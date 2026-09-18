import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowError } from './errors.ts';

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, fallback = 'Not extracted'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function sourcedValue(value: unknown): { value: string | null; page: number | null; quote: string | null } {
  if (!record(value)) return { value: null, page: null, quote: null };
  const evidence = record(value.evidence) ? value.evidence : null;
  return {
    value: typeof value.value === 'string' ? value.value : null,
    page: typeof evidence?.page === 'number' ? evidence.page : null,
    quote: typeof evidence?.quote === 'string' ? evidence.quote : null,
  };
}

function humanize(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Unknown';
  return value.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function statusTone(value: unknown): 'positive' | 'warning' | 'neutral' {
  if (['answer_key_match', 'arithmetic_consistent', 'manifest_match', 'suggested_human_review_required']
    .includes(String(value))) return 'positive';
  if (['needs_review', 'mismatch', 'withheld_needs_review', 'incomplete'].includes(String(value))) return 'warning';
  return 'neutral';
}

function badge(value: unknown, label?: string): string {
  const raw = typeof value === 'string' ? value : 'unknown';
  return `<span class="badge ${statusTone(raw)}"><span class="badge-dot"></span>${escapeHtml(label ?? humanize(raw))}</span>`;
}

function displayValue(value: string | null): string {
  return value === null || value === '' ? '<span class="empty">Not extracted</span>' : escapeHtml(value);
}

function evidenceDetail(label: string, source: unknown): string {
  const extracted = sourcedValue(source);
  const location = extracted.page === null ? 'No source location' : `Page ${extracted.page}`;
  return `<article class="evidence-item">
    <div class="evidence-heading"><span>${escapeHtml(label)}</span><small>${escapeHtml(location)}</small></div>
    <strong>${displayValue(extracted.value)}</strong>
    <p>${extracted.quote === null ? '<span class="empty">No source quote</span>' : `“${escapeHtml(extracted.quote)}”`}</p>
  </article>`;
}

function renderResultBody(result: Record<string, unknown>): string {
  const extractionBlock = record(result.extraction) ? result.extraction : {};
  const values = record(extractionBlock.values) ? extractionBlock.values : {};
  const intake = record(result.intake) ? result.intake : {};
  const attachment = record(intake.attachment) ? intake.attachment : {};
  const documentText = record(result.documentText) ? result.documentText : {};
  const accuracy = record(result.documentAccuracy) ? result.documentAccuracy : {};
  const arithmetic = record(result.arithmetic) ? result.arithmetic : {};
  const completeness = record(result.completeness) ? result.completeness : {};
  const proposal = record(result.accountingProposal) ? result.accountingProposal : {};
  const job = record(result.job) ? result.job : {};
  const controls = record(result.controls) ? result.controls : {};

  const supplier = sourcedValue(values.supplierName).value;
  const invoiceNumber = sourcedValue(values.invoiceNumber).value;
  const invoiceDate = sourcedValue(values.invoiceDate).value;
  const currency = sourcedValue(values.currency).value;
  const subtotal = sourcedValue(values.subtotal).value;
  const tax = sourcedValue(values.tax).value;
  const total = sourcedValue(values.total).value;
  const decision = typeof result.decision === 'string' ? result.decision : 'needs_review';
  const lines = Array.isArray(values.lines) ? values.lines : [];
  const checks = Array.isArray(arithmetic.checks) ? arithmetic.checks : [];
  const arithmeticIssues = Array.isArray(arithmetic.issues) ? arithmetic.issues : [];
  const proposalEntries = Array.isArray(proposal.entries) ? proposal.entries : [];
  const proposalIssues = Array.isArray(proposal.issues) ? proposal.issues : [];
  const complexities = Array.isArray(values.complexities) ? values.complexities : [];

  const lineRows = lines.map((line, index) => {
    const item = record(line) ? line : {};
    return `<tr>
      <td><span class="line-index">${index + 1}</span></td>
      <td><strong>${displayValue(sourcedValue(item.description).value)}</strong></td>
      <td class="numeric">${displayValue(sourcedValue(item.quantity).value)}</td>
      <td class="numeric">${displayValue(sourcedValue(item.unitPrice).value)}</td>
      <td class="numeric"><strong>${displayValue(sourcedValue(item.lineNet).value)}</strong></td>
    </tr>`;
  }).join('');

  const checkRows = checks.map(check => {
    const item = record(check) ? check : {};
    const matches = item.matches === true;
    return `<tr>
      <td>${escapeHtml(humanize(item.path))}</td>
      <td class="numeric">${escapeHtml(text(item.printed, '—'))}</td>
      <td class="numeric">${escapeHtml(text(item.calculated, '—'))}</td>
      <td class="numeric">${escapeHtml(text(item.delta, '—'))}</td>
      <td>${badge(matches ? 'arithmetic_consistent' : 'needs_review', matches ? 'Match' : 'Review')}</td>
    </tr>`;
  }).join('');

  const entryRows = proposalEntries.map(entry => {
    const item = record(entry) ? entry : {};
    return `<tr>
      <td><span class="entry-side ${item.side === 'debit' ? 'debit' : 'credit'}">${escapeHtml(text(item.side, 'Entry'))}</span></td>
      <td><strong>${escapeHtml(text(item.accountId))}</strong><small>${escapeHtml(text(item.basis, ''))}</small></td>
      <td class="numeric"><strong>${escapeHtml(text(item.amount, '—'))}</strong> ${escapeHtml(text(item.currency, ''))}</td>
    </tr>`;
  }).join('');

  const evidenceFields: Array<[string, unknown]> = [
    ['Supplier', values.supplierName],
    ['Supplier address', values.supplierAddress],
    ['Tax registration ID', values.supplierTaxRegistrationId],
    ['Invoice number', values.invoiceNumber],
    ['Invoice date', values.invoiceDate],
    ['Currency', values.currency],
    ['Pricing basis', values.pricing],
    ['Subtotal', values.subtotal],
    ['Tax', values.tax],
    ['Total', values.total],
  ];
  const lineEvidence = lines.flatMap((line, index) => {
    const item = record(line) ? line : {};
    return [
      [`Line ${index + 1} description`, item.description],
      [`Line ${index + 1} quantity`, item.quantity],
      [`Line ${index + 1} unit price`, item.unitPrice],
      [`Line ${index + 1} net`, item.lineNet],
    ] as Array<[string, unknown]>;
  });
  const evidenceItems = [...evidenceFields, ...lineEvidence]
    .map(([label, source]) => evidenceDetail(label, source)).join('');

  const accuracyMismatchCount = Array.isArray(accuracy.mismatches) ? accuracy.mismatches.length : 0;
  const completenessExpected = typeof completeness.expectedCount === 'number' ? String(completeness.expectedCount) : 'Not configured';
  const completenessReceived = typeof completeness.uniqueReceived === 'number' ? String(completeness.uniqueReceived) : '—';
  const proposalStatus = typeof proposal.status === 'string' ? proposal.status : 'withheld_needs_review';
  const allIssues = [
    ...arithmeticIssues.map(issue => record(issue) ? text(issue.code, '') : '').filter(Boolean),
    ...proposalIssues.filter(issue => typeof issue === 'string'),
  ];
  const processingNote = text(documentText.note, 'Document source details were not recorded.');

  return `<div class="app-shell">
  <header class="topbar">
    <a class="brand" href="/" aria-label="Back to invoice review dashboard"><span class="brand-mark">T</span><span>Telnyx <b>Bookkeeping</b></span></a>
    <div class="topbar-meta"><span class="privacy-dot"></span>Private review workspace</div>
  </header>

  <main>
    <a class="back-link" href="/">← All invoice jobs</a>
    <section class="result-hero">
      <div>
        <p class="eyebrow">Invoice review</p>
        <h1>${escapeHtml(text(supplier, 'Unnamed supplier'))}</h1>
        <p class="hero-meta">${invoiceNumber === null ? 'No invoice number' : `Invoice ${escapeHtml(invoiceNumber)}`}<span></span>${invoiceDate === null ? 'Date not extracted' : escapeHtml(invoiceDate)}</p>
      </div>
      ${badge(decision, decision === 'proposal_ready_for_human_review' ? 'Ready for human review' : 'Needs attention')}
    </section>

    <div class="review-notice"><span class="notice-icon">!</span><div><strong>Human review required — no automatic action</strong><p>This result has not been posted, paid, filed, or emailed. Tax treatment and accounting approval remain with a human reviewer.</p></div></div>

    <section class="summary-grid" aria-label="Invoice summary">
      <article class="card total-card">
        <p class="card-label">Invoice total</p>
        <div class="total-value"><span>${escapeHtml(text(currency, '—'))}</span>${displayValue(total)}</div>
        <div class="amount-breakdown"><div><span>Subtotal</span><strong>${displayValue(subtotal)}</strong></div><div><span>Tax</span><strong>${displayValue(tax)}</strong></div></div>
      </article>
      <article class="card details-card">
        <p class="card-label">Invoice details</p>
        <dl class="detail-list">
          <div><dt>Supplier</dt><dd>${displayValue(supplier)}</dd></div>
          <div><dt>Invoice number</dt><dd>${displayValue(invoiceNumber)}</dd></div>
          <div><dt>Invoice date</dt><dd>${displayValue(invoiceDate)}</dd></div>
          <div><dt>Pricing</dt><dd>${displayValue(sourcedValue(values.pricing).value)}</dd></div>
        </dl>
      </article>
      <article class="card validation-card">
        <p class="card-label">Independent checks</p>
        <div class="check-list">
          <div><span>Extraction accuracy</span>${badge(accuracy.status, accuracy.status === 'answer_key_match' ? 'Verified to answer key' : undefined)}</div>
          <div><span>Arithmetic</span>${badge(arithmetic.status)}</div>
          <div><span>Completeness</span>${badge(completeness.status)}</div>
        </div>
        <p class="subtle">${accuracyMismatchCount === 0 ? 'No recorded answer-key mismatches.' : `${accuracyMismatchCount} answer-key mismatch${accuracyMismatchCount === 1 ? '' : 'es'} found.`}</p>
      </article>
    </section>

    <section class="card section-card">
      <div class="section-heading"><div><p class="eyebrow">Extracted data</p><h2>Line items</h2></div><span class="section-count">${lines.length} item${lines.length === 1 ? '' : 's'}</span></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Description</th><th class="numeric">Qty</th><th class="numeric">Unit price</th><th class="numeric">Net amount</th></tr></thead><tbody>${lineRows || '<tr><td colspan="5" class="empty-row">No line items were extracted.</td></tr>'}</tbody><tfoot><tr><td colspan="4">Subtotal</td><td class="numeric">${displayValue(subtotal)}</td></tr><tr><td colspan="4">Tax</td><td class="numeric">${displayValue(tax)}</td></tr><tr class="grand-total"><td colspan="4">Total</td><td class="numeric">${escapeHtml(text(currency, ''))} ${displayValue(total)}</td></tr></tfoot></table></div>
    </section>

    <section class="two-column">
      <article class="card section-card">
        <div class="section-heading"><div><p class="eyebrow">Step 3 · Accounting</p><h2>Suggested debit / credit entries</h2></div>${badge(proposalStatus, proposalStatus === 'suggested_human_review_required' ? 'Balanced proposal' : 'Withheld')}</div>
        <p class="section-intro">${escapeHtml(text(proposal.policyLabel, 'No accounting policy was recorded.'))}</p>
        <div class="table-wrap compact"><table><thead><tr><th>Side</th><th>Account</th><th class="numeric">Amount</th></tr></thead><tbody>${entryRows || '<tr><td colspan="3" class="empty-row">Entries are withheld pending review.</td></tr>'}</tbody></table></div>
        ${proposalIssues.length ? `<div class="issue-list"><strong>Why withheld</strong><p>${proposalIssues.map(issue => escapeHtml(humanize(String(issue)))).join(' · ')}</p></div>` : '<p class="success-note">Debit and credit balance exactly. Human approval is still required.</p>'}
      </article>
      <article class="card section-card">
        <div class="section-heading"><div><p class="eyebrow">Step 4 · Reconciliation</p><h2>Calculation checks</h2></div>${badge(arithmetic.status)}</div>
        <div class="table-wrap compact"><table><thead><tr><th>Field</th><th class="numeric">Normalized</th><th class="numeric">Calculated</th><th class="numeric">Delta</th><th>Result</th></tr></thead><tbody>${checkRows || '<tr><td colspan="5" class="empty-row">No calculation checks were recorded.</td></tr>'}</tbody></table></div>
        ${allIssues.length ? `<div class="issue-list"><strong>Review issues</strong><p>${allIssues.map(issue => escapeHtml(humanize(issue))).join(' · ')}</p></div>` : '<p class="success-note">All available arithmetic checks agree exactly. Original printed strings remain in Extracted data and Source evidence.</p>'}
      </article>
    </section>

    <section class="card section-card">
      <div class="section-heading"><div><p class="eyebrow">Traceability</p><h2>Source evidence</h2></div><span class="section-count">${evidenceFields.length + lineEvidence.length} fields</span></div>
      <p class="section-intro">Printed values stay separate from calculated values. Expand this section to inspect the exact page and quote supporting every extracted field.</p>
      <details class="evidence-panel"><summary>Show field-level evidence</summary><div class="evidence-grid">${evidenceItems}</div></details>
      ${complexities.length ? `<div class="issue-list"><strong>Detected document complexities</strong><p>${complexities.map(item => escapeHtml(humanize(record(item) ? item.code : item))).join(' · ')}</p></div>` : '<p class="success-note">No supported financial complexities were extracted.</p>'}
    </section>

    <section class="card section-card">
      <div class="section-heading"><div><p class="eyebrow">Processing record</p><h2>Document & model details</h2></div>${badge(documentText.source, documentText.source === 'embedded_pdf_text' ? 'Embedded text' : 'Vision capture')}</div>
      <div class="metadata-grid">
        <div><span>Attachment</span><strong>${escapeHtml(text(attachment.filename))}</strong></div>
        <div><span>File type</span><strong>${escapeHtml(text(attachment.contentType))}</strong></div>
        <div><span>Retrieved size</span><strong>${typeof attachment.calculatedSize === 'number' ? `${attachment.calculatedSize.toLocaleString('en-US')} bytes` : 'Not recorded'}</strong></div>
        <div><span>Pages</span><strong>${typeof documentText.pages === 'number' ? documentText.pages : 'Not recorded'}</strong></div>
        <div><span>Model</span><strong>${escapeHtml(text(extractionBlock.responseModelId ?? extractionBlock.configuredModelId))}</strong></div>
        <div><span>Created</span><strong>${escapeHtml(text(result.createdAt, 'Not recorded'))}</strong></div>
        <div><span>Job ID</span><strong class="mono">${escapeHtml(text(job.id, 'Not recorded'))}</strong></div>
        <div><span>Result access</span><strong>${escapeHtml(humanize(controls.resultAccess))}</strong></div>
      </div>
      <p class="processing-note">${escapeHtml(processingNote)}</p>
      <div class="completeness-note"><strong>Completeness basis</strong><span>${completenessReceived} unique received / ${escapeHtml(completenessExpected)} expected</span></div>
    </section>
  </main>`;
}

const RESULT_STYLES = `
  :root{color-scheme:light;--ink:#17211b;--muted:#66736a;--paper:#fbfaf6;--card:#fff;--line:#e5e8e3;--green:#176b45;--green-soft:#e7f3ec;--amber:#9a5a0a;--amber-soft:#fff3d9;--neutral:#55625a;--neutral-soft:#eef1ee;--shadow:0 10px 30px rgba(26,45,34,.06)}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}.app-shell{min-height:100vh}.topbar{height:68px;padding:0 clamp(20px,4vw,56px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:rgba(251,250,246,.92)}.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;letter-spacing:-.01em}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--ink);color:#fff;font-weight:800}.brand b{font-weight:650}.topbar-meta{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.privacy-dot{width:7px;height:7px;border-radius:50%;background:#2aa36b;box-shadow:0 0 0 4px var(--green-soft)}main{width:min(1180px,calc(100% - 40px));margin:0 auto;padding:34px 0 64px}.back-link{display:inline-flex;color:var(--muted);text-decoration:none;font-weight:600;margin-bottom:24px}.back-link:hover{color:var(--ink)}.result-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:22px}.eyebrow{margin:0 0 7px;color:var(--green);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.result-hero h1{font-size:clamp(32px,5vw,52px);line-height:1.03;letter-spacing:-.045em;margin:0}.hero-meta{display:flex;align-items:center;gap:10px;margin:12px 0 0;color:var(--muted)}.hero-meta span{width:3px;height:3px;border-radius:50%;background:#a6afa9}.badge{display:inline-flex;align-items:center;gap:7px;width:max-content;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:750;white-space:nowrap}.badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.badge.positive{color:var(--green);background:var(--green-soft)}.badge.warning{color:var(--amber);background:var(--amber-soft)}.badge.neutral{color:var(--neutral);background:var(--neutral-soft)}.review-notice{display:flex;gap:13px;align-items:flex-start;margin:0 0 22px;padding:14px 16px;border:1px solid #ecd9aa;border-radius:14px;background:#fff8e9;color:#70470e}.notice-icon{display:grid;place-items:center;flex:0 0 24px;width:24px;height:24px;border-radius:50%;background:#f4d58a;font-weight:800}.review-notice strong{font-size:14px}.review-notice p{margin:2px 0 0;color:#886128;font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.summary-grid{display:grid;grid-template-columns:1.05fr 1fr 1.15fr;gap:16px;margin-bottom:16px}.summary-grid .card{padding:22px}.card-label{margin:0 0 18px;color:var(--muted);font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.total-card{background:var(--ink);color:#fff;border-color:var(--ink)}.total-card .card-label{color:#aeb8b1}.total-value{display:flex;align-items:baseline;gap:10px;font-size:38px;font-weight:750;letter-spacing:-.04em}.total-value>span{font-size:13px;letter-spacing:.04em;color:#b8c2bb}.amount-breakdown{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px;padding-top:16px;border-top:1px solid #ffffff22}.amount-breakdown div{display:flex;justify-content:space-between;gap:12px}.amount-breakdown span{color:#adb8b0;font-size:12px}.detail-list{margin:0}.detail-list>div{display:flex;justify-content:space-between;gap:18px;padding:9px 0;border-bottom:1px solid var(--line)}.detail-list>div:last-child{border-bottom:0}.detail-list dt{color:var(--muted)}.detail-list dd{margin:0;font-weight:650;text-align:right}.check-list{display:grid;gap:11px}.check-list>div{display:flex;align-items:center;justify-content:space-between;gap:10px}.check-list>div>span:first-child{color:var(--muted)}.subtle,.section-intro{color:var(--muted);font-size:13px}.subtle{margin:16px 0 0}.section-card{padding:24px;margin-bottom:16px}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.section-heading h2{font-size:20px;line-height:1.2;letter-spacing:-.02em;margin:0}.section-count{color:var(--muted);font-size:12px;font-weight:700;border:1px solid var(--line);border-radius:999px;padding:5px 9px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th{padding:11px 12px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:750;letter-spacing:.06em;text-align:left;text-transform:uppercase}td{padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr:last-child td{border-bottom:0}.numeric{text-align:right;white-space:nowrap}.line-index{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:var(--neutral-soft);color:var(--muted);font-size:12px;font-weight:700}tfoot td{padding:8px 12px;border:0;color:var(--muted)}tfoot tr:first-child td{padding-top:18px;border-top:1px solid var(--line)}tfoot .grand-total td{padding-top:11px;color:var(--ink);font-size:16px;font-weight:750}.empty{color:#98a19b;font-weight:400}.empty-row{padding:28px;text-align:center;color:var(--muted)}.two-column{display:grid;grid-template-columns:1.18fr .82fr;gap:16px}.two-column .section-card{min-width:0}.compact th,.compact td{padding-left:8px;padding-right:8px}.entry-side{display:inline-flex;border-radius:7px;padding:3px 7px;font-size:11px;font-weight:800;text-transform:uppercase}.entry-side.debit{color:#16653f;background:#e7f3ec}.entry-side.credit{color:#465c89;background:#edf1f8}td small{display:block;margin-top:4px;color:var(--muted);font-size:11px;line-height:1.4}.success-note,.processing-note,.issue-list{margin:18px 0 0;padding:12px 14px;border-radius:11px;font-size:13px}.success-note{color:var(--green);background:var(--green-soft)}.issue-list{color:var(--amber);background:var(--amber-soft)}.issue-list p{margin:3px 0 0}.evidence-panel{margin-top:18px;border:1px solid var(--line);border-radius:13px;overflow:hidden}.evidence-panel summary{padding:13px 15px;background:#fafbf9;cursor:pointer;font-weight:700;list-style-position:inside}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border-top:1px solid var(--line)}.evidence-item{padding:16px;background:#fff;min-width:0}.evidence-heading{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.evidence-heading small{font-size:11px;text-transform:none;letter-spacing:0}.evidence-item>strong{display:block;margin-top:7px}.evidence-item p{margin:7px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.metadata-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden}.metadata-grid>div{min-width:0;padding:14px;background:#fff}.metadata-grid span{display:block;margin-bottom:5px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.metadata-grid strong{display:block;overflow-wrap:anywhere;font-size:13px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px!important}.processing-note{color:var(--muted);background:#f5f7f4}.completeness-note{display:flex;justify-content:space-between;gap:15px;margin-top:15px;padding-top:15px;border-top:1px solid var(--line);font-size:13px}.completeness-note span{color:var(--muted)}.raw-section{margin:0 auto 64px}.raw-section details{border:1px solid #29332c;border-radius:16px;overflow:hidden;background:#131a16;color:#e4ebe6}.raw-section summary{display:flex;align-items:center;justify-content:space-between;padding:17px 20px;cursor:pointer;font-weight:700}.raw-section summary small{color:#94a198;font-weight:500}.raw-section pre{max-height:680px;margin:0;padding:20px;border-top:1px solid #2d3730;overflow:auto;white-space:pre;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfe0d4;background:#0f1511}.raw-footer{display:flex;justify-content:space-between;gap:15px;padding:13px 20px;border-top:1px solid #2d3730;color:#91a198;font-size:11px}
  @media (max-width:900px){.summary-grid{grid-template-columns:1fr 1fr}.validation-card{grid-column:1/-1}.two-column{grid-template-columns:1fr}.metadata-grid{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:620px){.topbar{height:60px;padding:0 18px}.topbar-meta{font-size:0}.topbar-meta::after{content:'Private';font-size:12px}.brand b{display:none}main{width:min(100% - 28px,1180px);padding-top:24px}.result-hero{align-items:flex-start;flex-direction:column}.result-hero h1{font-size:36px}.summary-grid{grid-template-columns:1fr}.validation-card{grid-column:auto}.section-card,.summary-grid .card{padding:18px;border-radius:15px}.evidence-grid,.metadata-grid{grid-template-columns:1fr}.table-wrap{margin-left:-18px;margin-right:-18px;padding:0 18px}.review-notice{border-radius:12px}.completeness-note{flex-direction:column;gap:3px}}
  @media print{body{background:#fff}.topbar,.back-link,.raw-section{display:none}main{width:100%;padding:0}.card{box-shadow:none}.review-notice{break-inside:avoid}.evidence-panel>summary{display:none}.evidence-panel>.evidence-grid{display:grid}}
`;

export function renderInspectableResult(result: unknown): string {
  const json = JSON.stringify(result, null, 2);
  const safeResult = record(result) ? result : {};
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Bookkeeping review result</title>
  <style>${RESULT_STYLES}</style>
</head>
<body>${renderResultBody(safeResult)}
<section class="raw-section" style="width:min(1180px,calc(100% - 40px))">
  <details>
    <summary><span>Raw JSON result</span><small>Complete audit record</small></summary>
    <pre>${escapeHtml(json)}</pre>
    <div class="raw-footer"><span>Read-only</span><span>Values shown exactly as stored</span></div>
  </details>
</section>
</div></body></html>\n`;
}

export async function writeInspectableResult(
  outputDirectory: string,
  jobId: string,
  result: unknown,
): Promise<{ jsonPath: string; htmlPath: string }> {
  if (!/^[a-f0-9]{64}$/.test(jobId)) throw new WorkflowError('invalid_result_job_id');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const jsonPath = join(outputDirectory, `${jobId}.json`);
  const htmlPath = join(outputDirectory, `${jobId}.html`);
  const nonce = `${process.pid}-${Date.now()}`;
  const tempJson = `${jsonPath}.${nonce}.tmp`;
  const tempHtml = `${htmlPath}.${nonce}.tmp`;
  await writeFile(tempJson, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(tempHtml, renderInspectableResult(result), { mode: 0o600, flag: 'wx' });
  await rename(tempJson, jsonPath);
  await rename(tempHtml, htmlPath);
  return { jsonPath, htmlPath };
}
