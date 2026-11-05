import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isPrHost } from '@cindy/maker-shared';

export type GlabTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'glab-missing' | 'glab-not-logged-in' | 'no-token' };

export function systemGlabBinary(
  platform = process.platform,
  exists = existsSync,
  home = homedir(),
): string {
  const candidates =
    platform === 'win32'
      ? [
          path.join('C:\\', 'Program Files', 'glab', 'glab.exe'),
          path.join(home, '.local', 'bin', 'glab.exe'),
        ]
      : [
          platform === 'darwin' ? '/opt/homebrew/bin/glab' : '/usr/bin/glab',
          '/usr/local/bin/glab',
          '/home/linuxbrew/.linuxbrew/bin/glab',
          path.join(home, '.local', 'bin', 'glab'),
        ];
  return candidates.find(exists) ?? (platform === 'win32' ? 'glab.exe' : 'glab');
}

export function createGlabCliTokenSource(
  deps: {
    exec?: typeof execFile;
    binary?: () => string;
    now?: () => number;
  } = {},
) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { result: GlabTokenResult; until: number }>();
  const inflight = new Map<string, Promise<GlabTokenResult>>();
  let generation = 0;
  const invalidate = () => {
    generation++;
    cache.clear();
    inflight.clear();
  };
  return {
    invalidate,
    invalidateNegativeCache() {
      for (const [host, entry] of cache) {
        if (!entry.result.ok) cache.delete(host);
      }
    },
    rejectToken(host: string) {
      cache.set(host.toLowerCase(), {
        result: { ok: false, reason: 'glab-not-logged-in' },
        until: now() + 30_000,
      });
    },
    async readTokenDetailed(host: string): Promise<GlabTokenResult> {
      if (!isPrHost(host)) return { ok: false, reason: 'no-token' };
      host = host.toLowerCase();
      const cached = cache.get(host);
      if (cached && cached.until > now()) return cached.result;
      if (inflight.has(host)) return inflight.get(host)!;
      const gen = generation;
      const promise = new Promise<GlabTokenResult>((resolve) => {
        // CLI overrides must not leak another host's token into this host's lookup.
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              ![
                'GLAB_TOKEN',
                'GITLAB_TOKEN',
                'GITLAB_ACCESS_TOKEN',
                'OAUTH_TOKEN',
                'GITLAB_HOST',
                'GL_HOST',
              ].includes(key.toUpperCase()),
          ),
        );
        try {
          (deps.exec ?? execFile)(
            (deps.binary ?? systemGlabBinary)(),
            ['config', 'get', 'token', '--host', host],
            { timeout: 3_000, env },
            (error, stdout) => {
              if (error) {
                const code = (error as NodeJS.ErrnoException).code;
                resolve({
                  ok: false,
                  reason:
                    code === 'ENOENT'
                      ? 'glab-missing'
                      : typeof code === 'string'
                        ? 'no-token'
                        : 'glab-not-logged-in',
                });
                return;
              }
              const token = String(stdout).trim();
              resolve(token ? { ok: true, token } : { ok: false, reason: 'glab-not-logged-in' });
            },
          );
        } catch {
          resolve({ ok: false, reason: 'no-token' });
        }
      })
        .then((result) => {
          if (gen === generation) {
            if (cache.size >= 200) cache.delete(cache.keys().next().value!);
            cache.set(host, { result, until: now() + (result.ok ? 300_000 : 30_000) });
          }
          return result;
        })
        .finally(() => {
          if (inflight.get(host) === promise) inflight.delete(host);
        });
      inflight.set(host, promise);
      return promise;
    },
  };
}

export const glabCliTokenSource = createGlabCliTokenSource();
