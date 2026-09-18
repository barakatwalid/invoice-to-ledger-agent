import type { InvoiceExtraction } from './extraction.ts';
import type { ArithmeticReview } from './reconcile.ts';
import { reviewInvoice } from './reconcile.ts';
import { formatUnits, parseUnits } from './money.ts';
import { WorkflowError } from './errors.ts';

export interface BookkeepingPolicy {
  schemaVersion: 'bookkeeping_policy_v1';
  id: string;
  label: string;
  currencyMinorUnits: Record<string, number>;
  currencyAmountFormats: Record<string, {
    styles: Array<'dot_decimal' | 'comma_decimal'>;
    markers: string[];
  }>;
  accounting: {
    method: 'gross_expense';
    debitAccountId: string;
    creditAccountId: string;
  };
  resultAccess: 'local_private_files_only' | 'authenticated_edge_actor_only' | 'authenticated_local_service_only';
  allowedResultRecipients: string[];
}

export interface ProposedEntry {
  side: 'debit' | 'credit';
  accountId: string;
  amount: string;
  currency: string;
  basis: string;
}

export interface AccountingProposal {
  status: 'suggested_human_review_required' | 'withheld_needs_review';
  policyId: string;
  policyLabel: string;
  postingPermitted: false;
  taxTreatmentVerified: false;
  entries: ProposedEntry[];
  balance: { debits: string; credits: string; matches: boolean } | null;
  issues: string[];
}

export interface NormalizedFinancialValues {
  status: 'normalized' | 'needs_review';
  basis: 'trusted_currency_format_policy';
  currency: string | null;
  lines: Array<{ quantity: string | null; unitPrice: string | null; lineNet: string | null }>;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  issues: Array<{ code: 'amount_format_unresolved'; path: string }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}

export function validateBookkeepingPolicy(input: unknown): BookkeepingPolicy {
  if (!record(input) || !exactKeys(input, [
    'schemaVersion', 'id', 'label', 'currencyMinorUnits', 'currencyAmountFormats', 'accounting',
    'resultAccess', 'allowedResultRecipients',
  ]) || input.schemaVersion !== 'bookkeeping_policy_v1' ||
      typeof input.id !== 'string' || !input.id || typeof input.label !== 'string' || !input.label ||
      !['local_private_files_only', 'authenticated_edge_actor_only', 'authenticated_local_service_only']
        .includes(input.resultAccess as string) ||
      !record(input.currencyMinorUnits) || !record(input.currencyAmountFormats) ||
      !record(input.accounting) || !exactKeys(input.accounting, ['method', 'debitAccountId', 'creditAccountId']) ||
      input.accounting.method !== 'gross_expense' || typeof input.accounting.debitAccountId !== 'string' ||
      !input.accounting.debitAccountId || typeof input.accounting.creditAccountId !== 'string' ||
      !input.accounting.creditAccountId || !Array.isArray(input.allowedResultRecipients) ||
      !input.allowedResultRecipients.every(item => typeof item === 'string' && item.length > 2 && item.length <= 320)) {
    throw new WorkflowError('invalid_bookkeeping_policy');
  }
  const currencyMinorUnits: Record<string, number> = {};
  for (const [currency, scale] of Object.entries(input.currencyMinorUnits)) {
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isInteger(scale) || (scale as number) < 0 || (scale as number) > 6) {
      throw new WorkflowError('invalid_bookkeeping_policy');
    }
    currencyMinorUnits[currency] = scale as number;
  }
  const currencyAmountFormats: BookkeepingPolicy['currencyAmountFormats'] = {};
  for (const [currency, rawFormat] of Object.entries(input.currencyAmountFormats)) {
    if (!/^[A-Z]{3}$/.test(currency) || !record(rawFormat) || !exactKeys(rawFormat, ['styles', 'markers']) ||
        !Array.isArray(rawFormat.styles) || rawFormat.styles.length < 1 || rawFormat.styles.length > 2 ||
        !rawFormat.styles.every(style => style === 'dot_decimal' || style === 'comma_decimal') ||
        new Set(rawFormat.styles).size !== rawFormat.styles.length ||
        !Array.isArray(rawFormat.markers) || rawFormat.markers.length < 1 || rawFormat.markers.length > 8 ||
        !rawFormat.markers.every(marker => typeof marker === 'string' && marker.trim() === marker &&
          marker.length >= 1 && marker.length <= 12 && !/[\r\n\d]/.test(marker)) ||
        new Set(rawFormat.markers).size !== rawFormat.markers.length) {
      throw new WorkflowError('invalid_bookkeeping_policy');
    }
    currencyAmountFormats[currency] = {
      styles: [...rawFormat.styles] as Array<'dot_decimal' | 'comma_decimal'>,
      markers: [...rawFormat.markers] as string[],
    };
  }
  if (Object.keys(currencyMinorUnits).length !== Object.keys(currencyAmountFormats).length ||
      Object.keys(currencyMinorUnits).some(currency => currencyAmountFormats[currency] === undefined)) {
    throw new WorkflowError('invalid_bookkeeping_policy');
  }
  const resultAccess = input.resultAccess as BookkeepingPolicy['resultAccess'];
  return {
    schemaVersion: 'bookkeeping_policy_v1',
    id: input.id,
    label: input.label,
    currencyMinorUnits,
    currencyAmountFormats,
    accounting: {
      method: 'gross_expense',
      debitAccountId: input.accounting.debitAccountId,
      creditAccountId: input.accounting.creditAccountId,
    },
    resultAccess,
    allowedResultRecipients: [...input.allowedResultRecipients],
  };
}

function amountBodies(value: string, markers: readonly string[]): string[] {
  const trimmed = value.replaceAll('\u00a0', ' ').trim();
  const bodies = new Set<string>();
  if (/^-?[\d.,]+$/.test(trimmed)) bodies.add(trimmed);
  const upper = trimmed.toUpperCase();
  for (const marker of markers) {
    const markerUpper = marker.toUpperCase();
    if (upper.startsWith(markerUpper)) bodies.add(trimmed.slice(marker.length).trim());
    if (upper.endsWith(markerUpper)) bodies.add(trimmed.slice(0, -marker.length).trim());
  }
  return [...bodies];
}

function normalizeBody(
  body: string,
  style: 'dot_decimal' | 'comma_decimal',
  scale: number,
): string | null {
  const dotDecimal = /^-?(?:(?:0|[1-9]\d{0,11})|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,6})?$/;
  const commaDecimal = /^-?(?:(?:0|[1-9]\d{0,11})|[1-9]\d{0,2}(?:\.\d{3})+)(?:,\d{1,6})?$/;
  if (!(style === 'dot_decimal' ? dotDecimal : commaDecimal).test(body)) return null;
  const canonical = style === 'dot_decimal' ? body.replaceAll(',', '') : body.replaceAll('.', '').replace(',', '.');
  try {
    return formatUnits(parseUnits(canonical, scale), scale);
  } catch {
    return null;
  }
}

export function normalizePrintedAmount(
  value: string,
  currency: string,
  policy: BookkeepingPolicy,
): string | null {
  const scale = policy.currencyMinorUnits[currency];
  const format = policy.currencyAmountFormats[currency];
  if (scale === undefined || format === undefined) return null;
  const normalized = new Set<string>();
  for (const body of amountBodies(value, format.markers)) {
    for (const style of format.styles) {
      const candidate = normalizeBody(body, style, scale);
      if (candidate !== null) normalized.add(candidate);
    }
  }
  return normalized.size === 1 ? [...normalized][0]! : null;
}

export function normalizeFinancialValues(
  extraction: InvoiceExtraction,
  policy: BookkeepingPolicy,
): NormalizedFinancialValues {
  const currency = extraction.currency.value;
  const issues: NormalizedFinancialValues['issues'] = [];
  const amount = (value: string | null, path: string): string | null => {
    if (value === null || currency === null) return null;
    const normalized = normalizePrintedAmount(value, currency, policy);
    if (normalized === null) issues.push({ code: 'amount_format_unresolved', path });
    return normalized;
  };
  const lines = extraction.lines.map((line, index) => ({
    quantity: line.quantity.value,
    unitPrice: amount(line.unitPrice.value, `lines[${index}].unitPrice`),
    lineNet: amount(line.lineNet.value, `lines[${index}].lineNet`),
  }));
  const normalized: NormalizedFinancialValues = {
    status: 'normalized', basis: 'trusted_currency_format_policy', currency, lines,
    subtotal: amount(extraction.subtotal.value, 'subtotal'),
    tax: amount(extraction.tax.value, 'tax'),
    total: amount(extraction.total.value, 'total'), issues,
  };
  normalized.status = issues.length ? 'needs_review' : 'normalized';
  return normalized;
}

export function reviewExtraction(extraction: InvoiceExtraction, canonicalId: string, policy: BookkeepingPolicy): ArithmeticReview {
  const currency = extraction.currency.value;
  const minorUnits = currency === null ? null : policy.currencyMinorUnits[currency] ?? null;
  const normalized = normalizeFinancialValues(extraction, policy);
  return reviewInvoice({
    id: canonicalId,
    documentType: extraction.documentType.value,
    currency,
    minorUnits,
    pricing: extraction.pricing.value,
    rounding: 'line_half_away_from_zero',
    lines: extraction.lines.map((line, index) => ({
      description: line.description.value,
      quantity: normalized.lines[index]?.quantity ?? null,
      unitPrice: normalized.lines[index]?.unitPrice ?? line.unitPrice.value,
      lineNet: normalized.lines[index]?.lineNet ?? line.lineNet.value,
    })),
    subtotal: normalized.subtotal ?? extraction.subtotal.value,
    tax: normalized.tax ?? extraction.tax.value,
    total: normalized.total ?? extraction.total.value,
    complexities: extraction.complexities.map(item => item.code),
  });
}

export function proposeAccountingEntries(
  extraction: InvoiceExtraction,
  arithmetic: ArithmeticReview,
  policy: BookkeepingPolicy,
): AccountingProposal {
  const withheld = (issues: string[]): AccountingProposal => ({
    status: 'withheld_needs_review', policyId: policy.id, policyLabel: policy.label,
    postingPermitted: false, taxTreatmentVerified: false, entries: [], balance: null, issues,
  });
  if (arithmetic.status !== 'arithmetic_consistent') return withheld(['arithmetic_needs_review']);
  const currency = extraction.currency.value;
  const total = extraction.total.value;
  if (currency === null || total === null) return withheld(['missing_currency_or_total']);
  const scale = policy.currencyMinorUnits[currency];
  if (scale === undefined) return withheld(['currency_not_in_trusted_policy']);
  const normalizedTotal = normalizePrintedAmount(total, currency, policy);
  if (normalizedTotal === null) return withheld(['invalid_total_for_trusted_policy']);
  let units: bigint;
  try {
    units = parseUnits(normalizedTotal, scale);
  } catch {
    return withheld(['invalid_total_for_trusted_policy']);
  }
  const amount = formatUnits(units, scale);
  const entries: ProposedEntry[] = [
    {
      side: 'debit', accountId: policy.accounting.debitAccountId, amount, currency,
      basis: 'Demo policy: gross invoice total to unclassified expense; tax treatment not inferred.',
    },
    {
      side: 'credit', accountId: policy.accounting.creditAccountId, amount, currency,
      basis: 'Demo policy: gross invoice total to accounts payable; no posting performed.',
    },
  ];
  return {
    status: 'suggested_human_review_required', policyId: policy.id, policyLabel: policy.label,
    postingPermitted: false, taxTreatmentVerified: false, entries,
    balance: { debits: amount, credits: amount, matches: true }, issues: [],
  };
}

/** Re-evaluates a stored result against the current trusted demo policy without
 * changing its retained model extraction, evidence, or durable source record. */
export function refreshAccountingResult(input: unknown, policy: BookkeepingPolicy): unknown {
  if (!record(input) || !record(input.job) || typeof input.job.id !== 'string' ||
      !record(input.extraction) || !record(input.extraction.values)) return input;
  try {
    const extraction = input.extraction.values as unknown as InvoiceExtraction;
    const arithmetic = reviewExtraction(extraction, input.job.id, policy);
    const accountingProposal = proposeAccountingEntries(extraction, arithmetic, policy);
    return {
      ...structuredClone(input),
      normalizedFinancialValues: normalizeFinancialValues(extraction, policy),
      arithmetic,
      accountingProposal,
      decision: accountingProposal.status === 'suggested_human_review_required' ?
        'proposal_ready_for_human_review' : 'needs_review',
    };
  } catch {
    // Corrupt or older stored shapes remain unchanged and cannot gain a proposal.
    return input;
  }
}

export function assertAllowedResultRecipient(recipient: string, policy: BookkeepingPolicy): void {
  const normalized = recipient.trim().toLowerCase();
  if (!normalized || !policy.allowedResultRecipients.some(item => item.trim().toLowerCase() === normalized)) {
    throw new WorkflowError('result_recipient_not_allowed');
  }
}
