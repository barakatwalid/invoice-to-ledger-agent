import { errorCode, WorkflowError } from '../errors.ts';
import { SUPPORTED_INVOICE_CONTENT_TYPES } from '../attachment.ts';
import { BookkeepingAgentV2, type EdgeInvoiceDocument } from './bookkeeping-agent.ts';
import {
  deriveEdgeViewerToken,
  hasAuthorizedBearer,
  hasAuthorizedViewer,
  readEdgeAgentConfig,
  readEdgeControlToken,
} from './config.ts';
import { renderHostedDashboard, renderHostedUnavailable } from './dashboard.ts';
import { renderHowItWorks } from './how-it-works.ts';

export { BookkeepingAgentV2 };

const EDGE_ACTOR_INSTANCE_NAME = 'authorized-bookkeeping-inbox-http-v1';

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function dashboard(html: string): Response {
  return new Response(html, { headers: {
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  } });
}

function unavailableDashboard(): Response {
  return new Response(renderHostedUnavailable(), { status: 503, headers: {
    'cache-control': 'private, no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'retry-after': '30',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  } });
}

function invoiceDocument(document: EdgeInvoiceDocument): Response {
  if (!(document.bytes instanceof Uint8Array) || document.bytes.byteLength !== document.sizeBytes ||
      !SUPPORTED_INVOICE_CONTENT_TYPES.includes(document.contentType) ||
      typeof document.filename !== 'string' || !document.filename.trim() || document.filename.length > 255) {
    throw new WorkflowError('invalid_edge_invoice_document');
  }
  const encodedFilename = encodeURIComponent(document.filename).replaceAll("'", '%27');
  const body = new Uint8Array(document.bytes).buffer;
  return new Response(body, { headers: {
    'cache-control': 'private, no-store',
    'content-disposition': `inline; filename*=UTF-8''${encodedFilename}`,
    'content-length': String(document.sizeBytes),
    'content-security-policy': "default-src 'none'; sandbox",
    'content-type': document.contentType,
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  } });
}

function viewerChallenge(): Response {
  return new Response('Authentication required.', { status: 401, headers: {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Basic realm="Telnyx Bookkeeping Review", charset="UTF-8"',
    'x-content-type-options': 'nosniff',
  } });
}

const MAX_BATCH_REQUEST_BYTES = 120_000;

async function readBoundedJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new WorkflowError('edge_json_content_type_required');
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new WorkflowError('invalid_edge_content_length');
    if (length > MAX_BATCH_REQUEST_BYTES) throw new WorkflowError('edge_request_too_large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BATCH_REQUEST_BYTES) {
    throw new WorkflowError('edge_request_too_large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkflowError('invalid_edge_json');
  }
}

function requestErrorStatus(code: string): number {
  if (code === 'edge_request_too_large') return 413;
  if (code === 'edge_json_content_type_required') return 415;
  if (code === 'invalid_edge_content_length' || code === 'invalid_edge_json' ||
      code === 'invalid_edge_batch_configuration') return 400;
  return 503;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ status: 'ready', service: 'invoice-to-ledger-agent' });
  }

  const invoicePath = url.pathname.match(/^\/invoices\/([a-f0-9]{64})(\/document)?$/);
  if (request.method === 'GET' &&
      (url.pathname === '/' || url.pathname === '/how-it-works' || url.pathname.startsWith('/invoices/'))) {
    let viewerToken: string;
    try {
      viewerToken = await deriveEdgeViewerToken(await readEdgeControlToken(env.SECRETS));
    } catch {
      return unavailableDashboard();
    }
    if (!hasAuthorizedViewer(request, viewerToken)) return viewerChallenge();
    if (url.pathname === '/how-it-works') return dashboard(renderHowItWorks());
    if (url.pathname.startsWith('/invoices/') && invoicePath === null) {
      return json({ error: 'invalid_edge_job_id' }, 400);
    }
    try {
      const actor = env.INVOICE_AGENT.idFromName(EDGE_ACTOR_INSTANCE_NAME);
      if (invoicePath?.[2] === '/document') {
        const document = await actor.invoiceDocument(invoicePath[1]!);
        return document === null ? json({ error: 'result_not_found' }, 404) : invoiceDocument(document);
      }
      const status = await actor.status();
      let jobId = status.lastCompletedJobId;
      if (invoicePath !== null) jobId = invoicePath[1]!;
      const result = jobId === null ? null : await actor.result(jobId);
      if (invoicePath !== null && result === null) {
        return json({ error: 'result_not_found' }, 404);
      }
      let monitor = null;
      let monitorErrorCode: string | null = null;
      try {
        monitor = await actor.inboxMonitor();
      } catch (error) {
        monitorErrorCode = errorCode(error);
      }
      return dashboard(renderHostedDashboard(status, result, monitor, monitorErrorCode, {
        detailJobId: invoicePath?.[1] ?? null,
      }));
    } catch {
      return unavailableDashboard();
    }
  }

  let controlToken: string;
  try {
    controlToken = await readEdgeControlToken(env.SECRETS);
  } catch (error) {
    return json({ status: 'blocked', error: errorCode(error) }, 503);
  }
  if (!hasAuthorizedBearer(request, controlToken)) return json({ error: 'unauthorized' }, 401);

  const actor = env.INVOICE_AGENT.idFromName(EDGE_ACTOR_INSTANCE_NAME);
  if (request.method === 'POST' && url.pathname === '/control/start') {
    try {
      return json(await actor.start(await readEdgeAgentConfig(env.SECRETS)));
    } catch (error) {
      return json({ status: 'blocked', error: errorCode(error) }, 503);
    }
  }
  if (request.method === 'POST' && url.pathname === '/control/stop') return json(await actor.stop());
  if (request.method === 'POST' && url.pathname === '/control/poll') {
    try {
      const outcome = await actor.pollNow();
      if (!outcome.ok) {
        return json({ error: outcome.errorCode }, outcome.errorCode === 'edge_agent_not_running' ? 409 : 503);
      }
      return json(outcome.status);
    } catch (error) {
      const code = errorCode(error);
      return json({ error: code }, code === 'edge_agent_not_running' ? 409 : 503);
    }
  }
  if (request.method === 'POST' && url.pathname === '/control/batch') {
    try {
      return json(await actor.configureBatch(await readBoundedJson(request)));
    } catch (error) {
      const code = errorCode(error);
      return json({ error: code }, requestErrorStatus(code));
    }
  }
  if (request.method === 'POST' && url.pathname === '/control/batch/close') {
    try {
      return json(await actor.closeBatch());
    } catch (error) {
      return json({ error: errorCode(error) }, 503);
    }
  }
  if (request.method === 'POST' && url.pathname === '/control/history/clear') {
    try {
      const outcome = await actor.clearPriorHistory();
      if (!outcome.ok) {
        return json({ error: outcome.errorCode }, 409);
      }
      return json(outcome.status);
    } catch (error) {
      const code = errorCode(error);
      return json({ error: code }, 503);
    }
  }
  if (request.method === 'POST' && /^\/control\/jobs\/[a-f0-9]{64}\/hide$/.test(url.pathname)) {
    const jobId = url.pathname.slice('/control/jobs/'.length, -'/hide'.length);
    try {
      const outcome = await actor.hideFailedJob(jobId);
      if (!outcome.ok) return json({ error: outcome.errorCode }, 409);
      return json(outcome.status);
    } catch (error) {
      return json({ error: errorCode(error) }, 503);
    }
  }
  if (request.method === 'GET' && url.pathname === '/status') {
    try {
      return json(await actor.status());
    } catch (error) {
      return json({ status: 'blocked', error: errorCode(error) }, 503);
    }
  }
  if (request.method === 'GET' && url.pathname.startsWith('/results/')) {
    const jobId = url.pathname.slice('/results/'.length);
    try {
      const result = await actor.result(jobId);
      return result === null ? json({ error: 'result_not_found' }, 404) : json(result);
    } catch (error) {
      return json({ error: errorCode(error) }, 400);
    }
  }
  return json({ error: 'not_found' }, 404);
}

export default { fetch: handle };
