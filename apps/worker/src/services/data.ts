import { roundNutrients } from "@macro-cache/core";
import { asc, isNull } from "drizzle-orm";
import { auditLog, container, food, logEntry, profile, recipe, restaurantOrder, template, weightEntry } from "../db/schema";
import type { Ctx } from "./context";

export const EXPORT_VERSION = 1;

const TABLES = { profile, weightEntry, food, recipe, container, restaurantOrder, logEntry, template } as const;

/** Full JSON export of the user's data. */
export async function exportJson(ctx: Ctx) {
  const out: Record<string, unknown[]> = {};
  for (const [name, t] of Object.entries(TABLES)) out[name] = await ctx.db.select().from(t as any).all();
  return { app: "macro-cache", version: EXPORT_VERSION, exportedAt: new Date().toISOString(), data: out };
}

/** Replace all data with an export. Dashboard-only (never exposed to Claude). */
export async function importJson(ctx: Ctx, payload: { app?: string; version?: number; data?: Record<string, Record<string, unknown>[]> }) {
  if (payload.app !== "macro-cache" || !payload.data) throw new Error("Not a macro-cache export file.");
  if ((payload.version ?? 0) > EXPORT_VERSION) throw new Error("Export is from a newer version.");
  const counts: Record<string, number> = {};
  // Clear in dependency-free order (no FKs), then insert.
  for (const t of Object.values(TABLES)) await ctx.db.delete(t as any);
  await ctx.db.delete(auditLog);
  for (const [name, t] of Object.entries(TABLES)) {
    const rows = payload.data[name] ?? [];
    counts[name] = rows.length;
    for (let i = 0; i < rows.length; i += 20) {
      const chunk = rows.slice(i, i + 20);
      if (chunk.length) await ctx.db.insert(t as any).values(chunk as any);
    }
  }
  return { imported: counts };
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(ctx: Ctx, kind: "log" | "weights") {
  if (kind === "weights") {
    const rows = await ctx.db.select().from(weightEntry).where(isNull(weightEntry.deletedAt)).orderBy(asc(weightEntry.date)).all();
    return ["date,weight_kg,body_fat_pct", ...rows.map((r) => [r.date, r.weightKg, r.bodyFatPct].map(csvCell).join(","))].join("\n");
  }
  const rows = await ctx.db.select().from(logEntry).where(isNull(logEntry.deletedAt)).orderBy(asc(logEntry.date), asc(logEntry.id)).all();
  return [
    "date,meal,name,amount,unit,grams,kcal,protein_g,carbs_g,fat_g,fiber_g,sugar_g,sodium_mg,source,created_via",
    ...rows.map((r) => {
      const n = roundNutrients(r);
      return [r.date, r.meal, r.name, r.amount, r.unit, r.grams, n.kcal, n.protein, n.carbs, n.fat, n.fiber, n.sugar, n.sodiumMg, r.refType, r.createdVia].map(csvCell).join(",");
    }),
  ].join("\n");
}
