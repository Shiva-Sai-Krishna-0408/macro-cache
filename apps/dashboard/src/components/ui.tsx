import { type ReactNode, useEffect, useState } from "react";
import { type Units, kgToLb, lbToKg, cmToIn, inToCm } from "@macro-cache/core";

export function Card({ children, className = "", title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-ink-2">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "subtle"; size?: "sm" | "md" };
export function Button({ variant = "ghost", size = "md", className = "", ...p }: BtnProps) {
  const v = {
    primary: "bg-accent text-accent-ink font-semibold hover:brightness-110",
    ghost: "bg-panel-2 text-ink hover:bg-line",
    danger: "bg-danger/15 text-danger hover:bg-danger/25",
    subtle: "bg-transparent text-ink-2 hover:bg-panel-2",
  }[variant];
  const s = size === "sm" ? "px-2.5 py-1.5 text-sm" : "px-4 py-2.5";
  return <button {...p} className={`rounded-xl ${s} ${v} transition disabled:opacity-50 ${className}`} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink placeholder:text-muted focus:border-accent focus:outline-none";

export function NumberInput({ value, onChange, step = "any", min, max, placeholder, className = "" }: { value: number | "" | null | undefined; onChange: (v: number | "") => void; step?: string; min?: number; max?: number; placeholder?: string; className?: string }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      className={`${inputCls} tabular ${className}`}
    />
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-xl bg-bg p-1" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-2 py-1.5 text-sm transition ${value === o.value ? "bg-panel-2 font-semibold text-ink" : "text-muted"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div role="dialog" aria-modal className="safe-bottom max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-line bg-panel p-4 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full px-3 py-1 text-2xl leading-none text-muted hover:bg-panel-2">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Horizontal progress meter: track is a lighter step of the same hue. */
export function MacroBar({ label, value, target, color, unit = "g" }: { label: string; value: number; target: number | null; color: string; unit?: string }) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  const left = target != null ? Math.round(target - value) : null;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="flex items-center gap-2 text-ink-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          {label}
        </span>
        <span className="tabular text-ink">
          {Math.round(value)}
          <span className="text-muted">{target != null ? ` / ${target}${unit}` : unit}</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: `color-mix(in oklab, ${color} 22%, var(--color-panel))` }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      {left != null && <div className="mt-0.5 text-right text-xs text-muted tabular">{left >= 0 ? `${left}${unit} left` : `${-left}${unit} over`}</div>}
    </div>
  );
}

/** Calorie ring: hero number in the middle. */
export function Ring({ value, target, size = 168 }: { value: number; target: number | null; size?: number }) {
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = target ? Math.min(1, value / target) : 0;
  const remaining = target != null ? Math.round(target - value) : null;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="color-mix(in oklab, var(--color-accent) 18%, var(--color-panel))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-accent)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} className="transition-all duration-500" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="tabular text-4xl font-semibold leading-none">{remaining != null ? Math.abs(remaining) : Math.round(value)}</div>
        <div className="mt-1 text-xs text-muted">{remaining == null ? "kcal eaten" : remaining >= 0 ? "kcal left" : "kcal over"}</div>
        {target != null && <div className="tabular mt-1 text-xs text-ink-2">{Math.round(value)} / {target}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl bg-bg p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular mt-0.5 text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

export function Toast({ message, action, onAction, onDone }: { message: string; action?: string; onAction?: () => void; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <div className="fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <div className="flex max-w-md items-center gap-3 rounded-2xl border border-line bg-panel-2 px-4 py-3 text-sm shadow-2xl">
        <span>{message}</span>
        {action && (
          <button className="font-semibold text-accent" onClick={onAction}>
            {action}
          </button>
        )}
      </div>
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{(error as Error).message}</p>;
}

// ---- unit helpers
export const fmtW = (kg: number | null | undefined, units: Units, digits = 1) =>
  kg == null ? "—" : units === "imperial" ? `${(kgToLb(kg)).toFixed(digits)} lb` : `${kg.toFixed(digits)} kg`;
export const wIn = (kg: number | null | undefined, units: Units) => (kg == null ? "" : Math.round((units === "imperial" ? kgToLb(kg) : kg) * 10) / 10);
export const wOut = (v: number, units: Units) => (units === "imperial" ? lbToKg(v) : v);
export const hIn = (cm: number | null | undefined, units: Units) => (cm == null ? "" : Math.round((units === "imperial" ? cmToIn(cm) : cm) * 10) / 10);
export const hOut = (v: number, units: Units) => (units === "imperial" ? inToCm(v) : v);
export const fmtDate = (d: string | null | undefined) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—");

export function useLocalState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV] as const;
}
