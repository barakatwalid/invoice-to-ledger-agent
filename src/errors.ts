/** Safe operational errors carry only a stable code suitable for logs and evidence. */
export class WorkflowError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = false) {
    super(code);
    this.name = 'WorkflowError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorCode(error: unknown): string {
  return error instanceof WorkflowError ? error.code : 'unexpected_error';
}
