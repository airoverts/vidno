import importlib
import os
import sys
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "").strip()


@unittest.skipUnless(TEST_DATABASE_URL, "TEST_DATABASE_URL is required for PostgreSQL integration tests")
class PostgresAccessIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        cls.psycopg = psycopg
        cls.sql = sql
        cls.make_conninfo = staticmethod(make_conninfo)
        info = conninfo_to_dict(TEST_DATABASE_URL)
        database_name = str(info.get("dbname") or "").lower()
        if "test" not in database_name:
            raise unittest.SkipTest("TEST_DATABASE_URL must point to a database whose name contains 'test'")
        cls.schema = f"vidno_test_{uuid.uuid4().hex}"
        cls.test_database_url = TEST_DATABASE_URL
        with cls.psycopg.connect(TEST_DATABASE_URL, autocommit=True) as database:
            database.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        cls.database_url_before = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = make_conninfo(TEST_DATABASE_URL, options=f"-csearch_path={cls.schema}")
        cls.schema_database_url = os.environ["DATABASE_URL"]
        with cls.psycopg.connect(os.environ["DATABASE_URL"]) as database:
            database.execute(
                """
                CREATE TABLE users (
                    id BIGSERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    brand TEXT NOT NULL DEFAULT '',
                    password_hash TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            database.execute(
                """
                CREATE TABLE brands (
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
                """
            )
            database.execute(
                """
                CREATE TABLE checks (
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
                """
            )
            database.execute(
                """
                INSERT INTO users(id, name, email, brand, password_hash)
                VALUES
                    (9000001, 'Legacy Empty', 'legacy-empty@integration.test', 'Legacy Materialized', 'legacy'),
                    (9000002, 'Legacy Existing', 'legacy-existing@integration.test', 'Must Not Duplicate', 'legacy')
                """
            )
            database.execute(
                """
                INSERT INTO brands(id, user_id, canonical_id, canonical_name, aliases, domains)
                VALUES (9100001, 9000002, 'existing', 'Existing Brand', '["alias"]', '["existing.test"]')
                """
            )
            database.execute(
                """
                INSERT INTO checks(id, user_id, brand_id, brand, canonical_id, query, provider, status, result)
                VALUES (9200001, 9000002, 9100001, 'Existing Brand', 'existing', 'Legacy query', 'gigachat', 'completed', '{"mentioned":true}')
                """
            )
        cls.database = importlib.import_module("database")
        cls.database.initialize_database()
        cls.main = importlib.import_module("main")
        cls.clients = []
        cls.counter = 0

    @classmethod
    def tearDownClass(cls):
        for client in cls.clients:
            client.close()
        self_schema = cls.schema
        if not self_schema.startswith("vidno_test_"):
            raise RuntimeError("Refusing to drop an unexpected schema")
        with cls.psycopg.connect(TEST_DATABASE_URL, autocommit=True) as database:
            database.execute(cls.sql.SQL("DROP SCHEMA {} CASCADE").format(cls.sql.Identifier(self_schema)))
        if cls.database_url_before is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = cls.database_url_before

    def setUp(self):
        self.main.app.dependency_overrides.clear()
        self.main._check_times.clear()

    def tearDown(self):
        self.main.app.dependency_overrides.clear()
        self.main._check_times.clear()

    @classmethod
    def _client(cls):
        client = TestClient(cls.main.app)
        cls.clients.append(client)
        return client

    @classmethod
    def _next_email(cls, label):
        cls.counter += 1
        return f"{label}-{cls.counter}@integration.test"

    def _register(self, label="user", brand=""):
        client = self._client()
        email = self._next_email(label)
        response = client.post(
            "/api/auth/register",
            json={"name": label.title(), "email": email, "password": "password1", "brand": brand},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return client, response.json()["user"], email

    def _make_admin(self):
        client, user, email = self._register("admin")
        with self.database.connection() as database:
            database.execute("UPDATE users SET role = 'admin' WHERE id = %s", (user["id"],))
        response = client.get("/api/account")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["role"], "admin")
        return client, user, email

    def _set_access(self, admin, user_id, **changes):
        response = admin.patch(f"/api/admin/clients/{user_id}/access", json=changes)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["access"]

    def test_migrations_are_idempotent_and_new_users_are_pending_clients(self):
        with self.database.connection() as database:
            before = database.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        self.database.initialize_database()
        with self.database.connection() as database:
            after = database.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        self.assertEqual(before, after)
        with self.database.connection() as database:
            legacy_access = database.execute(
                "SELECT user_id, status, checks_limit, brands_limit FROM user_access WHERE user_id IN (9000001, 9000002) ORDER BY user_id"
            ).fetchall()
            materialized = database.execute(
                "SELECT id, canonical_name FROM brands WHERE user_id = 9000001"
            ).fetchall()
            existing = database.execute(
                "SELECT id, canonical_id, aliases, domains FROM brands WHERE user_id = 9000002"
            ).fetchall()
            legacy_check = database.execute(
                "SELECT id, result, quota_state FROM checks WHERE id = 9200001"
            ).fetchone()
        self.assertEqual([row["status"] for row in legacy_access], ["active", "active"])
        self.assertTrue(all(row["checks_limit"] is None and row["brands_limit"] is None for row in legacy_access))
        self.assertEqual(len(materialized), 1)
        self.assertEqual(materialized[0]["canonical_name"], "Legacy Materialized")
        self.assertEqual(existing, [{"id": 9100001, "canonical_id": "existing", "aliases": ["alias"], "domains": ["existing.test"]}])
        self.assertEqual(legacy_check, {"id": 9200001, "result": {"mentioned": True}, "quota_state": "unmetered"})
        with self.database.connection() as database:
            legacy_users = database.execute("SELECT onboarding_completed_at FROM users WHERE id IN (9000001, 9000002)").fetchall()
        self.assertTrue(all(row["onboarding_completed_at"] is not None for row in legacy_users))

        client, user, _email = self._register("pending")
        account = client.get("/api/account")
        access = client.get("/api/access")
        self.assertEqual(account.status_code, 200, account.text)
        self.assertEqual(account.json()["role"], "client")
        self.assertEqual(account.json()["id"], user["id"])
        self.assertIsNone(account.json()["onboarding_completed_at"])
        self.assertEqual(access.status_code, 200, access.text)
        self.assertEqual(access.json()["status"], "pending")
        self.assertEqual(access.json()["administrative_status"], "pending")
        self.assertFalse(access.json()["capabilities"]["workspace_write"])
        self.assertFalse(access.json()["capabilities"]["run_checks"])

    def test_startup_preserves_old_pending_accounts(self):
        admin, _admin_user, _admin_email = self._make_admin()
        _pending_client, pending_user, _pending_email = self._register("old-pending")
        _returned_client, returned_user, _returned_email = self._register("returned-pending")
        self._set_access(admin, returned_user["id"], status="active")
        self._set_access(admin, returned_user["id"], status="pending")
        user_ids = (pending_user["id"], returned_user["id"])
        with self.database.connection() as database:
            database.execute(
                "UPDATE users SET last_activity_at = NOW() - INTERVAL '30 days' WHERE id = ANY(%s)",
                (list(user_ids),),
            )

        with TestClient(self.main.app):
            pass

        with self.database.connection() as database:
            surviving = database.execute(
                """
                SELECT users.id, user_access.status
                FROM users
                JOIN user_access ON user_access.user_id = users.id
                WHERE users.id = ANY(%s)
                ORDER BY users.id
                """,
                (list(user_ids),),
            ).fetchall()
        self.assertEqual([row["id"] for row in surviving], sorted(user_ids))
        self.assertEqual([row["status"] for row in surviving], ["pending", "pending"])

    def test_fresh_install_creates_complete_access_schema(self):
        fresh_schema = f"vidno_test_{uuid.uuid4().hex}"
        with self.psycopg.connect(self.test_database_url, autocommit=True) as database:
            database.execute(self.sql.SQL("CREATE SCHEMA {}").format(self.sql.Identifier(fresh_schema)))
        try:
            os.environ["DATABASE_URL"] = self.make_conninfo(
                self.test_database_url,
                options=f"-csearch_path={fresh_schema}",
            )
            self.database.initialize_database()
            self.database.initialize_database()
            with self.database.connection() as database:
                tables = {
                    row["table_name"]
                    for row in database.execute(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
                    ).fetchall()
                }
                migrations = database.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
            self.assertTrue({"users", "sessions", "brands", "checks", "user_access", "schema_migrations"} <= tables)
            self.assertGreaterEqual(len(migrations), 1)
        finally:
            os.environ["DATABASE_URL"] = self.schema_database_url
            if not fresh_schema.startswith("vidno_test_"):
                raise RuntimeError("Refusing to drop an unexpected schema")
            with self.psycopg.connect(self.test_database_url, autocommit=True) as database:
                database.execute(self.sql.SQL("DROP SCHEMA {} CASCADE").format(self.sql.Identifier(fresh_schema)))

    def test_account_update_requires_password_and_invalidates_all_sessions(self):
        first, user, email = self._register("profile")
        second = self._client()
        login = second.post("/api/auth/login", json={"email": email, "password": "password1"})
        self.assertEqual(login.status_code, 200, login.text)

        renamed = first.patch("/api/account", json={"name": "Renamed User"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertFalse(renamed.json()["reauth_required"])
        self.assertEqual(renamed.json()["account"]["name"], "Renamed User")

        new_email = self._next_email("changed")
        denied = first.patch("/api/account", json={"email": new_email})
        self.assertIn(denied.status_code, (400, 401, 422))
        changed = first.patch(
            "/api/account",
            json={"email": new_email, "current_password": "password1"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertTrue(changed.json()["reauth_required"])
        self.assertEqual(first.get("/api/account").status_code, 401)
        self.assertEqual(second.get("/api/account").status_code, 401)
        self.assertEqual(first.post("/api/auth/login", json={"email": email, "password": "password1"}).status_code, 401)
        self.assertEqual(first.post("/api/auth/login", json={"email": new_email, "password": "password1"}).status_code, 200)

        _other_client, _other_user, other_email = self._register("duplicate")
        duplicate = first.patch(
            "/api/account",
            json={"email": other_email, "current_password": "password1"},
        )
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(duplicate.json()["detail"]["code"], "duplicate_email")
        password_changed = first.patch(
            "/api/account",
            json={"current_password": "password1", "new_password": "password2"},
        )
        self.assertEqual(password_changed.status_code, 200, password_changed.text)
        self.assertTrue(password_changed.json()["reauth_required"])
        self.assertEqual(first.post("/api/auth/login", json={"email": new_email, "password": "password1"}).status_code, 401)
        self.assertEqual(first.post("/api/auth/login", json={"email": new_email, "password": "password2"}).status_code, 200)

        with self.database.connection() as database:
            role = database.execute("SELECT role FROM users WHERE id = %s", (user["id"],)).fetchone()["role"]
        self.assertEqual(role, "client")

    def test_admin_search_update_statuses_and_role_boundaries(self):
        admin, admin_user, _admin_email = self._make_admin()
        client, user, email = self._register("searchable")

        forbidden = client.get("/api/admin/clients")
        self.assertEqual(forbidden.status_code, 403, forbidden.text)
        self.assertEqual(forbidden.json()["detail"]["code"], "admin_required")

        listing = admin.get("/api/admin/clients", params={"q": email, "status": "pending"})
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual(listing.json()["total"], 1)
        self.assertEqual(listing.json()["items"][0]["account"]["id"], user["id"])
        detail = admin.get(f"/api/admin/clients/{user['id']}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(set(detail.json()), {"account", "access"})
        self.assertEqual(set(detail.json()["account"]), {"id", "name", "email", "created_at", "role"})
        self.assertEqual(admin.get(f"/api/admin/clients/{admin_user['id']}").status_code, 404)
        self.assertEqual(
            admin.patch(f"/api/admin/clients/{admin_user['id']}/access", json={"status": "active"}).status_code,
            404,
        )

        access = self._set_access(
            admin,
            user["id"],
            status="active",
            plan="custom",
            checks_limit=5,
            brands_limit=2,
        )
        self.assertEqual(access["status"], "active")
        self.assertEqual(access["plan"], "custom")
        self.assertEqual(access["checks"]["limit"], 5)
        self.assertEqual(access["brands"]["limit"], 2)
        self.assertTrue(client.get("/api/access").json()["capabilities"]["workspace_write"])

        expires_at = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        self._set_access(admin, user["id"], status="active", expires_at=expires_at)
        expired = client.get("/api/access").json()
        self.assertEqual(expired["administrative_status"], "active")
        self.assertEqual(expired["status"], "expired")
        blocked = client.post("/api/brands", json={"canonical_name": "Blocked"})
        self.assertEqual(blocked.status_code, 403, blocked.text)
        self.assertEqual(blocked.json()["detail"]["code"], "access_expired")

        self._set_access(admin, user["id"], status="suspended")
        suspended = client.get("/api/access").json()
        self.assertEqual(suspended["status"], "suspended")
        blocked = client.post("/api/brands", json={"canonical_name": "Blocked"})
        self.assertEqual(blocked.status_code, 403, blocked.text)
        self.assertEqual(blocked.json()["detail"]["code"], "access_suspended")

        invalid = admin.patch(f"/api/admin/clients/{user['id']}/access", json={"checks_limit": -1})
        self.assertEqual(invalid.status_code, 422)
        role_change = admin.patch(f"/api/admin/clients/{user['id']}/access", json={"role": "admin"})
        self.assertEqual(role_change.status_code, 422)

    def test_blocked_users_can_read_history_but_not_mutate_workspace(self):
        client, _user, _email = self._register("readonly")
        for path in ("/api/brands", "/api/checks", "/api/growth-tasks", "/api/dismissed-opportunities"):
            response = client.get(path)
            self.assertEqual(response.status_code, 200, f"{path}: {response.text}")
        mutations = (
            ("post", "/api/brands", {"canonical_name": "Brand"}),
            ("post", "/api/checks", {"brand": "Brand", "query": "Query"}),
            ("post", "/api/growth-tasks", {"brand": "Brand", "status": "planned"}),
            ("put", "/api/dismissed-opportunities", {"opportunity_id": "one"}),
            ("post", "/api/prompt-suggestions", {"brand": "Brand"}),
            ("post", "/api/check", {"brand": "Brand", "query": "Query", "provider": "gigachat"}),
            ("post", "/api/check-all", {"brand": "Brand", "query": "Query"}),
        )
        with patch.object(self.main, "_run_check") as provider:
            for method, path, body in mutations:
                with self.subTest(method=method, path=path):
                    response = client.request(method, path, json=body)
                    self.assertEqual(response.status_code, 403, response.text)
                    self.assertEqual(response.json()["detail"]["code"], "access_pending")
        provider.assert_not_called()

    def test_monthly_reset_zero_limits_and_suspension_preserve_period(self):
        admin, _admin_user, _admin_email = self._make_admin()
        client, user, _email = self._register("period")
        active = self._set_access(admin, user["id"], status="active", checks_limit=5, brands_limit=3)
        initial_start = active["checks"]["period_start"]
        initial_end = active["checks"]["period_end"]
        with self.database.connection() as database:
            database.execute(
                "UPDATE user_access SET checks_used = 3, period_end = NOW() - INTERVAL '1 second' WHERE user_id = %s",
                (user["id"],),
            )
        refreshed = client.get("/api/access").json()
        self.assertEqual(refreshed["checks"]["used"], 0)
        self.assertEqual(refreshed["checks"]["period_start"], initial_start)
        self.assertEqual(refreshed["checks"]["period_end"], initial_end)

        with self.database.connection() as database:
            database.execute("UPDATE user_access SET checks_used = 2 WHERE user_id = %s", (user["id"],))
        suspended = self._set_access(admin, user["id"], status="suspended")
        resumed = self._set_access(admin, user["id"], status="active")
        self.assertEqual(suspended["checks"]["used"], 2)
        self.assertEqual(resumed["checks"]["used"], 2)
        self.assertEqual(resumed["checks"]["period_start"], suspended["checks"]["period_start"])
        self.assertEqual(resumed["checks"]["period_end"], suspended["checks"]["period_end"])

        zero_client, zero_user, _email = self._register("zero")
        zero = self._set_access(admin, zero_user["id"], status="active", checks_limit=0, brands_limit=0)
        self.assertEqual(zero["checks"]["remaining"], 0)
        self.assertEqual(zero["brands"]["remaining"], 0)
        self.assertFalse(zero["checks"]["unlimited"])
        self.assertFalse(zero["brands"]["unlimited"])
        brand_denied = zero_client.post("/api/brands", json={"canonical_name": "No Slot"})
        check_denied = zero_client.post(
            "/api/check",
            json={"brand": "No Slot", "query": "Query", "provider": "gigachat"},
        )
        self.assertEqual(brand_denied.status_code, 429, brand_denied.text)
        self.assertEqual(brand_denied.json()["detail"]["resource"], "brands")
        self.assertEqual(check_denied.status_code, 429, check_denied.text)
        self.assertEqual(check_denied.json()["detail"]["resource"], "checks")

    def test_brand_quota_identity_cooldown_and_alias_updates(self):
        admin, _admin_user, _admin_email = self._make_admin()
        client, user, _email = self._register("brandquota")
        self._set_access(admin, user["id"], status="active", brands_limit=1, checks_limit=5)

        created = client.post(
            "/api/brands",
            json={"canonical_name": "First Brand", "canonical_id": "first", "aliases": [], "domains": ["first.test"]},
        )
        self.assertEqual(created.status_code, 201, created.text)
        brand_id = created.json()["brand"]["id"]
        exhausted = client.post("/api/brands", json={"canonical_name": "Second Brand", "canonical_id": "second"})
        self.assertEqual(exhausted.status_code, 429, exhausted.text)
        self.assertEqual(exhausted.json()["detail"]["code"], "quota_exceeded")
        self.assertEqual(exhausted.json()["detail"]["resource"], "brands")

        alias_update = client.patch(f"/api/brands/{brand_id}", json={"aliases": ["First"]})
        self.assertEqual(alias_update.status_code, 200, alias_update.text)
        identity_update = client.patch(f"/api/brands/{brand_id}", json={"canonical_name": "Renamed Brand"})
        self.assertEqual(identity_update.status_code, 409, identity_update.text)
        self.assertEqual(identity_update.json()["detail"]["code"], "brand_identity_cooldown")
        self.assertIn("next_allowed_at", identity_update.json()["detail"])
        immutable = client.patch(f"/api/brands/{brand_id}", json={"canonical_id": "renamed"})
        self.assertEqual(immutable.status_code, 422)

        access = client.get("/api/access").json()
        self.assertEqual(access["brands"]["used"], 1)
        self.assertEqual(access["brands"]["remaining"], 0)
        self.assertFalse(access["brands"]["unlimited"])
        self.assertIsNotNone(access["brands"]["period_start"])
        self.assertIsNotNone(access["brands"]["period_end"])

    def test_check_quota_counts_cache_and_partial_but_refunds_full_failure(self):
        admin, _admin_user, _admin_email = self._make_admin()

        cached_client, cached_user, _email = self._register("cached")
        self._set_access(admin, cached_user["id"], status="active", checks_limit=1, brands_limit=None)
        cached_result = {"provider": "gigachat", "mentioned": True, "cache_hit": True}
        with patch.object(self.main, "_run_check", return_value=cached_result):
            first = cached_client.post("/api/check", json={"brand": "Brand", "query": "Query", "provider": "gigachat"})
            second = cached_client.post("/api/check", json={"brand": "Brand", "query": "Query 2", "provider": "gigachat"})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 429, second.text)
        self.assertEqual(second.json()["detail"]["code"], "quota_exceeded")
        self.assertEqual(cached_client.get("/api/access").json()["checks"]["used"], 1)

        failed_client, failed_user, _email = self._register("failed")
        self._set_access(admin, failed_user["id"], status="active", checks_limit=1, brands_limit=None)
        provider_error = JSONResponse(status_code=502, content={"error": "provider failed"})
        with patch.object(self.main, "_run_check", return_value=provider_error):
            failed = failed_client.post("/api/check", json={"brand": "Brand", "query": "Query", "provider": "gigachat"})
        self.assertEqual(failed.status_code, 502, failed.text)
        self.assertEqual(failed_client.get("/api/access").json()["checks"]["used"], 0)

        partial_client, partial_user, _email = self._register("partial")
        self._set_access(admin, partial_user["id"], status="active", checks_limit=1, brands_limit=None)
        with patch.object(self.main, "is_perplexity_configured", return_value=True), patch.object(
            self.main,
            "_run_check",
            return_value={"provider": "gigachat", "mentioned": True},
        ), patch.object(
            self.main,
            "_aggregate_results",
            return_value={"provider": "all", "provider_errors": [{"provider": "openai", "error": "failed"}]},
        ):
            partial = partial_client.post("/api/check-all", json={"brand": "Brand", "query": "Query"})
        self.assertEqual(partial.status_code, 200, partial.text)
        self.assertEqual(partial.json()["check"]["status"], "partial")
        self.assertEqual(partial_client.get("/api/access").json()["checks"]["used"], 1)

    def test_first_success_completes_onboarding_once_even_after_history_deletion(self):
        admin, _admin_user, _admin_email = self._make_admin()
        client, user, _email = self._register("onboarding")
        self._set_access(admin, user["id"], status="active", checks_limit=None, brands_limit=None)
        self.assertIsNone(client.get("/api/account").json()["onboarding_completed_at"])
        first = self.main.start_check(user["id"], "Brand", "", "Query", "all")
        self.main.finish_check(user["id"], first["id"], "partial", result={"provider_errors": [{"provider": "openai", "error": "unavailable"}]})
        completed_at = client.get("/api/account").json()["onboarding_completed_at"]
        self.assertIsNotNone(completed_at)
        second = self.main.start_check(user["id"], "Brand", first["canonical_id"], "Query 2", "all")
        self.main.finish_check(user["id"], second["id"], "completed", result={"mentioned": False})
        self.assertEqual(client.get("/api/account").json()["onboarding_completed_at"], completed_at)
        for check in (first, second):
            self.assertEqual(client.delete(f"/api/checks/{check['id']}").status_code, 204)
        self.assertEqual(client.get("/api/checks").json()["checks"], [])
        self.assertEqual(client.get("/api/account").json()["onboarding_completed_at"], completed_at)

        failed_client, failed_user, _email = self._register("onboarding-failed")
        self._set_access(admin, failed_user["id"], status="active", checks_limit=None, brands_limit=None)
        failed = self.main.start_check(failed_user["id"], "Brand", "", "Query", "all")
        self.main.finish_check(failed_user["id"], failed["id"], "failed", error={"error": "unavailable"})
        self.assertIsNone(failed_client.get("/api/account").json()["onboarding_completed_at"])

    def test_history_expires_only_owned_stale_checks_and_refunds_current_cycle_once(self):
        admin, _admin_user, _admin_email = self._make_admin()
        client, user, _email = self._register("stale-checks")
        other_client, other_user, _email = self._register("other-stale-checks")
        for owner in (user, other_user):
            self._set_access(admin, owner["id"], status="active", checks_limit=None, brands_limit=None)
        expired = self.main.start_check(user["id"], "Brand", "", "Expired query", "all")
        old_cycle = self.main.start_check(user["id"], "Brand", expired["canonical_id"], "Old cycle", "all")
        fresh = self.main.start_check(user["id"], "Brand", expired["canonical_id"], "Fresh query", "all")
        foreign = self.main.start_check(other_user["id"], "Other", "", "Other query", "all")
        with self.database.connection() as database:
            database.execute("UPDATE checks SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ANY(%s)", ([expired["id"], old_cycle["id"], foreign["id"]],))
            database.execute("UPDATE checks SET quota_cycle = quota_cycle - 1 WHERE id = %s", (old_cycle["id"],))
        for _attempt in range(2):
            response = client.get("/api/checks")
            self.assertEqual(response.status_code, 200, response.text)
            history = {item["id"]: item for item in response.json()["checks"]}
            self.assertEqual(history[expired["id"]]["status"], "failed")
            self.assertEqual(history[old_cycle["id"]]["status"], "failed")
            self.assertEqual(history[expired["id"]]["quota_state"], "refunded")
            self.assertEqual(history[fresh["id"]]["status"], "running")
            self.assertEqual(client.get("/api/access").json()["checks"]["used"], 2)
        with self.database.connection() as database:
            foreign_row = database.execute("SELECT status, quota_state FROM checks WHERE id = %s", (foreign["id"],)).fetchone()
        self.assertEqual(foreign_row, {"status": "running", "quota_state": "reserved"})
        self.assertEqual(other_client.get("/api/access").json()["checks"]["used"], 1)
        late = self.main.finish_check(user["id"], expired["id"], "completed", result={"mentioned": True})
        self.assertEqual(late["status"], "failed")
        self.assertEqual(late["error"], {"error": "interrupted"})
        self.assertIsNone(late["result"])
        self.assertIsNone(client.get("/api/account").json()["onboarding_completed_at"])
        self.assertEqual(client.get("/api/access").json()["checks"]["used"], 2)

    def test_cleanup_and_completion_share_one_terminal_transition(self):
        admin, _admin_user, _admin_email = self._make_admin()
        client, user, _email = self._register("cleanup-race")
        self._set_access(admin, user["id"], status="active", checks_limit=None, brands_limit=None)
        check = self.main.start_check(user["id"], "Brand", "", "Query", "all")
        with self.database.connection() as database:
            database.execute("UPDATE checks SET created_at = NOW() - INTERVAL '2 hours' WHERE id = %s", (check["id"],))
        with ThreadPoolExecutor(max_workers=2) as executor:
            cleanup = executor.submit(self.main.list_checks, user["id"])
            completion = executor.submit(self.main.finish_check, user["id"], check["id"], "completed", {"mentioned": True})
            cleanup.result(timeout=10)
            completion.result(timeout=10)
        stored = client.get("/api/checks").json()["checks"][0]
        self.assertIn(stored["status"], ("failed", "completed"))
        consumed = stored["status"] == "completed"
        self.assertEqual(client.get("/api/access").json()["checks"]["used"], int(consumed))
        self.assertEqual(stored["quota_state"], "consumed" if consumed else "refunded")
        self.assertEqual(client.get("/api/account").json()["onboarding_completed_at"] is not None, consumed)

    def test_last_check_slot_is_reserved_atomically(self):
        admin, _admin_user, _admin_email = self._make_admin()
        first_client, user, email = self._register("concurrent")
        second_client = self._client()
        self.assertEqual(second_client.post("/api/auth/login", json={"email": email, "password": "password1"}).status_code, 200)
        self._set_access(admin, user["id"], status="active", checks_limit=1, brands_limit=None)
        entered = threading.Event()
        release = threading.Event()

        def slow_result(*_args, **_kwargs):
            entered.set()
            release.wait(5)
            return {"provider": "gigachat", "mentioned": True}

        with patch.object(self.main, "_run_check", side_effect=slow_result):
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(
                    first_client.post,
                    "/api/check",
                    json={"brand": "Brand", "query": "First", "provider": "gigachat"},
                )
                self.assertTrue(entered.wait(5))
                try:
                    rejected = second_client.post(
                        "/api/check",
                        json={"brand": "Brand", "query": "Second", "provider": "gigachat"},
                    )
                finally:
                    release.set()
                completed = future.result(timeout=5)
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertEqual(rejected.status_code, 429, rejected.text)
        self.assertEqual(rejected.json()["detail"]["code"], "quota_exceeded")

    def test_user_data_isolation_and_verified_account_deletion(self):
        admin, _admin_user, _admin_email = self._make_admin()
        first, first_user, _first_email = self._register("owner")
        second, second_user, _second_email = self._register("outsider")
        self._set_access(admin, first_user["id"], status="active", checks_limit=None, brands_limit=None)
        self._set_access(admin, second_user["id"], status="active", checks_limit=None, brands_limit=None)

        created = first.post("/api/brands", json={"canonical_name": "Private", "canonical_id": "private"})
        self.assertEqual(created.status_code, 201, created.text)
        brand_id = created.json()["brand"]["id"]
        self.assertEqual(second.get("/api/brands").json()["brands"], [])
        self.assertEqual(second.patch(f"/api/brands/{brand_id}", json={"aliases": ["Intrusion"]}).status_code, 404)
        self.assertEqual(second.delete(f"/api/brands/{brand_id}").status_code, 404)

        wrong = first.request(
            "delete",
            "/api/account",
            json={"current_password": "wrongpass", "confirmation": "УДАЛИТЬ"},
        )
        self.assertIn(wrong.status_code, (400, 401, 403))
        deleted = first.request(
            "delete",
            "/api/account",
            json={"current_password": "password1", "confirmation": "УДАЛИТЬ"},
        )
        self.assertEqual(deleted.status_code, 204, deleted.text)
        self.assertEqual(first.get("/api/account").status_code, 401)
        self.assertEqual(second.get("/api/account").status_code, 200)
        with self.database.connection() as database:
            owner = database.execute("SELECT id FROM users WHERE id = %s", (first_user["id"],)).fetchone()
            brands = database.execute("SELECT id FROM brands WHERE user_id = %s", (first_user["id"],)).fetchall()
        self.assertIsNone(owner)
        self.assertEqual(brands, [])


if __name__ == "__main__":
    unittest.main()
