import { defineConfig } from "vitest/config";

// The stdio smoke test (test/smoke.test.ts) spawns the BUILT dist/index.js.
// `npm test` works because the "pretest" script runs "npm run build" first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
