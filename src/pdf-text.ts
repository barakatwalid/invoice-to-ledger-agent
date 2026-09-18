// Telnyx Edge ships one bundled module, so PDF.js cannot dynamically load its
// sibling worker file. This side-effect registers WorkerMessageHandler on
// globalThis before the display module initializes its bounded fake worker.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfTextPage } from './extraction.ts';
import { WorkflowError } from './errors.ts';

const MAX_PDF_BYTES = 5_000_000;
const MAX_PAGES = 20;
const MAX_TEXT_CHARACTERS = 100_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextPage[]> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 || bytes.byteLength > MAX_PDF_BYTES ||
      new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new WorkflowError('unsupported_or_invalid_pdf');
  }
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    useWasm: false,
    enableXfa: false,
    stopAtErrors: true,
    // Text extraction does not render glyphs; avoid renderer-only standard-font warnings.
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > MAX_PAGES) throw new WorkflowError('unsupported_pdf_page_count');
    const pages: PdfTextPage[] = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map(item => 'str' in item && typeof item.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      characterCount += text.length;
      if (characterCount > MAX_TEXT_CHARACTERS) throw new WorkflowError('pdf_text_limit_exceeded');
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
    if (!pages.some(page => page.text.length > 0)) throw new WorkflowError('pdf_has_no_extractable_text');
    return pages;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('pdf_text_extraction_failed');
  } finally {
    await task.destroy();
  }
}
