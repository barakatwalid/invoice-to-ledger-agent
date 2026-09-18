import type {
  EdgeAgentStatus,
  EdgeBatchOverview,
  EdgeInboxMonitor,
  EdgeJobSummary,
} from './bookkeeping-agent.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function plain(value: unknown, fallback = 'Not available'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function sourced(source: unknown): string | null {
  if (!record(source)) return null;
  return typeof source.value === 'string' && source.value.trim() ? source.value : null;
}

function humanize(value: unknown): string {
  return plain(value, 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function display(value: string | null, fallback = 'Not extracted'): string {
  return escapeHtml(value ?? fallback);
}

function safeDate(value: unknown): string {
  if (typeof value !== 'string') return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-AE', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dubai',
  }).format(date);
}

function displayReference(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(item => typeof item === 'string')) {
      return `${parsed[0]} · ${parsed[1]}`;
    }
  } catch {
    // Fall back to the safely escaped stored reference.
  }
  return value;
}

function completenessCopy(batch: EdgeBatchOverview): string {
  switch (batch.completeness.status) {
    case 'manifest_match': return 'All expected invoice identities confirmed';
    case 'count_match_only': return 'Expected count received; identity list not supplied';
    case 'incomplete': return 'More invoices are expected';
    case 'needs_review': return 'Batch needs review';
    default: return 'Completeness is not yet known';
  }
}

function batchPanel(batch: EdgeBatchOverview | null): string {
  if (batch === null) {
    return `<section class="card section batch-card"><div class="section-title"><div>
      <p class="eyebrow">Step 1 · Completeness</p><h2>No batch configured</h2></div><span class="pill neutral"><i></i>Unknown</span></div>
      <p class="intro">Configure the expected invoice count—or the exact supplier and invoice-number list—through the protected operator control. Until then, the system cannot honestly confirm it found all invoices.</p></section>`;
  }
  const completion = batch.completeness;
  const confirmed = completion.status === 'manifest_match' || completion.status === 'count_match_only';
  const problems = [
    ...completion.missingReferences.map(value => `Missing: ${displayReference(value)}`),
    ...completion.unexpectedReferences.map(value => `Unexpected: ${displayReference(value)}`),
    ...completion.issues.map(value => humanize(value)),
  ];
  return `<section class="card section batch-card"><div class="section-title"><div>
      <p class="eyebrow">Step 1 · Completeness</p><h2>${escapeHtml(batch.label)}</h2></div>
      <span class="pill ${confirmed ? 'good' : 'warning'}"><i></i>${escapeHtml(humanize(completion.status))}</span></div>
    <p class="batch-verdict"><b>${escapeHtml(completenessCopy(batch))}</b><span>${completion.uniqueReceived} of ${batch.expectedCount} unique invoice${batch.expectedCount === 1 ? '' : 's'} received</span></p>
    <div class="stat-grid">
      <div class="stat"><span>Received</span><b>${completion.uniqueReceived} / ${batch.expectedCount}</b></div>
      <div class="stat"><span>Completed</span><b>${batch.jobs.completed}</b></div>
      <div class="stat"><span>Processing / pending</span><b>${batch.jobs.processing} / ${batch.jobs.pending}</b></div>
      <div class="stat"><span>Failed</span><b>${batch.jobs.failed}</b></div>
      <div class="stat"><span>Unresolved PDFs</span><b>${batch.jobs.unresolved}</b></div>
      <div class="stat"><span>Unsupported emails</span><b>${batch.jobs.unsupportedReceipts}</b></div>
    </div>
    <p class="batch-basis">${batch.expectedManifest === null ?
      'Count-based check only. Exact invoice identity completeness remains unconfirmed.' :
      `Exact manifest check using ${batch.expectedManifest.length} supplier + invoice-number reference${batch.expectedManifest.length === 1 ? '' : 's'}.`}
      Batch ${escapeHtml(batch.state)} · opened ${escapeHtml(safeDate(batch.startedAt))}${batch.closedAt === null ? '' : ` · closed ${escapeHtml(safeDate(batch.closedAt))}`}</p>
    ${problems.length === 0 ? '' : `<ul class="issue-list">${problems.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`}
  </section>`;
}

function jobHistory(jobs: readonly EdgeJobSummary[]): string {
  const rows = jobs.map(job => {
    const reference = [job.supplierName, job.invoiceNumber].filter(Boolean).join(' · ') || 'Awaiting extraction';
    const amount = job.printedTotal === null ? '—' : `${job.currency ?? ''} ${job.printedTotal}`.trim();
    const state = job.status === 'complete' && job.decision === 'proposal_ready_for_human_review' ?
      'Ready for review' : job.errorCode === null ? humanize(job.status) : `Failed · ${humanize(job.errorCode)}`;
    const action = job.status === 'complete' ?
      `<a class="view-link" href="/invoices/${encodeURIComponent(job.id)}">View</a>` : '—';
    const path = job.processingPath === 'telnyx_vision' ? 'Vision scan' :
      job.processingPath === 'embedded_text' ? 'Embedded text' : '';
    return `<tr><td><strong>${escapeHtml(job.filename ?? 'Invoice document')}</strong><small>${escapeHtml(safeDate(job.receivedAt ?? job.createdAt))}${path ? ` · ${path}` : ''}</small></td>
      <td>${escapeHtml(reference)}</td><td class="amount">${escapeHtml(amount)}</td><td>${escapeHtml(state)}</td><td>${action}</td></tr>`;
  }).join('');
  return `<section class="card section history-card"><div class="section-title"><div><p class="eyebrow">Invoice archive</p><h2>Recent invoices</h2></div>
    <span class="count">${jobs.length} shown</span></div><div class="table-wrap"><table><thead><tr><th>Document</th><th>Supplier · invoice</th><th class="amount">Printed total</th><th>Status</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="empty-row">No invoices have been accepted yet</td></tr>'}</tbody></table></div></section>`;
}

function batchArchive(batches: readonly EdgeBatchOverview[]): string {
  if (batches.length < 2) return '';
  const rows = batches.slice(1).map(batch => `<tr><td><strong>${escapeHtml(batch.label)}</strong><small>${escapeHtml(safeDate(batch.startedAt))}</small></td>
    <td>${escapeHtml(humanize(batch.state))}</td><td>${batch.completeness.uniqueReceived} / ${batch.expectedCount}</td>
    <td>${escapeHtml(humanize(batch.completeness.status))}</td></tr>`).join('');
  return `<section class="card section batch-archive"><div class="section-title"><div><p class="eyebrow">Batch archive</p><h2>Previous completeness checks</h2></div></div>
    <div class="table-wrap"><table><thead><tr><th>Batch</th><th>State</th><th>Received</th><th>Conclusion</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function inboxMonitorPanel(
  status: EdgeAgentStatus,
  monitor: EdgeInboxMonitor | null,
  monitorErrorCode: string | null,
): string {
  if (monitor === null || !monitor.available) {
    const detail = monitorErrorCode === null ? 'The hosted inbox has not been configured yet.' :
      `The read-only inbox snapshot is temporarily unavailable (${humanize(monitorErrorCode)}).`;
    return `<section class="card section monitor-card"><div class="section-title"><div>
      <p class="eyebrow">Live inbox monitor</p><h2>Telnyx intake</h2></div>
      <span class="pill warning"><i></i>Unavailable</span></div>
      <p class="intro">${escapeHtml(detail)} The actor state below remains available and no processing action was triggered.</p>
      <div class="monitor-meta"><span>Agent <b>${status.running ? 'Running' : 'Stopped'}</b></span>
      <span>Last actor poll <b>${escapeHtml(safeDate(status.lastPolledAt))}</b></span></div></section>`;
  }
  const latest = monitor.newestEligible === null ? 'No eligible invoice document received in this monitoring window.' :
    `<b>${escapeHtml(monitor.newestEligible.filename)}</b> received ${escapeHtml(safeDate(monitor.newestEligible.receivedAt))}`;
  return `<section class="card section monitor-card"><div class="section-title"><div>
      <p class="eyebrow">Live inbox monitor</p><h2>Telnyx intake</h2><p>Read-only view of messages received since this hosted intake window started.</p></div>
      <span class="pill ${status.running && status.lastError === null ? 'good' : 'warning'}"><i></i>${status.running ? escapeHtml(humanize(status.phase)) : 'Stopped'}</span></div>
    <div class="monitor-grid">
      <div><span>Received emails</span><b>${monitor.receivedMessages}</b></div>
      <div><span>Eligible documents</span><b>${monitor.eligiblePdfMessages}</b></div>
      <div><span>Known jobs</span><b>${monitor.knownJobs}</b></div>
      <div class="${monitor.waitingJobs > 0 ? 'attention' : ''}"><span>Waiting to claim</span><b>${monitor.waitingJobs}</b></div>
      <div class="${monitor.unsupportedMessages > 0 ? 'attention' : ''}"><span>Unsupported emails</span><b>${monitor.unsupportedMessages}</b></div>
      <div class="${status.jobs.failed > 0 ? 'attention' : ''}"><span>Failed jobs</span><b>${status.jobs.failed}</b></div>
    </div>
    <div class="monitor-latest"><span class="pulse"></span><p>${latest}</p></div>
    <div class="monitor-meta"><span>Last actor poll <b>${escapeHtml(safeDate(status.lastPolledAt))}</b></span>
      <span>Snapshot refreshed <b>${escapeHtml(safeDate(monitor.refreshedAt))}</b></span>
      <span>Scope started <b>${escapeHtml(safeDate(monitor.scopeStartedAt))}</b></span></div>
  </section>`;
}

function guideLink(): string {
  return '<a class="guide-link" href="/how-it-works">How it works <span>→</span></a>';
}

function documentPreview(jobId: string, filename: string, contentType: string): string {
  const source = `/invoices/${jobId}/document`;
  const visual = contentType === 'application/pdf' ?
    `<iframe class="preview-frame" src="${source}" title="Invoice document preview"></iframe>` :
    contentType === 'image/jpeg' || contentType === 'image/png' ?
      `<div class="preview-image-wrap"><img class="preview-image" src="${source}" alt="Invoice document preview"></div>` :
      '<div class="preview-unavailable"><b>Preview unavailable</b><span>The extracted data remains available for review.</span></div>';
  return `<section class="card preview-card"><div class="preview-head"><div><p class="eyebrow">Source document</p>
      <h2>${escapeHtml(filename)}</h2></div><a class="open-document" href="${source}" target="_blank" rel="noreferrer">Open file ↗</a></div>
    <div class="preview-surface">${visual}</div><p class="preview-note">Private, authenticated preview · original Telnyx attachment is not made public</p></section>`;
}

const OMITTED_TECHNICAL_JSON_KEYS = new Set([
  'apikey',
  'authorization',
  'body',
  'downloadurl',
  'inboxid',
  'jobid',
  'messageid',
  'quote',
  'sha256',
  'sourcekey',
  'token',
  'url',
]);

function sanitizeTechnicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTechnicalValue);
  if (record(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!OMITTED_TECHNICAL_JSON_KEYS.has(normalizedKey)) {
        sanitized[key] = sanitizeTechnicalValue(child);
      }
    }
    return sanitized;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function technicalJsonPanel(result: Record<string, unknown>): string {
  const json = JSON.stringify(sanitizeTechnicalValue(result), null, 2);
  return `<details class="technical-json card"><summary><span>View technical JSON</span>
    <small>Sanitized structured result · private URLs, hashes, source quotes and internal identifiers omitted</small></summary>
    <div class="technical-json-body"><pre><code>${escapeHtml(json)}</code></pre></div></details>`;
}

export interface HostedDashboardOptions {
  detailJobId?: string | null;
}

function dashboardBody(
  status: EdgeAgentStatus,
  result: unknown,
  monitor: EdgeInboxMonitor | null,
  monitorErrorCode: string | null,
  options: HostedDashboardOptions,
): string {
  if (!record(result)) {
    return `<main>
      <section class="hero">
        <div><p class="eyebrow">Telnyx Edge · Private review</p><h1>Invoice processing dashboard</h1>
        <p class="lede">The hosted agent is ready. A completed invoice will appear here after processing.</p></div>
        <div class="hero-actions">${guideLink()}<span class="pill neutral"><i></i>${escapeHtml(humanize(status.phase))}</span></div>
      </section>
      <div class="dashboard-layout"><aside class="dashboard-rail">${inboxMonitorPanel(status, monitor, monitorErrorCode)}</aside>
      <div class="dashboard-content">
        ${status.lastError === null ? '' : `<div class="alert">Processing needs attention: ${escapeHtml(humanize(status.lastError))}</div>`}
        <section class="empty-state"><div class="empty-icon">↻</div><h2>No completed invoice yet</h2>
        <p>Completed: ${status.jobs.complete} · Failed: ${status.jobs.failed} · Last poll: ${escapeHtml(safeDate(status.lastPolledAt))}</p></section>
        ${batchPanel(status.batch ?? (status.batches ?? [])[0] ?? null)}
        ${jobHistory(status.recentJobs ?? [])}${batchArchive(status.batches ?? [])}
      </div></div>
    </main>`;
  }

  const extraction = record(result.extraction) ? result.extraction : {};
  const values = record(extraction.values) ? extraction.values : {};
  const intake = record(result.intake) ? result.intake : {};
  const attachment = record(intake.attachment) ? intake.attachment : {};
  const arithmetic = record(result.arithmetic) ? result.arithmetic : {};
  const proposal = record(result.accountingProposal) ? result.accountingProposal : {};
  const controls = record(result.controls) ? result.controls : {};
  const supplier = sourced(values.supplierName);
  const invoiceNumber = sourced(values.invoiceNumber);
  const invoiceDate = sourced(values.invoiceDate);
  const supplierAddress = sourced(values.supplierAddress);
  const taxId = sourced(values.supplierTaxRegistrationId);
  const currency = sourced(values.currency);
  const subtotal = sourced(values.subtotal);
  const tax = sourced(values.tax);
  const total = sourced(values.total);
  const lines = Array.isArray(values.lines) ? values.lines : [];
  const entries = Array.isArray(proposal.entries) ? proposal.entries : [];
  const checks = Array.isArray(arithmetic.checks) ? arithmetic.checks : [];
  const proposalReady = proposal.status === 'suggested_human_review_required';
  const arithmeticReady = arithmetic.status === 'arithmetic_consistent';
  const decisionReady = result.decision === 'proposal_ready_for_human_review';
  const model = plain(extraction.responseModelId ?? extraction.configuredModelId);
  const processingPath = extraction.documentPath === 'telnyx_vision' ? 'Vision scan' : 'Embedded text';
  const detailJobId = options.detailJobId && /^[a-f0-9]{64}$/.test(options.detailJobId) ? options.detailJobId : null;

  const lineRows = lines.map((value, index) => {
    const line = record(value) ? value : {};
    return `<tr><td><span class="number">${index + 1}</span></td>
      <td><strong>${display(sourced(line.description))}</strong></td>
      <td class="amount">${display(sourced(line.quantity), '—')}</td>
      <td class="amount">${display(sourced(line.unitPrice), '—')}</td>
      <td class="amount"><strong>${display(sourced(line.lineNet), '—')}</strong></td></tr>`;
  }).join('');

  const entryRows = entries.map(value => {
    const entry = record(value) ? value : {};
    const side = entry.side === 'debit' ? 'debit' : 'credit';
    return `<tr><td><span class="side ${side}">${escapeHtml(humanize(entry.side))}</span></td>
      <td><strong>${escapeHtml(plain(entry.accountId))}</strong><small>Human-review proposal only</small></td>
      <td class="amount"><strong>${escapeHtml(plain(entry.amount, '—'))}</strong> ${escapeHtml(plain(entry.currency, ''))}</td></tr>`;
  }).join('');

  const checkRows = checks.map(value => {
    const check = record(value) ? value : {};
    const matches = check.matches === true;
    return `<tr><td>${escapeHtml(humanize(check.path))}</td><td class="amount">${escapeHtml(plain(check.printed, '—'))}</td>
      <td class="amount">${escapeHtml(plain(check.calculated, '—'))}</td>
      <td><span class="mini ${matches ? 'ok' : 'warn'}">${matches ? 'Match' : 'Review'}</span></td></tr>`;
  }).join('');

  const summaryCards = `<article class="card total-card"><p class="label">Printed invoice total</p><div class="total"><small>${display(currency, '—')}</small>${display(total, '—')}</div>
      <div class="total-breakdown"><span>Subtotal <b>${display(subtotal, '—')}</b></span><span>Tax <b>${display(tax, '—')}</b></span></div></article>
    <article class="card"><p class="label">Invoice details</p><dl><div><dt>Supplier</dt><dd>${display(supplier)}</dd></div>
      <div><dt>Invoice number</dt><dd>${display(invoiceNumber)}</dd></div><div><dt>Tax / VAT ID</dt><dd>${display(taxId)}</dd></div>
      <div><dt>Address</dt><dd>${display(supplierAddress)}</dd></div></dl></article>
    <article class="card"><p class="label">Hosted processing</p><div class="status-line"><span>Agent</span><b>${escapeHtml(humanize(status.phase))}</b></div>
      <div class="status-line"><span>Completed / failed</span><b>${status.jobs.complete} / ${status.jobs.failed}</b></div>
      <div class="status-line"><span>Document path</span><b>${processingPath}</b></div><div class="status-line"><span>Model</span><b class="wrap">${escapeHtml(model)}</b></div>
      <p class="timestamp">Completed ${escapeHtml(safeDate(result.completedAt))} (Dubai)</p></article>`;
  const overview = detailJobId === null ? `<section class="summary-grid">${summaryCards}</section>` :
    `<section class="detail-overview">${documentPreview(
      detailJobId,
      plain(attachment.filename, 'Invoice document'),
      plain(attachment.contentType, ''),
    )}<div class="detail-summary">${summaryCards}</div></section>`;

  return `<main>
    <section class="hero">
      <div><p class="eyebrow">Telnyx Edge · Private review</p><h1>${display(supplier, 'Invoice review')}</h1>
      <p class="lede">Invoice ${display(invoiceNumber, 'number not extracted')} · ${display(invoiceDate, 'date not extracted')}</p></div>
      <div class="hero-actions">${detailJobId === null ? '' : '<a class="guide-link" href="/">← All invoices</a>'}${guideLink()}<span class="pill ${decisionReady ? 'good' : 'warning'}"><i></i>${decisionReady ? 'Ready for human review' : 'Needs review'}</span></div>
    </section>

    <div class="dashboard-layout"><aside class="dashboard-rail">${inboxMonitorPanel(status, monitor, monitorErrorCode)}</aside>
    <div class="dashboard-content">
    ${overview}

    <section class="card section"><div class="section-title"><div><p class="eyebrow">Step 2 · Extraction</p><h2>Invoice line items</h2></div><span class="count">${lines.length} line${lines.length === 1 ? '' : 's'}</span></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Description</th><th class="amount">Quantity</th><th class="amount">Unit price</th><th class="amount">Net amount</th></tr></thead>
      <tbody>${lineRows || '<tr><td colspan="5" class="empty-row">No line items extracted</td></tr>'}</tbody></table></div></section>

    <section class="two-column">
      <article class="card section accent-accounting"><div class="section-title"><div><p class="eyebrow">Step 3 · Accounting</p><h2>Suggested entries</h2></div>
        <span class="pill ${proposalReady ? 'good' : 'warning'}"><i></i>${proposalReady ? 'Balanced proposal' : 'Withheld'}</span></div>
        <p class="intro">Demo gross-expense policy. Suggestions require human approval and are never posted automatically.</p>
        <div class="table-wrap"><table><thead><tr><th>Side</th><th>Account</th><th class="amount">Amount</th></tr></thead>
        <tbody>${entryRows || '<tr><td colspan="3" class="empty-row">Entries withheld pending review</td></tr>'}</tbody></table></div>
        <div class="guardrail"><span>🔒</span><p><b>Automatic posting is off</b><small>${controls.automaticPosting === false ? 'Confirmed by the hosted result.' : 'No posting permission is exposed.'}</small></p></div>
      </article>

      <article class="card section accent-reconcile"><div class="section-title"><div><p class="eyebrow">Step 4 · Reconciliation</p><h2>Independent checks</h2></div>
        <span class="pill ${arithmeticReady ? 'good' : 'warning'}"><i></i>${arithmeticReady ? 'Consistent' : 'Review'}</span></div>
        <p class="intro">Printed amounts are compared with independently calculated line extensions and totals using exact decimal arithmetic.</p>
        <div class="table-wrap"><table><thead><tr><th>Check</th><th class="amount">Printed</th><th class="amount">Calculated</th><th>Result</th></tr></thead>
        <tbody>${checkRows || '<tr><td colspan="4" class="empty-row">No arithmetic checks available</td></tr>'}</tbody></table></div>
        <p class="caveat">A matching sum verifies arithmetic consistency—not extraction accuracy, tax treatment, or accounting approval.</p>
      </article>
    </section>

    ${detailJobId === null ? '' : technicalJsonPanel(result)}
    ${batchPanel(status.batch ?? (status.batches ?? [])[0] ?? null)}
    ${jobHistory(status.recentJobs ?? [])}
    ${batchArchive(status.batches ?? [])}
    </div></div>

    <footer><div><b>Invoice-to-Ledger Agent</b><span>Read-only hosted review · no payments, posting, tax filing, or reporting</span></div>
      <div><a class="footer-guide" href="/how-it-works">How it works</a><span>${escapeHtml(plain(attachment.filename, 'Invoice PDF'))}</span><a href="/">Refresh ↻</a></div></footer>
  </main>`;
}

const STYLES = `
  :root{color-scheme:light;--ink:#14251d;--muted:#68776f;--paper:#f4f4ed;--card:#fff;--line:#e1e5df;--green:#176f4a;--green-soft:#e8f5ee;--amber:#a26113;--amber-soft:#fff1d5;--purple:#6554c0;--purple-soft:#f0edff;--teal:#087f8c;--teal-soft:#e2f5f6;--shadow:0 16px 45px rgba(28,54,40,.08)}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 6% 3%,#e2f2e8 0,transparent 25%),radial-gradient(circle at 94% 8%,#ece8ff 0,transparent 22%),var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}body:before{content:"";display:block;height:7px;background:linear-gradient(90deg,var(--green),var(--teal),var(--purple),#d99324)}main{width:min(1440px,calc(100% - 40px));margin:auto;padding:42px 0 34px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.hero-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}.guide-link{display:inline-flex;align-items:center;gap:9px;padding:8px 12px;border:1px solid #d6ded8;border-radius:999px;color:var(--ink);background:#fff;font-size:12px;font-weight:800;text-decoration:none}.guide-link span{color:var(--green)}.eyebrow{margin:0 0 7px;color:var(--green);font-size:11px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}.hero h1{margin:0;font-size:clamp(35px,5vw,58px);line-height:1;letter-spacing:-.05em}.lede{margin:13px 0 0;color:var(--muted);font-size:16px}.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:800;white-space:nowrap}.pill i{width:7px;height:7px;border-radius:50%;background:currentColor}.pill.good{color:var(--green);background:var(--green-soft)}.pill.warning{color:var(--amber);background:var(--amber-soft)}.pill.neutral{color:#56635c;background:#e9ece9}.card{background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}.dashboard-layout{display:grid;grid-template-columns:280px minmax(0,1fr);gap:22px;align-items:start}.dashboard-content,.dashboard-rail{min-width:0}.dashboard-rail{padding:4px 20px 0 0;border-right:1px solid #cbd4ce}.dashboard-rail .section{padding:0}.dashboard-rail .section-title{align-items:flex-start;flex-direction:column}.dashboard-rail .monitor-card{margin:0;border:0;border-radius:0;background:transparent;box-shadow:none}.dashboard-rail .monitor-grid{grid-template-columns:repeat(2,1fr)}.dashboard-rail .monitor-meta{align-items:flex-start;flex-direction:column}.dashboard-rail .monitor-grid span{min-height:30px}.monitor-card{border-top:5px solid var(--teal)}.monitor-card .eyebrow{color:var(--teal)}.monitor-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:9px}.monitor-grid>div{padding:13px;border-radius:13px;background:#f3f7f5}.monitor-grid>div.attention{background:var(--amber-soft)}.monitor-grid span,.monitor-grid b{display:block}.monitor-grid span{min-height:35px;color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}.monitor-grid b{font-size:24px;letter-spacing:-.03em}.monitor-latest{display:flex;align-items:center;gap:10px;margin-top:14px;padding:11px 13px;border-radius:12px;background:var(--teal-soft);color:#315f64}.monitor-latest p{margin:0;overflow-wrap:anywhere}.pulse{flex:0 0 9px;width:9px;height:9px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 5px #087f8c18}.monitor-meta{display:flex;align-items:center;justify-content:space-between;gap:15px;flex-wrap:wrap;margin-top:13px;color:var(--muted);font-size:11px}.monitor-meta b{color:var(--ink)}.summary-grid{display:grid;grid-template-columns:1fr 1.05fr 1.1fr;gap:17px;margin-bottom:17px}.summary-grid>.card,.detail-summary>.card{padding:23px}.detail-overview{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(310px,.65fr);gap:17px;margin-bottom:17px;align-items:start}.detail-summary{display:grid;gap:17px}.preview-card{min-width:0;padding:20px}.preview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;margin-bottom:14px}.preview-head h2{margin:0;font-size:18px;line-height:1.2;overflow-wrap:anywhere}.open-document{flex:0 0 auto;padding:7px 10px;border-radius:9px;color:#fff;background:var(--ink);font-size:11px;font-weight:800;text-decoration:none}.preview-surface{height:660px;overflow:hidden;border:1px solid #d7ddd8;border-radius:14px;background:#e8ece9}.preview-frame{display:block;width:100%;height:100%;border:0;background:#fff}.preview-image-wrap{display:grid;place-items:center;width:100%;height:100%;overflow:auto;padding:14px}.preview-image{display:block;max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 10px 35px #14251d1f}.preview-unavailable{display:grid;place-items:center;align-content:center;height:100%;color:var(--muted);text-align:center}.preview-unavailable b,.preview-unavailable span{display:block}.preview-note{margin:11px 0 0;color:var(--muted);font-size:10px}.label{margin:0 0 19px;color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.total-card{position:relative;overflow:hidden;color:#fff;background:linear-gradient(145deg,#14261e,#1d503a);border-color:#173828}.total{display:flex;align-items:baseline;gap:9px;font-size:42px;font-weight:800;letter-spacing:-.045em}.total small{color:#b9d7c7;font-size:13px;letter-spacing:.04em}.total-breakdown{display:flex;justify-content:space-between;gap:15px;margin-top:32px;padding-top:16px;border-top:1px solid #ffffff24}.total-breakdown span{display:flex;flex-direction:column;color:#b8cec2;font-size:11px}.total-breakdown b{margin-top:4px;color:#fff;font-size:14px}dl{margin:0}dl>div,.status-line{display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid var(--line)}dl>div:last-child,.status-line:nth-last-of-type(1){border-bottom:0}dt,.status-line span{color:var(--muted)}dd{margin:0;max-width:64%;font-weight:700;text-align:right;overflow-wrap:anywhere}.status-line b{max-width:65%;text-align:right}.wrap{overflow-wrap:anywhere}.timestamp{margin:13px 0 0;color:var(--muted);font-size:11px}.section{padding:25px;margin-bottom:17px}.section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.section-title h2{margin:0;font-size:22px;line-height:1.1;letter-spacing:-.025em}.section-title p{margin:6px 0 0;color:var(--muted);font-size:12px}.count{padding:5px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:11px;font-weight:750}.intro{margin:-5px 0 18px;color:var(--muted);font-size:13px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th{padding:10px 11px;border-bottom:1px solid var(--line);color:var(--muted);font-size:10px;font-weight:850;letter-spacing:.07em;text-align:left;text-transform:uppercase}td{padding:13px 11px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:0}.amount{text-align:right;white-space:nowrap}.number{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;color:var(--muted);background:#eff2ef;font-size:11px;font-weight:800}.two-column{display:grid;grid-template-columns:1fr 1fr;gap:17px}.two-column .section{min-width:0}.accent-accounting{border-top:5px solid var(--purple)}.accent-accounting .eyebrow{color:var(--purple)}.accent-reconcile{border-top:5px solid var(--teal)}.accent-reconcile .eyebrow{color:var(--teal)}.side,.mini{display:inline-flex;border-radius:7px;padding:4px 7px;font-size:10px;font-weight:850;text-transform:uppercase}.side.debit{color:var(--green);background:var(--green-soft)}.side.credit{color:#5066a1;background:#edf1fb}.mini.ok{color:var(--green);background:var(--green-soft)}.mini.warn{color:var(--amber);background:var(--amber-soft)}td small{display:block;margin-top:3px;color:var(--muted);font-size:10px}.empty-row{padding:28px;text-align:center;color:var(--muted)}.batch-card{border-top:5px solid var(--green)}.batch-verdict{display:flex;justify-content:space-between;gap:18px;margin:0 0 18px}.batch-verdict b,.batch-verdict span{display:block}.batch-verdict span{color:var(--muted);text-align:right}.stat-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:9px}.stat{padding:12px;border-radius:12px;background:#f4f7f4}.stat span,.stat b{display:block}.stat span{min-height:32px;color:var(--muted);font-size:10px;font-weight:750;text-transform:uppercase}.stat b{font-size:18px}.batch-basis{margin:16px 0 0;color:var(--muted);font-size:12px}.issue-list{margin:14px 0 0;padding:12px 12px 12px 30px;border-radius:12px;color:var(--amber);background:var(--amber-soft);font-size:12px}.history-card{border-top:5px solid #243f34}.view-link{display:inline-flex;padding:5px 9px;border-radius:8px;color:#fff;background:var(--ink);font-size:11px;font-weight:800;text-decoration:none}.guardrail{display:flex;align-items:center;gap:11px;margin-top:18px;padding:12px 13px;border-radius:12px;background:var(--purple-soft);color:#493c91}.guardrail>span{display:grid;place-items:center;width:31px;height:31px;border-radius:10px;background:#fff}.guardrail p,.guardrail b,.guardrail small{display:block;margin:0}.guardrail small{margin-top:2px;color:#7569ac}.caveat{margin:18px 0 0;padding:12px 13px;border-radius:12px;color:#446f74;background:var(--teal-soft);font-size:12px}.alert{margin:0 0 17px;padding:13px 15px;border-radius:12px;color:var(--amber);background:var(--amber-soft);font-weight:700}.empty-state{margin-bottom:17px;padding:70px 25px;border:1px dashed #cbd4cd;border-radius:20px;background:#ffffffaa;text-align:center}.empty-icon{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 16px;border-radius:15px;color:#fff;background:var(--green);font-size:24px}.empty-state h2{margin:0}.empty-state p{color:var(--muted)}footer{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 3px 0;color:var(--muted);font-size:11px}footer b,footer span{display:block}footer b{color:var(--ink)}footer>div:last-child{display:flex;align-items:center;gap:15px;text-align:right}footer a{padding:7px 10px;border-radius:9px;color:#fff;background:var(--ink);font-weight:750;text-decoration:none}.footer-guide{color:var(--ink);background:#fff;border:1px solid var(--line)}
  .technical-json{margin:0 0 17px;overflow:hidden}.technical-json summary{position:relative;display:flex;align-items:center;gap:16px;padding:18px 52px 18px 22px;cursor:pointer;list-style:none}.technical-json summary::-webkit-details-marker{display:none}.technical-json summary:after{content:"›";position:absolute;right:23px;top:50%;color:var(--green);font-size:25px;font-weight:700;line-height:1;transform:translateY(-50%);transition:transform .18s ease}.technical-json[open] summary:after{transform:translateY(-50%) rotate(90deg)}.technical-json summary span{font-size:14px;font-weight:800}.technical-json summary small{color:var(--muted);font-size:11px}.technical-json-body{padding:0 14px 14px}.technical-json pre{max-height:520px;margin:0;overflow:auto;border-radius:13px;padding:18px;color:#d6efe0;background:#10221a;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}.technical-json code{font:inherit}
  @media(max-width:1120px){.dashboard-layout{grid-template-columns:1fr}.dashboard-rail{padding:0 0 17px;border-right:0;border-bottom:1px solid #cbd4ce}.detail-overview{grid-template-columns:1fr}.preview-surface{height:580px}}
  @media(max-width:920px){.summary-grid{grid-template-columns:1fr 1fr}.summary-grid>.card:last-child{grid-column:1/-1}.two-column{grid-template-columns:1fr}.stat-grid,.monitor-grid{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:620px){main{width:min(100% - 26px,1440px);padding-top:28px}.hero{align-items:flex-start;flex-direction:column}.hero-actions{justify-content:flex-start}.hero h1{font-size:38px}.summary-grid{grid-template-columns:1fr}.summary-grid>.card:last-child{grid-column:auto}.section,.summary-grid>.card,.detail-summary>.card,.preview-card{padding:18px;border-radius:16px}.preview-head{align-items:flex-start;flex-direction:column}.preview-surface{height:460px}.table-wrap{margin:0 -18px;padding:0 18px}.section-title,.batch-verdict{align-items:flex-start;flex-direction:column}.batch-verdict span{text-align:left}.section-title .pill{align-self:flex-start}.stat-grid,.monitor-grid{grid-template-columns:repeat(2,1fr)}footer{align-items:flex-start;flex-direction:column}footer>div:last-child{align-items:flex-start;flex-wrap:wrap;text-align:left}}
`;

export function renderHostedDashboard(
  status: EdgeAgentStatus,
  result: unknown,
  monitor: EdgeInboxMonitor | null = null,
  monitorErrorCode: string | null = null,
  options: HostedDashboardOptions = {},
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="30"><title>Telnyx Bookkeeping Review</title>
    <style>${STYLES}</style></head><body>${dashboardBody(status, result, monitor, monitorErrorCode, options)}</body></html>\n`;
}

export function renderHostedUnavailable(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="30"><title>Telnyx Bookkeeping Review</title>
    <style>${STYLES}</style></head><body><main>
      <section class="hero"><div><p class="eyebrow">Telnyx Edge · Private review</p><h1>Invoice processing dashboard</h1>
        <p class="lede">The web function is online, but Telnyx StatefulActor storage is temporarily unavailable.</p></div>
        <div class="hero-actions">${guideLink()}<span class="pill warning"><i></i>Platform recovery</span></div></section>
      <section class="card section"><div class="section-title"><div><p class="eyebrow">Hosted status</p>
        <h2>Processing is safely paused</h2></div><span class="pill warning"><i></i>Actor unavailable</span></div>
        <p class="intro">Telnyx Edge can serve this protected page, but the platform cannot currently open the agent's durable state. No invoice retry, deletion, payment or posting was triggered.</p>
        <div class="stat-grid">
          <div class="stat"><span>Edge function</span><b>Online</b></div>
          <div class="stat"><span>StatefulActor</span><b>Unavailable</b></div>
          <div class="stat"><span>Inbox claims</span><b>Paused</b></div>
          <div class="stat"><span>AI calls</span><b>Paused</b></div>
          <div class="stat"><span>Automatic posting</span><b>Off</b></div>
          <div class="stat"><span>Refresh</span><b>30 sec</b></div>
        </div>
        <p class="batch-basis">The page will reconnect automatically when Telnyx restores StatefulActor storage access. Existing actor state has not been intentionally modified or deleted.</p>
      </section>
      <footer><div><b>Invoice-to-Ledger Agent</b><span>Read-only hosted review · no payments, posting, tax filing, or reporting</span></div>
        <div><a class="footer-guide" href="/how-it-works">How it works</a><a href="/">Refresh ↻</a></div></footer>
    </main></body></html>\n`;
}
