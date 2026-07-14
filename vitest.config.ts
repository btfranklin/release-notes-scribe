import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { GITHUB_ACTIONS: "false" },
    environment: "node",
    sequence: { concurrent: false },
  },
});
