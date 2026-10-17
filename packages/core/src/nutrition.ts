/** Nutrient amounts. For foods these are per 100 g; for log entries they are absolute. */
export interface Nutrients {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number | null;
  sugar?: number | null;
  /** Sodium in milligrams. */
  sodiumMg?: number | null;
}

export const NUTRIENT_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodiumMg"] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

export type FullNutrients = { [K in keyof Nutrients]-?: number };

export const ZERO: FullNutrients = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodiumMg: 0 };

export function scale(n: Nutrients, factor: number): FullNutrients {
  return {
    kcal: n.kcal * factor,
    protein: n.protein * factor,
    carbs: n.carbs * factor,
    fat: n.fat * factor,
    fiber: (n.fiber ?? 0) * factor,
    sugar: (n.sugar ?? 0) * factor,
    sodiumMg: (n.sodiumMg ?? 0) * factor,
  };
}

/** Nutrients for `grams` of something with per-100g values. */
export function forGrams(per100: Nutrients, grams: number): FullNutrients {
  return scale(per100, grams / 100);
}

export function sum(list: Nutrients[]): FullNutrients {
  const t = { ...ZERO };
  for (const n of list) {
    t.kcal += n.kcal;
    t.protein += n.protein;
    t.carbs += n.carbs;
    t.fat += n.fat;
    t.fiber += n.fiber ?? 0;
    t.sugar += n.sugar ?? 0;
    t.sodiumMg += n.sodiumMg ?? 0;
  }
  return t;
}

export function roundNutrients(n: Nutrients, digits = 1): FullNutrients {
  const r = (v: number | null | undefined) => Math.round((v ?? 0) * 10 ** digits) / 10 ** digits;
  return { kcal: Math.round(n.kcal), protein: r(n.protein), carbs: r(n.carbs), fat: r(n.fat), fiber: r(n.fiber), sugar: r(n.sugar), sodiumMg: Math.round(n.sodiumMg ?? 0) };
}

export interface RecipeIngredient {
  grams: number;
  per100: Nutrients;
}

export interface RecipeComputed {
  totalRawG: number;
  totalCookedG: number;
  total: FullNutrients;
  per100: FullNutrients;
  portionG: number | null;
  perPortion: FullNutrients | null;
  portions: number | null;
}

/**
 * Recipe math: sum ingredient nutrients (raw weights), then divide by the
 * total COOKED weight to get per-100g of the finished dish. Water lost or
 * gained in cooking changes weight, not nutrients.
 */
export function computeRecipe(ingredients: RecipeIngredient[], totalCookedWeightG?: number | null, portionG?: number | null): RecipeComputed {
  const total = sum(ingredients.map((i) => forGrams(i.per100, i.grams)));
  const totalRawG = ingredients.reduce((a, i) => a + i.grams, 0);
  const cooked = totalCookedWeightG && totalCookedWeightG > 0 ? totalCookedWeightG : totalRawG;
  const per100 = cooked > 0 ? scale(total, 100 / cooked) : { ...ZERO };
  const portion = portionG && portionG > 0 ? portionG : null;
  return {
    totalRawG,
    totalCookedG: cooked,
    total,
    per100,
    portionG: portion,
    perPortion: portion ? forGrams(per100, portion) : null,
    portions: portion ? cooked / portion : null,
  };
}

/** Protein grams per 100 kcal — the "protein density" used for ranking. */
export function proteinDensity(n: Pick<Nutrients, "kcal" | "protein">): number {
  if (n.kcal <= 0) return n.protein > 0 ? Infinity : 0;
  return (n.protein / n.kcal) * 100;
}

export function kcalFromMacros(n: Pick<Nutrients, "protein" | "carbs" | "fat">, alcoholG = 0): number {
  return n.protein * 4 + n.carbs * 4 + n.fat * 9 + alcoholG * 7;
}
