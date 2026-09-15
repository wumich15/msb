import { describe, expect, it } from "vitest";
import { exportSchema, messageSchema, referenceChoiceSchema } from "@/lib/validation";
import { AppError, fromPostgresError, statusFor } from "@/lib/errors";

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

  it("maps database conflict codes without leaking arbitrary details", () => {
    const error = fromPostgresError({ message: "NOTES_CONFLICT", details: "7" });
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("NOTES_CONFLICT");
    expect(error.status).toBe(409);
    expect(statusFor("AI_LIMIT_REACHED")).toBe(429);
  });
});
