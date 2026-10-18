import { todayIn } from "@macro-cache/core";
import { useEffect, useState } from "react";
import { api, invalidate, useApi } from "../api";
import { Button, Card, ErrorText, NumberInput, Segmented, fmtDate, inputCls } from "../components/ui";
import { guessMeal } from "./Today";

type Meal = "breakfast" | "lunch" | "dinner" | "snack";

export default function Recipes() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const list = useApi<any[]>(`/api/recipes${debounced ? `?q=${encodeURIComponent(debounced)}` : ""}`);

  if (openId != null) return <RecipeDetail id={openId} onBack={() => setOpenId(null)} />;

  return (
    <>
      <h1 className="text-xl font-semibold">Recipes</h1>
      <input placeholder="Search recipes…" value={q} onChange={(e) => setQ(e.target.value)} className={inputCls} aria-label="Search recipes" />
      {list.data && list.data.length === 0 && (
        <Card>
          <p className="text-sm text-ink-2">{debounced ? "No recipes match." : "No recipes yet. Tell Claude what you cooked, with ingredient weights and the total cooked weight, and it will save the recipe here."}</p>
        </Card>
      )}
      <ul className="space-y-2">
        {list.data?.map((r) => (
          <li key={r.id}>
            <button onClick={() => setOpenId(r.id)} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-panel p-4 text-left hover:border-accent/50">
              <div className="min-w-0">
                <div className="truncate font-medium">{r.name}</div>
                <div className="truncate text-xs text-muted">
                  {r.ingredients.length} ingredient{r.ingredients.length === 1 ? "" : "s"}
                  {r.portions ? ` · ${r.portions} portions of ${Math.round(r.portion_g)} g` : ""}
                  {r.version > 1 ? ` · v${r.version}` : ""}
                  {r.notes ? " · has notes" : ""}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs tabular">
                {r.per_portion ? (
                  <>
                    <div className="text-sm">{r.per_portion.kcal} kcal</div>
                    <div className="text-muted">{Math.round(r.per_portion.protein)} g P / portion</div>
                  </>
                ) : (
                  <>
                    <div className="text-sm">{r.per_100g.kcal} kcal</div>
                    <div className="text-muted">per 100 g</div>
                  </>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function MacroRow({ label, n }: { label: string; n: { kcal: number; protein: number; carbs: number; fat: number } | null }) {
  if (!n) return null;
  return (
    <tr className="border-t border-line">
      <td className="py-2 text-ink-2">{label}</td>
      <td className="py-2 text-right tabular">{n.kcal}</td>
      <td className="py-2 text-right tabular">{Math.round(n.protein)}</td>
      <td className="py-2 text-right tabular">{Math.round(n.carbs)}</td>
      <td className="py-2 text-right tabular">{Math.round(n.fat)}</td>
    </tr>
  );
}

function RecipeDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const detail = useApi(`/api/recipes/${id}`);
  const [notes, setNotes] = useState<string | null>(null);
  const [savedNotes, setSavedNotes] = useState<string | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const d = detail.data;

  useEffect(() => {
    if (d && notes === null) {
      setNotes(d.recipe.notes ?? "");
      setSavedNotes(d.recipe.notes ?? "");
    }
  }, [d, notes]);

  if (!d) return <div className="h-64 animate-pulse rounded-2xl bg-panel" />;
  const r = d.recipe;
  const dirty = notes !== null && notes !== savedNotes;

  async function saveNotes() {
    setSavingNotes(true);
    setError(null);
    try {
      await api(`/api/recipes/${r.id}`, { method: "PATCH", json: { notes: notes || null } });
      setSavedNotes(notes);
      invalidate();
    } catch (e) {
      setError(e);
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <>
      <button className="text-sm text-ink-2" onClick={onBack}>
        ‹ All recipes
      </button>
      <div>
        <h1 className="text-xl font-semibold">{r.name}</h1>
        <p className="text-xs text-muted">
          Version {r.version} · cooked weight {Math.round(r.total_cooked_weight_g)} g (raw {Math.round(r.total_raw_g)} g){r.portion_g ? ` · portion ${Math.round(r.portion_g)} g` : ""}
        </p>
      </div>

      <LogPortion recipe={r} batches={d.batches} />

      <Card title="Macros">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="text-left font-normal" />
              <th className="text-right font-normal">kcal</th>
              <th className="text-right font-normal">Protein</th>
              <th className="text-right font-normal">Carbs</th>
              <th className="text-right font-normal">Fat</th>
            </tr>
          </thead>
          <tbody>
            <MacroRow label="Per 100 g cooked" n={r.per_100g} />
            <MacroRow label={r.portion_g ? `Per portion (${Math.round(r.portion_g)} g)` : "Per portion"} n={r.per_portion} />
          </tbody>
        </table>
        {!r.per_portion && <p className="mt-2 text-xs text-muted">No portion size set. Ask Claude to set one, or log by grams.</p>}
      </Card>

      <Card title={`Ingredients (raw weights)`}>
        <ul className="divide-y divide-line text-sm">
          {d.ingredients.map((i: any) => (
            <li key={i.food_id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 truncate">
                {i.name}
                {i.brand && <span className="text-muted"> · {i.brand}</span>}
              </span>
              <span className="shrink-0 tabular text-ink-2">
                {Math.round(i.raw_g)} g{i.nutrients && <span className="text-muted"> · {i.nutrients.kcal} kcal</span>}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Steps / notes" action={dirty ? <span className="text-xs text-warn">Unsaved</span> : savedNotes ? <span className="text-xs text-muted">Saved</span> : null}>
        <textarea
          value={notes ?? ""}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={5000}
          rows={Math.min(14, Math.max(5, (notes ?? "").split("\n").length + 1))}
          placeholder={"1. Season the chicken…\n2. …"}
          className={`${inputCls} font-[inherit] leading-relaxed`}
          aria-label="Steps and notes"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted tabular">{(notes ?? "").length} / 5000</span>
          <Button variant="primary" size="sm" disabled={!dirty || savingNotes} onClick={saveNotes}>
            {savingNotes ? "Saving…" : "Save notes"}
          </Button>
        </div>
        <ErrorText error={error} />
        <p className="mt-2 text-xs text-muted">Claude can fill this in too: describe how you make it and ask it to save the steps.</p>
      </Card>

      <Card title="Batch history">
        {d.batches.length ? (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="text-left font-normal">Date</th>
                <th className="text-right font-normal">Cooked</th>
                <th className="text-right font-normal">Portions</th>
              </tr>
            </thead>
            <tbody>
              {d.batches.map((b: any) => (
                <tr key={b.container_id} className="border-t border-line">
                  <td className="py-2">
                    {fmtDate(b.date)}
                    {b.active && <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">active</span>}
                  </td>
                  <td className="py-2 text-right tabular">{b.cooked_weight_g != null ? `${Math.round(b.cooked_weight_g)} g` : "—"}</td>
                  <td className="py-2 text-right tabular">
                    {b.portions_total}
                    {b.active && <span className="text-muted"> ({b.portions_left} left)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted">No meal-prep batches yet.</p>
        )}
        {d.versions.length > 1 && (
          <details className="mt-3 text-xs text-ink-2">
            <summary className="cursor-pointer text-muted">Recipe versions ({d.versions.length})</summary>
            <ul className="mt-2 space-y-1">
              {d.versions.map((v: any) => (
                <li key={v.id} className="tabular">
                  v{v.version} · {fmtDate(v.created_at?.slice(0, 10))} · cooked {Math.round(v.total_cooked_weight_g)} g · {v.kcal_per_100g} kcal/100 g
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </>
  );
}

function LogPortion({ recipe, batches }: { recipe: any; batches: any[] }) {
  const active = batches.find((b) => b.active);
  const [meal, setMeal] = useState<Meal>(guessMeal());
  const [grams, setGrams] = useState<number | "">(recipe.portion_g ? "" : 300);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const date = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

  async function log() {
    setBusy(true);
    setError(null);
    try {
      if (active) {
        await api(`/api/containers/${active.container_id}/use`, { json: { portions: 1, meal, date } });
        setMsg(`Logged 1 portion from your ${fmtDate(active.date)} batch.`);
      } else {
        const item = recipe.portion_g ? { recipe_id: recipe.id, amount: 1, unit: "portion", meal } : { recipe_id: recipe.id, amount: Number(grams), unit: "g", meal };
        await api("/api/log", { json: { date, items: [item] } });
        setMsg(recipe.portion_g ? "Logged 1 portion." : `Logged ${grams} g.`);
      }
      invalidate();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Segmented value={meal} onChange={setMeal} options={(["breakfast", "lunch", "dinner", "snack"] as Meal[]).map((m) => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))} />
      <div className="mt-3 flex items-center gap-2">
        {!active && !recipe.portion_g && (
          <div className="w-28">
            <NumberInput value={grams} onChange={setGrams} placeholder="grams" />
          </div>
        )}
        <Button variant="primary" className="flex-1" disabled={busy || (!active && !recipe.portion_g && !grams)} onClick={log}>
          {active ? `Log a portion (${active.portions_left} left)` : recipe.portion_g ? `Log a portion · ${recipe.per_portion.kcal} kcal` : "Log grams"}
        </Button>
      </div>
      {msg && <p className="mt-2 text-sm text-accent">{msg}</p>}
      <ErrorText error={error} />
    </Card>
  );
}
