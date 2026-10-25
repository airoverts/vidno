import tempfile
import unittest
import subprocess
from unittest.mock import patch
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from http_boundary import ApiBoundary, DevelopmentFrontend, MAX_BODY_BYTES


class HttpBoundaryTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_middleware(ApiBoundary, allowed_origins=["https://vidno.one"])
        self.calls = []

        @app.post("/api/test")
        async def echo(request: Request):
            self.calls.append(True)
            return {"length": len(await request.body())}

        self.client = TestClient(app)

    def test_exact_limit_and_streamed_overflow(self):
        response = self.client.post("/api/test", content=b"a" * MAX_BODY_BYTES)
        self.assertEqual(response.status_code, 200)
        self.calls.clear()
        chunks = (b"a" * 1024 for _ in range(2049))
        self.assertEqual(self.client.post("/api/test", content=chunks).status_code, 413)
        self.assertEqual(self.calls, [])

    def test_origin_checks_cookie_mutations_only(self):
        self.client.cookies.set("vidno_session", "synthetic")
        for origin in ("null", "https://foreign.example", "*"):
            self.assertEqual(self.client.post("/api/test", headers={"Origin": origin}).status_code, 403)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.post("/api/test").status_code, 200)
        self.assertEqual(self.client.post("/api/test", headers={"Origin": "https://vidno.one"}).status_code, 200)
        self.assertEqual(self.client.post("/api/test", headers={"Origin": "https://foreign.example", "Cookie": "vidno_session = synthetic"}).status_code, 403)


class PublicFilesTests(unittest.TestCase):
    def test_public_allowlist_and_closed_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for relative in ("index.html", "dashboard.html", "css/style.css", "js/app.js", "assets/icon.svg", "legal/privacy.html", "backend/private.py", "css/.private"):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("synthetic", encoding="utf-8")
            client = TestClient(DevelopmentFrontend(root))
            for path in ("/", "/index.html", "/dashboard.html", "/css/style.css", "/js/app.js", "/assets/icon.svg", "/legal/privacy.html"):
                self.assertEqual(client.get(path).status_code, 200, path)
            for path in ("/backend/private.py", "/AGENTS.md", "/css/.private", "/css/%2e%2e/backend/private.py", "/assets/", "/js/app.js:stream"):
                self.assertEqual(client.get(path).status_code, 404, path)

    def test_external_symlink_is_not_served(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
            root = Path(folder)
            (root / "assets").mkdir()
            target = Path(outside) / "public.txt"
            target.write_text("synthetic", encoding="utf-8")
            try:
                (root / "assets" / "linked.txt").symlink_to(target)
            except OSError:
                linked = root / "assets" / "linked"
                subprocess.run(["cmd", "/c", "mklink", "/J", str(linked), str(outside)], check=True, capture_output=True)
                path = "/assets/linked/public.txt"
            else:
                path = "/assets/linked.txt"
            self.assertEqual(TestClient(DevelopmentFrontend(root)).get(path).status_code, 404)

    def test_resolved_hidden_and_nonpublic_html_targets_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            (root / "assets").mkdir()
            hidden = root / "assets" / ".private"
            hidden.write_text("synthetic", encoding="utf-8")
            app = DevelopmentFrontend(root)
            with patch.object(Path, "resolve", return_value=hidden):
                self.assertEqual(TestClient(app).get("/assets/linked.txt").status_code, 404)
                self.assertEqual(TestClient(app).get("/index.html").status_code, 404)
