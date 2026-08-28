import hashlib
import hmac
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path


AUTH_DB_PATH = Path(__file__).with_name("auth.db")
SESSION_DAYS = 30


def _connect():
    connection = sqlite3.connect(AUTH_DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


@contextmanager
def _database():
    connection = _connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_auth():
    with _database() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                brand TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        """)


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
    return {"id": row["id"], "name": row["name"], "email": row["email"], "brand": row["brand"]}


def create_user(name: str, email: str, password: str, brand: str):
    now = datetime.now(timezone.utc).isoformat()
    try:
        with _database() as connection:
            cursor = connection.execute(
                "INSERT INTO users(name, email, brand, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (name, email, brand, _password_hash(password), now),
            )
            row = connection.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
    except sqlite3.IntegrityError:
        return None
    return _public_user(row)


def authenticate(email: str, password: str):
    with _database() as connection:
        row = connection.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    return _public_user(row) if row and _password_matches(password, row["password_hash"]) else None


def create_session(user_id: int):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with _database() as connection:
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (datetime.now(timezone.utc).isoformat(),))
        connection.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)", (token_hash, user_id, expires_at.isoformat()))
    return token


def user_for_session(token: str | None):
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with _database() as connection:
        row = connection.execute(
            "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?",
            (token_hash, datetime.now(timezone.utc).isoformat()),
        ).fetchone()
    return _public_user(row) if row else None


def delete_session(token: str | None):
    if not token:
        return
    with _database() as connection:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
