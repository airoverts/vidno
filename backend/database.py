import os
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row


def database_url():
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError("DATABASE_URL is required")
    return value


@contextmanager
def connection():
    with psycopg.connect(database_url(), row_factory=dict_row) as database:
        yield database


def initialize_database():
    statements = (
        """
        CREATE TABLE IF NOT EXISTS users (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            brand TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
        """
        CREATE TABLE IF NOT EXISTS brands (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            canonical_id TEXT NOT NULL,
            canonical_name TEXT NOT NULL,
            aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
            domains JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, canonical_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_brands_user_id ON brands(user_id)",
        """
        CREATE TABLE IF NOT EXISTS checks (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            brand_id BIGINT REFERENCES brands(id) ON DELETE CASCADE,
            brand TEXT NOT NULL,
            canonical_id TEXT NOT NULL DEFAULT '',
            query TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            result JSONB,
            error JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_checks_user_created ON checks(user_id, created_at DESC)",
        """
        CREATE TABLE IF NOT EXISTS growth_tasks (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            brand_id BIGINT REFERENCES brands(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'planned',
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_growth_tasks_user_updated ON growth_tasks(user_id, updated_at DESC)",
        """
        CREATE TABLE IF NOT EXISTS dismissed_opportunities (
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            opportunity_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(user_id, opportunity_id)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS search_cache (
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            query_hash TEXT NOT NULL,
            context TEXT NOT NULL,
            sources JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(user_id, query_hash)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS result_cache (
            user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            cache_key TEXT NOT NULL,
            result JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(user_id, cache_key)
        )
        """,
    )
    with connection() as database:
        for statement in statements:
            database.execute(statement)
        database.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        database.execute("SELECT pg_advisory_xact_lock(hashtext('vidno_schema_migrations'))")
        migrations_path = Path(__file__).resolve().parent / "migrations"
        applied = {
            row["version"]
            for row in database.execute("SELECT version FROM schema_migrations").fetchall()
        }
        for migration in sorted(migrations_path.glob("*.sql")):
            if migration.name in applied:
                continue
            database.execute(migration.read_text(encoding="utf-8"))
            database.execute(
                "INSERT INTO schema_migrations(version) VALUES (%s)",
                (migration.name,),
            )
        database.execute(
            """
            WITH interrupted AS (
                UPDATE checks
                SET status = 'failed',
                    error = '{"error":"interrupted"}'::jsonb,
                    completed_at = NOW(),
                    quota_state = CASE WHEN quota_state = 'reserved' THEN 'refunded' ELSE quota_state END
                WHERE status = 'running' AND created_at < NOW() - INTERVAL '1 hour'
                RETURNING user_id, quota_state, quota_cycle
            ), refunds AS (
                SELECT user_id, quota_cycle, COUNT(*) AS amount
                FROM interrupted
                WHERE quota_state = 'refunded'
                GROUP BY user_id, quota_cycle
            )
            UPDATE user_access
            SET checks_used = GREATEST(0, checks_used - refunds.amount), updated_at = NOW()
            FROM refunds
            WHERE user_access.user_id = refunds.user_id
              AND user_access.quota_cycle = refunds.quota_cycle
            """
        )
