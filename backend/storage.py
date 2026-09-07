import secrets
from datetime import datetime

from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from database import connection


def _timestamp(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _brand(row):
    return {
        "id": row["id"],
        "canonical_id": row["canonical_id"],
        "canonical_name": row["canonical_name"],
        "aliases": row["aliases"],
        "domains": row["domains"],
        "created_at": _timestamp(row.get("created_at")),
        "updated_at": _timestamp(row.get("updated_at")),
    }


def list_brands(user_id: int):
    with connection() as database:
        rows = database.execute(
            "SELECT * FROM brands WHERE user_id = %s ORDER BY created_at, id",
            (user_id,),
        ).fetchall()
    return [_brand(row) for row in rows]


def create_brand(user_id: int, canonical_name: str, canonical_id: str = "", aliases=None, domains=None):
    canonical_id = canonical_id or secrets.token_hex(16)
    try:
        with connection() as database:
            row = database.execute(
                """
                INSERT INTO brands(user_id, canonical_id, canonical_name, aliases, domains)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING *
                """,
                (user_id, canonical_id, canonical_name, Jsonb(aliases or []), Jsonb(domains or [])),
            ).fetchone()
    except UniqueViolation:
        return None
    return _brand(row)


def ensure_brand(user_id: int, canonical_name: str, canonical_id: str = "", aliases=None, domains=None):
    with connection() as database:
        row = None
        if canonical_id:
            row = database.execute(
                "SELECT * FROM brands WHERE user_id = %s AND canonical_id = %s",
                (user_id, canonical_id),
            ).fetchone()
            if not row and canonical_id.isdigit():
                row = database.execute(
                    "SELECT * FROM brands WHERE user_id = %s AND id = %s",
                    (user_id, int(canonical_id)),
                ).fetchone()
        if not row:
            row = database.execute(
                "SELECT * FROM brands WHERE user_id = %s AND LOWER(canonical_name) = LOWER(%s) ORDER BY id LIMIT 1",
                (user_id, canonical_name),
            ).fetchone()
        if row:
            updated = database.execute(
                """
                UPDATE brands
                SET canonical_name = %s, aliases = %s, domains = %s, updated_at = NOW()
                WHERE id = %s AND user_id = %s
                RETURNING *
                """,
                (canonical_name, Jsonb(aliases if aliases is not None else row["aliases"]), Jsonb(domains if domains is not None else row["domains"]), row["id"], user_id),
            ).fetchone()
            return _brand(updated)
        inserted = database.execute(
            """
            INSERT INTO brands(user_id, canonical_id, canonical_name, aliases, domains)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING *
            """,
            (user_id, canonical_id or secrets.token_hex(16), canonical_name, Jsonb(aliases or []), Jsonb(domains or [])),
        ).fetchone()
    return _brand(inserted)


def update_brand(user_id: int, brand_id: int, canonical_name: str, canonical_id: str, aliases: list, domains: list):
    try:
        with connection() as database:
            row = database.execute(
                """
                UPDATE brands
                SET canonical_name = %s, canonical_id = %s, aliases = %s, domains = %s, updated_at = NOW()
                WHERE id = %s AND user_id = %s
                RETURNING *
                """,
                (canonical_name, canonical_id, Jsonb(aliases), Jsonb(domains), brand_id, user_id),
            ).fetchone()
    except UniqueViolation:
        return False
    return _brand(row) if row else None


def delete_brand(user_id: int, brand_id: int):
    with connection() as database:
        row = database.execute(
            "DELETE FROM brands WHERE id = %s AND user_id = %s RETURNING id, canonical_id",
            (brand_id, user_id),
        ).fetchone()
        if row:
            database.execute("DELETE FROM search_cache WHERE user_id = %s", (user_id,))
            database.execute("DELETE FROM result_cache WHERE user_id = %s", (user_id,))
            database.execute(
                "DELETE FROM dismissed_opportunities WHERE user_id = %s AND split_part(opportunity_id, '|', 1) = %s",
                (user_id, row["canonical_id"]),
            )
    return bool(row)


def _check(row):
    return {
        "id": row["id"],
        "brand_id": row["brand_id"],
        "brand": row["brand"],
        "canonical_id": row["canonical_id"],
        "query": row["query"],
        "provider": row["provider"],
        "status": row["status"],
        "result": row["result"],
        "error": row["error"],
        "created_at": _timestamp(row["created_at"]),
        "completed_at": _timestamp(row["completed_at"]),
    }


def start_check(user_id: int, brand: str, canonical_id: str, query: str, provider: str, aliases=None, domains=None):
    saved_brand = ensure_brand(user_id, brand, canonical_id, aliases, domains)
    with connection() as database:
        row = database.execute(
            """
            INSERT INTO checks(user_id, brand_id, brand, canonical_id, query, provider, status)
            VALUES (%s, %s, %s, %s, %s, %s, 'running')
            RETURNING *
            """,
            (user_id, saved_brand["id"], brand, saved_brand["canonical_id"], query, provider),
        ).fetchone()
    return _check(row)


def finish_check(user_id: int, check_id: int, status: str, result=None, error=None):
    with connection() as database:
        row = database.execute(
            """
            UPDATE checks
            SET status = %s, result = %s, error = %s, completed_at = NOW()
            WHERE id = %s AND user_id = %s
            RETURNING *
            """,
            (status, Jsonb(result) if result is not None else None, Jsonb(error) if error is not None else None, check_id, user_id),
        ).fetchone()
    return _check(row) if row else None


def create_saved_check(user_id: int, payload: dict):
    brand = str(payload.get("brand") or "").strip()
    query = str(payload.get("query") or "").strip()
    provider = str(payload.get("provider") or "all").strip()
    canonical_id = str(payload.get("canonical_id") or payload.get("canonicalId") or payload.get("brandKey") or "").strip()
    if not brand or not query:
        return None
    record = start_check(user_id, brand, canonical_id, query, provider)
    return finish_check(user_id, record["id"], "completed", payload)


def list_checks(user_id: int):
    with connection() as database:
        rows = database.execute(
            "SELECT * FROM checks WHERE user_id = %s ORDER BY created_at DESC, id DESC",
            (user_id,),
        ).fetchall()
    return [_check(row) for row in rows]


def delete_check(user_id: int, check_id: int):
    with connection() as database:
        row = database.execute(
            "DELETE FROM checks WHERE id = %s AND user_id = %s RETURNING id",
            (check_id, user_id),
        ).fetchone()
    return bool(row)


def _task(row):
    payload = dict(row["payload"] or {})
    payload.update({
        "id": row["id"],
        "brand_id": row["brand_id"],
        "status": row["status"],
        "created_at": _timestamp(row["created_at"]),
        "updated_at": _timestamp(row["updated_at"]),
    })
    return payload


def list_growth_tasks(user_id: int):
    with connection() as database:
        rows = database.execute(
            "SELECT * FROM growth_tasks WHERE user_id = %s ORDER BY updated_at DESC, id DESC",
            (user_id,),
        ).fetchall()
    return [_task(row) for row in rows]


def _owned_brand_id(database, user_id: int, payload: dict):
    reference = payload.get("brand_id") or payload.get("brandKey") or payload.get("canonical_id") or payload.get("canonicalId")
    row = None
    if reference is not None:
        text = str(reference).strip()
        if text.isdigit():
            row = database.execute(
                "SELECT id FROM brands WHERE user_id = %s AND id = %s",
                (user_id, int(text)),
            ).fetchone()
        if not row and text:
            row = database.execute(
                "SELECT id FROM brands WHERE user_id = %s AND canonical_id = %s",
                (user_id, text),
            ).fetchone()
    name = str(payload.get("brand") or "").strip()
    if not row and name:
        row = database.execute(
            "SELECT id FROM brands WHERE user_id = %s AND LOWER(canonical_name) = LOWER(%s) ORDER BY id LIMIT 1",
            (user_id, name),
        ).fetchone()
    return row["id"] if row else None


def create_growth_task(user_id: int, payload: dict):
    status = str(payload.get("status") or "planned")
    with connection() as database:
        brand_id = _owned_brand_id(database, user_id, payload)
        if not brand_id:
            return None
        row = database.execute(
            """
            INSERT INTO growth_tasks(user_id, brand_id, status, payload)
            VALUES (%s, %s, %s, %s)
            RETURNING *
            """,
            (user_id, brand_id, status, Jsonb(payload)),
        ).fetchone()
    return _task(row)


def update_growth_task(user_id: int, task_id: int, changes: dict):
    with connection() as database:
        current = database.execute(
            "SELECT * FROM growth_tasks WHERE id = %s AND user_id = %s",
            (task_id, user_id),
        ).fetchone()
        if not current:
            return None
        payload = dict(current["payload"] or {})
        payload.update(changes)
        status = str(payload.get("status") or current["status"])
        has_brand_reference = any(payload.get(key) for key in ("brand_id", "brandKey", "canonical_id", "canonicalId", "brand"))
        resolved_brand_id = _owned_brand_id(database, user_id, payload) if has_brand_reference else None
        if has_brand_reference and not resolved_brand_id:
            return False
        brand_id = resolved_brand_id or current["brand_id"]
        if not brand_id:
            return False
        row = database.execute(
            """
            UPDATE growth_tasks
            SET brand_id = %s, status = %s, payload = %s, updated_at = NOW()
            WHERE id = %s AND user_id = %s
            RETURNING *
            """,
            (brand_id, status, Jsonb(payload), task_id, user_id),
        ).fetchone()
    return _task(row)


def delete_growth_task(user_id: int, task_id: int):
    with connection() as database:
        row = database.execute(
            "DELETE FROM growth_tasks WHERE id = %s AND user_id = %s RETURNING id",
            (task_id, user_id),
        ).fetchone()
    return bool(row)


def list_dismissed_opportunities(user_id: int):
    with connection() as database:
        rows = database.execute(
            "SELECT opportunity_id FROM dismissed_opportunities WHERE user_id = %s ORDER BY created_at",
            (user_id,),
        ).fetchall()
    return [row["opportunity_id"] for row in rows]


def dismiss_opportunity(user_id: int, opportunity_id: str):
    with connection() as database:
        database.execute(
            """
            INSERT INTO dismissed_opportunities(user_id, opportunity_id)
            VALUES (%s, %s)
            ON CONFLICT(user_id, opportunity_id) DO NOTHING
            """,
            (user_id, opportunity_id),
        )
    return opportunity_id


def restore_opportunity(user_id: int, opportunity_id: str):
    with connection() as database:
        row = database.execute(
            "DELETE FROM dismissed_opportunities WHERE user_id = %s AND opportunity_id = %s RETURNING opportunity_id",
            (user_id, opportunity_id),
        ).fetchone()
    return bool(row)
