import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResponseObserverCtx } from '@cindy/anthropic-compat-proxy';
import type { PermissionMode } from '@cindy/maker-core';

import {
  createClaudeAutoClassifierFailureObserver,
  createClaudeAutoPermissionFallbackCoordinator,
  isClaudeAutoClassifierRequest,
  setClaudeAutoClassifierUnavailableListener,
  type ClaudeAutoPermissionFallbackDeps,
} from '../claude-auto-permission-fallback.js';

const CLASSIFIER_PREFIX = 'You are a security monitor for autonomous AI coding agents.';

function requestBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      system: [{ type: 'text', text: `${CLASSIFIER_PREFIX}\nRules` }],
      messages: [],
      ...overrides,
    }),
  );
}

function ctx(overrides: Partial<ResponseObserverCtx> = {}): ResponseObserverCtx {
  return {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://relay.example',
    status: 429,
    requestHeaders: { 'x-claude-code-session-id': 'sdk-1' },
    responseHeaders: {},
    requestBody: requestBody(),
    ...overrides,
  };
}

function createDeps(overrides: Partial<ClaudeAutoPermissionFallbackDeps> = {}) {
  const setPermissionMode = vi.fn<(mode: PermissionMode) => Promise<void>>(async () => {});
  const deps: ClaudeAutoPermissionFallbackDeps = {
    getSession: vi.fn(() => ({ agentKind: 'claude-code', setPermissionMode })),
    getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
    persistPermissionModeIfAuto: vi.fn(async () => true),
    broadcast: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { deps, setPermissionMode };
}

afterEach(() => {
  setClaudeAutoClassifierUnavailableListener(() => {});
});

describe('Claude Auto classifier request detection', () => {
  it('accepts the observed array and string system prompt shapes', () => {
    expect(isClaudeAutoClassifierRequest(requestBody())).toBe(true);
    expect(
      isClaudeAutoClassifierRequest(requestBody({ system: `${CLASSIFIER_PREFIX}\nRules` })),
    ).toBe(true);
  });

  it('detects every classifier max_tokens shape (fast 256 / stage1 64 / thinking 8192)', () => {
    // 不再依赖固定 max_tokens——三条分类器路径(含 +k 变体)都必须命中,
    // 否则 fast / thinking 路径的 429 会漏检、不触发降级。
    for (const max_tokens of [64, 256, 8192, 65, 320, 8256, 16384]) {
      expect(isClaudeAutoClassifierRequest(requestBody({ max_tokens }))).toBe(true);
    }
  });

  it('fails closed for malformed or lookalike requests', () => {
    expect(isClaudeAutoClassifierRequest(Buffer.from('{bad json'))).toBe(false);
    expect(isClaudeAutoClassifierRequest(requestBody({ system: 'ordinary assistant' }))).toBe(
      false,
    );
    expect(isClaudeAutoClassifierRequest(requestBody({ system: [] }))).toBe(false);
    // 前缀不匹配的普通主 turn 即使 max_tokens 恰为 64 也不得命中。
    expect(
      isClaudeAutoClassifierRequest(
        requestBody({ system: 'You are Claude Code, Anthropic official CLI' }),
      ),
    ).toBe(false);
    // 防御性副判据:即便 system 恰好以分类器前缀开头,大输出请求(超上界)也不误判为
    // 分类器故障——闭合「前缀碰撞 → 错误降级」的理论窗口。
    expect(isClaudeAutoClassifierRequest(requestBody({ max_tokens: 32000 }))).toBe(false);
    // 缺省 max_tokens(分类器恒会设置)同样不命中。
    expect(
      isClaudeAutoClassifierRequest(
        Buffer.from(JSON.stringify({ system: [{ type: 'text', text: CLASSIFIER_PREFIX }] })),
      ),
    ).toBe(false);
  });
});

describe('createClaudeAutoClassifierFailureObserver', () => {
  it('keeps Auto for transient classifier failures', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    const observer = createClaudeAutoClassifierFailureObserver(() => 'session-1');

    expect(observer(ctx({ status: 408 }))).toBeUndefined();
    expect(observer(ctx({ status: 429 }))).toBeUndefined();
    expect(observer(ctx({ status: 503 }))).toBeUndefined();
    expect(observer(ctx({ status: 529 }))).toBeUndefined();

    expect(listener).not.toHaveBeenCalled();
  });

  it('reports non-transient classifier failures with the resolved business session id', () => {
    const signals: unknown[] = [];
    setClaudeAutoClassifierUnavailableListener((signal) => signals.push(signal));
    const observer = createClaudeAutoClassifierFailureObserver((sdkId) =>
      sdkId === 'sdk-1' ? 'session-1' : null,
    );

    expect(observer(ctx({ status: 400 }))).toBeUndefined();
    expect(observer(ctx({ status: 401 }))).toBeUndefined();
    expect(observer(ctx({ status: 403 }))).toBeUndefined();
    expect(observer(ctx({ status: 404 }))).toBeUndefined();
    expect(observer(ctx({ status: 422 }))).toBeUndefined();

    expect(signals).toEqual([
      { sessionId: 'session-1', agentKind: 'claude-code', status: 400 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 401 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 403 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 404 },
      { sessionId: 'session-1', agentKind: 'claude-code', status: 422 },
    ]);
  });

  it('does not parse/report success, redirects, non-classifier bodies, or unresolved sessions', () => {
    const listener = vi.fn();
    setClaudeAutoClassifierUnavailableListener(listener);
    const resolved = createClaudeAutoClassifierFailureObserver(() => 'session-1');
    const unresolved = createClaudeAutoClassifierFailureObserver(() => null);

    resolved(ctx({ status: 200, requestBody: Buffer.from('{bad json') })); // 成功响应不解析
    resolved(ctx({ status: 302 })); // 3xx 重定向:非错误,短路
    // 即便状态码现在落在 4xx 触发区间,非分类器 body(前缀不匹配)仍不得上报。
    resolved(ctx({ status: 400, requestBody: requestBody({ system: 'ordinary assistant' }) }));
    unresolved(ctx()); // 无法反解会话 id
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createClaudeAutoPermissionFallbackCoordinator', () => {
  it('switches runtime, persists ask, and broadcasts only after success', async () => {
    const order: string[] = [];
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
      persistPermissionModeIfAuto: vi.fn(async () => {
        order.push('persist');
        return true;
      }),
      broadcast: vi.fn(() => {
        order.push('broadcast');
      }),
    });
    setPermissionMode.mockImplementation(async () => {
      order.push('runtime');
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(true);
    expect(order).toEqual(['runtime', 'persist', 'broadcast']);
    expect(deps.persistPermissionModeIfAuto).toHaveBeenCalledWith('session-1');
    expect(deps.broadcast).toHaveBeenCalledWith({
      sessionId: 'session-1',
      from: 'auto',
      to: 'ask',
      reason: 'classifier_unavailable',
      status: 429,
    });
  });

  it('accumulates classifier-failure counters across signals and logs them on downgrade', async () => {
    // 同一 coordinator 实例:先来一个非 auto 会话的跳过(静默计数),
    // 再来一个成功降级——降级日志里的 counters 必须反映累计(含前一次跳过)。
    const { deps } = createDeps({
      getSessionMeta: vi
        .fn()
        .mockResolvedValueOnce({ permissionMode: 'ask' }) // session-skip: 非 auto
        .mockResolvedValueOnce({ permissionMode: 'auto' }), // session-1: 正常降级
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-skip', status: 429 })).resolves.toBe(false);
    await expect(fallback({ sessionId: 'session-1', status: 503 })).resolves.toBe(true);

    expect(deps.logger.info).toHaveBeenCalledWith(
      'auto permission classifier unavailable; session downgraded to ask',
      expect.objectContaining({
        counters: expect.objectContaining({
          detected: 2,
          downgraded: 1,
          skippedNotAuto: 1,
          dedupedRetries: 0,
        }),
      }),
    );
  });

  it('deduplicates concurrent failures for the same session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, setPermissionMode } = createDeps();
    setPermissionMode.mockImplementation(async () => gate);
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    const first = fallback({ sessionId: 'session-1', status: 429 });
    await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledTimes(1));
    await expect(fallback({ sessionId: 'session-1', status: 503 })).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(deps.persistPermissionModeIfAuto).toHaveBeenCalledTimes(1);
  });

  it('restores the racing user choice when the conditional persist does not apply', async () => {
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi
        .fn()
        .mockResolvedValueOnce({ permissionMode: 'auto' })
        .mockResolvedValueOnce({ permissionMode: 'bypassPermissions' }),
      persistPermissionModeIfAuto: vi.fn(async () => false),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(false);
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
      'ask',
      'bypassPermissions',
    ]);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('keeps runtime at ask without re-push when the racing user choice is also ask', async () => {
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi
        .fn()
        .mockResolvedValueOnce({ permissionMode: 'auto' })
        .mockResolvedValueOnce({ permissionMode: 'ask' }),
      persistPermissionModeIfAuto: vi.fn(async () => false),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(false);
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['ask']);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('skips non-auto or non-Claude sessions', async () => {
    const notAuto = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'ask' as const })),
    });
    const codex = createDeps({
      getSession: vi.fn(() => ({
        agentKind: 'codex',
        setPermissionMode: vi.fn(async () => {}),
      })),
    });

    await expect(
      createClaudeAutoPermissionFallbackCoordinator(notAuto.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    await expect(
      createClaudeAutoPermissionFallbackCoordinator(codex.deps)({
        sessionId: 'session-1',
        status: 429,
      }),
    ).resolves.toBe(false);
    expect(notAuto.setPermissionMode).not.toHaveBeenCalled();
    expect(codex.deps.persistPermissionModeIfAuto).not.toHaveBeenCalled();
  });

  it('downgrades a Codex Auto session when the signal identifies Codex', async () => {
    const setPermissionMode = vi.fn(async () => {});
    const { deps } = createDeps({
      getSession: vi.fn(() => ({ agentKind: 'codex', setPermissionMode })),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({
      sessionId: 'session-codex',
      agentKind: 'codex',
      status: 408,
    })).resolves.toBe(true);
    expect(setPermissionMode).toHaveBeenCalledWith('ask');
    expect(deps.persistPermissionModeIfAuto).toHaveBeenCalledWith('session-codex');
  });

  it('rolls runtime back to persisted mode when persistence fails', async () => {
    const { deps, setPermissionMode } = createDeps({
      getSessionMeta: vi.fn(async () => ({ permissionMode: 'auto' as const })),
      persistPermissionModeIfAuto: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });
    const fallback = createClaudeAutoPermissionFallbackCoordinator(deps);

    await expect(fallback({ sessionId: 'session-1', status: 429 })).resolves.toBe(false);
    expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual(['ask', 'auto']);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'auto permission fallback failed',
      expect.objectContaining({ error: 'db unavailable' }),
    );
  });
});
