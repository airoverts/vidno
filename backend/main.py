from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from gigachat_client import check_brand, is_configured
from search_collector import collect_and_format
from cache import get_search_cache, set_search_cache, get_result_cache, set_result_cache, clear_cache, cleanup_expired
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

cleanup_expired()

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
    
    cached_result = get_result_cache(brand, query)
    if cached_result and not context:
        if "sources" in cached_result and cached_result["sources"]:
            logger.info("[API] Возвращён результат из кэша (с sources)")
            return cached_result
        else:
            logger.info("[API] Результат из кэша без sources, пересчитываем")
    
    sources = []
    
    if not context:
        cached_search = get_search_cache(query)
        if cached_search:
            context, sources = cached_search
            logger.info(f"[API] Использован контекст из кэша ({len(sources)} источников)")
        else:
            logger.info("[API] Контекст не найден в кэше, собираем данные из DuckDuckGo")
            context, sources = collect_and_format(query, max_results=10)
            set_search_cache(query, context, sources)
            logger.info(f"[API] Собрано {len(sources)} источников")
    
    result = check_brand(brand, query, context)
    
    if not result.get("error"):
        if sources:
            result["sources"] = [
                {
                    "index": s.get("index"),
                    "title": s.get("title", ""),
                    "url": s.get("url", ""),
                    "authority_score": s.get("authority_score", 3),
                    "authority_label": s.get("authority_label", "низкая"),
                }
                for s in sources
            ]
            
            if "source_analysis" in result and result["source_analysis"]:
                for i, analysis in enumerate(result["source_analysis"]):
                    if i < len(sources):
                        analysis["url"] = sources[i].get("url", "")
                        analysis["title"] = sources[i].get("title", "")
                        analysis["authority_score"] = sources[i].get("authority_score", 3)
                        analysis["authority_label"] = sources[i].get("authority_label", "низкая")
        
        set_result_cache(brand, query, result)
    
    logger.info(f"[API] Результат: mentioned={result.get('mentioned')}, position={result.get('position')}, sources={len(result.get('sources', []))}")
    return result


@app.delete("/api/cache")
def clear_all_cache():
    clear_cache()
    return {"status": "cleared"}
