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


def _call_gigachat(messages: list, temperature: float | None = None, max_tokens: int = 2000, response_format: dict | None = None) -> str:
    if not is_configured():
        raise RuntimeError("GigaChat не настроен")
    
    payload = {
        "model": MODEL_NAME,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False
    }
    if temperature is not None:
        payload["temperature"] = temperature
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


def generate_natural_answer(query: str, context: str) -> str:
    messages = [
        {"role": "system", "content": "Ответь как обычный AI-ассистент в пользовательском приложении. Используй предоставленные поисковые материалы как актуальную справку, но не обсуждай внутренний поиск, мониторинг или анализ брендов. Дай прямой, полезный и естественный ответ на запрос пользователя. Не выдумывай факты, которых нет в материалах."},
        {"role": "user", "content": f"<search_context>\n{context}\n</search_context>\n\nЗапрос пользователя: {query}"},
    ]
    return _call_gigachat(messages, max_tokens=3000)


def generate_answer(query: str, context: str) -> dict:
    if not is_configured():
        return {"error": "GigaChat не настроен"}
    if not context or not context.strip():
        return {"error": "Контекст не предоставлен. Соберите данные через search_collector."}
    try:
        raw_answer = generate_natural_answer(query, context)
    except httpx.HTTPStatusError as e:
        status = e.response.status_code
        logger.error("[GigaChat] HTTP ошибка: %s", status)
        if status in {401, 403}:
            return {"error": "Ошибка авторизации GigaChat"}
        if status == 429:
            return {"error": "Превышен лимит запросов GigaChat"}
        return {"error": f"Ошибка API GigaChat: {status}"}
    except httpx.RequestError as e:
        logger.error("[GigaChat] Ошибка запроса: %s", e)
        return {"error": "Ошибка подключения к GigaChat"}
    except ValueError as e:
        logger.error("[GigaChat] Некорректный ответ: %s", e)
        return {"error": "GigaChat вернул некорректный ответ"}
    except Exception as e:
        logger.error("[GigaChat] Ошибка обработки: %s", type(e).__name__, exc_info=True)
        return {"error": "Ошибка обработки ответа GigaChat"}
    return {"raw_answer": raw_answer, "sources": []}


def check_brand(brand: str, query: str, context: str, canonical_id: str = "", canonical_name: str = "", aliases: list[str] | None = None, domains: list[str] | None = None) -> dict:
    generated = generate_answer(query, context)
    if "error" in generated:
        return generated
    return {
        "brand": brand,
        "query": query,
        **generated,
        "rag": True
    }
