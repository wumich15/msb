import { createHash } from "node:crypto";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Admin SDK bootstrap for operator scripts. Uses the same environment as the
 * application: FIREBASE_PROJECT_ID plus either a service-account key pair,
 * application-default credentials, or the emulator hosts.
 */
export function adminFirestore(): Firestore {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required");
  if (getApps().length === 0) {
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
    const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
    initializeApp({
      projectId,
      ...(clientEmail && privateKey
        ? { credential: cert({ projectId, clientEmail, privateKey }) }
        : emulator
          ? {}
          : { credential: applicationDefault() }),
    });
  }
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

/** Mirrors src/lib/db/collections.ts so scripts and the app agree on ids. */
export function derivedId(...parts: string[]): string {
  return createHash("sha256").update(parts.map((part) => `${part.length}:${part}`).join("|")).digest("hex").slice(0, 40);
}

export function releaseId(datasetId: string, revision: string, indexVersion: number): string {
  return derivedId("release", datasetId, revision, String(indexVersion));
}

export function mathnetProblemId(release: string, sourceId: string): string {
  return `${release}_${derivedId("mathnet", sourceId).slice(0, 24)}`;
}
