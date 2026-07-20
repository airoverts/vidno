import os
import time
import base64
import json
import re
from dotenv import load_dotenv
import httpx
import urllib3
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

load_dotenv()

CLIENT_ID = os.getenv("GIGACHAT_CLIENT_ID")
CLIENT_SECRET = os.getenv("GIGACHAT_CLIENT_SECRET")

_access_token = None
_token_expires = 0


def _get_access_token() -> str:
    global _access_token, _token_expires
    
    if _access_token and time.time() < _token_expires - 60:
        return _access_token
    
    credentials = f"{CLIENT_ID}:{CLIENT_SECRET}"
    auth_header = base64.b64encode(credentials.encode()).decode()
    
    response = httpx.post(
        "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
        headers={
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "RqUID": "6f0b129e-c779-4f29-9289-1f547ca8f51b"
        },
        data={"scope": "GIGACHAT_API_PERS"},
        verify=False
    )
    response.raise_for_status()
    data = response.json()
    
    _access_token = data["access_token"]
    _token_expires = data["expires_at"] / 1000
    
    return _access_token


def is_configured() -> bool:
    return bool(CLIENT_ID) and bool(CLIENT_SECRET)


def _call_gigachat(messages: list, temperature: float = 0.0, max_tokens: int = 2000) -> str:
    if not is_configured():
        raise RuntimeError("GigaChat не настроен")
    
    access_token = _get_access_token()
    
    payload = {
        "model": "GigaChat:pro",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False
    }
    
    response = httpx.post(
        "https://gigachat.devices.sberbank.ru/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        json=payload,
        verify=False,
        timeout=60.0
    )
    response.raise_for_status()
    data = response.json()
    
    return data["choices"][0]["message"]["content"]


SYSTEM_PROMPT_ANALYZE = """Ты — аналитик видимости бренда в AI-поиске. Твоя задача — проанализировать предоставленный контекст (результаты поиска) и определить, как в нём представлен бренд {brand}.

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. Используй ИСКЛЮЧИТЕЛЬНО предоставленный контекст. Никаких внешних знаний.
2. Если бренд не упомянут — так и скажи. Не выдумывай.
3. Определи позицию бренда среди конкурентов в контексте (1 = упоминается первым, 2 = вторым и т.д.).
4. Определи роль бренда: рекомендация (нейросеть советует), сравнение (сравнивает с другими), упоминание в списке, просто упоминание, не упомянут.
5. Приведи прямые цитаты из контекста как доказательство.
6. Перечисли ВСЕ бренды-конкуренты, упомянутые в контексте.

Ответь строго в формате JSON:
{{
  "mentioned": true/false,
  "position": число_или_null,
  "role": "рекомендация" / "сравнение" / "упоминание в списке" / "упоминание" / "не упомянут",
  "reasoning": "краткое обоснование для пользователя",
  "quotes": ["цитата 1 из контекста", "цитата 2"],
  "mentioned_brands": ["бренд 1", "бренд 2"]
}}"""


def _extract_json(text: str) -> dict:
    text = text.strip()
    
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    
    brace_count = 0
    start_idx = None
    for i, char in enumerate(text):
        if char == '{':
            if brace_count == 0:
                start_idx = i
            brace_count += 1
        elif char == '}':
            brace_count -= 1
            if brace_count == 0 and start_idx is not None:
                json_str = text[start_idx:i+1]
                try:
                    return json.loads(json_str)
                except json.JSONDecodeError:
                    continue
    
    return {}


def _extract_brands_from_text(text: str) -> list:
    messages = [
        {"role": "system", "content": "Извлеки из текста список всех упомянутых брендов. Верни только JSON-массив названий брендов, без пояснений."},
        {"role": "user", "content": text}
    ]
    try:
        answer = _call_gigachat(messages, temperature=0.0, max_tokens=500)
        answer = answer.strip()
        if answer.startswith("```"):
            answer = re.sub(r"^```(?:json)?\s*", "", answer)
            answer = re.sub(r"\s*```$", "", answer)
        brands = json.loads(answer)
        if isinstance(brands, list):
            return [str(b).strip() for b in brands if str(b).strip()]
    except Exception as e:
        logger.warning(f"[RAG] Не удалось извлечь бренды: {e}")
    return []


def _fallback_analysis(answer: str, brand: str) -> dict:
    brand_lower = brand.lower()
    answer_lower = answer.lower()
    mentioned = brand_lower in answer_lower
    position = None
    context = None
    
    if mentioned:
        sentences = [s.strip() for s in re.split(r"[.!?]", answer) if s.strip()]
        for i, sentence in enumerate(sentences):
            if brand_lower in sentence.lower():
                position = i + 1
                context = sentence.strip()
                break
    
    role = "не упомянут"
    quotes = []
    if mentioned and context:
        quotes = [context]
        cl = context.lower()
        if any(w in cl for w in ["рекомендую", "советую", "лучший", "топ", "стоит обратить"]):
            role = "рекомендация"
        elif any(w in cl for w in ["альтернатива", "вместо", "конкурент", "сравн"]):
            role = "сравнение"
        elif any(w in cl for w in ["например", "такие как", "включая"]):
            role = "упоминание в списке"
        else:
            role = "упоминание"
    
    total_sentences = len([s.strip() for s in re.split(r"[.!?]", answer) if s.strip()])
    
    found_brands = _extract_brands_from_text(answer)
    
    return {
        "mentioned": mentioned,
        "position": position,
        "total_sentences": total_sentences,
        "role": role,
        "reasoning": context or "Бренд не упомянут в предоставленном контексте.",
        "quotes": quotes,
        "mentioned_brands": found_brands
    }


def analyze_brand_rag(brand: str, query: str, context: str) -> dict:
    logger.info(f"[RAG] Анализ бренда '{brand}' для запроса: {query}")
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT_ANALYZE.format(brand=brand)},
        {"role": "user", "content": f"КОНТЕКСТ:\n{context}\n\nЗапрос пользователя: {query}\nБренд для анализа: {brand}\n\nПроанализируй видимость бренда в контексте."}
    ]
    
    answer = _call_gigachat(messages, temperature=0.0, max_tokens=2000)
    logger.debug(f"[RAG] Сырой ответ анализа: {answer[:500]}...")
    parsed = _extract_json(answer)
    
    if parsed and "mentioned" in parsed:
        logger.info(f"[RAG] JSON успешно распарсен: mentioned={parsed.get('mentioned')}, position={parsed.get('position')}")
        return {
            "mentioned": bool(parsed.get("mentioned", False)),
            "position": parsed.get("position"),
            "total_sentences": None,
            "role": parsed.get("role", "не упомянут"),
            "reasoning": parsed.get("reasoning", ""),
            "quotes": parsed.get("quotes", []),
            "mentioned_brands": parsed.get("mentioned_brands", []),
            "raw_answer": answer
        }
    
    logger.warning("[RAG] JSON не распарсен, используется fallback анализ")
    fallback = _fallback_analysis(answer, brand)
    fallback["raw_answer"] = answer
    return fallback


def check_brand(brand: str, query: str, context: str) -> dict:
    if not is_configured():
        logger.error("[RAG] GigaChat не настроен (отсутствуют CLIENT_ID или CLIENT_SECRET)")
        return {"error": "GigaChat не настроен"}
    
    logger.info(f"[RAG] Проверка бренда '{brand}' по запросу: {query}")
    
    if not context or not context.strip():
        logger.error("[RAG] Контекст не предоставлен")
        return {"error": "Контекст не предоставлен. Соберите данные через search_collector."}
    
    try:
        analysis = analyze_brand_rag(brand, query, context)
    except httpx.HTTPStatusError as e:
        logger.error(f"[RAG] HTTP ошибка: {e.response.status_code} - {e.response.text}")
        return {"error": f"Ошибка API GigaChat: {e.response.status_code}"}
    except httpx.RequestError as e:
        logger.error(f"[RAG] Ошибка запроса: {str(e)}")
        return {"error": f"Ошибка подключения к GigaChat: {str(e)}"}
    except Exception as e:
        logger.error(f"[RAG] Неожиданная ошибка: {str(e)}", exc_info=True)
        return {"error": f"Ошибка запроса к GigaChat: {str(e)}"}
    
    logger.info(f"[RAG] Результат: mentioned={analysis['mentioned']}, position={analysis['position']}, role={analysis['role']}")
    
    return {
        "brand": brand,
        "query": query,
        "mentioned": analysis["mentioned"],
        "position": analysis["position"],
        "total_sentences": analysis["total_sentences"],
        "role": analysis["role"],
        "reasoning": analysis["reasoning"],
        "quotes": analysis["quotes"],
        "mentioned_brands": analysis["mentioned_brands"],
        "rag": True
    }
