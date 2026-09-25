import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/delta.ts",
        "src/thresholds.ts",
        "src/alerts.ts",
        "src/llama.ts",
        "src/kv.ts",
        "src/subgraph.ts",
        "src/foundation/*.ts",
      ],
    },
  },
});
