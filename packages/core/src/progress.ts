import { type ISODate, addDays } from "./dates";
import { compositionRange, type Range } from "./projection";
import { type WeighIn, trendSlopeKgPerDay, trendWeights } from "./trend";

export const ADHERENCE_TOLERANCE = 0.1;

export interface DayTotal {
  date: ISODate;
  kcal: number;
  protein: number;
}

export interface ProgressInput {
  today: ISODate;
  weights: WeighIn[];
  dayTotals: DayTotal[];
  goalWeightKg?: number | null;
  /** Daily kcal target (for adherence). */
  targetKcal?: number | null;
  /** Optional profile start weight (used if no weigh-ins). */
  profileWeightKg?: number | null;
}

export interface ProgressResult {
  startWeightKg: number | null;
  startDate: ISODate | null;
  currentTrendKg: number | null;
  latestWeightKg: number | null;
  goalWeightKg: number | null;
  /** Signed change from start to current trend. */
  totalChangeKg: number | null;
  percentOfGoal: number | null;
  /** Trend slope over last 28 days (kg/week, signed). */
  ratePerWeekKg: number | null;
  /** Estimated fat change (signed). Exact when body-fat data exists. */
  fatChange: { kind: "measured"; kg: number } | { kind: "estimate"; range: Range } | null;
  leanChange: { kind: "measured"; kg: number } | { kind: "estimate"; range: Range } | null;
  streakDays: number;
  weeklyAdherencePct: number | null;
  daysLoggedLast7: number;
  projectedGoalDate: ISODate | null;
  trend: { date: ISODate; weightKg: number; trendKg: number }[];
}

/** Progress stats shared by the dashboard and the get_progress tool. */
export function computeProgress(input: ProgressInput): ProgressResult {
  const weights = [...input.weights].sort((a, b) => a.date.localeCompare(b.date));
  const trend = trendWeights(weights);
  const first = weights[0];
  const startWeightKg = first?.weightKg ?? input.profileWeightKg ?? null;
  const currentTrendKg = trend.at(-1)?.trendKg ?? input.profileWeightKg ?? null;
  const latestWeightKg = weights.at(-1)?.weightKg ?? null;
  const goal = input.goalWeightKg ?? null;

  const totalChangeKg = startWeightKg !== null && currentTrendKg !== null ? currentTrendKg - startWeightKg : null;
  let percentOfGoal: number | null = null;
  if (goal !== null && startWeightKg !== null && currentTrendKg !== null && goal !== startWeightKg) {
    percentOfGoal = Math.max(0, Math.min(100, ((startWeightKg - currentTrendKg) / (startWeightKg - goal)) * 100));
  }

  const slope = trendSlopeKgPerDay(trend, input.today, 28);
  const ratePerWeekKg = slope === null ? null : slope * 7;

  // Body composition
  let fatChange: ProgressResult["fatChange"] = null;
  let leanChange: ProgressResult["leanChange"] = null;
  const bf = weights.filter((w) => w.bodyFatPct != null && w.bodyFatPct > 0);
  if (bf.length >= 2) {
    const a = bf[0];
    const b = bf.at(-1)!;
    const fatA = (a.weightKg * a.bodyFatPct!) / 100;
    const fatB = (b.weightKg * b.bodyFatPct!) / 100;
    fatChange = { kind: "measured", kg: fatB - fatA };
    leanChange = { kind: "measured", kg: b.weightKg - fatB - (a.weightKg - fatA) };
  } else if (totalChangeKg !== null && totalChangeKg !== 0) {
    const r = compositionRange(totalChangeKg);
    fatChange = { kind: "estimate", range: r.fat };
    leanChange = { kind: "estimate", range: r.lean };
  }

  // Logging streak: consecutive logged days ending today (or yesterday, if today isn't logged yet).
  const logged = new Set(input.dayTotals.filter((d) => d.kcal > 0).map((d) => d.date));
  let streakDays = 0;
  let cursor = logged.has(input.today) ? input.today : addDays(input.today, -1);
  while (logged.has(cursor)) {
    streakDays++;
    cursor = addDays(cursor, -1);
  }

  // Weekly adherence: % of the last 7 days (ending yesterday if today is incomplete) within ±10% of target.
  let weeklyAdherencePct: number | null = null;
  let daysLoggedLast7 = 0;
  if (input.targetKcal && input.targetKcal > 0) {
    const byDate = new Map(input.dayTotals.map((d) => [d.date, d.kcal]));
    let hits = 0;
    for (let i = 0; i < 7; i++) {
      const d = addDays(input.today, -i);
      const k = byDate.get(d) ?? 0;
      if (k > 0) daysLoggedLast7++;
      if (k > 0 && Math.abs(k - input.targetKcal) <= input.targetKcal * ADHERENCE_TOLERANCE) hits++;
    }
    weeklyAdherencePct = Math.round((hits / 7) * 100);
  }

  // Projected goal date from actual trend pace.
  let projectedGoalDate: ISODate | null = null;
  if (goal !== null && currentTrendKg !== null && slope !== null && slope !== 0) {
    const remaining = goal - currentTrendKg;
    if (Math.sign(remaining) === Math.sign(slope) && Math.abs(remaining) > 0.05) {
      const days = remaining / slope;
      if (days < 365 * 5) projectedGoalDate = addDays(input.today, Math.round(days));
    }
  }

  return {
    startWeightKg,
    startDate: first?.date ?? null,
    currentTrendKg,
    latestWeightKg,
    goalWeightKg: goal,
    totalChangeKg,
    percentOfGoal,
    ratePerWeekKg,
    fatChange,
    leanChange,
    streakDays,
    weeklyAdherencePct,
    daysLoggedLast7,
    projectedGoalDate,
    trend,
  };
}

