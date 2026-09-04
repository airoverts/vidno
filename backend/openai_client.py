import logging
import os
import time

import httpx
from dotenv import load_dotenv

from brand_identity import canonicalize_analysis
from rag_analysis import ANALYSIS_RESPONSE_SCHEMA, build_answer_analysis_messages, parse_analysis_response

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
MODEL_NAME = os.getenv("OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
API_URL = "https://api.openai.com/v1/responses"


def is_configured() -> bool:
    return bool(API_KEY)


def get_model_name() -> str:
    return MODEL_NAME


def get_cache_identity() -> str:
    return f"{MODEL_NAME}:ru-market-v1"


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
                timeout=90.0,
            )
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning("[OpenAI] Временная ошибка API, повтор %s/2", attempt + 1)
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            if attempt == 2:
                raise
            logger.warning("[OpenAI] Ошибка соединения, повтор %s/2: %s", attempt + 1, type(error).__name__)
        time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("Не удалось выполнить запрос к OpenAI")


def _response_text(data: dict) -> str:
    if data.get("status") != "completed":
        raise ValueError(f"OpenAI завершил запрос со статусом {data.get('status') or 'unknown'}")
    output_text = data.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()
    parts = []
    for item in data.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "output_text" and content.get("text"):
                parts.append(str(content["text"]))
    answer = "\n".join(parts).strip()
    if not answer:
        raise ValueError("OpenAI вернул пустой ответ")
    return answer


def _web_evidence(data: dict) -> tuple[bool, list[dict]]:
    web_search_used = False
    sources = {}
    for item in data.get("output") or []:
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type", "")).lower()
        status = str(item.get("status", "completed")).lower()
        if item_type in {"web_search", "web_search_call"} and status in {"completed", "succeeded"}:
            web_search_used = True
        action = item.get("action") if isinstance(item.get("action"), dict) else {}
        for source in action.get("sources") or []:
            if not isinstance(source, dict):
                continue
            url = source.get("url")
            if isinstance(url, str) and url.startswith(("http://", "https://")):
                sources.setdefault(url, {"url": url, "title": str(source.get("title") or url), "authority_score": 5, "authority_label": "не определена"})
        if item_type != "message":
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict) or content.get("type") != "output_text":
                continue
            for annotation in content.get("annotations") or []:
                if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
                    continue
                url = annotation.get("url")
                if isinstance(url, str) and url.startswith(("http://", "https://")):
                    sources.setdefault(url, {"url": url, "title": str(annotation.get("title") or url), "authority_score": 5, "authority_label": "не определена"})
    return web_search_used, list(sources.values())


def _call_with_web_search(query: str) -> tuple[str, list[dict]]:
    response = _post_with_retry({
        "model": MODEL_NAME,
        "instructions": "Перед формированием каждого ответа обязательно используй Web Search для получения актуальной информации. Не отвечай на запрос пользователя до выполнения Web Search. Используй результаты Web Search при формировании финального ответа. Пользователь находится в России и спрашивает о российском рынке. Рассматривай только бренды, компании, товары и услуги, которые реально доступны российскому пользователю. Отдавай приоритет актуальным российским источникам и официальным русскоязычным сайтам. Не предлагай варианты, работающие только в США или других зарубежных странах. Отвечай на русском языке.",
        "tools": [{"type": "web_search"}],
        "tool_choice": "required",
        "include": ["web_search_call.action.sources"],
        "input": query,
        "store": False,
    })
    response.raise_for_status()
    data = response.json()
    answer = _response_text(data)
    web_search_used, sources = _web_evidence(data)
    if not web_search_used:
        raise ValueError("OpenAI не выполнил обязательный Web Search")
    if not sources:
        raise ValueError("OpenAI не вернул источники Web Search")
    return answer, sources


def _analyze_answer(brand: str, query: str, raw_answer: str, canonical_id: str, canonical_name: str, aliases: list[str] | None, domains: list[str] | None) -> dict:
    analysis_brand = canonical_name or brand
    response = _post_with_retry({
        "model": MODEL_NAME,
        "input": build_answer_analysis_messages(analysis_brand, query, raw_answer, aliases, domains),
        "text": {
            "format": {
                "type": "json_schema",
                "name": "brand_visibility_analysis",
                "schema": ANALYSIS_RESPONSE_SCHEMA,
                "strict": True,
            }
        },
        "store": False,
    })
    response.raise_for_status()
    answer = _response_text(response.json())
    analysis = parse_analysis_response(answer, raw_answer, target_brand=analysis_brand)
    return canonicalize_analysis(analysis, raw_answer, brand, canonical_id, canonical_name, aliases, domains)


def check_brand(brand: str, query: str, context: str = "", canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    if not is_configured():
        return {"error": "ChatGPT не настроен"}
    logger.info("[OpenAI] Проверка бренда %r по запросу %r", brand[:80], query[:120])
    try:
        raw_answer, sources = _call_with_web_search(query)
        analysis = _analyze_answer(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        logger.error("[OpenAI] HTTP ошибка: %s", status)
        if status in {401, 403}:
            return {"error": "Ошибка авторизации ChatGPT"}
        if status == 429:
            return {"error": "Превышен лимит запросов ChatGPT"}
        return {"error": f"Ошибка API ChatGPT: {status}"}
    except httpx.RequestError as error:
        logger.error("[OpenAI] Ошибка подключения: %s", type(error).__name__)
        return {"error": "Ошибка подключения к ChatGPT"}
    except (ValueError, TypeError) as error:
        logger.error("[OpenAI] Некорректный ответ: %s", error)
        return {"error": str(error)}
    except Exception as error:
        logger.error("[OpenAI] Ошибка обработки: %s", type(error).__name__, exc_info=True)
        return {"error": "Ошибка обработки ответа ChatGPT"}
    return {
        "brand": brand,
        "query": query,
        **analysis,
        "raw_answer": raw_answer,
        "sources": sources,
        "market_scope": "ru",
        "web_search_used": True,
        "rag": True,
    }
