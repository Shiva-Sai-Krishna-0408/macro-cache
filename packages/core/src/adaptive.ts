import { type ISODate, addDays, daysBetween } from "./dates";
import { type WeighIn, trendWeights } from "./trend";
import { KCAL_PER_LB, clamp, kgToLb } from "./units";

export interface DailyIntake {
  date: ISODate;
  kcal: number;
}

export const ADAPTIVE_MIN_DAYS = 14;
/** Minimum share of days in the window that must be logged. */
export const ADAPTIVE_MIN_LOGGED_FRACTION = 0.7;
export const ADAPTIVE_MIN_WEIGH_INS = 4;
/** Look-back window for the estimate. */
export const ADAPTIVE_WINDOW_DAYS = 28;

export interface AdaptiveResult {
  ok: boolean;
  reason?: string;
  /** Observed TDEE from intake and trend weight change. */
  observedTdee?: number;
  /** Observed blended with the formula estimate. */
  blendedTdee?: number;
  /** Weight given to the observed value (0–1). */
  observedWeight?: number;
  windowDays?: number;
  avgIntake?: number;
  trendChangeKg?: number;
  loggedDays?: number;
  weighIns?: number;
}

/**
 * Adaptive TDEE: real TDEE = avg intake − (trend weight change × 3500 kcal/lb ÷ days).
 * Requires ≥14 days of intake + weight data. The result is blended with the
 * formula estimate, trusting the observation more as the window grows.
 */
export function adaptiveTdee(intake: DailyIntake[], weights: WeighIn[], formulaTdee: number, endDate: ISODate): AdaptiveResult {
  const windowStart = addDays(endDate, -(ADAPTIVE_WINDOW_DAYS - 1));
  const inWindow = (d: ISODate) => d >= windowStart && d <= endDate;
  const logged = intake.filter((i) => inWindow(i.date) && i.kcal > 0);
  const ws = weights.filter((w) => inWindow(w.date));

  if (logged.length === 0 || ws.length === 0) return { ok: false, reason: "Need intake logs and weigh-ins." };
  const firstDay = [logged[0].date, ...logged.map((l) => l.date), ws[0].date, ...ws.map((w) => w.date)].sort()[0];
  const span = daysBetween(firstDay, endDate) + 1;
  if (span < ADAPTIVE_MIN_DAYS) return { ok: false, reason: `Need at least ${ADAPTIVE_MIN_DAYS} days of data (have ${span}).`, windowDays: span };
  if (logged.length < Math.ceil(span * ADAPTIVE_MIN_LOGGED_FRACTION))
    return { ok: false, reason: `Log food on at least ${Math.round(ADAPTIVE_MIN_LOGGED_FRACTION * 100)}% of days (logged ${logged.length} of ${span}).`, windowDays: span };
  if (ws.length < ADAPTIVE_MIN_WEIGH_INS)
    return { ok: false, reason: `Need at least ${ADAPTIVE_MIN_WEIGH_INS} weigh-ins in the window (have ${ws.length}).`, windowDays: span };

  // Use all history to seed the trend, then measure change across the window.
  const trend = trendWeights(weights.filter((w) => w.date <= endDate));
  const startTrend = trend.filter((p) => p.date <= windowStart).at(-1) ?? trend.find((p) => p.date >= windowStart)!;
  const endTrend = trend.at(-1)!;
  const days = Math.max(1, daysBetween(startTrend.date < windowStart ? windowStart : startTrend.date, endTrend.date));

  const avgIntake = logged.reduce((a, b) => a + b.kcal, 0) / logged.length;
  const changeKg = endTrend.trendKg - startTrend.trendKg;
  const observed = avgIntake - (kgToLb(changeKg) * KCAL_PER_LB) / days;

  // 50% trust at 14 days → 80% at 28 days.
  const observedWeight = clamp(0.5 + ((span - ADAPTIVE_MIN_DAYS) / (ADAPTIVE_WINDOW_DAYS - ADAPTIVE_MIN_DAYS)) * 0.3, 0.5, 0.8);
  const blended = observed * observedWeight + formulaTdee * (1 - observedWeight);

  return {
    ok: true,
    observedTdee: Math.round(observed),
    blendedTdee: Math.round(blended),
    observedWeight,
    windowDays: span,
    avgIntake: Math.round(avgIntake),
    trendChangeKg: changeKg,
    loggedDays: logged.length,
    weighIns: ws.length,
  };
}
