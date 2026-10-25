import asyncio
import ipaddress
import os
import socket
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import HTTPException


@dataclass(frozen=True)
class SecuritySettings:
    mode: str
    allowed_origins: tuple[str, ...]
    trusted_proxy_service: str

    @property
    def production(self):
        return self.mode == "production"

    @classmethod
    def from_environment(cls, environ=None):
        values = os.environ if environ is None else environ
        mode = values.get("APP_ENV", "production").strip().lower()
        if mode not in {"production", "development"}:
            raise ValueError("APP_ENV must be production or development")
        if mode == "development":
            origins = tuple(
                f"http://{host}{port}"
                for host in ("localhost", "127.0.0.1")
                for port in ("", ":80", ":5500", ":8000")
            )
        else:
            origins = tuple(dict.fromkeys(
                item.strip() for item in values.get("CORS_ORIGINS", "https://vidno.one").split(",") if item.strip()
            ))
            for origin in origins:
                parsed = urlsplit(origin)
                if (
                    origin == "null" or "*" in origin or parsed.scheme != "https"
                    or not parsed.hostname or parsed.username or parsed.password
                    or parsed.path or parsed.query or parsed.fragment
                ):
                    raise ValueError("CORS_ORIGINS must contain explicit HTTPS origins")
                try:
                    parsed.port
                except ValueError as exc:
                    raise ValueError("Invalid origin port") from exc
        return cls(mode, origins, values.get("AUTH_TRUSTED_PROXY_SERVICE", "frontend").strip())

    def set_session_cookie(self, response, token):
        response.set_cookie(
            "vidno_session", token, max_age=30 * 24 * 60 * 60,
            httponly=True, samesite="lax", secure=self.production, path="/",
        )

    def delete_session_cookie(self, response):
        response.delete_cookie(
            "vidno_session", path="/", secure=self.production, httponly=True, samesite="lax",
        )


def _ip(value):
    if "%" in value:
        raise ValueError("Scoped IP addresses are not supported")
    address = ipaddress.ip_address(value)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return str(address)


class TrustedProxyResolver:
    def __init__(self, settings):
        self.settings = settings
        self._addresses = frozenset()
        self._expires = 0.0
        self._retry_at = 0.0
        self._task = None

    async def _lookup(self):
        try:
            records = await asyncio.get_running_loop().getaddrinfo(
                self.settings.trusted_proxy_service, None, type=socket.SOCK_STREAM,
            )
            addresses = frozenset(_ip(record[4][0]) for record in records)
            if not addresses:
                raise OSError("Proxy DNS has no addresses")
            self._addresses = addresses
            self._expires = time.monotonic() + 5
            self._retry_at = 0.0
            return True
        except (OSError, ValueError):
            self._expires = 0.0
            self._retry_at = time.monotonic() + 5
            return False

    async def client_ip(self, request):
        try:
            peer = _ip(request.client.host)
        except (ValueError, AttributeError):
            raise HTTPException(503, "Client address unavailable") from None
        if not self.settings.production:
            return peer
        now = time.monotonic()
        if now >= self._expires:
            if self._task is None or self._task.done():
                if now < self._retry_at:
                    raise HTTPException(503, "Trusted proxy temporarily unavailable")
                self._task = asyncio.create_task(self._lookup())
            try:
                success = await asyncio.wait_for(asyncio.shield(self._task), timeout=1)
            except asyncio.TimeoutError:
                raise HTTPException(503, "Trusted proxy temporarily unavailable") from None
            if not success:
                raise HTTPException(503, "Trusted proxy temporarily unavailable")
        if peer not in self._addresses:
            return peer
        values = request.headers.getlist("x-real-ip")
        if len(values) != 1:
            raise HTTPException(503, "Trusted proxy client address unavailable")
        try:
            return _ip(values[0])
        except ValueError:
            raise HTTPException(503, "Trusted proxy client address unavailable") from None
