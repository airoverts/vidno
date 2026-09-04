import logging
import json
import os
import secrets
import threading
import time
import httpx
from contextlib import asynccontextmanager
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Literal

from fastapi import Cookie, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv()

from gigachat_client import generate_answer as generate_gigachat, get_model_name as get_gigachat_model, is_configured as is_gigachat_configured, _call_gigachat
from deepseek_client import generate_answer as generate_deepseek, get_model_name as get_deepseek_model, is_configured as is_deepseek_configured, _call_deepseek
from yandex_client import generate_answer as generate_yandex, get_cache_identity as get_yandex_cache_identity, get_model_name as get_yandex_model, is_configured as is_yandex_configured
from openai_client import generate_answer as generate_openai, get_cache_identity as get_openai_cache_identity, get_model_name as get_openai_model, is_configured as is_openai_configured
from gemini_client import generate_answer as generate_gemini, get_model_name as get_gemini_model, is_configured as is_gemini_configured
from perplexity_client import ANALYSIS_VERSION, analyze_answer as analyze_with_perplexity, generate_answer as generate_perplexity, generate_prompt_payload as generate_perplexity_prompt_payload, get_analysis_cache_identity, get_cache_identity as get_perplexity_cache_identity, get_model_name as get_perplexity_model, is_configured as is_perplexity_configured
from search_collector import apply_brand_evidence, collect_and_format
from cache import get_search_cache, set_search_cache, get_result_cache, set_result_cache, clear_cache, initialize_cache
from prompt_suggestions import curated_prompts, excluded_topics, normalize_suggested_prompts, parse_prompt_payload
from auth import authenticate, create_session, create_user, delete_session, initialize_auth, user_for_session

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
        "generate": generate_gigachat,
        "configured": is_gigachat_configured,
        "model": get_gigachat_model,
    },
    "deepseek": {
        "generate": generate_deepseek,
        "configured": is_deepseek_configured,
        "model": get_deepseek_model,
    },
    "yandex": {
        "generate": generate_yandex,
        "configured": is_yandex_configured,
        "model": get_yandex_model,
        "cache_identity": get_yandex_cache_identity,
    },
    "openai": {
        "generate": generate_openai,
        "configured": is_openai_configured,
        "model": get_openai_model,
        "cache_identity": get_openai_cache_identity,
    },
    "gemini": {
        "generate": generate_gemini,
        "configured": is_gemini_configured,
        "model": get_gemini_model,
    },
    "perplexity": {
        "generate": generate_perplexity,
        "configured": is_perplexity_configured,
        "model": get_perplexity_model,
        "cache_identity": get_perplexity_cache_identity,
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
    initialize_auth()
    yield


app = FastAPI(lifespan=lifespan)

cors_origins = [origin.strip() for origin in os.getenv(
    "CORS_ORIGINS",
    "null,http://localhost,http://127.0.0.1,http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000"
).split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Admin-Token", "Authorization"],
    allow_credentials=True,
)

SESSION_COOKIE = "vidno_session"


class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    brand: str = Field(default="", max_length=200)


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)


def _normalized_email(value: str):
    email = value.strip().lower()
    if email.count("@") != 1 or "." not in email.split("@", 1)[1]:
        raise HTTPException(status_code=422, detail="Введите корректный email")
    return email


def _set_session_cookie(response: Response, token: str):
    response.set_cookie(SESSION_COOKIE, token, max_age=30 * 24 * 60 * 60, httponly=True, samesite="lax", secure=os.getenv("COOKIE_SECURE", "false").lower() == "true", path="/")


def _session_token(cookie_token: str | None, authorization: str | None):
    if cookie_token:
        return cookie_token
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


@app.post("/api/auth/register", status_code=201)
def register(req: RegisterRequest, response: Response):
    user = create_user(req.name.strip(), _normalized_email(req.email), req.password, req.brand.strip())
    if not user:
        raise HTTPException(status_code=409, detail="Аккаунт с таким email уже существует")
    token = create_session(user["id"])
    _set_session_cookie(response, token)
    return {"user": user, "session_token": token}


@app.post("/api/auth/login")
def login(req: LoginRequest, response: Response):
    user = authenticate(_normalized_email(req.email), req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    token = create_session(user["id"])
    _set_session_cookie(response, token)
    return {"user": user, "session_token": token}


@app.get("/api/auth/me")
def auth_me(vidno_session: str | None = Cookie(default=None), authorization: str | None = Header(default=None)):
    user = user_for_session(_session_token(vidno_session, authorization))
    if not user:
        raise HTTPException(status_code=401, detail="Требуется вход")
    return {"user": user}


@app.post("/api/auth/logout", status_code=204)
def logout(response: Response, vidno_session: str | None = Cookie(default=None), authorization: str | None = Header(default=None)):
    delete_session(_session_token(vidno_session, authorization))
    response.delete_cookie(SESSION_COOKIE, path="/")


class CheckRequest(BaseModel):
    brand: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=2000)
    context: str = Field(default="", max_length=60000)
    provider: Literal["gigachat", "deepseek", "yandex", "openai", "gemini", "perplexity"] = "gigachat"
    force_refresh: bool = False
    canonical_id: str = Field(default="", max_length=200)
    canonical_name: str = Field(default="", max_length=200)
    aliases: list[str] = Field(default_factory=list, max_length=50)
    domains: list[str] = Field(default_factory=list, max_length=50)


class CheckAllRequest(BaseModel):
    brand: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=2000)
    context: str = Field(default="", max_length=60000)
    force_refresh: bool = False
    canonical_id: str = Field(default="", max_length=200)
    canonical_name: str = Field(default="", max_length=200)
    aliases: list[str] = Field(default_factory=list, max_length=50)
    domains: list[str] = Field(default_factory=list, max_length=50)


class BriefRequest(BaseModel):
    brand: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=2000)
    provider: Literal["gigachat", "deepseek"] = "gigachat"
    competitors: list[str] = Field(default_factory=list, max_length=20)
    checks_count: int = Field(ge=1, le=100)
    evidence: str = Field(min_length=1, max_length=12000)


class PromptSuggestionsRequest(BaseModel):
    brand: str = Field(min_length=1, max_length=200)
    existing_queries: list[str] = Field(default_factory=list, max_length=20)
    domains: list[str] = Field(default_factory=list, max_length=20)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "gigachat_configured": is_gigachat_configured(),
        "deepseek_configured": is_deepseek_configured(),
        "yandex_configured": is_yandex_configured(),
        "openai_configured": is_openai_configured(),
        "gemini_configured": is_gemini_configured(),
        "perplexity_configured": is_perplexity_configured(),
        "analysis_provider": "perplexity" if is_perplexity_configured() else None,
        "analysis_version": ANALYSIS_VERSION,
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


@app.post("/api/check-all")
def check_all(req: CheckAllRequest, request: Request):
    client_host = request.client.host if request.client else "unknown"
    _enforce_rate_limit(client_host)
    if not _check_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Сервис занят, повторите запрос позже")
    try:
        if not is_perplexity_configured():
            return JSONResponse(status_code=503, content={"error": "Perplexity не настроен: единый анализ ответов недоступен"})
        provider_results = []
        errors = []
        analysis_errors = []
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = {executor.submit(_run_check, CheckRequest(**req.model_dump(), provider=provider), False): provider for provider in ("gigachat", "yandex", "openai", "gemini", "perplexity")}
            for future in as_completed(futures):
                provider = futures[future]
                try:
                    result = future.result()
                except Exception as error:
                    logger.exception("[API] Ошибка агрегированной проверки provider=%s", provider)
                    errors.append({"provider": provider, "error": str(error)})
                    continue
                if isinstance(result, JSONResponse):
                    payload = json.loads(result.body)
                    errors.append({"provider": provider, "error": payload.get("error", "Ошибка провайдера")})
                    if payload.get("analysis_error"):
                        analysis_errors.append(provider)
                else:
                    provider_results.append(result)
        if analysis_errors:
            return JSONResponse(status_code=502, content={"error": "Perplexity не смог завершить единый анализ ответов", "provider_errors": errors})
        if not provider_results:
            return JSONResponse(status_code=502, content={"error": "Не удалось получить ответы AI-моделей", "provider_errors": errors})
        return _aggregate_results(provider_results, errors)
    finally:
        _check_semaphore.release()


def _aggregate_results(results, errors):
    mentioned_results = [item for item in results if item.get("mentioned")]
    positions = [item.get("position") or item.get("weighted_position") for item in mentioned_results]
    positions = [float(value) for value in positions if value]
    mention_scores = {}
    mention_roles = {}
    for item in results:
        for mention in item.get("ordered_mentions", []):
            name = str(mention.get("canonical_name") or mention.get("name", "")).strip()
            position = mention.get("position")
            if not name or not isinstance(position, int) or position < 1:
                continue
            key = str(mention.get("canonical_id") or name.casefold())
            mention_scores[key] = mention_scores.get(key, {"name": name, "score": 0.0, "canonical_id": key})
            mention_scores[key]["score"] += 1 / position
            mention_roles.setdefault(key, mention.get("role", "упоминание"))
    ordered_mentions = [
        {"name": item["name"], "position": index, "role": mention_roles.get(key, "упоминание"), "canonical_id": item["canonical_id"], "canonical_name": item["name"]}
        for index, (key, item) in enumerate(sorted(mention_scores.items(), key=lambda pair: (-pair[1]["score"], pair[1]["name"].casefold())), start=1)
    ]
    target_ids = {str(item.get("canonical_id")) for item in results if item.get("canonical_id")}
    competitors = [item["canonical_name"] for item in ordered_mentions if item["canonical_id"] not in target_ids] if target_ids else list(dict.fromkeys(name for result in results for name in result.get("mentioned_brands", []) if name))
    quotes = list(dict.fromkeys(quote for item in results for quote in item.get("quotes", []) if quote))
    sources_by_url = {}
    for item in results:
        for source in item.get("sources", []):
            key = source.get("url") or source.get("title")
            if key and key not in sources_by_url:
                sources_by_url[key] = source
    if len(mentioned_results) == len(results):
        reasoning = f"Бренд упомянут во всех полученных ответах ({len(mentioned_results)} из {len(results)})."
    elif mentioned_results:
        reasoning = f"Бренд упомянут в {len(mentioned_results)} из {len(results)} полученных ответов."
    else:
        reasoning = "Бренд не упомянут в полученных ответах."
    detailed_reasoning = " ".join(dict.fromkeys(item.get("reasoning") for item in results if item.get("reasoning")))
    return {
        "provider": "all",
        "model": " + ".join(dict.fromkeys(str(item.get("model") or item.get("provider") or "AI") for item in results)),
        "mentioned": bool(mentioned_results),
        "position": sum(positions) / len(positions) if positions else None,
        "role": "рекомендация" if any("рекомендац" in str(item.get("role", "")).lower() for item in results) else ("упоминание" if mentioned_results else "не упомянут"),
        "reasoning": f"{reasoning} {detailed_reasoning}".strip(),
        "quotes": quotes,
        "competitors": competitors,
        "mentioned_brands": competitors,
        "ordered_mentions": ordered_mentions,
        "sources": list(sources_by_url.values()),
        "source_analysis": [analysis for item in results for analysis in item.get("source_analysis", [])],
        "provider_results": results,
        "provider_errors": errors,
        "canonical_id": next((item.get("canonical_id") for item in results if item.get("canonical_id")), None),
        "canonical_name": next((item.get("canonical_name") for item in results if item.get("canonical_name")), None),
        "observed_name": next((item.get("observed_name") for item in results if item.get("observed_name")), None),
        "analysis_provider": "perplexity",
        "analysis_version": ANALYSIS_VERSION,
    }


@app.post("/api/prompt-suggestions")
def prompt_suggestions(req: PromptSuggestionsRequest, request: Request):
    client_host = request.client.host if request.client else "unknown"
    _enforce_rate_limit(client_host)
    if not is_perplexity_configured():
        raise HTTPException(status_code=503, detail="Perplexity не настроен")
    brand = " ".join(req.brand.split())
    existing_queries = list(dict.fromkeys(" ".join(value.split()) for value in req.existing_queries if value and value.strip()))
    domains = list(dict.fromkeys(" ".join(value.split()) for value in req.domains if value and value.strip()))
    rejected_topics = excluded_topics(brand)
    if any(len(value) > 200 for value in domains):
        raise HTTPException(status_code=422, detail="Домен слишком длинный")
    generation_messages = [
        {"role": "system", "content": """Ты создаёшь ровно 3 естественных пользовательских запроса для проверки AI-видимости компании. Сначала через Web Search установи, какие продукты или услуги являются основным коммерческим бизнесом исследуемой компании. Приоритетны официальный сайт и надёжные актуальные источники. Никогда не принимай сувениры, мерч, футболки, свитшоты, подарочную продукцию, вакансии, благотворительность и другие побочные активности за основной бизнес компании.

Каждый итоговый запрос должен быть таким, чтобы обычный AI-ассистент в ответе назвал несколько подходящих компаний, сервисов, банков, производителей или решений, среди которых потенциально может оказаться исследуемая компания. Слова «бренд», «марка» и «производитель» не обязательны. Допустимы естественные форматы: «Какой банк лучше выбрать для ежедневных платежей?», «Где оформить дебетовую карту с выгодным кэшбэком?», «Какие сервисы подходят для ...?», «Что лучше использовать для ...?». Не включай название исследуемой компании и названия её конкурентов. Не создавай сравнение заранее заданных компаний. Не используй «купить», адреса, наличие, SEO, мониторинг или вопросы только о характеристиках без запроса рекомендации. Все три запроса должны относиться только к ключевым коммерческим направлениям компании и покрывать разные реальные пользовательские задачи. Верни JSON с единственным полем prompts — массивом ровно из 3 строк."""},
        {"role": "user", "content": json.dumps({"company_for_research_only": brand, "official_domains": domains, "previous_user_queries": existing_queries[-12:], "excluded_topics_from_product_feedback": rejected_topics}, ensure_ascii=False)},
    ]
    try:
        generated = generate_perplexity_prompt_payload(generation_messages, require_web_search=True)
        prompts = normalize_suggested_prompts(generated.get("prompts"), brand, limit=3, require_brand_intent=False)
        if len(prompts) < 3:
            raise ValueError("Perplexity вернул недостаточно подходящих промптов")
        return {"brand": brand, "prompts": prompts}
    except Exception as error:
        logger.warning("[API] Не удалось предложить промпты: %s", error)
        raise HTTPException(status_code=502, detail="Не удалось предложить промпты")


def _run_check(req: CheckRequest, use_result_cache: bool = True):
    brand = " ".join(req.brand.split()) if req.brand else ""
    query = " ".join(req.query.split()) if req.query else ""
    context = req.context.strip() if req.context else None
    provider = req.provider
    aliases = list(dict.fromkeys(" ".join(value.split()) for value in req.aliases if value and value.strip()))
    domains = list(dict.fromkeys(" ".join(value.split()) for value in req.domains if value and value.strip()))
    canonical_id = " ".join(req.canonical_id.split())
    canonical_name = " ".join(req.canonical_name.split())
    if any(len(value) > 200 for value in aliases + domains):
        return JSONResponse(status_code=422, content={"error": "Псевдоним или домен слишком длинный"})
    provider_config = PROVIDERS[provider]
    model = provider_config["model"]()
    identity_cache = json.dumps([canonical_id, canonical_name, sorted(aliases), sorted(domains)], ensure_ascii=False)
    cache_version = f"{get_analysis_cache_identity()}|canonical-brands-v1:{identity_cache}"
    cache_identity = f'{provider_config.get("cache_identity", provider_config["model"])()}|{cache_version}'
    search_cache_key = f"source-evidence-v2:{query}"
    
    logger.info(f"[API] Запрос: provider={provider}, brand={brand[:80]!r}, query={query[:120]!r}, context_provided={bool(context)}")
    
    if not brand or not query:
        logger.warning("[API] Отсутствует бренд или запрос")
        return JSONResponse(status_code=422, content={"error": "Бренд и запрос обязательны"})
    
    if not provider_config["configured"]():
        return JSONResponse(status_code=503, content={"error": f"Провайдер {provider} не настроен"})
    if not is_perplexity_configured():
        return JSONResponse(status_code=503, content={"error": "Perplexity не настроен: единый анализ ответов недоступен", "analysis_error": True})

    cached_result = None if req.force_refresh or not use_result_cache else get_result_cache(brand, query, provider, cache_identity)
    if cached_result and not context:
        if provider == "yandex" or "sources" in cached_result:
            logger.info("[API] Возвращён результат из кэша")
            return cached_result
        else:
            logger.info("[API] Результат из кэша без sources, пересчитываем")
    
    sources = []
    has_custom_context = bool(context)
    
    if not context and provider not in {"yandex", "openai", "gemini", "perplexity"}:
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

    if not context and provider not in {"yandex", "openai", "gemini", "perplexity"}:
        return JSONResponse(status_code=502, content={"error": "Не удалось собрать данные по запросу"})
    
    try:
        generated = provider_config["generate"](query, context or "") if provider in {"gigachat", "deepseek"} else provider_config["generate"](query)
    except httpx.HTTPStatusError as error:
        return JSONResponse(status_code=502, content={"error": f"Ошибка API {provider}: {error.response.status_code}"})
    except httpx.RequestError:
        return JSONResponse(status_code=502, content={"error": f"Ошибка подключения к {provider}"})
    except Exception as error:
        logger.exception("[API] Ошибка генерации provider=%s", provider)
        return JSONResponse(status_code=502, content={"error": f"Ошибка обработки ответа {provider}: {type(error).__name__}"})

    if generated.get("error"):
        return JSONResponse(status_code=502, content=generated)

    raw_answer = str(generated.get("raw_answer") or "").strip()
    if not raw_answer:
        return JSONResponse(status_code=502, content={"error": f"Провайдер {provider} вернул пустой ответ"})
    try:
        analysis = analyze_with_perplexity(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)
    except httpx.HTTPStatusError as error:
        logger.warning("[API] Ошибка анализа Perplexity: %s", error.response.status_code)
        return JSONResponse(status_code=502, content={"error": f"Ошибка анализа Perplexity: {error.response.status_code}", "analysis_error": True})
    except httpx.RequestError:
        return JSONResponse(status_code=502, content={"error": "Ошибка подключения к Perplexity при анализе ответа", "analysis_error": True})
    except Exception as error:
        logger.warning("[API] Некорректный анализ Perplexity: %s", error)
        return JSONResponse(status_code=502, content={"error": "Perplexity не смог сформировать корректный анализ ответа", "analysis_error": True})

    result = {
        "brand": brand,
        "query": query,
        **analysis,
        "raw_answer": raw_answer,
        "sources": generated.get("sources") or [],
        "search_queries": generated.get("search_queries") or [],
        "web_search_used": bool(generated.get("web_search_used")),
        "rag": True,
        "provider": provider,
        "model": model,
    }
    
    if sources:
        apply_brand_evidence(sources, brand)
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

    if not has_custom_context and use_result_cache:
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


app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent, html=True), name="frontend")
