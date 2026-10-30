import type { GhostSecretDecl } from '../../../shared/ghost.js';

const activeChecks = new Map<string, number>();
const LIMIT = 64 * 1024;
function atPath(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
async function jsonBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > LIMIT) throw new Error('large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

/** Candidate checks never write the vault or reuse the network slot's token cache. */
export async function checkGhostSecret(args: {
  instanceKey: string;
  secret: GhostSecretDecl;
  value: string;
  isCurrent: () => boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<{ status: number; body?: string }> {
  const { secret, value, isCurrent } = args;
  if (!secret.check || (secret.source && secret.source !== 'user')) return { status: 404 };
  if (!isCurrent()) return { status: 403 };
  if ((activeChecks.get(args.instanceKey) ?? 0) >= 2) return { status: 429 };
  activeChecks.set(args.instanceKey, (activeChecks.get(args.instanceKey) ?? 0) + 1);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref?.();
  const assertCurrent = () => { if (!isCurrent()) throw new Error('stale'); };
  const post = async (url: string, body: string, headers: Record<string, string>) => {
    assertCurrent();
    const response = await args.fetch(url, { method: 'POST', body, headers, redirect: 'manual', signal: controller.signal });
    assertCurrent();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream');
    }
    const result = await jsonBody(response);
    assertCurrent();
    return result;
  };
  try {
    let token = value;
    if (secret.exchange) {
      const ex = secret.exchange;
      const contentType = ex.contentType ?? 'application/json';
      const escaped = contentType === 'application/json' ? JSON.stringify(value).slice(1, -1) : encodeURIComponent(value);
      const data = await post(ex.url, ex.bodyFormat.replace('{value}', () => escaped), { 'Content-Type': contentType });
      const exchanged = atPath(data, ex.tokenPath);
      if (typeof exchanged !== 'string' || !exchanged || exchanged.length > LIMIT || /[\r\n]/.test(exchanged)) throw new Error('token');
      token = exchanged;
    }
    const check = secret.check;
    const data = await post(check.url, check.bodyFormat.replace('{value}', () => JSON.stringify(value).slice(1, -1)), {
      'Content-Type': 'application/json',
      [secret.inject.header]: secret.inject.format.replace('{value}', () => token),
    });
    const valid = atPath(data, check.validPath);
    if (typeof valid !== typeof check.validValue) throw new Error('shape');
    const result: { valid: boolean; expiresAt?: string } = { valid: valid === check.validValue };
    if (check.expiresAtPath) {
      const expiry = atPath(data, check.expiresAtPath);
      if (expiry !== undefined && expiry !== null) {
        let ms: number;
        if ((check.expiresAtFormat ?? 'iso') === 'iso') {
          if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiry)) throw new Error('date');
          ms = Date.parse(expiry);
        } else {
          if (typeof expiry !== 'number' || !Number.isFinite(expiry)) throw new Error('date');
          ms = expiry * (check.expiresAtFormat === 'unix-seconds' ? 1000 : 1);
        }
        if (!Number.isFinite(ms) || ms < 0 || ms > 253402300799999) throw new Error('date');
        result.expiresAt = new Date(ms).toISOString();
      }
    }
    const body = JSON.stringify(result);
    // Only locally constructed boolean/ISO fields leave this boundary. Substring
    // matching credentials against that JSON rejects valid short keys (e.g. 'true').
    return { status: 200, body };
  } catch {
    return { status: !isCurrent() ? 403 : controller.signal.aborted ? 504 : 502,
      body: JSON.stringify({ error: 'SECRET_CHECK_FAILED' }) };
  } finally {
    clearTimeout(timer);
    const count = (activeChecks.get(args.instanceKey) ?? 1) - 1;
    if (count) activeChecks.set(args.instanceKey, count); else activeChecks.delete(args.instanceKey);
  }
}
