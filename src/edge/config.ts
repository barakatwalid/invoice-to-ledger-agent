import { parseAllowedAttachmentHosts } from '../attachment.ts';
import { WorkflowError } from '../errors.ts';
import { validateEdgePdfRendererConfig } from './pdf-renderer-client.ts';

export interface EdgeAgentConfig {
  inboxId: string;
  modelId: string;
  attachmentHosts: string[];
  pollIntervalSeconds: number;
}

export type EdgeSecretHandle =
  'CONTROL_TOKEN' | 'INBOX_ID' | 'MODEL_ID' | 'ATTACHMENT_HOSTS' | 'API_KEY' |
  'PDF_RENDERER_URL' | 'PDF_RENDERER_TOKEN';

export interface EdgeSecretReader {
  get(handle: EdgeSecretHandle): Promise<string>;
}

async function requiredSecret(secrets: EdgeSecretReader, handle: EdgeSecretHandle): Promise<string> {
  let value: string;
  try {
    value = await secrets.get(handle);
  } catch {
    throw new WorkflowError('edge_secret_read_failed');
  }
  const trimmed = value.trim();
  if (!trimmed) throw new WorkflowError(`edge_missing_${handle.toLowerCase()}`);
  return trimmed;
}

export function validateEdgeAgentConfig(input: unknown): EdgeAgentConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkflowError('invalid_edge_agent_config');
  }
  const value = input as Record<string, unknown>;
  const keys = ['inboxId', 'modelId', 'attachmentHosts', 'pollIntervalSeconds'];
  if (Object.keys(value).length !== keys.length || !Object.keys(value).every(key => keys.includes(key)) ||
      typeof value.inboxId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.inboxId) ||
      typeof value.modelId !== 'string' || !value.modelId.trim() || value.modelId.length > 300 ||
      !Array.isArray(value.attachmentHosts) || value.attachmentHosts.length < 1 ||
      !value.attachmentHosts.every(item => typeof item === 'string') ||
      !Number.isInteger(value.pollIntervalSeconds) ||
      (value.pollIntervalSeconds as number) < 15 || (value.pollIntervalSeconds as number) > 3_600) {
    throw new WorkflowError('invalid_edge_agent_config');
  }
  const hosts = [...parseAllowedAttachmentHosts((value.attachmentHosts as string[]).join(','))];
  if (hosts.length !== value.attachmentHosts.length) throw new WorkflowError('invalid_edge_agent_config');
  return {
    inboxId: value.inboxId,
    modelId: value.modelId,
    attachmentHosts: hosts,
    pollIntervalSeconds: value.pollIntervalSeconds as number,
  };
}

/** Migrates only the previously deployed exact-subject state shape; new inputs remain strict. */
export function validateStoredEdgeAgentConfig(input: unknown): EdgeAgentConfig {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length === 5 && keys.includes('targetSubject') &&
        typeof value.targetSubject === 'string' && value.targetSubject.trim() &&
        value.targetSubject.length <= 500) {
      const { targetSubject: _obsoleteTargetSubject, ...current } = value;
      return validateEdgeAgentConfig(current);
    }
  }
  return validateEdgeAgentConfig(input);
}

export async function readEdgeAgentConfig(secrets: EdgeSecretReader): Promise<EdgeAgentConfig> {
  const [inboxId, modelId, attachmentHosts] = await Promise.all([
    requiredSecret(secrets, 'INBOX_ID'),
    requiredSecret(secrets, 'MODEL_ID'),
    requiredSecret(secrets, 'ATTACHMENT_HOSTS'),
  ]);
  return validateEdgeAgentConfig({
    inboxId,
    modelId,
    attachmentHosts: [...parseAllowedAttachmentHosts(attachmentHosts)],
    pollIntervalSeconds: 60,
  });
}

export async function readEdgeControlToken(secrets: EdgeSecretReader): Promise<string> {
  const token = await requiredSecret(secrets, 'CONTROL_TOKEN');
  if (token.length < 32 || token.length > 512) throw new WorkflowError('invalid_edge_control_token');
  return token;
}

export async function readEdgeApiKey(secrets: EdgeSecretReader): Promise<string> {
  const apiKey = await requiredSecret(secrets, 'API_KEY');
  if (apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) {
    throw new WorkflowError('invalid_edge_api_key');
  }
  return apiKey;
}

export async function readEdgePdfRendererConfig(
  secrets: EdgeSecretReader,
): Promise<{ baseUrl: string; token: string }> {
  const [baseUrl, token] = await Promise.all([
    requiredSecret(secrets, 'PDF_RENDERER_URL'),
    requiredSecret(secrets, 'PDF_RENDERER_TOKEN'),
  ]);
  return validateEdgePdfRendererConfig({ baseUrl, token });
}

export async function deriveEdgeViewerToken(controlToken: string): Promise<string> {
  if (controlToken.length < 32 || controlToken.length > 512) {
    throw new WorkflowError('invalid_edge_control_token');
  }
  const bytes = new TextEncoder().encode(`telnyx-bookkeeping-viewer-v1\0${controlToken}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function constantTimeEqual(supplied: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(supplied);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export function hasAuthorizedBearer(request: Request, expectedToken: string): boolean {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  return constantTimeEqual(header.slice('Bearer '.length), expectedToken);
}

export function hasAuthorizedViewer(request: Request, expectedToken: string): boolean {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return false;
  try {
    return constantTimeEqual(atob(header.slice('Basic '.length)), `review:${expectedToken}`);
  } catch {
    return false;
  }
}
