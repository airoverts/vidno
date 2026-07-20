import sqlite3
import hashlib
import json
import time
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 86400
CACHE_DB_PATH = Path(__file__).parent / "cache.db"


def _get_connection():
    conn = sqlite3.connect(CACHE_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    conn = _get_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS search_cache (
            query_hash TEXT PRIMARY KEY,
            context TEXT NOT NULL,
            sources TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS result_cache (
            cache_key TEXT PRIMARY KEY,
            result TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    
    conn.commit()
    conn.close()


def _hash_key(text: str) -> str:
    normalized = text.strip().lower()
    return hashlib.sha256(normalized.encode()).hexdigest()


def cleanup_expired():
    conn = _get_connection()
    cursor = conn.cursor()
    cutoff = time.time() - CACHE_TTL_SECONDS
    
    cursor.execute("DELETE FROM search_cache WHERE created_at < ?", (cutoff,))
    cursor.execute("DELETE FROM result_cache WHERE created_at < ?", (cutoff,))
    
    conn.commit()
    conn.close()
    logger.info("[Cache] Удалены устаревшие записи")


def get_search_cache(query: str):
    conn = _get_connection()
    cursor = conn.cursor()
    query_hash = _hash_key(query)
    cutoff = time.time() - CACHE_TTL_SECONDS
    
    cursor.execute(
        "SELECT context, sources FROM search_cache WHERE query_hash = ? AND created_at >= ?",
        (query_hash, cutoff)
    )
    row = cursor.fetchone()
    conn.close()
    
    if row:
        logger.info(f"[Cache] Найден search_cache для query='{query}'")
        return row["context"], json.loads(row["sources"])
    
    return None


def set_search_cache(query: str, context: str, sources: list):
    conn = _get_connection()
    cursor = conn.cursor()
    query_hash = _hash_key(query)
    
    cursor.execute(
        "INSERT OR REPLACE INTO search_cache (query_hash, context, sources, created_at) VALUES (?, ?, ?, ?)",
        (query_hash, context, json.dumps(sources), time.time())
    )
    
    conn.commit()
    conn.close()
    logger.info(f"[Cache] Сохранён search_cache для query='{query}'")


def get_result_cache(brand: str, query: str):
    conn = _get_connection()
    cursor = conn.cursor()
    cache_key = _hash_key(f"{brand}|{query}")
    cutoff = time.time() - CACHE_TTL_SECONDS
    
    cursor.execute(
        "SELECT result FROM result_cache WHERE cache_key = ? AND created_at >= ?",
        (cache_key, cutoff)
    )
    row = cursor.fetchone()
    conn.close()
    
    if row:
        logger.info(f"[Cache] Найден result_cache для brand='{brand}', query='{query}'")
        return json.loads(row["result"])
    
    return None


def set_result_cache(brand: str, query: str, result: dict):
    conn = _get_connection()
    cursor = conn.cursor()
    cache_key = _hash_key(f"{brand}|{query}")
    
    cursor.execute(
        "INSERT OR REPLACE INTO result_cache (cache_key, result, created_at) VALUES (?, ?, ?)",
        (cache_key, json.dumps(result), time.time())
    )
    
    conn.commit()
    conn.close()
    logger.info(f"[Cache] Сохранён result_cache для brand='{brand}', query='{query}'")


def clear_cache():
    conn = _get_connection()
    cursor = conn.cursor()
    
    cursor.execute("DELETE FROM search_cache")
    cursor.execute("DELETE FROM result_cache")
    
    conn.commit()
    conn.close()
    logger.info("[Cache] Кэш полностью очищен")


_init_db()
