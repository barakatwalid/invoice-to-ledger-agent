/** These inputs come from trusted batch state, never from instructions in a PDF.
 * Identity resolution and persistent deduplication are NOT implemented here.
 * canonicalId must already identify a unique invoice within this account/batch.
 */
export interface ReceivedInvoice { canonicalId: string; businessReference: string | null }
export interface BatchInput {
  received: readonly ReceivedInvoice[];
  expectedCount: number | null;
  expectedManifest: readonly string[] | null;
  unresolvedDocuments: number;
}
export interface BatchResult {
  status: 'unknown' | 'incomplete' | 'needs_review' | 'count_match_only' | 'manifest_match';
  uniqueReceived: number;
  duplicateOccurrences: number;
  expectedCount: number | null;
  countState: 'unknown' | 'short' | 'excess' | 'match';
  missingReferences: string[];
  unexpectedReferences: string[];
  issues: string[];
}
function validString(s: unknown): s is string { return typeof s === 'string' && !!s.trim() && s.length <= 1000; }
function validCount(n: unknown): n is number { return Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 10000; }
export function businessReference(supplierId: string, invoiceNumber: string): string {
  if (!validString(supplierId) || !validString(invoiceNumber)) throw new TypeError('Supplier and invoice references are required');
  // Structural encoding avoids ambiguous delimiter concatenation; do not case-fold identifiers.
  return JSON.stringify([supplierId, invoiceNumber]);
}
export function checkCompleteness(input: BatchInput): BatchResult {
  if (!input || !Array.isArray(input.received) || input.received.length > 10000 ||
      !validCount(input.unresolvedDocuments) ||
      !(input.expectedCount === null || validCount(input.expectedCount)) ||
      !(input.expectedManifest === null || (Array.isArray(input.expectedManifest) && input.expectedManifest.length <= 10000 && input.expectedManifest.every(validString)))) {
    throw new TypeError('Invalid trusted batch metadata');
  }
  const manifest = input.expectedManifest;
  if (manifest !== null && new Set(manifest).size !== manifest.length) throw new TypeError('Duplicate expected references');
  if (manifest !== null && input.expectedCount !== null && input.expectedCount !== manifest.length) throw new TypeError('Expected count contradicts manifest');
  const issues: string[] = [];
  const unique = new Map<string,string|null>();
  for (const item of input.received) {
    if (!item || !validString(item.canonicalId) || !(item.businessReference === null || validString(item.businessReference))) throw new TypeError('Invalid received invoice identity');
    if (unique.has(item.canonicalId) && unique.get(item.canonicalId) !== item.businessReference) issues.push('conflicting_identity_for_canonical_id');
    if (!unique.has(item.canonicalId)) unique.set(item.canonicalId,item.businessReference);
  }
  const references = [...unique.values()].filter((x): x is string => x !== null);
  const referenceSet = new Set(references);
  if (referenceSet.size !== references.length) issues.push('different_canonical_ids_share_business_reference');
  if (input.unresolvedDocuments) issues.push('unresolved_documents');
  if (manifest !== null && references.length !== unique.size) issues.push('unresolved_business_reference');
  const expected = input.expectedCount ?? (manifest === null ? null : manifest.length);
  const countState = expected === null ? 'unknown' : unique.size < expected ? 'short' : unique.size > expected ? 'excess' : 'match';
  const missing = manifest === null ? [] : manifest.filter(ref => !referenceSet.has(ref));
  const unexpected = manifest === null ? [] : [...referenceSet].filter(ref => !manifest.includes(ref));
  let status: BatchResult['status'];
  if (issues.length) status = 'needs_review';
  else if (countState === 'unknown') status = 'unknown';
  else if (countState === 'short') status = 'incomplete';
  else if (countState === 'excess' || missing.length || unexpected.length) status = 'needs_review';
  else status = manifest === null ? 'count_match_only' : 'manifest_match';
  return {status, uniqueReceived: unique.size, duplicateOccurrences: input.received.length - unique.size,
    expectedCount: expected, countState, missingReferences: missing, unexpectedReferences: unexpected, issues};
}
