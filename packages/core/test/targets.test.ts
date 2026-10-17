import { describe, expect, it } from "vitest";
import {
  bmrMifflin,
  checkIntakeAgainstFloor,
  computeMacros,
  computeTargets,
  maxLossPaceLb,
  safetyFloor,
  tdeeFormula,
  lbToKg,
} from "../src";

const male = { weightKg: 80, heightCm: 180, age: 30, sex: "male" as const };
const female = { weightKg: 60, heightCm: 165, age: 25, sex: "female" as const };

describe("BMR / TDEE (Mifflin-St Jeor)", () => {
  it("matches reference values", () => {
    // 10×80 + 6.25×180 − 5×30 + 5 = 1780
    expect(bmrMifflin(male)).toBeCloseTo(1780, 6);
    // 10×60 + 6.25×165 − 5×25 − 161 = 1345.25
    expect(bmrMifflin(female)).toBeCloseTo(1345.25, 6);
  });

  it("applies activity multipliers", () => {
    expect(tdeeFormula(male, "sedentary")).toBeCloseTo(1780 * 1.2);
    expect(tdeeFormula(male, "moderate")).toBeCloseTo(2759);
    expect(tdeeFormula(female, "very_active")).toBeCloseTo(1345.25 * 1.9);
  });
});

describe("safety floor", () => {
  it("is max(BMR, 1500) for men and max(BMR, 1200) for women", () => {
    expect(safetyFloor(male)).toBe(1780); // BMR above 1500
    expect(safetyFloor(female)).toBe(1345); // BMR above 1200
    const smallWoman = { weightKg: 45, heightCm: 150, age: 60, sex: "female" as const }; // BMR 976.5
    expect(safetyFloor(smallWoman)).toBe(1200);
    const smallMan = { weightKg: 50, heightCm: 160, age: 70, sex: "male" as const }; // BMR 1155
    expect(safetyFloor(smallMan)).toBe(1500);
  });

  it("never sets a target below the floor, and warns", () => {
    const t = computeTargets({ ...female, activity: "sedentary", goal: "lose", paceLbPerWeek: 1 });
    // TDEE 1614, 1 lb/wk would be 1114 → raised to floor (and pace already capped at 1% = 1.32 lb so no cap)
    expect(t.kcal).toBe(t.floor);
    expect(t.kcal).toBeGreaterThanOrEqual(1200);
    expect(t.warnings.join(" ")).toMatch(/safety floor/);
    expect(t.effectivePaceLbPerWeek).toBeLessThan(0);
    expect(Math.abs(t.effectivePaceLbPerWeek)).toBeLessThan(1);
  });

  it("flags manual intake below the floor", () => {
    expect(checkIntakeAgainstFloor(1000, female).ok).toBe(false);
    expect(checkIntakeAgainstFloor(1000, female).warning).toMatch(/below your safety floor/);
    expect(checkIntakeAgainstFloor(2000, female).ok).toBe(true);
  });
});

describe("pace caps", () => {
  it("caps loss at ~1% bodyweight per week", () => {
    const light = lbToKg(80); // 80 lb person → 0.8 lb/wk max
    expect(maxLossPaceLb(light)).toBeCloseTo(0.8);
    expect(maxLossPaceLb(lbToKg(250))).toBe(1); // never above the 1 lb preset
    const t = computeTargets({ weightKg: lbToKg(120), heightCm: 160, age: 30, sex: "female", activity: "active", goal: "lose", paceLbPerWeek: 1 });
    expect(t.effectivePaceLbPerWeek).toBe(-1); // 1% of 120 lb = 1.2, but presets top out at 1
    expect(Math.abs(t.effectivePaceLbPerWeek)).toBeLessThanOrEqual(1.2);
  });

  it("caps loss for a lighter person and reports it", () => {
    const t = computeTargets({ weightKg: lbToKg(110), heightCm: 160, age: 30, sex: "female", activity: "very_active", goal: "lose", paceLbPerWeek: 1 });
    expect(Math.abs(t.effectivePaceLbPerWeek)).toBe(1);
    const t2 = computeTargets({ weightKg: lbToKg(90), heightCm: 150, age: 30, sex: "female", activity: "very_active", goal: "lose", paceLbPerWeek: 1 });
    expect(Math.abs(t2.effectivePaceLbPerWeek)).toBeCloseTo(0.9, 2);
    expect(t2.warnings.join(" ")).toMatch(/capped/);
  });

  it("caps gain at 0.5 lb/week", () => {
    const t = computeTargets({ ...male, activity: "moderate", goal: "gain", paceLbPerWeek: 2 });
    expect(t.effectivePaceLbPerWeek).toBe(0.5);
    expect(t.kcal).toBe(Math.round(2759 + 250));
  });

  it("computes a standard deficit", () => {
    const t = computeTargets({ ...male, activity: "moderate", goal: "lose", paceLbPerWeek: 0.5 });
    expect(t.maintenance).toBe(2759);
    expect(t.kcal).toBe(2759 - 250);
    expect(t.effectivePaceLbPerWeek).toBe(-0.5);
  });
});

describe("minor gate", () => {
  it("forces maintenance under 18 with a doctor note", () => {
    const t = computeTargets({ weightKg: 70, heightCm: 170, age: 16, sex: "male", activity: "moderate", goal: "lose", paceLbPerWeek: 1 });
    expect(t.goal).toBe("maintain");
    expect(t.kcal).toBe(t.maintenance);
    expect(t.minor).toBe(true);
    expect(t.warnings.join(" ")).toMatch(/talk to a doctor/i);
  });
});

describe("macros", () => {
  it("protein 1.6 g/kg, fat ≥ 0.6 g/kg, carbs remainder", () => {
    const m = computeMacros(2500, 80);
    expect(m.protein).toBe(128);
    expect(m.fat).toBeGreaterThanOrEqual(48);
    expect(m.protein * 4 + m.carbs * 4 + m.fat * 9).toBeGreaterThan(2480);
    expect(m.protein * 4 + m.carbs * 4 + m.fat * 9).toBeLessThan(2520);
  });

  it("clamps protein to 1.2–2.2 g/kg", () => {
    expect(computeMacros(2500, 80, 5).protein).toBe(176);
    expect(computeMacros(2500, 80, 0.5).protein).toBe(96);
  });

  it("never drops fat below 0.6 g/kg even when calories are tight", () => {
    const m = computeMacros(1200, 100, 2.2);
    expect(m.fat).toBeGreaterThanOrEqual(60);
    expect(m.carbs).toBe(0);
  });
});
