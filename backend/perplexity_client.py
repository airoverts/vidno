import logging
import json
import os
import time

import httpx
from dotenv import load_dotenv

from brand_identity import canonicalize_analysis
from rag_analysis import ANALYSIS_RESPONSE_SCHEMA, build_answer_analysis_messages, parse_analysis_response

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("PERPLEXITY_API_KEY", "").strip()
MODEL_NAME = os.getenv("PERPLEXITY_MODEL", "perplexity/sonar").strip() or "perplexity/sonar"
API_URL = "https://api.perplexity.ai/v1/agent"

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


def _post_with_retry(payload: dict) -> httpx.Response:
    for attempt in range(3):
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
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning("[Perplexity] Временная ошибка API, повтор %s/2", attempt + 1)
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            if attempt == 2:
                raise
            logger.warning("[Perplexity] Ошибка соединения, повтор %s/2: %s", attempt + 1, type(error).__name__)
        time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("Не удалось выполнить запрос к Perplexity")


def _response_text(data: dict) -> str:
    if data.get("status") != "completed":
        error = data.get("error") if isinstance(data.get("error"), dict) else {}
        raise ValueError(str(error.get("message") or f"Perplexity завершил запрос со статусом {data.get('status') or 'unknown'}"))
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
                sources.setdefault(url, {"url": url, "title": str(result.get("title") or url), "authority_score": 5, "authority_label": "не определена"})
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            for annotation in content.get("annotations") or []:
                if not isinstance(annotation, dict):
                    continue
                url = annotation.get("url")
                if isinstance(url, str) and url.startswith(("http://", "https://")):
                    sources.setdefault(url, {"url": url, "title": str(annotation.get("title") or url), "authority_score": 5, "authority_label": "не определена"})
    return bool(queries or sources), list(sources.values()), queries


def _call_with_web_search(query: str) -> tuple[str, list[dict], list[str]]:
    response = _post_with_retry({
        "model": MODEL_NAME,
        "input": query,
        "instructions": VIDNO_INSTRUCTIONS,
        "tools": [{"type": "web_search"}],
        "max_output_tokens": 4000,
        "store": False,
    })
    response.raise_for_status()
    data = response.json()
    answer = _response_text(data)
    web_search_used, sources, queries = _web_evidence(data)
    if not web_search_used:
        raise ValueError("Perplexity не выполнил обязательный Web Search")
    if not sources:
        raise ValueError("Perplexity не вернул источники Web Search")
    return answer, sources, queries


def _analyze_answer(brand: str, query: str, raw_answer: str, canonical_id: str, canonical_name: str, aliases: list[str] | None, domains: list[str] | None) -> dict:
    analysis_brand = canonical_name or brand
    response = _post_with_retry({
        "model": MODEL_NAME,
        "input": build_answer_analysis_messages(analysis_brand, query, raw_answer, aliases, domains),
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "brand_visibility_analysis", "schema": ANALYSIS_RESPONSE_SCHEMA},
        },
        "max_output_tokens": 4000,
        "store": False,
    })
    response.raise_for_status()
    analysis = parse_analysis_response(_response_text(response.json()), raw_answer, target_brand=analysis_brand)
    return canonicalize_analysis(analysis, raw_answer, brand, canonical_id, canonical_name, aliases, domains)


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
    response = _post_with_retry(request_payload)
    response.raise_for_status()
    response_data = response.json()
    if require_web_search:
        web_search_used, sources, _ = _web_evidence(response_data)
        if not web_search_used or not sources:
            raise ValueError("Perplexity не подтвердил Web Search для генерации промптов")
    payload = json.loads(_response_text(response_data))
    if not isinstance(payload, dict) or not isinstance(payload.get("prompts"), list):
        raise ValueError("Perplexity не вернул JSON с промптами")
    return payload


def check_brand(brand: str, query: str, context: str = "", canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    if not is_configured():
        return {"error": "Perplexity не настроен"}
    logger.info("[Perplexity] Проверка бренда %r по запросу %r", brand[:80], query[:120])
    try:
        raw_answer, sources, search_queries = _call_with_web_search(query)
        analysis = _analyze_answer(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)
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
        logger.error("[Perplexity] Некорректный ответ: %s", error)
        return {"error": str(error)}
    except Exception as error:
        logger.error("[Perplexity] Ошибка обработки: %s", type(error).__name__, exc_info=True)
        return {"error": "Ошибка обработки ответа Perplexity"}
    return {
        "brand": brand,
        "query": query,
        **analysis,
        "raw_answer": raw_answer,
        "sources": sources,
        "search_queries": search_queries,
        "web_search_used": True,
        "rag": True,
    }
