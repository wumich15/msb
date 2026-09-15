import { randomUUID } from "node:crypto";

/**
 * Emulator-backed test helpers. These tests exercise the real transaction code
 * against the Firestore emulator with two independent accounts; they skip
 * themselves when the emulator is not configured.
 */

export const EMULATOR_AVAILABLE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

process.env.FIREBASE_PROJECT_ID ??= "demo-math-study-buddy";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??= process.env.FIREBASE_PROJECT_ID;
process.env.FIREBASE_STORAGE_BUCKET ??= `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;

export function freshUser(): string {
  return `user-${randomUUID()}`;
}

export async function clearEmulator(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
}
