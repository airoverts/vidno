import secrets
import calendar
from datetime import datetime, timedelta, timezone

from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from database import connection, expire_stale_checks


class AccessControlError(Exception):
    def __init__(self, status_code: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status_code = status_code
        self.payload = {"code": code, "message": message, **extra}


def _add_months(value: datetime, months: int):
    index = value.month - 1 + months
    year = value.year + index // 12
    month = index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def _period_bounds(activated_at: datetime, now: datetime):
    months = (now.year - activated_at.year) * 12 + now.month - activated_at.month
    cycle = max(0, months)
    start = _add_months(activated_at, cycle)
    if start > now:
        cycle = max(0, cycle - 1)
        start = _add_months(activated_at, cycle)
    return start, _add_months(activated_at, cycle + 1)


def _locked_access(database, user_id: int, refresh: bool = True):
    row = database.execute(
        "SELECT user_access.*, users.role FROM user_access JOIN users ON users.id = user_access.user_id WHERE user_id = %s FOR UPDATE OF user_access",
        (user_id,),
    ).fetchone()
    if not row:
        raise AccessControlError(403, "access_pending", "Доступ ожидает активации")
    role = row["role"]
    now = datetime.now(timezone.utc)
    if refresh and row["status"] == "active":
        activated_at = row["activated_at"] or now
        period_start, period_end = _period_bounds(activated_at, now)
        reset = row["period_end"] is None or now >= row["period_end"]
        if row["activated_at"] is None or row["period_start"] is None or row["period_end"] is None or reset:
            row = database.execute(
                """
                UPDATE user_access
                SET activated_at = %s, period_start = %s, period_end = %s,
                    checks_used = CASE WHEN %s THEN 0 ELSE checks_used END,
                    quota_cycle = quota_cycle + CASE WHEN %s THEN 1 ELSE 0 END,
                    updated_at = NOW()
                WHERE user_id = %s
                RETURNING *
                """,
                (activated_at, period_start, period_end, reset, reset, user_id),
            ).fetchone()
    row["role"] = role
    return row


def _effective_status(row, now=None):
    now = now or datetime.now(timezone.utc)
    if row["status"] == "active" and row["expires_at"] is not None and row["expires_at"] <= now:
        return "expired"
    return row["status"]


def _require_active(row):
    status = _effective_status(row)
    if status != "active":
        labels = {
            "pending": "Доступ ожидает активации",
            "suspended": "Доступ приостановлен",
            "expired": "Срок доступа истёк",
        }
        raise AccessControlError(403, f"access_{status}", labels[status])


def require_workspace_access(user_id: int):
    with connection() as database:
        row = _locked_access(database, user_id)
        _require_active(row)
    return True


def _quota_payload(limit, used, period_start, period_end):
    unlimited = limit is None
    return {
        "limit": limit,
        "used": used,
        "remaining": None if unlimited else max(0, limit - used),
        "unlimited": unlimited,
        "period_start": _timestamp(period_start),
        "period_end": _timestamp(period_end),
    }


def _access_payload(database, row):
    brands_used = database.execute(
        "SELECT COUNT(*) AS amount FROM brands WHERE user_id = %s",
        (row["user_id"],),
    ).fetchone()["amount"]
    status = _effective_status(row)
    active = status == "active"
    checks_available = active and (row["checks_limit"] is None or row["checks_used"] < row["checks_limit"])
    brands_available = active and (row["brands_limit"] is None or brands_used < row["brands_limit"])
    return {
        "status": status,
        "administrative_status": row["status"],
        "plan": row["plan"],
        "activated_at": _timestamp(row["activated_at"]),
        "expires_at": _timestamp(row["expires_at"]),
        "voucher_redeemed": bool(row.get("voucher_redeemed_at")),
        "can_redeem_voucher": row.get("role") == "client" and status == "pending" and not row.get("first_activated_at") and not row.get("voucher_redeemed_at"),
        "checks": _quota_payload(row["checks_limit"], row["checks_used"], row["period_start"], row["period_end"]),
        "brands": _quota_payload(row["brands_limit"], brands_used, row["period_start"], row["period_end"]),
        "capabilities": {
            "workspace_write": active,
            "run_checks": checks_available,
            "create_brands": brands_available,
            "manage_existing_brands": active,
        },
    }


def get_access(user_id: int):
    with connection() as database:
        row = _locked_access(database, user_id)
        return _access_payload(database, row)


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
        "identity_changed_at": _timestamp(row.get("identity_changed_at")),
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
            access = _locked_access(database, user_id)
            _require_active(access)
            used = database.execute("SELECT COUNT(*) AS amount FROM brands WHERE user_id = %s", (user_id,)).fetchone()["amount"]
            if access["brands_limit"] is not None and used >= access["brands_limit"]:
                raise AccessControlError(429, "quota_exceeded", "Лимит брендов исчерпан", resource="brands")
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
        access = _locked_access(database, user_id)
        _require_active(access)
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
            return _brand(row)
        used = database.execute("SELECT COUNT(*) AS amount FROM brands WHERE user_id = %s", (user_id,)).fetchone()["amount"]
        if access["brands_limit"] is not None and used >= access["brands_limit"]:
            raise AccessControlError(429, "quota_exceeded", "Лимит брендов исчерпан", resource="brands")
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
            access = _locked_access(database, user_id)
            _require_active(access)
            current = database.execute(
                "SELECT * FROM brands WHERE id = %s AND user_id = %s FOR UPDATE",
                (brand_id, user_id),
            ).fetchone()
            if not current:
                return None
            if canonical_id != current["canonical_id"]:
                return False
            identity_changed = canonical_name != current["canonical_name"] or domains != current["domains"]
            if identity_changed:
                next_allowed_at = current["identity_changed_at"] + timedelta(days=14)
                if datetime.now(timezone.utc) < next_allowed_at:
                    raise AccessControlError(
                        409,
                        "brand_identity_cooldown",
                        "Название и домены бренда можно менять не чаще раза в 14 дней",
                        next_allowed_at=_timestamp(next_allowed_at),
                    )
            row = database.execute(
                """
                UPDATE brands
                SET canonical_name = %s, aliases = %s, domains = %s,
                    identity_changed_at = CASE WHEN %s THEN NOW() ELSE identity_changed_at END,
                    updated_at = NOW()
                WHERE id = %s AND user_id = %s
                RETURNING *
                """,
                (canonical_name, Jsonb(aliases), Jsonb(domains), identity_changed, brand_id, user_id),
            ).fetchone()
    except UniqueViolation:
        return False
    return _brand(row) if row else None


def delete_brand(user_id: int, brand_id: int):
    with connection() as database:
        access = _locked_access(database, user_id)
        _require_active(access)
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
        "quota_state": row.get("quota_state", "unmetered"),
        "result": row["result"],
        "error": row["error"],
        "created_at": _timestamp(row["created_at"]),
        "completed_at": _timestamp(row["completed_at"]),
    }


def start_check(user_id: int, brand: str, canonical_id: str, query: str, provider: str, aliases=None, domains=None):
    with connection() as database:
        access = _locked_access(database, user_id)
        _require_active(access)
        if access["checks_limit"] is not None and access["checks_used"] >= access["checks_limit"]:
            raise AccessControlError(429, "quota_exceeded", "Лимит проверок исчерпан", resource="checks")
        saved_brand = None
        if canonical_id:
            saved_brand = database.execute(
                "SELECT * FROM brands WHERE user_id = %s AND canonical_id = %s",
                (user_id, canonical_id),
            ).fetchone()
            if not saved_brand and canonical_id.isdigit():
                saved_brand = database.execute(
                    "SELECT * FROM brands WHERE user_id = %s AND id = %s",
                    (user_id, int(canonical_id)),
                ).fetchone()
        if not saved_brand:
            saved_brand = database.execute(
                "SELECT * FROM brands WHERE user_id = %s AND LOWER(canonical_name) = LOWER(%s) ORDER BY id LIMIT 1",
                (user_id, brand),
            ).fetchone()
        if not saved_brand:
            used = database.execute("SELECT COUNT(*) AS amount FROM brands WHERE user_id = %s", (user_id,)).fetchone()["amount"]
            if access["brands_limit"] is not None and used >= access["brands_limit"]:
                raise AccessControlError(429, "quota_exceeded", "Лимит брендов исчерпан", resource="brands")
            saved_brand = database.execute(
                """
                INSERT INTO brands(user_id, canonical_id, canonical_name, aliases, domains)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING *
                """,
                (user_id, canonical_id or secrets.token_hex(16), brand, Jsonb(aliases or []), Jsonb(domains or [])),
            ).fetchone()
        database.execute(
            "UPDATE user_access SET checks_used = checks_used + 1, updated_at = NOW() WHERE user_id = %s",
            (user_id,),
        )
        row = database.execute(
            """
            INSERT INTO checks(user_id, brand_id, brand, canonical_id, query, provider, status, quota_state, quota_cycle)
            VALUES (%s, %s, %s, %s, %s, %s, 'running', 'reserved', %s)
            RETURNING *
            """,
            (user_id, saved_brand["id"], saved_brand["canonical_name"], saved_brand["canonical_id"], query, provider, access["quota_cycle"]),
        ).fetchone()
    return _check(row)


def finish_check(user_id: int, check_id: int, status: str, result=None, error=None):
    with connection() as database:
        _locked_access(database, user_id, refresh=False)
        current = database.execute(
            "SELECT * FROM checks WHERE id = %s AND user_id = %s FOR UPDATE",
            (check_id, user_id),
        ).fetchone()
        if not current or current["status"] != "running":
            return _check(current) if current else None
        was_reserved = bool(current and current["quota_state"] == "reserved")
        row = database.execute(
            """
            UPDATE checks
            SET status = %s, result = %s, error = %s, completed_at = NOW(),
                quota_state = CASE
                    WHEN quota_state = 'reserved' AND %s = 'failed' THEN 'refunded'
                    WHEN quota_state = 'reserved' THEN 'consumed'
                    ELSE quota_state
                END
            WHERE id = %s AND user_id = %s AND status = 'running'
            RETURNING *
            """,
            (status, Jsonb(result) if result is not None else None, Jsonb(error) if error is not None else None, status, check_id, user_id),
        ).fetchone()
        if row and was_reserved and status == "failed":
            database.execute(
                "UPDATE user_access SET checks_used = GREATEST(0, checks_used - 1), updated_at = NOW() WHERE user_id = %s AND quota_cycle = %s",
                (user_id, current["quota_cycle"]),
            )
        if row and status in {"completed", "partial"}:
            database.execute(
                "UPDATE users SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()) WHERE id = %s",
                (user_id,),
            )
    return _check(row) if row else None


def create_saved_check(user_id: int, payload: dict):
    brand = str(payload.get("brand") or "").strip()
    query = str(payload.get("query") or "").strip()
    provider = str(payload.get("provider") or "all").strip()
    canonical_id = str(payload.get("canonical_id") or payload.get("canonicalId") or payload.get("brandKey") or "").strip()
    if not brand or not query:
        return None
    saved_brand = ensure_brand(user_id, brand, canonical_id)
    with connection() as database:
        access = _locked_access(database, user_id)
        _require_active(access)
        row = database.execute(
            """
            INSERT INTO checks(
                user_id, brand_id, brand, canonical_id, query, provider,
                status, result, completed_at, quota_state
            )
            VALUES (%s, %s, %s, %s, %s, %s, 'completed', %s, NOW(), 'unmetered')
            RETURNING *
            """,
            (
                user_id,
                saved_brand["id"],
                saved_brand["canonical_name"],
                saved_brand["canonical_id"],
                query,
                provider,
                Jsonb(payload),
            ),
        ).fetchone()
    return _check(row)


def list_checks(user_id: int):
    with connection() as database:
        expire_stale_checks(database, user_id)
        rows = database.execute(
            "SELECT * FROM checks WHERE user_id = %s ORDER BY created_at DESC, id DESC",
            (user_id,),
        ).fetchall()
    return [_check(row) for row in rows]


def read_report_data(user_id: int, brand_id: int):
    with connection() as database:
        database.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        brands = database.execute(
            "SELECT * FROM brands WHERE user_id = %s ORDER BY created_at, id",
            (user_id,),
        ).fetchall()
        brand = next((row for row in brands if row["id"] == brand_id), None)
        if brand is None:
            return None
        rows = database.execute(
            "SELECT * FROM checks WHERE user_id = %s ORDER BY created_at DESC, id DESC",
            (user_id,),
        ).fetchall()
    return _brand(brand), [_brand(row) for row in brands], [_check(row) for row in rows]


def delete_check(user_id: int, check_id: int):
    with connection() as database:
        access = _locked_access(database, user_id)
        _require_active(access)
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
        access = _locked_access(database, user_id)
        _require_active(access)
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
        access = _locked_access(database, user_id)
        _require_active(access)
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
        access = _locked_access(database, user_id)
        _require_active(access)
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
        access = _locked_access(database, user_id)
        _require_active(access)
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
        access = _locked_access(database, user_id)
        _require_active(access)
        row = database.execute(
            "DELETE FROM dismissed_opportunities WHERE user_id = %s AND opportunity_id = %s RETURNING opportunity_id",
            (user_id, opportunity_id),
        ).fetchone()
    return bool(row)


def _account_payload(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "created_at": _timestamp(row.get("user_created_at", row["created_at"])),
        "role": row["role"],
    }


def list_admin_clients(query: str = "", status: str | None = None, plan: str | None = None, page: int = 1, page_size: int = 25):
    clauses = ["users.role = 'client'"]
    params = []
    if query:
        clauses.append(
            "(users.name ILIKE %s OR users.email ILIKE %s OR EXISTS (SELECT 1 FROM brands WHERE brands.user_id = users.id AND brands.canonical_name ILIKE %s))"
        )
        pattern = f"%{query}%"
        params.extend((pattern, pattern, pattern))
    if plan:
        clauses.append("user_access.plan = %s")
        params.append(plan)
    if status == "expired":
        clauses.append("user_access.status = 'active' AND user_access.expires_at IS NOT NULL AND user_access.expires_at <= NOW()")
    elif status:
        clauses.append("user_access.status = %s")
        params.append(status)
        if status == "active":
            clauses.append("(user_access.expires_at IS NULL OR user_access.expires_at > NOW())")
    where = " AND ".join(f"({clause})" for clause in clauses)
    with connection() as database:
        total = database.execute(
            f"SELECT COUNT(*) AS amount FROM users JOIN user_access ON user_access.user_id = users.id WHERE {where}",
            tuple(params),
        ).fetchone()["amount"]
        rows = database.execute(
            f"""
            SELECT users.id, users.name, users.email, users.created_at AS user_created_at, users.role,
                   user_access.*
            FROM users
            JOIN user_access ON user_access.user_id = users.id
            WHERE {where}
            ORDER BY users.created_at DESC, users.id DESC
            LIMIT %s OFFSET %s
            """,
            (*params, page_size, (page - 1) * page_size),
        ).fetchall()
        items = []
        for row in rows:
            current_access = _locked_access(database, row["id"])
            items.append({"account": _account_payload(row), "access": _access_payload(database, current_access)})
    return {"items": items, "page": page, "page_size": page_size, "total": total}


def get_admin_client(user_id: int):
    with connection() as database:
        row = database.execute(
            """
            SELECT users.id, users.name, users.email, users.created_at AS user_created_at, users.role,
                   user_access.*
            FROM users
            JOIN user_access ON user_access.user_id = users.id
            WHERE users.id = %s AND users.role = 'client'
            """,
            (user_id,),
        ).fetchone()
        if not row:
            return None
        current_access = _locked_access(database, user_id)
        return {"account": _account_payload(row), "access": _access_payload(database, current_access)}


def update_admin_access(user_id: int, changes: dict):
    with connection() as database:
        user = database.execute(
            "SELECT id, name, email, created_at, role FROM users WHERE id = %s AND role = 'client'",
            (user_id,),
        ).fetchone()
        if not user:
            return None
        current = _locked_access(database, user_id, refresh=False)
        now = datetime.now(timezone.utc)
        old_effective = _effective_status(current, now)
        new_status = changes.get("status", current["status"])
        new_plan = changes.get("plan", current["plan"])
        new_expires_at = changes.get("expires_at", current["expires_at"])
        if new_expires_at is not None and new_expires_at.tzinfo is None:
            new_expires_at = new_expires_at.replace(tzinfo=timezone.utc)
        checks_limit = changes.get("checks_limit", current["checks_limit"])
        brands_limit = changes.get("brands_limit", current["brands_limit"])
        becomes_active = new_status == "active" and (new_expires_at is None or new_expires_at > now)
        reactivation = becomes_active and (current["status"] == "pending" or old_effective == "expired")
        activated_at = current["activated_at"]
        period_start = current["period_start"]
        period_end = current["period_end"]
        checks_used = current["checks_used"]
        quota_cycle = current["quota_cycle"]
        if new_status == "pending":
            activated_at = None
            period_start = None
            period_end = None
            checks_used = 0
            quota_cycle += 1
        elif reactivation:
            activated_at = now
            period_start, period_end = _period_bounds(now, now)
            checks_used = 0
            quota_cycle += 1
        elif changes.get("reset_usage"):
            checks_used = 0
            quota_cycle += 1
        updated = database.execute(
            """
            UPDATE user_access
            SET status = %s, plan = %s, expires_at = %s,
                checks_limit = %s, brands_limit = %s,
                activated_at = %s, period_start = %s, period_end = %s,
                first_activated_at = COALESCE(first_activated_at, CASE WHEN %s THEN %s END),
                checks_used = %s, quota_cycle = %s, updated_at = NOW()
            WHERE user_id = %s
            RETURNING *
            """,
            (new_status, new_plan, new_expires_at, checks_limit, brands_limit, activated_at, period_start, period_end, becomes_active, now, checks_used, quota_cycle, user_id),
        ).fetchone()
        updated["role"] = user["role"]
        return {"account": _account_payload(user), "access": _access_payload(database, updated)}
