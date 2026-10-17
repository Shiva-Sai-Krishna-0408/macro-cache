import { type Units } from "@macro-cache/core";
import { useState } from "react";
import { api, invalidate } from "../api";
import { Button, Card, ErrorText, Field, NumberInput, Segmented } from "../components/ui";

export default function Settings({ profile, login, onEditProfile }: { profile: any; login: string; onEditProfile: () => void }) {
  const p = profile.profile;
  const t = profile.targets;
  const [override, setOverride] = useState<number | "">(p.targetOverrideKcal ?? "");
  const [protein, setProtein] = useState<number>(p.proteinGPerKg ?? 1.6);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${location.origin}/mcp`;

  async function save(patch: Record<string, unknown>, note = "Saved") {
    setError(null);
    try {
      await api("/api/profile", { method: "PUT", json: patch });
      invalidate();
      setMsg(note);
      setTimeout(() => setMsg(null), 2500);
    } catch (e) {
      setError(e);
    }
  }

  const belowFloor = override !== "" && t && override < t.floor;

  async function importFile(file: File) {
    if (!confirm("Importing REPLACES all data on this instance with the file's contents. Continue?")) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api("/api/import", { json: data });
      invalidate();
      setMsg(`Imported ${Object.entries(r.imported).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Settings</h1>
      {msg && <p className="rounded-xl bg-accent/10 p-3 text-sm">{msg}</p>}
      <ErrorText error={error} />

      <Card title="Connect Claude">
        <p className="text-sm text-ink-2">Add this URL as a custom connector in Claude (Settings → Connectors → Add custom connector):</p>
        <div className="mt-2 flex gap-2">
          <code className="min-w-0 flex-1 truncate rounded-xl bg-bg px-3 py-2.5 text-sm">{mcpUrl}</code>
          <Button
            size="sm"
            onClick={async () => {
              await navigator.clipboard.writeText(mcpUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </Card>

      <Card title="Units & display">
        <Segmented value={p.units as Units} onChange={(units) => save({ units })} options={[{ value: "metric", label: "Metric (kg)" }, { value: "imperial", label: "Imperial (lb)" }]} />
        <label className="mt-4 flex items-center justify-between gap-3 text-sm">
          <span>
            Weekly budget mode
            <span className="block text-xs text-muted">Track a weekly total (daily target × 7) so you can bank calories for a meal out.</span>
          </span>
          <input type="checkbox" checked={p.weeklyBudget} onChange={(e) => save({ weeklyBudget: e.target.checked })} className="h-5 w-5 accent-[var(--color-accent)]" />
        </label>
        <label className="mt-4 flex items-center justify-between gap-3 text-sm">
          <span>
            Tradeoff cards in Claude
            <span className="block text-xs text-muted">Neutral numbers when you pick something other than the top suggestion.</span>
          </span>
          <input type="checkbox" checked={p.tradeoffCards} onChange={(e) => save({ tradeoffCards: e.target.checked })} className="h-5 w-5 accent-[var(--color-accent)]" />
        </label>
      </Card>

      <Card title="Targets">
        {t && (
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-xl bg-bg p-2">
              <div className="tabular text-lg font-semibold">{t.maintenance}</div>
              <div className="text-xs text-muted">Maintenance</div>
            </div>
            <div className="rounded-xl bg-bg p-2">
              <div className="tabular text-lg font-semibold text-accent">{t.kcal}</div>
              <div className="text-xs text-muted">Daily target</div>
            </div>
            <div className="rounded-xl bg-bg p-2">
              <div className="tabular text-lg font-semibold">{t.floor}</div>
              <div className="text-xs text-muted">Safety floor</div>
            </div>
          </div>
        )}
        <Field label={`Protein: ${protein.toFixed(1)} g per kg`} hint="1.6 g/kg is a solid default; 1.2–2.2 is the useful range.">
          <input type="range" min={1.2} max={2.2} step={0.1} value={protein} onChange={(e) => setProtein(Number(e.target.value))} onPointerUp={() => save({ proteinGPerKg: protein })} onKeyUp={() => save({ proteinGPerKg: protein })} className="w-full" />
        </Field>
        <div className="mt-3">
          <Field label="Override daily calories (blank = automatic)" hint={belowFloor ? <span className="text-warn">⚠ Below your safety floor of {t.floor} kcal. Very low intakes should be medically supervised.</span> : undefined}>
            <div className="flex gap-2">
              <NumberInput value={override} onChange={setOverride} className={belowFloor ? "border-warn" : ""} />
              <Button onClick={() => save({ targetOverrideKcal: override === "" ? null : override }, override === "" ? "Using automatic targets" : "Override saved")}>Save</Button>
            </div>
          </Field>
        </div>
        {t?.warnings?.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-ink-2">
            {t.warnings.map((w: string) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={onEditProfile}>
            Edit profile & goal
          </Button>
          <Button size="sm" onClick={() => api("/api/profile/recalculate", { json: {} }).then(() => (invalidate(), setMsg("Targets recalculated from your trend weight")))}>
            Recalculate
          </Button>
        </div>
      </Card>

      <Card title="Your data">
        <div className="flex flex-wrap gap-2">
          <a className="rounded-xl bg-panel-2 px-3 py-2 text-sm" href="/api/export.json">
            Export JSON
          </a>
          <a className="rounded-xl bg-panel-2 px-3 py-2 text-sm" href="/api/export.csv?kind=log">
            Food log CSV
          </a>
          <a className="rounded-xl bg-panel-2 px-3 py-2 text-sm" href="/api/export.csv?kind=weights">
            Weights CSV
          </a>
          <label className="cursor-pointer rounded-xl bg-panel-2 px-3 py-2 text-sm">
            Import JSON…
            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">Your data lives in your own Cloudflare D1 database. Exports are complete and portable.</p>
      </Card>

      <Card title="Account">
        <div className="flex items-center justify-between text-sm">
          <span>
            Signed in as <strong>{login}</strong>
          </span>
          <a href="/logout" className="text-ink-2 underline">
            Sign out
          </a>
        </div>
      </Card>

      <p className="px-1 pb-4 text-center text-xs text-muted">
        macro-cache gives estimates, not medical advice. ·{" "}
        <a className="underline" href="https://github.com/" target="_blank" rel="noreferrer">
          Source
        </a>
      </p>
    </>
  );
}
