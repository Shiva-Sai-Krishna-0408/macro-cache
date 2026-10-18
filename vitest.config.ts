import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./apps/worker/test/stubs/cloudflare-workers.ts", import.meta.url)) },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/worker/test/**/*.test.ts"],
    environment: "node",
    // Inline so the cloudflare:workers alias applies inside the OAuth library.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
