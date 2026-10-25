import argparse
import ipaddress
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", default="")
    parser.add_argument("--pattern", default="test*.py")
    args = parser.parse_args()
    if args.database_url:
        from psycopg.conninfo import conninfo_to_dict
        info = conninfo_to_dict(args.database_url)
        if "test" not in info.get("dbname", "").lower() or info.get("host") not in {"127.0.0.1", "localhost", "::1"}:
            parser.error("Only an explicit local test database is allowed")
    safe_environment = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH") if key in os.environ}
    safe_environment.update(APP_ENV="development", APPDATA=tempfile.gettempdir(), TEMP=tempfile.gettempdir(), TMP=tempfile.gettempdir(), TEST_DATABASE_URL=args.database_url)
    original_connect = socket.socket.connect

    def local_connect(sock, address):
        if isinstance(address, tuple):
            try:
                local = address[0] == "localhost" or ipaddress.ip_address(address[0]).is_loopback
            except ValueError:
                local = False
            if not local:
                raise OSError("External network disabled in security tests")
        return original_connect(sock, address)

    with patch.dict(os.environ, safe_environment, clear=True), patch("dotenv.load_dotenv"), patch.object(socket.socket, "connect", local_connect):
        suite = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern=args.pattern)
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
