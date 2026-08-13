import logging
import json
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from collections import defaultdict, deque
from typing import Literal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv()

from gigachat_client import check_brand as check_gigachat, get_model_name as get_gigachat_model, is_configured as is_gigachat_configured, _call_gigachat
from deepseek_client import check_brand as check_deepseek, get_model_name as get_deepseek_model, is_configured as is_deepseek_configured, _call_deepseek
from yandex_client import check_brand as check_yandex, get_cache_identity as get_yandex_cache_identity, get_model_name as get_yandex_model, is_configured as is_yandex_configured
from search_collector import apply_brand_evidence, collect_and_format, format_context
from cache import get_search_cache, set_search_cache, get_result_cache, set_result_cache, clear_cache, initialize_cache

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _positive_int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


CHECKS_PER_MINUTE = _positive_int_env("CHECKS_PER_MINUTE", 10)
MAX_CONCURRENT_CHECKS = _positive_int_env("MAX_CONCURRENT_CHECKS", 4)
_rate_lock = threading.Lock()
_check_times = defaultdict(deque)
_check_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_CHECKS)

PROVIDERS = {
    "gigachat": {
        "check": check_gigachat,
        "configured": is_gigachat_configured,
        "model": get_gigachat_model,
    },
    "deepseek": {
        "check": check_deepseek,
        "configured": is_deepseek_configured,
        "model": get_deepseek_model,
    },
    "yandex": {
        "check": check_yandex,
        "configured": is_yandex_configured,
        "model": get_yandex_model,
        "cache_identity": get_yandex_cache_identity,
    },
}


def _enforce_rate_limit(client_host: str):
    now = time.monotonic()
    with _rate_lock:
        timestamps = _check_times[client_host]
        while timestamps and now - timestamps[0] >= 60:
            timestamps.popleft()
        if len(timestamps) >= CHECKS_PER_MINUTE:
            raise HTTPException(status_code=429, detail="Слишком много запросов")
        timestamps.append(now)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize_cache()
    yield


app = FastAPI(lifespan=lifespan)

cors_origins = [origin.strip() for origin in os.getenv(
    "CORS_ORIGINS",
    "null,http://localhost,http://127.0.0.1,http://localhost:8000,http://127.0.0.1:8000"
).split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Admin-Token"],
)


class CheckRequest(BaseModel):
    brand: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=2000)
    context: str = Field(default="", max_length=60000)
    provider: Literal["gigachat", "deepseek", "yandex"] = "gigachat"
    force_refresh: bool = False


class BriefRequest(BaseModel):
    brand: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=2000)
    provider: Literal["gigachat", "deepseek"] = "gigachat"
    competitors: list[str] = Field(default_factory=list, max_length=20)
    checks_count: int = Field(ge=1, le=100)
    evidence: str = Field(min_length=1, max_length=12000)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "gigachat_configured": is_gigachat_configured(),
        "deepseek_configured": is_deepseek_configured(),
        "yandex_configured": is_yandex_configured(),
    }


@app.post("/api/check")
def check(req: CheckRequest, request: Request):
    client_host = request.client.host if request.client else "unknown"
    _enforce_rate_limit(client_host)
    if not _check_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Сервис занят, повторите запрос позже")
    try:
        return _run_check(req)
    finally:
        _check_semaphore.release()


def _run_check(req: CheckRequest):
    brand = " ".join(req.brand.split()) if req.brand else ""
    query = " ".join(req.query.split()) if req.query else ""
    context = req.context.strip() if req.context else None
    provider = req.provider
    provider_config = PROVIDERS[provider]
    model = provider_config["model"]()
    cache_identity = f'{provider_config.get("cache_identity", provider_config["model"])()}|source-evidence-v2'
    search_cache_key = f"source-evidence-v2:{query}"
    
    logger.info(f"[API] Запрос: provider={provider}, brand={brand[:80]!r}, query={query[:120]!r}, context_provided={bool(context)}")
    
    if not brand or not query:
        logger.warning("[API] Отсутствует бренд или запрос")
        return JSONResponse(status_code=422, content={"error": "Бренд и запрос обязательны"})
    
    if not provider_config["configured"]():
        return JSONResponse(status_code=503, content={"error": f"Провайдер {provider} не настроен"})

    cached_result = None if req.force_refresh else get_result_cache(brand, query, provider, cache_identity)
    if cached_result and not context:
        if "sources" in cached_result:
            logger.info("[API] Возвращён результат из кэша")
            return cached_result
        else:
            logger.info("[API] Результат из кэша без sources, пересчитываем")
    
    sources = []
    has_custom_context = bool(context)
    
    if not context:
        cached_search = None if req.force_refresh else get_search_cache(search_cache_key)
        if cached_search:
            context, sources = cached_search
            logger.info(f"[API] Использован контекст из кэша ({len(sources)} источников)")
        else:
            logger.info("[API] Контекст не найден в кэше, собираем данные из DuckDuckGo")
            context, sources = collect_and_format(query, max_results=10)
            if context and sources:
                set_search_cache(search_cache_key, context, sources)
            logger.info(f"[API] Собрано {len(sources)} источников")

    if not context:
        return JSONResponse(status_code=502, content={"error": "Не удалось собрать данные по запросу"})
    
    if sources:
        apply_brand_evidence(sources, brand)
        context = format_context(sources)

    result = provider_config["check"](brand, query, context)

    if result.get("error"):
        return JSONResponse(status_code=502, content=result)

    result["provider"] = provider
    result["model"] = model
    
    if sources:
        result["sources"] = [
            {
                "index": s.get("index"),
                "title": s.get("title", ""),
                "url": s.get("url", ""),
                "authority_score": s.get("authority_score", 3),
                "authority_label": s.get("authority_label", "низкая"),
                "brand_check_status": s.get("brand_check_status", "unavailable"),
                "brand_check_basis": s.get("brand_check_basis", "unavailable"),
                "brand_matches": s.get("brand_matches", []),
            }
            for s in sources
        ]
        
        if "source_analysis" in result and result["source_analysis"]:
            sources_by_index = {s.get("index"): s for s in sources}
            for analysis in result["source_analysis"]:
                source = sources_by_index.get(analysis.get("source_index"))
                if source:
                    analysis["url"] = source.get("url", "")
                    analysis["title"] = source.get("title", "")
                    analysis["authority_score"] = source.get("authority_score", 3)
                    analysis["authority_label"] = source.get("authority_label", "низкая")
                    status = source.get("brand_check_status", "unavailable")
                    analysis["brand_check_status"] = status
                    analysis["brand_check_basis"] = source.get("brand_check_basis", "unavailable")
                    analysis["brand_matches"] = source.get("brand_matches", [])
                    if status != "unavailable":
                        analysis["mentions_brand"] = status == "found"
            result["sources_count"] = sum(item.get("mentions_brand") is True for item in result["source_analysis"])

    if not has_custom_context:
        set_result_cache(brand, query, result, provider, cache_identity)
    
    logger.info(f"[API] Результат: mentioned={result.get('mentioned')}, position={result.get('position')}, sources={len(result.get('sources', []))}")
    return result


@app.post("/api/brief")
def create_brief(req: BriefRequest, request: Request):
    client_host = request.client.host if request.client else "unknown"
    _enforce_rate_limit(client_host)
    provider = PROVIDERS[req.provider]
    if not provider["configured"]():
        raise HTTPException(status_code=503, detail=f"Провайдер {req.provider} не настроен")
    payload = {
        "brand": req.brand,
        "query": req.query,
        "competitors": req.competitors,
        "checks_count": req.checks_count,
        "evidence": req.evidence,
    }
    messages = [
        {"role": "system", "content": "Ты готовишь короткий маркетинговый бриф. Используй только данные из JSON, не выдумывай факты, ссылки, метрики или гарантии. Верни JSON с полями title, goal, action, verification."},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        answer = _call_gigachat(messages, temperature=0.1, max_tokens=1200) if req.provider == "gigachat" else _call_deepseek(messages)
        parsed = json.loads(answer.strip().removeprefix("```json").removesuffix("```").strip())
        if not isinstance(parsed, dict):
            raise ValueError("invalid response")
        return {key: str(parsed.get(key, "")).strip() for key in ("title", "goal", "action", "verification")}
    except Exception as error:
        logger.warning("[API] Не удалось создать бриф: %s", error)
        raise HTTPException(status_code=502, detail="Не удалось создать бриф")


@app.delete("/api/cache")
def clear_all_cache(request: Request, x_admin_token: str | None = Header(default=None)):
    admin_token = os.getenv("CACHE_ADMIN_TOKEN", "").strip()
    client_host = request.client.host if request.client else ""
    is_local = client_host in {"127.0.0.1", "::1", "localhost"}
    if not admin_token and not is_local:
        raise HTTPException(status_code=503, detail="Очистка кэша отключена")
    if admin_token and (not x_admin_token or not secrets.compare_digest(x_admin_token, admin_token)):
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    clear_cache()
    return {"status": "cleared"}
