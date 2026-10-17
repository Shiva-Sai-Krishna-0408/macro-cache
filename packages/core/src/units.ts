export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
/** Energy in one pound of body-weight change (classic approximation). */
export const KCAL_PER_LB = 3500;
/** Energy in one kilogram of body-weight change. */
export const KCAL_PER_KG = 7700;

export type Units = "metric" | "imperial";

export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const inToCm = (inch: number) => inch * CM_PER_IN;
export const cmToIn = (cm: number) => cm / CM_PER_IN;

export function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Display a weight stored in kg in the user's units. */
export function displayWeight(kg: number, units: Units, digits = 1): string {
  return units === "imperial" ? `${round(kgToLb(kg), digits)} lb` : `${round(kg, digits)} kg`;
}

export function bmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

/** Weight (kg) at a given BMI for a height. */
export function weightAtBmi(bmiValue: number, heightCm: number): number {
  const m = heightCm / 100;
  return bmiValue * m * m;
}
