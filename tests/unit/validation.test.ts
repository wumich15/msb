import { describe, expect, it } from "vitest";
import { exportSchema, messageSchema, referenceChoiceSchema } from "@/lib/validation";
import { AppError, fromFirestoreError, statusFor } from "@/lib/errors";

describe("request validation and errors", () => {
  it("requires a scope id for problem and folder exports", () => {
    expect(exportSchema.safeParse({ scope: "problem" }).success).toBe(false);
    expect(exportSchema.safeParse({ scope: "folder", scopeId: null }).success).toBe(false);
    expect(exportSchema.safeParse({ scope: "account" }).success).toBe(true);
  });

  it("requires pasted work only for the provide path", () => {
    expect(referenceChoiceSchema.safeParse({ choice: "provide", expectedStatementVersion: 1 }).success).toBe(false);
    expect(referenceChoiceSchema.safeParse({ choice: "find", expectedStatementVersion: 1 }).success).toBe(true);
  });

  it("does not silently turn free-form questions into solution requests", () => {
    const parsed = messageSchema.parse({ requestId: "request-123", question: "Please solve it", expectedNotesRevision: 2 });
    expect(parsed.responseMode).toBe("default");
  });

  it("passes application errors through and maps database contention to a retriable conflict", () => {
    const conflict = fromFirestoreError(new AppError("NOTES_CONFLICT", "7"));
    expect(conflict.code).toBe("NOTES_CONFLICT");
    expect(conflict.detail).toBe("7");
    expect(conflict.status).toBe(409);

    const aborted = fromFirestoreError(Object.assign(new Error("10 ABORTED: contention"), { code: 10 }));
    expect(aborted.code).toBe("STALE_REQUEST");

    const unknown = fromFirestoreError(new Error("secret internal detail"));
    expect(unknown.code).toBe("INTERNAL_ERROR");
    expect(statusFor("AI_LIMIT_REACHED")).toBe(429);
  });
});
