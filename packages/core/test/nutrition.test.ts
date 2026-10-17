import { describe, expect, it } from "vitest";
import {
  computeRecipe,
  forGrams,
  proteinDensity,
  rankByProteinDensity,
  suggestMealsForRemaining,
  tradeoffCard,
  validateEntryNutrients,
  validatePer100g,
  validateUrls,
  validateAmount,
  cleanText,
} from "../src";

const chicken = { kcal: 165, protein: 31, carbs: 0, fat: 3.6 };
const rice = { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 };
const oil = { kcal: 884, protein: 0, carbs: 0, fat: 100 };

describe("recipes", () => {
  it("divides by cooked weight, not raw weight", () => {
    const r = computeRecipe(
      [
        { grams: 500, per100: chicken },
        { grams: 300, per100: rice },
        { grams: 20, per100: oil },
      ],
      1000,
      250,
    );
    const totalKcal = 165 * 5 + 130 * 3 + 884 * 0.2;
    expect(r.total.kcal).toBeCloseTo(totalKcal);
    expect(r.totalRawG).toBe(820);
    expect(r.per100.kcal).toBeCloseTo(totalKcal / 10);
    expect(r.perPortion!.kcal).toBeCloseTo(totalKcal / 4);
    expect(r.portions).toBe(4);
  });

  it("falls back to raw weight when cooked weight is missing", () => {
    const r = computeRecipe([{ grams: 200, per100: chicken }]);
    expect(r.per100.kcal).toBeCloseTo(165);
    expect(r.perPortion).toBeNull();
  });

  it("scales portions", () => {
    expect(forGrams(chicken, 150).protein).toBeCloseTo(46.5);
    expect(forGrams(chicken, 0).kcal).toBe(0);
  });
});

describe("protein density ranking", () => {
  it("ranks by protein per 100 kcal", () => {
    const ranked = rankByProteinDensity([
      { kind: "food", id: 1, name: "rice", per100: rice },
      { kind: "food", id: 2, name: "chicken", per100: chicken },
      { kind: "restaurant_order", id: 3, name: "burger", perUnit: { kcal: 800, protein: 40, carbs: 60, fat: 45 } },
    ]);
    expect(ranked.map((r) => r.name)).toEqual(["chicken", "burger", "rice"]);
    expect(ranked[0].proteinPer100kcal).toBeCloseTo(18.8, 1);
    expect(proteinDensity({ kcal: 0, protein: 0 })).toBe(0);
  });
});

describe("suggest_meals_for_remaining", () => {
  const candidates = [
    { kind: "food" as const, id: 1, name: "chicken", per100: chicken, portionG: 150 },
    { kind: "food" as const, id: 2, name: "rice", per100: rice, portionG: 200 },
    { kind: "restaurant_order" as const, id: 3, name: "pizza", perUnit: { kcal: 2000, protein: 80, carbs: 220, fat: 85 } },
  ];

  it("only suggests portions that fit remaining kcal", () => {
    const r = suggestMealsForRemaining({ remaining: { kcal: 400, protein: 50, carbs: 40, fat: 10 }, consumedKcal: 1600, floor: 1500, candidates });
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) expect(s.nutrients.kcal).toBeLessThanOrEqual(400);
    expect(r.suggestions[0].name).toBe("chicken");
    expect(r.suggestions.find((s) => s.name === "pizza")).toBeUndefined();
  });

  it("respects the floor: flags a gap and never suggests eating below it", () => {
    const r = suggestMealsForRemaining({ remaining: { kcal: 1300, protein: 100, carbs: 100, fat: 40 }, consumedKcal: 500, floor: 1500, candidates });
    expect(r.floorGapKcal).toBe(1000);
    expect(r.note).toMatch(/below your safety floor/);
    // Budget is at least the floor gap
    const r2 = suggestMealsForRemaining({ remaining: { kcal: -100, protein: 0, carbs: 0, fat: 0 }, consumedKcal: 1000, floor: 1500, candidates });
    expect(r2.floorGapKcal).toBe(500);
    expect(r2.suggestions.length).toBeGreaterThan(0);
    for (const s of r2.suggestions) expect(s.nutrients.kcal).toBeLessThanOrEqual(500);
  });

  it("returns nothing (not negative portions) when the target is met", () => {
    const r = suggestMealsForRemaining({ remaining: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, consumedKcal: 2000, floor: 1500, candidates });
    expect(r.suggestions).toHaveLength(0);
    expect(r.note).toMatch(/reached/);
  });
});

describe("tradeoff card", () => {
  it("returns neutral numbers and the goal shift", () => {
    const c = tradeoffCard({
      chosen: { kcal: 900, protein: 30 },
      best: { kcal: 600, protein: 45 },
      remainingKcal: 1000,
      remainingProtein: 60,
      dailyDeficitKcal: 500,
      daysToGoal: 100,
      timesPerWeek: 3,
    });
    expect(c.deltaKcal).toBe(300);
    expect(c.deltaProtein).toBe(-15);
    expect(c.remainingKcalAfter).toBe(100);
    // weekly deficit 3500, lost 900 → 100 × 3500/2600 − 100 ≈ 35
    expect(c.goalShiftDays).toBe(35);
    expect(c.summary).toContain("vs best pick: +300 kcal, -15 g protein");
    expect(c.summary).not.toMatch(/bad|good|cheat|guilt/i);
  });
});

describe("plausibility validation", () => {
  it("accepts real foods", () => {
    expect(validatePer100g(chicken).ok).toBe(true);
    expect(validatePer100g(oil).ok).toBe(true);
    expect(validatePer100g({ kcal: 539, protein: 6.3, carbs: 57.5, fat: 30.9, sugar: 56.3, sodiumMg: 43 }).ok).toBe(true); // Nutella
    // US label: fiber inside carbs at 2 kcal/g
    expect(validatePer100g({ kcal: 340, protein: 13, carbs: 72, fat: 2.5, fiber: 11 }).ok).toBe(true);
  });

  it("rejects > 900 kcal/100g", () => {
    const r = validatePer100g({ kcal: 1200, protein: 0, carbs: 0, fat: 100 });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/900/);
  });

  it("rejects macros exceeding weight", () => {
    const r = validatePer100g({ kcal: 600, protein: 60, carbs: 60, fat: 10 });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/exceeds 100 g/);
  });

  it("rejects kcal inconsistent with 4/4/9 by >15%", () => {
    const r = validatePer100g({ kcal: 100, protein: 25, carbs: 10, fat: 5 });
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toMatch(/inconsistent/);
  });

  it("rejects negative and non-finite values", () => {
    expect(validatePer100g({ kcal: -5, protein: 0, carbs: 0, fat: 0 }).ok).toBe(false);
    expect(validatePer100g({ kcal: NaN, protein: 0, carbs: 0, fat: 0 }).ok).toBe(false);
  });

  it("validates eaten entries", () => {
    expect(validateEntryNutrients({ kcal: 650, protein: 40, carbs: 60, fat: 27 }).ok).toBe(true);
    expect(validateEntryNutrients({ kcal: 9000, protein: 300, carbs: 1000, fat: 300 }).ok).toBe(false);
    expect(validateEntryNutrients({ kcal: 400, protein: 50, carbs: 30, fat: 9 }, { grams: 50 }).ok).toBe(false);
  });

  it("validates amounts, URLs, and text", () => {
    expect(validateAmount(100000, "g").ok).toBe(false);
    expect(validateAmount(0, "g").ok).toBe(false);
    expect(validateAmount(500, "serving").ok).toBe(false);
    expect(validateUrls(["javascript:alert(1)"]).ok).toBe(false);
    expect(validateUrls(["https://example.com/menu"]).ok).toBe(true);
    expect(cleanText("  hi\u0000there  ")).toBe("hithere");
  });
});
