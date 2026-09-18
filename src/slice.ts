import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DownloadedAttachment, SupportedInvoiceContentType } from './attachment.ts';
import type { BookkeepingPolicy } from './bookkeeping.ts';
import { normalizeFinancialValues, proposeAccountingEntries, reviewExtraction } from './bookkeeping.ts';
import { businessReference, checkCompleteness } from './completeness.ts';
import type { InvoiceExtraction, PdfTextPage } from './extraction.ts';
import { errorCode, WorkflowError } from './errors.ts';
import type { ClaimResult, JobStore } from './job-store.ts';
import { extractPdfText } from './pdf-text.ts';
import { writeInspectableResult } from './result.ts';

export interface SyntheticAnswerKey {
  schemaVersion: 'synthetic_invoice_answer_key_v1';
  subject: string;
  pdfSha256: string;
  expected: {
    documentType: string;
    supplierName: string;
    supplierAddress: string;
    supplierTaxRegistrationId: string;
    invoiceNumber: string;
    invoiceDate: string;
    currency: string;
    pricing: string;
    lines: Array<{ description: string; quantity: string; unitPrice: string; lineNet: string }>;
    subtotal: string;
    tax: string;
    total: string;
    complexities: string[];
  };
}

export interface SliceModelRun {
  extraction: InvoiceExtraction;
  configuredModelId: string;
  responseModelId: string | null;
  provider: 'telnyx_inference' | 'recorded_fixture_not_a_live_model';
}

export interface SliceVisualModelRun extends SliceModelRun {
  pages: PdfTextPage[];
}

export interface ProcessClaimedJobOptions {
  store: JobStore;
  claim: Extract<ClaimResult, { outcome: 'claimed' }>;
  mode: 'live_telnyx' | 'local_fixture' | 'local_pdf_live_telnyx_model';
  inboxId: string;
  messageId: string;
  receivedAt: string;
  filename: string;
  contentType?: SupportedInvoiceContentType;
  declaredSha256: string | null;
  declaredSize: number | null;
  privateDirectory: string;
  policy: BookkeepingPolicy;
  answerKey: SyntheticAnswerKey | null;
  loadAttachment: () => Promise<DownloadedAttachment>;
  extractText?: (bytes: Uint8Array) => Promise<PdfTextPage[]>;
  runModel: (pages: readonly PdfTextPage[]) => Promise<SliceModelRun>;
  runVisualModel?: (
    bytes: Uint8Array,
    contentType: SupportedInvoiceContentType,
  ) => Promise<SliceVisualModelRun>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateSyntheticAnswerKey(input: unknown): SyntheticAnswerKey {
  if (!record(input) || input.schemaVersion !== 'synthetic_invoice_answer_key_v1' ||
      typeof input.subject !== 'string' || !input.subject ||
      typeof input.pdfSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.pdfSha256) ||
      !record(input.expected) || !Array.isArray(input.expected.lines) ||
      !Array.isArray(input.expected.complexities)) {
    throw new WorkflowError('invalid_synthetic_answer_key');
  }
  const expected = input.expected;
  const complexities = expected.complexities as unknown[];
  const lines = expected.lines as unknown[];
  const scalarKeys = [
    'documentType', 'supplierName', 'supplierAddress', 'supplierTaxRegistrationId',
    'invoiceNumber', 'invoiceDate', 'currency',
    'pricing', 'subtotal', 'tax', 'total',
  ] as const;
  if (!scalarKeys.every(key => typeof expected[key] === 'string') ||
      !complexities.every(item => typeof item === 'string') ||
      !lines.every(line => record(line) &&
        ['description', 'quantity', 'unitPrice', 'lineNet'].every(key => typeof line[key] === 'string'))) {
    throw new WorkflowError('invalid_synthetic_answer_key');
  }
  return input as unknown as SyntheticAnswerKey;
}

export function jobIdentity(sourceKey: string): string {
  if (!sourceKey || sourceKey.length > 2000) throw new WorkflowError('invalid_job_source_key');
  return createHash('sha256').update(sourceKey).digest('hex');
}

function extractionValues(extraction: InvoiceExtraction): SyntheticAnswerKey['expected'] {
  return {
    documentType: extraction.documentType.value ?? '',
    supplierName: extraction.supplierName.value ?? '',
    supplierAddress: extraction.supplierAddress.value ?? '',
    supplierTaxRegistrationId: extraction.supplierTaxRegistrationId.value ?? '',
    invoiceNumber: extraction.invoiceNumber.value ?? '',
    invoiceDate: extraction.invoiceDate.value ?? '',
    currency: extraction.currency.value ?? '',
    pricing: extraction.pricing.value ?? '',
    lines: extraction.lines.map(line => ({
      description: line.description.value ?? '', quantity: line.quantity.value ?? '',
      unitPrice: line.unitPrice.value ?? '', lineNet: line.lineNet.value ?? '',
    })),
    subtotal: extraction.subtotal.value ?? '',
    tax: extraction.tax.value ?? '',
    total: extraction.total.value ?? '',
    complexities: extraction.complexities.map(item => item.code),
  };
}

export function compareWithAnswerKey(
  extraction: InvoiceExtraction,
  attachmentSha256: string,
  answerKey: SyntheticAnswerKey | null,
): { status: 'answer_key_match' | 'mismatch' | 'not_evaluated'; mismatches: string[]; reason: string | null } {
  if (answerKey === null) return { status: 'not_evaluated', mismatches: [], reason: 'no_answer_key' };
  if (attachmentSha256 !== answerKey.pdfSha256) {
    return { status: 'not_evaluated', mismatches: [], reason: 'attachment_hash_does_not_match_answer_key' };
  }
  const actual = extractionValues(extraction);
  const mismatches: string[] = [];
  const compare = (path: string, left: unknown, right: unknown): void => {
    if (JSON.stringify(left) !== JSON.stringify(right)) mismatches.push(path);
  };
  for (const key of [
    'documentType', 'supplierName', 'supplierAddress', 'supplierTaxRegistrationId',
    'invoiceNumber', 'invoiceDate', 'currency',
    'pricing', 'subtotal', 'tax', 'total', 'lines', 'complexities',
  ] as const) compare(key, actual[key], answerKey.expected[key]);
  return { status: mismatches.length ? 'mismatch' : 'answer_key_match', mismatches, reason: null };
}

function buildResult(
  options: ProcessClaimedJobOptions,
  attachment: DownloadedAttachment,
  pages: readonly PdfTextPage[],
  modelRun: SliceModelRun,
  documentSource: 'embedded_pdf_text' | 'telnyx_vision_capture',
): Record<string, unknown> {
  // The bundled answer key is trusted only for its byte-identical synthetic fixture.
  // A different inbound invoice has no trusted expected count or business identity.
  const matchingAnswerKey = options.answerKey !== null &&
    attachment.sha256 === options.answerKey.pdfSha256 ? options.answerKey : null;
  const arithmetic = reviewExtraction(modelRun.extraction, options.claim.jobId, options.policy);
  const accountingProposal = proposeAccountingEntries(modelRun.extraction, arithmetic, options.policy);
  const normalizedFinancialValues = normalizeFinancialValues(modelRun.extraction, options.policy);
  const supplier = modelRun.extraction.supplierName.value;
  const invoiceNumber = modelRun.extraction.invoiceNumber.value;
  const actualReference = supplier !== null && invoiceNumber !== null ? businessReference(supplier, invoiceNumber) : null;
  const expectedReference = matchingAnswerKey === null ? null :
    businessReference(matchingAnswerKey.expected.supplierName, matchingAnswerKey.expected.invoiceNumber);
  const completeness = checkCompleteness({
    received: [{ canonicalId: options.claim.jobId, businessReference: actualReference }],
    expectedCount: matchingAnswerKey === null ? null : 1,
    expectedManifest: expectedReference === null ? null : [expectedReference],
    unresolvedDocuments: actualReference === null ? 1 : 0,
  });
  return {
    schemaVersion: 'bookkeeping_result_v1',
    mode: options.mode,
    createdAt: new Date().toISOString(),
    job: { id: options.claim.jobId, attempt: options.claim.attempt, durableStore: 'sqlite' },
    intake: {
      provider: options.mode === 'live_telnyx' ? 'telnyx_email' :
        options.mode === 'local_pdf_live_telnyx_model' ? 'local_pdf_not_telnyx_email' :
          'local_fixture_not_telnyx_email',
      inboxId: options.inboxId,
      messageId: options.messageId,
      receivedAt: options.receivedAt,
      attachment: {
        filename: options.filename,
        contentType: options.contentType ?? 'application/pdf',
        declaredSha256: options.declaredSha256,
        calculatedSha256: attachment.sha256,
        declaredSize: options.declaredSize,
        calculatedSize: attachment.sizeBytes,
        bytesRetrieved: true,
      },
    },
    documentText: {
      source: documentSource,
      pages: pages.length,
      characters: pages.reduce((sum, page) => sum + page.text.length, 0),
      note: documentSource === 'embedded_pdf_text' ?
        'Evidence quotes were matched against text embedded in the retrieved PDF.' :
        'Evidence quotes were matched against the same Telnyx vision response transcription; visual accuracy still requires human review.',
    },
    pdfText: documentSource === 'embedded_pdf_text' ?
      { status: 'extracted', pages: pages.length, characters: pages.reduce((sum, page) => sum + page.text.length, 0) } :
      { status: 'not_used_visual_input' },
    extraction: {
      provider: modelRun.provider,
      configuredModelId: modelRun.configuredModelId,
      responseModelId: modelRun.responseModelId,
      validation: documentSource === 'embedded_pdf_text' ?
        'strict_schema_and_source_quotes_passed_against_embedded_text' :
        'strict_schema_and_source_quotes_passed_against_model_visual_transcription',
      values: modelRun.extraction,
    },
    documentAccuracy: compareWithAnswerKey(modelRun.extraction, attachment.sha256, options.answerKey),
    normalizedFinancialValues,
    arithmetic,
    completeness,
    accountingProposal,
    decision: accountingProposal.status === 'suggested_human_review_required' ?
      'proposal_ready_for_human_review' : 'needs_review',
    controls: {
      automaticPosting: false,
      automaticPayment: false,
      taxFiling: false,
      publicResultUrl: false,
      resultAccess: options.policy.resultAccess,
    },
  };
}

async function persistAttachment(
  directory: string,
  jobId: string,
  bytes: Uint8Array,
  contentType: SupportedInvoiceContentType,
): Promise<string> {
  const attachmentDirectory = join(directory, 'attachments');
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
  const extension = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg';
  const path = join(attachmentDirectory, `${jobId}.${extension}`);
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return path;
}

export async function processClaimedJob(options: ProcessClaimedJobOptions): Promise<{
  result: Record<string, unknown>;
  jsonPath: string;
  htmlPath: string;
}> {
  const { jobId, claimToken } = options.claim;
  try {
    const contentType = options.contentType ?? 'application/pdf';
    const attachment = await options.loadAttachment();
    const attachmentPath = await persistAttachment(options.privateDirectory, jobId, attachment.bytes, contentType);
    options.store.recordDownloaded(jobId, claimToken, attachment.sha256, attachment.sizeBytes, attachmentPath);
    let pages: PdfTextPage[];
    let modelRun: SliceModelRun | null = null;
    let documentSource: 'embedded_pdf_text' | 'telnyx_vision_capture';
    if (contentType === 'application/pdf') {
      try {
        pages = await (options.extractText ?? extractPdfText)(attachment.bytes);
        documentSource = 'embedded_pdf_text';
      } catch (error) {
        if (!(error instanceof WorkflowError) || error.code !== 'pdf_has_no_extractable_text' ||
            options.runVisualModel === undefined) throw error;
        const visualRun = await options.runVisualModel(attachment.bytes, contentType);
        pages = visualRun.pages;
        modelRun = visualRun;
        documentSource = 'telnyx_vision_capture';
      }
    } else {
      if (options.runVisualModel === undefined) throw new WorkflowError('visual_invoice_processing_not_configured');
      const visualRun = await options.runVisualModel(attachment.bytes, contentType);
      pages = visualRun.pages;
      modelRun = visualRun;
      documentSource = 'telnyx_vision_capture';
    }
    options.store.recordTextExtracted(jobId, claimToken);
    modelRun ??= await options.runModel(pages);
    options.store.recordModelCompleted(jobId, claimToken, modelRun.configuredModelId);
    const result = buildResult(options, attachment, pages, modelRun, documentSource);
    const paths = await writeInspectableResult(join(options.privateDirectory, 'results'), jobId, result);
    options.store.complete(jobId, claimToken, JSON.stringify(result));
    return { result, ...paths };
  } catch (error) {
    try {
      options.store.fail(jobId, claimToken, errorCode(error));
    } catch {
      // Preserve the original safe failure; a stage conflict is separately visible in SQLite.
    }
    throw error;
  }
}
