/**
 * Dedicated Vitest config. Without it, Vitest falls back to vite.config.ts —
 * which would run the extension build plugin (manifest generation, esbuild
 * passes) on every test run. Aliases mirror tsconfig "paths", which Vitest
 * does not read on its own.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@shared": r("./src/shared"),
      "@background": r("./src/background"),
      "@content": r("./src/content"),
    },
  },
});
