import { createMcpHandler } from "@modelcontextprotocol/server";
import { makeDb } from "../src/db/client";
import { buildMcpServer } from "../src/mcp/server";
import type { Ctx } from "../src/services/context";
import { createTestD1 } from "./d1-shim";

export const NOW = new Date("2026-10-17T18:00:00Z");

export function setup(opts: { fetch?: typeof fetch } = {}) {
  const { d1, raw } = createTestD1();
  const db = makeDb(d1);
  const claude: Ctx = { db, via: "claude", fetch: opts.fetch, now: () => NOW };
  const dashboard: Ctx = { db, via: "dashboard", fetch: opts.fetch, now: () => NOW };
  const handler = createMcpHandler(() => buildMcpServer(claude));
  let nextId = 1;

  async function rpc(method: string, params: unknown) {
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      }),
    );
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line ? line.slice(6) : text);
  }

  /** Call an MCP tool and return its parsed JSON payload (+ isError flag). */
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const msg = await rpc("tools/call", { name, arguments: args });
    if (msg.error) return { ok: false, error: "rpc_error", message: msg.error.message, isError: true } as any;
    const r = msg.result;
    const textPart = r.content?.find((c: any) => c.type === "text")?.text ?? "{}";
    let payload: any;
    try {
      payload = JSON.parse(textPart);
    } catch {
      payload = { ok: false, error: "invalid_input", message: textPart };
    }
    return { ...payload, isError: !!r.isError } as any;
  }

  /** Row counts of every table, for "nothing was written" assertions. */
  function counts() {
    const out: Record<string, number> = {};
    for (const t of ["profile", "weight_entry", "food", "recipe", "container", "restaurant_order", "log_entry", "template", "audit_log"]) {
      out[t] = (raw.prepare(`select count(*) as n from ${t}`).get() as { n: number }).n;
    }
    return out;
  }

  function snapshot() {
    const out: Record<string, unknown[]> = {};
    for (const t of ["profile", "weight_entry", "food", "recipe", "container", "restaurant_order", "log_entry", "template", "audit_log"]) out[t] = raw.prepare(`select * from ${t}`).all();
    return JSON.stringify(out);
  }

  return { db, raw, claude, dashboard, rpc, tool, counts, snapshot };
}

export const PROFILE = { height_cm: 178, weight_kg: 90, age: 35, sex: "male", activity: "moderate", goal: "lose", pace_lb_per_week: 0.5, goal_weight_kg: 80, timezone: "UTC" };
export const CHICKEN = { name: "Chicken breast, cooked", per_100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 }, source: "manual", serving_size_g: 150, aliases: ["chicken"] };
export const RICE = { name: "White rice, cooked", per_100g: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, source: "manual" };
