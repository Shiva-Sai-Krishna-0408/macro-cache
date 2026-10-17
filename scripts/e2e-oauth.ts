// Local end-to-end check of the MCP OAuth flow against `wrangler dev`.
// Uses the "already signed in to the dashboard" path so no GitHub round-trip is needed.
// Usage: node scripts/e2e-oauth.ts http://localhost:8788 <COOKIE_ENCRYPTION_KEY> <ALLOWED_GITHUB_USER>
import { createHash, randomBytes } from "node:crypto";
import { createSession } from "../apps/worker/src/auth/session.ts";

const [base, key, user] = process.argv.slice(2);
const b64u = (b: Buffer) => b.toString("base64url");
const verifier = b64u(randomBytes(32));
const challenge = b64u(createHash("sha256").update(verifier).digest());
const redirect = "https://claude.ai/api/mcp/auth_callback";
const resource = `${base}/mcp`;

const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "e2e", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json();
const session = (await createSession(user, key)).split(";")[0];
const authUrl = `${base}/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource, scope: "mcp offline_access" });
const page = await fetch(authUrl, { headers: { cookie: session } });
const html = await page.text();
const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
const consentCookie = page.headers.get("set-cookie")!.split(";")[0];
const approve = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { cookie: `${session}; ${consentCookie}`, "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ handle, decision: "approve" }) });
const loc = new URL(approve.headers.get("location")!);
console.log("authorize ->", approve.status, loc.origin + loc.pathname, "state=" + loc.searchParams.get("state"));
const tok = await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource }) })).json();
console.log("token ->", tok.token_type, "expires_in", tok.expires_in, "refresh", !!tok.refresh_token);
const call = async (method: string, params: unknown) => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : t);
};
const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
console.log("initialize ->", init.result?.serverInfo);
const list = await call("tools/list", {});
console.log("tools ->", list.result?.tools.length);
const day = await call("tools/call", { name: "get_day_summary", arguments: {} });
console.log("get_day_summary ->", JSON.parse(day.result.content[0].text).status_line);
const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
console.log("bad token ->", bad.status);
