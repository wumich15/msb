"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import { publicConfig } from "@/lib/config";

/**
 * Browser-side Firebase app, used only for Firebase Auth's email-link sign-in.
 *
 * The browser never talks to Firestore or Storage: all data access goes through
 * the API routes, and the security rules deny client SDK access entirely. The web
 * API key and project identifiers here are public configuration, not secrets.
 */

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (cachedApp) return cachedApp;
  cachedApp = getApps().length
    ? getApp()
    : initializeApp({
        apiKey: publicConfig.firebase.apiKey || "emulator",
        authDomain: publicConfig.firebase.authDomain || undefined,
        projectId: publicConfig.firebase.projectId || "demo-math-study-buddy",
        appId: publicConfig.firebase.appId || undefined,
      });
  return cachedApp;
}

export function getFirebaseAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseApp());
  if (publicConfig.firebase.authEmulatorUrl) {
    connectAuthEmulator(cachedAuth, publicConfig.firebase.authEmulatorUrl, { disableWarnings: true });
  }
  return cachedAuth;
}

/** Same-device email-link completion needs the address the link was sent to. */
export const SIGN_IN_EMAIL_KEY = "msb.signin.email";
