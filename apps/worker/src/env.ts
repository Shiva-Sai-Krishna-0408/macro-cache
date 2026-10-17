import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  /** The only GitHub login allowed to use this instance. */
  ALLOWED_GITHUB_USER: string;
}

/** Props stored with each MCP grant (encrypted by the OAuth provider). */
export interface GrantProps {
  login: string;
  githubId: number;
}
