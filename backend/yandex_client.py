import hashlib
import logging
import os
import time

import httpx
from dotenv import load_dotenv

from rag_analysis import build_analysis_messages, parse_analysis_response

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


def _build_input(brand: str, query: str, context: str) -> str:
    messages = build_analysis_messages(brand, query, context)
    return "\n\n".join(str(message.get("content", "")) for message in messages if message.get("content"))


def _call_agent(brand: str, query: str, context: str) -> str:
    response = _post_with_retry({
        "prompt": {"id": AGENT_ID},
        "input": _build_input(brand, query, context),
        "stream": False,
        "store": False,
    })
    response.raise_for_status()
    return _response_text(response.json())


def check_brand(brand: str, query: str, context: str) -> dict:
    if not is_configured():
        return {"error": "YandexGPT не настроен"}
    if not context or not context.strip():
        return {"error": "Контекст не предоставлен"}

    logger.info("[YandexGPT] Проверка бренда %r по запросу %r", brand[:80], query[:120])
    try:
        answer = _call_agent(brand, query, context)
        analysis = parse_analysis_response(answer, context)
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
        "rag": True,
    }
