import os
import time
import json
import logging
import threading
from datetime import datetime
from pathlib import Path
import jwt
from dotenv import load_dotenv
import httpx
from text_analysis import analyze_answer

load_dotenv()

FOLDER_ID = os.getenv("YANDEX_FOLDER_ID")
key_file = Path(os.getenv("YANDEX_KEY_FILE", "authorized_key.json"))
KEY_FILE_PATH = key_file if key_file.is_absolute() else Path(__file__).parent / key_file

logger = logging.getLogger(__name__)

_iam_token = None
_iam_token_expires = 0
_service_account_id = None
_private_key = None
_key_id = None
_token_lock = threading.Lock()


def _load_key():
    global _service_account_id, _private_key, _key_id
    
    if _service_account_id and _private_key:
        return
    
    with KEY_FILE_PATH.open("r", encoding="utf-8") as f:
        key_data = json.load(f)
    
    _service_account_id = key_data["service_account_id"]
    _private_key = key_data["private_key"]
    _key_id = key_data["id"]


def _create_jwt() -> str:
    _load_key()
    
    now = int(time.time())
    payload = {
        "aud": "https://iam.api.cloud.yandex.net/iam/v1/tokens",
        "iss": _service_account_id,
        "iat": now,
        "exp": now + 3600
    }
    
    encoded = jwt.encode(
        payload,
        _private_key,
        algorithm="PS256",
        headers={"kid": _key_id}
    )
    
    return encoded


def _post_with_retry(url: str, **kwargs) -> httpx.Response:
    for attempt in range(3):
        try:
            response = httpx.post(url, **kwargs)
            if response.status_code not in {429, 500, 502, 503, 504} or attempt == 2:
                return response
            logger.warning(f"[YandexGPT] Временная ошибка {response.status_code}, повтор {attempt + 1}/2")
        except (httpx.TimeoutException, httpx.NetworkError):
            if attempt == 2:
                raise
        time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError("Не удалось выполнить запрос к YandexGPT")


def _get_iam_token() -> str:
    global _iam_token, _iam_token_expires
    
    if _iam_token and time.time() < _iam_token_expires - 60:
        return _iam_token
    
    with _token_lock:
        if _iam_token and time.time() < _iam_token_expires - 60:
            return _iam_token
        jwt_token = _create_jwt()
        response = _post_with_retry(
            "https://iam.api.cloud.yandex.net/iam/v1/tokens",
            json={"jwt": jwt_token},
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        _iam_token = data["iamToken"]
        expires_at = data.get("expiresAt")
        try:
            _iam_token_expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp()
        except (AttributeError, TypeError, ValueError):
            _iam_token_expires = time.time() + 11 * 3600
    
    return _iam_token


def is_configured() -> bool:
    return bool(FOLDER_ID) and os.path.exists(KEY_FILE_PATH)


def check_brand(brand: str, query: str) -> dict:
    global _iam_token, _iam_token_expires

    if not is_configured():
        return {"error": "YandexGPT не настроен"}
    
    try:
        iam_token = _get_iam_token()
    except Exception as e:
        logger.error(f"[YandexGPT] Ошибка получения IAM токена: {e}", exc_info=True)
        return {"error": "Ошибка получения IAM токена YandexGPT"}
    
    model_uri = f"gpt://{FOLDER_ID}/yandexgpt-lite"
    
    payload = {
        "modelUri": model_uri,
        "completionOptions": {
            "stream": False,
            "temperature": 0.6,
            "maxTokens": 2000
        },
        "messages": [
            {
                "role": "system",
                "text": "Ты AI-ассистент. Отвечай на русском языке, развёрнуто и полезно."
            },
            {
                "role": "user",
                "text": query
            }
        ]
    }
    
    try:
        for attempt in range(2):
            response = _post_with_retry(
                "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
                headers={
                    "Authorization": f"Bearer {iam_token}",
                    "Content-Type": "application/json"
                },
                json=payload,
                timeout=30.0
            )
            if response.status_code != 401 or attempt == 1:
                break
            with _token_lock:
                if _iam_token == iam_token:
                    _iam_token = None
                    _iam_token_expires = 0
            iam_token = _get_iam_token()
        response.raise_for_status()
        data = response.json()
        
        answer = data["result"]["alternatives"][0]["message"]["text"]
    except Exception as e:
        logger.error(f"[YandexGPT] Ошибка запроса: {e}", exc_info=True)
        return {"error": "Ошибка запроса к YandexGPT"}
    
    analysis = analyze_answer(brand, answer)
    
    return {
        "brand": brand,
        "query": query,
        "answer": answer,
        **analysis,
    }
