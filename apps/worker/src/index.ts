import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleApi } from "./api/routes";
import { handleAuthorize, handleCallback, handleLogin, handleLogout } from "./auth/github";
import { readSession, sameUser } from "./auth/session";
import { makeDb } from "./db/client";
import type { Env, GrantProps } from "./env";
import { buildMcpServer } from "./mcp/server";

const MCP_PATH = "/mcp";

/** MCP endpoint — only reached with a valid OAuth access token. */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: GrantProps; auth?: { token: string; clientId?: string; scope: string[]; expiresAt?: number } }) {
    // Defense in depth: the grant must belong to the allowed user.
    if (!sameUser(ctx.props?.login, env.ALLOWED_GITHUB_USER)) return new Response("Forbidden", { status: 403 });
    const handler = createMcpHandler(() => buildMcpServer({ db: makeDb(env.DB), via: "claude" }));
    return handler.fetch(request, {
      authInfo: ctx.auth ? { token: ctx.auth.token, clientId: ctx.auth.clientId ?? "unknown", scopes: ctx.auth.scope, expiresAt: ctx.auth.expiresAt } : undefined,
    });
  },
};

/** Everything that isn't the MCP endpoint: OAuth pages, dashboard API, static dashboard. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!env.ALLOWED_GITHUB_USER || !env.GITHUB_CLIENT_ID || !env.COOKIE_ENCRYPTION_KEY) {
      if (path.startsWith("/api/") || path === "/authorize" || path === "/login")
        return new Response("Server not configured: set ALLOWED_GITHUB_USER, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and COOKIE_ENCRYPTION_KEY.", { status: 503 });
    }
    if (path === "/authorize") return handleAuthorize(request, env);
    if (path === "/callback") return handleCallback(request, env);
    if (path === "/login") return handleLogin(request, env);
    if (path === "/logout") return handleLogout();
    if (path === "/healthz") return Response.json({ ok: true });
    if (path.startsWith("/api/")) {
      const session = await readSession(request, env.COOKIE_ENCRYPTION_KEY, env.ALLOWED_GITHUB_USER);
      if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
      return handleApi(request, env, session.login);
    }
    // Static dashboard (SPA). The bundle holds no user data; all data is behind /api.
    return env.ASSETS.fetch(request);
  },
};

// The resource URL must be the deployed origin, which differs per self-hosted instance,
// so build (and cache) one provider per origin.
const providers = new Map<string, OAuthProvider<Env>>();
function providerFor(origin: string) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: MCP_PATH,
      apiHandler: mcpApiHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mcp", "offline_access"],
      resourceMetadata: {
        resource: `${origin}${MCP_PATH}`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "macro-cache",
      },
      clientIdMetadataDocumentEnabled: true,
      refreshTokenTTL: 90 * 86400,
      refreshTokenIdleTTL: 30 * 86400,
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
