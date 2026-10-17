/**
 * gatewayKeyRejection 单测:Cindy AI Key 被网关 401 后的统一上报入口(依赖全注入)。
 * 覆盖:各「直接跳过」条件、规则 A(只认当前 Key)、规则 B(每把 Key 只触发一次)、
 * sync 失败不外冒、单例安装/卸载,以及 fetch 包装从 Authorization 头取 Key。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// 单例的默认依赖(仅 singleton 用例经 install 使用;工厂用例全部显式注入)。
const defaults = vi.hoisted(() => ({
  canUseCindyGateway: true,
  boundaryPending: false,
  source: 'server' as 'server' | 'manual' | null,
  currentKey: null as string | null,
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: defaults.canUseCindyGateway }),
}));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: () => defaults.boundaryPending,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: (id: string) => (id === 'xd' ? defaults.currentKey : null) }),
}));
vi.mock('../credentialsStore.js', () => ({
  getModelAccessCredentialsStore: () => ({ getSource: () => defaults.source }),
}));

import {
  bearerKeyFromHeaders,
  createGatewayKeyRejectionReporter,
  CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS,
  installCindyGatewayKeyRejectionReporter,
  reportCindyGatewayKeyRejected,
  reportCindyGatewayKeyRejectedForCurrentKey,
  withCindyGatewayKeyRejectionReport,
  type GatewayKeyRejectionDeps,
} from '../gatewayKeyRejection.js';

const KEY_A = 'sk-test-invalid-a';
const KEY_B = 'sk-test-invalid-b';

function harness(overrides: Partial<GatewayKeyRejectionDeps> = {}) {
  let currentKey: string | null = KEY_A;
  let clock = 1_000_000;
  const requestSync = vi.fn(async () => undefined);
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: GatewayKeyRejectionDeps = {
    canUseCindyGateway: () => true,
    isSessionBoundaryPending: () => false,
    getCredentialSource: () => 'server',
    readCurrentKey: () => currentKey,
    requestSync,
    log,
    now: () => clock,
    ...overrides,
  };
  const reporter = createGatewayKeyRejectionReporter(deps);
  return {
    report: reporter.reportUsedKey,
    reportCurrent: reporter.reportCurrentKey,
    requestSync: (overrides.requestSync as typeof requestSync | undefined) ?? requestSync,
    log,
    setCurrentKey: (key: string | null) => {
      currentKey = key;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const WINDOW = CINDY_KEY_REJECTION_RETRIGGER_WINDOW_MS;

describe('createGatewayKeyRejectionReporter', () => {
  it('re-syncs once when the current server-issued key is rejected', () => {
    const h = harness();
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    expect(h.log.info).toHaveBeenCalledWith('Cindy AI key rejected by gateway, re-syncing credentials');
    // 日志不得带 Key 本身。
    for (const call of [...h.log.info.mock.calls, ...h.log.warn.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(KEY_A);
    }
  });

  it.each([
    ['gateway capability is unavailable', { canUseCindyGateway: () => false }],
    ['an account switch is pending', { isSessionBoundaryPending: () => true }],
    ['the key was entered manually', { getCredentialSource: () => 'manual' as const }],
    ['the key has no source marker', { getCredentialSource: () => null }],
  ])('skips when %s', (_label, overrides) => {
    const h = harness(overrides);
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ''])('skips an empty used key (%s)', (usedKey) => {
    const h = harness();
    h.report(usedKey);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it('ignores a rejection for a key that is no longer the stored key (rule A)', () => {
    const h = harness();
    h.setCurrentKey(KEY_B);
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
    h.setCurrentKey(null);
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it('triggers at most once per key within the window, and again after it (rule B)', () => {
    const h = harness();
    h.report(KEY_A);
    h.advance(WINDOW - 1);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    // 同步失败(failed resolve)或服务端暂时原样返回旧 Key 后,窗口过去即可自行恢复。
    h.advance(1);
    h.report(KEY_A);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(2);
  });

  it('treats a clock moved backwards as an expired window', () => {
    const h = harness();
    h.report(KEY_A);
    h.advance(-1);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(2);
  });

  it('triggers once per key and again after the key changes (rule B)', () => {
    const h = harness();
    h.report(KEY_A);
    h.report(KEY_A);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);

    h.setCurrentKey(KEY_B);
    h.report(KEY_B);
    h.report(KEY_B);
    expect(h.requestSync).toHaveBeenCalledTimes(2);

    // 换回旧 Key 时与「上一次」不同,允许再触发。
    h.setCurrentKey(KEY_A);
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(3);
  });

  it('does not remember a key whose report was skipped', () => {
    let pending = true;
    const h = harness({ isSessionBoundaryPending: () => pending });
    h.report(KEY_A);
    expect(h.requestSync).not.toHaveBeenCalled();
    pending = false;
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected sync', async () => {
    const requestSync = vi.fn(async () => {
      throw new Error('network down');
    });
    const h = harness({ requestSync });
    expect(() => h.report(KEY_A)).not.toThrow();
    await vi.waitFor(() => expect(h.log.warn).toHaveBeenCalledTimes(1));
  });

  it('swallows a synchronously throwing dependency', () => {
    const h = harness({
      requestSync: () => {
        throw new Error('sync unavailable');
      },
      readCurrentKey: () => KEY_A,
    });
    expect(() => h.report(KEY_A)).not.toThrow();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('reportCurrentKey (agent turns that do not reveal the key they used)', () => {
  it('re-syncs without consuming the accurate report for the current key', () => {
    const h = harness();
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    // 未占用机会:同一把 Key 的准确上报仍可触发一次。
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(2);
    for (const call of [...h.log.info.mock.calls, ...h.log.warn.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(KEY_A);
    }
  });

  it('triggers only once per current key across repeated agent failures', () => {
    const h = harness();
    h.reportCurrent();
    h.reportCurrent();
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });

  it('applies the same window to repeated agent failures', () => {
    const h = harness();
    h.reportCurrent();
    h.advance(WINDOW - 1);
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.reportCurrent();
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(2);
  });

  it('lets an accurate report re-trigger only after its own window', () => {
    const h = harness();
    h.report(KEY_A);
    h.reportCurrent(); // 准确上报的窗口内:跳过
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.advance(WINDOW);
    h.reportCurrent(); // 窗口已过:智能体路径可再触发
    h.report(KEY_A); // 智能体路径没占用准确上报的机会
    expect(h.requestSync).toHaveBeenCalledTimes(3);
  });

  it('can trigger again once the current key changes', () => {
    const h = harness();
    h.reportCurrent();
    h.setCurrentKey(KEY_B);
    h.reportCurrent();
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(2);
  });

  it('skips once the current key was already re-synced by an accurate report', () => {
    const h = harness();
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.reportCurrent();
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['gateway capability is unavailable', { canUseCindyGateway: () => false }],
    ['an account switch is pending', { isSessionBoundaryPending: () => true }],
    ['the key was entered manually', { getCredentialSource: () => 'manual' as const }],
    ['there is no current key', { readCurrentKey: () => null }],
  ])('skips when %s', (_label, overrides) => {
    const h = harness(overrides);
    h.reportCurrent();
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it('never lets stale agent failures consume a new key\'s single accurate trigger', () => {
    const h = harness();
    // 1. 准确上报 K1,触发同步。
    h.report(KEY_A);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    // 2. 同步写入 K2。
    h.setCurrentKey(KEY_B);
    // 3. 仍带旧 Key 的智能体回合失败若干次:只同步 1 次,且不标记准确上报的 K2 记录。
    h.reportCurrent();
    h.reportCurrent();
    h.reportCurrent();
    expect(h.requestSync).toHaveBeenCalledTimes(2);
    // 4. K2 真正失效时的准确上报仍触发一次。
    h.report(KEY_B);
    expect(h.requestSync).toHaveBeenCalledTimes(3);
    h.report(KEY_B);
    expect(h.requestSync).toHaveBeenCalledTimes(3);
  });

  it('swallows a rejected or throwing sync', async () => {
    const requestSync = vi.fn(async () => {
      throw new Error('network down');
    });
    const h = harness({ requestSync });
    expect(() => h.reportCurrent()).not.toThrow();
    await vi.waitFor(() => expect(h.log.warn).toHaveBeenCalledTimes(1));

    const t = harness({
      requestSync: () => {
        throw new Error('sync unavailable');
      },
    });
    expect(() => t.reportCurrent()).not.toThrow();
    expect(t.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('reportCindyGatewayKeyRejected singleton', () => {
  afterEach(() => installCindyGatewayKeyRejectionReporter(null));

  it('is a no-op before model-access installs a reporter', () => {
    expect(() => reportCindyGatewayKeyRejected(KEY_A)).not.toThrow();
  });

  it('wires both entries to the default local dependencies and the installed sync', () => {
    Object.assign(defaults, { canUseCindyGateway: true, boundaryPending: false, source: 'server', currentKey: KEY_A });
    const requestSync = vi.fn(async () => undefined);
    installCindyGatewayKeyRejectionReporter(requestSync);

    reportCindyGatewayKeyRejectedForCurrentKey();
    expect(requestSync).toHaveBeenCalledTimes(1);
    reportCindyGatewayKeyRejected(KEY_B); // 规则 A:不是当前 Key
    expect(requestSync).toHaveBeenCalledTimes(1);
    reportCindyGatewayKeyRejected(KEY_A);
    reportCindyGatewayKeyRejected(KEY_A);
    expect(requestSync).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['gateway capability is unavailable', { canUseCindyGateway: false }],
    ['an account switch is pending', { boundaryPending: true }],
    ['the key was entered manually', { source: 'manual' as const }],
  ])('default dependencies skip when %s', (_label, overrides) => {
    Object.assign(defaults, { canUseCindyGateway: true, boundaryPending: false, source: 'server', currentKey: KEY_A }, overrides);
    const requestSync = vi.fn(async () => undefined);
    installCindyGatewayKeyRejectionReporter(requestSync);
    reportCindyGatewayKeyRejected(KEY_A);
    reportCindyGatewayKeyRejectedForCurrentKey();
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('uninstalls with null', () => {
    Object.assign(defaults, { canUseCindyGateway: true, boundaryPending: false, source: 'server', currentKey: KEY_A });
    const requestSync = vi.fn(async () => undefined);
    installCindyGatewayKeyRejectionReporter(requestSync);
    installCindyGatewayKeyRejectionReporter(null);
    reportCindyGatewayKeyRejected(KEY_A);
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('the current-key entry is a no-op before model-access installs a reporter', () => {
    expect(() => reportCindyGatewayKeyRejectedForCurrentKey()).not.toThrow();
  });
});

describe('bearerKeyFromHeaders', () => {
  it('reads bearer keys from every HeadersInit shape', () => {
    expect(bearerKeyFromHeaders({ Authorization: `Bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerKeyFromHeaders({ authorization: `bearer ${KEY_A}` })).toBe(KEY_A);
    expect(bearerKeyFromHeaders(new Headers({ Authorization: `Bearer ${KEY_A}` }))).toBe(KEY_A);
    expect(bearerKeyFromHeaders([['Authorization', `Bearer ${KEY_A}`]])).toBe(KEY_A);
  });

  it('returns null without a bearer authorization header', () => {
    expect(bearerKeyFromHeaders(undefined)).toBeNull();
    expect(bearerKeyFromHeaders({ 'x-api-key': KEY_A })).toBeNull();
    expect(bearerKeyFromHeaders({ Authorization: `Basic ${KEY_A}` })).toBeNull();
    expect(bearerKeyFromHeaders({ Authorization: 'Bearer ' })).toBeNull();
  });
});

describe('withCindyGatewayKeyRejectionReport', () => {
  it('reports the bearer key of a 401 request and returns the response untouched', async () => {
    const response = new Response('denied', { status: 401 });
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);

    const result = await wrapped('https://gateway.invalid/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });

    expect(result).toBe(response);
    expect(report).toHaveBeenCalledWith(KEY_A);
    expect(fetchImpl).toHaveBeenCalledWith('https://gateway.invalid/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
  });

  it('reads the key from a Request object', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);
    await wrapped(new Request('https://gateway.invalid/v1/embeddings', {
      headers: { Authorization: `Bearer ${KEY_B}` },
    }));
    expect(report).toHaveBeenCalledWith(KEY_B);
  });

  it.each([200, 403, 500])('does not report HTTP %s', async (status) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);
    await wrapped('https://gateway.invalid/v1/embeddings', {
      headers: { Authorization: `Bearer ${KEY_A}` },
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('propagates network failures without reporting', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const report = vi.fn();
    const wrapped = withCindyGatewayKeyRejectionReport(fetchImpl, report);
    await expect(wrapped('https://gateway.invalid/v1/embeddings')).rejects.toThrow('fetch failed');
    expect(report).not.toHaveBeenCalled();
  });
});
