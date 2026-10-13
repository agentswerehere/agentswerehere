import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

const alias = {
  "@agentswerehere/core": `${root}packages/core/src/index.ts`,
  "@agentswerehere/sdk": `${root}packages/sdk/src/index.ts`,
  "@agentswerehere/config": `${root}config/index.ts`,
};

export default defineConfig({
  resolve: { alias },
  test: {
    // These options apply to every project. Vitest ignores them inside a project.
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      {
        esbuild: { jsx: "automatic" },
        resolve: { alias },
        test: {
          name: "unit",
          include: [
            "packages/**/*.test.ts",
            "apps/**/*.unit.test.ts",
            "config/**/*.test.ts",
            "infra/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["apps/api/test/**/*.test.ts"],
          environment: "node",
          hookTimeout: 120_000,
          testTimeout: 60_000,
          globalSetup: ["./apps/api/test/global-setup.ts"],
        },
      },
    ],
  },
});
