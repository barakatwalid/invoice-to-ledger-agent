import { Agent } from '@telnyx/edge-runtime';
import {
  downloadAttachment,
  sha256Hex,
  type SupportedInvoiceContentType,
} from '../attachment.ts';
import {
  proposeAccountingEntries,
  reviewExtraction,
  type BookkeepingPolicy,
} from '../bookkeeping.ts';
import { businessReference, checkCompleteness, type BatchResult } from '../completeness.ts';
import { errorCode, WorkflowError } from '../errors.ts';
import { readInvoiceDocument } from '../invoice-document.ts';
import {
  extractWithTelnyxModel,
  findTargetInboxMessageHttp,
  listInboxMessagesHttp,
  selectSingleInvoiceAttachment,
  type InboxMessage,
} from '../telnyx-adapter.ts';
import { transcribeVisualWithTelnyxModel } from '../telnyx-vision.ts';
import {
  readEdgeApiKey,
  readEdgePdfRendererConfig,
  validateEdgeAgentConfig,
  validateStoredEdgeAgentConfig,
  type EdgeAgentConfig,
} from './config.ts';
import { prepareEdgeVisualPages } from './pdf-renderer-client.ts';
import { createDirectTelnyxAiClient } from './telnyx-ai-http-client.ts';

type AgentPhase = 'stopped' | 'waiting' | 'polling' | 'processing' | 'ready' | 'error';

type BookkeepingAgentV2State = {
  running: boolean;
  phase: AgentPhase;
  config?: EdgeAgentConfig;
  acceptAfter?: string;
  lastPolledAt?: string;
  lastCompletedJobId?: string;
  lastError?: string;
};

export interface EdgeAgentStatus {
  running: boolean;
  phase: AgentPhase;
  lastPolledAt: string | null;
  lastCompletedJobId: string | null;
  lastError: string | null;
  jobs: { pending: number; processing: number; complete: number; failed: number };
  recentJobs: EdgeJobSummary[];
  batch: EdgeBatchOverview | null;
  batches: EdgeBatchOverview[];
}

export interface EdgeInboxMonitor {
  available: boolean;
  refreshedAt: string;
  scopeStartedAt: string | null;
  receivedMessages: number;
  eligiblePdfMessages: number;
  knownJobs: number;
  waitingJobs: number;
  unsupportedMessages: number;
  newestEligible: { receivedAt: string; filename: string } | null;
}

export interface EdgeBatchManifestEntry {
  supplierName: string;
  invoiceNumber: string;
}

export interface EdgeBatchConfiguration {
  label: string;
  expectedCount: number;
  expectedManifest: EdgeBatchManifestEntry[] | null;
}

export interface EdgeBatchOverview {
  id: string;
  state: 'active' | 'closed';
  label: string;
  expectedCount: number;
  expectedManifest: EdgeBatchManifestEntry[] | null;
  startedAt: string;
  closedAt: string | null;
  jobs: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    unresolved: number;
    unsupportedReceipts: number;
  };
  completeness: BatchResult;
}

export interface EdgeJobSummary {
  id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  filename: string | null;
  receivedAt: string | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  currency: string | null;
  printedTotal: string | null;
  processingPath: 'embedded_text' | 'telnyx_vision' | null;
  decision: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EdgeInvoiceDocument {
  bytes: Uint8Array;
  contentType: SupportedInvoiceContentType;
  filename: string;
  sizeBytes: number;
}

export type EdgeManualPollOutcome =
  | { ok: true; status: EdgeAgentStatus }
  | { ok: false; errorCode: string };

export type EdgeHistoryClearOutcome =
  | { ok: true; status: EdgeAgentStatus }
  | { ok: false; errorCode: string };

export type EdgeFailedJobHideOutcome =
  | { ok: true; status: EdgeAgentStatus }
  | { ok: false; errorCode: string };

export interface EdgeBatchEvaluationInput {
  id: string;
  state: 'active' | 'closed';
  label: string;
  expectedCount: number;
  expectedManifest: EdgeBatchManifestEntry[] | null;
  startedAt: string;
  closedAt: string | null;
  unsupportedReceipts: number;
  jobs: Array<{
    canonicalId: string;
    status: 'pending' | 'processing' | 'complete' | 'failed';
    businessReference: string | null;
  }>;
}

interface ProcessPayload {
  jobId: string;
  messageId: string;
  attachmentIndex: number;
}

type JobStatusRow = { status: string };
type PendingJobRow = { job_id: string; message_id: string; attachment_index: number };
type JobCountRow = { status: string; count: number };
type JobResultRow = { result_json: string | null };
type DocumentJobRow = {
  message_id: string;
  attachment_index: number;
};
type ColumnRow = { name: string };
type ReceiptRow = { batch_id: string | null };
type BatchIdRow = { id: string; started_at: string };
type BatchRow = {
  id: string;
  state: 'active' | 'closed';
  label: string;
  expected_count: number;
  expected_manifest_json: string | null;
  started_at: string;
  closed_at: string | null;
};
type BatchJobRow = { job_id: string; status: string; result_json: string | null };
type JobSummaryRow = {
  job_id: string;
  status: string;
  result_json: string | null;
  error_code: string | null;
  filename: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
};

export interface EligibleInvoiceMessage {
  message: InboxMessage;
  attachment: ReturnType<typeof selectSingleInvoiceAttachment>;
}

const SKIPPABLE_INTAKE_CODES = new Set([
  'invoice_attachment_not_found',
  'multiple_invoice_attachments',
  'invoice_pdf_attachment_not_found',
  'unsupported_attachment_shape',
  'unsupported_attachment_type',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourcedValue(input: unknown): string | null {
  return record(input) && typeof input.value === 'string' && input.value.trim() ? input.value : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}

export function validateEdgeBatchConfiguration(input: unknown): EdgeBatchConfiguration {
  if (!record(input) || !exactKeys(input, ['label', 'expectedCount', 'expectedManifest']) ||
      typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200 ||
      !Number.isSafeInteger(input.expectedCount) || (input.expectedCount as number) < 0 ||
      (input.expectedCount as number) > 10_000 ||
      !(input.expectedManifest === null ||
        (Array.isArray(input.expectedManifest) && input.expectedManifest.length <= 10_000))) {
    throw new WorkflowError('invalid_edge_batch_configuration');
  }
  const expectedManifest = input.expectedManifest?.map(entry => {
    if (!record(entry) || !exactKeys(entry, ['supplierName', 'invoiceNumber']) ||
        typeof entry.supplierName !== 'string' || typeof entry.invoiceNumber !== 'string') {
      throw new WorkflowError('invalid_edge_batch_configuration');
    }
    const supplierName = entry.supplierName.trim();
    const invoiceNumber = entry.invoiceNumber.trim();
    try {
      businessReference(supplierName, invoiceNumber);
    } catch {
      throw new WorkflowError('invalid_edge_batch_configuration');
    }
    return { supplierName, invoiceNumber };
  }) ?? null;
  const expectedCount = input.expectedCount as number;
  if (expectedManifest !== null &&
      (expectedManifest.length !== expectedCount ||
       new Set(expectedManifest.map(entry => businessReference(entry.supplierName, entry.invoiceNumber))).size !==
         expectedManifest.length)) {
    throw new WorkflowError('invalid_edge_batch_configuration');
  }
  return { label: input.label.trim(), expectedCount, expectedManifest };
}

function parseStoredManifest(input: string | null, expectedCount: number): EdgeBatchManifestEntry[] | null {
  if (input === null) return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return validateEdgeBatchConfiguration({
      label: 'stored-batch', expectedCount, expectedManifest: parsed,
    }).expectedManifest;
  } catch {
    throw new WorkflowError('invalid_stored_edge_batch');
  }
}

function storedBusinessReference(resultJson: string | null): string | null {
  if (resultJson === null) return null;
  try {
    const result = JSON.parse(resultJson) as unknown;
    if (!record(result) || !record(result.extraction) || !record(result.extraction.values)) return null;
    const supplier = sourcedValue(result.extraction.values.supplierName);
    const invoiceNumber = sourcedValue(result.extraction.values.invoiceNumber);
    return supplier === null || invoiceNumber === null ? null : businessReference(supplier, invoiceNumber);
  } catch {
    return null;
  }
}

function summarizeJob(row: JobSummaryRow): EdgeJobSummary {
  let result: Record<string, unknown> = {};
  if (row.result_json !== null) {
    try {
      const parsed = JSON.parse(row.result_json) as unknown;
      if (record(parsed)) result = parsed;
    } catch {
      // Corrupt private state is represented by absent summary values; raw content is never exposed.
    }
  }
  const extraction = record(result.extraction) ? result.extraction : {};
  const values = record(extraction.values) ? extraction.values : {};
  const intake = record(result.intake) ? result.intake : {};
  const attachment = record(intake.attachment) ? intake.attachment : {};
  const status = ['pending', 'processing', 'complete', 'failed'].includes(row.status) ? row.status : 'failed';
  return {
    id: row.job_id,
    status: status as EdgeJobSummary['status'],
    filename: row.filename ?? (typeof attachment.filename === 'string' ? attachment.filename : null),
    receivedAt: row.received_at ?? (typeof intake.receivedAt === 'string' ? intake.receivedAt : null),
    supplierName: sourcedValue(values.supplierName),
    invoiceNumber: sourcedValue(values.invoiceNumber),
    currency: sourcedValue(values.currency),
    printedTotal: sourcedValue(values.total),
    processingPath: extraction.documentPath === 'embedded_text' || extraction.documentPath === 'telnyx_vision' ?
      extraction.documentPath : null,
    decision: typeof result.decision === 'string' ? result.decision : null,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function evaluateEdgeBatch(input: EdgeBatchEvaluationInput): EdgeBatchOverview {
  if (!Number.isSafeInteger(input.unsupportedReceipts) || input.unsupportedReceipts < 0) {
    throw new WorkflowError('invalid_edge_batch_receipt_count');
  }
  const counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const job of input.jobs) {
    if (job.status === 'pending') counts.pending++;
    else if (job.status === 'processing') counts.processing++;
    else if (job.status === 'complete') counts.completed++;
    else if (job.status === 'failed') counts.failed++;
    else throw new WorkflowError('invalid_stored_edge_job_status');
  }
  const unresolvedJobs = input.jobs.filter(invoice => invoice.businessReference === null).length;
  const expectedManifest = input.expectedManifest?.map(entry =>
    businessReference(entry.supplierName, entry.invoiceNumber)) ?? null;
  const completeness = checkCompleteness({
    received: input.jobs.map(job => ({
      canonicalId: job.canonicalId,
      businessReference: job.businessReference,
    })),
    expectedCount: input.expectedCount,
    expectedManifest,
    unresolvedDocuments: unresolvedJobs + input.unsupportedReceipts,
  });
  return {
    id: input.id,
    state: input.state,
    label: input.label,
    expectedCount: input.expectedCount,
    expectedManifest: input.expectedManifest,
    startedAt: input.startedAt,
    closedAt: input.closedAt,
    jobs: {
      total: input.jobs.length,
      ...counts,
      unresolved: unresolvedJobs,
      unsupportedReceipts: input.unsupportedReceipts,
    },
    completeness,
  };
}

/** Returns new messages in deterministic arrival order without trusting or filtering subjects. */
export function messagesReceivedAfter(messages: readonly InboxMessage[], acceptAfter: string): InboxMessage[] {
  const cutoff = Date.parse(acceptAfter);
  if (!Number.isFinite(cutoff)) throw new WorkflowError('invalid_edge_accept_after');
  return messages.filter(message => {
    const receivedAt = Date.parse(message.receivedAt);
    return Number.isFinite(receivedAt) && receivedAt >= cutoff;
  }).sort((left, right) =>
    left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id));
}

/** Selects new, structurally eligible invoice emails without trusting or filtering their subjects. */
export function eligibleInvoiceMessagesReceivedAfter(
  messages: readonly InboxMessage[],
  acceptAfter: string,
): EligibleInvoiceMessage[] {
  const eligible: EligibleInvoiceMessage[] = [];
  for (const message of messagesReceivedAfter(messages, acceptAfter)) {
    try {
      eligible.push({ message, attachment: selectSingleInvoiceAttachment(message) });
    } catch (error) {
      if (SKIPPABLE_INTAKE_CODES.has(errorCode(error))) continue;
      throw error;
    }
  }
  return eligible;
}

/** Re-arming a running actor must not move the cutoff past mail already waiting in the inbox. */
export function intakeCutoffForStart(
  wasRunning: boolean,
  existingCutoff: string | undefined,
  now: string,
): string {
  if (!Number.isFinite(Date.parse(now))) throw new WorkflowError('invalid_edge_accept_after');
  if (wasRunning && existingCutoff && Number.isFinite(Date.parse(existingCutoff))) return existingCutoff;
  return now;
}

const EDGE_DEMO_POLICY: BookkeepingPolicy = {
  schemaVersion: 'bookkeeping_policy_v1',
  id: 'demo-gross-expense-v1',
  label: 'DEMO ONLY — human review required; no posting or tax conclusion',
  currencyMinorUnits: { USD: 2, EUR: 2, GBP: 2, AED: 2, SGD: 2, MYR: 2 },
  currencyAmountFormats: {
    USD: { styles: ['dot_decimal'], markers: ['USD', '$'] },
    EUR: { styles: ['dot_decimal', 'comma_decimal'], markers: ['EUR', '€'] },
    GBP: { styles: ['dot_decimal'], markers: ['GBP', '£'] },
    AED: { styles: ['dot_decimal'], markers: ['AED'] },
    SGD: { styles: ['dot_decimal'], markers: ['SGD', 'S$'] },
    MYR: { styles: ['dot_decimal'], markers: ['MYR', 'RM'] },
  },
  accounting: {
    method: 'gross_expense',
    debitAccountId: 'DEMO-6000-UNCLASSIFIED-EXPENSE',
    creditAccountId: 'DEMO-2000-ACCOUNTS-PAYABLE',
  },
  resultAccess: 'authenticated_edge_actor_only',
  allowedResultRecipients: [],
};

function processPayload(input: unknown): ProcessPayload {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowError('invalid_edge_process_payload');
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || typeof value.jobId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.jobId) || typeof value.messageId !== 'string' || !value.messageId ||
      !Number.isInteger(value.attachmentIndex) || (value.attachmentIndex as number) < 0) {
    throw new WorkflowError('invalid_edge_process_payload');
  }
  return value as unknown as ProcessPayload;
}

function isoNow(): string {
  return new Date().toISOString();
}

export class BookkeepingAgentV2 extends Agent<Env, BookkeepingAgentV2State> {
  protected initialState(): BookkeepingAgentV2State {
    return { running: false, phase: 'stopped' };
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invoice_jobs (
        job_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        attachment_index INTEGER NOT NULL,
        batch_id TEXT,
        filename TEXT,
        received_at TEXT,
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('pending','processing','complete','failed')),
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(message_id, attachment_index)
      )
    `);
    const columns = this.ctx.storage.sql.exec<ColumnRow>('PRAGMA table_info(invoice_jobs)').toArray();
    if (!columns.some(column => column.name === 'batch_id')) {
      this.ctx.storage.sql.exec('ALTER TABLE invoice_jobs ADD COLUMN batch_id TEXT');
    }
    if (!columns.some(column => column.name === 'filename')) {
      this.ctx.storage.sql.exec('ALTER TABLE invoice_jobs ADD COLUMN filename TEXT');
    }
    if (!columns.some(column => column.name === 'received_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE invoice_jobs ADD COLUMN received_at TEXT');
    }
    if (!columns.some(column => column.name === 'hidden')) {
      this.ctx.storage.sql.exec('ALTER TABLE invoice_jobs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))');
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS invoice_batches (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('active','closed')),
        label TEXT NOT NULL,
        expected_count INTEGER NOT NULL CHECK (expected_count >= 0 AND expected_count <= 10000),
        expected_manifest_json TEXT,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS invoice_batches_one_active
        ON invoice_batches(state) WHERE state = 'active';
      CREATE INDEX IF NOT EXISTS invoice_jobs_batch_id ON invoice_jobs(batch_id);
      CREATE TABLE IF NOT EXISTS inbox_receipts (
        source_key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        batch_id TEXT,
        received_at TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('supported','unsupported')),
        reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_receipts_batch_id ON inbox_receipts(batch_id)
    `);
  }

  private activeBatch(): BatchIdRow | null {
    return this.ctx.storage.sql.exec<BatchIdRow>(
      "SELECT id, started_at FROM invoice_batches WHERE state = 'active' LIMIT 1",
    ).toArray()[0] ?? null;
  }

  private recordInboxReceipt(
    message: InboxMessage,
    classification: 'supported' | 'unsupported',
    reasonCode: string | null,
  ): string | null {
    if ((classification === 'supported' && reasonCode !== null) ||
        (classification === 'unsupported' &&
         !(typeof reasonCode === 'string' && /^[a-z0-9_]{1,160}$/.test(reasonCode)))) {
      throw new WorkflowError('invalid_edge_inbox_receipt');
    }
    const sourceKey = `telnyx-email:${message.inboxId}:${message.id}`;
    const now = isoNow();
    const batchId = this.activeBatch()?.id ?? null;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO inbox_receipts
       (source_key, message_id, batch_id, received_at, classification, reason_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sourceKey, message.id, batchId, message.receivedAt, classification, reasonCode, now, now,
    );
    const stored = this.ctx.storage.sql.exec<ReceiptRow>(
      'SELECT batch_id FROM inbox_receipts WHERE source_key = ?', sourceKey,
    ).toArray()[0];
    if (!stored) throw new WorkflowError('edge_receipt_store_failed', true);
    return stored.batch_id;
  }

  private async claimInvoiceMessage(
    message: InboxMessage,
    attachment: ReturnType<typeof selectSingleInvoiceAttachment>,
  ): Promise<string | null> {
    const batchId = this.recordInboxReceipt(message, 'supported', null);
    const jobId = await sha256Hex(new TextEncoder().encode(`${message.id}:${attachment.index}`));
    const existing = this.ctx.storage.sql.exec<JobStatusRow>(
      'SELECT status FROM invoice_jobs WHERE job_id = ?', jobId,
    ).toArray()[0];
    if (existing) return null;
    const now = isoNow();
    this.ctx.storage.sql.exec(
      `INSERT INTO invoice_jobs
       (job_id, message_id, attachment_index, batch_id, filename, received_at,
        status, result_json, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
      jobId, message.id, attachment.index, batchId, attachment.filename, message.receivedAt, now, now,
    );
    return jobId;
  }

  private batchOverview(id: string): EdgeBatchOverview {
    const row = this.ctx.storage.sql.exec<BatchRow>(
      `SELECT id, state, label, expected_count, expected_manifest_json, started_at, closed_at
       FROM invoice_batches WHERE id = ?`, id,
    ).toArray()[0];
    if (!row) throw new WorkflowError('edge_batch_not_found');
    const manifest = parseStoredManifest(row.expected_manifest_json, row.expected_count);
    const jobs = this.ctx.storage.sql.exec<BatchJobRow>(
      `SELECT job_id, status, result_json FROM invoice_jobs
       WHERE batch_id = ? AND hidden = 0 ORDER BY created_at, job_id`, id,
    ).toArray();
    const unsupported = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM inbox_receipts
       WHERE batch_id = ? AND classification = 'unsupported'`, id,
    ).toArray()[0]?.count ?? 0;
    return evaluateEdgeBatch({
      id: row.id,
      state: row.state,
      label: row.label,
      expectedCount: row.expected_count,
      expectedManifest: manifest,
      startedAt: row.started_at,
      closedAt: row.closed_at,
      unsupportedReceipts: Number(unsupported),
      jobs: jobs.map(job => ({
        canonicalId: job.job_id,
        status: job.status as EdgeBatchEvaluationInput['jobs'][number]['status'],
        businessReference: storedBusinessReference(job.result_json),
      })),
    });
  }

  private batchHistory(limit = 20): EdgeBatchOverview[] {
    const rows = this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM invoice_batches
       ORDER BY (state = 'active') DESC, created_at DESC LIMIT ?`, limit,
    ).toArray();
    return rows.map(row => this.batchOverview(row.id));
  }

  private recentJobs(limit = 50): EdgeJobSummary[] {
    return this.ctx.storage.sql.exec<JobSummaryRow>(
      `SELECT job_id, status, result_json, error_code, filename, received_at, created_at, updated_at
       FROM invoice_jobs WHERE hidden = 0 ORDER BY created_at DESC, job_id DESC LIMIT ?`, limit,
    ).toArray().map(summarizeJob);
  }

  async start(input: EdgeAgentConfig): Promise<EdgeAgentStatus> {
    const config = validateEdgeAgentConfig(input);
    this.ensureSchema();
    const previous = await this.getState();
    const now = isoNow();
    const batch = this.activeBatch();
    await this.setState({
      running: true,
      phase: 'waiting',
      config,
      acceptAfter: batch?.started_at ?? intakeCutoffForStart(previous.running, previous.acceptAfter, now),
      lastError: null,
    });
    await this.queue('_poll', undefined, { id: 'poll-now', maxRetries: 0 });
    await this.schedule(config.pollIntervalSeconds, '_poll', undefined, {
      id: 'poll-loop',
      maxRetries: 0,
    });
    return this.status();
  }

  async stop(): Promise<EdgeAgentStatus> {
    await this.cancelSchedule('poll-now');
    await this.cancelSchedule('poll-loop');
    await this.setState({ running: false, phase: 'stopped' });
    return this.status();
  }

  async status(): Promise<EdgeAgentStatus> {
    this.ensureSchema();
    const state = await this.getState();
    const jobs = { pending: 0, processing: 0, complete: 0, failed: 0 };
    const rows = this.ctx.storage.sql
      .exec<JobCountRow>('SELECT status, COUNT(*) AS count FROM invoice_jobs WHERE hidden = 0 GROUP BY status')
      .toArray();
    for (const row of rows) {
      if (row.status in jobs && Number.isInteger(row.count)) jobs[row.status as keyof typeof jobs] = row.count;
    }
    const batches = this.batchHistory();
    return {
      running: state.running,
      phase: state.phase,
      lastPolledAt: state.lastPolledAt ?? null,
      lastCompletedJobId: state.lastCompletedJobId ?? null,
      lastError: state.lastError ?? null,
      jobs,
      recentJobs: this.recentJobs(),
      batch: batches.length === 0 ? null : this.batchOverview(batches[0]!.id),
      batches,
    };
  }

  /** Read-only inbox snapshot for the private dashboard. It never downloads attachments,
   * invokes a model, claims a job, or changes actor state. */
  async inboxMonitor(): Promise<EdgeInboxMonitor> {
    this.ensureSchema();
    const state = await this.getState();
    const refreshedAt = isoNow();
    if (!state.config || !state.acceptAfter) {
      return {
        available: false,
        refreshedAt,
        scopeStartedAt: null,
        receivedMessages: 0,
        eligiblePdfMessages: 0,
        knownJobs: 0,
        waitingJobs: 0,
        unsupportedMessages: 0,
        newestEligible: null,
      };
    }
    const config = validateStoredEdgeAgentConfig(state.config);
    const apiKey = await readEdgeApiKey(this.env.SECRETS);
    const messages = messagesReceivedAfter(
      await listInboxMessagesHttp(apiKey, config.inboxId, null),
      state.acceptAfter,
    );
    let eligiblePdfMessages = 0;
    let knownJobs = 0;
    let unsupportedMessages = 0;
    let newestEligible: EdgeInboxMonitor['newestEligible'] = null;
    for (const message of messages) {
      let attachment: ReturnType<typeof selectSingleInvoiceAttachment>;
      try {
        attachment = selectSingleInvoiceAttachment(message);
      } catch (error) {
        if (SKIPPABLE_INTAKE_CODES.has(errorCode(error))) {
          unsupportedMessages++;
          continue;
        }
        throw error;
      }
      eligiblePdfMessages++;
      const known = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM invoice_jobs
         WHERE message_id = ? AND attachment_index = ?`,
        message.id, attachment.index,
      ).toArray()[0]?.count ?? 0;
      if (Number(known) > 0) knownJobs++;
      if (newestEligible === null || message.receivedAt > newestEligible.receivedAt) {
        newestEligible = { receivedAt: message.receivedAt, filename: attachment.filename };
      }
    }
    return {
      available: true,
      refreshedAt,
      scopeStartedAt: state.acceptAfter,
      receivedMessages: messages.length,
      eligiblePdfMessages,
      knownJobs,
      waitingJobs: eligiblePdfMessages - knownJobs,
      unsupportedMessages,
      newestEligible,
    };
  }

  async configureBatch(input: unknown): Promise<EdgeBatchOverview> {
    const config = validateEdgeBatchConfiguration(input);
    this.ensureSchema();
    const now = isoNow();
    const manifestJson = config.expectedManifest === null ? null : JSON.stringify(config.expectedManifest);
    const active = this.activeBatch();
    if (active) {
      this.ctx.storage.sql.exec(
        `UPDATE invoice_batches
         SET label = ?, expected_count = ?, expected_manifest_json = ?, updated_at = ?
         WHERE id = ? AND state = 'active'`,
        config.label, config.expectedCount, manifestJson, now, active.id,
      );
      return this.batchOverview(active.id);
    }
    const id = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO invoice_batches
       (id, state, label, expected_count, expected_manifest_json, started_at, closed_at, created_at, updated_at)
       VALUES (?, 'active', ?, ?, ?, ?, NULL, ?, ?)`,
      id, config.label, config.expectedCount, manifestJson, now, now, now,
    );
    await this.setState({ acceptAfter: now });
    return this.batchOverview(id);
  }

  async closeBatch(): Promise<EdgeBatchOverview | null> {
    this.ensureSchema();
    const active = this.activeBatch();
    if (!active) return null;
    const now = isoNow();
    this.ctx.storage.sql.exec(
      `UPDATE invoice_batches SET state = 'closed', closed_at = ?, updated_at = ?
       WHERE id = ? AND state = 'active'`,
      now, now, active.id,
    );
    return this.batchOverview(active.id);
  }

  async clearPriorHistory(): Promise<EdgeHistoryClearOutcome> {
    try {
      this.ensureSchema();
      const active = this.activeBatch();
      if (!active) return { ok: false, errorCode: 'edge_active_batch_required' };
      const activeRecords = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT (SELECT COUNT(*) FROM invoice_jobs WHERE batch_id = ?) +
                (SELECT COUNT(*) FROM inbox_receipts WHERE batch_id = ?) AS count`,
        active.id, active.id,
      ).toArray()[0]?.count ?? 0;
      if (Number(activeRecords) !== 0) return { ok: false, errorCode: 'edge_active_batch_not_empty' };
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM invoice_jobs');
        this.ctx.storage.sql.exec('DELETE FROM inbox_receipts');
        this.ctx.storage.sql.exec("DELETE FROM invoice_batches WHERE state = 'closed'");
      });
      const state = await this.getState();
      await this.setState({
        phase: state.running ? 'waiting' : 'stopped',
        lastCompletedJobId: null,
        lastError: null,
      });
      return { ok: true, status: await this.status() };
    } catch (error) {
      return { ok: false, errorCode: errorCode(error) };
    }
  }

  /** Hides exactly one failed job from operator views while retaining its durable
   * source identity so the same inbox message cannot be claimed again. */
  async hideFailedJob(jobId: string): Promise<EdgeFailedJobHideOutcome> {
    try {
      if (!/^[a-f0-9]{64}$/.test(jobId)) {
        return { ok: false, errorCode: 'invalid_edge_job_id' };
      }
      this.ensureSchema();
      const row = this.ctx.storage.sql.exec<{ status: string; hidden: number }>(
        'SELECT status, hidden FROM invoice_jobs WHERE job_id = ?', jobId,
      ).toArray()[0];
      if (!row) return { ok: false, errorCode: 'edge_job_not_found' };
      if (row.hidden === 1) return { ok: false, errorCode: 'edge_job_already_hidden' };
      if (row.status !== 'failed') return { ok: false, errorCode: 'edge_job_not_failed' };
      this.ctx.storage.sql.exec(
        `UPDATE invoice_jobs SET hidden = 1, updated_at = ?
         WHERE job_id = ? AND status = 'failed' AND hidden = 0`,
        isoNow(), jobId,
      );
      return { ok: true, status: await this.status() };
    } catch {
      return { ok: false, errorCode: 'edge_failed_job_hide_failed' };
    }
  }

  /** Operator fallback for platforms where a due actor alarm has not fired. */
  async pollNow(): Promise<EdgeManualPollOutcome> {
    let stage = 'schema';
    try {
      this.ensureSchema();
      stage = 'state';
      const state = await this.getState();
      if (!state.running || !state.config || !state.acceptAfter) {
        return { ok: false, errorCode: 'edge_agent_not_running' };
      }
      stage = 'cycle';
      await this._pollCycle(false);
      const cycleState = await this.getState();
      if (cycleState.phase === 'error' && cycleState.lastError) {
        return { ok: false, errorCode: cycleState.lastError };
      }
      stage = 'pending_lookup';
      const pending = this.ctx.storage.sql.exec<PendingJobRow>(
        `SELECT job_id, message_id, attachment_index FROM invoice_jobs
         WHERE status = 'pending' AND hidden = 0 ORDER BY created_at, job_id LIMIT 1`,
      ).toArray()[0];
      if (pending) {
        stage = 'process';
        await this._process({
          jobId: pending.job_id,
          messageId: pending.message_id,
          attachmentIndex: pending.attachment_index,
        });
      }
      stage = 'status';
      const status = await this.status();
      if (status.phase === 'error' && status.lastError) {
        return { ok: false, errorCode: status.lastError };
      }
      return { ok: true, status };
    } catch {
      return { ok: false, errorCode: `edge_manual_poll_${stage}_failed` };
    }
  }

  async result(jobId: string): Promise<unknown | null> {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new WorkflowError('invalid_edge_job_id');
    this.ensureSchema();
    const row = this.ctx.storage.sql
      .exec<JobResultRow>('SELECT result_json FROM invoice_jobs WHERE job_id = ? AND hidden = 0', jobId)
      .toArray()[0];
    if (!row?.result_json) return null;
    try {
      return JSON.parse(row.result_json) as unknown;
    } catch {
      throw new WorkflowError('invalid_stored_edge_result');
    }
  }

  /** Authenticated dashboard support: fetches the original completed-invoice attachment on demand.
   * The private provider URL is never returned or persisted, and the normal host/type/size checks
   * are applied again before bytes cross the actor boundary. */
  async invoiceDocument(jobId: string): Promise<EdgeInvoiceDocument | null> {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new WorkflowError('invalid_edge_job_id');
    this.ensureSchema();
    const row = this.ctx.storage.sql.exec<DocumentJobRow>(
      `SELECT message_id, attachment_index FROM invoice_jobs
       WHERE job_id = ? AND hidden = 0 AND status = 'complete'`,
      jobId,
    ).toArray()[0];
    if (!row) return null;
    const state = await this.getState();
    if (!state.config) throw new WorkflowError('edge_agent_not_configured');
    const config = validateStoredEdgeAgentConfig(state.config);
    const apiKey = await readEdgeApiKey(this.env.SECRETS);
    const message = await findTargetInboxMessageHttp(apiKey, config.inboxId, null, row.message_id);
    const attachment = selectSingleInvoiceAttachment(message);
    if (attachment.index !== row.attachment_index) {
      throw new WorkflowError('edge_attachment_identity_changed');
    }
    const downloaded = await downloadAttachment(attachment, {
      allowedHosts: new Set(config.attachmentHosts),
    });
    return {
      bytes: downloaded.bytes,
      contentType: attachment.contentType,
      filename: attachment.filename,
      sizeBytes: downloaded.sizeBytes,
    };
  }

  private async _pollCycle(queueProcessing: boolean): Promise<void> {
    this.ensureSchema();
    const state = await this.getState();
    if (!state.running || !state.config || !state.acceptAfter) return;
    const config = validateStoredEdgeAgentConfig(state.config);
    await this.setState({ phase: 'polling', lastError: null });
    try {
      const apiKey = await readEdgeApiKey(this.env.SECRETS);
      const messages = await listInboxMessagesHttp(apiKey, config.inboxId, null);
      for (const message of messagesReceivedAfter(messages, state.acceptAfter)) {
        let attachment: ReturnType<typeof selectSingleInvoiceAttachment>;
        try {
          attachment = selectSingleInvoiceAttachment(message);
        } catch (error) {
          const code = errorCode(error);
          if (SKIPPABLE_INTAKE_CODES.has(code)) {
            this.recordInboxReceipt(message, 'unsupported', code);
            continue;
          }
          throw error;
        }
        const jobId = await this.claimInvoiceMessage(message, attachment);
        if (jobId === null) continue;
        const now = isoNow();
        if (queueProcessing) {
          await this.queue('_process', { jobId, messageId: message.id, attachmentIndex: attachment.index }, {
            id: `process:${jobId}`,
            maxRetries: 0,
          });
        }
        await this.setState({ phase: 'processing', lastPolledAt: now });
        return;
      }
      await this.setState({
        phase: state.lastCompletedJobId ? 'ready' : 'waiting',
        lastPolledAt: isoNow(),
        lastError: null,
      });
    } catch (error) {
      const code = errorCode(error);
      await this.setState({ phase: 'error', lastPolledAt: isoNow(), lastError: code });
    }
  }

  async _poll(): Promise<void> {
    await this._pollCycle(true);
    try {
      const latest = await this.getState();
      if (latest.running && latest.config) {
        const latestConfig = validateStoredEdgeAgentConfig(latest.config);
        await this.schedule(latestConfig.pollIntervalSeconds, '_poll', undefined, {
          id: 'poll-loop',
          maxRetries: 0,
        });
      }
    } catch {
      await this.setState({ phase: 'error', lastError: 'edge_poll_schedule_failed' });
    }
  }

  async _process(input: unknown): Promise<void> {
    const payload = processPayload(input);
    this.ensureSchema();
    const current = this.ctx.storage.sql.exec<JobStatusRow>(
      'SELECT status FROM invoice_jobs WHERE job_id = ?', payload.jobId,
    ).toArray()[0];
    if (!current) throw new WorkflowError('edge_job_not_found');
    if (current.status !== 'pending') return;
    const state = await this.getState();
    if (!state.config) throw new WorkflowError('edge_agent_not_configured');
    const config = validateStoredEdgeAgentConfig(state.config);
    const startedAt = isoNow();
    this.ctx.storage.sql.exec(
      `UPDATE invoice_jobs SET status = 'processing', error_code = NULL, updated_at = ? WHERE job_id = ?`,
      startedAt, payload.jobId,
    );
    await this.setState({ phase: 'processing', lastError: null });
    try {
      const apiKey = await readEdgeApiKey(this.env.SECRETS);
      const client = createDirectTelnyxAiClient(apiKey);
      const message = await findTargetInboxMessageHttp(
        apiKey,
        config.inboxId,
        null,
        payload.messageId,
      );
      const attachment = selectSingleInvoiceAttachment(message);
      if (attachment.index !== payload.attachmentIndex) throw new WorkflowError('edge_attachment_identity_changed');
      const downloaded = await downloadAttachment(attachment, {
        allowedHosts: new Set(config.attachmentHosts),
      });
      const document = await readInvoiceDocument(downloaded.bytes, attachment.contentType, {
        prepareVisual: async (bytes, contentType) => prepareEdgeVisualPages(
          bytes,
          contentType,
          contentType === 'application/pdf' ? await readEdgePdfRendererConfig(this.env.SECRETS) : undefined,
        ),
        transcribeVisual: pages => transcribeVisualWithTelnyxModel(client, config.modelId, pages, {
          reasoningEffort: 'high',
        }),
      });
      const modelRun = await extractWithTelnyxModel(client, config.modelId, document.pages, {
        reasoningEffort: 'high',
      });
      const arithmetic = reviewExtraction(modelRun.extraction, payload.jobId, EDGE_DEMO_POLICY);
      const accountingProposal = proposeAccountingEntries(modelRun.extraction, arithmetic, EDGE_DEMO_POLICY);
      const decision = arithmetic.status === 'arithmetic_consistent' &&
        accountingProposal.status === 'suggested_human_review_required' ?
        'proposal_ready_for_human_review' : 'needs_review';
      const result = {
        schemaVersion: 'bookkeeping_edge_result_v1',
        jobId: payload.jobId,
        completedAt: isoNow(),
        intake: {
          provider: 'telnyx_email',
          receivedAt: message.receivedAt,
          attachment: {
            index: attachment.index,
            filename: attachment.filename,
            contentType: attachment.contentType,
            sizeBytes: downloaded.sizeBytes,
            sha256: downloaded.sha256,
          },
        },
        extraction: {
          provider: modelRun.provider,
          configuredModelId: modelRun.configuredModelId,
          responseModelId: modelRun.responseModelId,
          documentPath: document.path,
          visualModel: document.visualModel,
          validation: 'strict_schema_and_source_quotes_passed',
          values: modelRun.extraction,
        },
        documentAccuracy: {
          status: 'not_evaluated',
          reason: 'no_answer_key_for_general_inbound_invoice',
        },
        arithmetic,
        accountingProposal,
        decision,
        controls: {
          automaticPosting: false,
          automaticPayment: false,
          taxFiling: false,
          publicResultUrl: false,
          resultAccess: EDGE_DEMO_POLICY.resultAccess,
        },
      };
      const completedAt = isoNow();
      this.ctx.storage.sql.exec(
        `UPDATE invoice_jobs
         SET status = 'complete', result_json = ?, error_code = NULL, updated_at = ?
         WHERE job_id = ?`,
        JSON.stringify(result), completedAt, payload.jobId,
      );
      await this.setState({ phase: decision === 'proposal_ready_for_human_review' ? 'ready' : 'error',
        lastCompletedJobId: payload.jobId, lastError: null });
    } catch (error) {
      const code = errorCode(error);
      this.ctx.storage.sql.exec(
        `UPDATE invoice_jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE job_id = ?`,
        code, isoNow(), payload.jobId,
      );
      await this.setState({ phase: 'error', lastError: code });
    }
  }
}
