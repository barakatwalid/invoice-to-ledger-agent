"""Bounded PDF-to-JPEG rendering for the Invoice-to-Ledger Agent."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from typing import Any

import pypdfium2 as pdfium

MAX_SOURCE_BYTES = 5_000_000
MAX_PAGES = 10
MAX_PAGE_POINTS = 20_000
MAX_RENDER_SIDE = 1_800
MAX_PAGE_PIXELS = 5_000_000
MAX_PAGE_JPEG_BYTES = 1_500_000
MAX_TOTAL_JPEG_BYTES = 6_000_000
MAX_RESPONSE_BYTES = 8_500_000
JPEG_QUALITY = 82


class RenderError(Exception):
    def __init__(self, code: str, status: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class RenderedPage:
    page: int
    width: int
    height: int
    jpeg: bytes


def _validate_pdf_bytes(pdf_bytes: bytes) -> None:
    if not isinstance(pdf_bytes, bytes) or len(pdf_bytes) < 8 or len(pdf_bytes) > MAX_SOURCE_BYTES:
        raise RenderError("invalid_pdf_size", 413 if len(pdf_bytes) > MAX_SOURCE_BYTES else 422)
    if not pdf_bytes.startswith(b"%PDF-"):
        raise RenderError("invalid_pdf_signature", 415)


def _render_page(page: Any, page_number: int) -> RenderedPage:
    width_points, height_points = page.get_size()
    if not (0 < width_points <= MAX_PAGE_POINTS and 0 < height_points <= MAX_PAGE_POINTS):
        raise RenderError("unsupported_pdf_page_dimensions")
    scale = min(3.0, MAX_RENDER_SIDE / max(width_points, height_points))
    if scale <= 0:
        raise RenderError("unsupported_pdf_page_dimensions")
    bitmap = page.render(scale=scale, rev_byteorder=True, prefer_bgrx=True)
    try:
        image = bitmap.to_pil().convert("RGB")
        try:
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_PAGE_PIXELS:
                raise RenderError("unsupported_rendered_page_dimensions")
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            jpeg = output.getvalue()
        finally:
            image.close()
    finally:
        bitmap.close()
    if len(jpeg) < 4 or not jpeg.startswith(b"\xff\xd8\xff") or not jpeg.endswith(b"\xff\xd9"):
        raise RenderError("invalid_rendered_page")
    if len(jpeg) > MAX_PAGE_JPEG_BYTES:
        raise RenderError("rendered_page_too_large", 413)
    return RenderedPage(page=page_number, width=width, height=height, jpeg=jpeg)


def render_pdf(pdf_bytes: bytes) -> list[RenderedPage]:
    """Render one bounded invoice PDF. No text extraction or model call occurs here."""
    _validate_pdf_bytes(pdf_bytes)
    try:
        document = pdfium.PdfDocument(pdf_bytes)
    except Exception as error:
        raise RenderError("invalid_or_encrypted_pdf") from error
    try:
        page_count = len(document)
        if page_count < 1 or page_count > MAX_PAGES:
            raise RenderError("unsupported_pdf_page_count")
        pages: list[RenderedPage] = []
        total_bytes = 0
        for index in range(page_count):
            page = document[index]
            try:
                rendered = _render_page(page, index + 1)
            finally:
                page.close()
            total_bytes += len(rendered.jpeg)
            if total_bytes > MAX_TOTAL_JPEG_BYTES:
                raise RenderError("render_output_too_large", 413)
            pages.append(rendered)
        return pages
    except RenderError:
        raise
    except Exception as error:
        raise RenderError("pdf_render_failed") from error
    finally:
        document.close()


def encode_render_response(pages: list[RenderedPage]) -> bytes:
    import json

    payload = {
        "schemaVersion": "pdf_page_render_v1",
        "pages": [
            {
                "page": page.page,
                "contentType": "image/jpeg",
                "width": page.width,
                "height": page.height,
                "base64": base64.b64encode(page.jpeg).decode("ascii"),
            }
            for page in pages
        ],
    }
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise RenderError("render_response_too_large", 413)
    return encoded
