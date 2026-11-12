import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { InboundAdmissionCtx, InboundRejection } from '@cindy/anthropic-compat-proxy';

/** The header this runtime's Codex processes carry to its loopback proxies. */
export const CODEX_PROXY_TOKEN_HEADER = 'x-cindy-proxy-token';
/**
 * Its value reaches Codex only through this environment variable (named by
 * env_http_headers, so the command line carries the name, not the value). The commands
 * the task's own tools run can read it; the token is valid only on this runtime's
 * loopback proxies and ends with the runtime.
 */
export const CODEX_PROXY_TOKEN_ENV = 'CINDY_CODEX_PROXY_TOKEN';

/**
 * 403, never 401: Codex reads a 401 as an expired login, refreshes the token against
 * the real OAuth endpoint and then reports the login invalid, which would suppress it.
 */
const REJECTION: InboundRejection = {
  status: 403,
  code: 'inbound_credentials_required',
  message: 'This local proxy only accepts requests from the Codex processes Cindy started.',
};

const sameToken = (candidate: string, expected: string): boolean => {
  const a = Buffer.from(candidate), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

type SpawnConfig = { extraArgs?: string[]; extraEnv?: Record<string, string> };

const BASE_URL_ARG = /^model_providers\.([A-Za-z0-9_-]+)\.base_url="([^"]*)"$/;

/**
 * The Host's Codex loopback proxies require inbound credentials: the per-runtime token
 * this runtime gives its own Codex processes, and nothing else (no gateway key, OAuth
 * token or provider placeholder on its own). Shared-provider guest tasks (remote tasks,
 * M3) run their Codex here too and carry the same header; verify that when they arrive.
 */
export function createCodexProxyInbound(isCurrent: () => boolean) {
  // 32 random bytes, kept only in memory; a new runtime (owner change) has a new one.
  const token = randomBytes(32).toString('base64url');
  /** Endpoints of proxies of this runtime that were running when the spawn config read them. */
  const running = new Set<string>();
  const ours = (url: string) => [...running].some(endpoint => url === endpoint || url.startsWith(endpoint.endsWith('/') ? endpoint : `${endpoint}/`));
  return {
    /** For tests and for this runtime's own requests to its proxies. */
    token: () => token,
    authorizeInbound(ctx: InboundAdmissionCtx): InboundRejection | null {
      // Never throws: the proxy package answers a throwing check with 401.
      try {
        if (!isCurrent()) return REJECTION;
        const value = ctx.headers[CODEX_PROXY_TOKEN_HEADER];
        if (typeof value !== 'string' || !sameToken(value, token)) return REJECTION;
        // Forwarded headers are this same object: the token never leaves the Host.
        delete (ctx.headers as Record<string, string>)[CODEX_PROXY_TOKEN_HEADER];
        return null;
      } catch {
        return REJECTION;
      }
    },
    /** Wraps a proxy endpoint read: only a running proxy's endpoint counts as ours. */
    track(url: string, isRunning: boolean): string {
      if (isRunning) running.add(url);
      return url;
    },
    /** Every model provider of a Codex spawn whose base_url is one of our proxies carries the token. */
    withToken<T extends SpawnConfig>(spawn: T): T {
      const args = spawn.extraArgs ?? [];
      const providers = new Set<string>();
      for (let i = 0; i + 1 < args.length; i++) {
        if (args[i] !== '-c') continue;
        const match = BASE_URL_ARG.exec(args[i + 1]!);
        if (match && ours(match[2]!)) providers.add(match[1]!);
      }
      if (providers.size === 0) return spawn;
      return {
        ...spawn,
        extraArgs: [...args, ...[...providers].flatMap(id =>
          ['-c', `model_providers.${id}.env_http_headers.${CODEX_PROXY_TOKEN_HEADER}="${CODEX_PROXY_TOKEN_ENV}"`])],
        extraEnv: { ...spawn.extraEnv, [CODEX_PROXY_TOKEN_ENV]: token },
      };
    },
  };
}
