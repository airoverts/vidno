import logging
import json
import os
import secrets
import threading
import time
import httpx
from contextlib import asynccontextmanager
from collections import defaultdict, deque
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import Body, Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from dotenv import load_dotenv

load_dotenv()

from gigachat_client import generate_answer as generate_gigachat, get_model_name as get_gigachat_model, is_configured as is_gigachat_configured, _call_gigachat
from deepseek_client import generate_answer as generate_deepseek, get_model_name as get_deepseek_model, is_configured as is_deepseek_configured, _call_deepseek
from yandex_client import generate_answer as generate_yandex, get_cache_identity as get_yandex_cache_identity, get_model_name as get_yandex_model, is_configured as is_yandex_configured
from openai_client import generate_answer as generate_openai, get_cache_identity as get_openai_cache_identity, get_model_name as get_openai_model, is_configured as is_openai_configured
from gemini_client import generate_answer as generate_gemini, get_model_name as get_gemini_model, is_configured as is_gemini_configured
from perplexity_client import ANALYSIS_VERSION, PerplexityModelError, analyze_answer as analyze_with_perplexity, generate_answer as generate_perplexity, generate_prompt_payload as generate_perplexity_prompt_payload, get_analysis_cache_identity, get_cache_identity as get_perplexity_cache_identity, get_model_name as get_perplexity_model, is_configured as is_perplexity_configured
from brand_identity import IDENTITY_NORMALIZATION_VERSION
from search_collector import apply_brand_evidence, collect_and_format
from cache import get_search_cache, set_search_cache, get_result_cache, set_result_cache, clear_cache, initialize_cache
from prompt_suggestions import curated_prompts, excluded_topics, normalize_suggested_prompts, parse_prompt_payload
from auth import authenticate, create_session, create_user, delete_session, delete_user_verified, get_account, initialize_auth, update_account, user_for_session
from storage import AccessControlError, create_brand, create_growth_task, create_saved_check, delete_brand, delete_check, delete_growth_task, dismiss_opportunity, finish_check, get_access, get_admin_client, list_admin_clients, list_brands, list_checks, list_dismissed_opportunities, list_growth_tasks, require_workspace_access, restore_opportunity, start_check, update_admin_access, update_brand, update_growth_task
from vouchers import create_voucher_batch, get_voucher_batch, list_tariffs, list_voucher_batches, redeem_voucher, revoke_voucher, update_tariff

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
CHECK_ALL_PROVIDERS = ("gigachat", "yandex", "openai", "gemini", "perplexity")


def _normalized_hostname(value: str, require_http: bool = False) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw if "://" in raw else f"//{raw}")
        if require_http and parsed.scheme.casefold() not in {"http", "https"}:
            return ""
        hostname = str(parsed.hostname or "").casefold().rstrip(".")
        if hostname.startswith("www."):
            hostname = hostname[4:]
        return hostname.encode("idna").decode("ascii")
    except (UnicodeError, ValueError):
        return ""


def _apply_brand_citations(result: dict, domains: list[str]) -> dict:
    official_domains = {
        hostname
        for value in domains
        if (hostname := _normalized_hostname(value))
    }
    citation_urls = []
    seen_urls = set()
    for source in result.get("sources") or []:
        if not isinstance(source, dict):
            continue
        source["cited_in_answer"] = source.get("cited_in_answer") is True
        hostname = _normalized_hostname(source.get("url", ""), require_http=True)
        is_brand_source = bool(hostname and any(hostname == domain or hostname.endswith(f".{domain}") for domain in official_domains))
        source["is_brand_source"] = is_brand_source
        url = source.get("url")
        if source["cited_in_answer"] and is_brand_source and isinstance(url, str) and url not in seen_urls:
            seen_urls.add(url)
            citation_urls.append(url)
    result["brand_citation_urls"] = citation_urls
    result["brand_cited"] = bool(citation_urls)
    return result


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


@app.exception_handler(AccessControlError)
async def access_control_error_handler(_request: Request, error: AccessControlError):
    return JSONResponse(status_code=error.status_code, content={"detail": error.payload})

cors_origins = [origin.strip() for origin in os.getenv(
    "CORS_ORIGINS",
    "null,http://localhost,http://127.0.0.1,http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000,http://127.0.0.1:8000"
).split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
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


def _current_user(vidno_session: str | None = Cookie(default=None)):
    user = user_for_session(vidno_session)
    if not user:
        raise HTTPException(status_code=401, detail="Требуется вход")
    return user


@app.post("/api/auth/register", status_code=201)
def register(req: RegisterRequest, response: Response):
    user = create_user(req.name.strip(), _normalized_email(req.email), req.password, req.brand.strip())
    if not user:
        raise HTTPException(status_code=409, detail="Аккаунт с таким email уже существует")
    token = create_session(user["id"])
    _set_session_cookie(response, token)
    return {"user": user}


@app.post("/api/auth/login")
def login(req: LoginRequest, response: Response):
    user = authenticate(_normalized_email(req.email), req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    token = create_session(user["id"])
    _set_session_cookie(response, token)
    return {"user": user}


@app.get("/api/auth/me")
def auth_me(user: dict = Depends(_current_user)):
    return {"user": user}


@app.post("/api/auth/logout", status_code=204)
def logout(response: Response, vidno_session: str | None = Cookie(default=None), _user: dict = Depends(_current_user)):
    delete_session(vidno_session)
    response.delete_cookie(SESSION_COOKIE, path="/")


class AccountPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=2, max_length=100)
    email: str | None = Field(default=None, min_length=5, max_length=254)
    current_password: str | None = Field(default=None, min_length=1, max_length=128)
    new_password: str | None = Field(default=None, min_length=8, max_length=128)


class AccountDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1, max_length=128)
    confirmation: str


@app.get("/api/account")
def account(user: dict = Depends(_current_user)):
    result = get_account(user["id"])
    if not result:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")
    result.pop("brand", None)
    return result


@app.patch("/api/account")
def patch_account(req: AccountPatchRequest, response: Response, user: dict = Depends(_current_user)):
    email = _normalized_email(req.email) if req.email is not None else None
    name = " ".join(req.name.split()) if req.name is not None else None
    if name is not None and len(name) < 2:
        raise HTTPException(status_code=422, detail={"code": "invalid_name", "message": "Имя должно содержать не менее двух символов"})
    if name is None and email is None and req.new_password is None:
        raise HTTPException(status_code=422, detail={"code": "no_changes", "message": "Не указаны изменения аккаунта"})
    if req.name is not None and not name:
        raise HTTPException(status_code=422, detail="Имя обязательно")
    if (email is not None or req.new_password is not None) and not req.current_password:
        raise HTTPException(status_code=422, detail={"code": "current_password_required", "message": "Введите текущий пароль"})
    result, reauth_required, error = update_account(user["id"], name, email, req.current_password, req.new_password)
    if error == "invalid_password":
        raise HTTPException(status_code=403, detail={"code": "invalid_current_password", "message": "Неверный текущий пароль"})
    if error == "duplicate_email":
        raise HTTPException(status_code=409, detail={"code": "duplicate_email", "message": "Аккаунт с таким email уже существует"})
    if error or not result:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")
    result.pop("brand", None)
    if reauth_required:
        response.delete_cookie(SESSION_COOKIE, path="/")
    return {"account": result, "reauth_required": reauth_required}


@app.delete("/api/account", status_code=204)
def delete_account(req: AccountDeleteRequest, response: Response, user: dict = Depends(_current_user)):
    if req.confirmation != "УДАЛИТЬ":
        raise HTTPException(status_code=422, detail={"code": "confirmation_required", "message": "Введите УДАЛИТЬ для подтверждения"})
    error = delete_user_verified(user["id"], req.current_password)
    if error == "invalid_password":
        raise HTTPException(status_code=403, detail={"code": "invalid_current_password", "message": "Неверный текущий пароль"})
    if error:
        raise HTTPException(status_code=404, detail="Аккаунт не найден")
    response.delete_cookie(SESSION_COOKIE, path="/")


@app.get("/api/access")
def access(user: dict = Depends(_current_user)):
    return get_access(user["id"])


def _admin_user(user: dict = Depends(_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail={"code": "admin_required", "message": "Недостаточно прав"})
    return user


class AdminAccessPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["pending", "active", "suspended"] | None = None
    plan: Literal["basic", "pro", "business", "custom"] | None = None
    expires_at: datetime | None = None
    checks_limit: int | None = Field(default=None, ge=0)
    brands_limit: int | None = Field(default=None, ge=0)
    reset_usage: bool = False


class TariffPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    checks_limit: int = Field(ge=0, le=2147483647, strict=True)
    brands_limit: int = Field(ge=0, le=2147483647, strict=True)


class VoucherBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan: Literal["basic", "pro", "business"]
    quantity: int = Field(default=10, ge=1, le=100, strict=True)
    duration_days: int = Field(default=30, ge=1, le=365, strict=True)


class VoucherRedeemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=200, repr=False)


@app.get("/api/admin/tariffs")
def admin_tariffs(_admin: dict = Depends(_admin_user)):
    return {"items": list_tariffs()}


@app.patch("/api/admin/tariffs/{plan}")
def patch_admin_tariff(plan: Literal["basic", "pro", "business"], req: TariffPatchRequest, _admin: dict = Depends(_admin_user)):
    result = update_tariff(plan, req.model_dump())
    if not result:
        raise HTTPException(status_code=404, detail="Тариф не найден")
    return result


@app.post("/api/admin/voucher-batches", status_code=201)
def post_admin_voucher_batch(req: VoucherBatchRequest, response: Response, admin: dict = Depends(_admin_user)):
    response.headers["Cache-Control"] = "no-store"
    return create_voucher_batch(admin["id"], req.plan, req.quantity, req.duration_days)


@app.get("/api/admin/voucher-batches")
def admin_voucher_batches(_admin: dict = Depends(_admin_user)):
    return {"items": list_voucher_batches()}


@app.get("/api/admin/voucher-batches/{batch_id}")
def admin_voucher_batch(batch_id: int, _admin: dict = Depends(_admin_user)):
    result = get_voucher_batch(batch_id)
    if not result:
        raise HTTPException(status_code=404, detail="Партия не найдена")
    return result


@app.post("/api/admin/vouchers/{voucher_id}/revoke")
def post_admin_revoke_voucher(voucher_id: int, _admin: dict = Depends(_admin_user)):
    result = revoke_voucher(voucher_id)
    if not result:
        raise HTTPException(status_code=404, detail="Ваучер не найден")
    return {"voucher": result}


@app.post("/api/vouchers/redeem")
def post_redeem_voucher(req: VoucherRedeemRequest, user: dict = Depends(_current_user)):
    _enforce_rate_limit(f"voucher:{user['id']}")
    return {"access": redeem_voucher(user["id"], req.code)}


@app.get("/api/admin/clients")
def admin_clients(
    q: str = Query(default="", max_length=200),
    status: Literal["pending", "active", "expired", "suspended"] | None = None,
    plan: Literal["basic", "pro", "business", "custom"] | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    _admin: dict = Depends(_admin_user),
):
    return list_admin_clients(q.strip(), status, plan, page, page_size)


@app.get("/api/admin/clients/{client_id}")
def admin_client(client_id: int, _admin: dict = Depends(_admin_user)):
    result = get_admin_client(client_id)
    if not result:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return result


@app.patch("/api/admin/clients/{client_id}/access")
def patch_admin_client_access(client_id: int, req: AdminAccessPatchRequest, _admin: dict = Depends(_admin_user)):
    changes = req.model_dump(exclude_unset=True)
    if changes.get("status", "valid") is None or changes.get("plan", "valid") is None:
        raise HTTPException(status_code=422, detail={"code": "invalid_access_update", "message": "Статус и тариф не могут быть пустыми"})
    result = update_admin_access(client_id, changes)
    if not result:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return result


class BrandRequest(BaseModel):
    canonical_name: str = Field(min_length=1, max_length=200)
    canonical_id: str = Field(default="", max_length=200)
    aliases: list[str] = Field(default_factory=list, max_length=50)
    domains: list[str] = Field(default_factory=list, max_length=50)


class BrandUpdateRequest(BaseModel):
    canonical_name: str | None = Field(default=None, min_length=1, max_length=200)
    canonical_id: str | None = Field(default=None, min_length=1, max_length=200)
    aliases: list[str] | None = Field(default=None, max_length=50)
    domains: list[str] | None = Field(default=None, max_length=50)


class OpportunityRequest(BaseModel):
    opportunity_id: str = Field(min_length=1, max_length=500)


def _clean_values(values: list[str]):
    cleaned = list(dict.fromkeys(" ".join(value.split()) for value in values if value and value.strip()))
    if any(len(value) > 200 for value in cleaned):
        raise HTTPException(status_code=422, detail="Значение слишком длинное")
    return cleaned


@app.get("/api/brands")
def get_brands(user: dict = Depends(_current_user)):
    return {"brands": list_brands(user["id"])}


@app.post("/api/brands", status_code=201)
def post_brand(req: BrandRequest, user: dict = Depends(_current_user)):
    brand = create_brand(user["id"], " ".join(req.canonical_name.split()), req.canonical_id.strip(), _clean_values(req.aliases), _clean_values(req.domains))
    if not brand:
        raise HTTPException(status_code=409, detail="Бренд с таким canonical_id уже существует")
    return {"brand": brand}


@app.patch("/api/brands/{brand_id}")
def patch_brand(brand_id: int, req: BrandUpdateRequest, user: dict = Depends(_current_user)):
    current = next((item for item in list_brands(user["id"]) if item["id"] == brand_id), None)
    if not current:
        raise HTTPException(status_code=404, detail="Бренд не найден")
    if req.canonical_id is not None and req.canonical_id.strip() != current["canonical_id"]:
        raise HTTPException(status_code=422, detail={"code": "canonical_id_immutable", "message": "canonical_id нельзя изменить"})
    brand = update_brand(
        user["id"],
        brand_id,
        " ".join((req.canonical_name or current["canonical_name"]).split()),
        (req.canonical_id or current["canonical_id"]).strip(),
        _clean_values(req.aliases) if req.aliases is not None else current["aliases"],
        _clean_values(req.domains) if req.domains is not None else current["domains"],
    )
    if brand is False:
        raise HTTPException(status_code=422, detail={"code": "canonical_id_immutable", "message": "canonical_id нельзя изменить"})
    return {"brand": brand}


@app.delete("/api/brands/{brand_id}", status_code=204)
def remove_brand(brand_id: int, user: dict = Depends(_current_user)):
    if not delete_brand(user["id"], brand_id):
        raise HTTPException(status_code=404, detail="Бренд не найден")


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
    providers: list[Literal["gigachat", "yandex", "openai", "gemini", "perplexity"]] = Field(default_factory=lambda: list(CHECK_ALL_PROVIDERS), min_length=1, max_length=5)


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
    aliases: list[str] = Field(default_factory=list, max_length=50)


def _check_metadata(record: dict):
    return {key: record[key] for key in ("id", "brand_id", "status", "created_at", "completed_at")}


def _complete_check_response(user_id: int, check_id: int, response):
    if isinstance(response, JSONResponse):
        payload = json.loads(response.body)
        _tag_provider_calls(payload, check_id)
        artifacts = {key: payload[key] for key in ("provider", "provider_errors", "requested_providers") if key in payload}
        record = finish_check(user_id, check_id, "failed", result=artifacts or None, error={key: value for key, value in payload.items() if key != "provider_errors"})
        payload["check_id"] = check_id
        return JSONResponse(status_code=response.status_code, content=payload)
    response = deepcopy(response)
    _tag_provider_calls(response, check_id)
    status = "partial" if response.get("provider_errors") else "completed"
    record = finish_check(user_id, check_id, status, result=response, error=response.get("provider_errors") or None)
    if not record or record["status"] not in {"completed", "partial"}:
        return JSONResponse(status_code=409, content={"error": "Проверка прервана. Запустите её повторно.", "check_id": check_id})
    saved_result = record.get("result")
    return {**(saved_result if isinstance(saved_result, dict) else response), "check": _check_metadata(record)}


def _tag_provider_calls(payload: dict, check_id: int):
    for call in payload.get("provider_calls", []):
        call["check_id"] = check_id
    for key in ("provider_results", "provider_errors"):
        for item in payload.get(key, []):
            _tag_provider_calls(item, check_id)


def _provider_failure(provider: str, message: str, generated: dict | None = None, error: Exception | None = None, analysis_error: bool = False):
    generated = generated or {}
    artifact = {
        "provider": provider,
        "error": message,
        "raw_answer": generated.get("raw_answer") or getattr(error, "raw_answer", ""),
        "sources": generated.get("sources") or [],
        "search_queries": generated.get("search_queries") or [],
        "provider_calls": generated.get("provider_calls", []) + getattr(error, "provider_calls", []),
    }
    return JSONResponse(status_code=502, content={"error": message, "provider": provider, "analysis_error": analysis_error, "provider_errors": [artifact]})


@app.get("/api/checks")
def get_checks(user: dict = Depends(_current_user)):
    return {"checks": list_checks(user["id"])}


@app.post("/api/checks", status_code=201)
def post_check(payload: dict[str, Any] = Body(...), user: dict = Depends(_current_user)):
    source = payload.get("check") if isinstance(payload.get("check"), dict) else payload
    record = create_saved_check(user["id"], source)
    if not record:
        raise HTTPException(status_code=422, detail="Бренд и запрос обязательны")
    return {"check": record}


@app.delete("/api/checks/{check_id}", status_code=204)
def remove_check(check_id: int, user: dict = Depends(_current_user)):
    if not delete_check(user["id"], check_id):
        raise HTTPException(status_code=404, detail="Проверка не найдена")


@app.get("/api/growth-tasks")
def get_growth_tasks(user: dict = Depends(_current_user)):
    return {"tasks": list_growth_tasks(user["id"])}


@app.post("/api/growth-tasks", status_code=201)
def post_growth_task(payload: dict[str, Any] = Body(...), user: dict = Depends(_current_user)):
    source = payload.get("task") if isinstance(payload.get("task"), dict) else payload
    task = create_growth_task(user["id"], source)
    if not task:
        raise HTTPException(status_code=422, detail="Бренд задачи не найден")
    return {"task": task}


@app.patch("/api/growth-tasks/{task_id}")
def patch_growth_task(task_id: int, payload: dict[str, Any] = Body(...), user: dict = Depends(_current_user)):
    source = payload.get("task") if isinstance(payload.get("task"), dict) else payload
    task = update_growth_task(user["id"], task_id, source)
    if task is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    if task is False:
        raise HTTPException(status_code=422, detail="Бренд задачи не найден")
    return {"task": task}


@app.delete("/api/growth-tasks/{task_id}", status_code=204)
def remove_growth_task(task_id: int, user: dict = Depends(_current_user)):
    if not delete_growth_task(user["id"], task_id):
        raise HTTPException(status_code=404, detail="Задача не найдена")


@app.get("/api/dismissed-opportunities")
def get_dismissed_opportunities(user: dict = Depends(_current_user)):
    return {"items": list_dismissed_opportunities(user["id"])}


@app.put("/api/dismissed-opportunities")
def put_dismissed_opportunity(req: OpportunityRequest, user: dict = Depends(_current_user)):
    return {"opportunity_id": dismiss_opportunity(user["id"], req.opportunity_id.strip())}


@app.delete("/api/dismissed-opportunities", status_code=204)
def delete_dismissed_opportunity(req: OpportunityRequest, user: dict = Depends(_current_user)):
    restore_opportunity(user["id"], req.opportunity_id.strip())


@app.delete("/api/dismissed-opportunities/{opportunity_id:path}", status_code=204)
def delete_dismissed_opportunity_path(opportunity_id: str, user: dict = Depends(_current_user)):
    restore_opportunity(user["id"], opportunity_id)


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
def check(req: CheckRequest, user: dict = Depends(_current_user)):
    _enforce_rate_limit(str(user["id"]))
    if not _check_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Сервис занят, повторите запрос позже")
    record = None
    try:
        record = start_check(user["id"], " ".join(req.brand.split()), req.canonical_id.strip(), " ".join(req.query.split()), req.provider, req.aliases, req.domains)
        saved_request = req.model_copy(update={"canonical_id": record.get("canonical_id") or req.canonical_id, "canonical_name": record.get("brand") or req.canonical_name or req.brand})
        return _complete_check_response(user["id"], record["id"], _run_check(saved_request, user["id"]))
    except Exception as error:
        if record:
            finish_check(user["id"], record["id"], "failed", error={"error": type(error).__name__})
        raise
    finally:
        _check_semaphore.release()


@app.post("/api/check-all")
def check_all(req: CheckAllRequest, user: dict = Depends(_current_user)):
    _enforce_rate_limit(str(user["id"]))
    if not _check_semaphore.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="Сервис занят, повторите запрос позже")
    record = None
    try:
        record = start_check(user["id"], " ".join(req.brand.split()), req.canonical_id.strip(), " ".join(req.query.split()), "all", req.aliases, req.domains)
        if not is_perplexity_configured():
            return _complete_check_response(user["id"], record["id"], JSONResponse(status_code=503, content={"error": "Perplexity не настроен: единый анализ ответов недоступен"}))
        requested_providers = tuple(dict.fromkeys(req.providers))
        provider_results = []
        errors = []
        analysis_errors = []
        with ThreadPoolExecutor(max_workers=len(requested_providers)) as executor:
            request_data = req.model_dump(exclude={"providers"})
            request_data.update({"canonical_id": record.get("canonical_id") or req.canonical_id, "canonical_name": record.get("brand") or req.canonical_name or req.brand})
            futures = {executor.submit(_run_check, CheckRequest(**request_data, provider=provider), user["id"], False): provider for provider in requested_providers}
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
                    errors.extend(payload.get("provider_errors") or [{"provider": provider, "error": payload.get("error", "Ошибка провайдера")}])
                    if payload.get("analysis_error"):
                        analysis_errors.append(provider)
                else:
                    provider_results.append(result)
        if analysis_errors:
            errors.extend({"provider": item["provider"], "error": "Единый анализ не завершён", "raw_answer": item.get("raw_answer", ""), "sources": item.get("sources", []), "provider_calls": item.get("provider_calls", [])} for item in provider_results)
            return _complete_check_response(user["id"], record["id"], JSONResponse(status_code=502, content={"error": "Perplexity не смог завершить единый анализ ответов", "provider": "all", "analysis_error": True, "provider_errors": errors, "requested_providers": list(requested_providers)}))
        if not provider_results:
            return _complete_check_response(user["id"], record["id"], JSONResponse(status_code=502, content={"error": "Не удалось получить ответы AI-моделей", "provider": "all", "provider_errors": errors, "requested_providers": list(requested_providers)}))
        return _complete_check_response(user["id"], record["id"], _aggregate_results(provider_results, errors, requested_providers))
    except Exception as error:
        if record:
            finish_check(user["id"], record["id"], "failed", error={"error": type(error).__name__})
        raise
    finally:
        _check_semaphore.release()


def _aggregate_results(results, errors, requested_providers=None):
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
            mention_scores[key].setdefault("mention", dict(mention))
            saved_mention = mention_scores[key]["mention"]
            for field in ("observed_names", "evidence_spans"):
                if mention.get(field):
                    saved_mention[field] = list(dict.fromkeys(saved_mention.get(field, []) + mention[field]))
            mention_roles.setdefault(key, mention.get("role", "упоминание"))
    ordered_mentions = [
        {**item["mention"], "name": item["name"], "position": index, "role": mention_roles.get(key, "упоминание"), "canonical_id": item["canonical_id"], "canonical_name": item["name"]}
        for index, (key, item) in enumerate(sorted(mention_scores.items(), key=lambda pair: (-pair[1]["score"], pair[1]["name"].casefold())), start=1)
    ]
    target_ids = {str(item.get("canonical_id")) for item in results if item.get("canonical_id")}
    competitors = [item["canonical_name"] for item in ordered_mentions if item["canonical_id"] not in target_ids] if target_ids else list(dict.fromkeys(name for result in results for name in result.get("mentioned_brands", []) if name))
    quotes = list(dict.fromkeys(quote for item in results for quote in item.get("quotes", []) if quote))
    sources_by_url = {}
    for item in results:
        for source in item.get("sources", []):
            key = source.get("url") or source.get("title")
            if not key:
                continue
            if key not in sources_by_url:
                sources_by_url[key] = dict(source)
                continue
            sources_by_url[key]["cited_in_answer"] = sources_by_url[key].get("cited_in_answer") is True or source.get("cited_in_answer") is True
            sources_by_url[key]["is_brand_source"] = sources_by_url[key].get("is_brand_source") is True or source.get("is_brand_source") is True
    brand_citation_urls = list(dict.fromkeys(
        url
        for item in results
        for url in item.get("brand_citation_urls", [])
        if isinstance(url, str) and url
    ))
    if len(mentioned_results) == len(results):
        reasoning = f"Бренд упомянут во всех полученных ответах ({len(mentioned_results)} из {len(results)})."
    elif mentioned_results:
        reasoning = f"Бренд упомянут в {len(mentioned_results)} из {len(results)} полученных ответов."
    else:
        reasoning = "Бренд не упомянут в полученных ответах."
    detailed_reasoning = " ".join(dict.fromkeys(item.get("reasoning") for item in results if item.get("reasoning")))
    return {
        "provider": "all",
        **({"identity_normalization_version": IDENTITY_NORMALIZATION_VERSION} if results and all(item.get("identity_normalization_version") == IDENTITY_NORMALIZATION_VERSION for item in results) else {}),
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
        "brand_cited": bool(brand_citation_urls),
        "brand_citation_urls": brand_citation_urls,
        "citation_domains": list(dict.fromkeys(domain for item in results for domain in item.get("citation_domains", []))),
        "source_analysis": [analysis for item in results for analysis in item.get("source_analysis", [])],
        "provider_results": results,
        "provider_errors": errors,
        "requested_providers": list(requested_providers or [item.get("provider") for item in results if item.get("provider")]),
        "canonical_id": next((item.get("canonical_id") for item in results if item.get("canonical_id")), None),
        "canonical_name": next((item.get("canonical_name") for item in results if item.get("canonical_name")), None),
        "observed_name": next((item.get("observed_name") for item in results if item.get("observed_name")), None),
        "analysis_provider": "perplexity",
        "analysis_version": ANALYSIS_VERSION,
    }


@app.post("/api/prompt-suggestions")
def prompt_suggestions(req: PromptSuggestionsRequest, user: dict = Depends(_current_user)):
    require_workspace_access(user["id"])
    _enforce_rate_limit(str(user["id"]))
    if not is_perplexity_configured():
        raise HTTPException(status_code=503, detail="Perplexity не настроен")
    brand = " ".join(req.brand.split())
    existing_queries = list(dict.fromkeys(" ".join(value.split()) for value in req.existing_queries if value and value.strip()))
    domains = list(dict.fromkeys(" ".join(value.split()) for value in req.domains if value and value.strip()))
    aliases = list(dict.fromkeys(" ".join(value.split()) for value in req.aliases if value and value.strip()))
    rejected_topics = excluded_topics(brand)
    if any(len(value) > 200 for value in domains + aliases):
        raise HTTPException(status_code=422, detail="Домен слишком длинный")
    generation_messages = [
        {"role": "system", "content": """Ты создаёшь ровно 3 естественных пользовательских запроса для проверки AI-видимости компании. Сначала через Web Search установи, какие продукты или услуги являются основным коммерческим бизнесом исследуемой компании. Приоритетны официальный сайт и надёжные актуальные источники. Никогда не принимай сувениры, мерч, футболки, свитшоты, подарочную продукцию, вакансии, благотворительность и другие побочные активности за основной бизнес компании.

Каждый итоговый пользовательский запрос должен явно просить назвать 3–5 конкретных подходящих компаний, сервисов, банков, производителей или решений и кратко объяснить, чем подходит каждый вариант. Например: «Какие банки в России стоит рассмотреть для повседневных переводов и управления деньгами через приложение? Назови 3–5 конкретных вариантов и кратко объясни, чем подходит каждый». Слова «бренд», «марка» и «производитель» не обязательны. Не включай название исследуемой компании, её другие названия и названия конкурентов. Не создавай сравнение заранее заданных компаний и не подсказывай желаемый вариант ответа. Не используй «купить», адреса, наличие, SEO, мониторинг или вопросы только о критериях и характеристиках без запроса конкретных рекомендаций. Все три запроса должны относиться только к ключевым коммерческим направлениям компании, покрывать разные реальные пользовательские задачи и не повторять предыдущие запросы. Верни JSON с единственным полем prompts — массивом ровно из 3 строк."""},
        {"role": "user", "content": json.dumps({"company_for_research_only": brand, "other_company_names_to_exclude": aliases, "official_domains": domains, "previous_user_queries": existing_queries[-12:], "excluded_topics_from_product_feedback": rejected_topics}, ensure_ascii=False)},
    ]
    try:
        generated = generate_perplexity_prompt_payload(generation_messages, require_web_search=True)
        prompts = normalize_suggested_prompts(generated.get("prompts"), brand, limit=3, require_brand_intent=False, clarify_recommendations=True, excluded_names=domains + aliases)
        if len(prompts) < 3:
            raise ValueError("Perplexity вернул недостаточно подходящих промптов")
        return {"brand": brand, "prompts": prompts, "provider_calls": generated.get("provider_calls", [])}
    except Exception as error:
        logger.warning("[API] Не удалось предложить промпты: %s", type(error).__name__)
        raise HTTPException(status_code=502, detail="Не удалось предложить промпты")


def _run_check(req: CheckRequest, user_id: int | None = None, use_result_cache: bool = True):
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
    cache_version = f"{get_analysis_cache_identity()}|{IDENTITY_NORMALIZATION_VERSION}|confirmed-sonar-v1|brand-citations-v1:{identity_cache}"
    cache_identity = f'{provider_config.get("cache_identity", provider_config["model"])()}|{cache_version}'
    search_cache_key = f"source-evidence-v2:{query}"
    
    logger.info("[API] Запрос: provider=%s user_id=%s context_provided=%s", provider, user_id, bool(context))
    
    if not brand or not query:
        logger.warning("[API] Отсутствует бренд или запрос")
        return JSONResponse(status_code=422, content={"error": "Бренд и запрос обязательны"})
    
    if not provider_config["configured"]():
        return JSONResponse(status_code=503, content={"error": f"Провайдер {provider} не настроен"})
    if not is_perplexity_configured():
        return JSONResponse(status_code=503, content={"error": "Perplexity не настроен: единый анализ ответов недоступен", "analysis_error": True})

    cached_result = None if req.force_refresh or not use_result_cache or user_id is None else get_result_cache(user_id, brand, query, provider, cache_identity)
    if cached_result and not context:
        if provider == "yandex" or "sources" in cached_result:
            logger.info("[API] Возвращён результат из кэша")
            return cached_result
        else:
            logger.info("[API] Результат из кэша без sources, пересчитываем")
    
    sources = []
    has_custom_context = bool(context)
    
    if not context and provider not in {"yandex", "openai", "gemini", "perplexity"}:
        cached_search = None if req.force_refresh or user_id is None else get_search_cache(user_id, search_cache_key)
        if cached_search:
            context, sources = cached_search
            logger.info(f"[API] Использован контекст из кэша ({len(sources)} источников)")
        else:
            logger.info("[API] Контекст не найден в кэше, собираем данные из DuckDuckGo")
            context, sources = collect_and_format(query, max_results=10)
            if context and sources and user_id is not None:
                set_search_cache(user_id, search_cache_key, context, sources)
            logger.info(f"[API] Собрано {len(sources)} источников")

    if not context and provider not in {"yandex", "openai", "gemini", "perplexity"}:
        return JSONResponse(status_code=502, content={"error": "Не удалось собрать данные по запросу"})
    
    try:
        generated = provider_config["generate"](query, context or "") if provider in {"gigachat", "deepseek"} else provider_config["generate"](query)
    except PerplexityModelError as error:
        return _provider_failure(provider, str(error), error=error)
    except httpx.HTTPStatusError as error:
        return _provider_failure(provider, f"Ошибка API {provider}: {error.response.status_code}", error=error)
    except httpx.RequestError as error:
        return _provider_failure(provider, f"Ошибка подключения к {provider}", error=error)
    except Exception as error:
        logger.warning("[API] Ошибка генерации provider=%s type=%s", provider, type(error).__name__)
        return _provider_failure(provider, f"Ошибка обработки ответа {provider}: {type(error).__name__}", error=error)

    if generated.get("error"):
        return _provider_failure(provider, generated["error"], generated)

    if sources:
        generated = {**generated, "sources": [{**source, "cited_in_answer": False} for source in sources]}

    raw_answer = str(generated.get("raw_answer") or "")
    if not raw_answer.strip():
        return _provider_failure(provider, f"Провайдер {provider} вернул пустой ответ", generated)
    try:
        analysis = analyze_with_perplexity(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)
    except PerplexityModelError as error:
        return _provider_failure(provider, str(error), generated, error, analysis_error=True)
    except httpx.HTTPStatusError as error:
        logger.warning("[API] Ошибка анализа Perplexity: %s", error.response.status_code)
        return _provider_failure(provider, f"Ошибка анализа Perplexity: {error.response.status_code}", generated, error, analysis_error=True)
    except httpx.RequestError as error:
        return _provider_failure(provider, "Ошибка подключения к Perplexity при анализе ответа", generated, error, analysis_error=True)
    except Exception as error:
        logger.warning("[API] Некорректный анализ Perplexity: %s", type(error).__name__)
        return _provider_failure(provider, "Perplexity не смог сформировать корректный анализ ответа", generated, error, analysis_error=True)

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
        "provider_calls": generated.get("provider_calls", []) + analysis.get("provider_calls", []),
        "citation_domains": domains,
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
                "cited_in_answer": False,
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

    _apply_brand_citations(result, domains)

    if not has_custom_context and use_result_cache and user_id is not None:
        set_result_cache(user_id, brand, query, result, provider, cache_identity)
    
    logger.info(f"[API] Результат: mentioned={result.get('mentioned')}, position={result.get('position')}, sources={len(result.get('sources', []))}")
    return result


@app.post("/api/brief")
def create_brief(req: BriefRequest, user: dict = Depends(_current_user)):
    require_workspace_access(user["id"])
    _enforce_rate_limit(str(user["id"]))
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
