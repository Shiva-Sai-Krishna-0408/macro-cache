/** Signed, HttpOnly session cookie for the dashboard (HMAC-SHA256). */

export const SESSION_COOKIE = "__Host-mc_session";
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(secret: string) {
  if (!secret || secret.length < 16) throw new Error("COOKIE_ENCRYPTION_KEY must be set (at least 16 characters).");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(value: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return `${value}.${b64url(sig)}`;
}

export async function verify(signed: string, secret: string): Promise<string | null> {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(signed.slice(i + 1)), enc.encode(value));
    return ok ? value : null;
  } catch {
    return null;
  }
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

export async function createSession(login: string, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ login, exp: Date.now() + SESSION_DAYS * 86400_000 })));
  return cookie(SESSION_COOKIE, await sign(payload, secret), SESSION_DAYS * 86400);
}

export async function readSession(req: Request, secret: string, allowedUser: string): Promise<{ login: string } | null> {
  const raw = getCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const payload = await verify(raw, secret);
  if (!payload) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { login: string; exp: number };
    if (data.exp < Date.now()) return null;
    if (!sameUser(data.login, allowedUser)) return null;
    return { login: data.login };
  } catch {
    return null;
  }
}

export const sameUser = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}
