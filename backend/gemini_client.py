import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY")
MODEL_NAME = "gemini-2.0-flash"

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = genai.Client(api_key=API_KEY)
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
    except Exception as e:
        return {"error": str(e)}

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
    if mentioned:
        if context:
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
