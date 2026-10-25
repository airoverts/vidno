import unittest
from unittest.mock import patch

with patch("dotenv.load_dotenv"):
    import main

from fastapi import HTTPException
from fastapi.testclient import TestClient
from security_config import SecuritySettings


class HardeningApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, base_url="https://vidno.one")
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7}
        main.app.dependency_overrides[main._auth_client_ip] = lambda: "192.0.2.9"
        self.addCleanup(main.app.dependency_overrides.clear)

    def test_import_forms_and_invalid_data_never_written(self):
        payload = {"brand": "Synthetic", "query": "Question", "provider": "deepseek", "position": 1.5}
        with patch.object(main, "create_saved_check", return_value={"id": 1}) as save, patch.object(main, "start_check") as quota:
            for body in (payload, {"check": payload}):
                self.assertEqual(self.client.post("/api/checks", json=body).status_code, 201)
                self.assertEqual(save.call_args.args, (7, payload))
            quota.assert_not_called()
            save.reset_mock()
            for body in ({**payload, "user_id": 1}, {"check": payload, "brand": "Other"}, {**payload, "position": "1"}, {**payload, "provider": "unknown"}):
                self.assertEqual(self.client.post("/api/checks", json=body).status_code, 422)
            self.assertEqual(self.client.post("/api/checks", content=(b" " * (2 * 1024 * 1024 + 1))).status_code, 413)
            save.assert_not_called()

    def test_patch_is_delta_and_metadata_survives(self):
        with patch.object(main, "update_growth_task", return_value={"id": 3}) as update:
            for body in ({"status": "in_progress"}, {"task": {"status": "in_progress"}}):
                self.assertEqual(self.client.patch("/api/growth-tasks/3", json=body).status_code, 200)
                update.assert_called_with(7, 3, {"status": "in_progress"})
            update.reset_mock()
            self.assertEqual(self.client.patch("/api/growth-tasks/3", json={"status": "unknown"}).status_code, 422)
            update.assert_not_called()

    def test_auth_admission_precedes_credentials_and_errors_stop_auth(self):
        events = []
        body = {"email": " TEST@example.invalid ", "password": "synthetic-password"}
        with patch.object(main, "admit_auth_attempt", side_effect=lambda *args: events.append(args)), patch.object(main, "authenticate", side_effect=lambda *args: events.append("password") or {"id": 7}), patch.object(main, "create_session", return_value="synthetic-session"), patch.object(main, "security_settings", SecuritySettings("production", ("https://vidno.one",), "frontend")):
            response = self.client.post("/api/auth/login", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(events, [("login", "192.0.2.9", "test@example.invalid"), "password"])
        for attribute in ("Secure", "HttpOnly", "SameSite=lax", "Max-Age=2592000"):
            self.assertIn(attribute, response.headers["set-cookie"])
        for status in (429, 503):
            with patch.object(main, "admit_auth_attempt", side_effect=HTTPException(status, "temporary", headers={"Retry-After": "60"})), patch.object(main, "authenticate") as authenticate:
                response = self.client.post("/api/auth/login", json=body)
                self.assertEqual(response.status_code, status)
                authenticate.assert_not_called()

    def test_cookie_deletion_and_foreign_origin(self):
        self.client.cookies.set("vidno_session", "synthetic-session")
        with patch.object(main, "delete_session") as delete, patch.object(main, "security_settings", SecuritySettings("production", ("https://vidno.one",), "frontend")):
            response = self.client.post("/api/auth/logout", headers={"Origin": "https://foreign.example"})
            self.assertEqual(response.status_code, 403)
            delete.assert_not_called()
            response = self.client.post("/api/auth/logout")
            self.assertEqual(response.status_code, 204)
            self.assertIn("Secure", response.headers["set-cookie"])
            self.assertIn("Max-Age=0", response.headers["set-cookie"])
