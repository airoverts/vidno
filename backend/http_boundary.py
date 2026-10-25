from pathlib import Path

from starlette.responses import FileResponse, JSONResponse, Response
from starlette.requests import cookie_parser


MAX_BODY_BYTES = 2 * 1024 * 1024


class ApiBoundary:
    def __init__(self, app, allowed_origins, max_body_bytes=MAX_BODY_BYTES):
        self.app = app
        self.allowed_origins = frozenset(allowed_origins)
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not (scope["path"] == "/api" or scope["path"].startswith("/api/")):
            return await self.app(scope, receive, send)
        headers = scope.get("headers", [])
        origins = [value.decode("latin-1") for key, value in headers if key.lower() == b"origin"]
        cookies = any(key.lower() == b"cookie" and "vidno_session" in cookie_parser(value.decode("latin-1")) for key, value in headers)
        if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"} and cookies and origins:
            if len(origins) != 1 or origins[0] not in self.allowed_origins:
                return await JSONResponse({"detail": "Origin не разрешён"}, status_code=403)(scope, receive, send)
        lengths = [value for key, value in headers if key.lower() == b"content-length"]
        try:
            if len(lengths) > 1 or (lengths and (int(lengths[0]) < 0 or int(lengths[0]) > self.max_body_bytes)):
                return await JSONResponse({"detail": "Тело запроса слишком большое"}, status_code=413)(scope, receive, send)
        except ValueError:
            return await JSONResponse({"detail": "Некорректный Content-Length"}, status_code=400)(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.max_body_bytes:
                return await JSONResponse({"detail": "Тело запроса слишком большое"}, status_code=413)(scope, receive, send)
            body.extend(chunk)
            if not message.get("more_body", False):
                break
        iterator = iter([{"type": "http.request", "body": bytes(body), "more_body": False}])

        async def replay():
            return next(iterator, {"type": "http.disconnect"})

        await self.app(scope, replay, send)


class DevelopmentFrontend:
    def __init__(self, root):
        self.root = Path(root).resolve()

    async def __call__(self, scope, receive, send):
        path = scope["path"]
        parts = Path(path.lstrip("/")).parts
        if path == "/":
            parts = ("index.html",)
        allowed = parts in {("index.html",), ("dashboard.html",)} or (len(parts) > 1 and parts[0] in {"assets", "css", "js", "legal"})
        if scope["method"] not in {"GET", "HEAD"} or not allowed or any(part.startswith(".") or ":" in part or "\\" in part for part in parts):
            return await Response(status_code=404)(scope, receive, send)
        try:
            target = self.root.joinpath(*parts).resolve(strict=True)
            boundary = self.root if len(parts) == 1 else self.root / parts[0]
            target.relative_to(boundary)
            resolved_parts = target.relative_to(self.root).parts
            if any(part.startswith(".") for part in resolved_parts) or (len(parts) == 1 and target != self.root / parts[0]) or not target.is_file():
                raise ValueError()
        except (OSError, ValueError, RuntimeError):
            return await Response(status_code=404)(scope, receive, send)
        await FileResponse(target)(scope, receive, send)
