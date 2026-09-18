import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { businessReference, checkCompleteness, type BatchResult } from './completeness.ts';
import { WorkflowError } from './errors.ts';

export type JobStage = 'accepted' | 'downloaded' | 'text_extracted' | 'model_completed' | 'completed' | 'failed';

export interface NewJob {
  id: string;
  sourceKey: string;
  inboxId: string;
  messageId: string;
  attachmentIndex: number;
  filename: string;
}

export interface BatchManifestEntry {
  supplierName: string;
  invoiceNumber: string;
}

export interface BatchConfiguration {
  label: string;
  expectedCount: number;
  expectedManifest: BatchManifestEntry[] | null;
  includeUnassignedJobs: boolean;
}

export interface InboxReceipt {
  sourceKey: string;
  inboxId: string;
  messageId: string;
  receivedAt: string;
  classification: 'supported' | 'unsupported';
  reasonCode: string | null;
}

export interface BatchOverview {
  id: string;
  state: 'active' | 'closed';
  label: string;
  expectedCount: number;
  expectedManifest: BatchManifestEntry[] | null;
  startedAt: string;
  closedAt: string | null;
  jobs: {
    total: number;
    ready: number;
    processing: number;
    completed: number;
    failed: number;
    unresolved: number;
    unsupportedReceipts: number;
  };
  completeness: BatchResult;
}

export type ClaimResult =
  | { outcome: 'claimed'; jobId: string; claimToken: string; attempt: number }
  | { outcome: 'duplicate_completed'; jobId: string; resultJson: string }
  | { outcome: 'already_processing'; jobId: string }
  | { outcome: 'retry_exhausted'; jobId: string; attempts: number };

export interface JobSummary {
  id: string;
  state: 'ready' | 'processing' | 'completed' | 'failed';
  stage: JobStage;
  attempts: number;
  filename: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobOverview {
  counts: { ready: number; processing: number; completed: number; failed: number };
  latestCompletedJobId: string | null;
  recent: JobSummary[];
}

export interface StoredJobState {
  state: JobSummary['state'];
  attempts: number;
}

interface JobRow {
  id: string;
  state: string;
  attempts: number;
  result_json: string | null;
}

interface JobSummaryRow {
  id: string;
  state: JobSummary['state'];
  stage: JobStage;
  attempts: number;
  filename: string;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface BatchRow {
  id: string;
  state: 'active' | 'closed';
  label: string;
  expected_count: number;
  expected_manifest_json: string | null;
  started_at: string;
  closed_at: string | null;
}

interface BatchJobRow {
  id: string;
  state: JobSummary['state'];
  result_json: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateBatchConfiguration(input: BatchConfiguration): BatchConfiguration {
  if (!record(input) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200 ||
      !Number.isSafeInteger(input.expectedCount) || input.expectedCount < 0 || input.expectedCount > 10_000 ||
      typeof input.includeUnassignedJobs !== 'boolean' ||
      !(input.expectedManifest === null || (Array.isArray(input.expectedManifest) &&
        input.expectedManifest.length <= 10_000))) {
    throw new WorkflowError('invalid_batch_configuration');
  }
  const expectedManifest = input.expectedManifest?.map(entry => {
    if (!record(entry) || typeof entry.supplierName !== 'string' || typeof entry.invoiceNumber !== 'string') {
      throw new WorkflowError('invalid_batch_configuration');
    }
    const supplierName = entry.supplierName.trim();
    const invoiceNumber = entry.invoiceNumber.trim();
    try {
      businessReference(supplierName, invoiceNumber);
    } catch {
      throw new WorkflowError('invalid_batch_configuration');
    }
    return { supplierName, invoiceNumber };
  }) ?? null;
  if (expectedManifest !== null) {
    if (expectedManifest.length !== input.expectedCount ||
        new Set(expectedManifest.map(entry => businessReference(entry.supplierName, entry.invoiceNumber))).size !==
          expectedManifest.length) {
      throw new WorkflowError('invalid_batch_configuration');
    }
  }
  return { ...input, label: input.label.trim(), expectedManifest };
}

function parseManifest(value: string | null): BatchManifestEntry[] | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return validateBatchConfiguration({
      label: 'stored-batch', expectedCount: Array.isArray(parsed) ? parsed.length : -1,
      expectedManifest: parsed as BatchManifestEntry[], includeUnassignedJobs: false,
    }).expectedManifest;
  } catch {
    throw new WorkflowError('invalid_stored_batch');
  }
}

function storedBusinessReference(value: string | null): string | null {
  if (value === null) return null;
  try {
    const result = JSON.parse(value) as unknown;
    if (!record(result) || !record(result.extraction) || !record(result.extraction.values)) return null;
    const supplier = result.extraction.values.supplierName;
    const invoice = result.extraction.values.invoiceNumber;
    if (!record(supplier) || !record(invoice) || typeof supplier.value !== 'string' ||
        typeof invoice.value !== 'string') return null;
    return businessReference(supplier.value, invoice.value);
  } catch {
    return null;
  }
}

export class JobStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
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
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        inbox_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        attachment_index INTEGER NOT NULL,
        filename TEXT NOT NULL,
        batch_id TEXT REFERENCES invoice_batches(id),
        state TEXT NOT NULL CHECK (state IN ('ready','processing','completed','failed')),
        stage TEXT NOT NULL CHECK (stage IN ('accepted','downloaded','text_extracted','model_completed','completed','failed')),
        claim_token TEXT UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        attachment_sha256 TEXT,
        attachment_size INTEGER,
        attachment_path TEXT,
        model_id TEXT,
        result_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const jobColumns = this.database.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{ name: string }>;
    if (!jobColumns.some(column => column.name === 'batch_id')) {
      this.database.exec('ALTER TABLE jobs ADD COLUMN batch_id TEXT REFERENCES invoice_batches(id);');
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS jobs_batch_id ON jobs(batch_id);
      CREATE TABLE IF NOT EXISTS inbox_receipts (
        source_key TEXT PRIMARY KEY,
        inbox_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        batch_id TEXT REFERENCES invoice_batches(id),
        received_at TEXT NOT NULL,
        classification TEXT NOT NULL CHECK (classification IN ('supported','unsupported')),
        reason_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_receipts_batch_id ON inbox_receipts(batch_id);
    `);
  }

  close(): void {
    this.database.close();
  }

  claim(job: NewJob, maxAttempts = Number.MAX_SAFE_INTEGER): ClaimResult {
    if (!job.id || !job.sourceKey || !job.inboxId || !job.messageId || !job.filename ||
        !Number.isSafeInteger(job.attachmentIndex) || job.attachmentIndex < 0 ||
        !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new WorkflowError('invalid_job_identity');
    }
    const now = new Date().toISOString();
    const token = randomUUID();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO jobs
          (id, source_key, inbox_id, message_id, attachment_index, filename, batch_id,
           state, stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?,
          (SELECT id FROM invoice_batches WHERE state = 'active' ORDER BY created_at DESC LIMIT 1),
          'ready', 'accepted', ?, ?)
      `).run(job.id, job.sourceKey, job.inboxId, job.messageId, job.attachmentIndex, job.filename, now, now);
      const row = this.database.prepare('SELECT id, state, attempts, result_json FROM jobs WHERE source_key = ?')
        .get(job.sourceKey) as unknown as JobRow | undefined;
      if (!row) throw new WorkflowError('job_store_read_failed', true);
      if (row.state === 'completed' && row.result_json !== null) {
        this.database.exec('COMMIT');
        return { outcome: 'duplicate_completed', jobId: row.id, resultJson: row.result_json };
      }
      if (row.state === 'processing') {
        this.database.exec('COMMIT');
        return { outcome: 'already_processing', jobId: row.id };
      }
      if (row.state === 'failed' && row.attempts >= maxAttempts) {
        this.database.exec('COMMIT');
        return { outcome: 'retry_exhausted', jobId: row.id, attempts: row.attempts };
      }
      const update = this.database.prepare(`
        UPDATE jobs SET state = 'processing', stage = 'accepted', claim_token = ?, attempts = attempts + 1,
          error_code = NULL, updated_at = ? WHERE id = ? AND state IN ('ready','failed')
      `).run(token, now, row.id);
      if (update.changes !== 1) throw new WorkflowError('job_claim_conflict', true);
      this.database.exec('COMMIT');
      return { outcome: 'claimed', jobId: row.id, claimToken: token, attempt: row.attempts + 1 };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordInboxReceipt(receipt: InboxReceipt): void {
    if (!record(receipt) || !receipt.sourceKey || receipt.sourceKey.length > 2000 || !receipt.inboxId ||
        !receipt.messageId || !Number.isFinite(Date.parse(receipt.receivedAt)) ||
        !['supported', 'unsupported'].includes(receipt.classification) ||
        (receipt.classification === 'supported' ? receipt.reasonCode !== null :
          !(typeof receipt.reasonCode === 'string' && /^[a-z0-9_]{1,160}$/.test(receipt.reasonCode)))) {
      throw new WorkflowError('invalid_inbox_receipt');
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO inbox_receipts
        (source_key, inbox_id, message_id, batch_id, received_at, classification, reason_code, created_at, updated_at)
      VALUES (?, ?, ?,
        (SELECT id FROM invoice_batches WHERE state = 'active' ORDER BY created_at DESC LIMIT 1),
        ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        classification = excluded.classification, reason_code = excluded.reason_code, updated_at = excluded.updated_at
    `).run(receipt.sourceKey, receipt.inboxId, receipt.messageId, receipt.receivedAt,
      receipt.classification, receipt.reasonCode, now, now);
  }

  configureActiveBatch(input: BatchConfiguration): BatchOverview {
    const configuration = validateBatchConfiguration(input);
    const now = new Date().toISOString();
    const manifestJson = configuration.expectedManifest === null ? null :
      JSON.stringify(configuration.expectedManifest);
    this.database.exec('BEGIN IMMEDIATE');
    let id: string;
    try {
      const active = this.database.prepare(`SELECT id FROM invoice_batches WHERE state = 'active'`)
        .get() as { id: string } | undefined;
      id = active?.id ?? randomUUID();
      if (active === undefined) {
        this.database.prepare(`
          INSERT INTO invoice_batches
            (id, state, label, expected_count, expected_manifest_json, started_at, created_at, updated_at)
          VALUES (?, 'active', ?, ?, ?, ?, ?, ?)
        `).run(id, configuration.label, configuration.expectedCount, manifestJson, now, now, now);
      } else {
        this.database.prepare(`
          UPDATE invoice_batches SET label = ?, expected_count = ?, expected_manifest_json = ?, updated_at = ?
          WHERE id = ? AND state = 'active'
        `).run(configuration.label, configuration.expectedCount, manifestJson, now, id);
      }
      if (configuration.includeUnassignedJobs) {
        this.database.prepare('UPDATE jobs SET batch_id = ? WHERE batch_id IS NULL').run(id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
    return this.batchOverview(id);
  }

  closeActiveBatch(): BatchOverview | null {
    const active = this.database.prepare(`SELECT id FROM invoice_batches WHERE state = 'active'`)
      .get() as { id: string } | undefined;
    if (active === undefined) return null;
    const now = new Date().toISOString();
    const updated = this.database.prepare(`
      UPDATE invoice_batches SET state = 'closed', closed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'active'
    `).run(now, now, active.id);
    if (updated.changes !== 1) throw new WorkflowError('batch_state_conflict', true);
    return this.batchOverview(active.id);
  }

  latestBatchOverview(): BatchOverview | null {
    const row = this.database.prepare(`
      SELECT id FROM invoice_batches ORDER BY state = 'active' DESC, created_at DESC LIMIT 1
    `).get() as { id: string } | undefined;
    return row === undefined ? null : this.batchOverview(row.id);
  }

  batchHistory(limit = 20): BatchOverview[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new WorkflowError('invalid_batch_history_limit');
    }
    const rows = this.database.prepare(`
      SELECT id FROM invoice_batches ORDER BY state = 'active' DESC, created_at DESC LIMIT ?
    `).all(limit) as unknown as Array<{ id: string }>;
    return rows.map(row => this.batchOverview(row.id));
  }

  private batchOverview(id: string): BatchOverview {
    const row = this.database.prepare(`
      SELECT id, state, label, expected_count, expected_manifest_json, started_at, closed_at
      FROM invoice_batches WHERE id = ?
    `).get(id) as unknown as BatchRow | undefined;
    if (row === undefined) throw new WorkflowError('batch_not_found');
    const manifest = parseManifest(row.expected_manifest_json);
    const jobs = this.database.prepare(`
      SELECT id, state, result_json FROM jobs WHERE batch_id = ? ORDER BY created_at, id
    `).all(id) as unknown as BatchJobRow[];
    const counts = { ready: 0, processing: 0, completed: 0, failed: 0 };
    const received = jobs.map(job => {
      counts[job.state]++;
      return { canonicalId: job.id, businessReference: storedBusinessReference(job.result_json) };
    });
    const unsupported = this.database.prepare(`
      SELECT COUNT(*) AS count FROM inbox_receipts WHERE batch_id = ? AND classification = 'unsupported'
    `).get(id) as { count: number };
    const unresolvedJobs = received.filter(item => item.businessReference === null).length;
    const expectedManifest = manifest?.map(entry => businessReference(entry.supplierName, entry.invoiceNumber)) ?? null;
    const completeness = checkCompleteness({
      received, expectedCount: row.expected_count, expectedManifest,
      unresolvedDocuments: unresolvedJobs + Number(unsupported.count),
    });
    return {
      id: row.id, state: row.state, label: row.label, expectedCount: row.expected_count,
      expectedManifest: manifest, startedAt: row.started_at, closedAt: row.closed_at,
      jobs: { total: jobs.length, ...counts, unresolved: unresolvedJobs,
        unsupportedReceipts: Number(unsupported.count) },
      completeness,
    };
  }

  private advance(jobId: string, claimToken: string, from: JobStage, to: JobStage): void {
    const result = this.database.prepare(`
      UPDATE jobs SET stage = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND state = 'processing' AND stage = ?
    `).run(to, new Date().toISOString(), jobId, claimToken, from);
    if (result.changes !== 1) throw new WorkflowError('job_stage_conflict', true);
  }

  recordDownloaded(jobId: string, claimToken: string, sha256: string, size: number, path: string): void {
    const result = this.database.prepare(`
      UPDATE jobs SET stage = 'downloaded', attachment_sha256 = ?, attachment_size = ?,
        attachment_path = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND state = 'processing' AND stage = 'accepted'
    `).run(sha256, size, path, new Date().toISOString(), jobId, claimToken);
    if (result.changes !== 1) throw new WorkflowError('job_stage_conflict', true);
  }

  recordTextExtracted(jobId: string, claimToken: string): void {
    this.advance(jobId, claimToken, 'downloaded', 'text_extracted');
  }

  recordModelCompleted(jobId: string, claimToken: string, modelId: string): void {
    const result = this.database.prepare(`
      UPDATE jobs SET stage = 'model_completed', model_id = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND state = 'processing' AND stage = 'text_extracted'
    `).run(modelId, new Date().toISOString(), jobId, claimToken);
    if (result.changes !== 1) throw new WorkflowError('job_stage_conflict', true);
  }

  complete(jobId: string, claimToken: string, resultJson: string): void {
    JSON.parse(resultJson);
    const result = this.database.prepare(`
      UPDATE jobs SET state = 'completed', stage = 'completed', result_json = ?, claim_token = NULL,
        error_code = NULL, updated_at = ?
      WHERE id = ? AND claim_token = ? AND state = 'processing' AND stage = 'model_completed'
    `).run(resultJson, new Date().toISOString(), jobId, claimToken);
    if (result.changes !== 1) throw new WorkflowError('job_stage_conflict', true);
  }

  fail(jobId: string, claimToken: string, code: string): void {
    if (!/^[a-z0-9_]{1,160}$/.test(code)) throw new WorkflowError('unsafe_error_code');
    const result = this.database.prepare(`
      UPDATE jobs SET state = 'failed', stage = 'failed', error_code = ?, claim_token = NULL, updated_at = ?
      WHERE id = ? AND claim_token = ? AND state = 'processing'
    `).run(code, new Date().toISOString(), jobId, claimToken);
    if (result.changes !== 1) throw new WorkflowError('job_stage_conflict', true);
  }

  recoverInterruptedJobs(): number {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE jobs SET state = 'failed', stage = 'failed', error_code = 'interrupted_process_recovery',
        claim_token = NULL, updated_at = ? WHERE state = 'processing'
    `).run(now);
    return Number(result.changes);
  }

  overview(limit = 20): JobOverview {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkflowError('invalid_job_overview_limit');
    const counts = { ready: 0, processing: 0, completed: 0, failed: 0 };
    const countRows = this.database.prepare('SELECT state, COUNT(*) AS count FROM jobs GROUP BY state')
      .all() as unknown as Array<{ state: keyof typeof counts; count: number }>;
    for (const row of countRows) {
      if (row.state in counts && Number.isSafeInteger(row.count)) counts[row.state] = row.count;
    }
    const rows = this.database.prepare(`
      SELECT id, state, stage, attempts, filename, error_code, created_at, updated_at
      FROM jobs ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(limit) as unknown as JobSummaryRow[];
    const latest = this.database.prepare(`
      SELECT id FROM jobs WHERE state = 'completed' ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get() as { id: string } | undefined;
    return {
      counts,
      latestCompletedJobId: latest?.id ?? null,
      recent: rows.map(row => ({
        id: row.id,
        state: row.state,
        stage: row.stage,
        attempts: row.attempts,
        filename: row.filename,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  }

  result(jobId: string): unknown | null {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new WorkflowError('invalid_result_job_id');
    const row = this.database.prepare('SELECT result_json FROM jobs WHERE id = ? AND state = \'completed\'')
      .get(jobId) as { result_json: string | null } | undefined;
    if (!row?.result_json) return null;
    try {
      return JSON.parse(row.result_json) as unknown;
    } catch {
      throw new WorkflowError('invalid_stored_result');
    }
  }

  state(jobId: string): StoredJobState | null {
    if (!/^[a-f0-9]{64}$/.test(jobId)) throw new WorkflowError('invalid_result_job_id');
    const row = this.database.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(jobId) as
      { state: JobSummary['state']; attempts: number } | undefined;
    return row === undefined ? null : { state: row.state, attempts: row.attempts };
  }
}
