import os
import time
import json
import jwt
from dotenv import load_dotenv
import httpx

load_dotenv()

FOLDER_ID = os.getenv("YANDEX_FOLDER_ID")
KEY_FILE_PATH = "authorized_key.json"

_iam_token = None
_iam_token_expires = 0
_service_account_id = None
_private_key = None


def _load_key():
    global _service_account_id, _private_key
    
    if _service_account_id and _private_key:
        return
    
    with open(KEY_FILE_PATH, 'r') as f:
        key_data = json.load(f)
    
    _service_account_id = key_data["service_account_id"]
    _private_key = key_data["private_key"]


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
        headers={"kid": _load_key_id()}
    )
    
    return encoded


def _load_key_id() -> str:
    with open(KEY_FILE_PATH, 'r') as f:
        key_data = json.load(f)
    return key_data["id"]


def _get_iam_token() -> str:
    global _iam_token, _iam_token_expires
    
    if _iam_token and time.time() < _iam_token_expires - 60:
        return _iam_token
    
    jwt_token = _create_jwt()
    
    response = httpx.post(
        "https://iam.api.cloud.yandex.net/iam/v1/tokens",
        json={"jwt": jwt_token}
    )
    response.raise_for_status()
    data = response.json()
    
    _iam_token = data["iamToken"]
    _iam_token_expires = time.time() + 12 * 3600
    
    return _iam_token


def is_configured() -> bool:
    return bool(FOLDER_ID) and os.path.exists(KEY_FILE_PATH)


def check_brand(brand: str, query: str) -> dict:
    if not is_configured():
        return {"error": "YandexGPT не настроен"}
    
    try:
        iam_token = _get_iam_token()
    except Exception as e:
        return {"error": f"Ошибка получения IAM токена: {str(e)}"}
    
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
        response = httpx.post(
            "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
            headers={
                "Authorization": f"Bearer {iam_token}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        
        answer = data["result"]["alternatives"][0]["message"]["text"]
    except Exception as e:
        return {"error": f"Ошибка запроса к YandexGPT: {str(e)}"}
    
    brand_lower = brand.lower()
    answer_lower = answer.lower()
    
    mentioned = brand_lower in answer_lower
    position = None
    context = None
    
    if mentioned:
        sentences = [s.strip() for s in answer.replace("!", ".").replace("?", ".").split(".") if s.strip()]
        for i, sentence in enumerate(sentences):
            if brand_lower in sentence.lower():
                position = i + 1
                context = sentence.strip()
                break
    
    role = "не упомянут"
    if mentioned and context:
        cl = context.lower()
        if any(w in cl for w in ["рекомендую", "советую", "лучший", "топ", "стоит обратить"]):
            role = "рекомендация"
        elif any(w in cl for w in ["альтернатива", "вместо", "конкурент", "сравн"]):
            role = "сравнение"
        elif any(w in cl for w in ["например", "такие как", "включая"]):
            role = "упоминание в списке"
        else:
            role = "упоминание"
    
    total_sentences = len([s.strip() for s in answer.replace("!", ".").replace("?", ".").split(".") if s.strip()])
    
    return {
        "brand": brand,
        "query": query,
        "answer": answer,
        "mentioned": mentioned,
        "position": position,
        "total_sentences": total_sentences,
        "context": context,
        "role": role,
    }
