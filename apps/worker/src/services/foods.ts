import { LIMITS, assertValid, cleanText, roundNutrients, validatePer100g, validateUrls } from "@macro-cache/core";
import { desc, eq, isNull } from "drizzle-orm";
import { FOOD_SOURCES, food } from "../db/schema";
import { type Ctx, NotFoundError, Writer } from "./context";
import { fuzzyScore } from "./fuzzy";

export type FoodRow = typeof food.$inferSelect;

export function foodView(f: FoodRow) {
  return {
    id: f.id,
    name: f.name,
    brand: f.brand,
    aliases: f.aliases,
    barcode: f.barcode,
    serving_size_g: f.servingSizeG,
    per_100g: roundNutrients(f),
    per_serving: f.servingSizeG ? roundNutrients({ kcal: (f.kcal * f.servingSizeG) / 100, protein: (f.protein * f.servingSizeG) / 100, carbs: (f.carbs * f.servingSizeG) / 100, fat: (f.fat * f.servingSizeG) / 100, fiber: ((f.fiber ?? 0) * f.servingSizeG) / 100, sugar: ((f.sugar ?? 0) * f.servingSizeG) / 100, sodiumMg: ((f.sodiumMg ?? 0) * f.servingSizeG) / 100 }) : null,
    source: f.source,
    confidence: f.confidence,
    source_urls: f.sourceUrls,
    favorite: f.favorite,
  };
}

export async function searchFoods(ctx: Ctx, query: string, limit = 10) {
  const all = await ctx.db.select().from(food).where(isNull(food.deletedAt)).all();
  const scored = all
    .map((f) => ({ f, score: fuzzyScore(query, [f.name, f.brand ? `${f.brand} ${f.name}` : null, ...(f.aliases ?? []), f.barcode]) }))
    .filter((x) => x.score >= 0.35)
    .sort((a, b) => b.score - a.score || Number(b.f.favorite) - Number(a.f.favorite))
    .slice(0, limit);
  return { query, count: scored.length, results: scored.map(({ f, score }) => ({ ...foodView(f), match: Math.round(score * 100) / 100 })) };
}

export async function getFoodRow(ctx: Ctx, id: number) {
  const f = await ctx.db.select().from(food).where(eq(food.id, id)).get();
  if (!f || f.deletedAt) throw new NotFoundError(`Food ${id}`);
  return f;
}

export async function getFood(ctx: Ctx, id: number) {
  return foodView(await getFoodRow(ctx, id));
}

export interface FoodInput {
  id?: number;
  name: string;
  brand?: string | null;
  aliases?: string[];
  barcode?: string | null;
  servingSizeG?: number | null;
  per100g: { kcal: number; protein: number; carbs: number; fat: number; fiber?: number | null; sugar?: number | null; sodiumMg?: number | null; alcohol?: number | null };
  source: (typeof FOOD_SOURCES)[number];
  confidence?: number | null;
  sourceUrls?: string[];
  favorite?: boolean;
}

function cleanFood(input: FoodInput) {
  const issues: string[] = [];
  const name = cleanText(input.name, LIMITS.nameMax);
  if (!name) issues.push("Name is required.");
  const aliases = (input.aliases ?? []).map((a) => cleanText(a, LIMITS.nameMax)).filter(Boolean);
  if (aliases.length > LIMITS.aliasesMax) issues.push(`At most ${LIMITS.aliasesMax} aliases.`);
  if (input.servingSizeG != null && !(input.servingSizeG > 0 && input.servingSizeG <= 2000)) issues.push("Serving size must be between 0 and 2000 g.");
  if (input.barcode != null && !/^\d{6,14}$/.test(input.barcode)) issues.push("Barcode must be 6–14 digits.");
  if (input.confidence != null && !(input.confidence >= 0 && input.confidence <= 1)) issues.push("Confidence must be between 0 and 1.");
  const { alcohol, ...n } = input.per100g;
  assertValid({ ok: issues.length === 0, issues }, validatePer100g(n, { alcoholG: alcohol ?? 0 }), validateUrls(input.sourceUrls));
  return {
    name,
    brand: input.brand ? cleanText(input.brand, LIMITS.nameMax) : null,
    aliases: aliases.slice(0, LIMITS.aliasesMax),
    barcode: input.barcode ?? null,
    servingSizeG: input.servingSizeG ?? null,
    kcal: n.kcal,
    protein: n.protein,
    carbs: n.carbs,
    fat: n.fat,
    fiber: n.fiber ?? null,
    sugar: n.sugar ?? null,
    sodiumMg: n.sodiumMg ?? null,
    source: input.source,
    confidence: input.confidence ?? null,
    sourceUrls: input.sourceUrls ?? [],
    ...(input.favorite != null ? { favorite: input.favorite } : {}),
  };
}

/** Create or update a food (matched by id, then barcode). Validated for plausibility. */
export async function upsertFood(ctx: Ctx, input: FoodInput, opts: { dryRun?: boolean; tool?: string } = {}) {
  const values = cleanFood(input);
  let existing: FoodRow | undefined;
  if (input.id) existing = await getFoodRow(ctx, input.id);
  else if (values.barcode) existing = (await ctx.db.select().from(food).where(eq(food.barcode, values.barcode)).get()) ?? undefined;

  if (opts.dryRun) {
    return { dry_run: true, action: existing ? "update" : "create", food: foodView({ ...(existing ?? ({} as FoodRow)), ...values, id: existing?.id ?? 0 } as FoodRow) };
  }
  const w = new Writer(ctx, opts.tool ?? "upsert_food", input);
  const row = existing ? await w.update<FoodRow>("food", existing.id, { ...values, deletedAt: null }) : await w.insert<FoodRow>("food", values);
  return { action: existing ? "updated" : "created", food: foodView(row) };
}

export async function setFavorite(ctx: Ctx, id: number, favorite: boolean) {
  await getFoodRow(ctx, id);
  const w = new Writer(ctx, "set_favorite", { id, favorite });
  return foodView(await w.update<FoodRow>("food", id, { favorite }));
}

export async function deleteFood(ctx: Ctx, id: number) {
  await getFoodRow(ctx, id);
  const w = new Writer(ctx, "delete_food", { id });
  await w.softDelete("food", id);
  return { deleted: id };
}

export async function recentFoods(ctx: Ctx, limit = 20) {
  return (await ctx.db.select().from(food).where(isNull(food.deletedAt)).orderBy(desc(food.updatedAt)).limit(limit).all()).map(foodView);
}

// ---------------------------------------------------------------------------
// Open Food Facts — the ONLY outbound network call this server makes.
// ---------------------------------------------------------------------------

export const OFF_USER_AGENT = "macro-cache/0.1 (https://github.com/macro-cache/macro-cache)";

interface OffProduct {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  serving_quantity?: number | string;
  serving_size?: string;
  nutriments?: Record<string, number | string | undefined>;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function parseOffProduct(code: string, p: OffProduct): FoodInput | null {
  const n = p.nutriments ?? {};
  let kcal = num(n["energy-kcal_100g"]);
  if (kcal === null) {
    const kj = num(n["energy-kj_100g"]) ?? num(n["energy_100g"]);
    if (kj !== null) kcal = kj / 4.184;
  }
  const protein = num(n.proteins_100g);
  const carbs = num(n.carbohydrates_100g);
  const fat = num(n.fat_100g);
  if (kcal === null || protein === null || carbs === null || fat === null) return null;
  const sodiumG = num(n.sodium_100g) ?? (num(n.salt_100g) !== null ? num(n.salt_100g)! / 2.5 : null);
  const name = (p.product_name || p.product_name_en || "").trim();
  if (!name) return null;
  return {
    name,
    brand: p.brands?.split(",")[0]?.trim() || null,
    barcode: code,
    servingSizeG: num(p.serving_quantity),
    per100g: {
      kcal: Math.round(kcal * 10) / 10,
      protein,
      carbs,
      fat,
      fiber: num(n.fiber_100g),
      sugar: num(n.sugars_100g),
      sodiumMg: sodiumG !== null ? Math.round(sodiumG * 1000) : null,
      alcohol: num(n.alcohol_100g),
    },
    source: "barcode",
    confidence: 0.9,
    sourceUrls: [`https://world.openfoodfacts.org/product/${code}`],
  };
}

/** Look up a barcode: local cache first, then Open Food Facts; cache the result. */
export async function lookupBarcode(ctx: Ctx, barcode: string, opts: { dryRun?: boolean } = {}) {
  if (!/^\d{6,14}$/.test(barcode)) assertValid({ ok: false, issues: ["Barcode must be 6–14 digits."] });
  const cached = await ctx.db.select().from(food).where(eq(food.barcode, barcode)).get();
  if (cached && !cached.deletedAt) return { found: true, cached: true, food: foodView(cached) };

  const f = ctx.fetch ?? fetch;
  const url = `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(barcode)}.json?fields=product_name,product_name_en,brands,serving_quantity,serving_size,nutriments`;
  let res: Response;
  try {
    res = await f(url, { headers: { "User-Agent": OFF_USER_AGENT, Accept: "application/json" } });
  } catch {
    return { found: false, message: "Open Food Facts is unreachable right now. Try again, or enter the label manually." };
  }
  if (res.status === 404) {
    return {
      found: false,
      message: "Not in Open Food Facts. Ask the user for a photo of the nutrition label, then call upsert_food. They can also add it at https://world.openfoodfacts.org/contribute.",
    };
  }
  if (!res.ok) return { found: false, message: `Open Food Facts returned HTTP ${res.status}. Try again later or enter manually.` };
  const body = (await res.json()) as { product?: OffProduct; status?: string };
  const parsed = body.product ? parseOffProduct(barcode, body.product) : null;
  if (!parsed) return { found: false, message: "Product found but nutrition data is incomplete. Ask for a label photo and use upsert_food." };

  try {
    const r = await upsertFood(ctx, parsed, { dryRun: opts.dryRun, tool: "lookup_barcode" });
    return { found: true, cached: false, ...r };
  } catch (e) {
    return { found: false, message: `Open Food Facts data failed plausibility checks: ${(e as Error).message} Ask for a label photo instead.` };
  }
}
