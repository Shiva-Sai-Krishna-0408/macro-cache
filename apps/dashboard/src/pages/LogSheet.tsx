import { forGrams, roundNutrients, todayIn } from "@macro-cache/core";
import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { api, invalidate, useApi } from "../api";
import { Button, ErrorText, Field, NumberInput, Segmented, Sheet, inputCls } from "../components/ui";
import { guessMeal } from "./Today";

const BarcodeScanner = lazy(() => import("../components/BarcodeScanner"));

type Meal = "breakfast" | "lunch" | "dinner" | "snack";
export interface LogPreset {
  meal?: Meal;
  date?: string;
}

/** Something that can be logged, normalized across foods, recipes, containers, orders. */
interface Pickable {
  kind: "food" | "recipe" | "container" | "restaurant_order";
  id: number;
  name: string;
  sub?: string;
  per100?: { kcal: number; protein: number; carbs: number; fat: number };
  servingG?: number | null;
  perUnit?: { kcal: number; protein: number; carbs: number; fat: number };
  favorite?: boolean;
  defaultAmount?: number;
  defaultUnit?: "g" | "serving" | "portion";
}

const fromFood = (f: any): Pickable => ({ kind: "food", id: f.id, name: f.name, sub: f.brand ?? undefined, per100: f.per_100g, servingG: f.serving_size_g, favorite: f.favorite });
const fromRecipe = (r: any): Pickable => ({ kind: "recipe", id: r.id, name: r.name, sub: "Recipe", per100: r.per_100g, servingG: r.portion_g });
const fromOrder = (o: any): Pickable => ({ kind: "restaurant_order", id: o.id, name: o.item, sub: o.restaurant, perUnit: o.nutrients });

type Tab = "search" | "recent" | "favorites" | "templates" | "scan" | "manual" | "quick";
const TABS: { value: Tab; label: string }[] = [
  { value: "search", label: "Search" },
  { value: "recent", label: "Recent" },
  { value: "favorites", label: "★" },
  { value: "templates", label: "Templates" },
  { value: "scan", label: "Scan" },
  { value: "manual", label: "New" },
  { value: "quick", label: "Quick" },
];

export default function LogSheet({ preset, onClose }: { preset: LogPreset; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("search");
  const [meal, setMeal] = useState<Meal>(preset.meal ?? guessMeal());
  const date = preset.date ?? todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [picked, setPicked] = useState<Pickable | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const logged = (msg: string) => {
    invalidate();
    setPicked(null);
    setDone(msg);
  };

  return (
    <Sheet open onClose={onClose} title="Log food">
      <div className="mb-3">
        <Segmented value={meal} onChange={setMeal} options={(["breakfast", "lunch", "dinner", "snack"] as Meal[]).map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} />
      </div>
      {done && (
        <div className="mb-3 flex items-center justify-between rounded-xl bg-accent/10 p-3 text-sm">
          <span>{done}</span>
          <button className="font-semibold text-accent" onClick={onClose}>
            Done
          </button>
        </div>
      )}
      {picked ? (
        <AmountPicker item={picked} meal={meal} date={date} onBack={() => setPicked(null)} onLogged={logged} />
      ) : (
        <>
          <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto pb-1">
            {TABS.map((t) => (
              <button key={t.value} onClick={() => setTab(t.value)} className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${tab === t.value ? "bg-accent text-accent-ink font-semibold" : "bg-panel-2 text-ink-2"}`}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === "search" && <SearchTab onPick={setPicked} />}
          {tab === "recent" && <RecentTab meal={meal} date={date} onLogged={logged} />}
          {tab === "favorites" && <FavoritesTab onPick={setPicked} />}
          {tab === "templates" && <TemplatesTab meal={meal} date={date} onLogged={logged} />}
          {tab === "scan" && <ScanTab onPick={setPicked} onNotFound={() => setTab("manual")} />}
          {tab === "manual" && <ManualFoodTab onCreated={(f) => setPicked(fromFood(f))} />}
          {tab === "quick" && <QuickAddTab meal={meal} date={date} onLogged={logged} />}
        </>
      )}
    </Sheet>
  );
}

function ResultList({ items, onPick }: { items: Pickable[]; onPick: (p: Pickable) => void }) {
  if (!items.length) return <p className="py-6 text-center text-sm text-muted">No matches.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((p) => {
        const n = p.perUnit ?? (p.per100 && p.servingG ? forGrams(p.per100, p.servingG) : p.per100);
        return (
          <li key={`${p.kind}-${p.id}`}>
            <button className="flex w-full items-center justify-between gap-3 py-2.5 text-left" onClick={() => onPick(p)}>
              <div className="min-w-0">
                <div className="truncate">{p.name}</div>
                <div className="truncate text-xs text-muted">
                  {[p.sub, p.perUnit ? "per order" : p.servingG ? `per ${Math.round(p.servingG)} g` : "per 100 g"].filter(Boolean).join(" · ")}
                </div>
              </div>
              {n && (
                <div className="shrink-0 text-right text-xs tabular">
                  <div className="text-sm">{Math.round(n.kcal)} kcal</div>
                  <div className="text-muted">{Math.round(n.protein)} g P</div>
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SearchTab({ onPick }: { onPick: (p: Pickable) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Pickable[]>([]);
  const containers = useApi<any[]>("/api/containers");
  useEffect(() => {
    const ctl = setTimeout(async () => {
      if (!q.trim()) {
        const [recent, recipes] = await Promise.all([api("/api/foods/recent"), api("/api/recipes")]);
        setItems([...recipes.slice(0, 5).map(fromRecipe), ...recent.slice(0, 15).map(fromFood)]);
        return;
      }
      const enc = encodeURIComponent(q);
      const [foods, recipes, orders] = await Promise.all([api(`/api/foods/search?q=${enc}`), api(`/api/recipes?q=${enc}`), api(`/api/restaurant-orders?q=${enc}`)]);
      setItems([...recipes.map(fromRecipe), ...foods.results.map(fromFood), ...orders.map(fromOrder)]);
    }, 200);
    return () => clearTimeout(ctl);
  }, [q]);
  return (
    <div className="space-y-3">
      <input autoFocus placeholder="Search your foods, recipes, orders…" value={q} onChange={(e) => setQ(e.target.value)} className={inputCls} />
      {!q && containers.data && containers.data.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted">Containers</div>
          <ResultList
            items={containers.data.map((c) => ({ kind: "container", id: c.id, name: c.label ?? c.recipe_name, sub: `${c.portions_left} portions left`, perUnit: c.per_portion, defaultUnit: "portion", defaultAmount: 1 }))}
            onPick={onPick}
          />
        </div>
      )}
      <ResultList items={items} onPick={onPick} />
    </div>
  );
}

function FavoritesTab({ onPick }: { onPick: (p: Pickable) => void }) {
  const favs = useApi<any[]>("/api/foods/favorites");
  if (!favs.data) return null;
  if (!favs.data.length) return <p className="py-6 text-center text-sm text-muted">Star a food after picking it to see it here.</p>;
  return <ResultList items={favs.data.map(fromFood)} onPick={onPick} />;
}

function RecentTab({ meal, date, onLogged }: { meal: Meal; date: string; onLogged: (m: string) => void }) {
  const recents = useApi<any[]>("/api/recents");
  const [error, setError] = useState<unknown>(null);
  async function relog(e: any) {
    setError(null);
    try {
      const item: any = { meal, amount: e.amount, unit: e.unit };
      if (e.ref_type === "adhoc" || !e.ref_id) Object.assign(item, { adhoc: { name: e.name, kcal: e.nutrients.kcal, protein: e.nutrients.protein, carbs: e.nutrients.carbs, fat: e.nutrients.fat }, amount: 1, unit: "serving" });
      else item[`${e.ref_type}_id`] = e.ref_id;
      await api("/api/log", { json: { items: [item], date } });
      onLogged(`Logged ${e.name}`);
    } catch (err) {
      setError(err);
    }
  }
  if (!recents.data) return null;
  if (!recents.data.length) return <p className="py-6 text-center text-sm text-muted">Nothing logged yet.</p>;
  return (
    <>
      <ErrorText error={error} />
      <ul className="divide-y divide-line">
        {recents.data.map((e) => (
          <li key={e.id}>
            <button className="flex w-full items-center justify-between gap-3 py-2.5 text-left" onClick={() => relog(e)}>
              <div className="min-w-0">
                <div className="truncate">{e.name}</div>
                <div className="text-xs text-muted">{e.unit === "g" ? `${Math.round(e.amount)} g` : `${e.amount} ${e.unit}`} · tap to log again</div>
              </div>
              <span className="shrink-0 text-sm tabular">{e.nutrients.kcal} kcal</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function TemplatesTab({ meal, date, onLogged }: { meal: Meal; date: string; onLogged: (m: string) => void }) {
  const tpls = useApi<any[]>("/api/templates");
  const [error, setError] = useState<unknown>(null);
  if (!tpls.data) return null;
  if (!tpls.data.length) return <p className="py-6 text-center text-sm text-muted">Save a meal as a template from the Today screen.</p>;
  return (
    <>
      <ErrorText error={error} />
      <ul className="space-y-2">
        {tpls.data.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2 rounded-xl bg-bg p-3">
            <div className="min-w-0">
              <div className="truncate font-medium">{t.name}</div>
              <div className="truncate text-xs text-muted">{t.items.map((i: any) => i.name).join(", ")}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="primary" onClick={async () => {
                try {
                  await api(`/api/templates/${t.id}/log`, { json: { date, meal } });
                  onLogged(`Logged ${t.name}`);
                } catch (e) {
                  setError(e);
                }
              }}>
                Log
              </Button>
              <Button size="sm" variant="subtle" aria-label={`Delete ${t.name}`} onClick={async () => {
                if (confirm(`Delete template "${t.name}"?`)) {
                  await api(`/api/templates/${t.id}`, { method: "DELETE" });
                  void tpls.reload();
                }
              }}>
                ×
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function ScanTab({ onPick, onNotFound }: { onPick: (p: Pickable) => void; onNotFound: () => void }) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const lookup = useCallback(
    async (c: string) => {
      setScanning(false);
      setStatus(`Looking up ${c}…`);
      try {
        const r = await api(`/api/barcode/${encodeURIComponent(c)}`);
        if (r.found) onPick(fromFood(r.food));
        else {
          setStatus(r.message);
          sessionStorage.setItem("mc.pendingBarcode", c);
        }
      } catch (e) {
        setStatus((e as Error).message);
      }
    },
    [onPick],
  );
  return (
    <div className="space-y-3">
      {scanning && (
        <Suspense fallback={<div className="aspect-[4/3] animate-pulse rounded-2xl bg-panel-2" />}>
          <BarcodeScanner onDetected={lookup} />
        </Suspense>
      )}
      <div className="flex gap-2">
        <input inputMode="numeric" placeholder="Or type the barcode" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className={inputCls} />
        <Button variant="primary" disabled={code.length < 6} onClick={() => lookup(code)}>
          Look up
        </Button>
      </div>
      {status && (
        <div className="space-y-2 rounded-xl bg-panel-2 p-3 text-sm">
          <p>{status}</p>
          {sessionStorage.getItem("mc.pendingBarcode") && (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={onNotFound}>
                Enter label manually
              </Button>
              <Button size="sm" onClick={() => (setScanning(true), setStatus(null))}>
                Scan again
              </Button>
            </div>
          )}
          <p className="text-xs text-muted">
            Missing products can be added to{" "}
            <a className="text-accent underline" href="https://world.openfoodfacts.org/contribute" target="_blank" rel="noreferrer">
              Open Food Facts
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}

function ManualFoodTab({ onCreated }: { onCreated: (food: any) => void }) {
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [basis, setBasis] = useState<"serving" | "100g">("serving");
  const [serving, setServing] = useState<number | "">("");
  const [n, setN] = useState<Record<string, number | "">>({ kcal: "", protein: "", carbs: "", fat: "", fiber: "", sugar: "", sodiumMg: "" });
  const [barcode] = useState(() => sessionStorage.getItem("mc.pendingBarcode") ?? "");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    setSaving(true);
    try {
      const factor = basis === "serving" ? 100 / Number(serving) : 1;
      const v = (k: string) => (n[k] === "" ? null : Number(n[k]) * factor);
      const r = await api("/api/foods", {
        json: {
          name,
          brand: brand || null,
          barcode: barcode || null,
          servingSizeG: serving === "" ? null : Number(serving),
          per100g: { kcal: v("kcal") ?? 0, protein: v("protein") ?? 0, carbs: v("carbs") ?? 0, fat: v("fat") ?? 0, fiber: v("fiber"), sugar: v("sugar"), sodiumMg: v("sodiumMg") },
          source: barcode ? "label-photo" : "manual",
        },
      });
      sessionStorage.removeItem("mc.pendingBarcode");
      invalidate();
      onCreated(r.food);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  const valid = name.trim() && n.kcal !== "" && n.protein !== "" && n.carbs !== "" && n.fat !== "" && (basis === "100g" || Number(serving) > 0);
  return (
    <div className="space-y-3">
      {barcode && <p className="text-xs text-muted">Barcode {barcode} will be saved with this food.</p>}
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Brand (optional)">
        <input value={brand} onChange={(e) => setBrand(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Nutrition is listed">
        <Segmented value={basis} onChange={setBasis} options={[{ value: "serving", label: "Per serving" }, { value: "100g", label: "Per 100 g" }]} />
      </Field>
      <Field label="Serving size (g)">
        <NumberInput value={serving} onChange={setServing} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["kcal", "Calories (kcal)"],
            ["protein", "Protein (g)"],
            ["carbs", "Carbs (g)"],
            ["fat", "Fat (g)"],
            ["fiber", "Fiber (g)"],
            ["sugar", "Sugar (g)"],
            ["sodiumMg", "Sodium (mg)"],
          ] as const
        ).map(([k, l]) => (
          <Field key={k} label={l}>
            <NumberInput value={n[k]} onChange={(v) => setN({ ...n, [k]: v })} />
          </Field>
        ))}
      </div>
      <ErrorText error={error} />
      <Button variant="primary" className="w-full" disabled={!valid || saving} onClick={save}>
        Save food
      </Button>
    </div>
  );
}

function QuickAddTab({ meal, date, onLogged }: { meal: Meal; date: string; onLogged: (m: string) => void }) {
  const [name, setName] = useState("Quick add");
  const [n, setN] = useState<Record<string, number | "">>({ kcal: "", protein: "", carbs: "", fat: "" });
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setError(null);
    try {
      await api("/api/log", { json: { date, items: [{ meal, adhoc: { name, kcal: Number(n.kcal), protein: Number(n.protein || 0), carbs: Number(n.carbs || 0), fat: Number(n.fat || 0) } }] } });
      onLogged(`Logged ${name}`);
    } catch (e) {
      setError(e);
    }
  }
  return (
    <div className="space-y-3">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {(["kcal", "protein", "carbs", "fat"] as const).map((k) => (
          <Field key={k} label={k === "kcal" ? "Calories" : `${k[0].toUpperCase() + k.slice(1)} (g)`}>
            <NumberInput value={n[k]} onChange={(v) => setN({ ...n, [k]: v })} />
          </Field>
        ))}
      </div>
      <ErrorText error={error} />
      <Button variant="primary" className="w-full" disabled={n.kcal === ""} onClick={save}>
        Log
      </Button>
    </div>
  );
}

function AmountPicker({ item, meal, date, onBack, onLogged }: { item: Pickable; meal: Meal; date: string; onBack: () => void; onLogged: (m: string) => void }) {
  const hasServing = !!item.servingG;
  const initialUnit = item.defaultUnit ?? (item.perUnit ? "serving" : hasServing ? (item.kind === "recipe" ? "portion" : "serving") : "g");
  const [unit, setUnit] = useState<"g" | "serving" | "portion">(initialUnit);
  const [amount, setAmount] = useState<number | "">(item.defaultAmount ?? (initialUnit === "g" ? 100 : 1));
  const [fav, setFav] = useState(!!item.favorite);
  const [error, setError] = useState<unknown>(null);

  const a = amount === "" ? 0 : amount;
  let preview: { kcal: number; protein: number; carbs: number; fat: number } | null = null;
  if (item.perUnit) preview = roundNutrients({ kcal: item.perUnit.kcal * a, protein: item.perUnit.protein * a, carbs: item.perUnit.carbs * a, fat: item.perUnit.fat * a });
  else if (item.per100) preview = roundNutrients(forGrams(item.per100, unit === "g" ? a : a * (item.servingG ?? 100)));

  async function log() {
    setError(null);
    try {
      await api("/api/log", { json: { date, items: [{ meal, [`${item.kind}_id`]: item.id, amount: a, unit }] } });
      onLogged(`Logged ${item.name}`);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="space-y-4">
      <button className="text-sm text-ink-2" onClick={onBack}>
        ‹ Back
      </button>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-lg font-semibold">{item.name}</div>
          {item.sub && <div className="text-sm text-muted">{item.sub}</div>}
        </div>
        {item.kind === "food" && (
          <button
            aria-label={fav ? "Remove from favorites" : "Add to favorites"}
            className={`text-2xl ${fav ? "text-warn" : "text-muted"}`}
            onClick={async () => {
              setFav(!fav);
              await api(`/api/foods/${item.id}/favorite`, { json: { favorite: !fav } });
            }}
          >
            {fav ? "★" : "☆"}
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <NumberInput value={amount} onChange={setAmount} className="flex-1" />
        {!item.perUnit && item.kind !== "container" && (
          <div className="w-44">
            <Segmented
              value={unit}
              onChange={(u) => (setUnit(u), setAmount(u === "g" ? Math.round(a * (item.servingG ?? 100)) || 100 : 1))}
              options={[{ value: "g", label: "grams" }, ...(hasServing ? [{ value: (item.kind === "recipe" ? "portion" : "serving") as "portion" | "serving", label: item.kind === "recipe" ? "portions" : "servings" }] : [])]}
            />
          </div>
        )}
      </div>
      {preview && (
        <div className="grid grid-cols-4 gap-2 text-center">
          {(
            [
              ["kcal", preview.kcal, ""],
              ["Protein", preview.protein, "g"],
              ["Carbs", preview.carbs, "g"],
              ["Fat", preview.fat, "g"],
            ] as const
          ).map(([l, v, u]) => (
            <div key={l} className="rounded-xl bg-bg p-2">
              <div className="tabular text-lg font-semibold">
                {Math.round(v)}
                {u}
              </div>
              <div className="text-xs text-muted">{l}</div>
            </div>
          ))}
        </div>
      )}
      <ErrorText error={error} />
      <Button variant="primary" className="w-full" disabled={!a} onClick={log}>
        Log to {meal}
      </Button>
    </div>
  );
}
