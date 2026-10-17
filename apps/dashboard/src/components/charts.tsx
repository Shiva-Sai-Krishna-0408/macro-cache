import type { ReactNode } from "react";

/** Shared chart styling: recessive axes/grid, text in ink tokens (never series colors). */
export const axisProps = {
  stroke: "var(--color-line)",
  tick: { fill: "var(--color-muted)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--color-line)" },
} as const;

export const gridProps = { stroke: "var(--color-line)", strokeOpacity: 0.6, vertical: false } as const;

export const dayTick = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const monthTick = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { month: "short" })} ’${String(d.getFullYear()).slice(2)}`;
};

export function TooltipBox({ title, rows }: { title: ReactNode; rows: { color?: string; label: string; value: ReactNode }[] }) {
  return (
    <div className="rounded-xl border border-line bg-panel-2 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-ink-2">
          {r.color && <span className="inline-block h-2 w-2 rounded-full" style={{ background: r.color }} />}
          <span>{r.label}</span>
          <span className="ml-auto pl-3 tabular text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function LegendKey({ items }: { items: { color: string; label: string; kind?: "line" | "dot" | "rule" }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          {i.kind === "dot" ? (
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: i.color }} />
          ) : (
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: i.color, opacity: i.kind === "rule" ? 0.8 : 1 }} />
          )}
          {i.label}
        </span>
      ))}
    </div>
  );
}
