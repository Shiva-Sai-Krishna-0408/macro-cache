import { type Units, kgToLb, parseDate, todayIn } from "@macro-cache/core";
import { useState } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { api, invalidate, useApi } from "../api";
import { LegendKey, TooltipBox, axisProps, dayTick, gridProps } from "../components/charts";
import { Button, Card, ErrorText, Field, NumberInput, Segmented, Stat, fmtDate, useLocalState, wOut } from "../components/ui";

const DOT = "var(--color-ink-2)";
const TREND = "var(--color-protein)";
const GOAL = "var(--color-accent)";

export default function Progress({ units: profileUnits }: { units: Units }) {
  const prog = useApi("/api/progress");
  const weights = useApi<any[]>("/api/weights");
  const [units, setUnits] = useLocalState<Units>("mc.progressUnits", profileUnits);
  const [range, setRange] = useLocalState<"30" | "90" | "365" | "all">("mc.progressRange", "90");
  const [w, setW] = useState<number | "">("");
  const [bf, setBf] = useState<number | "">("");
  const [error, setError] = useState<unknown>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  const p = prog.data;
  const conv = (kg: number) => (units === "imperial" ? kgToLb(kg) : kg);
  const u = units === "imperial" ? "lb" : "kg";
  const fmt = (kg: number | null | undefined, digits = 1, signed = false) => (kg == null ? "—" : `${signed && kg > 0 ? "+" : ""}${conv(kg).toFixed(digits)} ${u}`);

  async function logWeight() {
    setError(null);
    setWarning(null);
    try {
      const r = await api("/api/weights", { json: { weightKg: wOut(Number(w), units), bodyFatPct: bf === "" ? null : Number(bf), date: todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone) } });
      if (r.warnings?.length) setWarning(r.warnings.join(" "));
      setW("");
      setBf("");
      invalidate();
    } catch (e) {
      setError(e);
    }
  }

  if (!p) return <div className="h-64 animate-pulse rounded-2xl bg-panel" />;

  const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 86400_000;
  const series = p.trend.map((t: any) => ({ t: parseDate(t.date), w: conv(t.weightKg), trend: conv(t.trendKg) })).filter((d: any) => d.t >= cutoff);
  const goal = p.goalWeightKg != null ? conv(p.goalWeightKg) : null;
  const vals = series.flatMap((d: any) => [d.w, d.trend]).concat(goal != null ? [goal] : []);
  const lo = vals.length ? Math.floor(Math.min(...vals) - 1) : 0;
  const hi = vals.length ? Math.ceil(Math.max(...vals) + 1) : 1;

  const losing = p.goal === "lose";
  const changeWord = p.totalChangeKg == null ? "Change" : p.totalChangeKg <= 0 ? "Total lost" : "Total gained";
  const fat = p.fatChange;

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Progress</h1>
        <div className="w-32">
          <Segmented value={units} onChange={setUnits} options={[{ value: "metric", label: "kg" }, { value: "imperial", label: "lb" }]} />
        </div>
      </div>

      <Card>
        <div className="flex items-center justify-between text-center">
          <div>
            <div className="text-xs text-muted">Start</div>
            <div className="tabular text-lg font-semibold">{fmt(p.startWeightKg)}</div>
          </div>
          <div className="text-muted">→</div>
          <div>
            <div className="text-xs text-muted">Trend now</div>
            <div className="tabular text-3xl font-semibold">{fmt(p.currentTrendKg)}</div>
          </div>
          <div className="text-muted">→</div>
          <div>
            <div className="text-xs text-muted">Goal</div>
            <div className="tabular text-lg font-semibold">{fmt(p.goalWeightKg)}</div>
          </div>
        </div>
        {p.percentOfGoal != null && (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full" style={{ background: "color-mix(in oklab, var(--color-accent) 20%, var(--color-panel))" }}>
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${p.percentOfGoal}%` }} />
            </div>
            <div className="mt-1 text-right text-xs text-ink-2 tabular">{Math.round(p.percentOfGoal)}% of the way to your goal</div>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Stat label={changeWord} value={p.totalChangeKg == null ? "—" : fmt(Math.abs(p.totalChangeKg))} sub={p.startDate ? `since ${fmtDate(p.startDate)}` : undefined} />
        <Stat label="Rate (trend, 4 wk)" value={p.ratePerWeekKg == null ? "—" : `${fmt(p.ratePerWeekKg, 2, true)}/wk`} />
        <Stat
          label={losing || (p.totalChangeKg ?? 0) <= 0 ? "Est. fat lost" : "Est. fat gained"}
          value={!fat ? "—" : fat.kind === "measured" ? fmt(Math.abs(fat.kg)) : `${conv(Math.abs(fat.range.high)).toFixed(1)}–${conv(Math.abs(fat.range.low)).toFixed(1)} ${u}`}
          sub={!fat ? "log more weigh-ins" : fat.kind === "measured" ? "from body-fat entries" : (p.totalChangeKg ?? 0) <= 0 ? "estimate: 70–85% of loss, with enough protein + lifting" : "estimate"}
        />
        {p.leanChange && (p.totalChangeKg ?? 0) > 0 ? (
          <Stat label="Est. lean gained" value={p.leanChange.kind === "measured" ? fmt(p.leanChange.kg) : `${conv(p.leanChange.range.low).toFixed(1)}–${conv(p.leanChange.range.high).toFixed(1)} ${u}`} sub="estimate: 30–50% of gain with training" />
        ) : (
          <Stat label="Projected goal date" value={p.projectedGoalDate ? fmtDate(p.projectedGoalDate) : "—"} sub="at your actual trend pace" />
        )}
        <Stat label="Logging streak" value={`${p.streakDays} day${p.streakDays === 1 ? "" : "s"}`} />
        <Stat label="Weekly adherence" value={p.weeklyAdherencePct == null ? "—" : `${p.weeklyAdherencePct}%`} sub="days within ±10% of target" />
      </div>

      <Card
        title="Weight"
        action={
          <div className="w-48">
            <Segmented value={range} onChange={setRange} options={[{ value: "30", label: "1M" }, { value: "90", label: "3M" }, { value: "365", label: "1Y" }, { value: "all", label: "All" }]} />
          </div>
        }
      >
        {series.length ? (
          <>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={dayTick} {...axisProps} minTickGap={24} />
                  <YAxis domain={[lo, hi]} {...axisProps} width={44} tickFormatter={(v) => String(Math.round(v))} />
                  <Tooltip
                    cursor={{ stroke: "var(--color-muted)", strokeWidth: 1 }}
                    content={({ active, payload }) =>
                      active && payload?.length ? (
                        <TooltipBox
                          title={dayTick(payload[0].payload.t)}
                          rows={[
                            { color: DOT, label: "Weigh-in", value: `${payload[0].payload.w.toFixed(1)} ${u}` },
                            { color: TREND, label: "Trend", value: `${payload[0].payload.trend.toFixed(1)} ${u}` },
                          ]}
                        />
                      ) : null
                    }
                  />
                  {goal != null && <ReferenceLine y={goal} stroke={GOAL} strokeWidth={1.5} label={{ value: `Goal ${goal.toFixed(1)}`, position: "insideTopRight", fill: "var(--color-ink-2)", fontSize: 11 }} />}
                  <Scatter dataKey="w" fill={DOT} shape={(props: any) => <circle cx={props.cx} cy={props.cy} r={3.5} fill={DOT} stroke="var(--color-panel)" strokeWidth={2} />} isAnimationActive={false} />
                  <Line dataKey="trend" stroke={TREND} strokeWidth={2} dot={false} strokeLinecap="round" isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <LegendKey items={[{ color: DOT, label: "Weigh-ins", kind: "dot" }, { color: TREND, label: "Trend (smoothed)" }, ...(goal != null ? [{ color: GOAL, label: "Goal", kind: "rule" as const }] : [])]} />
            <button className="mt-2 text-xs text-muted underline" onClick={() => setShowTable(!showTable)}>
              {showTable ? "Hide" : "Show"} data table
            </button>
            {showTable && (
              <table className="mt-2 w-full text-xs tabular">
                <thead className="text-muted">
                  <tr>
                    <th className="text-left font-normal">Date</th>
                    <th className="text-right font-normal">Weigh-in</th>
                    <th className="text-right font-normal">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {[...series].reverse().map((d: any) => (
                    <tr key={d.t}>
                      <td>{dayTick(d.t)}</td>
                      <td className="text-right">{d.w.toFixed(1)}</td>
                      <td className="text-right">{d.trend.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">Log your first weigh-in below.</p>
        )}
      </Card>

      <Card title="Log weigh-in">
        <div className="grid grid-cols-2 gap-2">
          <Field label={`Weight (${u})`}>
            <NumberInput value={w} onChange={setW} />
          </Field>
          <Field label="Body fat % (optional)">
            <NumberInput value={bf} onChange={setBf} />
          </Field>
        </div>
        {warning && <p className="mt-2 rounded-xl bg-warn/10 p-2 text-sm text-ink-2">{warning}</p>}
        <ErrorText error={error} />
        <Button variant="primary" className="mt-3 w-full" disabled={w === ""} onClick={logWeight}>
          Save weigh-in
        </Button>
        <p className="mt-2 text-xs text-muted">Weigh daily if you can, same time, same conditions. The trend line smooths out water swings.</p>
      </Card>

      {weights.data && weights.data.length > 0 && (
        <Card title="Recent weigh-ins">
          <ul className="divide-y divide-line text-sm">
            {[...weights.data].reverse().slice(0, 10).map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2">
                <span>{fmtDate(e.date)}</span>
                <span className="flex items-center gap-2 tabular">
                  {fmt(e.weightKg)}
                  {e.bodyFatPct != null && <span className="text-muted">{e.bodyFatPct}%</span>}
                  <button aria-label="Delete weigh-in" className="rounded-lg px-2 text-muted hover:text-danger" onClick={async () => (await api(`/api/weights/${e.id}`, { method: "DELETE" }), invalidate())}>
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
