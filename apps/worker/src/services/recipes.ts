import { LIMITS, assertValid, cleanText, computeRecipe, roundNutrients, validatePer100g, validateUrls, validateEntryNutrients } from "@macro-cache/core";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { container, food, recipe, restaurantOrder } from "../db/schema";
import { type Ctx, NotFoundError, Writer } from "./context";
import { fuzzyScore } from "./fuzzy";
import { getProfileRow, today } from "./profile";

export type RecipeRow = typeof recipe.$inferSelect;
export type ContainerRow = typeof container.$inferSelect;
export type RestaurantRow = typeof restaurantOrder.$inferSelect;

export function recipeView(r: RecipeRow) {
  const per100 = roundNutrients(r);
  return {
    id: r.id,
    root_id: r.rootId ?? r.id,
    version: r.version,
    is_current: r.isCurrent,
    name: r.name,
    ingredients: r.ingredients,
    total_raw_g: r.totalRawG,
    total_cooked_weight_g: r.totalCookedWeightG,
    portion_g: r.portionG,
    portions: r.portionG ? Math.round((r.totalCookedWeightG / r.portionG) * 10) / 10 : null,
    per_100g: per100,
    per_portion: r.portionG ? roundNutrients({ kcal: (r.kcal * r.portionG) / 100, protein: (r.protein * r.portionG) / 100, carbs: (r.carbs * r.portionG) / 100, fat: (r.fat * r.portionG) / 100, fiber: ((r.fiber ?? 0) * r.portionG) / 100, sugar: ((r.sugar ?? 0) * r.portionG) / 100, sodiumMg: ((r.sodiumMg ?? 0) * r.portionG) / 100 }) : null,
    notes: r.notes,
  };
}

export interface RecipeInput {
  name: string;
  ingredients: { foodId: number; grams: number }[];
  totalCookedWeightG?: number | null;
  portionG?: number | null;
  notes?: string | null;
}

async function buildRecipe(ctx: Ctx, input: RecipeInput) {
  const issues: string[] = [];
  const name = cleanText(input.name, LIMITS.nameMax);
  if (!name) issues.push("Recipe name is required.");
  if (!input.ingredients.length) issues.push("A recipe needs at least one ingredient.");
  if (input.ingredients.length > LIMITS.ingredientsMax) issues.push(`At most ${LIMITS.ingredientsMax} ingredients.`);
  for (const i of input.ingredients) if (!(i.grams > 0 && i.grams <= 20000)) issues.push(`Ingredient grams must be between 0 and 20000 (food ${i.foodId}).`);
  if (input.totalCookedWeightG != null && !(input.totalCookedWeightG > 0 && input.totalCookedWeightG <= 50000)) issues.push("Cooked weight must be between 0 and 50000 g.");
  if (input.portionG != null && !(input.portionG > 0)) issues.push("Portion size must be positive.");
  assertValid({ ok: issues.length === 0, issues });

  const ids = [...new Set(input.ingredients.map((i) => i.foodId))];
  const foods = await ctx.db.select().from(food).where(and(inArray(food.id, ids), isNull(food.deletedAt))).all();
  const byId = new Map(foods.map((f) => [f.id, f]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new NotFoundError(`Food(s) ${missing.join(", ")}`);

  const computed = computeRecipe(
    input.ingredients.map((i) => ({ grams: i.grams, per100: byId.get(i.foodId)! })),
    input.totalCookedWeightG,
    input.portionG,
  );
  // Cooked dish can't be denser than physics allows (e.g. a typo'd cooked weight).
  assertValid(validatePer100g(computed.per100, { label: "Cooked recipe per 100 g" }));
  return {
    name,
    ingredients: input.ingredients.map((i) => ({ foodId: i.foodId, grams: i.grams, name: byId.get(i.foodId)!.name })),
    totalRawG: computed.totalRawG,
    totalCookedWeightG: computed.totalCookedG,
    portionG: computed.portionG,
    ...computed.per100,
    notes: input.notes ? cleanText(input.notes) : null,
  };
}

export async function createRecipe(ctx: Ctx, input: RecipeInput, opts: { dryRun?: boolean } = {}) {
  const values = await buildRecipe(ctx, input);
  if (opts.dryRun) return { dry_run: true, recipe: recipeView({ ...values, id: 0, rootId: null, version: 1, isCurrent: true } as RecipeRow) };
  const w = new Writer(ctx, "create_recipe", input);
  const row = await w.insert<RecipeRow>("recipe", values);
  const fixed = await w.update<RecipeRow>("recipe", row.id, { rootId: row.id });
  return { recipe: recipeView(fixed) };
}

export async function getRecipeRow(ctx: Ctx, id: number) {
  const r = await ctx.db.select().from(recipe).where(eq(recipe.id, id)).get();
  if (!r || r.deletedAt) throw new NotFoundError(`Recipe ${id}`);
  return r;
}

/** Versioned update: inserts version N+1 and marks the old one not current. Past logs keep their snapshots. */
export async function updateRecipe(ctx: Ctx, id: number, patch: Partial<RecipeInput>, opts: { dryRun?: boolean } = {}) {
  const old = await getRecipeRow(ctx, id);
  const rootId = old.rootId ?? old.id;
  const current = (await ctx.db.select().from(recipe).where(and(eq(recipe.rootId, rootId), eq(recipe.isCurrent, true))).get()) ?? old;
  const values = await buildRecipe(ctx, {
    name: patch.name ?? current.name,
    ingredients: patch.ingredients ?? current.ingredients.map((i) => ({ foodId: i.foodId, grams: i.grams })),
    totalCookedWeightG: patch.totalCookedWeightG !== undefined ? patch.totalCookedWeightG : current.totalCookedWeightG,
    portionG: patch.portionG !== undefined ? patch.portionG : current.portionG,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
  });
  const next = { ...values, rootId, version: current.version + 1, isCurrent: true };
  if (opts.dryRun) return { dry_run: true, previous_version: current.version, recipe: recipeView({ ...next, id: 0 } as RecipeRow) };
  const w = new Writer(ctx, "update_recipe", { id, ...patch });
  await w.update("recipe", current.id, { isCurrent: false });
  const row = await w.insert<RecipeRow>("recipe", next);
  return { previous_version: current.version, recipe: recipeView(row) };
}

export async function searchRecipes(ctx: Ctx, query?: string, limit = 10) {
  const all = await ctx.db.select().from(recipe).where(and(isNull(recipe.deletedAt), eq(recipe.isCurrent, true))).orderBy(desc(recipe.updatedAt)).all();
  const list = query ? all.map((r) => ({ r, s: fuzzyScore(query, [r.name]) })).filter((x) => x.s >= 0.35).sort((a, b) => b.s - a.s).map((x) => x.r) : all;
  return list.slice(0, limit).map(recipeView);
}

// ---------------------------------------------------------------------------
// Containers (meal-prep countdown)
// ---------------------------------------------------------------------------

export function containerView(c: ContainerRow, r?: RecipeRow) {
  return {
    id: c.id,
    recipe_id: c.recipeId,
    recipe_name: r?.name,
    label: c.label,
    portions_total: c.portionsTotal,
    portions_left: Math.round(c.portionsLeft * 100) / 100,
    portion_g: c.portionG,
    per_portion: r ? roundNutrients({ kcal: (r.kcal * c.portionG) / 100, protein: (r.protein * c.portionG) / 100, carbs: (r.carbs * c.portionG) / 100, fat: (r.fat * c.portionG) / 100 }) : undefined,
    started_on: c.startedOn,
    finished: c.finishedAt != null,
  };
}

export async function startContainer(ctx: Ctx, input: { recipeId: number; portions?: number | null; portionG?: number | null; label?: string | null }, opts: { dryRun?: boolean } = {}) {
  const r = await getRecipeRow(ctx, input.recipeId);
  const portionG = input.portionG ?? r.portionG ?? (input.portions ? r.totalCookedWeightG / input.portions : null);
  if (!portionG || portionG <= 0) assertValid({ ok: false, issues: ["Give either portions or portion_g (the recipe has no default portion)."] });
  const portions = input.portions ?? Math.round((r.totalCookedWeightG / portionG!) * 100) / 100;
  if (!(portions > 0 && portions <= 100)) assertValid({ ok: false, issues: ["Portions must be between 0 and 100."] });
  const p = await getProfileRow(ctx);
  const values = { recipeId: r.id, label: input.label ? cleanText(input.label, LIMITS.nameMax) : r.name, portionsTotal: portions, portionsLeft: portions, portionG: portionG!, startedOn: today(ctx, p) };
  if (opts.dryRun) return { dry_run: true, container: containerView({ ...values, id: 0, finishedAt: null } as ContainerRow, r) };
  const w = new Writer(ctx, "start_container", input);
  const row = await w.insert<ContainerRow>("container", values);
  return { container: containerView(row, r) };
}

export async function getContainerRow(ctx: Ctx, id: number) {
  const c = await ctx.db.select().from(container).where(eq(container.id, id)).get();
  if (!c || c.deletedAt) throw new NotFoundError(`Container ${id}`);
  return c;
}

export async function activeContainers(ctx: Ctx) {
  const cs = await ctx.db.select().from(container).where(and(isNull(container.deletedAt), isNull(container.finishedAt), gt(container.portionsLeft, 0))).orderBy(desc(container.id)).all();
  if (!cs.length) return [];
  const rs = await ctx.db.select().from(recipe).where(inArray(recipe.id, [...new Set(cs.map((c) => c.recipeId))])).all();
  const byId = new Map(rs.map((r) => [r.id, r]));
  return cs.map((c) => containerView(c, byId.get(c.recipeId)));
}

// ---------------------------------------------------------------------------
// Restaurant orders
// ---------------------------------------------------------------------------

export function restaurantView(o: RestaurantRow) {
  return {
    id: o.id,
    restaurant: o.restaurant,
    item: o.item,
    nutrients: roundNutrients(o),
    source: o.source,
    confidence: o.confidence,
    source_urls: o.sourceUrls,
    notes: o.notes,
  };
}

export interface RestaurantInput {
  restaurant: string;
  item: string;
  nutrients: { kcal: number; protein: number; carbs: number; fat: number; fiber?: number | null; sugar?: number | null; sodiumMg?: number | null };
  source?: "official" | "estimate";
  confidence?: number | null;
  sourceUrls?: string[];
  notes?: string | null;
}

export async function saveRestaurantOrder(ctx: Ctx, input: RestaurantInput, opts: { dryRun?: boolean } = {}) {
  const restaurant = cleanText(input.restaurant, LIMITS.nameMax);
  const item = cleanText(input.item, LIMITS.textMax);
  assertValid(
    { ok: !!restaurant && !!item, issues: !restaurant || !item ? ["Restaurant and item are required."] : [] },
    validateEntryNutrients(input.nutrients, { label: "Restaurant order" }),
    validateUrls(input.sourceUrls),
  );
  const values = {
    restaurant,
    item,
    kcal: input.nutrients.kcal,
    protein: input.nutrients.protein,
    carbs: input.nutrients.carbs,
    fat: input.nutrients.fat,
    fiber: input.nutrients.fiber ?? null,
    sugar: input.nutrients.sugar ?? null,
    sodiumMg: input.nutrients.sodiumMg ?? null,
    source: input.source ?? "estimate",
    confidence: input.confidence ?? null,
    sourceUrls: input.sourceUrls ?? [],
    notes: input.notes ? cleanText(input.notes) : null,
  };
  if (opts.dryRun) return { dry_run: true, order: restaurantView({ ...values, id: 0 } as RestaurantRow) };
  const w = new Writer(ctx, "save_restaurant_order", input);
  return { order: restaurantView(await w.insert<RestaurantRow>("restaurantOrder", values)) };
}

export async function searchRestaurantOrders(ctx: Ctx, query?: string, limit = 10) {
  const all = await ctx.db.select().from(restaurantOrder).where(isNull(restaurantOrder.deletedAt)).orderBy(desc(restaurantOrder.id)).all();
  const list = query
    ? all
        .map((o) => ({ o, s: fuzzyScore(query, [o.restaurant, o.item, `${o.restaurant} ${o.item}`]) }))
        .filter((x) => x.s >= 0.35)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.o)
    : all;
  return list.slice(0, limit).map(restaurantView);
}

export async function getRestaurantRow(ctx: Ctx, id: number) {
  const o = await ctx.db.select().from(restaurantOrder).where(eq(restaurantOrder.id, id)).get();
  if (!o || o.deletedAt) throw new NotFoundError(`Restaurant order ${id}`);
  return o;
}
