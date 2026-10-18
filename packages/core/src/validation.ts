import { kcalFromMacros, type Nutrients } from "./nutrition";

/**
 * Server-side plausibility checks. These run on EVERY write regardless of
 * who asked for it, so a malicious menu page or label photo cannot get absurd
 * values stored even if it convinces the model to try.
 */

export const LIMITS = {
  kcalPer100gMax: 900, // pure fat is ~900 kcal/100g
  sodiumMgPer100gMax: 40_000, // table salt is ~39,000 mg/100g
  macroSumTolerance: 2, // grams per 100 g, for label rounding
  kcalMismatchFraction: 0.15,
  kcalMismatchAbs: 15, // small foods: allow ±15 kcal absolute
  entryKcalMax: 5000,
  entryGramsMax: 5000,
  servingsMax: 50,
  nameMax: 120,
  textMax: 500,
  notesMax: 5000, // recipe steps / notes
  urlsMax: 5,
  aliasesMax: 20,
  ingredientsMax: 60,
  templateItemsMax: 30,
} as const;

export class ValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(" "));
    this.name = "ValidationError";
  }
}

export interface ValidationResult {
  ok: boolean;
  issues: string[];
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkKcalConsistency(n: Nutrients, issues: string[], label: string, alcoholG = 0) {
  if (!(n.kcal > 0)) return;
  const fiber = n.fiber ?? 0;
  // US labels count fiber inside carbs at ~2 kcal/g, EU labels list it separately: accept either convention.
  const expectedA = kcalFromMacros(n, alcoholG);
  const expectedB = kcalFromMacros({ ...n, carbs: Math.max(0, n.carbs - fiber) }, alcoholG) + fiber * 2;
  const off = (e: number) => Math.abs(n.kcal - e) > Math.max(LIMITS.kcalMismatchAbs, LIMITS.kcalMismatchFraction * Math.max(n.kcal, e));
  if (off(expectedA) && off(expectedB)) {
    issues.push(
      `${label}: ${Math.round(n.kcal)} kcal is inconsistent with its macros (4/4/9 gives ~${Math.round(expectedA)} kcal; >15% apart). Re-check the label.`,
    );
  }
}

function checkNonNegative(n: Nutrients, issues: string[], label: string) {
  for (const k of ["kcal", "protein", "carbs", "fat", "fiber", "sugar", "sodiumMg"] as const) {
    const v = n[k];
    if (v == null) continue;
    if (!fin(v)) issues.push(`${label}: ${k} must be a finite number.`);
    else if (v < 0) issues.push(`${label}: ${k} cannot be negative.`);
  }
}

/** Validate per-100 g nutrients for a food or recipe. */
export function validatePer100g(n: Nutrients, opts: { alcoholG?: number; label?: string } = {}): ValidationResult {
  const issues: string[] = [];
  const label = opts.label ?? "Per 100 g";
  checkNonNegative(n, issues, label);
  if (issues.length) return { ok: false, issues };
  if (n.kcal > LIMITS.kcalPer100gMax) issues.push(`${label}: ${n.kcal} kcal/100g exceeds the physical maximum of ${LIMITS.kcalPer100gMax}.`);
  const macroSum = n.protein + n.carbs + n.fat + (opts.alcoholG ?? 0);
  if (macroSum > 100 + LIMITS.macroSumTolerance) issues.push(`${label}: protein + carbs + fat = ${macroSum.toFixed(1)} g, which exceeds 100 g.`);
  if ((n.sugar ?? 0) > n.carbs + LIMITS.macroSumTolerance) issues.push(`${label}: sugar (${n.sugar} g) cannot exceed total carbs (${n.carbs} g).`);
  if ((n.sodiumMg ?? 0) > LIMITS.sodiumMgPer100gMax) issues.push(`${label}: sodium ${n.sodiumMg} mg/100g is implausible.`);
  checkKcalConsistency(n, issues, label, opts.alcoholG);
  return { ok: issues.length === 0, issues };
}

/** Validate absolute nutrients for one eaten item (log entry / restaurant order). */
export function validateEntryNutrients(n: Nutrients, opts: { grams?: number | null; label?: string } = {}): ValidationResult {
  const issues: string[] = [];
  const label = opts.label ?? "Entry";
  checkNonNegative(n, issues, label);
  if (issues.length) return { ok: false, issues };
  if (n.kcal > LIMITS.entryKcalMax) issues.push(`${label}: ${Math.round(n.kcal)} kcal in one entry exceeds the ${LIMITS.entryKcalMax} kcal limit. Split it into separate entries.`);
  if (opts.grams != null) {
    if (!(opts.grams > 0) || opts.grams > LIMITS.entryGramsMax) issues.push(`${label}: weight must be between 0 and ${LIMITS.entryGramsMax} g.`);
    const macroSum = n.protein + n.carbs + n.fat;
    if (macroSum > opts.grams * (1 + LIMITS.macroSumTolerance / 100) + 0.5)
      issues.push(`${label}: protein + carbs + fat (${macroSum.toFixed(1)} g) exceed the item's weight (${opts.grams} g).`);
  }
  checkKcalConsistency(n, issues, label);
  return { ok: issues.length === 0, issues };
}

export function validateAmount(amount: number, unit: "g" | "serving" | "portion"): ValidationResult {
  const issues: string[] = [];
  if (!fin(amount) || amount <= 0) issues.push("Amount must be a positive number.");
  else if (unit === "g" && amount > LIMITS.entryGramsMax) issues.push(`Amount ${amount} g exceeds the ${LIMITS.entryGramsMax} g limit for one entry.`);
  else if (unit !== "g" && amount > LIMITS.servingsMax) issues.push(`Amount ${amount} ${unit}s exceeds the ${LIMITS.servingsMax} limit for one entry.`);
  return { ok: issues.length === 0, issues };
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip control characters and trim; enforce a max length. */
export function cleanText(s: string, max: number = LIMITS.textMax): string {
  return s.replace(CONTROL, "").trim().slice(0, max);
}

/** Only plain http(s) URLs are accepted as source links. */
export function validateUrls(urls: string[] | undefined | null): ValidationResult {
  const issues: string[] = [];
  if (!urls) return { ok: true, issues };
  if (urls.length > LIMITS.urlsMax) issues.push(`At most ${LIMITS.urlsMax} source URLs.`);
  for (const u of urls) {
    try {
      const p = new URL(u);
      if (p.protocol !== "https:" && p.protocol !== "http:") issues.push(`Source URL must be http(s): ${u.slice(0, 80)}`);
    } catch {
      issues.push(`Invalid source URL: ${String(u).slice(0, 80)}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertValid(...results: ValidationResult[]): void {
  const issues = results.flatMap((r) => r.issues);
  if (issues.length) throw new ValidationError(issues);
}

export function validateBody(input: { heightCm?: number; weightKg?: number; age?: number; goalWeightKg?: number | null }): ValidationResult {
  const issues: string[] = [];
  if (input.heightCm != null && !(input.heightCm >= 100 && input.heightCm <= 250)) issues.push("Height must be between 100 and 250 cm.");
  if (input.weightKg != null && !(input.weightKg >= 30 && input.weightKg <= 350)) issues.push("Weight must be between 30 and 350 kg.");
  if (input.goalWeightKg != null && !(input.goalWeightKg >= 30 && input.goalWeightKg <= 350)) issues.push("Goal weight must be between 30 and 350 kg.");
  if (input.age != null && !(Number.isInteger(input.age) && input.age >= 13 && input.age <= 100)) issues.push("Age must be a whole number between 13 and 100.");
  return { ok: issues.length === 0, issues };
}
