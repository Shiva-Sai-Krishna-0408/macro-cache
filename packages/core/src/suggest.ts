import { type FullNutrients, forGrams, proteinDensity, roundNutrients, type Nutrients } from "./nutrition";

export type CandidateKind = "food" | "recipe" | "container" | "restaurant_order";

export interface Candidate {
  kind: CandidateKind;
  id: number;
  name: string;
  /** Per-100 g nutrients (foods, recipes, containers). */
  per100?: Nutrients | null;
  /** Default portion in grams (serving size or recipe portion). */
  portionG?: number | null;
  /** Fixed nutrients for one unit (restaurant orders). */
  perUnit?: Nutrients | null;
}

export interface RankedCandidate {
  kind: CandidateKind;
  id: number;
  name: string;
  proteinPer100kcal: number;
  basis: "per_100g" | "per_order";
}

/** Sort by protein grams per 100 kcal, best first. */
export function rankByProteinDensity(candidates: Candidate[], limit = 20): RankedCandidate[] {
  return candidates
    .map((c) => {
      const n = c.perUnit ?? c.per100;
      if (!n) return null;
      return {
        kind: c.kind,
        id: c.id,
        name: c.name,
        proteinPer100kcal: Math.round(proteinDensity(n) * 10) / 10,
        basis: c.perUnit ? ("per_order" as const) : ("per_100g" as const),
      };
    })
    .filter((x): x is RankedCandidate => x !== null && Number.isFinite(x.proteinPer100kcal))
    .sort((a, b) => b.proteinPer100kcal - a.proteinPer100kcal)
    .slice(0, limit);
}

export interface SuggestInput {
  remaining: { kcal: number; protein: number; carbs: number; fat: number };
  /** kcal already eaten today. */
  consumedKcal: number;
  /** Safety floor (kcal/day). */
  floor: number;
  candidates: Candidate[];
  limit?: number;
}

export interface Suggestion {
  kind: CandidateKind;
  id: number;
  name: string;
  grams: number | null;
  servings: number | null;
  nutrients: FullNutrients;
  proteinPer100kcal: number;
  fitsRemaining: boolean;
}

export interface SuggestResult {
  remaining: SuggestInput["remaining"];
  /** kcal still needed today to reach the safety floor (0 if already above it). */
  floorGapKcal: number;
  note: string | null;
  suggestions: Suggestion[];
}

const MIN_PORTION_SCALE = 0.5;
const MAX_PORTION_SCALE = 2;

/**
 * Suggest cached foods/recipes/orders with portions that fit what's left.
 * Respects the safety floor: never recommends eating less than the floor
 * requires, and flags when the user is below it.
 */
export function suggestMealsForRemaining(input: SuggestInput): SuggestResult {
  const { remaining, floor, consumedKcal } = input;
  const floorGapKcal = Math.max(0, Math.round(floor - consumedKcal));
  const budget = Math.max(remaining.kcal, floorGapKcal);
  const out: Suggestion[] = [];

  for (const c of input.candidates) {
    if (c.perUnit) {
      const n = roundNutrients(c.perUnit);
      if (n.kcal <= 0) continue;
      out.push({ kind: c.kind, id: c.id, name: c.name, grams: null, servings: 1, nutrients: n, proteinPer100kcal: proteinDensity(n), fitsRemaining: n.kcal <= budget });
      continue;
    }
    if (!c.per100 || c.per100.kcal <= 0) continue;
    const base = c.portionG && c.portionG > 0 ? c.portionG : 100;
    const kcalPerBase = (c.per100.kcal * base) / 100;
    // Scale the default portion to fit the budget, within 0.5×–2× of normal.
    let scaleF = Math.min(MAX_PORTION_SCALE, budget / kcalPerBase);
    if (scaleF < MIN_PORTION_SCALE) continue; // even a half portion doesn't fit
    scaleF = Math.floor(scaleF * 4) / 4; // quarter-portion steps
    const grams = Math.round(base * scaleF);
    const n = roundNutrients(forGrams(c.per100, grams));
    out.push({
      kind: c.kind,
      id: c.id,
      name: c.name,
      grams,
      servings: c.portionG ? scaleF : null,
      nutrients: n,
      proteinPer100kcal: proteinDensity(c.per100),
      fitsRemaining: n.kcal <= budget,
    });
  }

  const fits = out.filter((s) => s.fitsRemaining);
  // Rank: protein density, then closeness to remaining protein.
  fits.sort((a, b) => b.proteinPer100kcal - a.proteinPer100kcal || Math.abs(remaining.protein - a.nutrients.protein) - Math.abs(remaining.protein - b.nutrients.protein));

  let note: string | null = null;
  if (floorGapKcal > 0 && consumedKcal > 0) note = `You're ${floorGapKcal} kcal below your safety floor of ${floor} kcal today. Eating at least that much more is recommended.`;
  else if (remaining.kcal <= 0) note = "You've reached today's calorie target. If you're still hungry, lean protein and vegetables add the least.";

  return {
    remaining,
    floorGapKcal,
    note,
    suggestions: fits.slice(0, input.limit ?? 5).map((s) => ({ ...s, proteinPer100kcal: Math.round(s.proteinPer100kcal * 10) / 10 })),
  };
}
