import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone

from database import connection
from storage import AccessControlError, _access_payload, _locked_access, _period_bounds, _timestamp


def normalize_code(code: str):
    return re.sub(r"[\s-]", "", code).upper()


def code_hash(code: str):
    return hashlib.sha256(normalize_code(code).encode("utf-8")).hexdigest()


def generate_code():
    raw = secrets.token_hex(20).upper()
    return "-".join(raw[index:index + 5] for index in range(0, len(raw), 5))


def _tariff(row):
    return {key: _timestamp(row[key]) for key in ("plan", "checks_limit", "brands_limit", "updated_at")}


def _voucher(row):
    return {
        "id": row["id"],
        "batch_id": row["batch_id"],
        "code_mask": row["code_mask"],
        "status": "redeemed" if row["redeemed_at"] else "revoked" if row["revoked_at"] else "available",
        "redeemed_by": row["redeemed_by"],
        "redeemed_at": _timestamp(row["redeemed_at"]),
        "revoked_at": _timestamp(row["revoked_at"]),
    }


def _batch(database, row):
    result = {key: _timestamp(row[key]) for key in (
        "id", "plan", "checks_limit", "brands_limit", "duration_days", "quantity", "created_by", "created_at"
    )}
    result.update(database.execute(
        """
        SELECT COUNT(*) FILTER (WHERE redeemed_at IS NULL AND revoked_at IS NULL) AS available_count,
               COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL) AS redeemed_count,
               COUNT(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked_count
        FROM vouchers WHERE batch_id = %s
        """, (row["id"],),
    ).fetchone())
    return result


def list_tariffs():
    with connection() as database:
        rows = database.execute("SELECT * FROM tariff_settings ORDER BY checks_limit, plan").fetchall()
    return [_tariff(row) for row in rows]


def update_tariff(plan: str, changes: dict):
    with connection() as database:
        row = database.execute("SELECT * FROM tariff_settings WHERE plan = %s FOR UPDATE", (plan,)).fetchone()
        if not row:
            return None
        updated = database.execute(
            """
            UPDATE tariff_settings SET checks_limit = %s, brands_limit = %s, updated_at = NOW()
            WHERE plan = %s RETURNING *
            """,
            (changes.get("checks_limit", row["checks_limit"]), changes.get("brands_limit", row["brands_limit"]), plan),
        ).fetchone()
        return _tariff(updated)


def create_voucher_batch(admin_id: int, plan: str, quantity: int, duration_days: int):
    with connection() as database:
        tariff = database.execute("SELECT * FROM tariff_settings WHERE plan = %s FOR SHARE", (plan,)).fetchone()
        if not tariff:
            raise AccessControlError(422, "invalid_tariff", "Выберите стандартный тариф")
        batch = database.execute(
            """
            INSERT INTO voucher_batches(plan, checks_limit, brands_limit, duration_days, quantity, created_by)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING *
            """, (plan, tariff["checks_limit"], tariff["brands_limit"], duration_days, quantity, admin_id),
        ).fetchone()
        codes = []
        for _ in range(quantity):
            code = generate_code()
            mask = "••••-" + normalize_code(code)[-5:]
            row = database.execute(
                "INSERT INTO vouchers(batch_id, code_hash, code_mask) VALUES (%s, %s, %s) RETURNING *",
                (batch["id"], code_hash(code), mask),
            ).fetchone()
            codes.append({**_voucher(row), "code": code})
        return {"batch": _batch(database, batch), "vouchers": codes}


def list_voucher_batches():
    with connection() as database:
        rows = database.execute("SELECT * FROM voucher_batches ORDER BY created_at DESC, id DESC").fetchall()
        return [_batch(database, row) for row in rows]


def get_voucher_batch(batch_id: int):
    with connection() as database:
        row = database.execute("SELECT * FROM voucher_batches WHERE id = %s", (batch_id,)).fetchone()
        if not row:
            return None
        codes = database.execute("SELECT * FROM vouchers WHERE batch_id = %s ORDER BY id", (batch_id,)).fetchall()
        return {"batch": _batch(database, row), "vouchers": [_voucher(code) for code in codes]}


def revoke_voucher(voucher_id: int):
    with connection() as database:
        row = database.execute("SELECT * FROM vouchers WHERE id = %s FOR UPDATE", (voucher_id,)).fetchone()
        if not row:
            return None
        if row["redeemed_at"]:
            raise AccessControlError(409, "voucher_already_redeemed", "Использованный ваучер нельзя отозвать")
        updated = database.execute(
            "UPDATE vouchers SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = %s RETURNING *", (voucher_id,),
        ).fetchone()
        return _voucher(updated)


def redeem_voucher(user_id: int, code: str):
    with connection() as database:
        access = _locked_access(database, user_id, refresh=False)
        if (access.get("role") != "client" or access["status"] != "pending"
                or access["first_activated_at"] or access["voucher_redeemed_at"]):
            raise AccessControlError(403, "voucher_not_allowed", "Ваучер доступен только для первой активации аккаунта")
        voucher = database.execute(
            """
            SELECT vouchers.*, voucher_batches.plan, voucher_batches.checks_limit,
                   voucher_batches.brands_limit, voucher_batches.duration_days
            FROM vouchers JOIN voucher_batches ON voucher_batches.id = vouchers.batch_id
            WHERE vouchers.code_hash = %s FOR UPDATE OF vouchers
            """, (code_hash(code),),
        ).fetchone()
        if not voucher or voucher["redeemed_at"] or voucher["revoked_at"]:
            raise AccessControlError(400, "voucher_invalid", "Код неверный, уже использован или отозван")
        now = datetime.now(timezone.utc)
        period_start, period_end = _period_bounds(now, now)
        updated = database.execute(
            """
            UPDATE user_access SET status = 'active', plan = %s, checks_limit = %s, brands_limit = %s,
                activated_at = %s, first_activated_at = %s, voucher_redeemed_at = %s, expires_at = %s,
                period_start = %s, period_end = %s, checks_used = 0,
                quota_cycle = quota_cycle + 1, updated_at = NOW()
            WHERE user_id = %s RETURNING *
            """, (voucher["plan"], voucher["checks_limit"], voucher["brands_limit"], now, now, now,
                    now + timedelta(days=voucher["duration_days"]), period_start, period_end, user_id),
        ).fetchone()
        database.execute("UPDATE vouchers SET redeemed_by = %s, redeemed_at = %s WHERE id = %s", (user_id, now, voucher["id"]))
        updated["role"] = access["role"]
        return _access_payload(database, updated)
