import "server-only";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { AppError, fromFirestoreError, statusFor, type ErrorCode } from "@/lib/errors";
import { publicConfig } from "@/lib/config";

export function ok<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, { status: 200, ...init });
}

export function accepted<T>(body: T): NextResponse {
  // Model calls run in durable jobs; creation returns 202 with a job id.
  return NextResponse.json(body, { status: 202 });
}

export function failure(code: ErrorCode, detail?: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: { code, detail, ...extra } }, { status: statusFor(code) });
}

/**
 * Cookie-authenticated mutations require a same-origin request. The browser sends
 * Origin on every cross-origin write, so an absent or foreign Origin is rejected.
 */
export async function assertSameOrigin(): Promise<void> {
  const headerList = await headers();
  const origin = headerList.get("origin");
  const fetchSite = headerList.get("sec-fetch-site");
  if (fetchSite === "cross-site") throw new AppError("FORBIDDEN", "cross-origin request");
  // Non-browser clients may omit Origin. Browser cross-site mutations are still
  // rejected by Sec-Fetch-Site, while ordinary same-origin forms keep working.
  if (!origin) return;
  const allowed = new Set([publicConfig.appOrigin]);
  const host = headerList.get("host");
  if (host) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  if (!allowed.has(origin)) {
    throw new AppError("FORBIDDEN", "cross-origin request");
  }
}

/** Wraps a route handler so every failure becomes a consistent structured error. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof AppError) {
        return failure(error.code, error.detail, error.extra);
      }
      if (error instanceof z.ZodError) {
        return failure("INVALID_REQUEST", error.issues[0]?.message ?? "invalid payload");
      }
      const mapped = fromFirestoreError(error);
      if (mapped.code === "INTERNAL_ERROR") console.error("[route] unhandled error", error);
      return failure(mapped.code, mapped.code === "INTERNAL_ERROR" ? undefined : mapped.detail);
    }
  };
}

export async function parseBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new AppError("INVALID_REQUEST", "expected a JSON body");
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError("INVALID_REQUEST", result.error.issues[0]?.message ?? "invalid payload");
  }
  return result.data;
}
