import sqlite3
import hashlib
import json
import time
import logging
import os
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    CACHE_TTL_SECONDS = max(60, int(os.getenv("CACHE_TTL_SECONDS", "86400")))
except ValueError:
    CACHE_TTL_SECONDS = 86400
CACHE_DB_PATH = Path(__file__).parent / "cache.db"


def _get_connection():
    conn = sqlite3.connect(CACHE_DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def _connection():
    conn = _get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _init_db():
    with _connection() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS search_cache (
                query_hash TEXT PRIMARY KEY,
                context TEXT NOT NULL,
                sources TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS result_cache (
                cache_key TEXT PRIMARY KEY,
                result TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)


def _load_json(value: str, cache_name: str):
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning(f"[Cache] Повреждённые данные в {cache_name}: {e}")
        return None


def cleanup_expired():
    cutoff = time.time() - CACHE_TTL_SECONDS
    with _connection() as conn:
        conn.execute("DELETE FROM search_cache WHERE created_at < ?", (cutoff,))
        conn.execute("DELETE FROM result_cache WHERE created_at < ?", (cutoff,))
    logger.info("[Cache] Удалены устаревшие записи")


def get_search_cache(query: str):
    query_hash = _hash_key(query)
    cutoff = time.time() - CACHE_TTL_SECONDS
    try:
        with _connection() as conn:
            row = conn.execute(
                "SELECT context, sources FROM search_cache WHERE query_hash = ? AND created_at >= ?",
                (query_hash, cutoff)
            ).fetchone()
    except sqlite3.Error as e:
        logger.warning(f"[Cache] Ошибка чтения search_cache: {e}")
        return None

    if row:
        sources = _load_json(row["sources"], "search_cache")
        if isinstance(sources, list):
            logger.info(f"[Cache] Найден search_cache key={query_hash[:12]}")
            return row["context"], sources
    return None


def set_search_cache(query: str, context: str, sources: list):
    query_hash = _hash_key(query)
    try:
        with _connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO search_cache (query_hash, context, sources, created_at) VALUES (?, ?, ?, ?)",
                (query_hash, context, json.dumps(sources, ensure_ascii=False), time.time())
            )
    except sqlite3.Error as e:
        logger.warning(f"[Cache] Ошибка записи search_cache: {e}")
        return
    logger.info(f"[Cache] Сохранён search_cache key={query_hash[:12]}")


def _hash_key(text: str) -> str:
    normalized = text.strip().lower()
    return hashlib.sha256(normalized.encode()).hexdigest()


def _result_key(brand: str, query: str, provider: str, model: str) -> str:
    normalized = [
        brand.strip().casefold(),
        query.strip().casefold(),
        provider.strip().casefold(),
        model.strip().casefold(),
    ]
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode()).hexdigest()


def get_result_cache(brand: str, query: str, provider: str = "gigachat", model: str = ""):
    cache_key = _result_key(brand, query, provider, model)
    cutoff = time.time() - CACHE_TTL_SECONDS
    try:
        with _connection() as conn:
            row = conn.execute(
                "SELECT result FROM result_cache WHERE cache_key = ? AND created_at >= ?",
                (cache_key, cutoff)
            ).fetchone()
    except sqlite3.Error as e:
        logger.warning(f"[Cache] Ошибка чтения result_cache: {e}")
        return None

    if row:
        result = _load_json(row["result"], "result_cache")
        if isinstance(result, dict):
            logger.info(f"[Cache] Найден result_cache key={cache_key[:12]}")
            return result
    return None


def set_result_cache(brand: str, query: str, result: dict, provider: str = "gigachat", model: str = ""):
    cache_key = _result_key(brand, query, provider, model)
    try:
        with _connection() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO result_cache (cache_key, result, created_at) VALUES (?, ?, ?)",
                (cache_key, json.dumps(result, ensure_ascii=False), time.time())
            )
    except sqlite3.Error as e:
        logger.warning(f"[Cache] Ошибка записи result_cache: {e}")
        return
    logger.info(f"[Cache] Сохранён result_cache key={cache_key[:12]}")


def clear_cache():
    with _connection() as conn:
        conn.execute("DELETE FROM search_cache")
        conn.execute("DELETE FROM result_cache")
    logger.info("[Cache] Кэш полностью очищен")


def initialize_cache():
    _init_db()
    cleanup_expired()
