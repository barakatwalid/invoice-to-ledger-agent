import json
import os
import unittest
from unittest.mock import patch

from function.func import Function
from function.renderer import RenderError, RenderedPage, encode_render_response


async def request(function, method, path, *, headers=None, body=b""):
    messages = [{"type": "http.request", "body": body, "more_body": False}]
    sent = []

    async def receive():
        return messages.pop(0)

    async def send(message):
        sent.append(message)

    await function.handle({
        "type": "http",
        "method": method,
        "path": path,
        "headers": headers or [],
    }, receive, send)
    status = sent[0]["status"]
    response_body = sent[1]["body"]
    return status, json.loads(response_body)


class RendererHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_is_safe_and_public(self):
        status, body = await request(Function(), "GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["service"], "bookkeeping-pdf-renderer")
        self.assertNotIn("token", json.dumps(body).lower())

    async def test_render_requires_exact_bearer_token(self):
        with patch.dict(os.environ, {"BOOKKEEPING_PDF_RENDERER_TOKEN": "x" * 48}, clear=False):
            status, body = await request(Function(), "POST", "/render", headers=[
                (b"content-type", b"application/pdf"),
            ], body=b"%PDF-1.7")
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "unauthorized"})

    async def test_render_returns_only_validated_page_payload(self):
        page = RenderedPage(1, 2, 3, b"\xff\xd8\xff\x00\xff\xd9")
        with patch.dict(os.environ, {"BOOKKEEPING_PDF_RENDERER_TOKEN": "x" * 48}, clear=False):
            status, body = await request(Function(lambda _body: [page]), "POST", "/render", headers=[
                (b"authorization", b"Bearer " + b"x" * 48),
                (b"content-type", b"application/pdf"),
                (b"content-length", b"8"),
            ], body=b"%PDF-1.7")
        self.assertEqual(status, 200)
        self.assertEqual(body["schemaVersion"], "pdf_page_render_v1")
        self.assertEqual(body["pages"][0]["page"], 1)
        self.assertEqual(body["pages"][0]["contentType"], "image/jpeg")

    async def test_oversized_declared_input_fails_before_rendering(self):
        with patch.dict(os.environ, {"BOOKKEEPING_PDF_RENDERER_TOKEN": "x" * 48}, clear=False):
            status, body = await request(Function(lambda _body: self.fail("renderer called")), "POST", "/render", headers=[
                (b"authorization", b"Bearer " + b"x" * 48),
                (b"content-type", b"application/pdf"),
                (b"content-length", b"5000001"),
            ])
        self.assertEqual(status, 413)
        self.assertEqual(body, {"error": "pdf_request_too_large"})

    def test_response_cap_is_enforced_after_base64_encoding(self):
        pages = [RenderedPage(index + 1, 100, 100, b"x" * 1_000_000) for index in range(7)]
        with self.assertRaisesRegex(RenderError, "render_response_too_large"):
            encode_render_response(pages)


if __name__ == "__main__":
    unittest.main()
