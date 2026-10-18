import { AuthorizationError, CimdFetchError, type ConsentDescription, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { Env, GrantProps } from "../env";
import { cookie, createSession, getCookie, randomToken, readSession, s256, sameUser, sign, verify, SESSION_COOKIE } from "./session";

/**
 * GitHub sign-in for both the MCP connector (OAuth via workers-oauth-provider)
 * and the dashboard (signed session cookie). Only ALLOWED_GITHUB_USER gets in.
 *
 * One GitHub OAuth app, one callback URL: <origin>/callback. Dashboard logins use
 * a state prefixed with "d." bound to a cookie; MCP logins use the provider's
 * upstream state (bound to the browser by the library).
 */

const DASH_STATE_COOKIE = "__Host-mc_login";
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `formAction` matters: Chrome enforces CSP form-action on EVERY hop of the redirect chain a
 * form submission starts. The consent form's chain is POST /authorize → github.com → /callback →
 * the MCP client's redirect URI (e.g. claude.ai) when GitHub auto-approves, or straight to the
 * client when already signed in. Every one of those origins must be listed, or the browser blocks
 * the final hop after /callback has already consumed the one-time state.
 */
const html = (body: string, status = 200, headers?: Headers, formAction: string[] = ["'self'"]) => {
  const h = headers ?? new Headers();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action ${formAction.join(" ")}`);
  h.set("X-Frame-Options", "DENY");
  return new Response(page(body), { status, headers: h });
};

function page(body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>macro-cache</title>
<style>:root{color-scheme:dark}body{font:16px/1.5 system-ui,sans-serif;background:#0b0f14;color:#e6edf3;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:420px;width:100%;background:#131a22;border:1px solid #243041;border-radius:16px;padding:24px}h1{font-size:20px;margin:0 0 12px}
.muted{color:#8b9bb0;font-size:14px}.warn{background:#3a2a10;border:1px solid #6b4e1a;padding:8px 12px;border-radius:8px;font-size:14px}
button{font:inherit;border:0;border-radius:10px;padding:10px 16px;cursor:pointer;margin-right:8px}.primary{background:#3fb950;color:#04130a;font-weight:600}.ghost{background:#243041;color:#e6edf3}</style>
</head><body><main>${body}</main></body></html>`;
}

function githubAuthorizeUrl(env: Env, origin: string, state: string, challenge: string) {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${origin}/callback`);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("allow_signup", "false");
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function exchangeGithubCode(env: Env, origin: string, code: string, verifier: string): Promise<{ login: string; id: number }> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "macro-cache" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${origin}/callback`, code_verifier: verifier }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!token.access_token) throw new Error(`GitHub token exchange failed: ${token.error_description ?? token.error ?? tokenRes.status}`);
  const userRes = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": "macro-cache", Accept: "application/vnd.github+json" } });
  if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
  const user = (await userRes.json()) as { login: string; id: number };
  // We only need the identity; the GitHub token is discarded, never stored.
  return { login: user.login, id: user.id };
}

function consentPage(d: ConsentDescription, handle: string, login: string | null) {
  const name = escape(d.clientName);
  const origin = d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : `This app registered itself; its name is not verified.`;
  return `<h1>Connect ${name} to macro-cache?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>` : ""}
<p class="muted">It will be able to read and change your food logs, recipes, weights and targets.${login ? ` Signed in as <strong>${escape(login)}</strong>.` : " You'll sign in with GitHub next."}</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<button class="primary" name="decision" value="approve">Allow</button><button class="ghost" name="decision" value="deny">Deny</button></form>`;
}

/** form-action sources for the consent page: us, GitHub, and the client's (library-validated) redirect origin. */
export function consentFormAction(redirectUri: string): string[] {
  const sources = ["'self'", "https://github.com"];
  try {
    const origin = new URL(redirectUri).origin;
    if (origin !== "null" && /^https?:\/\/[a-z0-9.\-[\]:]+$/i.test(origin)) sources.push(origin);
  } catch {
    /* unparseable redirect URIs are rejected by parseAuthRequest before we get here */
  }
  return sources;
}

function renderAuthError(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
    const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
    return html(
      `<h1>Can't connect</h1><p>${escape(message ?? "Authorization failed.")}</p><p class="muted">Each sign-in link works once, for 10 minutes, in the browser that started it. If you just approved, check whether Claude already shows macro-cache as connected; otherwise start the connection again from Claude.</p>`,
      400,
    );
  }
  throw e;
}

/** GET/POST /authorize — consent page for MCP clients, then GitHub sign-in. */
export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const origin = new URL(req.url).origin;
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const session = await readSession(req, env.COOKIE_ENCRYPTION_KEY, env.ALLOWED_GITHUB_USER);
      return html(consentPage(details, consent.handle, session?.login ?? null), 200, consent.headers, consentFormAction(details.redirectUri));
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle);
      // Already signed in to the dashboard as the allowed user? Skip the GitHub round-trip.
      const session = await readSession(req, env.COOKIE_ENCRYPTION_KEY, env.ALLOWED_GITHUB_USER);
      if (session) {
        const { redirectTo } = await oauth.completeAuthorization({
          request: approved.request,
          userId: session.login.toLowerCase(),
          metadata: { login: session.login },
          scope: approved.request.scope,
          props: { login: session.login, githubId: 0 } satisfies GrantProps,
        });
        approved.headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers: approved.headers });
      }
      const verifier = randomToken(48);
      const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      headers.set("Location", githubAuthorizeUrl(env, origin, state, await s256(verifier)));
      return new Response(null, { status: 302, headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return renderAuthError(e);
  }
}

/** GET /login — dashboard sign-in. */
export async function handleLogin(req: Request, env: Env): Promise<Response> {
  const origin = new URL(req.url).origin;
  const verifier = randomToken(48);
  const state = `d.${randomToken(24)}`;
  const signed = await sign(JSON.stringify({ state, verifier }), env.COOKIE_ENCRYPTION_KEY);
  const headers = new Headers({ Location: githubAuthorizeUrl(env, origin, state, await s256(verifier)) });
  headers.append("Set-Cookie", cookie(DASH_STATE_COOKIE, signed, 600));
  return new Response(null, { status: 302, headers });
}

export function handleLogout(): Response {
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

const notAllowed = (login: string) =>
  html(`<h1>Not allowed</h1><p>GitHub user <strong>${escape(login)}</strong> is not allowed on this instance.</p><p class="muted">This is a single-user, self-hosted app. Deploy your own copy to use it.</p>`, 403);

/** GET /callback — GitHub redirects here for both flows. */
export async function handleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");

  if (state.startsWith("d.")) {
    // Dashboard login
    const raw = getCookie(req, DASH_STATE_COOKIE);
    const value = raw ? await verify(raw, env.COOKIE_ENCRYPTION_KEY) : null;
    const saved = value ? (JSON.parse(value) as { state: string; verifier: string }) : null;
    if (!saved || saved.state !== state || !code) return html(`<h1>Sign-in expired</h1><p><a href="/login" style="color:#3fb950">Try again</a></p>`, 400);
    const user = await exchangeGithubCode(env, url.origin, code, saved.verifier);
    if (!sameUser(user.login, env.ALLOWED_GITHUB_USER)) return notAllowed(user.login);
    const headers = new Headers({ Location: "/" });
    headers.append("Set-Cookie", await createSession(user.login, env.COOKIE_ENCRYPTION_KEY));
    headers.append("Set-Cookie", cookie(DASH_STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  // MCP connector flow
  const oauth = env.OAUTH_PROVIDER;
  try {
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
    if (url.searchParams.get("error") || !code) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const user = await exchangeGithubCode(env, url.origin, code, data.verifier);
    if (!sameUser(user.login, env.ALLOWED_GITHUB_USER)) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: user.login.toLowerCase(),
      metadata: { login: user.login },
      scope: original.scope,
      props: { login: user.login, githubId: user.id } satisfies GrantProps,
    });
    headers.set("Location", redirectTo);
    // Also sign the browser in to the dashboard.
    headers.append("Set-Cookie", await createSession(user.login, env.COOKIE_ENCRYPTION_KEY));
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return renderAuthError(e);
  }
}
