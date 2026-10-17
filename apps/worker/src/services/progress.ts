import {
  addDays,
  assertValid,
  computeProgress,
  isISODate,
  projectWeight,
  rankByProteinDensity,
  suggestMealsForRemaining,
  tradeoffCard,
  daysBetween,
  type Candidate,
} from "@macro-cache/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import { container, food, recipe, restaurantOrder, weightEntry } from "../db/schema";
import { type Ctx, Writer } from "./context";
import { getDaySummary } from "./logging";
import { activeTargets, adaptiveSuggestion, currentWeightKg, dailyIntake, getProfileRow, isComplete, today } from "./profile";

export type WeightRow = typeof weightEntry.$inferSelect;

export async function logWeight(ctx: Ctx, input: { weightKg: number; date?: string; bodyFatPct?: number | null }, opts: { dryRun?: boolean } = {}) {
  const issues: string[] = [];
  if (!(input.weightKg >= 30 && input.weightKg <= 350)) issues.push("Weight must be between 30 and 350 kg.");
  if (input.bodyFatPct != null && !(input.bodyFatPct >= 3 && input.bodyFatPct <= 70)) issues.push("Body-fat % must be between 3 and 70.");
  const p = await getProfileRow(ctx);
  const date = input.date ?? today(ctx, p);
  if (!isISODate(date)) issues.push(`Invalid date: ${date}`);
  if (date > addDays(today(ctx, p), 1)) issues.push("Cannot log a weight in the future.");
  assertValid({ ok: issues.length === 0, issues });

  const existing = await ctx.db.select().from(weightEntry).where(and(eq(weightEntry.date, date), isNull(weightEntry.deletedAt))).get();
  // Sudden jumps are usually unit mistakes (lb entered as kg).
  const prevKg = await currentWeightKg(ctx, p);
  const warnings: string[] = [];
  if (prevKg && Math.abs(input.weightKg - prevKg) / prevKg > 0.1) warnings.push(`This is ${Math.round(Math.abs(input.weightKg - prevKg) * 10) / 10} kg away from your trend weight. Was it entered in the right units (kg)?`);
  const values = { date, weightKg: input.weightKg, bodyFatPct: input.bodyFatPct ?? null };
  if (opts.dryRun) return { dry_run: true, action: existing ? "update" : "create", entry: values, warnings };
  const w = new Writer(ctx, "log_weight", input);
  const row = existing ? await w.update<WeightRow>("weightEntry", existing.id, values) : await w.insert<WeightRow>("weightEntry", values);
  return { entry: { id: row.id, date: row.date, weight_kg: row.weightKg, body_fat_pct: row.bodyFatPct }, warnings };
}

export async function deleteWeight(ctx: Ctx, id: number) {
  const w = new Writer(ctx, "delete_weight", { id });
  await w.softDelete("weightEntry", id);
  return { deleted: id };
}

export async function listWeights(ctx: Ctx) {
  return ctx.db.select().from(weightEntry).where(isNull(weightEntry.deletedAt)).orderBy(asc(weightEntry.date)).all();
}

/** Progress — same numbers the dashboard shows. */
export async function getProgress(ctx: Ctx) {
  const p = await getProfileRow(ctx);
  const t = today(ctx, p);
  const weights = await listWeights(ctx);
  const dayTotals = await dailyIntake(ctx, addDays(t, -365), t);
  const targets = await activeTargets(ctx, p);
  const progress = computeProgress({
    today: t,
    weights: weights.map((w) => ({ date: w.date, weightKg: w.weightKg, bodyFatPct: w.bodyFatPct })),
    dayTotals,
    goalWeightKg: p.goalWeightKg,
    targetKcal: targets?.kcal ?? null,
    profileWeightKg: p.weightKg,
  });
  return { today: t, units: p.units, goal: p.goal, ...progress, adaptive: await adaptiveSuggestion(ctx, p) };
}

export interface ProjectInput {
  months: number;
  intakeKcal?: number;
  daysOnTargetPerWeek?: number;
  compareIntakeKcal?: number;
}

/** Projection — same engine as the dashboard slider. */
export async function projectProgress(ctx: Ctx, input: ProjectInput) {
  const p = await getProfileRow(ctx);
  if (!isComplete(p)) return { ok: false, message: "Profile incomplete." };
  const targets = await activeTargets(ctx, p);
  const startWeightKg = (await currentWeightKg(ctx, p)) ?? p.weightKg!;
  const adaptive = await adaptiveSuggestion(ctx, p);
  const adaptiveTdee = p.maintenanceOverride ?? (adaptive?.ok ? adaptive.blendedTdee! : null);
  const base = {
    startDate: today(ctx, p),
    startWeightKg,
    heightCm: p.heightCm,
    age: p.age,
    sex: p.sex,
    activity: p.activity,
    months: input.months,
    daysOnTargetPerWeek: input.daysOnTargetPerWeek ?? 7,
    adaptiveTdee,
    goalWeightKg: p.goalWeightKg,
  };
  const intake = input.intakeKcal ?? targets!.kcal;
  const summarize = (r: ReturnType<typeof projectWeight>) => ({
    ...r,
    points: r.points.map((pt) => ({ ...pt, weightKg: Math.round(pt.weightKg * 100) / 100 })),
  });
  const primary = summarize(projectWeight({ ...base, intakeKcal: intake }));
  const comparison = input.compareIntakeKcal ? summarize(projectWeight({ ...base, intakeKcal: input.compareIntakeKcal })) : null;
  return {
    ok: true,
    units: p.units,
    intake_kcal: intake,
    compare_intake_kcal: input.compareIntakeKcal ?? null,
    used_adaptive_tdee: adaptiveTdee,
    primary,
    comparison,
    disclaimer: "Estimates. Real results vary with water, adherence, and metabolism.",
  };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

async function candidates(ctx: Ctx): Promise<Candidate[]> {
  const foods = await ctx.db.select().from(food).where(isNull(food.deletedAt)).all();
  const recipes = await ctx.db.select().from(recipe).where(and(isNull(recipe.deletedAt), eq(recipe.isCurrent, true))).all();
  const orders = await ctx.db.select().from(restaurantOrder).where(isNull(restaurantOrder.deletedAt)).all();
  const cs = await ctx.db.select().from(container).where(and(isNull(container.deletedAt), isNull(container.finishedAt))).all();
  const recipeById = new Map((await ctx.db.select().from(recipe).all()).map((r) => [r.id, r]));
  return [
    ...cs.filter((c) => c.portionsLeft > 0 && recipeById.has(c.recipeId)).map((c) => ({ kind: "container" as const, id: c.id, name: `${c.label ?? recipeById.get(c.recipeId)!.name} (container, ${Math.round(c.portionsLeft * 10) / 10} left)`, per100: recipeById.get(c.recipeId)!, portionG: c.portionG })),
    ...foods.map((f) => ({ kind: "food" as const, id: f.id, name: f.brand ? `${f.name} (${f.brand})` : f.name, per100: f, portionG: f.servingSizeG })),
    ...recipes.map((r) => ({ kind: "recipe" as const, id: r.id, name: r.name, per100: r, portionG: r.portionG })),
    ...orders.map((o) => ({ kind: "restaurant_order" as const, id: o.id, name: `${o.item} @ ${o.restaurant}`, perUnit: o })),
  ];
}

export async function rankByProteinDensityTool(ctx: Ctx, limit = 15) {
  return { ranked: rankByProteinDensity(await candidates(ctx), limit), unit: "grams of protein per 100 kcal" };
}

export async function suggestMeals(ctx: Ctx, input: { date?: string; limit?: number } = {}) {
  const day = await getDaySummary(ctx, input.date);
  if (!day.target || !day.remaining || day.floor == null) return { ok: false, message: "Set up your profile first so targets exist." };
  return {
    ok: true,
    date: day.date,
    ...suggestMealsForRemaining({ remaining: day.remaining, consumedKcal: day.totals.kcal, floor: day.floor, candidates: await candidates(ctx), limit: input.limit ?? 5 }),
  };
}

export async function tradeoff(ctx: Ctx, input: { chosen: { kcal: number; protein: number }; best: { kcal: number; protein: number }; timesPerWeek?: number; date?: string }) {
  const p = await getProfileRow(ctx);
  const day = await getDaySummary(ctx, input.date);
  const t = await activeTargets(ctx, p);
  const prog = await getProgress(ctx);
  const deficit = t ? Math.max(0, t.maintenance - t.kcal) : 0;
  const daysToGoal = prog.projectedGoalDate ? daysBetween(prog.today, prog.projectedGoalDate) : null;
  return tradeoffCard({
    chosen: input.chosen,
    best: input.best,
    remainingKcal: day.remaining?.kcal ?? 0,
    remainingProtein: day.remaining?.protein ?? 0,
    dailyDeficitKcal: deficit,
    daysToGoal,
    timesPerWeek: input.timesPerWeek,
  });
}
