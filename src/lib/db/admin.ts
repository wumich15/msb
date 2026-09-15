import "server-only";
import { applicationDefault, cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Bucket } from "@google-cloud/storage";
import { firebaseAdminConfig } from "@/lib/config";

/**
 * Firebase Admin SDK, server-only.
 *
 * The Admin SDK bypasses Firestore and Storage security rules, so every caller in
 * this codebase re-verifies ownership itself: routes derive the owner from the
 * verified session cookie, and workers re-read the live records by user id.
 * Nothing here is ever imported from a client component.
 *
 * With FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST /
 * FIREBASE_STORAGE_EMULATOR_HOST set, the SDK talks to the local emulators and no
 * service-account credential is needed.
 */

let app: App | null = null;

export function usingEmulators(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

export function adminApp(): App {
  if (app) return app;
  const existing = getApps()[0];
  if (existing) {
    app = existing;
    return app;
  }
  const config = firebaseAdminConfig();
  const credential = config.clientEmail && config.privateKey
    ? cert({ projectId: config.projectId, clientEmail: config.clientEmail, privateKey: config.privateKey })
    : usingEmulators()
      ? undefined
      : applicationDefault();
  app = initializeApp({
    ...(credential ? { credential } : {}),
    projectId: config.projectId,
    storageBucket: config.storageBucket || undefined,
  });
  return app;
}

let firestore: Firestore | null = null;

/** The one Firestore handle. Callers pass it into transactions explicitly. */
export function db(): Firestore {
  if (firestore) return firestore;
  firestore = getFirestore(adminApp());
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}

/** Private bucket for export archives; objects live under exports/<user_id>/. */
export function exportsBucket(): Bucket {
  const config = firebaseAdminConfig();
  return getStorage(adminApp()).bucket(config.storageBucket || undefined) as unknown as Bucket;
}

export function nowIso(): string {
  return new Date().toISOString();
}
