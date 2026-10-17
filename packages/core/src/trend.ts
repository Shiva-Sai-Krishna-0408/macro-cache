import { type ISODate, daysBetween } from "./dates";

export interface WeighIn {
  date: ISODate;
  weightKg: number;
  bodyFatPct?: number | null;
}

export interface TrendPoint {
  date: ISODate;
  weightKg: number;
  trendKg: number;
}

/** Per-day smoothing factor (Hacker's Diet style exponential moving average). */
export const TREND_ALPHA = 0.1;

/**
 * Exponentially smoothed trend weight. Gaps between weigh-ins are handled by
 * compounding the daily factor: alpha_eff = 1 − (1 − α)^gapDays.
 * Multiple weigh-ins on one day are averaged first.
 */
export function trendWeights(entries: WeighIn[], alpha = TREND_ALPHA): TrendPoint[] {
  const byDay = new Map<string, number[]>();
  for (const e of entries) {
    if (!Number.isFinite(e.weightKg)) continue;
    const list = byDay.get(e.date) ?? [];
    list.push(e.weightKg);
    byDay.set(e.date, list);
  }
  const days = [...byDay.keys()].sort();
  const out: TrendPoint[] = [];
  let trend: number | null = null;
  let prev: ISODate | null = null;
  for (const date of days) {
    const ws = byDay.get(date)!;
    const w = ws.reduce((a, b) => a + b, 0) / ws.length;
    if (trend === null || prev === null) {
      trend = w;
    } else {
      const gap = Math.max(1, daysBetween(prev, date));
      const a = 1 - (1 - alpha) ** gap;
      trend = trend + a * (w - trend);
    }
    out.push({ date, weightKg: w, trendKg: trend });
    prev = date;
  }
  return out;
}

/** Trend weight as of a date (last point on or before it). */
export function trendAt(points: TrendPoint[], date: ISODate): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p.date <= date) v = p.trendKg;
    else break;
  }
  return v;
}

/** Least-squares slope of trend weight (kg/day) over points within the last `days` days. */
export function trendSlopeKgPerDay(points: TrendPoint[], endDate: ISODate, days = 28): number | null {
  const window = points.filter((p) => daysBetween(p.date, endDate) >= 0 && daysBetween(p.date, endDate) <= days);
  if (window.length < 2) return null;
  const xs = window.map((p) => -daysBetween(p.date, endDate));
  const ys = window.map((p) => p.trendKg);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}
