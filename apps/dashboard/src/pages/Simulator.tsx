import { BMI_UNDERWEIGHT, type Units, kgToLb, parseDate, projectWeight, todayIn, weightAtBmi } from "@macro-cache/core";
import { useMemo, useState } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi } from "../api";
import { LegendKey, TooltipBox, axisProps, gridProps, monthTick } from "../components/charts";
import { Card, Field, NumberInput, Segmented, Stat, fmtDate } from "../components/ui";

const ACTUAL = "var(--color-ink-2)";
const PLAN_A = "var(--color-protein)";
const PLAN_B = "var(--color-carbs)";
const GOAL = "var(--color-accent)";

export default function Simulator({ profile }: { profile: any }) {
  const prog = useApi("/api/progress");
  const p = profile.profile;
  const units: Units = p.units;
  const target = profile.targets?.kcal ?? 2000;
  const [months, setMonths] = useState(6);
  const [kcal, setKcal] = useState<number | "">(target);
  const [days, setDays] = useState(7);
  const [compare, setCompare] = useState(false);
  const [kcalB, setKcalB] = useState<number | "">(target + 300);

  const conv = (kg: number) => (units === "imperial" ? kgToLb(kg) : kg);
  const u = units === "imperial" ? "lb" : "kg";
  const startWeight = profile.current_weight_kg ?? p.weightKg;
  const adaptiveTdee = p.maintenanceOverride ?? (profile.adaptive?.ok ? profile.adaptive.blendedTdee : null);

  const run = (intake: number) =>
    projectWeight({
      startDate: todayIn(p.timezone),
      startWeightKg: startWeight,
      heightCm: p.heightCm,
      age: p.age,
      sex: p.sex,
      activity: p.activity,
      intakeKcal: intake,
      months,
      daysOnTargetPerWeek: days,
      adaptiveTdee,
      goalWeightKg: p.goalWeightKg,
    });

  const a = useMemo(() => (kcal === "" ? null : run(kcal)), [kcal, months, days, startWeight, adaptiveTdee]); // eslint-disable-line react-hooks/exhaustive-deps
  const b = useMemo(() => (compare && kcalB !== "" ? run(kcalB) : null), [compare, kcalB, months, days, startWeight, adaptiveTdee]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    const rows = new Map<number, Record<string, number>>();
    const hist = (prog.data?.trend ?? []).slice(-120);
    for (const h of hist) rows.set(parseDate(h.date), { t: parseDate(h.date), actual: conv(h.trendKg) });
    for (const pt of a?.points ?? []) {
      const t = parseDate(pt.date);
      rows.set(t, { ...(rows.get(t) ?? { t }), a: conv(pt.weightKg) });
    }
    for (const pt of b?.points ?? []) {
      const t = parseDate(pt.date);
      rows.set(t, { ...(rows.get(t) ?? { t }), b: conv(pt.weightKg) });
    }
    return [...rows.values()].sort((x, y) => x.t - y.t);
  }, [a, b, prog.data, units]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!a) {
    return (
      <Card title="Projection simulator">
        <Field label="Daily calories">
          <NumberInput value={kcal} onChange={setKcal} />
        </Field>
      </Card>
    );
  }

  const goal = p.goalWeightKg != null ? conv(p.goalWeightKg) : null;
  const bmiFloor = conv(weightAtBmi(BMI_UNDERWEIGHT, p.heightCm));
  const vals = data.flatMap((d) => [d.actual, d.a, d.b].filter((v) => v != null) as number[]).concat(goal != null ? [goal] : []);
  const lo = Math.floor(Math.min(...vals) - 1);
  const hi = Math.ceil(Math.max(...vals) + 1);
  const sign = (n: number) => `${n > 0 ? "+" : ""}${conv(n).toFixed(1)}`;
  const range = (r: { low: number; high: number }) => `${sign(r.low)} to ${sign(r.high)} ${u}`;

  return (
    <>
      <h1 className="text-xl font-semibold">Projection simulator</h1>

      <Card>
        <div className="space-y-4">
          <Field label={`Time horizon: ${months} month${months === 1 ? "" : "s"}`}>
            <input type="range" min={1} max={24} value={months} onChange={(e) => setMonths(Number(e.target.value))} className="w-full" aria-label="Months" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Daily calories" hint={a.belowFloor ? <span className="text-warn">Below your safety floor ({a.floor})</span> : `Target: ${target}`}>
              <NumberInput value={kcal} onChange={setKcal} className={a.belowFloor ? "border-warn" : ""} />
            </Field>
            <Field label="Days/week on target" hint="Off days at maintenance">
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-full rounded-xl border border-line bg-bg px-3 py-2.5">
                {[7, 6, 5, 4, 3, 2, 1, 0].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Compare with another calorie level
          </label>
          {compare && (
            <Field label="Comparison calories" hint={b?.belowFloor ? <span className="text-warn">Below your safety floor ({b.floor})</span> : undefined}>
              <NumberInput value={kcalB} onChange={setKcalB} />
            </Field>
          )}
        </div>
      </Card>

      {(a.warnings.length > 0 || (b?.warnings.length ?? 0) > 0) && (
        <div role="alert" className="rounded-2xl border border-warn/50 bg-warn/10 p-3 text-sm text-ink-2">
          <div className="mb-1 font-semibold text-warn">⚠ Check this plan</div>
          <ul className="list-inside list-disc space-y-0.5">
            {[...new Set([...a.warnings, ...(b?.warnings ?? []).map((w) => `Comparison: ${w}`)])].map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Stat label={`Projected weight · ${months} mo`} value={`${conv(a.endWeightKg).toFixed(1)} ${u}`} sub={b ? `vs ${conv(b.endWeightKg).toFixed(1)} ${u} at ${kcalB} kcal` : undefined} />
        <Stat label="Total change" value={`${sign(a.totalChangeKg)} ${u}`} sub={b ? `vs ${sign(b.totalChangeKg)} ${u}` : undefined} />
        <Stat label="Est. fat change" value={<span className="text-base">{range(a.fatChangeKg)}</span>} />
        <Stat label="Est. lean change" value={<span className="text-base">{range(a.leanChangeKg)}</span>} />
        <div className="col-span-2">
          <Stat
            label="Goal reached"
            value={a.goalReachedDate ? fmtDate(a.goalReachedDate) : p.goalWeightKg ? `Not within ${months} months` : "Set a goal weight"}
            sub={b ? `Comparison: ${b.goalReachedDate ? fmtDate(b.goalReachedDate) : `not within ${months} months`}` : adaptiveTdee ? `Starting from your observed maintenance (${adaptiveTdee} kcal)` : "Starting from the formula estimate"}
          />
        </div>
      </div>

      <Card title="Projected weight">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={monthTick} {...axisProps} minTickGap={28} />
              <YAxis domain={[lo, hi]} {...axisProps} width={44} tickFormatter={(v) => String(Math.round(v))} />
              {bmiFloor > lo && <ReferenceArea y1={lo} y2={Math.min(bmiFloor, hi)} fill="var(--color-warn)" fillOpacity={0.08} />}
              {goal != null && <ReferenceLine y={goal} stroke={GOAL} strokeWidth={1.5} label={{ value: "Goal", position: "insideTopLeft", fill: "var(--color-ink-2)", fontSize: 11 }} />}
              <Tooltip
                cursor={{ stroke: "var(--color-muted)", strokeWidth: 1 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const r = payload[0].payload;
                  return (
                    <TooltipBox
                      title={new Date(r.t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      rows={[
                        ...(r.actual != null ? [{ color: ACTUAL, label: "Actual trend", value: `${r.actual.toFixed(1)} ${u}` }] : []),
                        ...(r.a != null ? [{ color: PLAN_A, label: `${kcal} kcal`, value: `${r.a.toFixed(1)} ${u}` }] : []),
                        ...(r.b != null ? [{ color: PLAN_B, label: `${kcalB} kcal`, value: `${r.b.toFixed(1)} ${u}` }] : []),
                      ]}
                    />
                  );
                }}
              />
              <Line dataKey="actual" stroke={ACTUAL} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              <Line dataKey="a" stroke={PLAN_A} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              {b && <Line dataKey="b" stroke={PLAN_B} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <LegendKey
          items={[
            { color: ACTUAL, label: "Actual trend" },
            { color: PLAN_A, label: `${kcal} kcal/day` },
            ...(b ? [{ color: PLAN_B, label: `${kcalB} kcal/day` }] : []),
            ...(goal != null ? [{ color: GOAL, label: "Goal", kind: "rule" as const }] : []),
            ...(bmiFloor > lo ? [{ color: "var(--color-warn)", label: `BMI < ${BMI_UNDERWEIGHT}`, kind: "dot" as const }] : []),
          ]}
        />
      </Card>

      <p className="px-1 text-center text-xs text-muted">Estimates. Real results vary with water, adherence, and metabolism.</p>
    </>
  );
}
