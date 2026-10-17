import { ValidationError } from "@macro-cache/core";
import { z } from "zod";
import { makeDb } from "../db/client";
import type { Env } from "../env";
import { logItemSchema, toLogItem } from "../mcp/server";
import { type Ctx, ForbiddenError, NotFoundError, undoLast } from "../services/context";
import { exportCsv, exportJson, importJson } from "../services/data";
import { deleteFood, lookupBarcode, recentFoods, searchFoods, setFavorite, upsertFood, foodView } from "../services/foods";
import { copyMeal, deleteEntry, deleteTemplate, getDaySummary, listTemplates, logFood, logTemplate, recentEntries, saveTemplate, useContainerPortion } from "../services/logging";
import { getProfile, recalculateTargets, updateProfile } from "../services/profile";
import { deleteWeight, getProgress, listWeights, logWeight, projectProgress, suggestMeals } from "../services/progress";
import { activeContainers, createRecipe, searchRecipes, searchRestaurantOrders, startContainer } from "../services/recipes";
import { food } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";

/** JSON REST API for the dashboard. Auth (session cookie) is enforced by the caller. */

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function errorResponse(e: unknown) {
  if (e instanceof ValidationError) return json({ error: "validation_failed", issues: e.issues }, 422);
  if (e instanceof z.ZodError) return json({ error: "invalid_input", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  if (e instanceof NotFoundError) return json({ error: "not_found", message: e.message }, 404);
  if (e instanceof ForbiddenError) return json({ error: "forbidden", message: e.message }, 403);
  console.error(e);
  return json({ error: "internal_error", message: (e as Error)?.message ?? "Unexpected error" }, 500);
}

const profileSchema = z
  .object({
    heightCm: z.number(),
    weightKg: z.number(),
    age: z.number().int(),
    sex: z.enum(["male", "female"]),
    activity: z.enum(["sedentary", "light", "moderate", "active", "very_active"]),
    goal: z.enum(["lose", "maintain", "gain"]),
    paceLbPerWeek: z.number().min(0).max(2),
    goalWeightKg: z.number().nullable(),
    units: z.enum(["metric", "imperial"]),
    timezone: z.string().max(64),
    proteinGPerKg: z.number().min(1.2).max(2.2),
    targetOverrideKcal: z.number().int().min(800).max(6000).nullable(),
    weeklyBudget: z.boolean(),
    tradeoffCards: z.boolean(),
    onboarded: z.boolean(),
  })
  .partial();

const nutrients = z.object({ kcal: z.number(), protein: z.number(), carbs: z.number(), fat: z.number(), fiber: z.number().nullable().optional(), sugar: z.number().nullable().optional(), sodiumMg: z.number().nullable().optional() });
const foodSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().min(1).max(120),
  brand: z.string().max(120).nullable().optional(),
  aliases: z.array(z.string()).max(20).optional(),
  barcode: z.string().regex(/^\d{6,14}$/).nullable().optional(),
  servingSizeG: z.number().positive().nullable().optional(),
  per100g: nutrients,
  source: z.enum(["barcode", "label-photo", "manual", "restaurant", "ai-estimate"]).default("manual"),
  favorite: z.boolean().optional(),
});
const mealSchema = z.enum(["breakfast", "lunch", "dinner", "snack"]);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type Handler = (ctx: Ctx, req: Request, params: Record<string, string>, url: URL) => Promise<unknown> | unknown;
const routes: [string, string, Handler][] = [];
const route = (method: string, path: string, h: Handler) => routes.push([method, path, h]);
const body = async <T>(req: Request, schema: z.ZodType<T>) => schema.parse(await req.json());
const qp = (url: URL, k: string) => url.searchParams.get(k) ?? undefined;

route("GET", "/api/profile", (ctx) => getProfile(ctx));
route("PUT", "/api/profile", async (ctx, req, _p, url) => updateProfile(ctx, await body(req, profileSchema), { dryRun: qp(url, "dry_run") === "1" }));
route("POST", "/api/profile/recalculate", async (ctx, req) => recalculateTargets(ctx, await body(req, z.object({ acceptAdaptive: z.boolean().optional(), dryRun: z.boolean().optional() }))));

route("GET", "/api/day", (ctx, _r, _p, url) => getDaySummary(ctx, qp(url, "date")));
route("POST", "/api/log", async (ctx, req) => {
  const b = await body(req, z.object({ items: z.array(logItemSchema).min(1).max(30), date: dateSchema.optional(), dryRun: z.boolean().optional() }));
  return logFood(ctx, b.items.map((i) => toLogItem(i, b.date)), { dryRun: b.dryRun, date: b.date });
});
route("DELETE", "/api/log/:id", (ctx, _r, p) => deleteEntry(ctx, Number(p.id)));
route("POST", "/api/log/copy-meal", async (ctx, req) => copyMeal(ctx, await body(req, z.object({ fromDate: dateSchema, meal: mealSchema, toDate: dateSchema.optional() }))));
route("POST", "/api/undo", (ctx) => undoLast(ctx));
route("GET", "/api/recents", (ctx) => recentEntries(ctx));

route("GET", "/api/foods/search", (ctx, _r, _p, url) => searchFoods(ctx, qp(url, "q") ?? "", 20));
route("GET", "/api/foods/recent", (ctx) => recentFoods(ctx));
route("GET", "/api/foods/favorites", async (ctx) => (await ctx.db.select().from(food).where(and(eq(food.favorite, true), isNull(food.deletedAt))).all()).map(foodView));
route("POST", "/api/foods", async (ctx, req) => upsertFood(ctx, await body(req, foodSchema), { tool: "dashboard_food" }));
route("POST", "/api/foods/:id/favorite", async (ctx, req, p) => setFavorite(ctx, Number(p.id), (await body(req, z.object({ favorite: z.boolean() }))).favorite));
route("DELETE", "/api/foods/:id", (ctx, _r, p) => deleteFood(ctx, Number(p.id)));
route("GET", "/api/barcode/:code", (ctx, _r, p) => lookupBarcode(ctx, p.code));

route("GET", "/api/recipes", (ctx, _r, _p, url) => searchRecipes(ctx, qp(url, "q"), 50));
route("POST", "/api/recipes", async (ctx, req) =>
  createRecipe(ctx, await body(req, z.object({ name: z.string(), ingredients: z.array(z.object({ foodId: z.number().int(), grams: z.number() })), totalCookedWeightG: z.number().nullable().optional(), portionG: z.number().nullable().optional() }))),
);
route("GET", "/api/containers", (ctx) => activeContainers(ctx));
route("POST", "/api/containers", async (ctx, req) => startContainer(ctx, await body(req, z.object({ recipeId: z.number().int(), portions: z.number().optional(), portionG: z.number().optional(), label: z.string().optional() }))));
route("POST", "/api/containers/:id/use", async (ctx, req, p) => {
  const b = await body(req, z.object({ portions: z.number().optional(), meal: mealSchema.optional(), date: dateSchema.optional() }));
  return useContainerPortion(ctx, { containerId: Number(p.id), ...b });
});
route("GET", "/api/restaurant-orders", (ctx, _r, _p, url) => searchRestaurantOrders(ctx, qp(url, "q"), 50));

route("GET", "/api/templates", (ctx) => listTemplates(ctx));
route("POST", "/api/templates", async (ctx, req) => saveTemplate(ctx, await body(req, z.object({ name: z.string(), fromDate: dateSchema, fromMeal: mealSchema.optional() }))));
route("POST", "/api/templates/:id/log", async (ctx, req, p) => {
  const b = await body(req, z.object({ date: dateSchema.optional(), meal: mealSchema.optional() }));
  return logTemplate(ctx, { templateId: Number(p.id), ...b });
});
route("DELETE", "/api/templates/:id", (ctx, _r, p) => deleteTemplate(ctx, Number(p.id)));

route("GET", "/api/weights", (ctx) => listWeights(ctx));
route("POST", "/api/weights", async (ctx, req) => logWeight(ctx, await body(req, z.object({ weightKg: z.number(), date: dateSchema.optional(), bodyFatPct: z.number().nullable().optional() }))));
route("DELETE", "/api/weights/:id", (ctx, _r, p) => deleteWeight(ctx, Number(p.id)));
route("GET", "/api/progress", (ctx) => getProgress(ctx));
route("POST", "/api/project", async (ctx, req) =>
  projectProgress(ctx, await body(req, z.object({ months: z.number(), intakeKcal: z.number().optional(), daysOnTargetPerWeek: z.number().optional(), compareIntakeKcal: z.number().optional() }))),
);
route("GET", "/api/suggest", (ctx, _r, _p, url) => suggestMeals(ctx, { date: qp(url, "date") }));

route("GET", "/api/export.json", async (ctx) => new Response(JSON.stringify(await exportJson(ctx), null, 1), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="macro-cache-${new Date().toISOString().slice(0, 10)}.json"` } }));
route("GET", "/api/export.csv", async (ctx, _r, _p, url) => {
  const kind = qp(url, "kind") === "weights" ? "weights" : "log";
  return new Response(await exportCsv(ctx, kind), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="macro-cache-${kind}.csv"` } });
});
route("POST", "/api/import", async (ctx, req) => importJson(ctx, (await req.json()) as never));

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function handleApi(req: Request, env: Env, login: string): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/me") return json({ login });
  // CSRF defense in depth (cookies are SameSite=Lax): state-changing requests must be same-origin.
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "forbidden", message: "Cross-origin request blocked." }, 403);
    if (!origin && req.headers.get("X-Requested-With") !== "macro-cache") return json({ error: "forbidden", message: "Missing origin." }, 403);
  }
  const ctx: Ctx = { db: makeDb(env.DB), via: "dashboard" };
  for (const [method, pattern, h] of routes) {
    if (method !== req.method) continue;
    const params = match(pattern, url.pathname);
    if (!params) continue;
    try {
      const result = await h(ctx, req, params, url);
      return result instanceof Response ? result : json(result);
    } catch (e) {
      return errorResponse(e);
    }
  }
  return json({ error: "not_found" }, 404);
}
