import importlib
import os
import threading
import subprocess
import sys
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import psycopg
from fastapi import HTTPException
from psycopg import sql
from psycopg.rows import dict_row

import auth_limits


class AuthLimitUnitTests(unittest.TestCase):
    def test_storage_failure_is_closed(self):
        with patch.object(auth_limits, "connection", side_effect=OSError):
            with self.assertRaises(HTTPException) as error:
                auth_limits.admit_auth_attempt("login", "192.0.2.3", "test@example.invalid")
        self.assertEqual(error.exception.status_code, 503)

    def test_keys_are_hashed_and_unambiguous(self):
        key = auth_limits._key("login-pair", "192.0.2.3", "test@example.invalid")
        self.assertEqual(len(key), 64)
        self.assertNotIn("test", key)
        self.assertNotEqual(auth_limits._key("scope", "a", "bc"), auth_limits._key("scope", "ab", "c"))


@unittest.skipUnless(os.getenv("TEST_DATABASE_URL"), "Explicit isolated TEST_DATABASE_URL required")
class AuthLimitPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.url = os.getenv("TEST_DATABASE_URL")
        parsed = psycopg.conninfo.conninfo_to_dict(cls.url)
        if "test" not in parsed.get("dbname", "").lower():
            raise unittest.SkipTest("TEST_DATABASE_URL must name a test database")
        cls.schema = "auth_limits_test_" + uuid.uuid4().hex
        with psycopg.connect(cls.url) as database:
            database.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(cls.schema)))

    @classmethod
    def tearDownClass(cls):
        with psycopg.connect(cls.url) as database:
            database.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(cls.schema)))

    @classmethod
    @contextmanager
    def connection(cls):
        with psycopg.connect(cls.url, row_factory=dict_row, options=f"-c search_path={cls.schema}") as database:
            yield database

    def setUp(self):
        with self.connection() as database:
            database.execute("DROP TABLE IF EXISTS auth_rate_limits")
            database.execute((Path(__file__).parent / "migrations" / "0005_auth_rate_limits.sql").read_text(encoding="utf-8"))
        self.patcher = patch.object(auth_limits, "connection", self.connection)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def result(self, action="login", ip="192.0.2.3", email="test@example.invalid"):
        try:
            auth_limits.admit_auth_attempt(action, ip, email)
            return 200
        except HTTPException as error:
            return error.status_code

    def test_pair_boundary_expiry_and_no_extension(self):
        for _ in range(10):
            self.assertEqual(self.result(), 200)
        with self.connection() as database:
            before = database.execute("SELECT * FROM auth_rate_limits ORDER BY key_hash").fetchall()
        with self.assertRaises(HTTPException) as error:
            auth_limits.admit_auth_attempt("login", "192.0.2.3", "TEST@example.invalid")
        self.assertEqual(error.exception.status_code, 429)
        self.assertTrue(1 <= int(error.exception.headers["Retry-After"]) <= 900)
        with self.connection() as database:
            self.assertEqual(before, database.execute("SELECT * FROM auth_rate_limits ORDER BY key_hash").fetchall())
            database.execute("UPDATE auth_rate_limits SET expires_at = clock_timestamp() - INTERVAL '1 second'")
        self.assertEqual(self.result(), 200)
        with self.connection() as database:
            self.assertEqual({row["attempts"] for row in database.execute("SELECT attempts FROM auth_rate_limits").fetchall()}, {1})

    def test_ip_aggregate_and_registration_boundary(self):
        for index in range(100):
            self.assertEqual(self.result(email=f"test{index}@example.invalid"), 200)
        self.assertEqual(self.result(email="new@example.invalid"), 429)
        self.assertEqual(self.result(ip="192.0.2.4"), 200)
        for _ in range(5):
            self.assertEqual(self.result(action="register"), 200)
        self.assertEqual(self.result(action="register"), 429)

    def test_parallel_connections_admit_exactly_ten(self):
        barrier = threading.Barrier(20)

        def attempt(_):
            barrier.wait(timeout=10)
            return self.result()

        with ThreadPoolExecutor(max_workers=20) as pool:
            results = list(pool.map(attempt, range(20)))
        self.assertEqual(results.count(200), 10)
        self.assertEqual(results.count(429), 10)
        self.assertEqual(results.count(503), 0)

    def test_reloaded_module_retains_limits(self):
        for _ in range(10):
            self.assertEqual(self.result(), 200)
        importlib.reload(auth_limits)
        with patch.object(auth_limits, "connection", self.connection):
            self.assertEqual(self.result(), 429)

    def test_new_process_retains_limits(self):
        for _ in range(10):
            self.assertEqual(self.result(), 200)
        url = psycopg.conninfo.make_conninfo(self.url, options=f"-c search_path={self.schema}")
        program = """
import sys
from contextlib import contextmanager
import psycopg
from psycopg.rows import dict_row
from fastapi import HTTPException
sys.path.insert(0, sys.argv[1])
import auth_limits
@contextmanager
def connection():
    with psycopg.connect(sys.argv[2], row_factory=dict_row) as db:
        yield db
auth_limits.connection = connection
try:
    auth_limits.admit_auth_attempt('login', '192.0.2.3', 'test@example.invalid')
except HTTPException as error:
    assert error.status_code == 429
else:
    raise AssertionError('Limit state lost across processes')
"""
        result = subprocess.run([sys.executable, "-I", "-c", program, str(Path(__file__).parent), url], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_limiter_table_returns_503(self):
        with self.connection() as database:
            database.execute("DROP TABLE auth_rate_limits")
        self.assertEqual(self.result(), 503)

    def test_cleanup_is_bounded_and_only_hashes_are_stored(self):
        with self.connection() as database:
            for index in range(250):
                database.execute(
                    "INSERT INTO auth_rate_limits VALUES (%s, 1, clock_timestamp() - INTERVAL '1 hour')",
                    (auth_limits._key("expired", str(index)),),
                )
        self.assertEqual(self.result(), 200)
        with self.connection() as database:
            expired = database.execute("SELECT count(*) AS amount FROM auth_rate_limits WHERE expires_at <= clock_timestamp()").fetchone()
            self.assertEqual(expired["amount"], 150)
            for row in database.execute("SELECT key_hash FROM auth_rate_limits").fetchall():
                self.assertRegex(row["key_hash"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
