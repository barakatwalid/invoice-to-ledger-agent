import type { SupportedInvoiceContentType } from './attachment.ts';
import type { PdfTextPage } from './extraction.ts';
import { errorCode } from './errors.ts';
import { extractPdfText } from './pdf-text.ts';
import { prepareVisualPages, type VisualPage } from './visual-document.ts';

export type InvoiceDocumentPath = 'embedded_text' | 'telnyx_vision';

export interface InvoiceDocumentRead {
  pages: PdfTextPage[];
  path: InvoiceDocumentPath;
  visualModel: {
    configuredModelId: string;
    responseModelId: string | null;
    provider: 'telnyx_inference';
  } | null;
}

export interface VisualInvoiceTranscription {
  pages: PdfTextPage[];
  configuredModelId: string;
  responseModelId: string | null;
  provider: 'telnyx_inference';
}

export interface InvoiceDocumentDependencies {
  extractText?: (bytes: Uint8Array) => Promise<PdfTextPage[]>;
  prepareVisual?: (
    bytes: Uint8Array,
    contentType: SupportedInvoiceContentType,
  ) => Promise<VisualPage[]>;
  transcribeVisual: (pages: readonly VisualPage[]) => Promise<VisualInvoiceTranscription>;
}

/**
 * Prefer deterministic embedded-text extraction. Only an image input or a PDF with no
 * extractable text is rendered/transcribed by the configured Telnyx vision model.
 */
export async function readInvoiceDocument(
  bytes: Uint8Array,
  contentType: SupportedInvoiceContentType,
  dependencies: InvoiceDocumentDependencies,
): Promise<InvoiceDocumentRead> {
  if (contentType === 'application/pdf') {
    try {
      const pages = await (dependencies.extractText ?? extractPdfText)(bytes);
      return { pages, path: 'embedded_text', visualModel: null };
    } catch (error) {
      if (errorCode(error) !== 'pdf_has_no_extractable_text') throw error;
    }
  }

  const visualPages = await (dependencies.prepareVisual ?? prepareVisualPages)(bytes, contentType);
  const transcription = await dependencies.transcribeVisual(visualPages);
  return {
    pages: transcription.pages,
    path: 'telnyx_vision',
    visualModel: {
      configuredModelId: transcription.configuredModelId,
      responseModelId: transcription.responseModelId,
      provider: transcription.provider,
    },
  };
}
