import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from psycopg.errors import UniqueViolation

from database import connection, initialize_database


SESSION_DAYS = 30


def initialize_auth():
    initialize_database()


def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"pbkdf2_sha256$310000${salt.hex()}${digest.hex()}"


def _password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_hex, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def _public_user(row):
    user = {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "brand": row["brand"],
        "role": row.get("role", "client"),
    }
    if row.get("created_at"):
        user["created_at"] = row["created_at"].isoformat()
    if "onboarding_completed_at" in row:
        completed_at = row["onboarding_completed_at"]
        user["onboarding_completed_at"] = completed_at.isoformat() if completed_at else None
    return user


def create_user(name: str, email: str, password: str, brand: str):
    try:
        with connection() as database:
            row = database.execute(
                """
                INSERT INTO users(name, email, brand, password_hash)
                VALUES (%s, %s, %s, %s)
                RETURNING *
                """,
                (name, email, brand, _password_hash(password)),
            ).fetchone()
            database.execute(
                "INSERT INTO user_access(user_id, status, plan) VALUES (%s, 'pending', 'custom')",
                (row["id"],),
            )
            if brand:
                database.execute(
                    "INSERT INTO brands(user_id, canonical_id, canonical_name) VALUES (%s, %s, %s)",
                    (row["id"], secrets.token_hex(16), brand),
                )
    except UniqueViolation:
        return None
    return _public_user(row)


def authenticate(email: str, password: str):
    with connection() as database:
        row = database.execute("SELECT * FROM users WHERE email = %s", (email,)).fetchone()
        valid = bool(row and _password_matches(password, row["password_hash"]))
        if valid:
            database.execute("UPDATE users SET last_activity_at = NOW() WHERE id = %s", (row["id"],))
    return _public_user(row) if valid else None


def create_session(user_id: int):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with connection() as database:
        database.execute("DELETE FROM sessions WHERE expires_at <= NOW()")
        database.execute(
            "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (%s, %s, %s)",
            (token_hash, user_id, expires_at),
        )
    return token


def user_for_session(token: str | None):
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with connection() as database:
        row = database.execute(
            """
            SELECT users.*
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = %s AND sessions.expires_at > NOW()
            """,
            (token_hash,),
        ).fetchone()
        if row:
            database.execute("UPDATE users SET last_activity_at = NOW() WHERE id = %s", (row["id"],))
    return _public_user(row) if row else None


def delete_session(token: str | None):
    if not token:
        return
    with connection() as database:
        database.execute(
            "DELETE FROM sessions WHERE token_hash = %s",
            (hashlib.sha256(token.encode()).hexdigest(),),
        )


def delete_user(user_id: int):
    with connection() as database:
        row = database.execute("DELETE FROM users WHERE id = %s RETURNING id", (user_id,)).fetchone()
    return bool(row)


def get_account(user_id: int):
    with connection() as database:
        row = database.execute(
            "SELECT id, name, email, brand, role, created_at, onboarding_completed_at FROM users WHERE id = %s",
            (user_id,),
        ).fetchone()
    return _public_user(row) if row else None


def update_account(user_id: int, name: str | None = None, email: str | None = None, current_password: str | None = None, new_password: str | None = None):
    try:
        with connection() as database:
            row = database.execute("SELECT * FROM users WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
            if not row:
                return None, False, "not_found"
            sensitive = email is not None and email != row["email"] or new_password is not None
            if sensitive and (not current_password or not _password_matches(current_password, row["password_hash"])):
                return None, False, "invalid_password"
            updated = database.execute(
                """
                UPDATE users
                SET name = COALESCE(%s, name),
                    email = COALESCE(%s, email),
                    password_hash = COALESCE(%s, password_hash)
                WHERE id = %s
                RETURNING id, name, email, brand, role, created_at, onboarding_completed_at
                """,
                (name, email, _password_hash(new_password) if new_password else None, user_id),
            ).fetchone()
            if sensitive:
                database.execute("DELETE FROM sessions WHERE user_id = %s", (user_id,))
    except UniqueViolation:
        return None, False, "duplicate_email"
    return _public_user(updated), sensitive, None


def delete_user_verified(user_id: int, current_password: str):
    with connection() as database:
        row = database.execute("SELECT password_hash FROM users WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
        if not row:
            return "not_found"
        if not _password_matches(current_password, row["password_hash"]):
            return "invalid_password"
        database.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return None


def set_user_role(email: str, role: str):
    if role not in {"client", "admin"}:
        raise ValueError("invalid role")
    with connection() as database:
        row = database.execute(
            "UPDATE users SET role = %s WHERE LOWER(email) = LOWER(%s) RETURNING id, email, role",
            (role, email.strip()),
        ).fetchone()
    return row
