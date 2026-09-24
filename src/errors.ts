/**
 * One error type for everything a caller can act on.
 *
 * `code` is stable and meant to be branched on by agents; `hint` says what to do
 * next. Tools return these as `isError` results; HTTP routes as
 * `{ error: { code, message, hint } }`.
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CONFIG"
  | "BUDGET_EXCEEDED"
  | "UPSTREAM_BLOCKED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_CHANGED"
  | "PLACE_NOT_FOUND"
  | "STATION_NOT_FOUND"
  | "AREA_NOT_FOUND"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  CONFIG: 500,
  BUDGET_EXCEEDED: 429,
  UPSTREAM_BLOCKED: 502,
  UPSTREAM_ERROR: 502,
  UPSTREAM_CHANGED: 502,
  PLACE_NOT_FOUND: 404,
  STATION_NOT_FOUND: 404,
  AREA_NOT_FOUND: 404,
  INTERNAL: 500,
};

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; hint?: string };
}

export function toErrorBody(err: unknown): ErrorBody {
  if (isAppError(err)) {
    return {
      error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: "INTERNAL", message } };
}

export function statusFor(err: unknown): number {
  return isAppError(err) ? err.status : 500;
}
