from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from gigachat_client import check_brand, is_configured
from search_collector import collect_and_format
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CheckRequest(BaseModel):
    brand: str
    query: str
    context: str = ""


@app.get("/api/health")
def health():
    return {"status": "ok", "gigachat_configured": is_configured()}


@app.post("/api/check")
def check(req: CheckRequest):
    brand = req.brand.strip() if req.brand else ""
    query = req.query.strip() if req.query else ""
    context = req.context.strip() if req.context else None
    
    logger.info(f"[API] Запрос: brand='{brand}', query='{query}', context_provided={bool(context)}")
    
    if not brand or not query:
        logger.warning("[API] Отсутствует бренд или запрос")
        return {"error": "Бренд и запрос обязательны"}
    
    if not context:
        logger.info("[API] Контекст не предоставлен, собираем данные из DuckDuckGo")
        context, sources = collect_and_format(query, max_results=10)
        logger.info(f"[API] Собрано {len(sources)} источников")
    
    result = check_brand(brand, query, context)
    
    logger.info(f"[API] Результат: mentioned={result.get('mentioned')}, position={result.get('position')}")
    return result
