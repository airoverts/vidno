import logging
import os
import time

import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import errors, types

from brand_identity import canonicalize_analysis
from rag_analysis import ANALYSIS_RESPONSE_SCHEMA, build_answer_analysis_messages, parse_analysis_response

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip() or "gemini-3.6-flash"

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(api_key=API_KEY, http_options=types.HttpOptions(timeout=90000))
    return _client


def is_configured() -> bool:
    return bool(API_KEY)


def get_model_name() -> str:
    return MODEL_NAME


def _response_text(response) -> str:
    answer = str(getattr(response, "text", "") or "").strip()
    if answer:
        return answer
    candidates = getattr(response, "candidates", None) or []
    finish_reason = getattr(candidates[0], "finish_reason", None) if candidates else None
    if finish_reason:
        raise ValueError(f"Gemini не сформировал ответ: {finish_reason}")
    raise ValueError("Gemini вернул пустой ответ")


def _grounding_evidence(response) -> tuple[list[str], list[dict]]:
    candidates = getattr(response, "candidates", None) or []
    metadata = getattr(candidates[0], "grounding_metadata", None) if candidates else None
    queries = []
    for query in getattr(metadata, "web_search_queries", None) or []:
        value = str(query or "").strip()
        if value and value not in queries:
            queries.append(value)
    sources = {}
    for chunk in getattr(metadata, "grounding_chunks", None) or []:
        web = getattr(chunk, "web", None)
        url = str(getattr(web, "uri", "") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        sources.setdefault(url, {
            "url": url,
            "title": str(getattr(web, "title", "") or url),
            "authority_score": 5,
            "authority_label": "не определена",
        })
    return queries, list(sources.values())


def _call_with_google_search(query: str) -> tuple[str, list[dict], list[str]]:
    response = _get_client().models.generate_content(
        model=MODEL_NAME,
        contents=query,
        config=types.GenerateContentConfig(
            system_instruction="Перед формированием каждого ответа обязательно выполни Google Search для получения актуальной информации. Не отвечай на запрос пользователя до выполнения Google Search. Используй найденные данные при формировании финального ответа.",
            tools=[types.Tool(google_search=types.GoogleSearch())],
        ),
    )
    answer = _response_text(response)
    queries, sources = _grounding_evidence(response)
    if not queries:
        raise ValueError("Gemini не выполнил обязательный Google Search")
    if not sources:
        raise ValueError("Gemini не вернул источники Google Search")
    return answer, sources, queries


def _analyze_answer(brand: str, query: str, raw_answer: str, canonical_id: str, canonical_name: str, aliases: list[str] | None, domains: list[str] | None) -> dict:
    analysis_brand = canonical_name or brand
    messages = build_answer_analysis_messages(analysis_brand, query, raw_answer, aliases, domains)
    for attempt in range(3):
        try:
            response = _get_client().models.generate_content(
                model=MODEL_NAME,
                contents=messages[1]["content"],
                config=types.GenerateContentConfig(
                    system_instruction=messages[0]["content"],
                    response_mime_type="application/json",
                    response_json_schema=ANALYSIS_RESPONSE_SCHEMA,
                ),
            )
            break
        except errors.ServerError:
            if attempt == 2:
                raise
            time.sleep(0.5 * (2 ** attempt))
    analysis = parse_analysis_response(_response_text(response), raw_answer, target_brand=analysis_brand)
    return canonicalize_analysis(analysis, raw_answer, brand, canonical_id, canonical_name, aliases, domains)


def _api_error_message(error: errors.APIError) -> str:
    code = getattr(error, "code", None)
    message = str(getattr(error, "message", "") or "").lower()
    status = str(getattr(error, "status", "") or "").upper()
    if code == 400 and ("user location is not supported" in message or status == "FAILED_PRECONDITION"):
        return "Gemini недоступен из текущего региона сервера"
    if code in {401, 403}:
        return "Ошибка авторизации Gemini"
    if code == 429:
        return "Превышен лимит запросов Gemini"
    return f"Ошибка API Gemini: {code or 'unknown'}"


def generate_answer(query: str) -> dict:
    if not is_configured():
        return {"error": "Gemini не настроен"}
    logger.info("[Gemini] Генерация ответа по запросу %r", query[:120])
    try:
        raw_answer, sources, _ = _call_with_google_search(query)
    except errors.APIError as error:
        logger.error("[Gemini] Ошибка API: %s", getattr(error, "code", "unknown"))
        return {"error": _api_error_message(error)}
    except (httpx.RequestError, TimeoutError, ConnectionError) as error:
        logger.error("[Gemini] Ошибка подключения: %s", type(error).__name__)
        return {"error": "Ошибка подключения к Gemini"}
    except (ValueError, TypeError) as error:
        logger.error("[Gemini] Некорректный ответ: %s", error)
        return {"error": str(error)}
    except Exception as error:
        logger.error("[Gemini] Ошибка обработки: %s", type(error).__name__, exc_info=True)
        return {"error": "Ошибка обработки ответа Gemini"}
    return {"raw_answer": raw_answer, "sources": sources}


def check_brand(brand: str, query: str, context: str = "", canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    generated = generate_answer(query)
    if "error" in generated:
        return generated
    return {
        "brand": brand,
        "query": query,
        **generated,
        "google_search_used": True,
        "rag": True,
    }
