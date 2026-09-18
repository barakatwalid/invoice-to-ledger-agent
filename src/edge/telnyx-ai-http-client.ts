import type Telnyx from 'telnyx';
import { WorkflowError } from '../errors.ts';

type AiClient = Pick<Telnyx, 'ai'>;
type Fetcher = typeof fetch;

const TELNYX_API_ORIGIN = 'https://api.telnyx.com';
const MAX_REQUEST_BYTES = 8_000_000;
const MAX_RESPONSE_BYTES = 10_000_000;

function stageFor(path: string): 'model_list' | 'model_completion' {
  return path.endsWith('/models') ? 'model_list' : 'model_completion';
}

async function readBoundedJson(response: Response, stage: string): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new WorkflowError(`${stage}_provider_invalid_response`, true);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowError(`${stage}_provider_invalid_response`, true);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WorkflowError(`${stage}_provider_invalid_response`, true);
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError(`${stage}_provider_connection_error`, true);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new WorkflowError(`${stage}_provider_invalid_response`, true);
  }
}

/**
 * Minimal OpenAI-compatible Telnyx client for Edge.
 *
 * A real image completion received a provider 502 through the Edge API binding.
 * This transport calls only Telnyx's fixed HTTPS API origin with the existing
 * named secret, rejects redirects, bounds payloads/responses, and never includes
 * a provider response body or credential in an error.
 */
export function createDirectTelnyxAiClient(apiKey: string, fetcher: Fetcher = fetch): AiClient {
  if (!apiKey || apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) {
    throw new WorkflowError('invalid_edge_api_key');
  }
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    const stage = stageFor(path);
    let encodedBody: string | undefined;
    if (body !== undefined) {
      try {
        encodedBody = JSON.stringify(body);
      } catch {
        throw new WorkflowError(`${stage}_request_invalid`);
      }
      if (new TextEncoder().encode(encodedBody).byteLength > MAX_REQUEST_BYTES) {
        throw new WorkflowError(`${stage}_request_too_large`);
      }
    }
    let response: Response;
    try {
      response = await fetcher(new URL(path, TELNYX_API_ORIGIN), {
        method: encodedBody === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(stage === 'model_list' ? 30_000 : 180_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...(encodedBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new WorkflowError(`${stage}_provider_timeout`, true);
      }
      throw new WorkflowError(`${stage}_provider_connection_error`, true);
    }
    if (!response.ok) {
      throw new WorkflowError(
        `${stage}_provider_http_${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new WorkflowError(`${stage}_provider_invalid_response`, true);
    }
    return readBoundedJson(response, stage);
  };

  return {
    ai: {
      openai: {
        listModels: () => request('/v2/ai/openai/models'),
        chat: {
          createCompletion: (body: unknown) => request('/v2/ai/openai/chat/completions', body),
        },
      },
    },
  } as unknown as AiClient;
}
