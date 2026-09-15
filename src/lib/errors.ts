/**
 * Application error codes. These are operational: they never carry mathematical
 * content, and a rejected pre-ready chat request must produce one of them rather
 * than a hint.
 */

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "NOTES_CONFLICT",
  "STATEMENT_CONFLICT",
  "SOLUTION_NOT_READY",
  "STALE_REQUEST",
  "AI_LIMIT_REACHED",
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  // A record another user owns is reported as absent, never as forbidden.
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  NOTES_CONFLICT: 409,
  STATEMENT_CONFLICT: 409,
  SOLUTION_NOT_READY: 409,
  STALE_REQUEST: 409,
  AI_LIMIT_REACHED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly extra?: Record<string, unknown>;

  constructor(code: ErrorCode, detail?: string, extra?: Record<string, unknown>) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * A Firestore transaction that throws an AppError aborts and rethrows it; a
 * contention/abort error surfaces as a retriable conflict rather than a crash.
 */
export function fromFirestoreError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: number | string } | null)?.code;
  if (code === 10 || code === "aborted" || code === "ABORTED") {
    return new AppError("STALE_REQUEST", "the record changed while this request ran; retry");
  }
  if (code === 8 || code === "resource-exhausted" || code === 14 || code === "unavailable") {
    return new AppError("UPSTREAM_UNAVAILABLE", "the database is temporarily unavailable");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("INTERNAL_ERROR", message.slice(0, 200));
}
