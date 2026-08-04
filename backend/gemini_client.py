import os
import logging
from dotenv import load_dotenv
from google import genai
from google.genai import types
from text_analysis import analyze_answer

load_dotenv()

logger = logging.getLogger(__name__)

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(
            api_key=API_KEY,
            http_options=types.HttpOptions(timeout=60000)
        )
    return _client


def is_configured() -> bool:
    return bool(API_KEY)


def check_brand(brand: str, query: str) -> dict:
    if not is_configured():
        return {"error": "API ключ не настроен"}

    client = _get_client()

    prompt = (
        f"Ответь на следующий запрос как AI-ассистент. "
        f"Отвечай на русском языке, развёрнуто и полезно.\n\n"
        f"Запрос: {query}"
    )

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=prompt
        )
        answer = response.text
        if not answer or not answer.strip():
            return {"error": "Gemini вернул пустой ответ"}
    except Exception as e:
        logger.error(f"[Gemini] Ошибка запроса: {e}", exc_info=True)
        return {"error": "Ошибка запроса к Gemini"}

    analysis = analyze_answer(brand, answer)

    return {
        "brand": brand,
        "query": query,
        "answer": answer,
        **analysis,
    }
