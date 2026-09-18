"""Telnyx conventional-function ASGI entrypoint for bounded PDF rendering."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from collections.abc import Awaitable, Callable
from typing import Any

from .renderer import MAX_PAGES, MAX_RENDER_SIDE, MAX_SOURCE_BYTES, RenderError, encode_render_response, render_pdf

Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]


def new() -> "Function":
    return Function()


class Function:
    def __init__(self, render: Callable[[bytes], Any] = render_pdf) -> None:
        self._render = render

    @staticmethod
    async def _respond(send: Send, status: int, body: bytes, content_type: bytes) -> None:
        headers = [
            (b"content-type", content_type),
            (b"content-length", str(len(body)).encode("ascii")),
            (b"cache-control", b"no-store"),
            (b"x-content-type-options", b"nosniff"),
        ]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    @classmethod
    async def _json(cls, send: Send, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        await cls._respond(send, status, body, b"application/json; charset=utf-8")

    @staticmethod
    def _authorized(headers: list[tuple[bytes, bytes]]) -> bool:
        expected = os.environ.get("BOOKKEEPING_PDF_RENDERER_TOKEN", "")
        if len(expected) < 32 or len(expected) > 512:
            raise RenderError("renderer_not_configured", 503)
        authorization = next((value for name, value in headers if name.lower() == b"authorization"), b"")
        prefix = b"Bearer "
        if not authorization.startswith(prefix):
            return False
        try:
            supplied = authorization[len(prefix):].decode("utf-8")
        except UnicodeDecodeError:
            return False
        return hmac.compare_digest(supplied, expected)

    @staticmethod
    async def _read_body(receive: Receive, headers: list[tuple[bytes, bytes]]) -> bytes:
        content_length = next((value for name, value in headers if name.lower() == b"content-length"), None)
        if content_length is not None:
            try:
                declared = int(content_length.decode("ascii"))
            except (UnicodeDecodeError, ValueError) as error:
                raise RenderError("invalid_content_length", 400) from error
            if declared < 0:
                raise RenderError("invalid_content_length", 400)
            if declared > MAX_SOURCE_BYTES:
                raise RenderError("pdf_request_too_large", 413)
        body = bytearray()
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                raise RenderError("invalid_http_request", 400)
            chunk = message.get("body", b"")
            if not isinstance(chunk, bytes):
                raise RenderError("invalid_http_request", 400)
            body.extend(chunk)
            if len(body) > MAX_SOURCE_BYTES:
                raise RenderError("pdf_request_too_large", 413)
            if not message.get("more_body", False):
                return bytes(body)

    async def handle(self, scope: dict[str, Any], receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            return
        method = str(scope.get("method", "")).upper()
        path = str(scope.get("path", ""))
        headers = scope.get("headers", [])
        if not isinstance(headers, list):
            headers = []
        if method == "GET" and path == "/health":
            await self._json(send, 200, {
                "status": "ready",
                "service": "bookkeeping-pdf-renderer",
                "engine": "pdfium",
                "maxPages": MAX_PAGES,
                "maxRenderSide": MAX_RENDER_SIDE,
            })
            return
        if method != "POST" or path != "/render":
            await self._json(send, 404, {"error": "not_found"})
            return
        try:
            if not self._authorized(headers):
                await self._json(send, 401, {"error": "unauthorized"})
                return
            content_type = next((value for name, value in headers if name.lower() == b"content-type"), b"")
            if content_type.split(b";", 1)[0].strip().lower() != b"application/pdf":
                raise RenderError("pdf_content_type_required", 415)
            body = await self._read_body(receive, headers)
            pages = await asyncio.to_thread(self._render, body)
            response = encode_render_response(pages)
            await self._respond(send, 200, response, b"application/json; charset=utf-8")
        except RenderError as error:
            await self._json(send, error.status, {"error": error.code})
        except Exception:
            await self._json(send, 500, {"error": "renderer_unexpected_error"})
