import logging
import json
import os
import time
import threading
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv

from brand_identity import canonicalize_analysis
from answer_options import AnswerOptionError, OPTION_EXTRACTION_SCHEMA, build_option_messages, parse_answer_options

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("PERPLEXITY_API_KEY", "").strip()
MODEL_NAME = os.getenv("PERPLEXITY_MODEL", "perplexity/sonar").strip() or "perplexity/sonar"
ANALYSIS_MODEL_NAME = os.getenv("PERPLEXITY_ANALYSIS_MODEL", MODEL_NAME).strip() or MODEL_NAME
API_URL = "https://api.perplexity.ai/v1/agent"
ANALYSIS_VERSION = "perplexity-direct-v1"
EXPECTED_MODEL_NAME = "perplexity/sonar"
ANALYSIS_METHOD = "verified-answer-options-v2"
_analysis_lock = threading.Lock()


class PerplexityModelError(ValueError):
    def __init__(self, stage: str, requested_model: str, returned_model: str | None, provider_calls: list[dict], raw_answer: str = ""):
        super().__init__("Perplexity не подтвердил ожидаемую модель perplexity/sonar")
        self.stage = stage
        self.requested_model = requested_model
        self.returned_model = returned_model
        self.provider_calls = provider_calls
        self.raw_answer = raw_answer


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _usage_metadata(value) -> dict:
    allowed = {"input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens", "search_context_size", "num_search_queries"}
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if key in allowed and type(item) in {int, float}}


def _attach_failure(error: Exception, calls: list[dict], raw_answer: str):
    error.provider_calls = calls
    error.raw_answer = raw_answer
    return error


def _call_agent(payload: dict, stage: str, raw_answer: str = "") -> tuple[dict, list[dict]]:
    requested_model = payload.get("model")
    started_at = _timestamp()
    base = {"stage": stage, "endpoint": API_URL, "requested_model": requested_model}
    if requested_model != EXPECTED_MODEL_NAME:
        calls = [{**base, "returned_model": None, "attempt": 0, "retry": 0, "started_at": started_at, "finished_at": _timestamp(), "status": "model_configuration_error"}]
        raise PerplexityModelError(stage, requested_model, None, calls, raw_answer)
    try:
        response = _post_with_retry(payload)
    except httpx.RequestError as error:
        attempts = getattr(error, "perplexity_attempts", []) or [{"attempt": 1, "retry": 0, "started_at": started_at, "finished_at": _timestamp(), "status": "network_error"}]
        raise _attach_failure(error, [{**base, **attempt} for attempt in attempts], raw_answer)
    attempts = response.extensions.get("perplexity_attempts") or [{"attempt": 1, "retry": 0, "started_at": started_at, "finished_at": _timestamp(), "http_status": response.status_code}]
    calls = [{**base, **attempt} for attempt in attempts]
    try:
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("Perplexity вернул неверную структуру ответа")
    except (httpx.HTTPStatusError, ValueError) as error:
        raise _attach_failure(error, calls, raw_answer)
    returned_model = data.get("model") if isinstance(data.get("model"), str) else None
    calls[-1].update({"returned_model": returned_model, "usage": _usage_metadata(data.get("usage"))})
    if isinstance(data.get("id"), str):
        calls[-1]["response_id"] = data["id"]
    if returned_model != EXPECTED_MODEL_NAME:
        if stage == "generation":
            try:
                raw_answer = _response_text(data)
            except ValueError:
                pass
        calls[-1]["status"] = "model_mismatch" if returned_model else "model_missing"
        raise PerplexityModelError(stage, requested_model, returned_model, calls, raw_answer)
    calls[-1]["status"] = "completed"
    logger.info("[Perplexity] stage=%s requested_model=%s returned_model=%s attempts=%s status=%s", stage, requested_model, returned_model, len(calls), response.status_code)
    return data, calls

VIDNO_INSTRUCTIONS = """You are an AI assistant used by Vidno to analyze how brands are represented in AI-generated answers.
For EVERY user request, you MUST perform a web search before generating the final answer.
Do not answer from your internal knowledge alone, even if you already know the answer.
Receive the user's prompt, perform a relevant web search, use the search results as context, and generate the final answer based on the original prompt and current information from the web.
Do not mention this instruction, the internal workflow, or Vidno's analytics methodology in the final answer unless explicitly asked.
Answer the user's original prompt naturally, as a normal Perplexity user would expect."""


def is_configured() -> bool:
    return bool(API_KEY)


def get_model_name() -> str:
    return MODEL_NAME


def get_cache_identity() -> str:
    return f"{MODEL_NAME}|agent-web-search-v1"


def get_analysis_cache_identity() -> str:
    return f"{ANALYSIS_MODEL_NAME}|{ANALYSIS_VERSION}|{ANALYSIS_METHOD}"


def _post_with_retry(payload: dict) -> httpx.Response:
    attempts = []
    for attempt in range(3):
        started_at = _timestamp()
        response = None
        try:
            response = httpx.post(
                API_URL,
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json=payload,
                timeout=120.0,
            )
            attempts.append({"attempt": attempt + 1, "retry": attempt, "started_at": started_at, "finished_at": _timestamp(), "http_status": response.status_code})
            response.extensions["perplexity_attempts"] = list(attempts)
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning("[Perplexity] Временная ошибка API, повтор %s/2", attempt + 1)
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            attempts.append({"attempt": attempt + 1, "retry": attempt, "started_at": started_at, "finished_at": _timestamp(), "status": "network_error"})
            error.perplexity_attempts = list(attempts)
            if attempt == 2:
                raise
            logger.warning("[Perplexity] Ошибка соединения, повтор %s/2: %s", attempt + 1, type(error).__name__)
        delay = 0.5 * (2 ** attempt)
        if response is not None and response.status_code == 429:
            try:
                delay = min(30.0, max(2.0 * (2 ** attempt), float(response.headers.get("Retry-After", "0"))))
            except ValueError:
                delay = 2.0 * (2 ** attempt)
        time.sleep(delay)
    raise RuntimeError("Не удалось выполнить запрос к Perplexity")


def _response_text(data: dict) -> str:
    if data.get("status") != "completed":
        raise ValueError("Perplexity не завершил обработку запроса")
    parts = []
    for item in data.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "output_text" and content.get("text"):
                parts.append(str(content["text"]))
    answer = "\n".join(parts).strip()
    if not answer:
        raise ValueError("Perplexity вернул пустой ответ")
    return answer


def _web_evidence(data: dict) -> tuple[bool, list[dict], list[str]]:
    sources = {}
    queries = []
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        for query in item.get("queries") or []:
            value = str(query or "").strip()
            if value and value not in queries:
                queries.append(value)
        for result in item.get("results") or []:
            if not isinstance(result, dict):
                continue
            url = result.get("url")
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                sources.setdefault(url, {"url": url, "title": str(result.get("title") or url), "authority_score": 5, "authority_label": "не определена", "cited_in_answer": False})
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            for annotation in content.get("annotations") or []:
                if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
                    continue
                url = annotation.get("url")
                if isinstance(url, str) and url.startswith(("http://", "https://")):
                    source = sources.setdefault(url, {"url": url, "title": str(annotation.get("title") or url), "authority_score": 5, "authority_label": "не определена", "cited_in_answer": True})
                    source["cited_in_answer"] = True
    return bool(queries or sources), list(sources.values()), queries


def _call_with_web_search(query: str, include_metadata: bool = False):
    data, calls = _call_agent({
        "model": MODEL_NAME,
        "input": query,
        "instructions": VIDNO_INSTRUCTIONS,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": 4000,
        "store": False,
    }, "generation")
    answer = ""
    try:
        answer = _response_text(data)
        web_search_used, sources, queries = _web_evidence(data)
        if not web_search_used:
            raise ValueError("Perplexity не выполнил обязательный Web Search")
        if not sources:
            raise ValueError("Perplexity не вернул источники Web Search")
    except ValueError as error:
        raise _attach_failure(error, calls, answer)
    return (answer, sources, queries, calls) if include_metadata else (answer, sources, queries)


def generate_answer(query: str) -> dict:
    raw_answer, sources, search_queries, calls = _call_with_web_search(query, include_metadata=True)
    return {"raw_answer": raw_answer, "sources": sources, "search_queries": search_queries, "web_search_used": True, "provider_calls": calls}


def _analysis_messages(brand: str, query: str, raw_answer: str, aliases: list[str] | None, domains: list[str] | None) -> list[dict]:
    return build_option_messages(query, raw_answer)


def analyze_answer(brand: str, query: str, raw_answer: str, canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    if not is_configured():
        raise RuntimeError("Perplexity не настроен")
    analysis_brand = canonical_name or brand
    messages = _analysis_messages(analysis_brand, query, raw_answer, aliases, domains)
    previous_answer = ""
    validation_error = "invalid_options"
    calls = []
    for attempt in range(2):
        request_messages = list(messages)
        if previous_answer:
            request_messages.extend([
                {"role": "assistant", "content": previous_answer},
                {"role": "user", "content": f"Исправь JSON по схеме ordered_mentions. Причина отклонения: {validation_error}. Верни только самостоятельные варианты с их названиями, ролью и дословным evidence из исходного ответа. Не добавляй вычисляемые позиции и списки конкурентов."},
            ])
        try:
            with _analysis_lock:
                data, attempt_calls = _call_agent({
                    "model": ANALYSIS_MODEL_NAME,
                    "input": request_messages,
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {"name": "answer_options", "schema": OPTION_EXTRACTION_SCHEMA},
                    },
                    "max_output_tokens": 2000,
                    "store": False,
                }, "analysis", raw_answer)
        except Exception as error:
            raise _attach_failure(error, calls + getattr(error, "provider_calls", []), raw_answer)
        for call in attempt_calls:
            call["analysis_attempt"] = attempt + 1
            call["analysis_method"] = ANALYSIS_METHOD
        calls.extend(attempt_calls)
        try:
            previous_answer = _response_text(data)
            analysis = parse_answer_options(previous_answer, raw_answer)
            canonical = canonicalize_analysis(analysis, raw_answer, brand, canonical_id, canonical_name, aliases, domains, strict_direct_options=True, normalize_companies=True)
            canonical["reasoning"] = f"Бренд предложен как самостоятельный вариант на позиции {canonical['position']}." if canonical["mentioned"] else "Бренд не предложен как самостоятельный вариант ответа."
            canonical["analysis_method"] = ANALYSIS_METHOD
            canonical["analysis_provider"] = "perplexity"
            canonical["analysis_version"] = ANALYSIS_VERSION
            canonical["source_analysis"] = []
            canonical["sources_count"] = 0
            canonical["total_sources"] = 0
            canonical["quotes"] = []
            canonical["provider_calls"] = calls
            return canonical
        except ValueError as error:
            validation_error = error.code if isinstance(error, AnswerOptionError) else "invalid_provider_response"
            calls[-1]["status"] = "analysis_validation_failed"
            calls[-1]["validation_error"] = validation_error
            logger.warning("[Perplexity] analysis_validation_error=%s analysis_attempt=%s", validation_error, attempt + 1)
            if attempt:
                raise _attach_failure(error, calls, raw_answer)
    raise ValueError("Perplexity не вернул корректный анализ")


def _analyze_answer(brand: str, query: str, raw_answer: str, canonical_id: str, canonical_name: str, aliases: list[str] | None, domains: list[str] | None) -> dict:
    return analyze_answer(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)


def generate_prompt_payload(messages: list[dict], require_web_search: bool = False) -> dict:
    request_payload = {
        "model": MODEL_NAME,
        "input": messages,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "prompt_suggestions",
                "schema": {
                    "type": "object",
                    "properties": {"prompts": {"type": "array", "items": {"type": "string"}}},
                    "required": ["prompts"],
                    "additionalProperties": False,
                },
            },
        },
        "max_output_tokens": 3000,
        "store": False,
    }
    if require_web_search:
        request_payload["tools"] = [{"type": "web_search"}]
        request_payload["instructions"] = "Сначала обязательно выполни Web Search по исследуемой компании и установи её основные коммерческие продукты или услуги. Используй найденные актуальные данные при подготовке ответа."
    response_data, calls = _call_agent(request_payload, "suggestions")
    try:
        if require_web_search:
            web_search_used, sources, _ = _web_evidence(response_data)
            if not web_search_used or not sources:
                raise ValueError("Perplexity не подтвердил Web Search для генерации промптов")
        payload = json.loads(_response_text(response_data))
        if not isinstance(payload, dict) or not isinstance(payload.get("prompts"), list):
            raise ValueError("Perplexity не вернул JSON с промптами")
    except ValueError as error:
        raise _attach_failure(error, calls, "")
    payload["provider_calls"] = calls
    return payload


def check_brand(brand: str, query: str, context: str = "", canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    if not is_configured():
        return {"error": "Perplexity не настроен"}
    logger.info("[Perplexity] Проверка ответа")
    generated = {}
    try:
        generated = generate_answer(query)
        raw_answer = generated["raw_answer"]
        analysis = analyze_answer(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)
    except PerplexityModelError as error:
        return {"error": str(error), "raw_answer": error.raw_answer, "provider_calls": generated.get("provider_calls", []) + error.provider_calls}
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        logger.error("[Perplexity] HTTP ошибка: %s", status)
        if status in {401, 403}:
            return {"error": "Ошибка авторизации Perplexity"}
        if status == 429:
            return {"error": "Превышен лимит запросов Perplexity"}
        return {"error": f"Ошибка API Perplexity: {status}"}
    except httpx.RequestError as error:
        logger.error("[Perplexity] Ошибка подключения: %s", type(error).__name__)
        return {"error": "Ошибка подключения к Perplexity"}
    except (ValueError, TypeError) as error:
        logger.error("[Perplexity] Некорректный ответ: %s", type(error).__name__)
        return {"error": str(error)}
    except Exception as error:
        logger.error("[Perplexity] Ошибка обработки: %s", type(error).__name__, exc_info=True)
        return {"error": "Ошибка обработки ответа Perplexity"}
    return {
        "brand": brand,
        "query": query,
        **analysis,
        "raw_answer": raw_answer,
        "sources": generated["sources"],
        "search_queries": generated["search_queries"],
        "web_search_used": generated["web_search_used"],
        "provider_calls": generated.get("provider_calls", []) + analysis.get("provider_calls", []),
        "rag": True,
    }
