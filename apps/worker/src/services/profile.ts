import {
  type Activity,
  type Goal,
  type Sex,
  type Units,
  adaptiveTdee,
  addDays,
  assertValid,
  checkIntakeAgainstFloor,
  computeMacros,
  computeTargets,
  tdeeFormula,
  todayIn,
  trendWeights,
  validateBody,
} from "@macro-cache/core";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { type CalcHistoryItem, logEntry, profile, weightEntry } from "../db/schema";
import { type Ctx, ForbiddenError, Writer, nowIso } from "./context";

export type ProfileRow = typeof profile.$inferSelect;

export async function getProfileRow(ctx: Ctx): Promise<ProfileRow> {
  let row = await ctx.db.select().from(profile).where(eq(profile.id, 1)).get();
  if (!row) {
    await ctx.db.insert(profile).values({ id: 1 }).onConflictDoNothing();
    row = (await ctx.db.select().from(profile).where(eq(profile.id, 1)).get())!;
  }
  return row;
}

export function today(ctx: Ctx, p: Pick<ProfileRow, "timezone">) {
  return todayIn(p.timezone, ctx.now ? ctx.now() : new Date());
}

export function isComplete(p: ProfileRow): p is ProfileRow & { heightCm: number; age: number; sex: Sex; activity: Activity } {
  return p.heightCm != null && p.age != null && p.sex != null && p.activity != null && (p.weightKg != null);
}

/** Latest trend weight, falling back to the profile weight. */
export async function currentWeightKg(ctx: Ctx, p: ProfileRow): Promise<number | null> {
  const ws = await ctx.db.select().from(weightEntry).where(isNull(weightEntry.deletedAt)).orderBy(asc(weightEntry.date)).all();
  const trend = trendWeights(ws.map((w) => ({ date: w.date, weightKg: w.weightKg })));
  return trend.at(-1)?.trendKg ?? p.weightKg ?? null;
}

export async function dailyIntake(ctx: Ctx, from: string, to: string) {
  const rows = await ctx.db
    .select({ date: logEntry.date, kcal: sql<number>`sum(${logEntry.kcal})`, protein: sql<number>`sum(${logEntry.protein})` })
    .from(logEntry)
    .where(and(isNull(logEntry.deletedAt), gte(logEntry.date, from), lte(logEntry.date, to)))
    .groupBy(logEntry.date)
    .all();
  return rows.map((r) => ({ date: r.date, kcal: Number(r.kcal) || 0, protein: Number(r.protein) || 0 }));
}

/** Compute targets for the current profile state (no writes). */
export async function computeProfileTargets(ctx: Ctx, p: ProfileRow, overrides: Partial<ProfileRow> = {}) {
  const merged = { ...p, ...overrides };
  if (!isComplete(merged)) return null;
  const weightKg = overrides.weightKg ?? (await currentWeightKg(ctx, merged)) ?? merged.weightKg!;
  const t = computeTargets({
    weightKg,
    heightCm: merged.heightCm,
    age: merged.age,
    sex: merged.sex,
    activity: merged.activity,
    goal: (merged.goal ?? "maintain") as Goal,
    paceLbPerWeek: merged.paceLbPerWeek ?? 0.5,
    proteinGPerKg: merged.proteinGPerKg,
    maintenanceOverride: merged.maintenanceOverride ?? undefined,
  });
  if (merged.targetOverrideKcal && merged.targetOverrideKcal > 0) {
    const check = checkIntakeAgainstFloor(merged.targetOverrideKcal, { weightKg, heightCm: merged.heightCm, age: merged.age, sex: merged.sex });
    t.kcal = merged.targetOverrideKcal;
    t.macros = computeMacros(t.kcal, weightKg, merged.proteinGPerKg, t.warnings);
    t.warnings.push("Calorie target manually overridden.");
    if (!check.ok) t.warnings.push(check.warning!);
  }
  return { ...t, weightKg };
}

/** Adaptive TDEE suggestion (computed live from the last 28 days). */
export async function adaptiveSuggestion(ctx: Ctx, p: ProfileRow) {
  if (!isComplete(p)) return null;
  const end = today(ctx, p);
  const intake = await dailyIntake(ctx, addDays(end, -27), end);
  const ws = await ctx.db.select().from(weightEntry).where(and(isNull(weightEntry.deletedAt), lte(weightEntry.date, end))).orderBy(asc(weightEntry.date)).all();
  const weightKg = (await currentWeightKg(ctx, p)) ?? p.weightKg!;
  const formula = tdeeFormula({ weightKg, heightCm: p.heightCm, age: p.age, sex: p.sex }, p.activity);
  const r = adaptiveTdee(intake, ws.map((w) => ({ date: w.date, weightKg: w.weightKg })), formula, end);
  const currentMaintenance = p.maintenanceOverride ?? Math.round(formula);
  return {
    ...r,
    formulaTdee: Math.round(formula),
    currentMaintenance,
    differsBy: r.ok ? r.blendedTdee! - currentMaintenance : null,
    shouldPrompt: r.ok && Math.abs(r.blendedTdee! - currentMaintenance) >= 75,
  };
}

export function publicProfile(p: ProfileRow) {
  const { id: _id, ...rest } = p;
  return rest;
}

export async function getProfile(ctx: Ctx) {
  const p = await getProfileRow(ctx);
  const targets = await computeProfileTargets(ctx, p);
  return {
    profile: publicProfile(p),
    complete: isComplete(p),
    current_weight_kg: await currentWeightKg(ctx, p),
    targets,
    adaptive: await adaptiveSuggestion(ctx, p),
    note: "All weights are stored in kg and heights in cm. 'units' controls display only.",
  };
}

export interface ProfileUpdate {
  heightCm?: number;
  weightKg?: number;
  age?: number;
  sex?: Sex;
  activity?: Activity;
  goal?: Goal;
  paceLbPerWeek?: number;
  goalWeightKg?: number | null;
  units?: Units;
  timezone?: string;
  proteinGPerKg?: number;
  targetOverrideKcal?: number | null;
  weeklyBudget?: boolean;
  tradeoffCards?: boolean;
  onboarded?: boolean;
}

function historyItem(at: string, reason: string, t: NonNullable<Awaited<ReturnType<typeof computeProfileTargets>>>): CalcHistoryItem {
  return { at, reason, kcal: t.kcal, protein: t.macros.protein, carbs: t.macros.carbs, fat: t.macros.fat, maintenance: t.maintenance };
}

/** Update profile fields and recompute targets. */
export async function updateProfile(ctx: Ctx, patch: ProfileUpdate, opts: { dryRun?: boolean; tool?: string } = {}) {
  assertValid(validateBody(patch));
  if (patch.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: patch.timezone });
    } catch {
      assertValid({ ok: false, issues: [`Unknown time zone: ${patch.timezone}`] });
    }
  }
  const p = await getProfileRow(ctx);
  const merged = { ...p, ...patch } as ProfileRow;

  if (patch.targetOverrideKcal) {
    if (!isComplete(merged)) assertValid({ ok: false, issues: ["Complete your profile before overriding targets."] });
    const w = (await currentWeightKg(ctx, merged)) ?? merged.weightKg!;
    const check = checkIntakeAgainstFloor(patch.targetOverrideKcal, { weightKg: w, heightCm: merged.heightCm!, age: merged.age!, sex: merged.sex! });
    // Injection mitigation: Claude can never set a below-floor target; only the signed-in dashboard can, with a warning.
    if (!check.ok && ctx.via === "claude")
      throw new ForbiddenError(`${check.warning} A target below the safety floor can only be set by the user in dashboard Settings.`);
  }

  const targets = await computeProfileTargets(ctx, p, patch as Partial<ProfileRow>);
  const preview = { profile: publicProfile(merged), targets };
  if (opts.dryRun) return { dry_run: true, ...preview };

  const w = new Writer(ctx, opts.tool ?? "update_profile", patch);
  const values: Record<string, unknown> = { ...patch };
  if (targets) {
    values.targets = { kcal: targets.kcal, ...targets.macros };
    values.calcHistory = [...(p.calcHistory ?? []), historyItem(nowIso(ctx), "profile update", targets)].slice(-50);
  }
  const row = await w.update<ProfileRow>("profile", 1, values);
  return { profile: publicProfile(row), targets };
}

/** Recompute targets, optionally accepting the adaptive maintenance estimate. */
export async function recalculateTargets(ctx: Ctx, opts: { acceptAdaptive?: boolean; dryRun?: boolean } = {}) {
  const p = await getProfileRow(ctx);
  if (!isComplete(p)) return { ok: false, message: "Profile incomplete: set height, weight, age, sex and activity first." };
  const adaptive = await adaptiveSuggestion(ctx, p);
  const patch: Partial<ProfileRow> = {};
  if (opts.acceptAdaptive) {
    if (!adaptive?.ok) return { ok: false, message: `Adaptive TDEE not available yet: ${adaptive?.reason}`, adaptive };
    patch.maintenanceOverride = adaptive.blendedTdee!;
    patch.adaptive = { acceptedAt: nowIso(ctx), value: adaptive.blendedTdee, observed: adaptive.observedTdee };
  }
  const targets = (await computeProfileTargets(ctx, p, patch))!;
  if (opts.dryRun) return { dry_run: true, targets, adaptive };
  const w = new Writer(ctx, "recalculate_targets", opts);
  await w.update("profile", 1, {
    ...patch,
    targets: { kcal: targets.kcal, ...targets.macros },
    calcHistory: [...(p.calcHistory ?? []), historyItem(nowIso(ctx), opts.acceptAdaptive ? "accepted adaptive TDEE" : "recalculated", targets)].slice(-50),
  });
  return { ok: true, targets, adaptive };
}

/** Target used for day summaries: stored targets, or freshly computed. */
export async function activeTargets(ctx: Ctx, p: ProfileRow) {
  const computed = await computeProfileTargets(ctx, p);
  if (computed) return { kcal: computed.kcal, ...computed.macros, floor: computed.floor, maintenance: computed.maintenance, computed };
  return null;
}
