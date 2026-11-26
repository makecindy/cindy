import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isPrHost } from '@cindy/maker-shared';

export type GlabTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'glab-missing' | 'glab-not-logged-in' | 'no-token' };

const GLAB_CONFIG_MAX_BYTES = 64 * 1024;
const GLAB_MAX_CONFIG_HOSTS = 16;

export function glabConfigPaths(
  platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const custom = env.GLAB_CONFIG_DIR?.trim();
  if (custom) return [path.join(custom, 'config.yml')];
  const out: string[] = [];
  const push = (dir: string) => {
    const file = path.join(dir, 'glab-cli', 'config.yml');
    if (!out.includes(file)) out.push(file);
  };
  if (env.XDG_CONFIG_HOME?.trim()) push(env.XDG_CONFIG_HOME.trim());
  if (platform === 'darwin') push(path.join(home, 'Library', 'Application Support'));
  else if (platform === 'win32') push(env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming'));
  push(path.join(home, '.config'));
  return out;
}

/**
 * Extract HTTPS hostnames declared under top-level `hosts:` in glab's config.yml.
 * Never reads tokens from YAML (modern glab uses OS keyring); callers verify live
 * login state per host via `readTokenDetailed`.
 */
export function parseGlabConfigHosts(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const hosts: string[] = [];
  let inHosts = false;
  let hostIndent: number | null = null;
  let currentHost: string | null = null;
  let currentHttpOnly = false;
  const flush = () => {
    if (
      currentHost &&
      !currentHttpOnly &&
      !currentHost.includes('*') &&
      !currentHost.includes(':') &&
      isPrHost(currentHost) &&
      !hosts.includes(currentHost) &&
      hosts.length < GLAB_MAX_CONFIG_HOSTS
    ) {
      hosts.push(currentHost);
    }
    currentHost = null;
    currentHttpOnly = false;
  };
  for (const line of lines) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (!inHosts) {
      if (/^hosts:\s*(?:#.*)?$/.test(line)) inHosts = true;
      continue;
    }
    if (/^\S/.test(line)) {
      flush();
      break;
    }
    const indent = /^(\s+)/.exec(line)?.[1]?.length ?? 0;
    if (hostIndent === null) hostIndent = indent;
    if (indent === hostIndent) {
      flush();
      const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:#]+))\s*:\s*(?:#.*)?$/.exec(line);
      const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim().toLowerCase();
      currentHost = raw || null;
      continue;
    }
    if (currentHost && indent > hostIndent) {
      const proto = /^\s*api_protocol\s*:\s*['"]?([a-z]+)['"]?\s*(?:#.*)?$/i.exec(line)?.[1]?.toLowerCase();
      if (proto && proto !== 'https') currentHttpOnly = true;
    }
  }
  flush();
  return hosts;
}

function readConfiguredGlabHostsDefault(): string[] {
  const seen: string[] = [];
  for (const file of glabConfigPaths()) {
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > GLAB_CONFIG_MAX_BYTES) continue;
      for (const host of parseGlabConfigHosts(readFileSync(file, 'utf8'))) {
        if (!seen.includes(host) && seen.length < GLAB_MAX_CONFIG_HOSTS) seen.push(host);
      }
    } catch {
      // Missing or unreadable config file is normal when glab is not configured.
    }
  }
  return seen;
}

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
    configuredHosts?: () => readonly string[];
    now?: () => number;
  } = {},
) {
  const now = deps.now ?? Date.now;
  const configuredHosts = deps.configuredHosts ?? readConfiguredGlabHostsDefault;
  const cache = new Map<string, { result: GlabTokenResult; until: number }>();
  const inflight = new Map<string, Promise<GlabTokenResult>>();
  let generation = 0;
  const invalidate = () => {
    generation++;
    cache.clear();
    inflight.clear();
  };
  const readTokenDetailed = async (host: string): Promise<GlabTokenResult> => {
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
    readTokenDetailed,
    async listLoggedInHosts(): Promise<string[]> {
      let candidates: readonly string[];
      try {
        candidates = configuredHosts();
      } catch {
        return [];
      }
      if (!candidates.length) return [];
      const checks = await Promise.all(
        candidates.slice(0, GLAB_MAX_CONFIG_HOSTS).map(async (raw) => {
          const host = raw.trim().toLowerCase();
          if (!host || host.includes('*') || host.includes(':') || !isPrHost(host)) return null;
          return (await readTokenDetailed(host)).ok ? host : null;
        }),
      );
      return checks.filter((host): host is string => host !== null);
    },
  };
}

export const glabCliTokenSource = createGlabCliTokenSource();
