# Bookkeeping PDF renderer

Companion Telnyx Edge conventional function for scanned/image-only PDF support.

- `GET /health` is public and contains no private data.
- `POST /render` requires `Authorization: Bearer …` and `Content-Type: application/pdf`.
- Input is capped at 5 MB and 10 pages.
- Each page is rasterized by PDFium to a bounded JPEG; total binary output is capped at 6 MB.
- It performs no OCR, inference, accounting, persistence, or logging of document content.

The shared token is the account secret `BOOKKEEPING_PDF_RENDERER_TOKEN`; it is never stored in
this directory. The calling actor validates the renderer hostname and every returned image.
