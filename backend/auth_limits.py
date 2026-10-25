import hashlib
import json
import math

from fastapi import HTTPException

from database import connection


def _key(scope, *parts):
    return hashlib.sha256(json.dumps([scope, *parts], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def admit_auth_attempt(action, client_ip, email=""):
    if action == "login":
        limits = [
            (_key("login-pair", client_ip, email.strip().lower()), 10, 900),
            (_key("login-ip", client_ip), 100, 900),
        ]
    elif action == "register":
        limits = [(_key("register-ip", client_ip), 5, 3600)]
    else:
        raise ValueError("Unknown authentication action")
    limits.sort()
    retry_after = 0
    try:
        with connection() as database:
            rows = []
            for key, maximum, seconds in limits:
                row = database.execute(
                    """
                    INSERT INTO auth_rate_limits(key_hash, attempts, expires_at)
                    VALUES (%s, 0, clock_timestamp())
                    ON CONFLICT (key_hash) DO UPDATE SET key_hash = EXCLUDED.key_hash
                    RETURNING attempts, expires_at
                    """,
                    (key,),
                ).fetchone()
                rows.append((key, maximum, seconds, row))
            now = database.execute("SELECT clock_timestamp() AS now").fetchone()["now"]
            for key, maximum, seconds, row in rows:
                if row["expires_at"] > now and row["attempts"] >= maximum:
                    retry_after = max(retry_after, math.ceil((row["expires_at"] - now).total_seconds()))
            if not retry_after:
                for key, maximum, seconds, row in rows:
                    database.execute(
                        """
                        UPDATE auth_rate_limits
                        SET attempts = CASE WHEN expires_at <= %s THEN 1 ELSE attempts + 1 END,
                            expires_at = CASE WHEN expires_at <= %s THEN %s + (%s * INTERVAL '1 second') ELSE expires_at END
                        WHERE key_hash = %s
                        """,
                        (now, now, now, seconds, key),
                    )
            database.execute(
                """
                DELETE FROM auth_rate_limits WHERE key_hash IN (
                    SELECT key_hash FROM auth_rate_limits WHERE expires_at <= clock_timestamp()
                    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
                )
                """
            )
    except Exception:
        raise HTTPException(503, "Authentication temporarily unavailable") from None
    if retry_after:
        raise HTTPException(429, "Too many authentication attempts", headers={"Retry-After": str(retry_after)})
