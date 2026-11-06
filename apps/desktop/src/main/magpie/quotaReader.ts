/**
 * Magpie upstream quota reader: one loopback GET per gateway, mapped to panel accounts.
 *
 * Security boundary: the response is upstream data. Cindy logs and throws with the origin
 * and HTTP status only — never bodies, never the upstream `user` (email), never the
 * upstream `error` string (it embeds the account email). Account identity is a hash, so
 * nothing reversible reaches disk, logs or the panel. No Authorization header is sent;
 * Magpie serves loopback reads without one.
 */

import { createHash } from 'node:crypto';

import { isLoopbackProviderUrl } from '@cindy/model-providers';

import {
  parseMagpieQuotaEnvelope,
  type MagpieQuotaAccount,
  type MagpieQuotaAccountRaw,
  type MagpieQuotaWindow,
  type MagpieQuotaWindowRaw,
} from '../../shared/magpieQuota.js';

export const MAGPIE_QUOTAS_PATH = '/v1/magpie/quotas';
export const MAGPIE_QUOTA_TIMEOUT_MS = 5_000;
/**
 * The gateway answers `/v1/magpie/quotas` from cache in ~130 ms, but a cold read
 * (upstream quota windows refreshed synchronously) was measured at ~8 s. Callers that
 * keep a last-good reading and can afford one slow first read should use this budget;
 * the short default stays for probes that must not block a panel rebuild.
 */
export const MAGPIE_QUOTA_COLD_READ_TIMEOUT_MS = 15_000;
export const MAGPIE_QUOTA_MAX_BODY_BYTES = 1024 * 1024;

export interface MagpieQuotaRead {
  /** The origin answered, but it is not a Magpie gateway (404 or a non-Magpie body). */
  notMagpie: boolean;
  accounts: MagpieQuotaAccount[];
}

export interface MagpieQuotaReaderDeps {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * Reads every upstream account of one Magpie gateway. Throws on unreachable, timeout,
 * non-2xx (except 404) and oversized/malformed-list responses; callers keep their last
 * good reading then. A 404 or non-Magpie body resolves with `notMagpie` so the caller can
 * memoize the verdict and other loopback proxies cost one probe.
 */
export async function readMagpieQuotas(
  providerId: string,
  origin: string,
  deps: MagpieQuotaReaderDeps = {},
): Promise<MagpieQuotaRead> {
  if (!isLoopbackProviderUrl(origin)) throw new Error('magpie quota origin is not loopback');
  const url = `${new URL(origin).origin}${MAGPIE_QUOTAS_PATH}`;
  const doFetch = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(deps.timeoutMs ?? MAGPIE_QUOTA_TIMEOUT_MS),
    });
  } catch {
    // Message stays generic: connect errors can quote upstream details.
    throw new Error('magpie quota gateway unreachable');
  }
  if (response.status === 404) return { notMagpie: true, accounts: [] };
  if (!response.ok) throw new Error(`magpie quota read failed with status ${response.status}`);
  const text = await readBodyWithCap(response, deps.maxBodyBytes ?? MAGPIE_QUOTA_MAX_BODY_BYTES);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { notMagpie: true, accounts: [] };
  }
  const parsed = parseMagpieQuotaEnvelope(json);
  if (!parsed.ok) return { notMagpie: true, accounts: [] };
  return { notMagpie: false, accounts: parsed.accounts.map((raw) => magpieAccountFrom(providerId, raw, nowMs)) };
}

async function readBodyWithCap(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw new Error('magpie quota response unavailable');
    });
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('magpie quota response is too large');
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/**
 * Stable account id. Magpie has no per-account key (contract gap: it should add
 * `accountKey`), so the id is a hash of everything that distinguishes two accounts on one
 * gateway. The upstream email only ever enters the hash, never the id text or the panel.
 */
export function magpieAccountId(providerId: string, raw: MagpieQuotaAccountRaw): string {
  const parts = [raw.provider, raw.user, raw.alias, raw.name, raw.from].map((value) =>
    typeof value === 'string' ? value : '',
  );
  const hash = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
  return `magpie:${providerId}:${hash}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoMs(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const HOURS_NAME = /^(\d+)\s*hours?$/i;
const DAYS_NAME = /^(\d+)\s*days?$/i;

/**
 * One upstream window. "N hours" reads as a session window and "N days" as a weekly one,
 * so the tubes compare like with like; everything else ("Credits", model-family names)
 * keeps Magpie's label verbatim as a `named` window. `pool` windows are per-model and map
 * to `scoped`. A reset that already passed is dropped: the percentage is on its own until
 * the next read.
 */
export function magpieWindowFrom(raw: unknown, nowMs: number): MagpieQuotaWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const window = raw as MagpieQuotaWindowRaw;
  const name = str(window.name) ?? '';
  let usedPercent: number;
  if (window.unlimited === true) {
    usedPercent = 0;
  } else {
    const remaining = num(window.remaining);
    const used = num(window.used);
    const value = remaining !== null ? 100 - remaining : used;
    if (value === null) return null;
    usedPercent = Math.min(100, Math.max(0, value));
  }
  const hours = HOURS_NAME.exec(name);
  const days = hours ? null : DAYS_NAME.exec(name);
  const kind = window.pool === true
    ? 'scoped'
    : hours ? 'session' : days ? 'week' : 'named';
  const windowMinutes = hours
    ? Number(hours[1]) * 60
    : days
      ? Number(days[1]) * 1440
      : 0;
  const resetsAtMs = isoMs(window.resetsAt);
  return {
    kind,
    label: kind === 'session' || kind === 'week' ? null : (name || null),
    display: str(window.display),
    usedPercent,
    resetsAtMs: resetsAtMs !== null && resetsAtMs > nowMs ? resetsAtMs : null,
    windowMinutes,
  };
}

/**
 * One upstream account. An account Magpie could not read (`error`) becomes
 * `needs-sign-in` with no windows; the upstream error text is dropped here and never
 * travels onward. An account without windows but with a balance keeps the balance string
 * verbatim for the detail facts only.
 */
export function magpieAccountFrom(
  providerId: string,
  raw: MagpieQuotaAccountRaw,
  nowMs: number,
): MagpieQuotaAccount {
  const hasError = raw.error !== null && raw.error !== undefined && raw.error !== '';
  const rawWindows = !hasError && Array.isArray(raw.windows) ? raw.windows : [];
  const windows = rawWindows
    .map((window) => magpieWindowFrom(window, nowMs))
    .filter((window): window is MagpieQuotaWindow => window !== null);
  // The display name never falls back to `user`: that is the upstream email.
  const name = str(raw.alias) ?? str(raw.name) ?? str(raw.provider) ?? '';
  const balanceText = windows.length === 0
    ? (str(raw.balance) ?? (num(raw.balance) !== null ? String(raw.balance) : null))
    : null;
  const asOf = isoMs(raw.asOf);
  const readAt = isoMs(raw.readAt);
  return {
    kind: 'magpie',
    id: magpieAccountId(providerId, raw),
    providerId,
    provider: str(raw.provider)?.toLowerCase() ?? '',
    name,
    plan: str(raw.plan),
    windows,
    balanceText,
    status: hasError ? 'needs-sign-in' : windows.length === 0 ? 'no-windows' : 'ok',
    observedAtMs: asOf !== null && readAt !== null ? Math.max(asOf, readAt) : (asOf ?? readAt),
    staleAtMs: null,
  };
}
