import os
import sys
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import database
import storage
import vouchers


TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL", "").strip()


@unittest.skipUnless(TEST_DATABASE_URL, "TEST_DATABASE_URL is required for PostgreSQL integration tests")
class VoucherPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        from psycopg.rows import dict_row

        if "test" not in str(conninfo_to_dict(TEST_DATABASE_URL).get("dbname", "")).lower():
            raise unittest.SkipTest("TEST_DATABASE_URL must point to a database whose name contains 'test'")
        cls.psycopg, cls.sql = psycopg, sql
        cls.schema = "vidno_vouchers_test_" + uuid.uuid4().hex
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as db:
            db.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))
        cls.url = make_conninfo(TEST_DATABASE_URL, options=f"-csearch_path={cls.schema}")

        @contextmanager
        def isolated_connection():
            with psycopg.connect(cls.url, row_factory=dict_row) as db:
                yield db

        cls.connect = staticmethod(isolated_connection)
        cls.patches = [patch.object(module, "connection", isolated_connection) for module in (database, storage, vouchers)]
        for item in cls.patches:
            item.start()
        database.initialize_database()

    @classmethod
    def tearDownClass(cls):
        for item in reversed(cls.patches):
            item.stop()
        if not cls.schema.startswith("vidno_vouchers_test_"):
            raise RuntimeError("Unexpected test schema")
        with cls.psycopg.connect(TEST_DATABASE_URL, autocommit=True) as db:
            db.execute(cls.sql.SQL("DROP SCHEMA {} CASCADE").format(cls.sql.Identifier(cls.schema)))

    def _user(self, role="client", status="pending"):
        with self.connect() as db:
            user = db.execute(
                "INSERT INTO users(name,email,password_hash,role) VALUES ('Voucher Test',%s,'unused',%s) RETURNING id",
                (uuid.uuid4().hex + "@voucher.test", role),
            ).fetchone()["id"]
            db.execute("INSERT INTO user_access(user_id,status,plan) VALUES (%s,%s,'custom')", (user, status))
        return user

    def _batch(self, quantity=1, plan="basic", duration=30):
        return vouchers.create_voucher_batch(self._user(role="admin"), plan, quantity, duration)

    def test_snapshot_activation_and_single_account_use(self):
        batch = self._batch()
        before = batch["batch"]
        vouchers.update_tariff("basic", {"checks_limit": before["checks_limit"] + 2, "brands_limit": before["brands_limit"] + 1})
        try:
            later = self._batch()
            self.assertEqual(later["batch"]["checks_limit"], before["checks_limit"] + 2)
            user = self._user()
            access = vouchers.redeem_voucher(user, batch["vouchers"][0]["code"].lower().replace("-", " "))
            self.assertEqual(access["status"], "active")
            self.assertEqual(access["checks"]["limit"], before["checks_limit"])
            self.assertEqual(access["brands"]["limit"], before["brands_limit"])
            self.assertTrue(access["voucher_redeemed"])
            self.assertFalse(access["can_redeem_voucher"])
            activated = datetime.fromisoformat(access["activated_at"])
            self.assertEqual(datetime.fromisoformat(access["expires_at"]) - activated, timedelta(days=30))
            with self.connect() as db:
                onboarding = db.execute("SELECT onboarding_completed_at FROM users WHERE id=%s", (user,)).fetchone()
            self.assertIsNone(onboarding["onboarding_completed_at"])
            for candidate, expected in ((self._user(), "voucher_invalid"), (user, "voucher_not_allowed")):
                with self.assertRaises(storage.AccessControlError) as caught:
                    vouchers.redeem_voucher(candidate, batch["vouchers"][0]["code"])
                self.assertEqual(caught.exception.payload["code"], expected)
            self.assertNotIn("code", vouchers.get_voucher_batch(before["id"])["vouchers"][0])
        finally:
            vouchers.update_tariff("basic", {"checks_limit": before["checks_limit"], "brands_limit": before["brands_limit"]})

    def test_ineligible_accounts_and_durable_manual_activation(self):
        code = self._batch()["vouchers"][0]["code"]
        for role, status in (("admin", "pending"), ("client", "active"), ("client", "suspended")):
            with self.assertRaises(storage.AccessControlError) as caught:
                vouchers.redeem_voucher(self._user(role, status), code)
            self.assertEqual(caught.exception.payload["code"], "voucher_not_allowed")
        user = self._user()
        self.assertTrue(storage.get_access(user)["can_redeem_voucher"])
        storage.update_admin_access(user, {"status": "active"})
        storage.update_admin_access(user, {"status": "pending"})
        self.assertFalse(storage.get_access(user)["can_redeem_voucher"])
        with self.assertRaises(storage.AccessControlError):
            vouchers.redeem_voucher(user, code)

    def test_revocation_and_deleted_recipient_cannot_reuse_code(self):
        batch = self._batch(quantity=2)
        first, second = batch["vouchers"]
        vouchers.revoke_voucher(first["id"])
        with self.assertRaises(storage.AccessControlError):
            vouchers.redeem_voucher(self._user(), first["code"])
        user = self._user()
        vouchers.redeem_voucher(user, second["code"])
        with self.assertRaises(storage.AccessControlError):
            vouchers.revoke_voucher(second["id"])
        with self.connect() as db:
            db.execute("DELETE FROM users WHERE id=%s", (user,))
        saved = vouchers.get_voucher_batch(batch["batch"]["id"])["vouchers"][1]
        self.assertEqual(saved["status"], "redeemed")
        self.assertIsNone(saved["redeemed_by"])
        with self.assertRaises(storage.AccessControlError):
            vouchers.redeem_voucher(self._user(), second["code"])

    def test_both_redemption_races(self):
        for same_user in (False, True):
            batch = self._batch(quantity=2 if same_user else 1)
            users = [self._user()]
            users.append(users[0] if same_user else self._user())
            codes = [batch["vouchers"][0]["code"], batch["vouchers"][-1]["code"]]
            barrier = threading.Barrier(2)

            def redeem(index):
                barrier.wait(timeout=5)
                try:
                    vouchers.redeem_voucher(users[index], codes[index])
                    return "success"
                except storage.AccessControlError as error:
                    return error.payload["code"]

            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(redeem, range(2)))
            self.assertEqual(results.count("success"), 1)
            self.assertIn("voucher_not_allowed" if same_user else "voucher_invalid", results)
            current = vouchers.get_voucher_batch(batch["batch"]["id"])["batch"]
            self.assertEqual(current["redeemed_count"], 1)

    def test_transaction_rolls_back_if_access_payload_fails(self):
        batch = self._batch()
        user = self._user()
        with patch.object(vouchers, "_access_payload", side_effect=RuntimeError("injected failure")):
            with self.assertRaises(RuntimeError):
                vouchers.redeem_voucher(user, batch["vouchers"][0]["code"])
        self.assertEqual(storage.get_access(user)["status"], "pending")
        self.assertFalse(storage.get_access(user)["voucher_redeemed"])
        self.assertEqual(vouchers.get_voucher_batch(batch["batch"]["id"])["vouchers"][0]["status"], "available")

    def test_voucher_access_keeps_existing_quota_refund_and_expiry_rules(self):
        batch = self._batch(plan="pro", duration=90)
        user = self._user()
        vouchers.redeem_voucher(user, batch["vouchers"][0]["code"])
        check = storage.start_check(user, "Voucher Brand", "voucher-brand", "Query", "all")
        self.assertEqual(storage.get_access(user)["checks"]["used"], 1)
        storage.finish_check(user, check["id"], "failed", error={"error": "provider_failed"})
        self.assertEqual(storage.get_access(user)["checks"]["used"], 0)
        check = storage.start_check(user, "Voucher Brand", "voucher-brand", "Query", "all")
        storage.finish_check(user, check["id"], "completed", result={"partial_error": True})
        self.assertEqual(storage.get_access(user)["checks"]["used"], 1)
        with self.connect() as db:
            db.execute("UPDATE user_access SET activated_at=NOW()-INTERVAL '32 days', period_end=NOW()-INTERVAL '1 day' WHERE user_id=%s", (user,))
        refreshed = storage.get_access(user)
        self.assertEqual(refreshed["checks"]["used"], 0)
        self.assertFalse(refreshed["can_redeem_voucher"])
        self.assertTrue(refreshed["voucher_redeemed"])
        storage.update_admin_access(user, {"expires_at": datetime.now(timezone.utc) - timedelta(seconds=1)})
        self.assertEqual(storage.get_access(user)["status"], "expired")
        with self.assertRaises(storage.AccessControlError) as caught:
            storage.start_check(user, "Voucher Brand", "voucher-brand", "Query", "all")
        self.assertEqual(caught.exception.payload["code"], "access_expired")
        self.assertEqual(len(storage.list_checks(user)), 2)

    def test_migration_rerun_preserves_tariffs_and_vouchers(self):
        batch = self._batch()
        before = vouchers.list_tariffs()
        database.initialize_database()
        self.assertEqual(vouchers.list_tariffs(), before)
        self.assertEqual(vouchers.get_voucher_batch(batch["batch"]["id"])["batch"]["available_count"], 1)


if __name__ == "__main__":
    unittest.main()
