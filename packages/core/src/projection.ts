import { type ISODate, addDays } from "./dates";
import { type Activity, type Sex, safetyFloor, tdeeFormula } from "./targets";
import { KCAL_PER_KG, bmi, clamp } from "./units";

export const BMI_UNDERWEIGHT = 18.5;
export const WEEKS_PER_MONTH = 52 / 12;

/** Share of weight LOST that is fat, assuming adequate protein + resistance training. */
export const FAT_SHARE_OF_LOSS: [number, number] = [0.7, 0.85];
/** Share of weight GAINED that is lean mass, with training and a modest surplus. */
export const LEAN_SHARE_OF_GAIN: [number, number] = [0.3, 0.5];

export interface ProjectionInput {
  startDate: ISODate;
  startWeightKg: number;
  heightCm: number;
  age: number;
  sex: Sex;
  activity: Activity;
  /** Daily calories on on-target days. */
  intakeKcal: number;
  /** Months to simulate (1–24). */
  months: number;
  /** Days per week on target (0–7). Off days are eaten at maintenance. */
  daysOnTargetPerWeek?: number;
  /** Observed (adaptive) TDEE at the start weight, if known. */
  adaptiveTdee?: number | null;
  goalWeightKg?: number | null;
}

export interface ProjectionPoint {
  week: number;
  date: ISODate;
  weightKg: number;
  tdee: number;
}

export interface Range {
  low: number;
  high: number;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  endWeightKg: number;
  totalChangeKg: number;
  /** Estimated fat-mass change (kg, signed). */
  fatChangeKg: Range;
  /** Estimated lean-mass change (kg, signed). */
  leanChangeKg: Range;
  goalReachedDate: ISODate | null;
  goalReachedWeek: number | null;
  floor: number;
  belowFloor: boolean;
  /** First week whose projected weight is under BMI 18.5. */
  bmiUnderweightWeek: number | null;
  warnings: string[];
}

/**
 * Week-by-week simulation. TDEE is recomputed from the projected weight each
 * week, so loss slows as weight (and BMR) falls. If an adaptive TDEE is
 * known, its offset from the formula at the start weight is carried forward.
 * Weekly change = Σ(intake − TDEE) over on-target days ÷ 7700 kcal/kg.
 */
export function projectWeight(input: ProjectionInput): ProjectionResult {
  const weeks = Math.round(clamp(input.months, 1, 24) * WEEKS_PER_MONTH);
  const daysOn = clamp(Math.round(input.daysOnTargetPerWeek ?? 7), 0, 7);
  const stats = (w: number) => ({ weightKg: w, heightCm: input.heightCm, age: input.age, sex: input.sex });
  const formulaAt = (w: number) => tdeeFormula(stats(w), input.activity);
  const offset = input.adaptiveTdee && input.adaptiveTdee > 0 ? input.adaptiveTdee - formulaAt(input.startWeightKg) : 0;
  const tdeeAt = (w: number) => formulaAt(w) + offset;

  const warnings: string[] = [];
  const floor = safetyFloor(stats(input.startWeightKg));
  const belowFloor = input.intakeKcal < floor;
  if (belowFloor) warnings.push(`${Math.round(input.intakeKcal)} kcal is below your safety floor of ${floor} kcal.`);

  let w = input.startWeightKg;
  const points: ProjectionPoint[] = [{ week: 0, date: input.startDate, weightKg: w, tdee: Math.round(tdeeAt(w)) }];
  let goalReachedWeek: number | null = null;
  let goalReachedDate: ISODate | null = null;
  let bmiUnderweightWeek: number | null = null;
  const goal = input.goalWeightKg ?? null;
  const losing = goal !== null && goal < input.startWeightKg;

  for (let week = 1; week <= weeks; week++) {
    const tdee = tdeeAt(w);
    const weeklyDeltaKcal = daysOn * (input.intakeKcal - tdee); // off days at maintenance → 0
    const prev = w;
    w = w + weeklyDeltaKcal / KCAL_PER_KG;
    const date = addDays(input.startDate, week * 7);
    points.push({ week, date, weightKg: w, tdee: Math.round(tdeeAt(w)) });

    if (goal !== null && goalReachedWeek === null) {
      const crossed = losing ? w <= goal && prev > goal : w >= goal && prev < goal;
      if (crossed) {
        const frac = (goal - prev) / (w - prev);
        goalReachedWeek = week - 1 + frac;
        goalReachedDate = addDays(input.startDate, Math.round((week - 1 + frac) * 7));
      }
    }
    if (bmiUnderweightWeek === null && bmi(w, input.heightCm) < BMI_UNDERWEIGHT) bmiUnderweightWeek = week;
  }
  if (goal !== null && goalReachedWeek === null && (losing ? input.startWeightKg <= goal : input.startWeightKg >= goal)) {
    goalReachedWeek = 0;
    goalReachedDate = input.startDate;
  }
  if (bmiUnderweightWeek !== null) warnings.push(`Projection drops below BMI ${BMI_UNDERWEIGHT} around week ${bmiUnderweightWeek}.`);

  const totalChangeKg = w - input.startWeightKg;
  const { fat, lean } = compositionRange(totalChangeKg);
  return {
    points,
    endWeightKg: w,
    totalChangeKg,
    fatChangeKg: fat,
    leanChangeKg: lean,
    goalReachedDate,
    goalReachedWeek,
    floor,
    belowFloor,
    bmiUnderweightWeek,
    warnings,
  };
}

/** Fat vs lean split of a weight change, as a range. Signed like the change. */
export function compositionRange(changeKg: number): { fat: Range; lean: Range } {
  if (changeKg <= 0) {
    const loss = -changeKg;
    return {
      fat: { low: -loss * FAT_SHARE_OF_LOSS[1], high: -loss * FAT_SHARE_OF_LOSS[0] },
      lean: { low: -loss * (1 - FAT_SHARE_OF_LOSS[0]), high: -loss * (1 - FAT_SHARE_OF_LOSS[1]) },
    };
  }
  return {
    lean: { low: changeKg * LEAN_SHARE_OF_GAIN[0], high: changeKg * LEAN_SHARE_OF_GAIN[1] },
    fat: { low: changeKg * (1 - LEAN_SHARE_OF_GAIN[1]), high: changeKg * (1 - LEAN_SHARE_OF_GAIN[0]) },
  };
}

