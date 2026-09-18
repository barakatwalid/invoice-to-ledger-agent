import { WorkflowError } from './errors.ts';

export interface AttachmentMetadata {
  url: string;
  filename: string;
  contentType: string;
  declaredSize: number | null;
  declaredSha256: string | null;
}

export const SUPPORTED_INVOICE_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
] as const;

export type SupportedInvoiceContentType = typeof SUPPORTED_INVOICE_CONTENT_TYPES[number];

export interface DownloadedAttachment {
  bytes: Uint8Array;
  sha256: string;
  sizeBytes: number;
}

export interface AttachmentDownloadOptions {
  allowedHosts: ReadonlySet<string>;
  fetcher?: typeof fetch;
  maxBytes?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':') || (hostname.startsWith('[') && hostname.endsWith(']'))) return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function parseAttachmentMetadata(input: unknown): AttachmentMetadata {
  if (!record(input) || typeof input.url !== 'string') {
    throw new WorkflowError('unsupported_attachment_shape');
  }
  let filename: unknown = input.filename;
  let contentType: unknown = input.content_type;
  if (record(input.content_type)) {
    contentType = input.content_type.content_type;
    const contentTypeParams = input.content_type.params;
    const disposition = input.content_disposition;
    const dispositionParams = record(disposition) ? disposition.params : null;
    const dispositionFilename = record(dispositionParams) ? dispositionParams.filename : undefined;
    const contentTypeFilename = record(contentTypeParams) ? contentTypeParams.name : undefined;
    if (typeof dispositionFilename === 'string' && typeof contentTypeFilename === 'string' &&
        dispositionFilename !== contentTypeFilename) {
      throw new WorkflowError('unsupported_attachment_shape');
    }
    filename = dispositionFilename ?? contentTypeFilename;
  }
  if (typeof filename !== 'string' || typeof contentType !== 'string') {
    throw new WorkflowError('unsupported_attachment_shape');
  }
  // MIME media types are case-insensitive. Normalize the provider value before
  // the allowlist check and before returning it to the document router.
  const normalizedContentType = contentType.trim().toLowerCase();
  const declaredSize = input.size_bytes === null || input.size_bytes === undefined ? null : input.size_bytes;
  const declaredSha256 = input.sha256 === null || input.sha256 === undefined ? null : input.sha256;
  if (!(declaredSize === null || (Number.isSafeInteger(declaredSize) && (declaredSize as number) >= 0)) ||
      !(declaredSha256 === null || (typeof declaredSha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(declaredSha256)))) {
    throw new WorkflowError('unsupported_attachment_shape');
  }
  if (!filename.trim() || filename.length > 255 ||
      !SUPPORTED_INVOICE_CONTENT_TYPES.includes(normalizedContentType as SupportedInvoiceContentType)) {
    throw new WorkflowError('unsupported_attachment_type');
  }
  return {
    url: input.url,
    filename,
    contentType: normalizedContentType,
    declaredSize: declaredSize as number | null,
    declaredSha256: declaredSha256 === null ? null : declaredSha256.toLowerCase(),
  };
}

export function parseAllowedAttachmentHosts(value: string): ReadonlySet<string> {
  const hosts = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length || hosts.some(host => isIpLiteral(host) ||
      !/^(?=.{1,253}$)(?!-)(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(host))) {
    throw new WorkflowError('invalid_attachment_host_allowlist');
  }
  return new Set(hosts);
}

function parseRestrictedAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkflowError('invalid_attachment_url');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      isIpLiteral(hostname) || parseAllowedAttachmentHosts(hostname).size !== 1) {
    throw new WorkflowError('invalid_attachment_url');
  }
  return url;
}

/** Safe discovery value for an operator-managed allowlist; never returns a path or query. */
export function attachmentHostname(attachment: AttachmentMetadata): string {
  return parseRestrictedAttachmentUrl(attachment.url).hostname.toLowerCase();
}

export async function downloadAttachment(
  attachment: AttachmentMetadata,
  options: AttachmentDownloadOptions,
): Promise<DownloadedAttachment> {
  const url = parseRestrictedAttachmentUrl(attachment.url);
  if (!options.allowedHosts.has(url.hostname.toLowerCase())) {
    throw new WorkflowError('attachment_host_not_allowed');
  }
  const maxBytes = options.maxBytes ?? 5_000_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20_000_000) {
    throw new WorkflowError('invalid_attachment_size_limit');
  }
  if (attachment.declaredSize !== null && attachment.declaredSize > maxBytes) {
    throw new WorkflowError('attachment_too_large');
  }
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    // Attachment URLs are fetched without Telnyx API authorization. Never forward the bearer token.
    response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new WorkflowError('attachment_network_error', true);
  }
  if (!response.ok) throw new WorkflowError(`attachment_http_${response.status}`, response.status >= 500);
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new WorkflowError('attachment_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowError('attachment_empty_body', true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new WorkflowError('attachment_too_large');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('attachment_stream_error', true);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (attachment.declaredSize !== null && attachment.declaredSize !== size) {
    throw new WorkflowError('attachment_size_mismatch');
  }
  const sha256 = await sha256Hex(bytes);
  if (attachment.declaredSha256 !== null && attachment.declaredSha256 !== sha256) {
    throw new WorkflowError('attachment_hash_mismatch');
  }
  return { bytes, sha256, sizeBytes: size };
}
