import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests run against the live STAGING Supabase project (never prod —
// enforced by src/test/integration/setup.ts). Kept OUT of the default `npm test`
// run because they require network + the gitignored .env.staging.
// Run with: npm run test:isolation
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/test/integration/**/*.test.ts"],
    setupFiles: ["./src/test/integration/setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
