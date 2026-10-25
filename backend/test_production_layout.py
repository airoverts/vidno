import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class ProductionLayoutTests(unittest.TestCase):
    def test_explicit_image_modules_start_without_frontend(self):
        backend = Path(__file__).parent
        dockerfile = (backend / "Dockerfile").read_text(encoding="utf-8")
        self.assertNotIn("COPY . .", dockerfile)
        self.assertIn('"--no-proxy-headers"', dockerfile)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for line in dockerfile.splitlines():
                if line.startswith("COPY ") and "main.py" in line:
                    for name in line.split()[1:-1]:
                        self.assertTrue(name.endswith(".py"))
                        shutil.copyfile(backend / name, root / name)
            self.assertTrue((root / "admin_cli.py").exists())
            self.assertFalse((root / "index.html").exists())
            program = """
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
with patch('dotenv.load_dotenv'):
    import main
from fastapi.testclient import TestClient
assert main.security_settings.production
with patch.object(main, 'initialize_cache'), patch.object(main, 'initialize_auth'):
    with TestClient(main.app) as client:
        assert client.get('/').status_code == 404
        assert client.get('/js/auth.js').status_code == 404
        assert client.get('/api/health').status_code == 200
"""
            environment = dict(os.environ, APP_ENV="production", CORS_ORIGINS="https://vidno.one")
            result = subprocess.run([sys.executable, "-I", "-c", program, str(root)], cwd=folder, env=environment, capture_output=True, text=True, timeout=45)
            self.assertEqual(result.returncode, 0, result.stderr)
