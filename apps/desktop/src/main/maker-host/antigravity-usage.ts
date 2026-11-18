import fs from 'node:fs';
import type { SubscriptionCodexUsageBucket } from '../../shared/subscriptionAccounts.js';

const LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const MAX_TOKEN_FILE_BYTES = 32 * 1024;
const CACHE_MS = 3 * 60_000;

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function readAntigravityToken(tokenPath: string) {
  try {
    // The CLI owns this file. Never follow a substituted symlink or copy its credentials.
    const fd = fs.openSync(tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || stat.size > MAX_TOKEN_FILE_BYTES) return null;
      const bytes = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
      const read = fs.readSync(fd, bytes);
      if (read > MAX_TOKEN_FILE_BYTES) return null;
      const value = record(JSON.parse(bytes.toString('utf8', 0, read)));
      const token = record(value.token);
      return {
        fileVersion: [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.size].join(':'),
        identity: typeof value.id_token_email === 'string' ? value.id_token_email.slice(0, 254) : undefined,
        accessToken: typeof token.access_token === 'string' && /^[!-~]+$/.test(token.access_token) ? token.access_token : undefined,
        expiresAt: typeof token.expiry === 'string' ? Date.parse(token.expiry) : 0,
      };
    } finally { fs.closeSync(fd); }
  } catch {
    return null;
  }
}

export function parseAntigravityQuota(raw: unknown, now: number): SubscriptionCodexUsageBucket[] {
  const { groups } = record(raw);
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, 64).flatMap((value, index) => {
    const group = record(value);
    if (!Array.isArray(group.buckets)) return [];
    let primary: SubscriptionCodexUsageBucket['primary'] = null;
    let secondary: SubscriptionCodexUsageBucket['secondary'] = null;
    for (const value of group.buckets) {
      const bucket = record(value);
      if (bucket.disabled === true) continue;
      const label = [bucket.window, bucket.displayName].filter(value => typeof value === 'string').join(' ');
      const weekly = /week/i.test(label);
      if (!weekly && bucket.window !== 'session' && !/\b5\s*-?\s*h|five.?hour/i.test(label)) continue;
      const reset = typeof bucket.resetTime === 'string' ? Date.parse(bucket.resetTime) : NaN;
      const fraction = bucket.remainingFraction ?? (Number.isFinite(reset) && bucket.remainingAmount === undefined ? 0 : null);
      if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const window = {
        usedPercent: 100 - fraction * 100, windowMinutes: weekly ? 10_080 : 300,
        resetsAt: Number.isFinite(reset) ? Math.floor(reset / 1000) : null,
      };
      if (weekly) {
        if (window.usedPercent > (secondary?.usedPercent ?? -1)) secondary = window;
      } else if (window.usedPercent > (primary?.usedPercent ?? -1)) primary = window;
    }
    if (!primary && !secondary) return [];
    return [{
      limitId: String(index),
      limitName: typeof group.displayName === 'string' ? group.displayName.slice(0, 160) : null,
      updatedAt: now, primary, secondary,
    }];
  });
}

/** Coalesce reads for the active owner and token across settings and the status card. */
export function createAntigravityUsageReader(fetcher: typeof fetch = fetch) {
  let cached: { key: string; until: number; result: Promise<SubscriptionCodexUsageBucket[]> } | undefined;
  return async (tokenPath: string, scope: number, signal: AbortSignal, assertCurrent: () => void): Promise<SubscriptionCodexUsageBucket[]> => {
    assertCurrent();
    const token = readAntigravityToken(tokenPath);
    const now = Date.now();
    if (!token?.accessToken || !(token.expiresAt > now + 60_000)) return [];
    const key = [tokenPath, token.fileVersion, scope].join('\0');
    if (cached?.key !== key || cached.until <= now) {
      const result = (async () => {
        const request = async (url: string, body: object) => {
          assertCurrent();
          if (readAntigravityToken(tokenPath)?.fileVersion !== token.fileVersion) return null;
          const response = await fetcher(url, {
            method: 'POST', body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': `antigravity/2.31.0 ${process.platform}/${process.arch}`,
            },
          });
          if (!response.ok) return null;
          return response.json() as Promise<unknown>;
        };
        const project = record(await request(LOAD_URL, {})).cloudaicompanionProject;
        if (typeof project !== 'string' || project.length > 256 || !project) return [];
        return parseAntigravityQuota(await request(QUOTA_URL, { project }), Date.now());
      })().catch(() => []);
      cached = { key, until: Math.min(token.expiresAt - 60_000, now + CACHE_MS), result };
    }
    const result = await cached.result;
    assertCurrent();
    return readAntigravityToken(tokenPath)?.fileVersion === token.fileVersion ? result : [];
  };
}
