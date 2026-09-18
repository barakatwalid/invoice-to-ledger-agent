export interface SourceEvidence {
  page: number;
  quote: string;
}

export interface SourcedValue {
  value: string | null;
  evidence: SourceEvidence | null;
}

export interface ExtractedLine {
  description: SourcedValue;
  quantity: SourcedValue;
  unitPrice: SourcedValue;
  lineNet: SourcedValue;
}

export interface ExtractedComplexity {
  code: string;
  evidence: SourceEvidence;
}

export const EXTRACTION_COMPLEXITY_CODES = [
  'invoice_discount',
  'line_discount',
  'shipping_charge',
  'withholding_tax',
  'multiple_tax_rates',
  'tax_inclusive_pricing',
  'credit_note',
  'negative_amount',
  'additional_charge',
  'unknown_financial_adjustment',
] as const;

export interface InvoiceExtraction {
  schemaVersion: 'invoice_extraction_v2';
  documentType: SourcedValue;
  supplierName: SourcedValue;
  supplierAddress: SourcedValue;
  supplierTaxRegistrationId: SourcedValue;
  invoiceNumber: SourcedValue;
  invoiceDate: SourcedValue;
  currency: SourcedValue;
  pricing: SourcedValue;
  lines: ExtractedLine[];
  subtotal: SourcedValue;
  tax: SourcedValue;
  total: SourcedValue;
  complexities: ExtractedComplexity[];
}

export interface ExtractionIssue {
  code: string;
  path: string;
}

export type ExtractionValidation =
  | { ok: true; value: InvoiceExtraction }
  | { ok: false; issues: ExtractionIssue[] };

export interface PdfTextPage {
  page: number;
  text: string;
}

const sourcedValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    value: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] },
    evidence: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, maximum: 50 },
            quote: { type: 'string', minLength: 1, maxLength: 500 },
          },
          required: ['page', 'quote'],
        },
        { type: 'null' },
      ],
    },
  },
  required: ['value', 'evidence'],
} as const;

export const INVOICE_EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 'invoice_extraction_v2' },
    documentType: sourcedValueSchema,
    supplierName: sourcedValueSchema,
    supplierAddress: sourcedValueSchema,
    supplierTaxRegistrationId: sourcedValueSchema,
    invoiceNumber: sourcedValueSchema,
    invoiceDate: sourcedValueSchema,
    currency: sourcedValueSchema,
    pricing: sourcedValueSchema,
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: sourcedValueSchema,
          quantity: sourcedValueSchema,
          unitPrice: sourcedValueSchema,
          lineNet: sourcedValueSchema,
        },
        required: ['description', 'quantity', 'unitPrice', 'lineNet'],
      },
    },
    subtotal: sourcedValueSchema,
    tax: sourcedValueSchema,
    total: sourcedValueSchema,
    complexities: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', enum: EXTRACTION_COMPLEXITY_CODES },
          evidence: {
            type: 'object',
            additionalProperties: false,
            properties: {
              page: { type: 'integer', minimum: 1, maximum: 50 },
              quote: { type: 'string', minLength: 1, maxLength: 500 },
            },
            required: ['page', 'quote'],
          },
        },
        required: ['code', 'evidence'],
      },
    },
  },
  required: [
    'schemaVersion', 'documentType', 'supplierName', 'supplierAddress', 'supplierTaxRegistrationId',
    'invoiceNumber', 'invoiceDate',
    'currency', 'pricing', 'lines', 'subtotal', 'tax', 'total', 'complexities',
  ],
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseEvidence(
  input: unknown,
  path: string,
  pages: readonly PdfTextPage[],
  issues: ExtractionIssue[],
): SourceEvidence | null {
  if (!record(input) || !exactKeys(input, ['page', 'quote']) ||
      !Number.isInteger(input.page) || (input.page as number) < 1 ||
      typeof input.quote !== 'string' || !input.quote.trim() || input.quote.length > 500) {
    issues.push({ code: 'invalid_evidence', path });
    return null;
  }
  const pageNumber = input.page as number;
  const page = pages.find(item => item.page === pageNumber);
  if (!page || !normalized(page.text).includes(normalized(input.quote))) {
    issues.push({ code: 'evidence_not_found', path });
    return null;
  }
  return { page: pageNumber, quote: input.quote };
}

function parseSourcedValue(
  input: unknown,
  path: string,
  pages: readonly PdfTextPage[],
  issues: ExtractionIssue[],
): SourcedValue | null {
  if (!record(input) || !exactKeys(input, ['value', 'evidence']) ||
      !(input.value === null || (typeof input.value === 'string' && input.value.length <= 500))) {
    issues.push({ code: 'invalid_sourced_value', path });
    return null;
  }
  if (input.value === null) {
    if (input.evidence !== null) issues.push({ code: 'evidence_without_value', path: `${path}.evidence` });
    return { value: null, evidence: null };
  }
  if (!input.value.trim()) issues.push({ code: 'blank_extracted_value', path: `${path}.value` });
  if (input.evidence === null) {
    issues.push({ code: 'missing_evidence', path: `${path}.evidence` });
    return { value: input.value, evidence: null };
  }
  const evidence = parseEvidence(input.evidence, `${path}.evidence`, pages, issues);
  return { value: input.value, evidence };
}

export function validateInvoiceExtraction(input: unknown, pages: readonly PdfTextPage[]): ExtractionValidation {
  const issues: ExtractionIssue[] = [];
  const keys = [
    'schemaVersion', 'documentType', 'supplierName', 'supplierAddress', 'supplierTaxRegistrationId',
    'invoiceNumber', 'invoiceDate',
    'currency', 'pricing', 'lines', 'subtotal', 'tax', 'total', 'complexities',
  ] as const;
  if (!record(input) || !exactKeys(input, keys) || input.schemaVersion !== 'invoice_extraction_v2') {
    return { ok: false, issues: [{ code: 'invalid_extraction_schema', path: 'extraction' }] };
  }

  const documentType = parseSourcedValue(input.documentType, 'documentType', pages, issues);
  const supplierName = parseSourcedValue(input.supplierName, 'supplierName', pages, issues);
  const supplierAddress = parseSourcedValue(input.supplierAddress, 'supplierAddress', pages, issues);
  const supplierTaxRegistrationId = parseSourcedValue(
    input.supplierTaxRegistrationId,
    'supplierTaxRegistrationId',
    pages,
    issues,
  );
  const invoiceNumber = parseSourcedValue(input.invoiceNumber, 'invoiceNumber', pages, issues);
  const invoiceDate = parseSourcedValue(input.invoiceDate, 'invoiceDate', pages, issues);
  const currency = parseSourcedValue(input.currency, 'currency', pages, issues);
  const pricing = parseSourcedValue(input.pricing, 'pricing', pages, issues);
  const subtotal = parseSourcedValue(input.subtotal, 'subtotal', pages, issues);
  const tax = parseSourcedValue(input.tax, 'tax', pages, issues);
  const total = parseSourcedValue(input.total, 'total', pages, issues);

  const lines: ExtractedLine[] = [];
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) {
    issues.push({ code: 'invalid_extracted_lines', path: 'lines' });
  } else {
    for (let index = 0; index < input.lines.length; index++) {
      const line = input.lines[index];
      const path = `lines[${index}]`;
      if (!record(line) || !exactKeys(line, ['description', 'quantity', 'unitPrice', 'lineNet'])) {
        issues.push({ code: 'invalid_extracted_line', path });
        continue;
      }
      const description = parseSourcedValue(line.description, `${path}.description`, pages, issues);
      const quantity = parseSourcedValue(line.quantity, `${path}.quantity`, pages, issues);
      const unitPrice = parseSourcedValue(line.unitPrice, `${path}.unitPrice`, pages, issues);
      const lineNet = parseSourcedValue(line.lineNet, `${path}.lineNet`, pages, issues);
      if (description && quantity && unitPrice && lineNet) lines.push({ description, quantity, unitPrice, lineNet });
    }
  }

  const complexities: ExtractedComplexity[] = [];
  if (!Array.isArray(input.complexities) || input.complexities.length > 20) {
    issues.push({ code: 'invalid_complexities', path: 'complexities' });
  } else {
    for (let index = 0; index < input.complexities.length; index++) {
      const item = input.complexities[index];
      const path = `complexities[${index}]`;
      if (!record(item) || !exactKeys(item, ['code', 'evidence']) ||
          typeof item.code !== 'string' ||
          !EXTRACTION_COMPLEXITY_CODES.includes(item.code as typeof EXTRACTION_COMPLEXITY_CODES[number])) {
        issues.push({ code: 'invalid_complexity', path });
        continue;
      }
      const evidence = parseEvidence(item.evidence, `${path}.evidence`, pages, issues);
      if (evidence) complexities.push({ code: item.code, evidence });
    }
  }

  if (issues.length || !documentType || !supplierName || !supplierAddress || !supplierTaxRegistrationId ||
      !invoiceNumber || !invoiceDate ||
      !currency || !pricing || !subtotal || !tax || !total) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 'invoice_extraction_v2', documentType, supplierName, supplierAddress,
      supplierTaxRegistrationId, invoiceNumber,
      invoiceDate, currency, pricing, lines, subtotal, tax, total, complexities,
    },
  };
}
