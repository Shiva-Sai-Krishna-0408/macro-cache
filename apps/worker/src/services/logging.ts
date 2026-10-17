import {
  type FullNutrients,
  LIMITS,
  addDays,
  assertValid,
  cleanText,
  forGrams,
  isISODate,
  roundNutrients,
  scale,
  sum,
  validateAmount,
  validateEntryNutrients,
  weekStart,
} from "@macro-cache/core";
import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { MEALS, type TemplateItemJson, logEntry, template } from "../db/schema";
import { type Ctx, NotFoundError, Writer } from "./context";
import { getFoodRow } from "./foods";
import { activeTargets, getProfileRow, today } from "./profile";
import { activeContainers, getContainerRow, getRecipeRow, getRestaurantRow } from "./recipes";

export type Meal = (typeof MEALS)[number];
export type LogRow = typeof logEntry.$inferSelect;

export type LogRef =
  | { type: "food"; id: number }
  | { type: "recipe"; id: number }
  | { type: "container"; id: number }
  | { type: "restaurant_order"; id: number }
  | {
      type: "adhoc";
      name: string;
      nutrients: { kcal: number; protein: number; carbs: number; fat: number; fiber?: number | null; sugar?: number | null; sodiumMg?: number | null };
      grams?: number | null;
    };

export interface LogItem {
  ref: LogRef;
  amount?: number;
  unit?: "g" | "serving" | "portion";
  meal: Meal;
  date?: string;
}

interface Resolved {
  row: Omit<typeof logEntry.$inferInsert, "createdVia">;
  containerUpdate?: { id: number; portionsLeft: number; finished: boolean };
  warnings: string[];
}

export function entryView(e: LogRow) {
  return {
    id: e.id,
    date: e.date,
    meal: e.meal,
    name: e.name,
    ref_type: e.refType,
    ref_id: e.refId,
    amount: e.amount,
    unit: e.unit,
    grams: e.grams,
    nutrients: roundNutrients(e),
    created_via: e.createdVia,
  };
}

/** Turn a log request into a concrete entry with a macro snapshot. Pure validation + reads. */
async function resolveItem(ctx: Ctx, item: LogItem, defaultDate: string, pendingContainer: Map<number, number>): Promise<Resolved> {
  const date = item.date ?? defaultDate;
  if (!isISODate(date)) assertValid({ ok: false, issues: [`Invalid date: ${date}`] });
  if (!MEALS.includes(item.meal)) assertValid({ ok: false, issues: [`Meal must be one of ${MEALS.join(", ")}.`] });
  const warnings: string[] = [];
  const ref = item.ref;
  let name: string;
  let grams: number | null = null;
  let n: FullNutrients;
  let amount = item.amount;
  let unit = item.unit;
  let refId: number | null = null;
  let containerUpdate: Resolved["containerUpdate"];

  switch (ref.type) {
    case "food": {
      const f = await getFoodRow(ctx, ref.id);
      refId = f.id;
      name = f.brand ? `${f.name} (${f.brand})` : f.name;
      unit ??= f.servingSizeG ? "serving" : "g";
      amount ??= unit === "g" ? 100 : 1;
      assertValid(validateAmount(amount, unit));
      if (unit === "g") grams = amount;
      else {
        if (!f.servingSizeG) assertValid({ ok: false, issues: [`${f.name} has no serving size; log it in grams.`] });
        grams = amount * f.servingSizeG!;
      }
      n = forGrams(f, grams);
      break;
    }
    case "recipe":
    case "container": {
      let portionG: number | null;
      let r;
      if (ref.type === "container") {
        const c = await getContainerRow(ctx, ref.id);
        r = await getRecipeRow(ctx, c.recipeId);
        portionG = c.portionG;
        refId = c.id;
        unit ??= "portion";
        amount ??= 1;
        assertValid(validateAmount(amount, unit));
        grams = unit === "g" ? amount : amount * portionG;
        const left = pendingContainer.get(c.id) ?? c.portionsLeft;
        const used = grams / portionG;
        if (used > left + 1e-6) warnings.push(`Container "${c.label}" only had ${Math.round(left * 100) / 100} portions left; set to 0.`);
        const newLeft = Math.max(0, Math.round((left - used) * 1000) / 1000);
        pendingContainer.set(c.id, newLeft);
        containerUpdate = { id: c.id, portionsLeft: newLeft, finished: newLeft <= 0 };
      } else {
        r = await getRecipeRow(ctx, ref.id);
        portionG = r.portionG;
        refId = r.id;
        unit ??= portionG ? "portion" : "g";
        amount ??= unit === "g" ? 100 : 1;
        assertValid(validateAmount(amount, unit));
        if (unit === "g") grams = amount;
        else {
          if (!portionG) assertValid({ ok: false, issues: [`Recipe ${r.name} has no portion size; log it in grams.`] });
          grams = amount * portionG!;
        }
      }
      name = r.name;
      n = forGrams(r, grams);
      break;
    }
    case "restaurant_order": {
      const o = await getRestaurantRow(ctx, ref.id);
      refId = o.id;
      name = `${o.item} @ ${o.restaurant}`;
      unit = "serving";
      amount ??= 1;
      assertValid(validateAmount(amount, unit));
      n = scale(o, amount);
      break;
    }
    case "adhoc": {
      name = cleanText(ref.name, LIMITS.nameMax) || "Quick add";
      unit = "serving";
      amount ??= 1;
      assertValid(validateAmount(amount, unit), validateEntryNutrients(ref.nutrients, { grams: ref.grams ?? null, label: name }));
      grams = ref.grams != null ? ref.grams * amount : null;
      n = scale(ref.nutrients, amount);
      break;
    }
  }

  assertValid(validateEntryNutrients(n, { label: name }));
  const r = roundNutrients(n, 2);
  return {
    row: { date, meal: item.meal, refType: ref.type, refId, name, amount, unit, grams, ...r },
    containerUpdate,
    warnings,
  };
}

/** Log one or more items (a multi-item meal is one undo batch). */
export async function logFood(ctx: Ctx, items: LogItem[], opts: { dryRun?: boolean; tool?: string; date?: string } = {}) {
  if (!items.length) assertValid({ ok: false, issues: ["Nothing to log."] });
  if (items.length > LIMITS.templateItemsMax) assertValid({ ok: false, issues: [`At most ${LIMITS.templateItemsMax} items per call.`] });
  const p = await getProfileRow(ctx);
  const defaultDate = opts.date ?? today(ctx, p);
  const pending = new Map<number, number>();
  const resolved: Resolved[] = [];
  for (const it of items) resolved.push(await resolveItem(ctx, it, defaultDate, pending));

  const total = roundNutrients(sum(resolved.map((r) => r.row as FullNutrients)));
  const warnings = resolved.flatMap((r) => r.warnings);
  if (opts.dryRun) {
    const date = resolved[0].row.date;
    const day = await getDaySummary(ctx, date);
    return {
      dry_run: true,
      entries: resolved.map((r) => ({ ...r.row, nutrients: roundNutrients(r.row as FullNutrients) })),
      total,
      warnings,
      day_after: day.target ? { kcal: Math.round(day.totals.kcal + total.kcal), protein: Math.round(day.totals.protein + total.protein), target_kcal: day.target.kcal, target_protein: day.target.protein } : null,
    };
  }

  const w = new Writer(ctx, opts.tool ?? "log_food", items);
  const created: LogRow[] = [];
  for (const r of resolved) {
    created.push(await w.insert<LogRow>("logEntry", { ...r.row, createdVia: ctx.via }));
  }
  // Apply final container counts once per container.
  const finalCounts = new Map<number, Resolved["containerUpdate"]>();
  for (const r of resolved) if (r.containerUpdate) finalCounts.set(r.containerUpdate.id, r.containerUpdate);
  for (const cu of finalCounts.values()) {
    await w.update("container", cu!.id, { portionsLeft: cu!.portionsLeft, finishedAt: cu!.finished ? new Date().toISOString() : null });
  }
  const day = await getDaySummary(ctx, created[0].date);
  return { logged: created.map(entryView), total, warnings, today: day.status_line };
}

export async function deleteEntry(ctx: Ctx, id: number, opts: { dryRun?: boolean } = {}) {
  const e = await ctx.db.select().from(logEntry).where(eq(logEntry.id, id)).get();
  if (!e || e.deletedAt) throw new NotFoundError(`Log entry ${id}`);
  if (opts.dryRun) return { dry_run: true, would_delete: entryView(e) };
  const w = new Writer(ctx, "delete_entry", { id });
  await w.softDelete("logEntry", id);
  // Return the portion to its container.
  if (e.refType === "container" && e.refId && e.grams) {
    const c = await getContainerRow(ctx, e.refId).catch(() => null);
    if (c) await w.update("container", c.id, { portionsLeft: Math.min(c.portionsTotal, c.portionsLeft + e.grams / c.portionG), finishedAt: null });
  }
  return { deleted: entryView(e) };
}

export async function entriesForDate(ctx: Ctx, date: string) {
  return ctx.db.select().from(logEntry).where(and(eq(logEntry.date, date), isNull(logEntry.deletedAt))).orderBy(asc(logEntry.id)).all();
}

export async function getDaySummary(ctx: Ctx, date?: string) {
  const p = await getProfileRow(ctx);
  const d = date ?? today(ctx, p);
  if (!isISODate(d)) assertValid({ ok: false, issues: [`Invalid date: ${d}`] });
  const entries = await entriesForDate(ctx, d);
  const totals = roundNutrients(sum(entries));
  const t = await activeTargets(ctx, p);
  const meals = Object.fromEntries(
    MEALS.map((m) => {
      const es = entries.filter((e) => e.meal === m);
      return [m, { entries: es.map(entryView), totals: roundNutrients(sum(es)) }];
    }),
  );
  const target = t ? { kcal: t.kcal, protein: t.protein, carbs: t.carbs, fat: t.fat } : null;
  const remaining = target
    ? { kcal: Math.round(target.kcal - totals.kcal), protein: Math.round(target.protein - totals.protein), carbs: Math.round(target.carbs - totals.carbs), fat: Math.round(target.fat - totals.fat) }
    : null;

  let weekly = null;
  if (p.weeklyBudget && target) {
    const ws = weekStart(d);
    const rows = await ctx.db.select().from(logEntry).where(and(isNull(logEntry.deletedAt), gte(logEntry.date, ws), lte(logEntry.date, addDays(ws, 6)))).all();
    const consumed = Math.round(rows.reduce((a, r) => a + r.kcal, 0));
    weekly = { week_start: ws, budget_kcal: target.kcal * 7, consumed_kcal: consumed, remaining_kcal: target.kcal * 7 - consumed };
  }

  const status_line = target
    ? `Today: ${totals.kcal} / ${target.kcal} kcal · ${Math.round(totals.protein)} / ${target.protein} g protein`
    : `Today: ${totals.kcal} kcal · ${Math.round(totals.protein)} g protein (set up your profile for targets)`;

  return { date: d, target, totals, remaining, floor: t?.floor ?? null, meals, weekly, containers: await activeContainers(ctx), status_line };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateRow = typeof template.$inferSelect;

export async function saveTemplate(ctx: Ctx, input: { name: string; items?: TemplateItemJson[]; fromDate?: string; fromMeal?: Meal }, opts: { dryRun?: boolean } = {}) {
  const name = cleanText(input.name, LIMITS.nameMax);
  if (!name) assertValid({ ok: false, issues: ["Template name is required."] });
  let items = input.items ?? [];
  if (!items.length && input.fromDate) {
    const es = (await entriesForDate(ctx, input.fromDate)).filter((e) => !input.fromMeal || e.meal === input.fromMeal);
    items = es.map((e) => entryToTemplateItem(e));
  }
  if (!items.length) assertValid({ ok: false, issues: ["A template needs at least one item (or a from_date with entries)."] });
  if (items.length > LIMITS.templateItemsMax) assertValid({ ok: false, issues: [`At most ${LIMITS.templateItemsMax} items.`] });
  // Validate by dry-resolving each item.
  const p = await getProfileRow(ctx);
  for (const it of items) await resolveItem(ctx, templateItemToLogItem(it, it.meal ?? "snack"), today(ctx, p), new Map());
  if (opts.dryRun) return { dry_run: true, template: { name, items } };
  const w = new Writer(ctx, "save_template", input);
  const row = await w.insert<TemplateRow>("template", { name, items });
  return { template: { id: row.id, name: row.name, items: row.items } };
}

function entryToTemplateItem(e: LogRow): TemplateItemJson {
  if (e.refType === "adhoc" || e.refType === "container" || !e.refId) {
    // Containers run out; store a snapshot instead.
    return { refType: "adhoc", amount: 1, unit: "serving", meal: e.meal, name: e.name, adhoc: { kcal: e.kcal, protein: e.protein, carbs: e.carbs, fat: e.fat } };
  }
  return { refType: e.refType, refId: e.refId, amount: e.amount, unit: e.unit, meal: e.meal, name: e.name };
}

function templateItemToLogItem(it: TemplateItemJson, meal: Meal, date?: string): LogItem {
  const ref: LogRef =
    it.refType === "adhoc"
      ? { type: "adhoc", name: it.name ?? "Quick add", nutrients: it.adhoc ?? { kcal: 0, protein: 0, carbs: 0, fat: 0 } }
      : ({ type: it.refType, id: it.refId! } as LogRef);
  return { ref, amount: it.refType === "adhoc" ? 1 : it.amount, unit: it.refType === "adhoc" ? "serving" : it.unit, meal, date };
}

export async function listTemplates(ctx: Ctx) {
  return (await ctx.db.select().from(template).where(isNull(template.deletedAt)).orderBy(desc(template.id)).all()).map((t) => ({ id: t.id, name: t.name, items: t.items }));
}

export async function logTemplate(ctx: Ctx, input: { templateId: number; date?: string; meal?: Meal }, opts: { dryRun?: boolean } = {}) {
  const t = await ctx.db.select().from(template).where(eq(template.id, input.templateId)).get();
  if (!t || t.deletedAt) throw new NotFoundError(`Template ${input.templateId}`);
  const items = t.items.map((it) => templateItemToLogItem(it, input.meal ?? it.meal ?? "snack", input.date));
  return logFood(ctx, items, { dryRun: opts.dryRun, tool: "log_template", date: input.date });
}

export async function deleteTemplate(ctx: Ctx, id: number) {
  const w = new Writer(ctx, "delete_template", { id });
  await w.softDelete("template", id);
  return { deleted: id };
}

/** Re-log a meal from another day (dashboard "repeat yesterday"). */
export async function copyMeal(ctx: Ctx, input: { fromDate: string; meal: Meal; toDate?: string }, opts: { dryRun?: boolean } = {}) {
  const es = (await entriesForDate(ctx, input.fromDate)).filter((e) => e.meal === input.meal);
  if (!es.length) return { logged: [], message: `No ${input.meal} entries on ${input.fromDate}.` };
  const items = es.map((e) => templateItemToLogItem(entryToTemplateItem(e), input.meal, input.toDate));
  return logFood(ctx, items, { dryRun: opts.dryRun, tool: "copy_meal", date: input.toDate });
}

export async function recentEntries(ctx: Ctx, limit = 30) {
  const rows = await ctx.db.select().from(logEntry).where(isNull(logEntry.deletedAt)).orderBy(desc(logEntry.id)).limit(200).all();
  const seen = new Set<string>();
  const out: ReturnType<typeof entryView>[] = [];
  for (const r of rows) {
    const key = `${r.refType}:${r.refId ?? r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entryView(r));
    if (out.length >= limit) break;
  }
  return out;
}

/** Eat (and by default log) portions from a meal-prep container. */
export async function useContainerPortion(
  ctx: Ctx,
  input: { containerId: number; portions?: number; meal?: Meal; date?: string; log?: boolean },
  opts: { dryRun?: boolean } = {},
) {
  const portions = input.portions ?? 1;
  if (input.log !== false) {
    return logFood(ctx, [{ ref: { type: "container", id: input.containerId }, amount: portions, unit: "portion", meal: input.meal ?? "lunch", date: input.date }], {
      dryRun: opts.dryRun,
      tool: "use_container_portion",
    });
  }
  assertValid(validateAmount(portions, "portion"));
  const c = await getContainerRow(ctx, input.containerId);
  const left = Math.max(0, Math.round((c.portionsLeft - portions) * 1000) / 1000);
  if (opts.dryRun) return { dry_run: true, container_id: c.id, portions_left: left };
  const w = new Writer(ctx, "use_container_portion", input);
  await w.update("container", c.id, { portionsLeft: left, finishedAt: left <= 0 ? new Date().toISOString() : null });
  return { container_id: c.id, portions_left: left, logged: false };
}
