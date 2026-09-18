import type { SupportedInvoiceContentType } from '../attachment.ts';
import { WorkflowError } from '../errors.ts';
import { validateVisualInputBytes, type VisualPage } from '../visual-document.ts';

export interface EdgePdfRendererConfig {
  baseUrl: string;
  token: string;
}

type Fetcher = typeof fetch;

const MAX_RESPONSE_BYTES = 9_000_000;
const MAX_TOTAL_RENDERED_BYTES = 6_000_000;
const MAX_RENDERED_PAGES = 10;
const MAX_RENDERED_SIDE = 1_800;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

export function validateEdgePdfRendererConfig(input: unknown): EdgePdfRendererConfig {
  if (!record(input) || !exactKeys(input, ['baseUrl', 'token']) ||
      typeof input.baseUrl !== 'string' || typeof input.token !== 'string' ||
      input.token.length < 32 || input.token.length > 512 || /\s/.test(input.token)) {
    throw new WorkflowError('invalid_edge_pdf_renderer_config');
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new WorkflowError('invalid_edge_pdf_renderer_config');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9-]+\.telnyxcompute\.com$/.test(url.hostname)) {
    throw new WorkflowError('invalid_edge_pdf_renderer_config');
  }
  return { baseUrl: url.origin, token: input.token };
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new WorkflowError('pdf_renderer_invalid_response');
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== value) {
    throw new WorkflowError('pdf_renderer_invalid_response');
  }
  return bytes;
}

export function validatePdfRendererResponse(input: unknown): VisualPage[] {
  if (!record(input) || !exactKeys(input, ['schemaVersion', 'pages']) ||
      input.schemaVersion !== 'pdf_page_render_v1' || !Array.isArray(input.pages) ||
      input.pages.length < 1 || input.pages.length > MAX_RENDERED_PAGES) {
    throw new WorkflowError('pdf_renderer_invalid_response');
  }
  let totalBytes = 0;
  return input.pages.map((page, index) => {
    if (!record(page) || !exactKeys(page, ['page', 'contentType', 'width', 'height', 'base64']) ||
        page.page !== index + 1 || page.contentType !== 'image/jpeg' ||
        !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height) ||
        (page.width as number) < 1 || (page.height as number) < 1 ||
        (page.width as number) > MAX_RENDERED_SIDE || (page.height as number) > MAX_RENDERED_SIDE ||
        typeof page.base64 !== 'string') {
      throw new WorkflowError('pdf_renderer_invalid_response');
    }
    const bytes = decodeBase64(page.base64);
    validateVisualInputBytes(bytes, 'image/jpeg');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_RENDERED_BYTES) throw new WorkflowError('visual_model_input_too_large');
    return { page: index + 1, contentType: 'image/jpeg' as const, bytes };
  });
}

function providerStatusCode(status: number): string {
  if (status === 401 || status === 403) return 'pdf_renderer_auth_failed';
  if (status === 413) return 'visual_model_input_too_large';
  if (status === 415 || status === 422) return 'pdf_renderer_rejected_document';
  if (status === 429 || status >= 500) return 'pdf_renderer_temporarily_unavailable';
  return 'pdf_renderer_http_error';
}

export async function renderPdfWithEdgeService(
  bytes: Uint8Array,
  configuration: EdgePdfRendererConfig,
  fetcher: Fetcher = fetch,
): Promise<VisualPage[]> {
  validateVisualInputBytes(bytes, 'application/pdf');
  const config = validateEdgePdfRendererConfig(configuration);
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}/render`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/pdf',
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(50_000),
    });
  } catch {
    throw new WorkflowError('pdf_renderer_connection_failed', true);
  }
  if (!response.ok) {
    throw new WorkflowError(providerStatusCode(response.status), response.status === 429 || response.status >= 500);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new WorkflowError('pdf_renderer_invalid_response');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new WorkflowError('pdf_renderer_invalid_response');
    }
  }
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  if (responseBytes.byteLength < 2 || responseBytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new WorkflowError('pdf_renderer_invalid_response');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(responseBytes)) as unknown;
  } catch {
    throw new WorkflowError('pdf_renderer_invalid_response');
  }
  return validatePdfRendererResponse(parsed);
}

/** Direct JPEG/PNG invoices do not need the PDF companion service. */
export async function prepareEdgeVisualPages(
  bytes: Uint8Array,
  contentType: SupportedInvoiceContentType,
  configuration?: EdgePdfRendererConfig,
  fetcher: Fetcher = fetch,
): Promise<VisualPage[]> {
  validateVisualInputBytes(bytes, contentType);
  if (contentType === 'application/pdf') {
    if (configuration === undefined) throw new WorkflowError('pdf_renderer_not_configured');
    return renderPdfWithEdgeService(bytes, configuration, fetcher);
  }
  return [{ page: 1, contentType, bytes: new Uint8Array(bytes) }];
}

export async function checkEdgePdfRendererHealth(
  configuration: EdgePdfRendererConfig,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const config = validateEdgePdfRendererConfig(configuration);
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}/health`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new WorkflowError('pdf_renderer_connection_failed', true);
  }
  if (!response.ok) throw new WorkflowError(providerStatusCode(response.status), response.status >= 500);
  const value = await response.json() as unknown;
  if (!record(value) || value.status !== 'ready' || value.service !== 'bookkeeping-pdf-renderer' ||
      value.engine !== 'pdfium') {
    throw new WorkflowError('pdf_renderer_invalid_response');
  }
}
