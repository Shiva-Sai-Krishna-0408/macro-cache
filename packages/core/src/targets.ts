import { KCAL_PER_LB, clamp, kgToLb, lbToKg, round } from "./units";

export type Sex = "male" | "female";
export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Goal = "lose" | "maintain" | "gain";

export const ACTIVITY_MULTIPLIERS: Record<Activity, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export const ACTIVITY_LABELS: Record<Activity, string> = {
  sedentary: "Sedentary (desk job, little exercise)",
  light: "Light (exercise 1–3 days/week)",
  moderate: "Moderate (exercise 3–5 days/week)",
  active: "Active (hard exercise 6–7 days/week)",
  very_active: "Very active (physical job + training)",
};

/** Pace presets in lb/week. */
export const LOSS_PACES_LB = [0.25, 0.5, 0.75, 1] as const;
export const GAIN_PACES_LB = [0.25, 0.5] as const;
/** Loss is capped at ~1% of body weight per week. */
export const MAX_LOSS_FRACTION_PER_WEEK = 0.01;
export const MAX_GAIN_LB_PER_WEEK = 0.5;

export const PROTEIN_G_PER_KG_DEFAULT = 1.6;
export const PROTEIN_G_PER_KG_MIN = 1.2;
export const PROTEIN_G_PER_KG_MAX = 2.2;
export const FAT_G_PER_KG_MIN = 0.6;
/** Default share of calories from fat (raised if needed to meet the g/kg minimum). */
export const FAT_KCAL_SHARE_DEFAULT = 0.25;

export const ABSOLUTE_FLOOR: Record<Sex, number> = { female: 1200, male: 1500 };
export const ADULT_AGE = 18;

export interface BodyStats {
  weightKg: number;
  heightCm: number;
  age: number;
  sex: Sex;
}

/** Mifflin-St Jeor resting energy expenditure (kcal/day). */
export function bmrMifflin({ weightKg, heightCm, age, sex }: BodyStats): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

/** Total daily energy expenditure from formula: BMR × activity multiplier ("maintenance calories"). */
export function tdeeFormula(stats: BodyStats, activity: Activity): number {
  return bmrMifflin(stats) * ACTIVITY_MULTIPLIERS[activity];
}

/** Lowest intake we will ever set or suggest: max(BMR, 1200 female / 1500 male). */
export function safetyFloor(stats: BodyStats): number {
  return Math.round(Math.max(bmrMifflin(stats), ABSOLUTE_FLOOR[stats.sex]));
}

/** Max loss pace (lb/week) allowed for a body weight: ~1%/week, never above the 1 lb preset. */
export function maxLossPaceLb(weightKg: number): number {
  return Math.min(kgToLb(weightKg) * MAX_LOSS_FRACTION_PER_WEEK, LOSS_PACES_LB[LOSS_PACES_LB.length - 1]);
}

export function clampPace(goal: Goal, paceLb: number, weightKg: number): number {
  if (goal === "maintain") return 0;
  if (goal === "lose") return clamp(paceLb, 0, maxLossPaceLb(weightKg));
  return clamp(paceLb, 0, MAX_GAIN_LB_PER_WEEK);
}

export interface TargetInput extends BodyStats {
  activity: Activity;
  goal: Goal;
  /** Desired pace in lb/week (positive number; direction comes from goal). */
  paceLbPerWeek: number;
  proteinGPerKg?: number;
  /** Optional maintenance override (e.g. accepted adaptive TDEE). */
  maintenanceOverride?: number;
}

export interface Macros {
  protein: number;
  carbs: number;
  fat: number;
}

export interface Targets {
  bmr: number;
  /** Maintenance calories (TDEE) used for the plan. */
  maintenance: number;
  /** Formula TDEE (before any adaptive override). */
  formulaMaintenance: number;
  floor: number;
  kcal: number;
  macros: Macros;
  goal: Goal;
  /** Pace actually used after caps and floor (lb/week; negative = loss). */
  effectivePaceLbPerWeek: number;
  requestedPaceLbPerWeek: number;
  minor: boolean;
  warnings: string[];
}

/**
 * Compute daily calorie and macro targets.
 * Enforces: pace caps, the safety floor, and the under-18 maintenance-only gate.
 */
export function computeTargets(input: TargetInput): Targets {
  const warnings: string[] = [];
  const bmr = bmrMifflin(input);
  const formulaMaintenance = tdeeFormula(input, input.activity);
  const maintenance = input.maintenanceOverride && input.maintenanceOverride > 0 ? input.maintenanceOverride : formulaMaintenance;
  const floor = safetyFloor(input);
  const minor = input.age < ADULT_AGE;

  let goal = input.goal;
  if (minor && goal !== "maintain") {
    warnings.push("Under 18: targets are set to maintenance only. Please talk to a doctor before trying to change your weight.");
    goal = "maintain";
  }

  const requested = goal === "maintain" ? 0 : Math.abs(input.paceLbPerWeek);
  let pace = clampPace(goal, requested, input.weightKg);
  if (pace < requested - 1e-9) {
    warnings.push(
      goal === "lose"
        ? `Pace capped at ${round(pace, 2)} lb/week (~1% of body weight per week).`
        : `Gain pace capped at ${MAX_GAIN_LB_PER_WEEK} lb/week.`,
    );
  }

  const dailyDelta = (pace * KCAL_PER_LB) / 7;
  let kcal = goal === "lose" ? maintenance - dailyDelta : goal === "gain" ? maintenance + dailyDelta : maintenance;

  if (kcal < floor) {
    kcal = floor;
    // Recompute the pace this floor actually allows.
    pace = Math.max(0, ((maintenance - floor) * 7) / KCAL_PER_LB);
    warnings.push(
      `Target raised to your safety floor of ${floor} kcal (max of BMR and ${ABSOLUTE_FLOOR[input.sex]} kcal); expected pace is ${round(pace, 2)} lb/week.`,
    );
  }
  kcal = Math.round(kcal);

  const macros = computeMacros(kcal, input.weightKg, input.proteinGPerKg, warnings);
  const signedPace = goal === "lose" ? -pace : goal === "gain" ? pace : 0;

  return {
    bmr: Math.round(bmr),
    maintenance: Math.round(maintenance),
    formulaMaintenance: Math.round(formulaMaintenance),
    floor,
    kcal,
    macros,
    goal,
    effectivePaceLbPerWeek: round(signedPace, 2),
    requestedPaceLbPerWeek: input.goal === "lose" ? -requested : input.goal === "gain" ? requested : 0,
    minor,
    warnings,
  };
}

/** Protein 1.6 g/kg (1.2–2.2), fat ≥ 0.6 g/kg (default 25% kcal), carbs = remainder. */
export function computeMacros(kcal: number, weightKg: number, proteinGPerKg = PROTEIN_G_PER_KG_DEFAULT, warnings: string[] = []): Macros {
  const pPerKg = clamp(proteinGPerKg, PROTEIN_G_PER_KG_MIN, PROTEIN_G_PER_KG_MAX);
  const protein = pPerKg * weightKg;
  const fatMin = FAT_G_PER_KG_MIN * weightKg;
  let fat = Math.max(fatMin, (kcal * FAT_KCAL_SHARE_DEFAULT) / 9);
  let carbs = (kcal - protein * 4 - fat * 9) / 4;
  if (carbs < 0) {
    // Lower fat toward its minimum before letting carbs hit zero.
    fat = Math.max(fatMin, (kcal - protein * 4) / 9);
    carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
    if (carbs === 0) warnings.push("Protein and minimum fat use up the whole calorie target; carbs set to 0.");
  }
  return { protein: Math.round(protein), carbs: Math.round(carbs), fat: Math.round(fat) };
}

/** Is a proposed manual intake below the safety floor? */
export function checkIntakeAgainstFloor(kcal: number, stats: BodyStats): { ok: boolean; floor: number; warning?: string } {
  const floor = safetyFloor(stats);
  if (kcal < floor) {
    return {
      ok: false,
      floor,
      warning: `${Math.round(kcal)} kcal is below your safety floor of ${floor} kcal (max of BMR and ${ABSOLUTE_FLOOR[stats.sex]}). Very low intakes should be medically supervised.`,
    };
  }
  return { ok: true, floor };
}

/** Pace in lb/week → kg/week. */
export const paceKg = (lb: number) => lbToKg(lb);
