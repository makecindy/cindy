import { randomUUID } from 'node:crypto';

import {
  SETTINGS_SNAPSHOT_FRESHNESS_MS,
  SETTINGS_SNAPSHOT_MIN_WRITE_INTERVAL_MS,
  SETTINGS_SNAPSHOT_PUBLISH_INTERVAL_MS,
  settingsSnapshotDomainsSchema,
  settingsSnapshotAnyReportSchema,
  validateSettingsSnapshotBudget,
  type SettingsSnapshotDomains,
  type SettingsSnapshotReceipt,
  type SettingsSnapshotAnyReport,
} from '../../shared/settingsSnapshot.js';
import {
  settingsSnapshotCapabilitiesSchema,
  type SettingsSnapshotReportV2,
} from '../../shared/settingsSnapshotV2.js';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 4 * 1024;
const CHANGE_DEBOUNCE_MS = 750;
const CAPABILITIES_REFRESH_MS = 5 * 60_000;

/** 仅在调用时读取的认证上下文，不持久化、不回传、不写日志。 */
export interface SnapshotPublishContext {
  scopeKey: string;
  baseUrl: string;
  accessToken: string;
}
export type SnapshotPublishResult =
  | { status: 'published'; receipt: SettingsSnapshotReceipt }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'rateLimited'; retryAfterMs: number }
  | { status: 'unavailable' | 'invalid' };
export type SnapshotFetch = (url: string, init: RequestInit) => Promise<Response>;

/** 只追加固定业务路径，禁止凭据、查询、片段及非 HTTPS 地址。 */
export function settingsSnapshotPublishUrl(base: string): string | null {
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || base.includes('?') || base.includes('#')) return null;
    let end = url.pathname.length;
    while (end > 0 && url.pathname.charCodeAt(end - 1) === 0x2f) end -= 1;
    url.pathname = `${url.pathname.slice(0, end)}/instances/self/settings-snapshot`;
    return url.href;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 对端错误也不可信；流式限长，绝不把原文带入错误或日志。 */
async function readResponseJson(response: Response): Promise<unknown> {
  const size = Number(response.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** 只有明确缺少能力入口的旧端才降至 v1；鉴权或网络失败不触发另一种上报。 */
export async function getSettingsSnapshotProtocol(
  fetcher: SnapshotFetch,
  context: SnapshotPublishContext,
  signal: AbortSignal,
): Promise<1 | 2 | null> {
  const publishUrl = settingsSnapshotPublishUrl(context.baseUrl);
  if (!publishUrl || !context.accessToken) return null;
  try {
    const response = await fetcher(`${publishUrl}/capabilities`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${context.accessToken}` },
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return 1;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return null;
    }
    const parsed = settingsSnapshotCapabilitiesSchema.safeParse(await readResponseJson(response));
    if (!parsed.success) return null;
    return parsed.data.supportedVersions.some(version => version === 2) ? 2
      : parsed.data.supportedVersions.some(version => version === 1) ? 1 : null;
  } catch {
    return null;
  }
}

/** 无 Cookie、无跳转、无自动刷新凭据的窄上报 transport。 */
export async function postSettingsSnapshot(
  fetcher: SnapshotFetch,
  context: SnapshotPublishContext,
  report: SettingsSnapshotAnyReport,
  signal: AbortSignal,
): Promise<SnapshotPublishResult> {
  const url = settingsSnapshotPublishUrl(context.baseUrl);
  const parsedReport = settingsSnapshotAnyReportSchema.safeParse(report);
  if (!parsedReport.success || !url || !context.accessToken) return { status: 'invalid' };
  const body = JSON.stringify(parsedReport.data);
  if (!validateSettingsSnapshotBudget(parsedReport.data, Buffer.byteLength(body, 'utf8')).ok) {
    return { status: 'invalid' };
  }
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${context.accessToken}` },
      body,
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      return { status: 'rateLimited', retryAfterMs: Number.isFinite(seconds) && seconds > 0
        ? Math.min(600_000, Math.max(SETTINGS_SNAPSHOT_MIN_WRITE_INTERVAL_MS, seconds * 1000))
        : SETTINGS_SNAPSHOT_PUBLISH_INTERVAL_MS };
    }
    if (response.status !== 200 && response.status !== 409) {
      await response.body?.cancel();
      return { status: 'unavailable' };
    }
    const parsed = object(await readResponseJson(response));
    if (response.status === 409) {
      const error = object(parsed?.error);
      if (error?.code === 'SETTINGS_SNAPSHOT_REVISION_CONFLICT'
        && integer(error.currentRevision) && error.currentRevision < Number.MAX_SAFE_INTEGER) {
        return { status: 'conflict', currentRevision: error.currentRevision };
      }
      return { status: 'unavailable' };
    }
    if (!parsed || Object.keys(parsed).some(key => !['revision', 'receivedAtMs', 'expiresAtMs'].includes(key))
      || !integer(parsed.revision) || parsed.revision <= report.baseRevision
      || !integer(parsed.receivedAtMs) || !integer(parsed.expiresAtMs)
      || parsed.expiresAtMs <= parsed.receivedAtMs
      || parsed.expiresAtMs - parsed.receivedAtMs > SETTINGS_SNAPSHOT_FRESHNESS_MS) {
      return { status: 'invalid' };
    }
    return { status: 'published', receipt: {
      revision: parsed.revision, receivedAtMs: parsed.receivedAtMs, expiresAtMs: parsed.expiresAtMs,
    } };
  } catch {
    return { status: 'unavailable' };
  }
}

/** 可注入的单请求上报器：只保留“需重采样”意图，不保留或回放旧设置队列。 */
export function createSettingsSnapshotPublisher(deps: {
  getContext: () => SnapshotPublishContext | null;
  readDomains: () => SettingsSnapshotDomains;
  readV2?: () => Pick<SettingsSnapshotReportV2, 'fields' | 'collections'>;
  fetch: SnapshotFetch;
  now?: () => number;
  random?: () => number;
  reportId?: () => string;
  onResult?: (status: SnapshotPublishResult['status']) => void;
}): { start: () => void; stop: () => void; requestPublish: () => void } {
  const now = deps.now ?? Date.now;
  let active = false;
  let running = false;
  let dirty = false;
  let generation = 0;
  let scope: Pick<SnapshotPublishContext, 'scopeKey' | 'baseUrl'> | null = null;
  let revision = 0;
  let nextAllowedAt = 0;
  let protocol: { version: 1 | 2; expiresAt: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;

  function currentContext(): SnapshotPublishContext | null {
    try {
      const context = deps.getContext();
      return context && context.scopeKey && context.accessToken
        && settingsSnapshotPublishUrl(context.baseUrl) ? context : null;
    } catch {
      return null;
    }
  }
  function matches(context: SnapshotPublishContext | null): boolean {
    return context === null ? scope === null
      : scope?.scopeKey === context.scopeKey && scope.baseUrl === context.baseUrl;
  }
  function reconcile(context: SnapshotPublishContext | null): void {
    if (matches(context)) return;
    generation += 1;
    request?.abort();
    scope = context ? { scopeKey: context.scopeKey, baseUrl: context.baseUrl } : null;
    revision = 0;
    protocol = null;
    nextAllowedAt = 0;
    dirty = true;
  }
  function schedule(delay: number): void {
    if (!active || running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void run(); }, Math.max(0, delay, nextAllowedAt - now()));
    timer.unref?.();
  }
  async function run(): Promise<void> {
    if (!active || running) return;
    const context = currentContext();
    reconcile(context);
    if (!context) {
      dirty = false;
      schedule(SETTINGS_SNAPSHOT_PUBLISH_INTERVAL_MS);
      return;
    }
    running = true;
    dirty = false;
    const capturedGeneration = generation;
    const controller = new AbortController();
    request = controller;
    const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    nextAllowedAt = now() + SETTINGS_SNAPSHOT_MIN_WRITE_INTERVAL_MS;
    let result: SnapshotPublishResult = { status: 'invalid' };
    try {
      const current = () => active && capturedGeneration === generation
        && matches(currentContext()) && !controller.signal.aborted;
      let version: 1 | 2 | null = 1;
      if (deps.readV2) {
        if (!protocol || protocol.expiresAt <= now()) {
          version = await getSettingsSnapshotProtocol(deps.fetch, context, controller.signal);
          if (!current()) return;
          protocol = version === null ? null : { version, expiresAt: now() + CAPABILITIES_REFRESH_MS };
        } else {
          version = protocol.version;
        }
      }
      let report: SettingsSnapshotAnyReport | null = null;
      if (version === 2 && deps.readV2) {
        const values = deps.readV2();
        report = {
          schemaVersion: 2, reportId: (deps.reportId ?? randomUUID)(), baseRevision: revision,
          capturedAtMs: now(), fields: values.fields, collections: values.collections,
        };
      } else if (version === 1) {
        const domains = settingsSnapshotDomainsSchema.safeParse(deps.readDomains());
        if (domains.success) report = {
          schemaVersion: 1, reportId: (deps.reportId ?? randomUUID)(), baseRevision: revision,
          capturedAtMs: now(), domains: domains.data,
        };
      } else {
        result = { status: 'unavailable' };
      }
      if (report && current()) {
        result = await postSettingsSnapshot(deps.fetch, context, report, controller.signal);
      }
      if (!current()) return;
      if (result.status === 'published') revision = result.receipt.revision;
      if (result.status === 'conflict') {
        revision = result.currentRevision;
        dirty = true;
      }
      if (result.status === 'rateLimited') nextAllowedAt = now() + result.retryAfterMs;
      // 观察者只收到分类，不拿到 payload、身份或异常；异常不得打断后台上报。
      try { deps.onResult?.(result.status); } catch { /* 不传播观察者异常。 */ }
    } catch {
      // 投影读失败不影响设置写入与任务运行，下一轮重新采样。
    } finally {
      clearTimeout(deadline);
      if (request === controller) request = null;
      running = false;
      const jitter = Math.max(0, Math.min(1, (deps.random ?? Math.random)())) * 6_000;
      schedule(dirty ? CHANGE_DEBOUNCE_MS : SETTINGS_SNAPSHOT_PUBLISH_INTERVAL_MS + jitter);
    }
  }
  function requestPublish(): void {
    if (!active) return;
    reconcile(currentContext());
    dirty = true;
    schedule(CHANGE_DEBOUNCE_MS);
  }
  return {
    start() {
      if (active) return;
      active = true;
      reconcile(currentContext());
      schedule(0);
    },
    stop() {
      active = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = undefined;
      request?.abort();
      scope = null;
      protocol = null;
      revision = 0;
    },
    requestPublish,
  };
}
