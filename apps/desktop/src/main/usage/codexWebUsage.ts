import { net } from 'electron';

import { createLogger } from '../logger.js';
import type { CreditsSnapshot, RateLimitSnapshot, RateLimitWindow } from '../usageBroadcaster.js';

const log = createLogger('usage:codex-web');

const CODEX_WEB_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_WEB_USAGE_TIMEOUT_MS = 5000;

export class CodexWebUsageUnauthorizedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Codex web usage unauthorized (${status})`);
    this.name = 'CodexWebUsageUnauthorizedError';
    this.status = status;
  }
}

interface CodexWebUsageWindow {
  limit_window_seconds?: number;
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
}

interface CodexWebUsageResponse {
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: CodexWebUsageWindow;
    secondary_window?: CodexWebUsageWindow;
  };
  plan_type?: string | null;
  credits?: {
    balance?: number | string | null;
    has_credits?: boolean | number | string | null;
    unlimited?: boolean | number | string | null;
  } | null;
}

function clampPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function toRateLimitWindow(window: CodexWebUsageWindow | undefined): RateLimitWindow | null {
  if (!window) return null;
  const usedPercent = typeof window.used_percent === 'number'
    ? window.used_percent
    : Number(window.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const seconds = Number(window.limit_window_seconds);
  return {
    usedPercent: clampPercent(usedPercent),
    windowMinutes: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : undefined,
    resetsAt: typeof window.reset_at === 'number' && Number.isFinite(window.reset_at)
      ? window.reset_at
      : undefined,
  };
}

function normalizeCreditBalance(balance: number | string | null | undefined): string | null {
  if (typeof balance === 'number' && Number.isFinite(balance)) return String(balance);
  if (typeof balance !== 'string') return null;
  const trimmed = balance.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBoolean(value: boolean | number | string | null | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function normalizeCredits(
  credits: CodexWebUsageResponse['credits'],
): CreditsSnapshot | undefined {
  if (!credits) return undefined;
  const balance = normalizeCreditBalance(credits.balance);
  const explicitHasCredits = normalizeBoolean(credits.has_credits);
  const explicitUnlimited = normalizeBoolean(credits.unlimited);
  const unlimited = explicitUnlimited ?? false;

  if (!balance && explicitHasCredits === null && !unlimited) return undefined;

  return {
    hasCredits: explicitHasCredits ?? Boolean(balance || unlimited),
    unlimited,
    balance: balance ?? undefined,
  };
}

export function codexWebUsageResponseToSnapshot(
  data: CodexWebUsageResponse,
  now: number = Date.now(),
): RateLimitSnapshot | null {
  const primary = toRateLimitWindow(data.rate_limit?.primary_window);
  const secondary = toRateLimitWindow(data.rate_limit?.secondary_window);
  const credits = normalizeCredits(data.credits);

  if (!primary && !secondary && !data.plan_type && !credits) return null;

  return {
    primary,
    secondary,
    credits,
    planType: data.plan_type ?? undefined,
    rateLimitReachedType: data.rate_limit?.limit_reached ? 'rate_limit_reached' : null,
    source: 'openai-web',
    updatedAt: now,
  };
}

export async function fetchCodexWebUsageSnapshot(
  opts: {
    accessToken: string;
    accountId?: string | null;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<RateLimitSnapshot | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? CODEX_WEB_USAGE_TIMEOUT_MS,
  );
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.accessToken}`,
      Accept: 'application/json',
    };
    if (opts.accountId) headers['ChatGPT-Account-Id'] = opts.accountId;

    // Electron net.fetch uses Chromium's network stack, so it honors the
    // system proxy/PAC configuration. A bare Node fetch bypasses that stack;
    // on managed or poisoned-DNS networks it can resolve chatgpt.com to the
    // wrong host even while the desktop app's proxied requests work normally.
    const res = await (opts.fetchFn ?? net.fetch)(CODEX_WEB_USAGE_URL, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('codex web usage fetch failed', { status: res.status });
      if (res.status === 401 || res.status === 403) {
        throw new CodexWebUsageUnauthorizedError(res.status);
      }
      return null;
    }
    const data = await res.json() as CodexWebUsageResponse;
    const snapshot = codexWebUsageResponseToSnapshot(data);
    return snapshot ? { ...snapshot, accountId: opts.accountId ?? null } : null;
  } catch (err) {
    if (err instanceof CodexWebUsageUnauthorizedError) throw err;
    log.warn('codex web usage fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
