import json
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import main
import storage


class PersistenceApiTests(unittest.TestCase):
    def setUp(self):
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7, "name": "User", "email": "u@example.com", "brand": "Vidno"}
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main._check_times.clear()

    def test_working_routes_require_cookie_session(self):
        main.app.dependency_overrides.clear()
        self.assertEqual(self.client.get("/api/brands").status_code, 401)
        self.assertEqual(self.client.get("/api/brands", headers={"Authorization": "Bearer legacy-token"}).status_code, 401)

    def test_registration_returns_cookie_without_token_body(self):
        with patch.object(main, "create_user", return_value={"id": 3, "name": "User", "email": "u@example.com", "brand": "Vidno"}), patch.object(main, "create_session", return_value="secret"):
            response = self.client.post("/api/auth/register", json={"name": "User", "email": "u@example.com", "password": "password1", "brand": "Vidno"})
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("session_token", response.json())
        self.assertIn("vidno_session=secret", response.headers["set-cookie"])
        self.assertIn("HttpOnly", response.headers["set-cookie"])

    def test_check_is_saved_and_returns_metadata(self):
        started = {"id": 41, "brand_id": 9, "status": "running", "created_at": "now", "completed_at": None}
        finished = {**started, "status": "completed", "completed_at": "later"}
        with patch.object(main, "start_check", return_value=started) as start, patch.object(main, "_run_check", return_value={"provider": "gigachat", "mentioned": True}) as run, patch.object(main, "finish_check", return_value=finished) as finish:
            response = self.client.post("/api/check", json={"brand": "Vidno", "query": "Лучший сервис?", "provider": "gigachat"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["check"]["id"], 41)
        self.assertEqual(start.call_args.args[0], 7)
        self.assertEqual(run.call_args.args[1], 7)
        self.assertEqual(finish.call_args.args[2], "completed")

    def test_failed_check_keeps_check_id_and_error(self):
        started = {"id": 42, "brand_id": 9, "status": "running", "created_at": "now", "completed_at": None}
        finished = {**started, "status": "failed", "completed_at": "later"}
        with patch.object(main, "start_check", return_value=started), patch.object(main, "_run_check", return_value=JSONResponse(status_code=502, content={"error": "provider failed"})), patch.object(main, "finish_check", return_value=finished) as finish:
            response = self.client.post("/api/check", json={"brand": "Vidno", "query": "Лучший сервис?", "provider": "gigachat"})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["check_id"], 42)
        self.assertEqual(finish.call_args.kwargs["error"], {"error": "provider failed"})

    def test_late_provider_success_does_not_return_unsaved_metrics(self):
        started = {"id": 42, "brand_id": 9, "status": "running", "created_at": "now", "completed_at": None}
        interrupted = {**started, "status": "failed", "completed_at": "later"}
        with patch.object(main, "start_check", return_value=started), patch.object(main, "_run_check", return_value={"provider": "gigachat", "mentioned": True}), patch.object(main, "finish_check", return_value=interrupted):
            response = self.client.post("/api/check", json={"brand": "Vidno", "query": "Лучший сервис?", "provider": "gigachat"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["check_id"], 42)
        self.assertNotIn("mentioned", response.json())

    def test_repeated_completion_returns_persisted_result(self):
        for status in ("completed", "partial"):
            with self.subTest(status=status):
                saved_result = {"provider": "all", "mentioned": False, "provider_results": [{"provider": "gigachat", "mentioned": False}]}
                if status == "partial":
                    saved_result["provider_errors"] = [{"provider": "openai", "error": "unavailable"}]
                record = {"id": 42, "brand_id": 9, "status": status, "created_at": "now", "completed_at": "later", "result": saved_result}
                with patch.object(main, "finish_check", return_value=record):
                    response = main._complete_check_response(7, 42, {"provider": "all", "mentioned": True, "new_unsaved_field": True})
                self.assertFalse(response["mentioned"])
                self.assertEqual(response["provider_results"], saved_result["provider_results"])
                self.assertEqual(response.get("provider_errors"), saved_result.get("provider_errors"))
                self.assertEqual(response["check"]["status"], status)
                self.assertNotIn("new_unsaved_field", response)

    def test_start_failure_releases_concurrency_slot(self):
        with patch.object(main, "start_check", side_effect=RuntimeError("database unavailable")):
            with self.assertRaises(RuntimeError):
                self.client.post("/api/check", json={"brand": "Vidno", "query": "Лучший сервис?", "provider": "gigachat"})
        self.assertTrue(main._check_semaphore.acquire(blocking=False))
        main._check_semaphore.release()

    def test_brand_listing_is_user_scoped(self):
        with patch.object(main, "list_brands", return_value=[{"id": 1, "canonical_id": "vidno", "canonical_name": "Vidno", "aliases": [], "domains": []}]) as listed:
            response = self.client.get("/api/brands")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["brands"][0]["canonical_id"], "vidno")
        listed.assert_called_once_with(7)

    def test_growth_task_accepts_wrapped_frontend_payload(self):
        task = {"id": 5, "brand": "Vidno", "status": "planned"}
        with patch.object(main, "create_growth_task", return_value=task) as created:
            response = self.client.post("/api/growth-tasks", json={"task": {"brand": "Vidno", "brandKey": "vidno", "status": "planned"}})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["task"]["id"], 5)
        created.assert_called_once_with(7, {"brand": "Vidno", "brandKey": "vidno", "status": "planned"})

    def test_dismissed_opportunities_contract(self):
        with patch.object(main, "dismiss_opportunity", return_value="key") as dismissed:
            response = self.client.put("/api/dismissed-opportunities", json={"opportunity_id": "key"})
        self.assertEqual(response.json(), {"opportunity_id": "key"})
        dismissed.assert_called_once_with(7, "key")


class StorageResolutionTests(unittest.TestCase):
    def test_task_brand_key_resolves_to_owned_brand(self):
        class Cursor:
            def fetchone(self):
                return {"id": 12}

        class Database:
            def execute(self, query, params):
                self.query = query
                self.params = params
                return Cursor()

        database = Database()
        brand_id = storage._owned_brand_id(database, 7, {"brandKey": "vidno", "brand": "Vidno"})
        self.assertEqual(brand_id, 12)
        self.assertEqual(database.params, (7, "vidno"))

    def test_deleting_brand_clears_related_user_cache_and_dismissals(self):
        class Cursor:
            def __init__(self, row=None):
                self.row = row

            def fetchone(self):
                return self.row

        class Database:
            def __init__(self):
                self.calls = []

            def execute(self, query, params):
                self.calls.append((" ".join(query.split()), params))
                return Cursor({"id": 12, "canonical_id": "vidno"}) if len(self.calls) == 1 else Cursor()

        database = Database()

        @contextmanager
        def fake_connection():
            yield database

        with patch.object(storage, "connection", fake_connection), patch.object(
            storage,
            "_locked_access",
            return_value={"status": "active", "expires_at": None},
        ):
            self.assertTrue(storage.delete_brand(7, 12))
        self.assertEqual(database.calls[1][1], (7,))
        self.assertEqual(database.calls[2][1], (7,))
        self.assertEqual(database.calls[3][1], (7, "vidno"))


class CheckCompletionTests(unittest.TestCase):
    def _record(self, status="running"):
        return {
            "id": 41, "brand_id": 9, "brand": "Vidno", "canonical_id": "vidno",
            "query": "Query", "provider": "all", "status": status,
            "quota_state": "reserved" if status == "running" else "refunded", "quota_cycle": 3,
            "result": None, "error": None, "created_at": "now", "completed_at": None,
        }

    def _database(self, current, finished=None):
        class Cursor:
            def __init__(self, row):
                self.row = row

            def fetchone(self):
                return self.row

        class Database:
            def __init__(self):
                self.calls = []

            def execute(self, query, params):
                self.calls.append((" ".join(query.split()), params))
                return Cursor(current if query.strip().startswith("SELECT") else finished)

        return Database()

    def test_terminal_check_cannot_be_overwritten_or_refunded_again(self):
        for status in ("failed", "completed", "partial"):
            with self.subTest(status=status):
                current = self._record(status)
                database = self._database(current)

                @contextmanager
                def fake_connection():
                    yield database

                with patch.object(storage, "connection", fake_connection), patch.object(storage, "_locked_access") as access:
                    result = storage.finish_check(7, 41, "completed", result={"mentioned": True})
                self.assertEqual(result["status"], status)
                self.assertEqual(len(database.calls), 1)
                access.assert_called_once_with(database, 7, refresh=False)

    def test_success_marks_onboarding_but_failure_only_refunds_quota(self):
        for status in ("completed", "partial", "failed"):
            with self.subTest(status=status):
                current = self._record()
                finished = {**current, "status": status}
                database = self._database(current, finished)

                @contextmanager
                def fake_connection():
                    yield database

                with patch.object(storage, "connection", fake_connection), patch.object(storage, "_locked_access"):
                    result = storage.finish_check(7, 41, status)
                self.assertEqual(result["status"], status)
                writes = [query for query, _params in database.calls]
                self.assertEqual(any("UPDATE users SET onboarding_completed_at" in query for query in writes), status != "failed")
                self.assertEqual(any("UPDATE user_access SET checks_used" in query for query in writes), status == "failed")


if __name__ == "__main__":
    unittest.main()
