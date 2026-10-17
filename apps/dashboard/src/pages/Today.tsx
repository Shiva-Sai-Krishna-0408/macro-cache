import { addDays, todayIn } from "@macro-cache/core";
import { useState } from "react";
import { api, invalidate, useApi } from "../api";
import { Button, Card, MacroBar, Ring, Toast } from "../components/ui";
import type { LogPreset } from "./LogSheet";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
const label = (m: string) => m[0].toUpperCase() + m.slice(1);

export default function Today({ profile, onLog }: { profile: any; onLog: (p: LogPreset) => void }) {
  const tz = profile.profile.timezone;
  const today = todayIn(tz);
  const [date, setDate] = useState(today);
  const day = useApi(`/api/day?date=${date}`);
  const [toast, setToast] = useState<string | null>(null);
  const adaptive = profile.adaptive;

  async function act(fn: () => Promise<unknown>, msg: string) {
    try {
      await fn();
      invalidate();
      setToast(msg);
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  const undo = () => act(() => api("/api/undo", { method: "POST", json: {} }), "Undone");

  const d = day.data;
  const dateLabel = date === today ? "Today" : date === addDays(today, -1) ? "Yesterday" : new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  return (
    <>
      <div className="flex items-center justify-between">
        <Button variant="subtle" size="sm" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
          ‹
        </Button>
        <button className="font-semibold" onClick={() => setDate(today)}>
          {dateLabel}
        </button>
        <Button variant="subtle" size="sm" onClick={() => setDate(addDays(date, 1))} disabled={date >= today} aria-label="Next day">
          ›
        </Button>
      </div>

      {adaptive?.shouldPrompt && (
        <Card className="border-accent/40">
          <p className="text-sm">
            Based on your last {adaptive.windowDays} days of logs and weigh-ins, your maintenance looks closer to <strong className="tabular">{adaptive.blendedTdee} kcal</strong> (currently {adaptive.currentMaintenance}).
          </p>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={() => act(() => api("/api/profile/recalculate", { json: { acceptAdaptive: true } }).then(() => api("/api/profile")), "Targets updated")}>
              Update my targets
            </Button>
          </div>
        </Card>
      )}

      <Card>
        {d ? (
          <div className="flex flex-col items-center gap-5 sm:flex-row">
            <Ring value={d.totals.kcal} target={d.target?.kcal ?? null} />
            <div className="w-full flex-1 space-y-3">
              <MacroBar label="Protein" value={d.totals.protein} target={d.target?.protein ?? null} color="var(--color-protein)" />
              <MacroBar label="Carbs" value={d.totals.carbs} target={d.target?.carbs ?? null} color="var(--color-carbs)" />
              <MacroBar label="Fat" value={d.totals.fat} target={d.target?.fat ?? null} color="var(--color-fat)" />
            </div>
          </div>
        ) : (
          <div className="h-44 animate-pulse rounded-xl bg-panel-2" />
        )}
        {d?.weekly && (
          <div className="mt-4 rounded-xl bg-bg p-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Weekly budget</span>
              <span className="tabular">
                {d.weekly.consumed_kcal} / {d.weekly.budget_kcal} kcal
              </span>
            </div>
            <div className="text-xs text-ink-2 tabular">{d.weekly.remaining_kcal >= 0 ? `${d.weekly.remaining_kcal} kcal left this week` : `${-d.weekly.remaining_kcal} kcal over this week`}</div>
          </div>
        )}
      </Card>

      {d?.containers?.length > 0 && (
        <Card title="Meal-prep containers">
          <ul className="space-y-2">
            {d.containers.map((c: any) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded-xl bg-bg p-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.label ?? c.recipe_name}</div>
                  <div className="text-xs text-muted tabular">
                    {c.portions_left} of {c.portions_total} left · {c.per_portion?.kcal} kcal, {c.per_portion?.protein} g P per portion
                  </div>
                </div>
                <Button size="sm" variant="primary" onClick={() => act(() => api(`/api/containers/${c.id}/use`, { json: { portions: 1, meal: guessMeal(), date } }), `Logged 1 portion of ${c.label}`)}>
                  Eat 1
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {MEALS.map((m) => {
        const meal = d?.meals?.[m];
        return (
          <Card
            key={m}
            title={
              <span className="block min-w-0">
                {label(m)}
                {meal?.totals.kcal ? <span className="block truncate text-xs font-normal text-muted tabular">{`${meal.totals.kcal} kcal · ${Math.round(meal.totals.protein)} g protein`}</span> : null}
              </span>
            }
            action={
              <div className="flex shrink-0 gap-1 whitespace-nowrap">
                {!meal?.entries.length && (
                  <Button size="sm" variant="subtle" aria-label="Repeat yesterday's meal" title="Repeat yesterday's meal" onClick={() => act(() => api("/api/log/copy-meal", { json: { fromDate: addDays(date, -1), meal: m, toDate: date } }), `Repeated yesterday's ${m}`)}>
                    ↻ Yesterday
                  </Button>
                )}
                {meal?.entries.length > 0 && (
                  <Button
                    size="sm"
                    variant="subtle"
                    aria-label="Save as template"
                    title="Save this meal as a template"
                    onClick={() => {
                      const name = prompt("Template name", `${label(m)} usual`);
                      if (name) void act(() => api("/api/templates", { json: { name, fromDate: date, fromMeal: m } }), "Template saved");
                    }}
                  >
                    ☆ Template
                  </Button>
                )}
                <Button size="sm" onClick={() => onLog({ meal: m, date })}>
                  + Add
                </Button>
              </div>
            }
          >
            {meal?.entries.length ? (
              <ul className="divide-y divide-line">
                {meal.entries.map((e: any) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="truncate">{e.name}</div>
                      <div className="text-xs text-muted tabular">
                        {e.unit === "g" ? `${Math.round(e.amount)} g` : `${e.amount} ${e.unit}${e.amount === 1 ? "" : "s"}`} · P {Math.round(e.nutrients.protein)} · C {Math.round(e.nutrients.carbs)} · F {Math.round(e.nutrients.fat)}
                        {e.created_via === "claude" && " · via Claude"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="tabular text-sm">{e.nutrients.kcal}</span>
                      <button aria-label={`Delete ${e.name}`} className="rounded-lg px-2 py-1 text-muted hover:bg-danger/15 hover:text-danger" onClick={() => act(() => api(`/api/log/${e.id}`, { method: "DELETE" }), "Entry deleted")}>
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nothing logged.</p>
            )}
          </Card>
        );
      })}

      {toast && <Toast message={toast} action={toast !== "Undone" ? "Undo" : undefined} onAction={undo} onDone={() => setToast(null)} />}
    </>
  );
}

export function guessMeal(): (typeof MEALS)[number] {
  const h = new Date().getHours();
  return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 21 ? "dinner" : "snack";
}
