import logging
import os
import time

import httpx
from dotenv import load_dotenv

from rag_analysis import build_analysis_messages, parse_analysis_response

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("DEEPSEEK_API_KEY")
MODEL_NAME = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
API_URL = "https://api.deepseek.com/chat/completions"


def is_configured() -> bool:
    return bool(API_KEY)


def get_model_name() -> str:
    return MODEL_NAME


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
                timeout=60.0,
            )
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning(f"[DeepSeek] Временная ошибка {response.status_code}, повтор {attempt + 1}/2")
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            if attempt == 2:
                raise
            logger.warning(f"[DeepSeek] Ошибка соединения, повтор {attempt + 1}/2: {e}")
        time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("Не удалось выполнить запрос к DeepSeek")


def _call_deepseek(messages: list[dict]) -> str:
    if not is_configured():
        raise RuntimeError("DeepSeek не настроен")

    response = _post_with_retry({
        "model": MODEL_NAME,
        "messages": messages,
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"},
        "max_tokens": 4000,
        "stream": False,
    })
    response.raise_for_status()
    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        raise ValueError("DeepSeek вернул ответ без вариантов")
    content = choices[0].get("message", {}).get("content")
    if not content or not content.strip():
        raise ValueError("DeepSeek вернул пустой ответ")
    return content


def check_brand(brand: str, query: str, context: str) -> dict:
    if not is_configured():
        return {"error": "DeepSeek не настроен"}
    if not context or not context.strip():
        return {"error": "Контекст не предоставлен"}

    logger.info(f"[DeepSeek] Проверка бренда {brand[:80]!r} по запросу {query[:120]!r}")
    try:
        answer = _call_deepseek(build_analysis_messages(brand, query, context))
        analysis = parse_analysis_response(answer, context)
    except httpx.HTTPStatusError as e:
        logger.error(f"[DeepSeek] HTTP ошибка: {e.response.status_code} - {e.response.text}")
        return {"error": f"Ошибка API DeepSeek: {e.response.status_code}"}
    except httpx.RequestError as e:
        logger.error(f"[DeepSeek] Ошибка запроса: {e}")
        return {"error": "Ошибка подключения к DeepSeek"}
    except Exception as e:
        logger.error(f"[DeepSeek] Ошибка обработки ответа: {e}", exc_info=True)
        return {"error": "Ошибка обработки ответа DeepSeek"}

    return {
        "brand": brand,
        "query": query,
        **analysis,
        "rag": True,
    }
