import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Emulator-backed tests. Start `npm run emulators` first (or run through
 * `firebase emulators:exec`). Each file skips itself when FIRESTORE_EMULATOR_HOST
 * is not set, so deterministic CI without the emulator stays green and honest.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts", "tests/rules/**/*.test.ts"],
    globals: true,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
