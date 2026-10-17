import { describe, expect, it } from "vitest";
import {
  addDays,
  adaptiveTdee,
  computeProgress,
  compositionRange,
  projectWeight,
  tdeeFormula,
  trendWeights,
  weekStart,
  lbToKg,
  KCAL_PER_KG,
} from "../src";

const base = { startDate: "2026-01-05", startWeightKg: 90, heightCm: 178, age: 35, sex: "male" as const, activity: "moderate" as const };

describe("trend weight", () => {
  it("smooths noise and handles gaps", () => {
    const pts = trendWeights([
      { date: "2026-01-01", weightKg: 80 },
      { date: "2026-01-02", weightKg: 82 },
      { date: "2026-01-04", weightKg: 80 },
    ]);
    expect(pts[0].trendKg).toBe(80);
    expect(pts[1].trendKg).toBeCloseTo(80.2);
    // 2-day gap → alpha_eff = 1 − 0.9² = 0.19
    expect(pts[2].trendKg).toBeCloseTo(80.2 + 0.19 * (80 - 80.2));
  });

  it("averages multiple weigh-ins on one day", () => {
    const pts = trendWeights([
      { date: "2026-01-01", weightKg: 80 },
      { date: "2026-01-01", weightKg: 81 },
    ]);
    expect(pts).toHaveLength(1);
    expect(pts[0].weightKg).toBe(80.5);
  });
});

describe("adaptive TDEE", () => {
  const formula = 2500;
  function series(days: number, intake: number, kgPerDay: number, start = "2026-03-01") {
    const intakeArr = [];
    const weights = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      intakeArr.push({ date: d, kcal: intake });
      weights.push({ date: d, weightKg: 90 + kgPerDay * i });
    }
    return { intakeArr, weights, end: addDays(start, days - 1) };
  }

  it("requires ≥14 days", () => {
    const s = series(10, 2000, 0);
    const r = adaptiveTdee(s.intakeArr, s.weights, formula, s.end);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/14 days/);
  });

  it("stable weight → TDEE ≈ average intake", () => {
    const s = series(28, 2200, 0);
    const r = adaptiveTdee(s.intakeArr, s.weights, formula, s.end);
    expect(r.ok).toBe(true);
    expect(r.observedTdee).toBe(2200);
    expect(r.blendedTdee).toBe(Math.round(2200 * 0.8 + 2500 * 0.2));
  });

  it("losing 1 lb/week at 2000 kcal → observed ≈ 2500", () => {
    const s = series(28, 2000, -lbToKg(1) / 7);
    const r = adaptiveTdee(s.intakeArr, s.weights, formula, s.end);
    expect(r.ok).toBe(true);
    // EMA lags the true slope, so allow a tolerance.
    expect(r.observedTdee!).toBeGreaterThan(2250);
    expect(r.observedTdee!).toBeLessThan(2550);
  });

  it("rejects sparse logging", () => {
    const s = series(28, 2000, 0);
    const sparse = s.intakeArr.filter((_, i) => i % 3 === 0);
    expect(adaptiveTdee(sparse, s.weights, formula, s.end).ok).toBe(false);
  });
});

describe("projection engine", () => {
  it("recomputes TDEE weekly so loss slows (non-linear)", () => {
    const r = projectWeight({ ...base, intakeKcal: 2000, months: 12 });
    const firstWeek = r.points[0].weightKg - r.points[1].weightKg;
    const lastWeek = r.points.at(-2)!.weightKg - r.points.at(-1)!.weightKg;
    expect(firstWeek).toBeGreaterThan(lastWeek);
    expect(r.points[1].tdee).toBeLessThan(r.points[0].tdee);
    // week 1 change matches (intake − TDEE)×7/7700
    const tdee0 = tdeeFormula({ weightKg: 90, heightCm: 178, age: 35, sex: "male" }, "moderate");
    expect(firstWeek).toBeCloseTo(((tdee0 - 2000) * 7) / KCAL_PER_KG, 6);
  });

  it("uses adaptive TDEE as the starting point", () => {
    const formula = projectWeight({ ...base, intakeKcal: 2200, months: 3 });
    const adaptive = projectWeight({ ...base, intakeKcal: 2200, months: 3, adaptiveTdee: 2500 });
    expect(adaptive.points[0].tdee).toBe(2500);
    expect(adaptive.endWeightKg).not.toBeCloseTo(formula.endWeightKg, 1);
  });

  it("days-on-target modifier: off days at maintenance shrink the change", () => {
    const seven = projectWeight({ ...base, intakeKcal: 2000, months: 6, daysOnTargetPerWeek: 7 });
    const five = projectWeight({ ...base, intakeKcal: 2000, months: 6, daysOnTargetPerWeek: 5 });
    const zero = projectWeight({ ...base, intakeKcal: 2000, months: 6, daysOnTargetPerWeek: 0 });
    expect(Math.abs(five.totalChangeKg)).toBeLessThan(Math.abs(seven.totalChangeKg));
    expect(Math.abs(five.totalChangeKg)).toBeGreaterThan(Math.abs(seven.totalChangeKg) * 0.6);
    expect(zero.totalChangeKg).toBe(0);
  });

  it("fat/lean ranges for loss and gain", () => {
    const loss = compositionRange(-10);
    expect(loss.fat.low).toBeCloseTo(-8.5);
    expect(loss.fat.high).toBeCloseTo(-7);
    expect(loss.lean.low).toBeCloseTo(-3);
    expect(loss.lean.high).toBeCloseTo(-1.5);
    const gain = compositionRange(4);
    expect(gain.lean.low).toBeCloseTo(1.2);
    expect(gain.lean.high).toBeCloseTo(2);
    expect(gain.fat.low).toBeCloseTo(2);
    expect(gain.fat.high).toBeCloseTo(2.8);
  });

  it("flags BMI < 18.5 and below-floor intake", () => {
    const r = projectWeight({ ...base, startWeightKg: 62, intakeKcal: 1200, months: 24 });
    expect(r.belowFloor).toBe(true);
    expect(r.bmiUnderweightWeek).not.toBeNull();
    expect(r.warnings.join(" ")).toMatch(/BMI 18.5/);
  });

  it("computes the goal date by interpolation", () => {
    const r = projectWeight({ ...base, intakeKcal: 2000, months: 24, goalWeightKg: 85 });
    expect(r.goalReachedWeek).not.toBeNull();
    const wk = Math.floor(r.goalReachedWeek!);
    expect(r.points[wk].weightKg).toBeGreaterThan(85);
    expect(r.points[wk + 1].weightKg).toBeLessThanOrEqual(85);
    expect(r.goalReachedDate! >= r.points[wk].date).toBe(true);
    expect(r.goalReachedDate! <= r.points[wk + 1].date).toBe(true);
    const never = projectWeight({ ...base, intakeKcal: 3500, months: 6, goalWeightKg: 80 });
    expect(never.goalReachedDate).toBeNull();
  });

  it("clamps months to 1–24", () => {
    expect(projectWeight({ ...base, intakeKcal: 2000, months: 100 }).points).toHaveLength(105);
    expect(projectWeight({ ...base, intakeKcal: 2000, months: 0 }).points).toHaveLength(5);
  });
});

describe("progress", () => {
  const today = "2026-04-30";
  const weights = Array.from({ length: 30 }, (_, i) => ({ date: addDays("2026-04-01", i), weightKg: 90 - i * 0.1 }));
  const dayTotals = Array.from({ length: 10 }, (_, i) => ({ date: addDays(today, -i), kcal: i === 3 ? 3000 : 2000, protein: 150 }));

  it("computes start, trend, % of goal, rate, and projected date", () => {
    const p = computeProgress({ today, weights, dayTotals, goalWeightKg: 80, targetKcal: 2000 });
    expect(p.startWeightKg).toBe(90);
    expect(p.currentTrendKg!).toBeLessThan(90);
    expect(p.currentTrendKg!).toBeGreaterThan(87.1);
    expect(p.percentOfGoal!).toBeGreaterThan(0);
    expect(p.ratePerWeekKg!).toBeLessThan(0);
    expect(p.projectedGoalDate! > today).toBe(true);
  });

  it("streak and adherence", () => {
    const p = computeProgress({ today, weights, dayTotals, goalWeightKg: 80, targetKcal: 2000 });
    expect(p.streakDays).toBe(10);
    expect(p.weeklyAdherencePct).toBe(Math.round((6 / 7) * 100));
  });

  it("estimated fat range without body-fat data; measured with it", () => {
    const est = computeProgress({ today, weights, dayTotals, goalWeightKg: 80 });
    expect(est.fatChange?.kind).toBe("estimate");
    const bf = computeProgress({
      today,
      weights: [
        { date: "2026-04-01", weightKg: 90, bodyFatPct: 25 },
        { date: "2026-04-29", weightKg: 86, bodyFatPct: 23 },
      ],
      dayTotals,
    });
    expect(bf.fatChange).toEqual({ kind: "measured", kg: 86 * 0.23 - 90 * 0.25 });
  });
});

describe("dates", () => {
  it("weekStart returns Monday", () => {
    expect(weekStart("2026-10-17")).toBe("2026-10-12"); // Saturday → Monday
    expect(weekStart("2026-10-18")).toBe("2026-10-12"); // Sunday → previous Monday
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
  });
});
