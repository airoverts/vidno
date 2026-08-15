import hashlib
import logging
import os
import time

import httpx
from dotenv import load_dotenv

from gigachat_client import analyze_natural_answer

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("YANDEX_API_KEY", "").strip()
AGENT_ID = os.getenv("YANDEX_AGENT_ID", "").strip()
API_URL = "https://ai.api.cloud.yandex.net/v1/responses"
MODEL_NAME = "YandexGPT Agent"


def is_configured() -> bool:
    return bool(API_KEY and AGENT_ID)


def get_model_name() -> str:
    return MODEL_NAME


def get_cache_identity() -> str:
    fingerprint = hashlib.sha256(AGENT_ID.encode()).hexdigest()[:16] if AGENT_ID else "unconfigured"
    return f"{MODEL_NAME}:{fingerprint}"


def _post_with_retry(payload: dict) -> httpx.Response:
    for attempt in range(3):
        try:
            response = httpx.post(
                API_URL,
                headers={
                    "Authorization": f"Api-Key {API_KEY}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json=payload,
                timeout=90.0,
            )
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning("[YandexGPT] Временная ошибка API, повтор %s/2", attempt + 1)
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            if attempt == 2:
                raise
            logger.warning("[YandexGPT] Ошибка соединения, повтор %s/2: %s", attempt + 1, type(error).__name__)
        time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("Не удалось выполнить запрос к YandexGPT")


def _response_text(data: dict) -> str:
    status = data.get("status")
    if status != "completed":
        raise ValueError(f"YandexGPT завершил запрос со статусом {status or 'unknown'}")
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
        raise ValueError("YandexGPT вернул пустой ответ")
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


def _call_agent(query: str) -> tuple[str, list[dict], bool]:
    response = _post_with_retry({
        "prompt": {"id": AGENT_ID},
        "input": query,
        "stream": False,
        "store": False,
    })
    response.raise_for_status()
    data = response.json()
    web_search_used, sources = _web_evidence(data)
    return _response_text(data), sources, web_search_used


def check_brand(brand: str, query: str, context: str = "", canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    if not is_configured():
        return {"error": "YandexGPT не настроен"}
    logger.info("[YandexGPT] Проверка бренда %r по запросу %r", brand[:80], query[:120])
    try:
        raw_answer, sources, web_search_used = _call_agent(query)
        if not web_search_used or not sources:
            return {"error": "Встроенный веб-поиск Алисы не подтверждён источниками"}
        analysis = analyze_natural_answer(brand, query, raw_answer, canonical_id, canonical_name, aliases, domains)
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        logger.error("[YandexGPT] HTTP ошибка: %s", status)
        if status in {401, 403}:
            return {"error": "Ошибка авторизации YandexGPT"}
        if status == 429:
            return {"error": "Превышен лимит запросов YandexGPT"}
        return {"error": f"Ошибка API YandexGPT: {status}"}
    except httpx.RequestError as error:
        logger.error("[YandexGPT] Ошибка подключения: %s", type(error).__name__)
        return {"error": "Ошибка подключения к YandexGPT"}
    except (ValueError, TypeError) as error:
        logger.error("[YandexGPT] Некорректный ответ: %s", error)
        return {"error": "YandexGPT вернул некорректный ответ"}
    except Exception as error:
        logger.error("[YandexGPT] Ошибка обработки: %s", type(error).__name__, exc_info=True)
        return {"error": "Ошибка обработки ответа YandexGPT"}

    return {
        "brand": brand,
        "query": query,
        **analysis,
        "raw_answer": raw_answer,
        "sources": sources,
        "web_search_used": True,
        "rag": True,
    }
