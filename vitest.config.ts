import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "conformance/**/*.conformance.test.ts"],
    globalSetup: ["./vitest.global_setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/testing/**"],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
