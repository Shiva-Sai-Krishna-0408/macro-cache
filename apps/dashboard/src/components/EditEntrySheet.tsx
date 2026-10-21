import { todayIn } from "@macro-cache/core";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { Button, ErrorText, Field, NumberInput, Segmented, Sheet, inputCls } from "./ui";

type Meal = "breakfast" | "lunch" | "dinner" | "snack";
type Unit = "g" | "serving" | "portion";
type RefKind = "food" | "recipe" | "container" | "restaurant_order";
interface Swap {
  kind: RefKind;
  id: number;
  name: string;
}
interface Target {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

const UNIT_LABEL: Record<Unit, string> = { g: "grams", serving: "servings", portion: "portions" };
const step = (unit: Unit, amount: number) => (unit === "g" ? (amount >= 200 ? 25 : 10) : 0.5);

/**
 * Edit a logged entry: amount stepper, food swap, meal slot, date. Every change
 * is previewed with a server dry-run (same math + validation as saving), so the
 * totals shown are exactly what Save will produce.
 */
export default function EditEntrySheet({ entryId, target, onClose, onDone }: { entryId: number; target: Target | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [loaded, setLoaded] = useState<any>(null);
  const [swap, setSwap] = useState<Swap | null>(null);
  const [amount, setAmount] = useState<number | "">("");
  const [unit, setUnit] = useState<Unit | null>(null);
  const [meal, setMeal] = useState<Meal>("lunch");
  const [date, setDate] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [picking, setPicking] = useState(false);
  const [unitOptions, setUnitOptions] = useState<Unit[] | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    api(`/api/log/${entryId}`)
      .then((r) => {
        setLoaded(r);
        setAmount(r.entry.amount);
        setUnit(r.entry.unit);
        setMeal(r.entry.meal);
        setDate(r.entry.date);
      })
      .catch(setError);
  }, [entryId]);

  const e = loaded?.entry;
  const unchanged = e && !swap && amount === e.amount && unit === e.unit && meal === e.meal && date === e.date;

  const patchBody = () => ({
    ...(swap ? { [`${swap.kind}_id`]: swap.id } : {}),
    ...(amount !== "" && unit ? { amount, unit } : {}),
    meal,
    date,
  });

  // Live preview (debounced dry-run).
  useEffect(() => {
    if (!e || unchanged || amount === "" || Number(amount) <= 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/log/${entryId}`, { method: "PATCH", json: { ...patchBody(), dryRun: true } });
        if (mine !== seq.current) return;
        setPreview(r);
        setPreviewError(null);
      } catch (err) {
        if (mine !== seq.current) return;
        setPreview(null);
        setPreviewError(err as ApiError);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [e, swap, amount, unit, meal, date]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/log/${entryId}`, { method: "PATCH", json: patchBody() });
      onDone("Entry updated");
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api(`/api/log/${entryId}`, { method: "DELETE" });
      onDone("Entry deleted");
    } catch (err) {
      setError(err);
    }
  }

  function pickSwap(s: Swap & { defaultUnit?: Unit; defaultAmount?: number; units: Unit[] }) {
    setSwap({ kind: s.kind, id: s.id, name: s.name });
    const firstUnit = s.defaultUnit ?? s.units[0];
    setUnitOptions(s.units);
    setUnit(firstUnit);
    setAmount(s.defaultAmount ?? (firstUnit === "g" ? 100 : 1));
    setPicking(false);
  }
  const units: Unit[] = unitOptions ?? loaded?.unit_options ?? [];

  if (!e) {
    return (
      <Sheet open onClose={onClose} title="Edit entry">
        {error ? <ErrorText error={error} /> : <div className="h-40 animate-pulse rounded-xl bg-panel-2" />}
      </Sheet>
    );
  }

  const shown = preview?.after?.nutrients ?? e.nutrients;
  const dayTotals = preview?.day_after?.totals;
  const a = amount === "" ? 0 : Number(amount);
  const u: Unit = unit ?? e.unit;

  return (
    <Sheet open onClose={onClose} title="Edit entry">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{swap?.name ?? e.name}</div>
            {swap && <div className="text-xs text-muted">was {e.name}</div>}
          </div>
          <Button size="sm" onClick={() => setPicking(!picking)}>
            {picking ? "Cancel" : "Change food"}
          </Button>
        </div>

        {picking ? (
          <SwapPicker onPick={pickSwap} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <button aria-label="Decrease" className="h-12 w-12 shrink-0 rounded-xl bg-panel-2 text-2xl" onClick={() => setAmount(Math.max(step(u, a), Math.round((a - step(u, a)) * 100) / 100))}>
                −
              </button>
              <NumberInput value={amount} onChange={setAmount} className="text-center text-lg" />
              <button aria-label="Increase" className="h-12 w-12 shrink-0 rounded-xl bg-panel-2 text-2xl" onClick={() => setAmount(Math.round((a + step(u, a)) * 100) / 100)}>
                +
              </button>
            </div>
            {units.length > 1 && (
              <Segmented
                value={u}
                onChange={(nu) => {
                  setUnit(nu);
                  setAmount(nu === "g" ? 100 : 1);
                }}
                options={units.map((x) => ({ value: x, label: UNIT_LABEL[x] }))}
              />
            )}
            {units.length <= 1 && <p className="-mt-2 text-xs text-muted">{UNIT_LABEL[u]}</p>}

            <Field label="Meal">
              <Segmented value={meal} onChange={setMeal} options={(["breakfast", "lunch", "dinner", "snack"] as Meal[]).map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} />
            </Field>
            <Field label="Date">
              <input type="date" value={date} max={todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone)} onChange={(ev) => ev.target.value && setDate(ev.target.value)} className={inputCls} />
            </Field>

            <div className="rounded-2xl bg-bg p-3">
              <div className="grid grid-cols-4 gap-2 text-center">
                {(
                  [
                    ["kcal", shown.kcal, ""],
                    ["Protein", shown.protein, "g"],
                    ["Carbs", shown.carbs, "g"],
                    ["Fat", shown.fat, "g"],
                  ] as const
                ).map(([l, v, unitLabel]) => (
                  <div key={l}>
                    <div className="tabular text-lg font-semibold">
                      {Math.round(v)}
                      {unitLabel}
                    </div>
                    <div className="text-xs text-muted">{l}</div>
                  </div>
                ))}
              </div>
              {preview && (
                <p className="mt-2 text-center text-xs text-ink-2 tabular">
                  {preview.delta.kcal >= 0 ? "+" : ""}
                  {preview.delta.kcal} kcal · {preview.delta.protein >= 0 ? "+" : ""}
                  {preview.delta.protein} g protein vs before
                </p>
              )}
              {dayTotals && (
                <div className="mt-2 border-t border-line pt-2 text-center text-sm tabular">
                  <span className="text-muted">{preview.day_after.date === e.date ? "Day after edit" : `${preview.day_after.date} after move`}: </span>
                  {dayTotals.kcal}
                  {target ? ` / ${target.kcal}` : ""} kcal · {Math.round(dayTotals.protein)}
                  {target ? ` / ${target.protein}` : ""} g protein
                </div>
              )}
              {preview?.containers?.length > 0 && <p className="mt-1 text-center text-xs text-muted">Container portions left after save: {preview.containers.map((c: any) => c.portions_left).join(", ")}</p>}
            </div>
            {previewError && (
              <ul role="alert" className="space-y-1 rounded-xl border border-warn/50 bg-warn/10 p-3 text-sm text-ink-2">
                {(previewError.body?.issues ?? [previewError.message]).map((i: string) => (
                  <li key={i}>⚠ {i}</li>
                ))}
              </ul>
            )}
          </>
        )}

        <ErrorText error={error} />
        {!picking && (
          <div className="flex gap-2">
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
            <Button variant="primary" className="flex-1" disabled={saving || !!unchanged || !!previewError || a <= 0 || (!preview && !unchanged)} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Search foods / recipes / containers / restaurant orders to swap the entry to. */
function SwapPicker({ onPick }: { onPick: (s: Swap & { defaultUnit?: Unit; defaultAmount?: number; units: Unit[] }) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<(Swap & { sub: string; defaultUnit?: Unit; units: Unit[] })[]>([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      const enc = encodeURIComponent(q.trim());
      const [foods, recipes, orders, containers] = await Promise.all([
        q.trim() ? api(`/api/foods/search?q=${enc}`).then((r) => r.results) : api("/api/foods/recent"),
        api(`/api/recipes${q.trim() ? `?q=${enc}` : ""}`),
        q.trim() ? api(`/api/restaurant-orders?q=${enc}`) : Promise.resolve([]),
        q.trim() ? Promise.resolve([]) : api("/api/containers"),
      ]);
      setItems([
        ...containers.map((c: any) => ({ kind: "container" as const, id: c.id, name: c.label ?? c.recipe_name, sub: `Container · ${c.portions_left} left`, units: ["portion", "g"] as Unit[], defaultUnit: "portion" as Unit })),
        ...recipes.slice(0, 8).map((r: any) => ({ kind: "recipe" as const, id: r.id, name: r.name, sub: "Recipe", units: (r.portion_g ? ["portion", "g"] : ["g"]) as Unit[] })),
        ...foods.slice(0, 15).map((f: any) => ({ kind: "food" as const, id: f.id, name: f.brand ? `${f.name} (${f.brand})` : f.name, sub: `${f.per_100g.kcal} kcal/100 g`, units: (f.serving_size_g ? ["serving", "g"] : ["g"]) as Unit[] })),
        ...orders.map((o: any) => ({ kind: "restaurant_order" as const, id: o.id, name: `${o.item} @ ${o.restaurant}`, sub: `${o.nutrients.kcal} kcal`, units: ["serving"] as Unit[] })),
      ]);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-2">
      <input autoFocus placeholder="Search foods, recipes, containers…" value={q} onChange={(e) => setQ(e.target.value)} className={inputCls} />
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {items.map((it) => (
          <li key={`${it.kind}-${it.id}`}>
            <button className="flex w-full items-center justify-between gap-2 py-2.5 text-left" onClick={() => onPick(it)}>
              <span className="min-w-0 truncate">{it.name}</span>
              <span className="shrink-0 text-xs text-muted">{it.sub}</span>
            </button>
          </li>
        ))}
        {!items.length && <li className="py-6 text-center text-sm text-muted">No matches.</li>}
      </ul>
    </div>
  );
}
