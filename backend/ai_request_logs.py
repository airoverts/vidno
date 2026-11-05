import inspect
import logging
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps

import httpx

from database import connection


logger = logging.getLogger(__name__)
_context = ContextVar("ai_request_context", default=None)
_MAX_COUNT = 2**63 - 1


@contextmanager
def request_scope(user_id, operation, request_id=None):
    token = _context.set({"user_id": user_id, "operation": operation, "request_id": str(request_id or uuid.uuid4()), "check_id": None, "stage": "generation"})
    try:
        yield
    finally:
        _context.reset(token)


@contextmanager
def stage_scope(stage):
    context = _context.get()
    token = _context.set({**context, "stage": stage} if context else None)
    try:
        yield
    finally:
        _context.reset(token)


def set_check_id(check_id):
    context = _context.get()
    if context:
        _context.set({**context, "check_id": check_id})


def track_operation(operation):
    def decorate(function):
        signature = inspect.signature(function)

        @wraps(function)
        def wrapped(*args, **kwargs):
            arguments = signature.bind(*args, **kwargs).arguments
            with request_scope(arguments["user"]["id"], operation):
                return function(*args, **kwargs)

        return wrapped
    return decorate


def _mapping(value):
    if isinstance(value, dict):
        return value
    if callable(getattr(value, "model_dump", None)):
        return value.model_dump()
    return vars(value) if hasattr(value, "__dict__") else {}


def _count(*values):
    return next((value for value in values if type(value) is int and 0 <= value <= _MAX_COUNT), None)


def usage_counts(provider, data):
    data = _mapping(data)
    usage = _mapping(data.get("usage_metadata") if provider == "gemini" else data.get("usage"))
    input_tokens = _count(usage.get("input_tokens"), usage.get("prompt_tokens"), usage.get("prompt_token_count"))
    output_tokens = _count(usage.get("output_tokens"), usage.get("completion_tokens"), usage.get("candidates_token_count"))
    total_tokens = _count(usage.get("total_tokens"), usage.get("total_token_count"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = _count(input_tokens + output_tokens)
    input_details = _mapping(usage.get("input_tokens_details") or usage.get("prompt_tokens_details"))
    output_details = _mapping(usage.get("output_tokens_details") or usage.get("completion_tokens_details"))
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
        "cached_tokens": _count(usage.get("cached_tokens"), usage.get("cached_content_token_count"), usage.get("prompt_cache_hit_tokens"), input_details.get("cached_tokens")),
        "reasoning_tokens": _count(usage.get("reasoning_tokens"), usage.get("thoughts_token_count"), output_details.get("reasoning_tokens")),
    }


def insert_log(row):
    columns = tuple(row)
    with connection() as database:
        database.execute(
            f"INSERT INTO ai_request_logs ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})",
            tuple(row[column] for column in columns),
        )


def _save(provider, requested_model, attempt, started_at, started, data=None, http_status=None, error=None):
    context = _context.get()
    if not context:
        return
    try:
        data = _mapping(data)
        if error is not None:
            status = "network_error" if isinstance(error, (httpx.RequestError, TimeoutError, ConnectionError)) else "http_error" if http_status else "provider_error"
            category = "timeout" if isinstance(error, (httpx.TimeoutException, TimeoutError)) else status
        elif http_status is not None and not 200 <= http_status < 300:
            status, category = "http_error", "http_error"
        elif data.get("error") or data.get("status") in {"failed", "incomplete", "cancelled"}:
            status, category = "provider_error", "provider_error"
        else:
            status, category = "success", None
        returned_model = data.get("model_version") if provider == "gemini" else data.get("model")
        row = {
            **context, "provider": provider, "requested_model": requested_model,
            "returned_model": returned_model[:500] if isinstance(returned_model, str) else None,
            "attempt": attempt, "started_at": started_at,
            "duration_ms": max(0, round((time.monotonic() - started) * 1000)),
            "status": status, "http_status": http_status, "error_category": category,
            **usage_counts(provider, data),
        }
        insert_log(row)
    except Exception:
        logger.error("AI request log write failed provider=%s request_id=%s", provider, context["request_id"])


def logged_http_post(provider, requested_model, attempt, url, **kwargs):
    started_at, started = datetime.now(timezone.utc), time.monotonic()
    try:
        response = httpx.post(url, **kwargs)
    except Exception as error:
        _save(provider, requested_model, attempt, started_at, started, error=error)
        raise
    try:
        data = response.json()
    except (ValueError, UnicodeError):
        data = {"error": True}
    _save(provider, requested_model, attempt, started_at, started, data, response.status_code)
    return response


def logged_generate_content(client, requested_model, attempt=1, **kwargs):
    started_at, started = datetime.now(timezone.utc), time.monotonic()
    try:
        response = client.models.generate_content(model=requested_model, **kwargs)
    except Exception as error:
        code = getattr(error, "code", None)
        _save("gemini", requested_model, attempt, started_at, started, http_status=code if type(code) is int and 100 <= code <= 599 else None, error=error)
        raise
    _save("gemini", requested_model, attempt, started_at, started, response, 200)
    return response


def list_ai_requests(*, date_from, date_to, user="", provider=None, model="", operation=None, status=None, page=1, page_size=50):
    clauses = ["l.started_at >= %s", "l.started_at < %s"]
    params = [date_from, date_to]
    if user:
        clauses.append("(strpos(lower(u.name), lower(%s)) > 0 OR strpos(lower(u.email), lower(%s)) > 0)")
        params.extend([user, user])
    for column, value in (("provider", provider), ("operation", operation), ("status", status)):
        if value:
            clauses.append(f"l.{column} = %s")
            params.append(value)
    if model:
        clauses.append("(strpos(lower(l.requested_model), lower(%s)) > 0 OR strpos(lower(l.returned_model), lower(%s)) > 0)")
        params.extend([model, model])
    source = "FROM ai_request_logs l JOIN users u ON u.id = l.user_id WHERE " + " AND ".join(clauses)
    with connection() as database:
        database.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        summary = database.execute(
            "SELECT COUNT(*) AS attempts, COUNT(*) FILTER (WHERE l.status <> 'success') AS errors, "
            "COALESCE(SUM(l.input_tokens), 0) AS input_tokens, COALESCE(SUM(l.output_tokens), 0) AS output_tokens, "
            "COALESCE(SUM(l.total_tokens), 0) AS total_tokens, "
            "COUNT(*) FILTER (WHERE l.input_tokens IS NULL OR l.output_tokens IS NULL OR l.total_tokens IS NULL) AS missing_usage " + source,
            params,
        ).fetchone()
        items = database.execute(
            "SELECT l.*, u.name AS user_name, u.email AS user_email " + source +
            " ORDER BY l.started_at DESC, l.id DESC LIMIT %s OFFSET %s",
            [*params, page_size, (page - 1) * page_size],
        ).fetchall()
    summary = {key: int(value) for key, value in summary.items()}
    for item in items:
        item["request_id"] = str(item["request_id"])
    return {"items": items, "total": summary["attempts"], "page": page, "page_size": page_size, "summary": summary}
