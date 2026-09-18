import { assertScale, formatUnits, lineExtension, parseUnits } from './money.ts';

export interface Issue { code: string; path: string }
export interface Check { path: string; printed: string; calculated: string; delta: string; matches: boolean }
export interface ArithmeticReview {
  status: 'arithmetic_consistent' | 'needs_review';
  basis: 'pre_extracted_values_only';
  taxRateVerified: false;
  extractionVerified: false;
  accountingApproved: false;
  checks: Check[];
  issues: Issue[];
}
function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function exactKeys(x: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(x).every(k => allowed.includes(k));
}
/** Deliberately limited first core. Complex documents fail closed to review.
 * This checks line extensions, the net subtotal, and net + printed tax = gross.
 * It does NOT check tax rates, accounting law, or extraction accuracy.
 */
export function reviewInvoice(input: unknown): ArithmeticReview {
  const result: ArithmeticReview = {
    status: 'needs_review', basis: 'pre_extracted_values_only',
    taxRateVerified: false, extractionVerified: false, accountingApproved: false,
    checks: [], issues: [],
  };
  const issue = (code: string, path: string): void => { result.issues.push({ code, path }); };
  if (!record(input) || !exactKeys(input, ['id','documentType','currency','minorUnits','pricing','rounding','lines','subtotal','tax','total','complexities'])) {
    issue('invalid_schema', 'invoice'); return result;
  }
  if (typeof input.id !== 'string' || !input.id.trim()) issue('missing_identifier', 'id');
  if (input.documentType !== 'invoice') issue('unsupported_document_type', 'documentType');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) issue('currency_unresolved', 'currency');
  if (input.pricing !== 'net') issue('unsupported_pricing', 'pricing');
  if (input.rounding !== 'line_half_away_from_zero') issue('unsupported_rounding', 'rounding');
  if (!Array.isArray(input.complexities) || input.complexities.length !== 0) issue('unsupported_adjustments_or_tax_structure', 'complexities');
  try { assertScale(input.minorUnits as number); } catch { issue('invalid_precision', 'minorUnits'); }
  if (result.issues.length) return result;
  const scale = input.minorUnits as number;
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 1000) {
    issue('invalid_line_count', 'lines'); return result;
  }
  const amount = (value: unknown, path: string): bigint | null => {
    try {
      const units = parseUnits(value, scale);
      if (units < 0n) { issue('negative_amount_requires_review', path); return null; }
      return units;
    } catch { issue(value === null || value === undefined ? 'missing_amount' : 'invalid_amount', path); return null; }
  };
  const compare = (path: string, stated: bigint, calculated: bigint): void => {
    result.checks.push({path, printed: formatUnits(stated, scale), calculated: formatUnits(calculated, scale), delta: formatUnits(stated - calculated, scale), matches: stated === calculated});
    if (stated !== calculated) issue('amount_mismatch', path);
  };
  let lineSum = 0n;
  let everyLineHasNet = true;
  for (let i = 0; i < input.lines.length; i++) {
    const line: unknown = input.lines[i];
    const path = `lines[${i}]`;
    if (!record(line) || !exactKeys(line, ['description','quantity','unitPrice','lineNet'])) {
      issue('invalid_line_schema', path); everyLineHasNet = false; continue;
    }
    if (typeof line.description !== 'string' || !line.description.trim()) issue('missing_description', `${path}.description`);
    const printed = amount(line.lineNet, `${path}.lineNet`);
    if (printed === null) everyLineHasNet = false; else lineSum += printed;
    try {
      // Validate sign BEFORE rounding: a small negative price cannot become zero and pass.
      if (parseUnits(line.quantity, 6) < 0n || parseUnits(line.unitPrice, 6) < 0n) {
        issue('negative_line_requires_review', path);
      } else {
        const calculated = parseUnits(lineExtension(line.quantity, line.unitPrice, scale), scale);
        if (printed !== null) compare(`${path}.lineNet`, printed, calculated);
      }
    } catch { issue('invalid_quantity_or_unit_price', path); }
  }
  const net = amount(input.subtotal, 'subtotal');
  const tax = amount(input.tax, 'tax');
  const total = amount(input.total, 'total');
  if (net !== null && everyLineHasNet) compare('subtotal', net, lineSum);
  if (net !== null && tax !== null && total !== null) compare('total', total, net + tax);
  result.status = result.issues.length ? 'needs_review' : 'arithmetic_consistent';
  return result;
}
