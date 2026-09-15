import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { CollectionReference, DocumentData, Firestore } from "firebase-admin/firestore";
import { db } from "@/lib/db/admin";

/**
 * Collection names and deterministic document ids.
 *
 * Every private collection stores `user_id`. Records that must be unique per key
 * (one notes document per problem, one job per idempotency key, one chat turn per
 * request id) use deterministic ids so a duplicate write lands on the same
 * document instead of creating a second one. Server-only collections
 * (reference_solutions, problem_idea_profiles, mathnet_solution_data,
 * mse_lookup_cache) are never projected to a browser response.
 */

export const COLLECTIONS = {
  profiles: "profiles",
  folders: "folders",
  problems: "problems",
  problemVersions: "problem_versions",
  notes: "notes",
  studyEvents: "study_events",
  assistantSessions: "assistant_sessions",
  referenceSolutions: "reference_solutions",
  chatThreads: "chat_threads",
  chatMessages: "chat_messages",
  ideaProfiles: "problem_idea_profiles",
  jobs: "jobs",
  aiUsage: "ai_usage",
  exports: "exports",
  mseLookupCache: "mse_lookup_cache",
  mathnetReleases: "mathnet_releases",
  mathnetProblems: "mathnet_problems",
  mathnetSolutionData: "mathnet_solution_data",
  recommendationRuns: "recommendation_runs",
  recommendationItems: "recommendation_items",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export function col(name: CollectionName, firestore: Firestore = db()): CollectionReference<DocumentData> {
  return firestore.collection(name);
}

export function newId(): string {
  return randomUUID();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Firestore ids may not contain "/" and must stay short; hashing keeps both true. */
export function derivedId(...parts: string[]): string {
  return sha256(parts.map((part) => `${part.length}:${part}`).join("|")).slice(0, 40);
}

export const ids = {
  versionDoc: (problemId: string, version: number) => `${problemId}_v${version}`,
  /** One conversation thread per statement version keeps superseded turns out of context. */
  threadDoc: (problemId: string, statementVersion: number) => `${problemId}_s${statementVersion}`,
  chatRequest: (userId: string, problemId: string, requestId: string) => derivedId("chat", userId, problemId, requestId),
  job: (userId: string, idempotencyKey: string) => derivedId("job", userId, idempotencyKey),
  usage: (userId: string, date: string) => `${userId}_${date}`,
  ideaProfile: (problemId: string, inputHash: string, classifierVersion: string) =>
    derivedId("idea", problemId, inputHash, classifierVersion),
  release: (datasetId: string, revision: string, indexVersion: number) =>
    derivedId("release", datasetId, revision, String(indexVersion)),
  mathnetProblem: (releaseId: string, sourceId: string) => `${releaseId}_${derivedId("mathnet", sourceId).slice(0, 24)}`,
};

export function utcDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Splits values into chunks that fit Firestore's `in` / `array-contains-any` limit. */
export function chunk<T>(values: T[], size = 30): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
