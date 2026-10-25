import asyncio
import socket
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Response
from starlette.requests import Request

from security_config import SecuritySettings, TrustedProxyResolver


def request(peer="172.20.0.3", headers=()):
    return Request({"type": "http", "client": (peer, 1234), "headers": list(headers)})


class SecuritySettingsTests(unittest.TestCase):
    def test_default_and_cookie_deletion_are_secure(self):
        settings = SecuritySettings.from_environment({"COOKIE_SECURE": "false"})
        self.assertTrue(settings.production)
        for method, args in ((settings.set_session_cookie, ("synthetic-session",)), (settings.delete_session_cookie, ())):
            response = Response()
            method(response, *args)
            cookie = response.headers["set-cookie"]
            self.assertIn("Secure", cookie)
            self.assertIn("HttpOnly", cookie)
            self.assertIn("SameSite=lax", cookie)
            self.assertNotIn("Domain=", cookie)
        response = Response()
        settings.set_session_cookie(response, "synthetic-session")
        self.assertIn("Max-Age=2592000", response.headers["set-cookie"])

    def test_development_origins_and_cookie(self):
        settings = SecuritySettings.from_environment({"APP_ENV": "development", "CORS_ORIGINS": "null,*"})
        for host in ("localhost", "127.0.0.1"):
            for port in ("", ":80", ":5500", ":8000"):
                self.assertIn(f"http://{host}{port}", settings.allowed_origins)
        self.assertNotIn("null", settings.allowed_origins)
        response = Response()
        settings.set_session_cookie(response, "synthetic-session")
        self.assertNotIn("Secure", response.headers["set-cookie"])

    def test_bad_production_origins_fail_startup(self):
        for value in ("null", "*", "https://*.example.org", "http://example.org", "https://example.org/path", "https://user:pass@example.org", "https://example.org:wrong"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                SecuritySettings.from_environment({"CORS_ORIGINS": value})


class ProxyResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_development_ignores_headers_without_dns(self):
        resolver = TrustedProxyResolver(SecuritySettings.from_environment({"APP_ENV": "development"}))
        with patch.object(resolver, "_lookup", new_callable=AsyncMock) as lookup:
            result = await resolver.client_ip(request("127.0.0.1", [(b"x-real-ip", b"192.0.2.2")]))
        self.assertEqual(result, "127.0.0.1")
        lookup.assert_not_called()

    async def test_trusted_header_direct_peer_and_cache(self):
        resolver = TrustedProxyResolver(SecuritySettings.from_environment({}))
        loop = asyncio.get_running_loop()
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("172.20.0.3", 0))]
        with patch.object(loop, "getaddrinfo", new=AsyncMock(return_value=records)) as lookup:
            self.assertEqual(await resolver.client_ip(request(headers=[(b"x-real-ip", b"192.0.2.4")])), "192.0.2.4")
            self.assertEqual(await resolver.client_ip(request("192.0.2.5", [(b"x-real-ip", b"192.0.2.4")])), "192.0.2.5")
            self.assertEqual(await resolver.client_ip(request(headers=[(b"x-real-ip", b"::ffff:192.0.2.4")])), "192.0.2.4")
        self.assertEqual(lookup.await_count, 1)

    async def test_missing_duplicate_and_invalid_trusted_header_fail_closed(self):
        resolver = TrustedProxyResolver(SecuritySettings.from_environment({}))
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("172.20.0.3", 0))]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(return_value=records)):
            for headers in ([], [(b"x-real-ip", b"192.0.2.4,192.0.2.5")], [(b"x-real-ip", b"192.0.2.4"), (b"x-real-ip", b"192.0.2.5")]):
                with self.assertRaises(HTTPException) as error:
                    await resolver.client_ip(request(headers=headers))
                self.assertEqual(error.exception.status_code, 503)

    async def test_dns_failure_cooldown(self):
        resolver = TrustedProxyResolver(SecuritySettings.from_environment({}))
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(side_effect=OSError)) as lookup:
            for _ in range(2):
                with self.assertRaises(HTTPException) as error:
                    await resolver.client_ip(request())
                self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(lookup.await_count, 1)

    async def test_parallel_requests_share_dns_task(self):
        resolver = TrustedProxyResolver(SecuritySettings.from_environment({}))
        gate = asyncio.Event()

        async def lookup(*args, **kwargs):
            await gate.wait()
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("172.20.0.3", 0))]

        with patch.object(asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(side_effect=lookup)) as lookup_mock:
            tasks = [asyncio.create_task(resolver.client_ip(request(headers=[(b"x-real-ip", b"192.0.2.4")]))) for _ in range(10)]
            await asyncio.sleep(0)
            gate.set()
            self.assertEqual(await asyncio.gather(*tasks), ["192.0.2.4"] * 10)
        self.assertEqual(lookup_mock.await_count, 1)

    async def test_expired_cache_refreshes_and_failure_does_not_trust_stale_address(self):
        resolver = TrustedProxyResolver(SecuritySettings.from_environment({}))
        records = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("172.20.0.3", 0))]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(side_effect=[records, OSError])) as lookup:
            self.assertEqual(await resolver.client_ip(request(headers=[(b"x-real-ip", b"192.0.2.4")])), "192.0.2.4")
            resolver._expires = 0
            with self.assertRaises(HTTPException) as error:
                await resolver.client_ip(request(headers=[(b"x-real-ip", b"192.0.2.4")]))
            self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(lookup.await_count, 2)


if __name__ == "__main__":
    unittest.main()
