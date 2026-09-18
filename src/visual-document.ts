import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WorkflowError } from './errors.ts';
import type { SupportedInvoiceContentType } from './attachment.ts';

export interface VisualPage {
  page: number;
  contentType: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
}

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 5_000_000;
const MAX_VISUAL_PAGES = 10;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_TOTAL_RENDERED_BYTES = 15_000_000;
const MAX_RENDER_SIDE = 2200;

function hasPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  return bytes.byteLength >= expected.length && expected.every((value, index) => bytes[index] === value);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || bytes.byteLength < 24 ||
      new TextDecoder().decode(bytes.subarray(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!hasPrefix(bytes, [0xff, 0xd8, 0xff])) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if (sof.has(marker)) {
      if (length < 7) return null;
      return {
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      };
    }
    offset += length;
  }
  return null;
}

function validateDimensions(dimensions: { width: number; height: number } | null): void {
  if (dimensions === null || !Number.isSafeInteger(dimensions.width) ||
      !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1 ||
      dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new WorkflowError('unsupported_invoice_image_dimensions');
  }
}

async function resolvePdfRenderer(): Promise<string> {
  const configured = process.env.PDFTOPPM_PATH?.trim();
  const candidates = configured ? [configured] : [
    resolve(dirname(process.execPath), '..', '..', 'bin', 'override', 'pdftoppm'),
    '/opt/homebrew/bin/pdftoppm',
    '/usr/local/bin/pdftoppm',
    '/usr/bin/pdftoppm',
  ];
  if (configured && !isAbsolute(configured)) throw new WorkflowError('invalid_pdf_renderer_path');
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next explicit, non-secret path.
    }
  }
  // Allow normal PATH resolution last; execFile will classify ENOENT safely.
  return 'pdftoppm';
}

/** Runtime preflight only. It returns a boolean and never exposes executable paths or stderr. */
export async function isPdfRendererAvailable(): Promise<boolean> {
  try {
    const renderer = await resolvePdfRenderer();
    await execFileAsync(renderer, ['-v'], { timeout: 5_000, maxBuffer: 100_000 });
    return true;
  } catch {
    return false;
  }
}

export function validateVisualInputBytes(bytes: Uint8Array, contentType: SupportedInvoiceContentType): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new WorkflowError('unsupported_or_invalid_visual_document');
  }
  if (contentType === 'application/pdf') {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw new WorkflowError('attachment_content_type_mismatch');
    }
    return;
  }
  const dimensions = contentType === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (dimensions === null) throw new WorkflowError('attachment_content_type_mismatch');
  validateDimensions(dimensions);
}

async function renderPdf(bytes: Uint8Array): Promise<VisualPage[]> {
  const directory = await mkdtemp(join(tmpdir(), 'bookkeeping-render-'));
  const inputPath = join(directory, 'invoice.pdf');
  const outputPrefix = join(directory, 'page');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes), useSystemFonts: false, useWasm: false,
    enableXfa: false, stopAtErrors: true, verbosity: 0,
  });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > MAX_VISUAL_PAGES) {
      throw new WorkflowError('unsupported_visual_pdf_page_count');
    }
    await writeFile(inputPath, bytes, { mode: 0o600, flag: 'wx' });
    try {
      const renderer = await resolvePdfRenderer();
      const bundledFontConfig = renderer === 'pdftoppm' ? null :
        resolve(dirname(renderer), '..', '..', 'native', 'poppler', 'poppler', 'etc', 'fonts', 'fonts.conf');
      let fontConfig = process.env.FONTCONFIG_FILE;
      if (!fontConfig && bundledFontConfig !== null) {
        try {
          await access(bundledFontConfig);
          fontConfig = bundledFontConfig;
        } catch {
          // A system-installed Poppler normally resolves its own font configuration.
        }
      }
      await execFileAsync(renderer, [
        '-q', '-f', '1', '-l', String(document.numPages), '-scale-to', String(MAX_RENDER_SIDE),
        '-png', '-forcenum', inputPath, outputPrefix,
      ], {
        timeout: 180_000,
        maxBuffer: 1_000_000,
        env: { ...process.env, XDG_CACHE_HOME: directory, ...(fontConfig ? { FONTCONFIG_FILE: fontConfig } : {}) },
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new WorkflowError('pdf_renderer_unavailable');
      }
      throw new WorkflowError('visual_pdf_render_failed');
    }
    const names = (await readdir(directory)).filter(name => /^page-\d+\.png$/.test(name))
      .sort((left, right) => Number(left.slice(5, -4)) - Number(right.slice(5, -4)));
    if (names.length !== document.numPages) throw new WorkflowError('visual_pdf_render_failed');
    const pages: VisualPage[] = [];
    let renderedBytes = 0;
    for (let index = 0; index < names.length; index++) {
      const rendered = new Uint8Array(await readFile(join(directory, names[index]!)));
      validateDimensions(pngDimensions(rendered));
      renderedBytes += rendered.byteLength;
      if (renderedBytes > MAX_TOTAL_RENDERED_BYTES) throw new WorkflowError('visual_model_input_too_large');
      pages.push({ page: index + 1, contentType: 'image/png', bytes: rendered });
    }
    return pages;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError('visual_pdf_render_failed');
  } finally {
    await task.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

/** Validates actual bytes, then prepares one model image per invoice page. */
export async function prepareVisualPages(
  bytes: Uint8Array,
  contentType: SupportedInvoiceContentType,
): Promise<VisualPage[]> {
  validateVisualInputBytes(bytes, contentType);
  if (contentType === 'application/pdf') return renderPdf(bytes);
  return [{ page: 1, contentType, bytes: new Uint8Array(bytes) }];
}

export function visualPageDataUrl(page: VisualPage): string {
  return `data:${page.contentType};base64,${Buffer.from(page.bytes).toString('base64')}`;
}
