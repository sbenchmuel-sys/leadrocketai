import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Dummy Supabase env so modules that construct the client at import time
    // (src/integrations/supabase/client.ts) don't throw during unit tests. The
    // client is never actually called over the network in unit tests.
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-anon-key",
    },
    // Integration tests (live staging, network) run separately via
    // vitest.integration.config.ts — keep them out of the default unit run.
    exclude: [...configDefaults.exclude, "src/test/integration/**"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
