import { isPrHost } from '@cindy/maker-shared';
import type { GlabTokenResult } from './glabCliTokenSource';

interface GlabSource {
  readTokenDetailed(host: string): Promise<GlabTokenResult>;
  rejectToken(host: string): void;
  invalidateNegativeCache(): void;
}

/**
 * GitLab MR status reads: the local glab sign-in first, then the account the user connected
 * for the same instance in the GitLab plugin. The plugin token is only read here, per host,
 * for read-only merge request status; it is never written back or handed to anything else.
 */
export function createGitlabTokenChain(deps: {
  glab: GlabSource;
  pluginToken: (host: string) => string | null;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** Which source answered last per host, so a 401 retires that source only. */
  const lastSource = new Map<string, 'glab' | 'plugin'>();
  const pluginRejectedUntil = new Map<string, number>();
  const remember = (host: string, source: 'glab' | 'plugin') => {
    if (lastSource.size >= 200 && !lastSource.has(host)) lastSource.delete(lastSource.keys().next().value!);
    lastSource.set(host, source);
  };
  return {
    async readTokenDetailed(rawHost: string): Promise<GlabTokenResult> {
      const host = rawHost.toLowerCase();
      const glab = await deps.glab.readTokenDetailed(host);
      if (glab.ok) {
        remember(host, 'glab');
        return glab;
      }
      if (!isPrHost(host)) return glab;
      if ((pluginRejectedUntil.get(host) ?? 0) <= now()) {
        pluginRejectedUntil.delete(host);
        let token: string | null = null;
        try {
          token = deps.pluginToken(host)?.trim() || null;
        } catch {
          token = null;
        }
        if (token) {
          remember(host, 'plugin');
          return { ok: true, token };
        }
      }
      return glab;
    },
    rejectToken(rawHost: string): void {
      const host = rawHost.toLowerCase();
      if (lastSource.get(host) === 'plugin') {
        if (pluginRejectedUntil.size >= 200) pluginRejectedUntil.delete(pluginRejectedUntil.keys().next().value!);
        pluginRejectedUntil.set(host, now() + 30_000);
      } else {
        deps.glab.rejectToken(host);
      }
    },
    invalidateNegativeCache(): void {
      pluginRejectedUntil.clear();
      deps.glab.invalidateNegativeCache();
    },
  };
}

let pluginTokenResolver: ((host: string) => string | null) | null = null;

/** Registered by the plugin runtime once it is up; git-context never imports it directly. */
export function setGitlabPluginTokenResolver(next: ((host: string) => string | null) | null): void {
  pluginTokenResolver = next;
}

export function gitlabPluginToken(host: string): string | null {
  return pluginTokenResolver?.(host) ?? null;
}
