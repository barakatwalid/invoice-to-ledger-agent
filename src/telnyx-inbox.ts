import type Telnyx from 'telnyx';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkflowError } from './errors.ts';

type InboxClient = Pick<Telnyx, 'emailInboxes'>;

export interface TestInboxReceipt {
  schemaVersion: 'telnyx_test_inbox_receipt_v1';
  inboxId: string;
  address: string;
  domain: string;
  status: 'active' | 'paused';
  providerCreatedAt: string;
  recordedAt: string;
  purpose: 'authorized_invoice_to_ledger_test';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function createSharedTestInbox(client: InboxClient): Promise<TestInboxReceipt> {
  const response = await client.emailInboxes.create({});
  const data = record(response) ? response.data : null;
  if (!record(data) || typeof data.id !== 'string' || !data.id ||
      typeof data.address !== 'string' || !data.address.includes('@') ||
      typeof data.domain !== 'string' || !data.domain ||
      (data.status !== 'active' && data.status !== 'paused') ||
      typeof data.created_at !== 'string' || !data.created_at) {
    throw new WorkflowError('inbox_create_invalid_response');
  }
  return {
    schemaVersion: 'telnyx_test_inbox_receipt_v1',
    inboxId: data.id,
    address: data.address,
    domain: data.domain,
    status: data.status,
    providerCreatedAt: data.created_at,
    recordedAt: new Date().toISOString(),
    purpose: 'authorized_invoice_to_ledger_test',
  };
}

export function validateTestInboxReceipt(value: unknown): TestInboxReceipt {
  if (!record(value) || value.schemaVersion !== 'telnyx_test_inbox_receipt_v1' ||
      typeof value.inboxId !== 'string' || !value.inboxId ||
      typeof value.address !== 'string' || !value.address.includes('@') ||
      typeof value.domain !== 'string' || !value.domain ||
      (value.status !== 'active' && value.status !== 'paused') ||
      typeof value.providerCreatedAt !== 'string' || typeof value.recordedAt !== 'string' ||
      value.purpose !== 'authorized_invoice_to_ledger_test') {
    throw new WorkflowError('invalid_test_inbox_receipt');
  }
  return value as unknown as TestInboxReceipt;
}

export async function writeTestInboxReceipt(path: string, receipt: TestInboxReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function setLocalInboxId(envPath: string, inboxId: string): Promise<void> {
  if (!inboxId || /[\r\n]/.test(inboxId)) throw new WorkflowError('invalid_inbox_id');
  const original = await readFile(envPath, 'utf8');
  const lines = original.split(/\r?\n/);
  const indexes = lines.flatMap((line, index) => line.startsWith('TELNYX_INBOX_ID=') ? [index] : []);
  if (indexes.length > 1) throw new WorkflowError('duplicate_local_inbox_id_setting');
  if (indexes.length === 1) {
    const current = lines[indexes[0]!]!.slice('TELNYX_INBOX_ID='.length);
    if (current && current !== inboxId) throw new WorkflowError('local_inbox_id_already_set');
    lines[indexes[0]!] = `TELNYX_INBOX_ID=${inboxId}`;
  } else {
    lines.push(`TELNYX_INBOX_ID=${inboxId}`);
  }
  const temporary = `${envPath}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, envPath);
  await chmod(envPath, 0o600);
}
