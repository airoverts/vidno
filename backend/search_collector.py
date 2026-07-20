import logging
from ddgs import DDGS
import time

logger = logging.getLogger(__name__)


def collect_search_results(query: str, max_results: int = 10) -> list[dict]:
    logger.info(f"[Search] Сбор результатов из DuckDuckGo для запроса: {query}")
    
    results = []
    try:
        with DDGS() as ddgs:
            search_results = list(ddgs.text(query, max_results=max_results))
            
            for i, result in enumerate(search_results, 1):
                results.append({
                    "index": i,
                    "title": result.get("title", ""),
                    "url": result.get("href", ""),
                    "snippet": result.get("body", "")
                })
                
        logger.info(f"[Search] Собрано {len(results)} источников")
        
    except Exception as e:
        logger.error(f"[Search] Ошибка при сборе данных: {e}")
    
    return results


def format_context(search_results: list[dict]) -> str:
    if not search_results:
        return ""
    
    context_parts = []
    for result in search_results:
        part = f"""Источник {result['index']}: {result['title']}
URL: {result['url']}
Текст: {result['snippet']}"""
        context_parts.append(part)
    
    return "\n\n".join(context_parts)


def collect_and_format(query: str, max_results: int = 10) -> tuple[str, list[dict]]:
    results = collect_search_results(query, max_results)
    context = format_context(results)
    return context, results
