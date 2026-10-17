import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/worker/src/db/schema.ts",
  out: "./migrations",
});
