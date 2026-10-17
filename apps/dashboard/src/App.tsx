import { useState } from "react";
import { useApi } from "./api";
import { Button } from "./components/ui";
import LogSheet, { type LogPreset } from "./pages/LogSheet";
import Onboarding from "./pages/Onboarding";
import Settings from "./pages/Settings";
import Today from "./pages/Today";

export type Tab = "today" | "progress" | "simulate" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "M4 12h16M12 4v16" },
  { id: "progress", label: "Progress", icon: "M4 19l5-6 4 3 7-9" },
  { id: "simulate", label: "Simulate", icon: "M4 17c4 0 6-10 16-10M4 7h4m-4 10h8" },
  { id: "settings", label: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zm7-3l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z" },
];

function Login() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-3xl border border-line bg-panel p-6 text-center">
        <img src="/favicon.svg" alt="" className="mx-auto mb-4 h-16 w-16" />
        <h1 className="text-2xl font-semibold">macro-cache</h1>
        <p className="mt-2 text-sm text-muted">Your Claude-native macro tracker, on your own Cloudflare instance.</p>
        <a href="/login" className="mt-6 block rounded-xl bg-accent px-4 py-3 font-semibold text-accent-ink">
          Sign in with GitHub
        </a>
      </div>
    </div>
  );
}

export default function App() {
  const me = useApi<{ login: string }>("/api/me");
  const profile = useApi("/api/profile");
  const [tab, setTab] = useState<Tab>("today");
  const [logPreset, setLogPreset] = useState<LogPreset | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);

  if (me.loading && !me.data) return <div className="flex min-h-screen items-center justify-center text-muted">Loading…</div>;
  if (me.error?.status === 401 || !me.data) return <Login />;
  if (!profile.data) return <div className="flex min-h-screen items-center justify-center text-muted">Loading…</div>;

  if (!profile.data.profile.onboarded || editingProfile)
    return <Onboarding initial={profile.data.profile} currentWeightKg={profile.data.current_weight_kg} onDone={() => setEditingProfile(false)} onCancel={profile.data.profile.onboarded ? () => setEditingProfile(false) : undefined} />;

  const units = profile.data.profile.units;
  return (
    <div className="mx-auto min-h-screen max-w-2xl pb-28">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line/60 bg-bg/90 px-4 py-3 backdrop-blur" style={{ paddingTop: "max(env(safe-area-inset-top), 12px)" }}>
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <span className="font-semibold">macro-cache</span>
        </div>
        <Button variant="primary" size="sm" onClick={() => setLogPreset({})}>
          + Log food
        </Button>
      </header>

      <main className="space-y-4 p-4">
        {tab === "today" && <Today profile={profile.data} onLog={(p) => setLogPreset(p)} />}
        {(tab === "progress" || tab === "simulate") && <p className="text-muted">Coming soon.</p>}
        {tab === "settings" && <Settings profile={profile.data} login={me.data.login} onEditProfile={() => setEditingProfile(true)} />}
      </main>

      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`flex flex-1 flex-col items-center gap-1 py-2 text-xs ${tab === t.id ? "text-accent" : "text-muted"}`} aria-current={tab === t.id}>
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={t.icon} />
              </svg>
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {logPreset && <LogSheet preset={logPreset} onClose={() => setLogPreset(null)} />}
    </div>
  );
}
