import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Telnyx from 'telnyx';
import {
  downloadAttachment,
  type AttachmentMetadata,
  type SupportedInvoiceContentType,
} from './attachment.ts';
import { refreshAccountingResult, type BookkeepingPolicy } from './bookkeeping.ts';
import { errorCode, WorkflowError } from './errors.ts';
import {
  type BatchConfiguration,
  type BatchOverview,
  type JobOverview,
  JobStore,
} from './job-store.ts';
import { renderInspectableResult } from './result.ts';
import { jobIdentity, processClaimedJob, type SyntheticAnswerKey } from './slice.ts';
import {
  extractWithTelnyxModel,
  listInboxMessages,
  selectSingleInvoiceAttachment,
  type InboxMessage,
  type ModelExtractionRun,
} from './telnyx-adapter.ts';
import type { DownloadedAttachment } from './attachment.ts';
import type { PdfTextPage } from './extraction.ts';
import { prepareVisualPages } from './visual-document.ts';
import type { SliceVisualModelRun } from './slice.ts';
import { transcribeVisualWithTelnyxModel } from './telnyx-vision.ts';

type LocalTelnyxClient = Pick<Telnyx, 'emailInboxes' | 'ai'>;
type AgentPhase = 'starting' | 'waiting' | 'polling' | 'processing' | 'ready' | 'error' | 'stopped';

export interface LocalAgentOptions {
  client: LocalTelnyxClient;
  store: JobStore;
  privateDirectory: string;
  inboxId: string;
  subjectFilter: string | null;
  modelId: string;
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  allowedHosts: ReadonlySet<string>;
  policy: BookkeepingPolicy;
  answerKey: SyntheticAnswerKey | null;
  maxNewJobsPerPoll?: number;
  maxJobAttempts?: number;
  loadAttachment?: (attachment: AttachmentMetadata) => Promise<DownloadedAttachment>;
  extractText?: (bytes: Uint8Array) => Promise<PdfTextPage[]>;
  runModel?: (pages: readonly PdfTextPage[]) => Promise<ModelExtractionRun>;
  runVisualModel?: (
    bytes: Uint8Array,
    contentType: SupportedInvoiceContentType,
  ) => Promise<SliceVisualModelRun>;
  now?: () => Date;
}

export interface LocalAgentStatus {
  running: boolean;
  phase: AgentPhase;
  lastPolledAt: string | null;
  lastCompletedJobId: string | null;
  lastError: string | null;
  recoveredInterruptedJobs: number;
  lastPoll: LocalPollResult | null;
  jobs: JobOverview;
  batch: BatchOverview | null;
  batches: BatchOverview[];
}

export interface LocalPollResult {
  status: 'complete' | 'idle' | 'error';
  inspectedMessages: number;
  claimedJobs: number;
  completedJobIds: string[];
  skippedUnsupportedMessages: number;
  lastError: string | null;
}

function iso(date: Date): string {
  return date.toISOString();
}

function safeTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export class LocalBookkeepingAgent {
  private readonly options: Required<Pick<LocalAgentOptions, 'maxNewJobsPerPoll' | 'maxJobAttempts' | 'now'>> &
    Omit<LocalAgentOptions, 'maxNewJobsPerPoll' | 'maxJobAttempts' | 'now'>;
  private phase: AgentPhase = 'starting';
  private lastPolledAt: string | null = null;
  private lastCompletedJobId: string | null = null;
  private lastError: string | null = null;
  private running = true;
  private activePoll: Promise<LocalPollResult> | null = null;
  private readonly recoveredInterruptedJobs: number;
  private lastPoll: LocalPollResult | null = null;

  constructor(options: LocalAgentOptions) {
    const maxNewJobsPerPoll = options.maxNewJobsPerPoll ?? 1;
    const maxJobAttempts = options.maxJobAttempts ?? 1;
    if (!Number.isSafeInteger(maxNewJobsPerPoll) || maxNewJobsPerPoll < 1 || maxNewJobsPerPoll > 10 ||
        !Number.isSafeInteger(maxJobAttempts) || maxJobAttempts < 1 || maxJobAttempts > 5) {
      throw new WorkflowError('invalid_local_agent_limits');
    }
    this.options = { ...options, maxNewJobsPerPoll, maxJobAttempts, now: options.now ?? (() => new Date()) };
    this.recoveredInterruptedJobs = options.store.recoverInterruptedJobs();
    this.phase = 'waiting';
  }

  status(): LocalAgentStatus {
    const jobs = this.options.store.overview();
    const batches = this.options.store.batchHistory();
    return {
      running: this.running,
      phase: this.phase,
      lastPolledAt: this.lastPolledAt,
      lastCompletedJobId: this.lastCompletedJobId ?? jobs.latestCompletedJobId,
      lastError: this.lastError,
      recoveredInterruptedJobs: this.recoveredInterruptedJobs,
      lastPoll: this.lastPoll,
      jobs,
      batch: batches[0] ?? null,
      batches,
    };
  }

  result(jobId: string): unknown | null {
    const stored = this.options.store.result(jobId);
    return stored === null ? null : refreshAccountingResult(stored, this.options.policy);
  }

  configureBatch(configuration: BatchConfiguration): BatchOverview {
    return this.options.store.configureActiveBatch(configuration);
  }

  closeBatch(): BatchOverview | null {
    return this.options.store.closeActiveBatch();
  }

  pollOnce(): Promise<LocalPollResult> {
    if (!this.running) return Promise.reject(new WorkflowError('local_agent_stopped'));
    if (this.activePoll !== null) return this.activePoll;
    const poll = this.runPoll().finally(() => {
      if (this.activePoll === poll) this.activePoll = null;
    });
    this.activePoll = poll;
    return poll;
  }

  private async runPoll(): Promise<LocalPollResult> {
    this.phase = 'polling';
    this.lastError = null;
    const completedJobIds: string[] = [];
    let claimedJobs = 0;
    let skippedUnsupportedMessages = 0;
    try {
      const messages = await listInboxMessages(
        this.options.client,
        this.options.inboxId,
        this.options.subjectFilter,
      );
      messages.sort((left, right) => safeTimestamp(left.receivedAt) - safeTimestamp(right.receivedAt) ||
        left.id.localeCompare(right.id));
      for (const message of messages) {
        const receiptSourceKey = `telnyx-email:${message.inboxId}:${message.id}`;
        let attachment: ReturnType<typeof selectSingleInvoiceAttachment>;
        try {
          attachment = selectSingleInvoiceAttachment(message);
        } catch (error) {
          if (['invoice_attachment_not_found', 'multiple_invoice_attachments']
            .includes(errorCode(error))) {
            this.options.store.recordInboxReceipt({
              sourceKey: receiptSourceKey, inboxId: message.inboxId, messageId: message.id,
              receivedAt: message.receivedAt, classification: 'unsupported', reasonCode: errorCode(error),
            });
            skippedUnsupportedMessages++;
            continue;
          }
          throw error;
        }
        this.options.store.recordInboxReceipt({
          sourceKey: receiptSourceKey, inboxId: message.inboxId, messageId: message.id,
          receivedAt: message.receivedAt, classification: 'supported', reasonCode: null,
        });
        const sourceKey = `telnyx-email:${message.inboxId}:${message.id}:${attachment.index}`;
        const id = jobIdentity(sourceKey);
        const claim = this.options.store.claim({
          id,
          sourceKey,
          inboxId: message.inboxId,
          messageId: message.id,
          attachmentIndex: attachment.index,
          filename: attachment.filename,
        }, this.options.maxJobAttempts);
        if (claim.outcome === 'duplicate_completed') continue;
        if (claim.outcome === 'already_processing' || claim.outcome === 'retry_exhausted') continue;
        claimedJobs++;
        this.phase = 'processing';
        try {
          const completed = await processClaimedJob({
            store: this.options.store,
            claim,
            mode: 'live_telnyx',
            inboxId: message.inboxId,
            messageId: message.id,
            receivedAt: message.receivedAt,
            filename: attachment.filename,
            contentType: attachment.contentType,
            declaredSha256: attachment.declaredSha256,
            declaredSize: attachment.declaredSize,
            privateDirectory: this.options.privateDirectory,
            policy: this.options.policy,
            answerKey: this.options.answerKey,
            loadAttachment: () => this.options.loadAttachment === undefined ?
              downloadAttachment(attachment, { allowedHosts: this.options.allowedHosts }) :
              this.options.loadAttachment(attachment),
            ...(this.options.extractText === undefined ? {} : { extractText: this.options.extractText }),
            runModel: pages => this.options.runModel === undefined ?
              extractWithTelnyxModel(this.options.client, this.options.modelId, pages, {
                reasoningEffort: this.options.reasoningEffort,
              }) : this.options.runModel(pages),
            runVisualModel: async (bytes, contentType) => {
              if (this.options.runVisualModel !== undefined) {
                return this.options.runVisualModel(bytes, contentType);
              }
              const images = await prepareVisualPages(bytes, contentType);
              const visual = await transcribeVisualWithTelnyxModel(
                this.options.client,
                this.options.modelId,
                images,
                { reasoningEffort: this.options.reasoningEffort },
              );
              const extraction = await extractWithTelnyxModel(this.options.client, this.options.modelId,
                visual.pages, { reasoningEffort: this.options.reasoningEffort });
              return { ...extraction, pages: visual.pages };
            },
          });
          completedJobIds.push(claim.jobId);
          this.lastCompletedJobId = claim.jobId;
          // A completed result that requires review is still a successful workflow run.
          // The result decision carries the financial state; `error` is for processing failures.
          this.phase = 'ready';
        } catch (error) {
          this.lastError = errorCode(error);
          this.phase = 'error';
        }
        if (claimedJobs >= this.options.maxNewJobsPerPoll) break;
      }
      this.lastPolledAt = iso(this.options.now());
      if (claimedJobs === 0) this.phase = this.lastError === null ? 'waiting' : 'error';
      const result: LocalPollResult = {
        status: this.lastError !== null ? 'error' : completedJobIds.length ? 'complete' : 'idle',
        inspectedMessages: messages.length,
        claimedJobs,
        completedJobIds,
        skippedUnsupportedMessages,
        lastError: this.lastError,
      };
      this.lastPoll = result;
      return result;
    } catch (error) {
      this.lastError = errorCode(error);
      this.lastPolledAt = iso(this.options.now());
      this.phase = 'error';
      const result: LocalPollResult = {
        status: 'error', inspectedMessages: 0, claimedJobs, completedJobIds,
        skippedUnsupportedMessages, lastError: this.lastError,
      };
      this.lastPoll = result;
      return result;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.activePoll !== null) await this.activePoll;
    this.phase = 'stopped';
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

export function hasLocalAgentAuthorization(request: IncomingMessage, controlToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return false;
  if (header.startsWith('Bearer ')) return constantTimeTextEqual(header.slice(7), controlToken);
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  return separator >= 0 && constantTimeTextEqual(decoded.slice(0, separator), 'review') &&
    constantTimeTextEqual(decoded.slice(separator + 1), controlToken);
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, securityHeaders('application/json; charset=utf-8'));
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function oneFormValue(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1) throw new WorkflowError('invalid_batch_form');
  return values[0]!;
}

export function parseBatchForm(form: URLSearchParams): BatchConfiguration {
  const label = oneFormValue(form, 'label');
  const expectedCountText = oneFormValue(form, 'expected_count');
  const manifestText = oneFormValue(form, 'expected_manifest');
  if (!/^\d{1,5}$/.test(expectedCountText) || manifestText.length > 100_000) {
    throw new WorkflowError('invalid_batch_form');
  }
  const lines = manifestText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const expectedManifest = lines.length === 0 ? null : lines.map(line => {
    const pieces = line.split('|');
    if (pieces.length !== 2 || !pieces[0]!.trim() || !pieces[1]!.trim()) {
      throw new WorkflowError('invalid_batch_manifest_line');
    }
    return { supplierName: pieces[0]!.trim(), invoiceNumber: pieces[1]!.trim() };
  });
  return {
    label,
    expectedCount: Number(expectedCountText),
    expectedManifest,
    includeUnassignedJobs: form.getAll('include_unassigned').length === 1 &&
      form.get('include_unassigned') === 'on',
  };
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new WorkflowError('invalid_form_content_type');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 120_000) throw new WorkflowError('form_too_large');
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function displayReference(reference: string): string {
  try {
    const parsed = JSON.parse(reference) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string')) {
      return `${parsed[0]} / ${parsed[1]}`;
    }
  } catch {
    // Fall through to a privacy-safe invalid marker for corrupt stored state.
  }
  return '[invalid reference]';
}

function humanizeStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function dashboardTone(value: string): 'positive' | 'warning' | 'neutral' | 'active' {
  if (['completed', 'ready', 'manifest_match'].includes(value)) return 'positive';
  if (['failed', 'error', 'needs_review', 'incomplete'].includes(value)) return 'warning';
  if (['polling', 'processing', 'starting'].includes(value)) return 'active';
  return 'neutral';
}

function dashboardBadge(value: string, label?: string): string {
  return `<span class="badge ${dashboardTone(value)}"><span></span>${escapeHtml(label ?? humanizeStatus(value))}</span>`;
}

export function renderLocalAgentHome(status: LocalAgentStatus, csrfToken: string): string {
  const rows = status.jobs.recent.map(job => `<tr>
    <td><div class="file-cell"><span class="file-icon">${escapeHtml(job.filename.slice(0, 1).toUpperCase() || 'I')}</span><div><strong>${escapeHtml(job.filename)}</strong><small>${escapeHtml(job.id.slice(0, 12))}…</small></div></div></td>
    <td>${dashboardBadge(job.state)}</td>
    <td><span class="stage">${escapeHtml(humanizeStatus(job.stage))}</span></td>
    <td>${job.attempts}</td>
    <td>${job.errorCode === null ? '<span class="muted">—</span>' : `<code>${escapeHtml(job.errorCode)}</code>`}</td>
    <td class="row-action">${job.state === 'completed' ? `<a class="view-link" href="/results/${job.id}">Review result <span>→</span></a>` : '<span class="muted">Not available</span>'}</td>
  </tr>`).join('');
  const scan = status.lastPoll === null ? 'No inbox scan has completed yet.' :
    `Last scan: ${status.lastPoll.inspectedMessages} message(s) inspected, ${status.lastPoll.claimedJobs} new job(s) claimed, ${status.lastPoll.completedJobIds.length} completed, ${status.lastPoll.skippedUnsupportedMessages} unsupported.`;
  const batch = status.batch;
  const editable = batch?.state === 'active' ? batch : null;
  const manifestText = editable?.expectedManifest?.map(entry =>
    `${entry.supplierName} | ${entry.invoiceNumber}`).join('\n') ?? '';
  const missing = batch?.completeness.missingReferences.map(displayReference) ?? [];
  const unexpected = batch?.completeness.unexpectedReferences.map(displayReference) ?? [];
  const previousBatches = (status.batches ?? (batch === null ? [] : [batch]))
    .filter(item => item.state === 'closed' && item.id !== batch?.id);
  const historyRows = previousBatches.map(item => `<tr>
    <td><strong>${escapeHtml(item.label)}</strong><small>Closed ${escapeHtml(item.closedAt ?? 'date not recorded')}</small></td>
    <td>${dashboardBadge(item.completeness.status)}</td>
    <td><strong>${item.completeness.uniqueReceived} of ${item.expectedCount}</strong><small>${escapeHtml(humanizeStatus(item.completeness.countState))} count</small></td>
    <td>${item.jobs.completed}</td>
    <td>${item.jobs.failed}</td>
    <td>${item.expectedManifest === null ? 'Count only' : 'Exact manifest'}</td>
  </tr>`).join('');
  const batchSummary = batch === null ?
    `<div class="empty-state"><span class="empty-icon">0</span><strong>No active batch</strong><p>Expected count and exact completeness remain unknown until you configure this quarter.</p></div>` :
    `<div class="batch-title"><div><strong>${escapeHtml(batch.label)}</strong><small>${escapeHtml(humanizeStatus(batch.state))} batch</small></div>${dashboardBadge(batch.completeness.status)}</div>
    <div class="batch-progress"><div class="progress-ring"><strong>${batch.completeness.uniqueReceived}</strong><span>of ${batch.expectedCount}</span></div><div><strong>${escapeHtml(humanizeStatus(batch.completeness.countState))} count</strong><p>${batch.expectedManifest === null ? 'Count-only basis — invoice identities are not verified.' : 'Checked against the expected vendor and invoice manifest.'}</p></div></div>
    <dl class="batch-details">
      <div><dt>Completed</dt><dd>${batch.jobs.completed}</dd></div>
      <div><dt>Processing</dt><dd>${batch.jobs.processing}</dd></div>
      <div><dt>Failed</dt><dd>${batch.jobs.failed}</dd></div>
      <div><dt>Unresolved</dt><dd>${batch.jobs.unresolved}</dd></div>
      <div><dt>Unsupported receipts</dt><dd>${batch.jobs.unsupportedReceipts}</dd></div>
      <div><dt>Identity basis</dt><dd>${batch.expectedManifest === null ? 'Expected count only' : 'Exact manifest'}</dd></div>
    </dl>
    ${(missing.length || unexpected.length || batch.completeness.issues.length) ? `<div class="batch-issues"><strong>Needs review</strong><p>${escapeHtml([
      missing.length ? `Missing: ${missing.join(', ')}` : '',
      unexpected.length ? `Unexpected: ${unexpected.join(', ')}` : '',
      batch.completeness.issues.length ? `Issues: ${batch.completeness.issues.map(humanizeStatus).join(', ')}` : '',
    ].filter(Boolean).join(' · '))}</p></div>` : ''}`;
  const closeForm = batch?.state === 'active' ?
    `<form method="post" action="/control/batch/close"><input type="hidden" name="_csrf" value="${csrfToken}"><button class="button secondary" type="submit">Close batch</button></form>` : '';
  const totalJobs = status.jobs.counts.ready + status.jobs.counts.processing +
    status.jobs.counts.completed + status.jobs.counts.failed;
  const latestResult = status.lastCompletedJobId === null ? '' :
    `<a class="button secondary latest-link" href="/results/${status.lastCompletedJobId}">Open latest result <span>→</span></a>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Telnyx bookkeeping review</title>
<style>
:root{color-scheme:light;--ink:#17211b;--muted:#66736a;--paper:#fbfaf6;--card:#fff;--line:#e5e8e3;--green:#176b45;--green-soft:#e7f3ec;--amber:#9a5a0a;--amber-soft:#fff3d9;--blue:#325b9c;--blue-soft:#edf2fa;--shadow:0 10px 30px rgba(26,45,34,.06)}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}.topbar{height:68px;padding:0 clamp(20px,4vw,56px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:rgba(251,250,246,.92)}.brand{display:flex;align-items:center;gap:10px;letter-spacing:-.01em}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--ink);color:#fff;font-weight:800}.brand b{font-weight:650}.secure-label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.secure-label span{width:7px;height:7px;border-radius:50%;background:#2aa36b;box-shadow:0 0 0 4px var(--green-soft)}main{width:min(1180px,calc(100% - 40px));margin:0 auto;padding:44px 0 70px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:30px;margin-bottom:28px}.eyebrow{margin:0 0 8px;color:var(--green);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{margin:0;font-size:clamp(34px,5vw,52px);line-height:1.02;letter-spacing:-.045em}.hero-copy{max-width:650px;margin:13px 0 0;color:var(--muted);font-size:16px}.hero-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.button{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:42px;padding:0 16px;border:1px solid var(--ink);border-radius:11px;background:var(--ink);color:#fff;font:inherit;font-weight:750;text-decoration:none;cursor:pointer}.button:hover{background:#2b3830}.button.secondary{border-color:var(--line);background:#fff;color:var(--ink)}.button.secondary:hover{background:#f6f7f4}.latest-link span,.view-link span{transition:transform .15s ease}.latest-link:hover span,.view-link:hover span{transform:translateX(2px)}.notice{display:flex;align-items:flex-start;gap:11px;margin-bottom:18px;padding:13px 15px;border:1px solid #ecd9aa;border-radius:13px;background:#fff8e9;color:#70470e}.notice span{display:grid;place-items:center;flex:0 0 22px;width:22px;height:22px;border-radius:50%;background:#f4d58a;font-weight:800}.notice p{margin:0;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metric{padding:18px 20px;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}.metric span{display:block;color:var(--muted);font-size:12px;font-weight:700}.metric strong{display:block;margin-top:5px;font-size:28px;line-height:1.15;letter-spacing:-.03em}.metric small{color:var(--muted)}.card{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:20px}.section-heading h2{margin:0;font-size:21px;letter-spacing:-.025em}.section-heading p{margin:5px 0 0;color:var(--muted);font-size:13px}.batch-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:16px;margin-bottom:18px}.batch-card,.form-card{padding:24px}.batch-title{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.batch-title strong{display:block;font-size:20px}.batch-title small{display:block;margin-top:3px;color:var(--muted)}.batch-progress{display:flex;align-items:center;gap:18px;margin:25px 0}.batch-progress p{margin:4px 0 0;color:var(--muted);font-size:12px}.progress-ring{display:grid;place-items:center;flex:0 0 72px;height:72px;border:7px solid var(--green-soft);border-top-color:var(--green);border-radius:50%}.progress-ring strong{font-size:21px;line-height:1}.progress-ring span{font-size:10px;color:var(--muted)}.batch-details{display:grid;grid-template-columns:repeat(2,1fr);margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}.batch-details>div{padding:11px 13px;border-bottom:1px solid var(--line)}.batch-details>div:nth-last-child(-n+2){border-bottom:0}.batch-details>div:nth-child(odd){border-right:1px solid var(--line)}.batch-details dt{color:var(--muted);font-size:11px}.batch-details dd{margin:2px 0 0;font-weight:700}.batch-issues{margin-top:14px;padding:11px 13px;border-radius:10px;color:var(--amber);background:var(--amber-soft);font-size:12px}.batch-issues p{margin:2px 0 0}.empty-state{display:grid;place-items:center;text-align:center;min-height:265px;padding:20px}.empty-icon{display:grid;place-items:center;width:64px;height:64px;margin-bottom:12px;border-radius:50%;background:#f1f4f1;color:var(--muted);font-size:22px;font-weight:750}.empty-state strong{font-size:18px}.empty-state p{max-width:320px;margin:6px 0;color:var(--muted)}label{display:block;margin-bottom:14px;color:#354138;font-size:12px;font-weight:750}input,textarea{display:block;width:100%;margin-top:6px;padding:10px 11px;border:1px solid #d8ded9;border-radius:9px;background:#fff;color:var(--ink);font:inherit;line-height:1.45;outline:none}input:focus,textarea:focus{border-color:#5a8a6e;box-shadow:0 0 0 3px var(--green-soft)}textarea{resize:vertical;min-height:96px}.form-row{display:grid;grid-template-columns:1.5fr .7fr;gap:12px}.hint{margin:-5px 0 14px;color:var(--muted);font-size:11px}.checkbox{display:flex;align-items:flex-start;gap:9px;color:var(--muted);font-weight:500;line-height:1.4}.checkbox input{width:auto;margin:2px 0 0}.form-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.jobs-card{overflow:hidden}.jobs-card .section-heading{padding:23px 24px 0}.table-wrap{overflow-x:auto;padding:0 12px 12px}table{width:100%;border-collapse:collapse}th{padding:11px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.07em;text-align:left;text-transform:uppercase}td{padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:middle}tbody tr:last-child td{border-bottom:0}.file-cell{display:flex;align-items:center;gap:11px;min-width:210px}.file-icon{display:grid;place-items:center;flex:0 0 34px;width:34px;height:34px;border-radius:9px;background:var(--blue-soft);color:var(--blue);font-weight:800}.file-cell strong{display:block}.file-cell small{display:block;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;align-items:center;gap:7px;width:max-content;padding:5px 9px;border-radius:999px;font-size:11px;font-weight:750;white-space:nowrap}.badge span{width:6px;height:6px;border-radius:50%;background:currentColor}.badge.positive{color:var(--green);background:var(--green-soft)}.badge.warning{color:var(--amber);background:var(--amber-soft)}.badge.active{color:var(--blue);background:var(--blue-soft)}.badge.neutral{color:#58645b;background:#eef1ee}.stage{color:var(--muted);font-size:12px}.muted{color:#98a19b}.view-link{display:inline-flex;align-items:center;gap:8px;color:var(--green);font-size:12px;font-weight:800;text-decoration:none;white-space:nowrap}.row-action{text-align:right}code{padding:3px 6px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-size:11px}.scan-summary{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.scan-summary span{width:6px;height:6px;border-radius:50%;background:#8c9a90}
.history-card{margin-bottom:18px;overflow:hidden}.history-card .section-heading{padding:23px 24px 0}.history-card td:first-child{min-width:220px}.history-card td strong,.history-card td small{display:block}.history-card td small{margin-top:3px;color:var(--muted);font-size:11px}
@media(max-width:860px){.hero{align-items:flex-start;flex-direction:column}.hero-actions{justify-content:flex-start}.metrics{grid-template-columns:repeat(2,1fr)}.batch-grid{grid-template-columns:1fr}}
@media(max-width:560px){.topbar{height:60px;padding:0 18px}.secure-label{font-size:0}.secure-label::after{content:'Private';font-size:12px}.brand b{display:none}main{width:min(100% - 28px,1180px);padding-top:28px}.hero h1{font-size:38px}.hero-actions,.hero-actions form,.hero-actions .button{width:100%}.metrics{grid-template-columns:repeat(2,1fr);gap:10px}.metric{padding:15px}.batch-card,.form-card{padding:18px}.form-row{grid-template-columns:1fr}.batch-details{grid-template-columns:1fr}.batch-details>div,.batch-details>div:nth-last-child(-n+2){border-bottom:1px solid var(--line)!important;border-right:0!important}.batch-details>div:last-child{border-bottom:0!important}.jobs-card .section-heading{padding:19px 18px 0}.table-wrap{padding:0 6px 8px}}
</style></head><body>
<header class="topbar"><div class="brand"><span class="brand-mark">T</span><span>Telnyx <b>Bookkeeping</b></span></div><div class="secure-label"><span></span>Private review workspace</div></header>
<main>
  <section class="hero"><div><p class="eyebrow">Invoice operations</p><h1>Bookkeeping review</h1><p class="hero-copy">Receive invoice documents, inspect extracted fields, and review independently reconciled accounting proposals.</p></div><div class="hero-actions">${latestResult}<form method="post" action="/control/poll"><input type="hidden" name="_csrf" value="${csrfToken}"><button class="button" type="submit">Process inbox now <span>↗</span></button></form></div></section>
  <div class="notice"><span>!</span><p><strong>Human review only.</strong> Nothing is posted, paid, filed, or emailed from this workspace.</p></div>
  <section class="metrics" aria-label="Job summary">
    <article class="metric"><span>All jobs</span><strong>${totalJobs}</strong><small>${dashboardBadge(status.phase)}</small></article>
    <article class="metric"><span>Completed</span><strong>${status.jobs.counts.completed}</strong><small>Ready to inspect</small></article>
    <article class="metric"><span>In progress</span><strong>${status.jobs.counts.processing + status.jobs.counts.ready}</strong><small>Ready or processing</small></article>
    <article class="metric"><span>Failed</span><strong>${status.jobs.counts.failed}</strong><small>${status.lastError === null ? 'No active error' : escapeHtml(status.lastError)}</small></article>
  </section>
  <div class="section-heading"><div><p class="eyebrow">Completeness</p><h2>Quarterly completeness batch</h2><p>Compare received invoices with a trusted expected count or exact manifest.</p></div><div class="scan-summary"><span></span>${escapeHtml(scan)}</div></div>
  <section class="batch-grid">
    <article class="card batch-card">${batchSummary}</article>
    <article class="card form-card"><div class="section-heading"><div><h2>${editable === null ? 'Start a batch' : 'Update active batch'}</h2><p>Operator-supplied expectations only.</p></div></div>
      <form method="post" action="/control/batch"><input type="hidden" name="_csrf" value="${csrfToken}">
        <div class="form-row"><label>Batch / quarter label<input name="label" maxlength="200" required value="${escapeHtml(editable?.label ?? '')}" placeholder="2026 Q3"></label><label>Expected count<input name="expected_count" type="number" min="0" max="10000" required value="${editable?.expectedCount ?? ''}" placeholder="0"></label></div>
        <label>Exact manifest <span class="muted">(optional)</span><textarea name="expected_manifest" rows="4" placeholder="Vendor name | Invoice number">${escapeHtml(manifestText)}</textarea></label>
        <p class="hint">One vendor and invoice number per line. Without a manifest, a matching total is labelled count-only—not exact completeness.</p>
        <label class="checkbox"><input name="include_unassigned" type="checkbox"><span>Include existing unassigned supported invoice jobs. Prior unsupported test emails stay excluded.</span></label>
        <div class="form-actions"><button class="button" type="submit">${editable === null ? 'Start batch' : 'Save changes'}</button></form>${closeForm}</div>
    </article>
  </section>
  ${historyRows ? `<section class="card history-card"><div class="section-heading"><div><p class="eyebrow">Archive</p><h2>Previous batches</h2><p>Closed test runs remain visible after a new batch starts.</p></div></div><div class="table-wrap"><table><thead><tr><th>Batch</th><th>Completeness</th><th>Received</th><th>Completed</th><th>Failed</th><th>Basis</th></tr></thead><tbody>${historyRows}</tbody></table></div></section>` : ''}
  <section class="card jobs-card"><div class="section-heading"><div><p class="eyebrow">Inbox activity</p><h2>Recent invoice jobs</h2><p>Completed jobs open into a full extracted-data and reconciliation review.</p></div></div><div class="table-wrap"><table><thead><tr><th>Attachment / job</th><th>Status</th><th>Stage</th><th>Attempts</th><th>Error</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-state"><strong>No invoice jobs yet</strong><p>Process the inbox to check for a supported PDF, JPEG, or PNG invoice.</p></td></tr>'}</tbody></table></div></section>
</main></body></html>\n`;
}

export function createLocalAgentHandler(agent: LocalBookkeepingAgent, controlToken: string) {
  if (controlToken.length < 32 || controlToken.length > 512) throw new WorkflowError('invalid_local_control_token');
  const csrfToken = createHmac('sha256', controlToken).update('local-bookkeeping-form-v1').digest('hex');
  const verifiedForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
    const form = await readForm(request);
    const supplied = form.getAll('_csrf');
    if (supplied.length !== 1 || !constantTimeTextEqual(supplied[0]!, csrfToken)) {
      throw new WorkflowError('csrf_rejected');
    }
    form.delete('_csrf');
    return form;
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ready', service: 'telnyx-bookkeeping-local-agent' });
      return;
    }
    if (!hasLocalAgentAuthorization(request, controlToken)) {
      response.writeHead(401, { ...securityHeaders('application/json; charset=utf-8'),
        'www-authenticate': 'Basic realm="Bookkeeping review", charset="UTF-8"' });
      response.end('{"error":"unauthorized"}\n');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, securityHeaders('text/html; charset=utf-8'));
      response.end(renderLocalAgentHome(agent.status(), csrfToken));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      sendJson(response, 200, agent.status());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/control/poll') {
      try {
        await verifiedForm(request);
        const result = await agent.pollOnce();
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' });
        response.end(JSON.stringify(result));
      } catch (error) {
        sendJson(response, errorCode(error) === 'csrf_rejected' ? 403 : 400, { error: errorCode(error) });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/control/batch') {
      try {
        const form = await verifiedForm(request);
        agent.configureBatch(parseBatchForm(form));
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' });
        response.end();
      } catch (error) {
        sendJson(response, errorCode(error) === 'csrf_rejected' ? 403 : 400, { error: errorCode(error) });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/control/batch/close') {
      try {
        await verifiedForm(request);
        agent.closeBatch();
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' });
        response.end();
      } catch (error) {
        sendJson(response, errorCode(error) === 'csrf_rejected' ? 403 : 400, { error: errorCode(error) });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/results/')) {
      const jobId = url.pathname.slice('/results/'.length);
      try {
        const result = agent.result(jobId);
        if (result === null) {
          sendJson(response, 404, { error: 'result_not_found' });
          return;
        }
        response.writeHead(200, securityHeaders('text/html; charset=utf-8'));
        response.end(renderInspectableResult(result));
      } catch (error) {
        sendJson(response, 400, { error: errorCode(error) });
      }
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  };
}
