import os
import time
import base64
import ssl
import threading
import uuid
from pathlib import Path
from dotenv import load_dotenv
import httpx
import logging
from rag_analysis import ANALYSIS_RESPONSE_SCHEMA, build_analysis_messages, parse_analysis_response

logger = logging.getLogger(__name__)

load_dotenv()

CLIENT_ID = os.getenv("GIGACHAT_CLIENT_ID")
CLIENT_SECRET = os.getenv("GIGACHAT_CLIENT_SECRET")
configured_model = os.getenv("GIGACHAT_MODEL", "GigaChat-2-Pro").strip()
MODEL_NAME = "GigaChat-2-Pro" if configured_model in {"GigaChat:pro", "GigaChat-Pro"} else configured_model

_access_token = None
_token_expires = 0
_token_lock = threading.Lock()


def _tls_verify():
    ca_bundle = os.getenv("GIGACHAT_CA_BUNDLE", "").strip()
    ca_path = Path(ca_bundle) if ca_bundle else Path(__file__).with_name("russian_trusted_root_ca_pem.crt")
    if not ca_path.is_absolute():
        ca_path = Path(__file__).parent / ca_path
    context = ssl.create_default_context()
    if ca_path.is_file():
        context.load_verify_locations(cafile=str(ca_path))
    return context


def _post_with_retry(url: str, **kwargs) -> httpx.Response:
    last_error = None
    for attempt in range(3):
        try:
            response = httpx.post(url, **kwargs)
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning(f"[GigaChat] Временная ошибка {response.status_code}, повтор {attempt + 1}/2")
        except httpx.TransportError as e:
            last_error = e
            if attempt == 2:
                raise
            logger.warning(f"[GigaChat] Ошибка соединения, повтор {attempt + 1}/2: {e}")
        time.sleep(0.5 * (2 ** attempt))
    if last_error:
        raise last_error
    raise RuntimeError("Не удалось выполнить запрос к GigaChat")


def _get_access_token() -> str:
    global _access_token, _token_expires
    
    if _access_token and time.time() < _token_expires - 60:
        return _access_token
    
    with _token_lock:
        if _access_token and time.time() < _token_expires - 60:
            return _access_token
        credentials = f"{CLIENT_ID}:{CLIENT_SECRET}"
        auth_header = base64.b64encode(credentials.encode()).decode()
        response = _post_with_retry(
            "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
            headers={
                "Authorization": f"Basic {auth_header}",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
                "RqUID": str(uuid.uuid4())
            },
            data={"scope": "GIGACHAT_API_PERS"},
            verify=_tls_verify(),
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        _access_token = data["access_token"]
        _token_expires = data["expires_at"] / 1000
    
    return _access_token


def is_configured() -> bool:
    return bool(CLIENT_ID) and bool(CLIENT_SECRET)


def get_model_name() -> str:
    return MODEL_NAME


def _call_gigachat(messages: list, temperature: float = 0.0, max_tokens: int = 2000, response_format: dict | None = None) -> str:
    if not is_configured():
        raise RuntimeError("GigaChat не настроен")
    
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False
    }
    if response_format:
        payload["response_format"] = response_format
    
    for attempt in range(2):
        access_token = _get_access_token()
        response = _post_with_retry(
            "https://gigachat.devices.sberbank.ru/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            json=payload,
            verify=_tls_verify(),
            timeout=60.0
        )
        if response.status_code != 401 or attempt == 1:
            break
        global _access_token, _token_expires
        with _token_lock:
            if _access_token == access_token:
                _access_token = None
                _token_expires = 0
    response.raise_for_status()
    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        raise ValueError("GigaChat вернул ответ без вариантов")
    choice = choices[0]
    finish_reason = choice.get("finish_reason")
    if finish_reason in {"length", "max_tokens"}:
        raise ValueError("ответ GigaChat обрезан по лимиту токенов")
    content = choice.get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("GigaChat вернул пустой ответ")
    return content.strip()


def analyze_brand_rag(brand: str, query: str, context: str) -> dict:
    logger.info(f"[RAG] Анализ бренда {brand[:80]!r} для запроса {query[:120]!r}")
    messages = build_analysis_messages(brand, query, context)
    response_format = {"type": "json_schema", "schema": ANALYSIS_RESPONSE_SCHEMA, "strict": True}
    answer = ""
    try:
        answer = _call_gigachat(messages, temperature=0.0, max_tokens=5000, response_format=response_format)
        analysis = parse_analysis_response(answer, context)
    except ValueError as error:
        logger.warning(f"[RAG] Повторный запрос для исправления JSON: {error}")
        repair_messages = list(messages)
        if answer:
            repair_messages.append({"role": "assistant", "content": answer})
        repair_messages.append({"role": "user", "content": "Верни заново один полный компактный JSON, соответствующий заданной схеме. Обязательно включи source_analysis для каждого источника."})
        answer = _call_gigachat(repair_messages, temperature=0.0, max_tokens=5000, response_format=response_format)
        analysis = parse_analysis_response(answer, context)
    logger.info(f"[RAG] JSON успешно проверен: mentioned={analysis['mentioned']}, position={analysis['position']}")
    return analysis


def check_brand(brand: str, query: str, context: str) -> dict:
    if not is_configured():
        logger.error("[RAG] GigaChat не настроен (отсутствуют CLIENT_ID или CLIENT_SECRET)")
        return {"error": "GigaChat не настроен"}
    
    logger.info(f"[RAG] Проверка бренда {brand[:80]!r} по запросу {query[:120]!r}")
    
    if not context or not context.strip():
        logger.error("[RAG] Контекст не предоставлен")
        return {"error": "Контекст не предоставлен. Соберите данные через search_collector."}
    
    try:
        analysis = analyze_brand_rag(brand, query, context)
    except httpx.HTTPStatusError as e:
        status = e.response.status_code
        logger.error("[RAG] HTTP ошибка GigaChat: %s", status)
        if status in {401, 403}:
            return {"error": "Ошибка авторизации GigaChat"}
        if status == 422:
            return {"error": "GigaChat отклонил параметры модели или формат ответа"}
        if status == 429:
            return {"error": "Превышен лимит запросов GigaChat"}
        return {"error": f"Ошибка API GigaChat: {status}"}
    except httpx.RequestError as e:
        logger.error(f"[RAG] Ошибка запроса: {str(e)}")
        return {"error": "Ошибка подключения к GigaChat"}
    except ValueError as e:
        logger.error("[RAG] Ответ GigaChat не прошёл проверку: %s", e)
        return {"error": "GigaChat не смог сформировать полный структурированный ответ"}
    except Exception as e:
        logger.error("[RAG] Неожиданная ошибка: %s", type(e).__name__, exc_info=True)
        return {"error": "Неожиданная ошибка при обработке ответа GigaChat"}
    
    logger.info(f"[RAG] Результат: mentioned={analysis['mentioned']}, position={analysis['position']}, role={analysis['role']}")
    
    return {
        "brand": brand,
        "query": query,
        "mentioned": analysis["mentioned"],
        "position": analysis["position"],
        "weighted_position": analysis.get("weighted_position"),
        "total_sentences": analysis["total_sentences"],
        "role": analysis["role"],
        "reasoning": analysis["reasoning"],
        "quotes": analysis["quotes"],
        "mentioned_brands": analysis["mentioned_brands"],
        "source_analysis": analysis.get("source_analysis", []),
        "sources_count": analysis.get("sources_count", 0),
        "total_sources": analysis.get("total_sources", 0),
        "rag": True
    }
