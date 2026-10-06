import asyncio
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient

import main
import auth
import storage


class AccessApiContractTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main._check_times.clear()

    def test_account_access_and_admin_routes_are_exposed(self):
        paths = main.app.openapi()["paths"]
        self.assertEqual(set(paths["/api/account"]), {"get", "patch", "delete"})
        self.assertEqual(set(paths["/api/access"]), {"get"})
        self.assertEqual(set(paths["/api/admin/clients"]), {"get"})
        self.assertEqual(set(paths["/api/admin/clients/{client_id}"]), {"get"})
        self.assertEqual(set(paths["/api/admin/clients/{client_id}/access"]), {"patch"})

    def test_account_access_and_admin_require_cookie_session(self):
        requests = (
            ("get", "/api/account", None),
            ("patch", "/api/account", {"name": "Changed"}),
            ("delete", "/api/account", {"current_password": "password1", "confirmation": "УДАЛИТЬ"}),
            ("get", "/api/access", None),
            ("get", "/api/admin/clients", None),
            ("get", "/api/admin/clients/1", None),
            ("patch", "/api/admin/clients/1/access", {"status": "active"}),
        )
        for method, path, body in requests:
            with self.subTest(method=method, path=path):
                response = self.client.request(method, path, json=body)
                self.assertEqual(response.status_code, 401)

    def test_account_patch_rejects_role_and_access_fields(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 7,
            "name": "User",
            "email": "u@example.com",
            "brand": "",
            "role": "client",
        }
        for body in (
            {"role": "admin"},
            {"status": "active"},
            {"plan": "business"},
            {"checks_limit": None},
            {"brands_limit": None},
            {"onboarding_completed_at": "2026-10-06T00:00:00Z"},
        ):
            with self.subTest(body=body):
                response = self.client.patch("/api/account", json=body)
                self.assertEqual(response.status_code, 422)

    def test_admin_access_patch_rejects_role(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 1,
            "name": "Admin",
            "email": "admin@example.com",
            "brand": "",
            "role": "admin",
        }
        response = self.client.patch("/api/admin/clients/7/access", json={"role": "admin"})
        self.assertEqual(response.status_code, 422)

    def test_admin_access_patch_rejects_empty_status_and_plan(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 1,
            "name": "Admin",
            "email": "admin@example.com",
            "brand": "",
            "role": "admin",
        }
        for body in ({"status": None}, {"plan": None}):
            with self.subTest(body=body), patch.object(main, "update_admin_access") as updated:
                response = self.client.patch("/api/admin/clients/7/access", json=body)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json()["detail"]["code"], "invalid_access_update")
                updated.assert_not_called()

    def test_delete_account_requires_confirmation_and_password(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 7,
            "name": "User",
            "email": "u@example.com",
            "brand": "",
            "role": "client",
        }
        for body in (
            {},
            {"current_password": "password1"},
            {"confirmation": "УДАЛИТЬ"},
            {"current_password": "password1", "confirmation": "DELETE"},
        ):
            with self.subTest(body=body):
                response = self.client.request("delete", "/api/account", json=body)
                self.assertEqual(response.status_code, 422)

    def test_delete_account_still_uses_verified_explicit_deletion(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 7,
            "name": "User",
            "email": "u@example.com",
            "brand": "",
            "role": "client",
        }
        with patch.object(main, "delete_user_verified", return_value=None) as deleted:
            response = self.client.request(
                "delete",
                "/api/account",
                json={"current_password": "password1", "confirmation": "УДАЛИТЬ"},
            )
        self.assertEqual(response.status_code, 204)
        deleted.assert_called_once_with(7, "password1")

    def test_client_role_cannot_use_admin_api(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 7,
            "name": "User",
            "email": "u@example.com",
            "brand": "",
            "role": "client",
        }
        for method, path, body in (
            ("get", "/api/admin/clients", None),
            ("get", "/api/admin/clients/1", None),
            ("patch", "/api/admin/clients/1/access", {"status": "active"}),
        ):
            with self.subTest(method=method, path=path):
                response = self.client.request(method, path, json=body)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["detail"]["code"], "admin_required")

    def test_account_and_access_return_public_contract(self):
        user = {
            "id": 7,
            "name": "User",
            "email": "u@example.com",
            "brand": "Legacy",
            "role": "client",
        }
        account = {**user, "created_at": "2026-01-01T00:00:00+00:00", "onboarding_completed_at": None}
        access = {
            "status": "active",
            "administrative_status": "active",
            "plan": "custom",
            "activated_at": "2026-01-01T00:00:00+00:00",
            "expires_at": None,
            "checks": {
                "limit": 10,
                "used": 2,
                "remaining": 8,
                "unlimited": False,
                "period_start": "2026-01-01T00:00:00+00:00",
                "period_end": "2026-02-01T00:00:00+00:00",
            },
            "brands": {
                "limit": None,
                "used": 1,
                "remaining": None,
                "unlimited": True,
                "period_start": "2026-01-01T00:00:00+00:00",
                "period_end": "2026-02-01T00:00:00+00:00",
            },
            "capabilities": {
                "workspace_write": True,
                "run_checks": True,
                "create_brands": True,
                "manage_existing_brands": True,
            },
        }
        main.app.dependency_overrides[main._current_user] = lambda: user
        with patch.object(main, "get_account", return_value=account) as get_account, patch.object(
            main,
            "get_access",
            return_value=access,
        ) as get_access:
            account_response = self.client.get("/api/account")
            access_response = self.client.get("/api/access")
        self.assertEqual(account_response.status_code, 200)
        self.assertEqual(
            account_response.json(),
            {key: account[key] for key in ("id", "name", "email", "created_at", "role", "onboarding_completed_at")},
        )
        self.assertEqual(access_response.status_code, 200)
        self.assertEqual(access_response.json(), access)
        get_account.assert_called_once_with(7)
        get_access.assert_called_once_with(7)

    def test_admin_search_uses_public_query_contract(self):
        main.app.dependency_overrides[main._current_user] = lambda: {
            "id": 1,
            "name": "Admin",
            "email": "admin@example.com",
            "brand": "",
            "role": "admin",
        }
        result = {"items": [], "page": 2, "page_size": 10, "total": 0}
        with patch.object(main, "list_admin_clients", return_value=result) as listed:
            response = self.client.get(
                "/api/admin/clients",
                params={"q": "vidno", "status": "active", "plan": "pro", "page": 2, "page_size": 10},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), result)
        listed.assert_called_once_with("vidno", "active", "pro", 2, 10)


class AccessPersistenceContractTests(unittest.TestCase):
    def test_account_serializes_nullable_onboarding_completion(self):
        from datetime import datetime, timezone

        completed = datetime(2026, 10, 6, tzinfo=timezone.utc)
        for value in (None, completed):
            with self.subTest(completed=value is not None):
                row = {"id": 7, "name": "User", "email": "u@example.com", "brand": "", "role": "client", "onboarding_completed_at": value}
                result = auth._public_user(row)
                self.assertEqual(result["onboarding_completed_at"], value.isoformat() if value else None)

    def test_startup_only_initializes_storage_without_account_cleanup(self):
        initialized = []

        async def verify():
            with patch.object(main, "initialize_cache", side_effect=lambda: initialized.append("cache")), patch.object(
                main,
                "initialize_auth",
                side_effect=lambda: initialized.append("auth"),
            ), patch.object(main.threading, "Thread") as thread:
                async with main.lifespan(main.app):
                    thread.assert_not_called()

        asyncio.run(verify())
        self.assertEqual(initialized, ["cache", "auth"])

    def test_registration_keeps_initial_brand_while_access_starts_pending(self):
        class Cursor:
            def fetchone(self):
                return {"id": 7, "name": "User", "email": "u@example.com", "brand": "Vidno", "role": "client"}

        class Database:
            def __init__(self):
                self.calls = []

            def execute(self, query, params):
                self.calls.append((" ".join(query.split()), params))
                return Cursor()

        database = Database()

        @contextmanager
        def fake_connection():
            yield database

        with patch.object(auth, "connection", fake_connection):
            user = auth.create_user("User", "u@example.com", "password1", "Vidno")
        self.assertEqual(user["role"], "client")
        self.assertIn("INSERT INTO user_access", database.calls[1][0])
        self.assertEqual(database.calls[1][1], (7,))
        self.assertIn("INSERT INTO brands", database.calls[2][0])
        self.assertEqual(database.calls[2][1][0], 7)
        self.assertEqual(database.calls[2][1][2], "Vidno")

    def test_saved_history_record_is_unmetered(self):
        check_row = {
            "id": 9,
            "brand_id": 3,
            "brand": "Vidno",
            "canonical_id": "vidno",
            "query": "Query",
            "provider": "all",
            "status": "completed",
            "result": {"brand": "Vidno", "query": "Query"},
            "error": None,
            "created_at": None,
            "completed_at": None,
            "quota_state": "unmetered",
        }

        class Cursor:
            def fetchone(self):
                return check_row

        class Database:
            def __init__(self):
                self.calls = []

            def execute(self, query, params):
                self.calls.append((" ".join(query.split()), params))
                return Cursor()

        database = Database()

        @contextmanager
        def fake_connection():
            yield database

        with patch.object(storage, "ensure_brand", return_value={"id": 3, "canonical_id": "vidno", "canonical_name": "Vidno"}), patch.object(
            storage,
            "connection",
            fake_connection,
        ), patch.object(storage, "_locked_access", return_value={"status": "active", "expires_at": None}), patch.object(
            storage,
            "start_check",
        ) as start_check:
            record = storage.create_saved_check(7, {"brand": "Vidno", "query": "Query", "provider": "all"})
        self.assertEqual(record["quota_state"], "unmetered")
        self.assertIn("'unmetered'", database.calls[0][0])
        start_check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
