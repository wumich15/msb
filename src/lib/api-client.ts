"use client";

import type { ErrorCode } from "@/lib/errors";

/**
 * Browser-side API wrapper.
 *
 * Every failure arrives as a typed code so the interface can distinguish a
 * revision conflict from a not-ready assistant from a provider outage, and keep
 * the learner's draft in every case.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | string,
    readonly status: number,
    readonly detail?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let response: Response;

  try {
    response = await fetch(path, {
      ...rest,
      headers: {
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(rest.headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("NETWORK_UNAVAILABLE", 0, "Could not reach the application.");
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as
    | { error?: { code: string; detail?: string } & Record<string, unknown> }
    | null;

  if (!response.ok) {
    const error = payload?.error;
    throw new ApiError(error?.code ?? "INTERNAL_ERROR", response.status, error?.detail, error);
  }

  return payload as T;
}

export const isConflict = (error: unknown): error is ApiError =>
  error instanceof ApiError && (error.code === "NOTES_CONFLICT" || error.code === "STATEMENT_CONFLICT");

export const isNotReady = (error: unknown): error is ApiError =>
  error instanceof ApiError && (error.code === "SOLUTION_NOT_READY" || error.code === "STALE_REQUEST");
