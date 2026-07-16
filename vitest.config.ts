import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.{ts,mts}",
      "tools/**/*.{test,spec}.{ts,mts,js,mjs}",
    ],
    passWithNoTests: false,
  },
});
