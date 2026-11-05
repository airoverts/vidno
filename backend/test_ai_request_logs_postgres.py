import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import ai_request_logs as audit
import auth
import database
import main


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "").strip()


@unittest.skipUnless(TEST_DATABASE_URL, "TEST_DATABASE_URL is required for PostgreSQL integration tests")
class AiRequestLogsPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import conninfo_to_dict, make_conninfo

        info = conninfo_to_dict(TEST_DATABASE_URL)
        if "test" not in str(info.get("dbname") or "").lower() or info.get("host") not in {"127.0.0.1", "localhost", "::1"}:
            raise unittest.SkipTest("Only an explicit local test database is allowed")
        cls.psycopg = psycopg
        cls.sql = sql
        cls.schema = "vidno_ai_logs_test_" + uuid.uuid4().hex
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        cls.addClassCleanup(cls.cleanup_schema)
        schema_url = make_conninfo(TEST_DATABASE_URL, options=f"-csearch_path={cls.schema}")
        cls.url_patch = patch.object(database, "database_url", return_value=schema_url)
        cls.url_patch.start()
        cls.addClassCleanup(cls.url_patch.stop)
        database.initialize_database()

    @classmethod
    def cleanup_schema(cls):
        if not cls.schema.startswith("vidno_ai_logs_test_") or len(cls.schema) != len("vidno_ai_logs_test_") + 32:
            raise RuntimeError("Refusing to remove an unexpected schema")
        with cls.psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            connection.execute(cls.sql.SQL("DROP SCHEMA {} CASCADE").format(cls.sql.Identifier(cls.schema)))

    def setUp(self):
        main.app.dependency_overrides.clear()
        self.addCleanup(main.app.dependency_overrides.clear)
        self.user_id, self.email = self.new_user()
        self.start = datetime(2026, 10, 1, tzinfo=timezone.utc)
        self.end = self.start + timedelta(days=30)

    def new_user(self, role="client"):
        label = uuid.uuid4().hex
        email = f"{label}@audit.integration.test"
        with database.connection() as connection:
            row = connection.execute("INSERT INTO users(name, email, password_hash, role) VALUES (%s, %s, %s, %s) RETURNING id", (f"User {label}", email, "test-fixture", role)).fetchone()
        return row["id"], email

    def log(self, **changes):
        row = {
            "user_id": self.user_id, "request_id": str(uuid.uuid4()), "check_id": None,
            "provider": "openai", "operation": "check", "stage": "generation", "attempt": 1,
            "started_at": self.start + timedelta(hours=1), "duration_ms": 15,
            "status": "success", "http_status": 200, "requested_model": "configured-v1", "returned_model": "actual-v2",
            "input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
            "cached_tokens": 2, "reasoning_tokens": 1, "error_category": None,
            **changes,
        }
        audit.insert_log(row)
        return row

    def listing(self, **changes):
        return audit.list_ai_requests(date_from=self.start, date_to=self.end, user=self.email, **changes)

    def new_check(self):
        with database.connection() as connection:
            brand = connection.execute("INSERT INTO brands(user_id, canonical_id, canonical_name) VALUES (%s, %s, %s) RETURNING id", (self.user_id, uuid.uuid4().hex, "Fixture brand")).fetchone()
            check = connection.execute("INSERT INTO checks(user_id, brand_id, brand, query, provider, status) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id", (self.user_id, brand["id"], "Fixture brand", "Fixture query", "openai", "completed")).fetchone()
        return brand["id"], check["id"]

    def test_initialization_repeatedly_applies_migration_only_once(self):
        self.log()
        database.initialize_database()
        database.initialize_database()
        with database.connection() as connection:
            applied = connection.execute("SELECT COUNT(*) AS amount FROM schema_migrations WHERE version = '0006_ai_request_logs.sql'").fetchone()
            indexed = connection.execute("SELECT COUNT(*) AS amount FROM pg_indexes WHERE schemaname = %s AND tablename = 'ai_request_logs'", (self.schema,)).fetchone()
        self.assertEqual(applied["amount"], 1)
        self.assertGreaterEqual(indexed["amount"], 4)
        self.assertEqual(self.listing()["total"], 1)

    def test_full_filtered_summary_is_independent_of_page(self):
        self.log(started_at=self.start + timedelta(hours=1))
        self.log(started_at=self.start + timedelta(hours=2), input_tokens=7, output_tokens=3, total_tokens=10)
        self.log(started_at=self.start + timedelta(hours=3), status="network_error", http_status=None, input_tokens=None, output_tokens=None, total_tokens=None)
        self.log(provider="deepseek", input_tokens=999, output_tokens=999, total_tokens=1998)
        outsider, _ = self.new_user()
        self.log(user_id=outsider, input_tokens=999, output_tokens=999, total_tokens=1998)
        first = self.listing(provider="openai", page=1, page_size=1)
        second = self.listing(provider="openai", page=2, page_size=1)
        expected = {"attempts": 3, "errors": 1, "input_tokens": 17, "output_tokens": 8, "total_tokens": 25, "missing_usage": 1}
        self.assertEqual(first["summary"], expected)
        self.assertEqual(second["summary"], expected)
        self.assertEqual((first["total"], first["page"], first["page_size"], len(first["items"])), (3, 1, 1, 1))
        self.assertEqual(first["items"][0]["status"], "network_error")
        self.assertGreater(first["items"][0]["started_at"], second["items"][0]["started_at"])
        self.assertNotEqual(first["items"][0]["id"], second["items"][0]["id"])

    def test_models_match_requested_or_returned_and_filters_combine(self):
        self.log(operation="brief", status="provider_error", requested_model="Configured-Unique", returned_model="Actual-Unique")
        self.log(operation="check", requested_model="configured-other", returned_model="actual-other")
        self.assertEqual(self.listing(model="CONFIGURED-UNIQUE")["total"], 1)
        self.assertEqual(self.listing(model="ACTUAL-UNIQUE")["total"], 1)
        self.assertEqual(self.listing(model="unique", operation="brief", status="provider_error", provider="openai")["total"], 1)
        self.assertEqual(self.listing(model="unique", operation="check")["total"], 0)
        self.assertEqual(self.listing(model="' OR TRUE --")["total"], 0)
        self.assertEqual(self.listing(model="%_")["total"], 0)

    def test_period_is_half_open_and_user_search_matches_name_or_email(self):
        self.log(started_at=self.start)
        self.log(started_at=self.end)
        self.log(started_at=self.start - timedelta(microseconds=1))
        with database.connection() as connection:
            connection.execute("UPDATE users SET name = %s WHERE id = %s", (f"Distinctive {self.email}", self.user_id))
        result = audit.list_ai_requests(date_from=self.start, date_to=self.end, user=f"DISTINCTIVE {self.email.upper()}")
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["started_at"], self.start)
        self.assertEqual(self.listing()["total"], 1)

    def test_transport_persists_usage_and_real_api_serializes_uuid_and_dates(self):
        admin_id, _ = self.new_user(role="admin")
        session = auth.create_session(admin_id)
        payload = {"model": "actual-v3", "usage": {"input_tokens": 13, "output_tokens": 4}}
        provider_response = httpx.Response(200, json=payload, request=httpx.Request("POST", "https://provider.integration.test/"))
        with patch.object(audit.httpx, "post", return_value=provider_response):
            with audit.request_scope(self.user_id, "brief"):
                audit.logged_http_post("openai", "configured-v1", 1, "https://provider.integration.test/")
        with TestClient(main.app) as client:
            client.cookies.set("vidno_session", session)
            result = client.get("/api/admin/ai-requests", params={"date_from": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(), "date_to": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(), "user": self.email})
        self.assertEqual(result.status_code, 200, result.text)
        body = result.json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["summary"]["total_tokens"], 17)
        row = body["items"][0]
        self.assertEqual(row["user_email"], self.email)
        self.assertEqual(row["user_id"], self.user_id)
        self.assertEqual(row["returned_model"], "actual-v3")
        self.assertEqual(str(uuid.UUID(row["request_id"])), row["request_id"])
        self.assertIsNotNone(datetime.fromisoformat(row["started_at"].replace("Z", "+00:00")).tzinfo)

    def test_check_deletion_retains_log_and_clears_reference(self):
        _, check_id = self.new_check()
        self.log(check_id=check_id)
        with database.connection() as connection:
            connection.execute("DELETE FROM checks WHERE id = %s AND user_id = %s", (check_id, self.user_id))
        result = self.listing()
        self.assertEqual(result["total"], 1)
        self.assertIsNone(result["items"][0]["check_id"])

    def test_brand_deletion_retains_log_and_clears_cascaded_check_reference(self):
        brand_id, check_id = self.new_check()
        self.log(check_id=check_id)
        with database.connection() as connection:
            connection.execute("DELETE FROM brands WHERE id = %s AND user_id = %s", (brand_id, self.user_id))
        result = self.listing()
        self.assertEqual(result["total"], 1)
        self.assertIsNone(result["items"][0]["check_id"])

    def test_user_deletion_cascades_logs(self):
        self.log()
        with database.connection() as connection:
            connection.execute("DELETE FROM users WHERE id = %s", (self.user_id,))
            count = connection.execute("SELECT COUNT(*) AS amount FROM ai_request_logs WHERE user_id = %s", (self.user_id,)).fetchone()
        self.assertEqual(count["amount"], 0)
