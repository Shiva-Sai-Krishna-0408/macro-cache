import { type Nutrients } from "./nutrition";

export interface TradeoffInput {
  chosen: Pick<Nutrients, "kcal" | "protein">;
  best: Pick<Nutrients, "kcal" | "protein">;
  /** Remaining today BEFORE eating the chosen option. */
  remainingKcal: number;
  remainingProtein: number;
  /** Planned daily deficit (maintenance − target), kcal. 0 for maintain. */
  dailyDeficitKcal: number;
  /** Days until goal at the current plan (null if unknown/maintaining). */
  daysToGoal: number | null;
  timesPerWeek?: number;
}

export interface TradeoffCard {
  deltaKcal: number;
  deltaProtein: number;
  remainingKcalAfter: number;
  remainingProteinAfter: number;
  timesPerWeek: number;
  /** Approximate days the goal date moves if this becomes a habit. */
  goalShiftDays: number | null;
  /** Neutral one-line summary — numbers only, no judgement words. */
  summary: string;
}

/**
 * Neutral tradeoff numbers for picking something other than the best option.
 * Used by Claude to render a "tradeoff card". Never blocks logging.
 */
export function tradeoffCard(input: TradeoffInput): TradeoffCard {
  const times = input.timesPerWeek ?? 3;
  const deltaKcal = Math.round(input.chosen.kcal - input.best.kcal);
  const deltaProtein = Math.round(input.chosen.protein - input.best.protein);
  const remainingKcalAfter = Math.round(input.remainingKcal - input.chosen.kcal);
  const remainingProteinAfter = Math.round(input.remainingProtein - input.chosen.protein);

  let goalShiftDays: number | null = null;
  if (input.daysToGoal !== null && input.dailyDeficitKcal > 0 && deltaKcal !== 0) {
    const weeklyDeficit = input.dailyDeficitKcal * 7;
    const weeklyLost = deltaKcal * times;
    if (weeklyLost >= weeklyDeficit) goalShiftDays = Infinity;
    else goalShiftDays = Math.round(input.daysToGoal * (weeklyDeficit / (weeklyDeficit - weeklyLost)) - input.daysToGoal);
  }

  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  const parts = [
    `vs best pick: ${sign(deltaKcal)} kcal, ${sign(deltaProtein)} g protein`,
    `remaining today: ${remainingKcalAfter} kcal / ${remainingProteinAfter} g protein`,
  ];
  if (goalShiftDays !== null)
    parts.push(
      goalShiftDays === Infinity
        ? `as a ${times}×/week habit, this would offset the planned weekly deficit`
        : `as a ${times}×/week habit, goal date moves ~${Math.abs(goalShiftDays)} days ${goalShiftDays >= 0 ? "later" : "earlier"}`,
    );
  return { deltaKcal, deltaProtein, remainingKcalAfter, remainingProteinAfter, timesPerWeek: times, goalShiftDays, summary: parts.join("; ") };
}
