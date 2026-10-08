import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

with patch("dotenv.load_dotenv", return_value=False):
    import main

from fastapi.testclient import TestClient
from storage import AccessControlError
from vouchers import code_hash, generate_code, normalize_code


class VoucherApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        main._check_times.clear()

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main._check_times.clear()
        self.client.close()

    def _role(self, role):
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7, "role": role}

    def test_session_and_admin_roles_protect_all_routes(self):
        requests = (
            ("get", "/api/admin/tariffs", None),
            ("patch", "/api/admin/tariffs/basic", {"checks_limit": 3, "brands_limit": 1}),
            ("post", "/api/admin/voucher-batches", {"plan": "basic"}),
            ("get", "/api/admin/voucher-batches", None),
            ("get", "/api/admin/voucher-batches/1", None),
            ("post", "/api/admin/vouchers/1/revoke", None),
        )
        for role, expected in ((None, 401), ("client", 403)):
            if role:
                self._role(role)
            for method, path, body in requests:
                with self.subTest(role=role, path=path):
                    self.assertEqual(self.client.request(method, path, json=body).status_code, expected)
        main.app.dependency_overrides.clear()
        self.assertEqual(self.client.post("/api/vouchers/redeem", json={"code": "example"}).status_code, 401)

    def test_batch_defaults_and_plaintext_once_contract(self):
        self._role("admin")
        created = {"batch": {"id": 1}, "vouchers": [{"id": 2, "code": "created-once", "code_mask": "••••-ONCE"}]}
        with patch.object(main, "create_voucher_batch", return_value=created) as create:
            response = self.client.post("/api/admin/voucher-batches", json={"plan": "basic"})
            self.assertEqual(response.status_code, 201)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.json(), created)
            create.assert_called_once_with(7, "basic", 10, 30)
        masked = {"batch": {"id": 1}, "vouchers": [{"id": 2, "code_mask": "••••-ONCE"}]}
        with patch.object(main, "get_voucher_batch", return_value=masked):
            self.assertEqual(self.client.get("/api/admin/voucher-batches/1").json(), masked)

    def test_batch_and_tariff_validation(self):
        self._role("admin")
        invalid_batches = (
            {"plan": "custom"}, {"plan": "basic", "quantity": 0}, {"plan": "basic", "quantity": 101},
            {"plan": "basic", "duration_days": 0}, {"plan": "basic", "duration_days": 366},
            {"plan": "basic", "quantity": True}, {"plan": "basic", "checks_limit": 1000},
        )
        with patch.object(main, "create_voucher_batch") as create:
            for body in invalid_batches:
                with self.subTest(body=body):
                    self.assertEqual(self.client.post("/api/admin/voucher-batches", json=body).status_code, 422)
            create.assert_not_called()
        for body in ({"checks_limit": None, "brands_limit": 1}, {"checks_limit": -1, "brands_limit": 1},
                     {"checks_limit": 3, "brands_limit": None}, {"checks_limit": 3, "brands_limit": True},
                     {"checks_limit": 2147483648, "brands_limit": 1}, {"checks_limit": 3, "brands_limit": 1, "role": "admin"}):
            self.assertEqual(self.client.patch("/api/admin/tariffs/basic", json=body).status_code, 422)

    def test_redeem_returns_access_and_backend_errors(self):
        self._role("client")
        access = {"status": "active", "can_redeem_voucher": False, "voucher_redeemed": True}
        with patch.object(main, "redeem_voucher", return_value=access) as redeem:
            response = self.client.post("/api/vouchers/redeem", json={"code": "example"})
            self.assertEqual(response.json(), {"access": access})
            redeem.assert_called_once_with(7, "example")
        with patch.object(main, "redeem_voucher", side_effect=AccessControlError(400, "voucher_invalid", "Код недоступен")):
            response = self.client.post("/api/vouchers/redeem", json={"code": "example"})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["detail"]["code"], "voucher_invalid")

    def test_redeem_rate_limit_blocks_before_database(self):
        self._role("client")
        with patch.object(main, "CHECKS_PER_MINUTE", 2), patch.object(main, "redeem_voucher", side_effect=AccessControlError(400, "voucher_invalid", "Код недоступен")) as redeem:
            for _ in range(2):
                self.assertEqual(self.client.post("/api/vouchers/redeem", json={"code": "example"}).status_code, 400)
            self.assertEqual(self.client.post("/api/vouchers/redeem", json={"code": "example"}).status_code, 429)
            self.assertEqual(redeem.call_count, 2)

    def test_redeem_rate_limit_isolated_between_accounts(self):
        self._role("client")
        with patch.object(main, "CHECKS_PER_MINUTE", 1), patch.object(main, "redeem_voucher", side_effect=AccessControlError(400, "voucher_invalid", "Код недоступен")) as redeem:
            self.assertEqual(self.client.post("/api/vouchers/redeem", json={"code": "example"}).status_code, 400)
            self.assertEqual(self.client.post("/api/vouchers/redeem", json={"code": "example"}).status_code, 429)
            main.app.dependency_overrides[main._current_user] = lambda: {"id": 8, "role": "client"}
            self.assertEqual(self.client.post("/api/vouchers/redeem", json={"code": "example"}).status_code, 400)
            self.assertEqual(redeem.call_count, 2)

    def test_codes_have_160_bits_and_normalization_is_stable(self):
        codes = [generate_code() for _ in range(100)]
        self.assertEqual(len(set(codes)), 100)
        for code in codes:
            raw = normalize_code(code)
            self.assertEqual(len(raw), 40)
            self.assertRegex(raw, r"^[0-9A-F]{40}$")
            self.assertEqual(code_hash(code), code_hash(" \t" + code.lower().replace("-", " - \n") + " "))
            self.assertEqual(len(code_hash(code)), 64)


if __name__ == "__main__":
    unittest.main()
