import type { RpcError, RpcErrorCode } from '@tagconn/shared';

/** A failure with a code the UI can switch on, a short cause, and one next step. */
export class RpcFailure extends Error {
  readonly code: RpcErrorCode;
  readonly hint?: string;
  constructor(code: RpcErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'RpcFailure';
    this.code = code;
    this.hint = hint;
  }
  toRpcError(): RpcError {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) };
  }
}
