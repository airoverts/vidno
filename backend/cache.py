import hashlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone

from database import connection, initialize_database


logger = logging.getLogger(__name__)

try:
    CACHE_TTL_SECONDS = max(60, int(os.getenv("CACHE_TTL_SECONDS", "86400")))
except ValueError:
    CACHE_TTL_SECONDS = 86400


def _hash_key(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()


def _result_key(brand: str, query: str, provider: str, model: str) -> str:
    normalized = [brand.strip().casefold(), query.strip().casefold(), provider.strip().casefold(), model.strip().casefold()]
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode()).hexdigest()


def cleanup_expired():
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=CACHE_TTL_SECONDS)
    with connection() as database:
        database.execute("DELETE FROM search_cache WHERE created_at < %s", (cutoff,))
        database.execute("DELETE FROM result_cache WHERE created_at < %s", (cutoff,))


def get_search_cache(user_id: int, query: str):
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=CACHE_TTL_SECONDS)
    try:
        with connection() as database:
            row = database.execute(
                "SELECT context, sources FROM search_cache WHERE user_id = %s AND query_hash = %s AND created_at >= %s",
                (user_id, _hash_key(query), cutoff),
            ).fetchone()
    except Exception as error:
        logger.warning("[Cache] Ошибка чтения search_cache: %s", error)
        return None
    return (row["context"], row["sources"]) if row and isinstance(row["sources"], list) else None


def set_search_cache(user_id: int, query: str, context: str, sources: list):
    try:
        with connection() as database:
            database.execute(
                """
                INSERT INTO search_cache(user_id, query_hash, context, sources, created_at)
                VALUES (%s, %s, %s, %s, NOW())
                ON CONFLICT(user_id, query_hash) DO UPDATE
                SET context = EXCLUDED.context, sources = EXCLUDED.sources, created_at = NOW()
                """,
                (user_id, _hash_key(query), context, json.dumps(sources, ensure_ascii=False)),
            )
    except Exception as error:
        logger.warning("[Cache] Ошибка записи search_cache: %s", error)


def get_result_cache(user_id: int, brand: str, query: str, provider: str = "gigachat", model: str = ""):
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=CACHE_TTL_SECONDS)
    try:
        with connection() as database:
            row = database.execute(
                "SELECT result FROM result_cache WHERE user_id = %s AND cache_key = %s AND created_at >= %s",
                (user_id, _result_key(brand, query, provider, model), cutoff),
            ).fetchone()
    except Exception as error:
        logger.warning("[Cache] Ошибка чтения result_cache: %s", error)
        return None
    return row["result"] if row and isinstance(row["result"], dict) else None


def set_result_cache(user_id: int, brand: str, query: str, result: dict, provider: str = "gigachat", model: str = ""):
    try:
        with connection() as database:
            database.execute(
                """
                INSERT INTO result_cache(user_id, cache_key, result, created_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT(user_id, cache_key) DO UPDATE
                SET result = EXCLUDED.result, created_at = NOW()
                """,
                (user_id, _result_key(brand, query, provider, model), json.dumps(result, ensure_ascii=False)),
            )
    except Exception as error:
        logger.warning("[Cache] Ошибка записи result_cache: %s", error)


def clear_cache():
    with connection() as database:
        database.execute("DELETE FROM search_cache")
        database.execute("DELETE FROM result_cache")


def initialize_cache():
    initialize_database()
    cleanup_expired()
