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


if __name__ == "__main__":
    unittest.main()
