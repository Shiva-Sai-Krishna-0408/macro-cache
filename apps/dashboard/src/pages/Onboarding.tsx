import {
  ACTIVITY_LABELS,
  type Activity,
  GAIN_PACES_LB,
  type Goal,
  LOSS_PACES_LB,
  type Sex,
  type Units,
  computeTargets,
  maxLossPaceLb,
  projectWeight,
  todayIn,
} from "@macro-cache/core";
import { useMemo, useState } from "react";
import { api, invalidate } from "../api";
import { Button, ErrorText, Field, NumberInput, Segmented, fmtDate, fmtW, hIn, hOut, wIn, wOut } from "../components/ui";

const STEPS = ["Units", "About you", "Body", "Activity", "Goal", "Your plan"];

export default function Onboarding({ initial, currentWeightKg, onDone, onCancel }: { initial: any; currentWeightKg: number | null; onDone: () => void; onCancel?: () => void }) {
  const [step, setStep] = useState(0);
  const [units, setUnits] = useState<Units>(initial.units ?? "metric");
  const [sex, setSex] = useState<Sex>(initial.sex ?? "female");
  const [age, setAge] = useState<number | "">(initial.age ?? "");
  const [heightCm, setHeightCm] = useState<number | null>(initial.heightCm ?? null);
  const [weightKg, setWeightKg] = useState<number | null>(currentWeightKg ?? initial.weightKg ?? null);
  const [activity, setActivity] = useState<Activity>(initial.activity ?? "light");
  const [goal, setGoal] = useState<Goal>(initial.goal ?? "lose");
  const [goalWeightKg, setGoalWeightKg] = useState<number | null>(initial.goalWeightKg ?? null);
  const [pace, setPace] = useState<number>(initial.paceLbPerWeek ?? 0.5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ready = age !== "" && heightCm && weightKg;
  const plan = useMemo(() => {
    if (!ready) return null;
    const stats = { weightKg: weightKg!, heightCm: heightCm!, age: Number(age), sex };
    const t = computeTargets({ ...stats, activity, goal, paceLbPerWeek: pace });
    const proj =
      goal !== "maintain" && goalWeightKg
        ? projectWeight({ ...stats, activity, startDate: todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone), startWeightKg: weightKg!, intakeKcal: t.kcal, months: 24, goalWeightKg })
        : null;
    return { t, proj };
  }, [ready, weightKg, heightCm, age, sex, activity, goal, pace, goalWeightKg]);

  const stepValid = [true, age !== "" && Number(age) >= 13 && Number(age) <= 100, !!heightCm && !!weightKg, true, goal === "maintain" || !!goalWeightKg, true][step];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api("/api/profile", { method: "PUT", json: { units, sex, age: Number(age), heightCm, weightKg, activity, goal, goalWeightKg: goal === "maintain" ? null : goalWeightKg, paceLbPerWeek: goal === "maintain" ? 0 : pace, timezone, onboarded: true } });
      if (!initial.onboarded || (currentWeightKg && Math.abs(currentWeightKg - weightKg!) > 0.05) || !currentWeightKg) await api("/api/weights", { json: { weightKg } });
      invalidate();
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  const paces = goal === "lose" ? LOSS_PACES_LB : GAIN_PACES_LB;
  const lossCap = weightKg ? maxLossPaceLb(weightKg) : 1;
  const paceLabel = (lb: number) => (units === "imperial" ? `${lb} lb/wk` : `${(lb * 0.4536).toFixed(2)} kg/wk`);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col p-4" style={{ paddingTop: "max(env(safe-area-inset-top), 16px)" }}>
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>
            Step {step + 1} of {STEPS.length} · {STEPS[step]}
          </span>
          {onCancel && (
            <button onClick={onCancel} className="text-ink-2">
              Cancel
            </button>
          )}
        </div>
        <div className="flex gap-1">
          {STEPS.map((s, i) => (
            <div key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-accent" : "bg-line"}`} />
          ))}
        </div>
      </div>

      <div className="flex-1 space-y-4">
        {step === 0 && (
          <>
            <h1 className="text-2xl font-semibold">Welcome to macro-cache</h1>
            <p className="text-ink-2">A few questions to set your maintenance calories and daily targets. You can change any of this later.</p>
            <Field label="Units">
              <Segmented value={units} onChange={setUnits} options={[{ value: "metric", label: "Metric (kg, cm)" }, { value: "imperial", label: "Imperial (lb, in)" }]} />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="text-2xl font-semibold">About you</h1>
            <Field label="Sex (used by the BMR formula)">
              <Segmented value={sex} onChange={setSex} options={[{ value: "female", label: "Female" }, { value: "male", label: "Male" }]} />
            </Field>
            <Field label="Age" hint={age !== "" && Number(age) < 18 ? "Under 18: targets are maintenance only. Please talk to a doctor before trying to change your weight." : undefined}>
              <NumberInput value={age} onChange={setAge} step="1" min={13} max={100} />
            </Field>
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="text-2xl font-semibold">Height & weight</h1>
            <Field label={`Height (${units === "imperial" ? "inches" : "cm"})`} hint={units === "imperial" ? "e.g. 5′10″ = 70 in" : undefined}>
              <NumberInput value={hIn(heightCm, units)} onChange={(v) => setHeightCm(v === "" ? null : hOut(v, units))} />
            </Field>
            <Field label={`Current weight (${units === "imperial" ? "lb" : "kg"})`}>
              <NumberInput value={wIn(weightKg, units)} onChange={(v) => setWeightKg(v === "" ? null : wOut(v, units))} />
            </Field>
          </>
        )}
        {step === 3 && (
          <>
            <h1 className="text-2xl font-semibold">Activity level</h1>
            <div className="space-y-2">
              {(Object.keys(ACTIVITY_LABELS) as Activity[]).map((a) => (
                <button key={a} onClick={() => setActivity(a)} className={`w-full rounded-xl border p-3 text-left ${activity === a ? "border-accent bg-accent/10" : "border-line bg-panel"}`}>
                  {ACTIVITY_LABELS[a]}
                </button>
              ))}
            </div>
          </>
        )}
        {step === 4 && (
          <>
            <h1 className="text-2xl font-semibold">Your goal</h1>
            <Segmented value={goal} onChange={(g) => (setGoal(g), setPace(g === "gain" ? 0.25 : 0.5))} options={[{ value: "lose", label: "Lose" }, { value: "maintain", label: "Maintain" }, { value: "gain", label: "Gain" }]} />
            {goal !== "maintain" && (
              <>
                <Field label={`Goal weight (${units === "imperial" ? "lb" : "kg"})`}>
                  <NumberInput value={wIn(goalWeightKg, units)} onChange={(v) => setGoalWeightKg(v === "" ? null : wOut(v, units))} />
                </Field>
                <Field label="Pace" hint={goal === "lose" ? `Capped at ~1% of body weight per week (${paceLabel(Math.round(lossCap * 100) / 100)} for you).` : "Slow gains keep more of it lean."}>
                  <div className="grid grid-cols-2 gap-2">
                    {paces.map((p) => {
                      const capped = goal === "lose" && p > lossCap + 1e-9;
                      return (
                        <button key={p} onClick={() => setPace(p)} className={`rounded-xl border p-3 text-sm ${pace === p ? "border-accent bg-accent/10" : "border-line bg-panel"}`}>
                          {paceLabel(p)}
                          {capped && <span className="block text-xs text-muted">capped</span>}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              </>
            )}
          </>
        )}
        {step === 5 && plan && (
          <>
            <h1 className="text-2xl font-semibold">Your plan</h1>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-panel p-3">
                <div className="text-xs text-muted">Maintenance calories</div>
                <div className="tabular text-2xl font-semibold">{plan.t.maintenance}</div>
              </div>
              <div className="rounded-xl bg-panel p-3">
                <div className="text-xs text-muted">Daily target</div>
                <div className="tabular text-2xl font-semibold text-accent">{plan.t.kcal}</div>
              </div>
              <div className="col-span-2 rounded-xl bg-panel p-3 text-sm">
                <div className="mb-1 text-xs text-muted">Macros</div>
                <span className="tabular">
                  Protein {plan.t.macros.protein} g · Carbs {plan.t.macros.carbs} g · Fat {plan.t.macros.fat} g
                </span>
              </div>
              {goal !== "maintain" && (
                <div className="col-span-2 rounded-xl bg-panel p-3">
                  <div className="text-xs text-muted">Projected goal date</div>
                  <div className="text-lg font-semibold">{plan.proj?.goalReachedDate ? fmtDate(plan.proj.goalReachedDate) : "Beyond 24 months at this pace"}</div>
                  <div className="text-xs text-muted">
                    {fmtW(weightKg, units)} → {fmtW(goalWeightKg, units)} · estimate, slows as you get closer
                  </div>
                </div>
              )}
            </div>
            {plan.t.warnings.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm text-ink-2">
                {plan.t.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted">Safety floor: {plan.t.floor} kcal. macro-cache never sets or suggests intake below it. This is an estimate, not medical advice.</p>
            <ErrorText error={error} />
          </>
        )}
      </div>

      <div className="safe-bottom mt-6 flex gap-2">
        {step > 0 && (
          <Button onClick={() => setStep(step - 1)} className="flex-1">
            Back
          </Button>
        )}
        {step < STEPS.length - 1 ? (
          <Button variant="primary" disabled={!stepValid} onClick={() => setStep(step + 1)} className="flex-1">
            Continue
          </Button>
        ) : (
          <Button variant="primary" disabled={saving} onClick={save} className="flex-1">
            {saving ? "Saving…" : "Start tracking"}
          </Button>
        )}
      </div>
    </div>
  );
}
