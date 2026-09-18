import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SyntheticInvalidOutputDiagnostic } from './telnyx-adapter.ts';
import { WorkflowError } from './errors.ts';

export async function writeSyntheticModelDiagnostic(
  outputDirectory: string,
  jobId: string,
  diagnostic: SyntheticInvalidOutputDiagnostic,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(jobId)) throw new WorkflowError('invalid_model_diagnostic_job_id');
  if (diagnostic.content.length > 100_000) throw new WorkflowError('model_diagnostic_too_large');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const contentSha256 = createHash('sha256').update(diagnostic.content).digest('hex');
  const path = join(outputDirectory, `${jobId}.${contentSha256.slice(0, 16)}.invalid-model-output.json`);
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  const body = {
    syntheticLocalPdfOnly: true,
    warning: 'Private diagnostic; never enable raw-output capture for real email or customer invoices.',
    finishReason: diagnostic.finishReason,
    responseModelId: diagnostic.responseModelId,
    contentSha256,
    content: diagnostic.content,
  };
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return path;
}
