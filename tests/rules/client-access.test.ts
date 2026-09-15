import { afterAll, beforeAll, describe, it } from "vitest";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The browser never uses the Firestore client SDK; every read and write goes
 * through the API routes. These tests pin that decision: a signed-in client,
 * even the record's owner, cannot read or write any collection directly, so
 * ownership alone can never set READY, forge a job, or reach a private solution.
 */
const EMULATOR_AVAILABLE = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

describe.skipIf(!EMULATOR_AVAILABLE)("Firestore security rules", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
    env = await initializeTestEnvironment({
      projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-math-study-buddy",
      firestore: { rules: readFileSync(resolve("firestore.rules"), "utf8"), host, port: Number(port) },
    });
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc("problems/p1").set({ user_id: "alice", title: "Owned by Alice" });
      await context.firestore().doc("reference_solutions/r1").set({ user_id: "alice", artifact: { conclusion: "secret" } });
      await context.firestore().doc("jobs/j1").set({ user_id: "alice", run_state: "QUEUED" });
    });
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("denies the owner direct reads and writes", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(alice.doc("problems/p1").get());
    await assertFails(alice.doc("reference_solutions/r1").get());
    await assertFails(alice.doc("jobs/j1").update({ run_state: "SUCCEEDED" }));
    await assertFails(alice.doc("assistant_sessions/p1").set({ preparation_state: "READY" }));
  });

  it("denies another account and anonymous clients everything", async () => {
    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(bob.doc("problems/p1").get());
    await assertFails(bob.collection("problems").where("user_id", "==", "alice").get());
    const anonymous = env.unauthenticatedContext().firestore();
    await assertFails(anonymous.doc("mathnet_problems/any").get());
    await assertFails(anonymous.doc("profiles/alice").set({ automatic_recommendations: false }));
  });
});
