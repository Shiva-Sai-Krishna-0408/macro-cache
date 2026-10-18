import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createTestD1 } from "./d1-shim";

/**
 * Full connector sign-in, end to end, through the REAL Worker (OAuth provider,
 * consent page, GitHub handlers, MCP endpoint):
 *
 *   claude.ai → GET /authorize (consent) → POST /authorize → github.com → GET /callback
 *   → claude.ai?code=… → POST /token → POST /mcp
 *
 * A small browser model enforces what real browsers enforce and what broke in
 * production: SameSite/Path cookie rules on cross-site navigations, cookie
 * replacement/expiry, and CSP form-action on EVERY hop of a form's redirect chain.
 */

const ORIGIN = "https://mc.example.com";
const CLIENT_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const b64u = (b: Buffer) => b.toString("base64url");
const s256 = (v: string) => b64u(createHash("sha256").update(v).digest());

// ---------------------------------------------------------------- KV + env

function memoryKV() {
  const m = new Map<string, { v: string; exp?: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.exp && e.exp < Date.now()) m.delete(k);
    return m.get(k);
  };
  return {
    async get(k: string, type?: string | { type?: string }) {
      const e = live(k);
      if (!e) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? JSON.parse(e.v) : e.v;
    },
    async put(k: string, v: string, o?: { expirationTtl?: number; expiration?: number }) {
      m.set(k, { v, exp: o?.expirationTtl ? Date.now() + o.expirationTtl * 1000 : o?.expiration ? o.expiration * 1000 : undefined });
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list(o: { prefix?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => !o.prefix || k.startsWith(o.prefix)).map((name) => ({ name })), list_complete: true, cacheStatus: null };
    },
  };
}

function makeEnv(allowed = "Octocat") {
  return {
    DB: createTestD1().d1,
    OAUTH_KV: memoryKV(),
    ASSETS: { fetch: async () => new Response("<!doctype html><title>dashboard</title>", { headers: { "content-type": "text/html" } }) },
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: "gh-client-secret",
    COOKIE_ENCRYPTION_KEY: "test-cookie-key-0123456789abcdef0123456789",
    ALLOWED_GITHUB_USER: allowed,
  } as any;
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as any;

// ---------------------------------------------------------------- fake GitHub (server side)

let githubLogin = "octocat";
const challenges = new Map<string, string>(); // code → PKCE challenge GitHub saw

function fakeGithubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body));
      expect(body.client_secret).toBe("gh-client-secret");
      expect(body.redirect_uri).toBe(`${ORIGIN}/callback`);
      // GitHub enforces PKCE: the verifier must match the challenge from /authorize.
      if (s256(body.code_verifier) !== challenges.get(body.code)) return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: "gho_test", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") return Response.json({ login: githubLogin, id: 4242 });
    throw new Error(`unexpected outbound fetch: ${url}`);
  });
}

// ---------------------------------------------------------------- browser model

interface Cookie {
  value: string;
  path: string;
  sameSite: "Strict" | "Lax" | "None";
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

function parseFormAction(csp: string | null): string[] | null {
  const d = csp?.split(";").map((s) => s.trim()).find((s) => s.startsWith("form-action"));
  return d ? d.split(/\s+/).slice(1) : null;
}

function allowedByFormAction(sources: string[], target: URL, self: string) {
  return sources.some((s) => (s === "'self'" ? target.origin === self : target.origin === s));
}

class Browser {
  jar = new Map<string, Cookie>(); // cookies for ORIGIN only
  hops: string[] = [];

  constructor(
    private env: any,
    private githubAutoApproves = true,
  ) {}

  setCookies(res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const a = Object.fromEntries(attrs.map((x) => [x.split("=")[0].toLowerCase(), x.split("=")[1] ?? true])) as Record<string, string | true>;
      if (name.startsWith("__Host-")) {
        // __Host- prefix rules: Secure, Path=/, no Domain — otherwise the browser rejects it.
        expect(a.secure, `${name} must be Secure`).toBe(true);
        expect(a.path, `${name} must have Path=/`).toBe("/");
        expect(a.domain, `${name} must not set Domain`).toBeUndefined();
      }
      const maxAge = a["max-age"] !== undefined ? Number(a["max-age"]) : undefined;
      if (maxAge !== undefined && maxAge <= 0) {
        this.jar.delete(name);
        continue;
      }
      this.jar.set(name, {
        value: decodeURIComponent(pair.slice(eq + 1)),
        path: (a.path as string) ?? "/",
        sameSite: ((a.samesite as string) ?? "Lax") as Cookie["sameSite"],
        secure: !!a.secure,
        httpOnly: !!a.httponly,
        expires: maxAge !== undefined ? Date.now() + maxAge * 1000 : undefined,
      });
    }
  }

  /** Cookies a browser would attach. SameSite=Strict is never sent cross-site; Lax only on top-level GET navigations. */
  cookieHeader(url: URL, crossSite: boolean, method: string, topLevel: boolean) {
    const out: string[] = [];
    for (const [name, c] of this.jar) {
      if (c.expires && c.expires < Date.now()) continue;
      if (!url.pathname.startsWith(c.path)) continue;
      if (c.secure && url.protocol !== "https:") continue;
      if (crossSite && c.sameSite === "Strict") continue;
      if (crossSite && c.sameSite === "Lax" && !(topLevel && method === "GET")) continue;
      out.push(`${name}=${encodeURIComponent(c.value)}`);
    }
    return out.join("; ");
  }

  /** Server-to-server-free single request to the Worker as this browser. */
  async request(url: string, opts: { method?: string; body?: BodyInit; headers?: Record<string, string>; crossSite?: boolean; topLevel?: boolean } = {}) {
    const u = new URL(url);
    const method = opts.method ?? "GET";
    const headers = new Headers(opts.headers);
    const c = this.cookieHeader(u, !!opts.crossSite, method, opts.topLevel ?? true);
    if (c) headers.set("cookie", c);
    const res = await worker.fetch(new Request(url, { method, headers, body: opts.body, redirect: "manual" }), this.env, ctx());
    this.setCookies(res);
    return res;
  }

  /**
   * Top-level navigation that follows redirects like a browser. `formAction`
   * (from the submitting page's CSP) is enforced on every redirect hop.
   */
  async navigate(url: string, opts: { method?: string; form?: Record<string, string>; initiator: string; formAction?: string[] | null }) {
    let current = new URL(url);
    let method = opts.method ?? "GET";
    let body: string | undefined = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
    let chainCrossSite = new URL(opts.initiator).origin !== ORIGIN;
    for (let i = 0; i < 10; i++) {
      this.hops.push(`${method} ${current.origin}${current.pathname}`);
      if (current.origin !== ORIGIN) chainCrossSite = true;
      if (current.origin === CLIENT_REDIRECT.slice(0, "https://claude.ai".length)) return { url: current, status: 200, text: "client" };
      if (current.origin === "https://github.com") {
        // GitHub's authorize endpoint. If the user already authorized the app (e.g. via the
        // dashboard login), GitHub redirects straight back — continuing the SAME redirect chain.
        const state = current.searchParams.get("state")!;
        const code = `gh-code-${randomBytes(4).toString("hex")}`;
        challenges.set(code, current.searchParams.get("code_challenge")!);
        if (!this.githubAutoApproves) return { url: current, status: 200, text: "github consent page" };
        const next = new URL(current.searchParams.get("redirect_uri")!);
        next.searchParams.set("code", code);
        next.searchParams.set("state", state);
        if (opts.formAction && !allowedByFormAction(opts.formAction, next, ORIGIN)) throw new Error(`CSP form-action blocked redirect to ${next.origin}`);
        current = next;
        method = "GET";
        body = undefined;
        continue;
      }
      const headers: Record<string, string> = {};
      if (body) headers["content-type"] = "application/x-www-form-urlencoded";
      if (method === "POST") headers.origin = opts.initiator;
      const res = await this.request(current.toString(), { method, body, headers, crossSite: chainCrossSite, topLevel: true });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, current);
        if (opts.formAction && !allowedByFormAction(opts.formAction, next, ORIGIN)) throw new Error(`CSP form-action blocked redirect to ${next.origin}`);
        current = next;
        if (res.status !== 307 && res.status !== 308) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return { url: current, status: res.status, text: await res.text(), res };
    }
    throw new Error("too many redirects");
  }
}

// ---------------------------------------------------------------- helpers

async function registerClient(env: any) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }) }),
    env,
    ctx(),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string) {
  return `${ORIGIN}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "client-state", resource: `${ORIGIN}/mcp`, scope: "mcp offline_access" })}`;
}

async function openConsent(b: Browser, clientId: string, challenge: string) {
  const page = await b.navigate(authorizeUrl(clientId, challenge), { initiator: "https://claude.ai" });
  expect(page.status).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(page.text)![1];
  const formAction = parseFormAction(page.res!.headers.get("content-security-policy"));
  return { handle, formAction };
}

async function exchangeCode(env: any, clientId: string, code: string, verifier: string) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLIENT_REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }),
    }),
    env,
    ctx(),
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function mcpToolsList(env: any, token: string) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    env,
    ctx(),
  );
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, body: res.status === 200 ? JSON.parse(line ? line.slice(6) : text) : null };
}

// ---------------------------------------------------------------- tests

describe("connector OAuth: authorize → GitHub → callback round trip", () => {
  beforeEach(() => {
    githubLogin = "octocat";
    challenges.clear();
    vi.stubGlobal("fetch", fakeGithubFetch());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("completes when GitHub auto-approves (one continuous redirect chain) and yields a working MCP token", async () => {
    const env = makeEnv();
    const b = new Browser(env);
    const clientId = await registerClient(env);
    const verifier = b64u(randomBytes(32));
    const { handle, formAction } = await openConsent(b, clientId, s256(verifier));

    // The consent page must allow its form's whole redirect chain.
    expect(formAction).toEqual(expect.arrayContaining(["'self'", "https://github.com", "https://claude.ai"]));
    const consentCookie = [...b.jar].find(([n]) => n.startsWith("__Host-oauth-consent-"))!;
    expect(consentCookie[1].sameSite).toBe("Lax");

    const end = await b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction });
    expect(b.hops).toEqual(expect.arrayContaining([`POST ${ORIGIN}/authorize`, "GET https://github.com/login/oauth/authorize", `GET ${ORIGIN}/callback`, "GET https://claude.ai/api/mcp/auth_callback"]));
    expect(end.url.origin + end.url.pathname).toBe(CLIENT_REDIRECT);
    expect(end.url.searchParams.get("state")).toBe("client-state");
    expect(end.url.searchParams.get("iss")).toBe(ORIGIN);
    const code = end.url.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // One-time binding cookie was used and cleared; the browser is now also signed in to the dashboard.
    expect([...b.jar.keys()].some((n) => n.startsWith("__Host-oauth-upstream-"))).toBe(false);
    const me = await b.request(`${ORIGIN}/api/me`, { headers: { "x-requested-with": "macro-cache" } });
    expect(await me.json()).toEqual({ login: "octocat" });

    const tok = await exchangeCode(env, clientId, code, verifier);
    expect(tok.status).toBe(200);
    expect(tok.body.token_type.toLowerCase()).toBe("bearer");
    expect(tok.body.refresh_token).toBeTruthy();
    const list = await mcpToolsList(env, tok.body.access_token);
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: any) => t.name)).toContain("get_day_summary");
  });

  it("the upstream state cookie is Lax, Path=/, and survives GitHub's cross-site redirect", async () => {
    const env = makeEnv();
    const b = new Browser(env, /* githubAutoApproves */ false); // stop at GitHub's own consent page
    const clientId = await registerClient(env);
    const verifier = b64u(randomBytes(32));
    const { handle, formAction } = await openConsent(b, clientId, s256(verifier));
    const atGithub = await b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction });
    expect(atGithub.url.origin).toBe("https://github.com");

    const [name, upstream] = [...b.jar].find(([n]) => n.startsWith("__Host-oauth-upstream-"))!;
    expect(upstream).toMatchObject({ sameSite: "Lax", path: "/", secure: true, httpOnly: true });
    // A cross-site top-level GET to /callback carries it; a Strict cookie would not have been sent.
    expect(b.cookieHeader(new URL(`${ORIGIN}/callback`), true, "GET", true)).toContain(name);

    // User clicks "Authorize" on GitHub → new navigation initiated by github.com (cross-site).
    const code = `gh-code-manual`;
    challenges.set(code, atGithub.url.searchParams.get("code_challenge")!);
    const cb = new URL(`${ORIGIN}/callback`);
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", atGithub.url.searchParams.get("state")!);
    const end = await b.navigate(cb.toString(), { initiator: "https://github.com" });
    expect(end.url.origin + end.url.pathname).toBe(CLIENT_REDIRECT);
    expect((await exchangeCode(env, clientId, end.url.searchParams.get("code")!, verifier)).status).toBe(200);
  });

  it("would fail with the old consent CSP (regression guard for the production bug)", async () => {
    const env = makeEnv();
    const b = new Browser(env);
    const clientId = await registerClient(env);
    const { handle } = await openConsent(b, clientId, s256(b64u(randomBytes(32))));
    const oldFormAction = ["'self'", "https://github.com"];
    await expect(b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction: oldFormAction })).rejects.toThrow(/form-action blocked redirect to https:\/\/claude\.ai/);
    // …and the state was already consumed, so retrying /callback can only fail.
    const cbHop = b.hops.find((h) => h.endsWith("/callback"));
    expect(cbHop).toBeDefined();
  });

  it("dashboard login and connector login can run at the same time in one browser without clobbering each other", async () => {
    const env = makeEnv();
    const b = new Browser(env);
    const clientId = await registerClient(env);
    const verifier = b64u(randomBytes(32));

    // 1. Start a dashboard login (sets its own state cookie), but don't finish it yet.
    const login = await b.request(`${ORIGIN}/login`);
    const githubForDashboard = login.headers.get("location")!;
    expect(new URL(githubForDashboard).searchParams.get("state")).toMatch(/^d\./);
    const dashCookie = [...b.jar.keys()].find((n) => n === "__Host-mc_login");
    expect(dashCookie).toBeDefined();

    // 2. Run the whole connector flow.
    const { handle, formAction } = await openConsent(b, clientId, s256(verifier));
    const upstreamNames = () => [...b.jar.keys()].filter((n) => n.startsWith("__Host-oauth-upstream-"));
    const end = await b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction });
    expect(end.url.origin + end.url.pathname).toBe(CLIENT_REDIRECT);
    expect(upstreamNames()).toHaveLength(0);
    expect(b.jar.has("__Host-mc_login")).toBe(true); // untouched by the MCP flow

    // 3. Finish the dashboard login afterwards — still works.
    b.jar.delete("__Host-mc_session");
    const dash = await b.navigate(githubForDashboard, { initiator: ORIGIN });
    expect(dash.url.toString()).toBe(`${ORIGIN}/`);
    expect(b.jar.has("__Host-mc_session")).toBe(true);
    expect((await exchangeCode(env, clientId, end.url.searchParams.get("code")!, verifier)).status).toBe(200);
  });

  it("already signed in to the dashboard: consent goes straight back to Claude (no GitHub hop) and the CSP allows it", async () => {
    const env = makeEnv();
    const b = new Browser(env);
    await b.navigate(`${ORIGIN}/login`, { initiator: ORIGIN }); // dashboard sign-in via GitHub
    expect(b.jar.has("__Host-mc_session")).toBe(true);
    const clientId = await registerClient(env);
    const verifier = b64u(randomBytes(32));
    const { handle, formAction } = await openConsent(b, clientId, s256(verifier));
    b.hops = [];
    const end = await b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction });
    expect(b.hops).not.toContain("GET https://github.com/login/oauth/authorize");
    expect(end.url.origin + end.url.pathname).toBe(CLIENT_REDIRECT);
    expect((await exchangeCode(env, clientId, end.url.searchParams.get("code")!, verifier)).status).toBe(200);
  });

  it("replaying /callback cannot mint a second authorization", async () => {
    const env = makeEnv();
    const b = new Browser(env, false);
    const clientId = await registerClient(env);
    const { handle, formAction } = await openConsent(b, clientId, s256(b64u(randomBytes(32))));
    const atGithub = await b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction });
    const code = "gh-code-replay";
    challenges.set(code, atGithub.url.searchParams.get("code_challenge")!);
    const cb = `${ORIGIN}/callback?code=${code}&state=${encodeURIComponent(atGithub.url.searchParams.get("state")!)}`;
    expect((await b.navigate(cb, { initiator: "https://github.com" })).url.origin).toBe("https://claude.ai");
    const again = await b.navigate(cb, { initiator: "https://github.com" });
    expect(again.status).toBe(400);
    expect(again.text).toMatch(/start again/);
  });

  it("a GitHub account other than ALLOWED_GITHUB_USER is sent back to Claude with access_denied", async () => {
    githubLogin = "mallory";
    const env = makeEnv();
    const b = new Browser(env);
    const clientId = await registerClient(env);
    const verifier = b64u(randomBytes(32));
    const { handle, formAction } = await openConsent(b, clientId, s256(verifier));
    const end = await b.navigate(`${ORIGIN}/authorize`, { method: "POST", form: { handle, decision: "approve" }, initiator: ORIGIN, formAction });
    expect(end.url.searchParams.get("error")).toBe("access_denied");
    expect(end.url.searchParams.get("code")).toBeNull();
    expect(b.jar.has("__Host-mc_session")).toBe(false);
  });

  it("browser model sanity: SameSite=Strict cookies are withheld on cross-site navigations", () => {
    const b = new Browser(makeEnv());
    b.jar.set("strict", { value: "1", path: "/", sameSite: "Strict", secure: true, httpOnly: true });
    b.jar.set("lax", { value: "1", path: "/", sameSite: "Lax", secure: true, httpOnly: true });
    b.jar.set("scoped", { value: "1", path: "/authorize", sameSite: "Lax", secure: true, httpOnly: true });
    const h = b.cookieHeader(new URL(`${ORIGIN}/callback`), true, "GET", true);
    expect(h).toContain("lax=1");
    expect(h).not.toContain("strict=1");
    expect(h).not.toContain("scoped=1");
    expect(b.cookieHeader(new URL(`${ORIGIN}/callback`), true, "POST", true)).not.toContain("lax=1");
  });
});
