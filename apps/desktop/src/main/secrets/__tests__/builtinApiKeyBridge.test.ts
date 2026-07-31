/**
 * builtinApiKeyBridge.test.ts — 内置 API-key IPC 业务体的边界回归测试。
 * 这组桥承担 MAIN_ONLY 凭证写删的安全边界:白名单、类型/长度上限、空值拒绝、
 * 存储失败错误路径都在此锁住,防止后续改动回退(此前实审出过长度校验缺口)。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_API_KEY_MAX_LENGTH,
  builtinApiKeyHas,
  builtinApiKeyRemove,
  builtinApiKeyStore,
  type BuiltinApiKeyBridgeDeps,
} from '../builtinApiKeyBridge';

function makeDeps(overrides?: Partial<BuiltinApiKeyBridgeDeps['store']>) {
  const store = {
    set: vi.fn<BuiltinApiKeyBridgeDeps['store']['set']>(() => true),
    remove: vi.fn<BuiltinApiKeyBridgeDeps['store']['remove']>(() => ({ success: true })),
    has: vi.fn<BuiltinApiKeyBridgeDeps['store']['has']>(() => true),
    ...overrides,
  };
  const onKeyChanged = vi.fn<BuiltinApiKeyBridgeDeps['onKeyChanged']>();
  const logError = vi.fn<BuiltinApiKeyBridgeDeps['logError']>();
  const deps: BuiltinApiKeyBridgeDeps = { store, onKeyChanged, logError };
  return { deps, store, onKeyChanged, logError };
}

/** 断言抛出的是统一 IPC 协议错误(err.code + [CODE] 前缀话术)。 */
function expectIpcError(fn: () => void, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code?: string }).code).toBe(code);
  expect((thrown as Error).message).toContain(`[${code}]`);
}

describe('builtinApiKeyStore', () => {
  it('白名单外 providerId 拒绝(INVALID_PARAMS),不触达存储', () => {
    const { deps, store } = makeDeps();
    expectIpcError(() => builtinApiKeyStore(deps, 'xd', 'sk-x'), 'INVALID_PARAMS');
    expectIpcError(() => builtinApiKeyStore(deps, 42, 'sk-x'), 'INVALID_PARAMS');
    expectIpcError(() => builtinApiKeyStore(deps, undefined, 'sk-x'), 'INVALID_PARAMS');
    expect(store.set).not.toHaveBeenCalled();
  });

  it('value 非字符串 / 超长拒绝(INVALID_PARAMS),不触达存储', () => {
    const { deps, store } = makeDeps();
    expectIpcError(() => builtinApiKeyStore(deps, 'gemini', 123), 'INVALID_PARAMS');
    expectIpcError(
      () => builtinApiKeyStore(deps, 'gemini', 'x'.repeat(BUILTIN_API_KEY_MAX_LENGTH + 1)),
      'INVALID_PARAMS',
    );
    expect(store.set).not.toHaveBeenCalled();
  });

  it('空串 / 纯空白拒绝(INVALID_PARAMS)', () => {
    const { deps, store } = makeDeps();
    expectIpcError(() => builtinApiKeyStore(deps, 'gemini', ''), 'INVALID_PARAMS');
    expectIpcError(() => builtinApiKeyStore(deps, 'gemini', '   '), 'INVALID_PARAMS');
    expect(store.set).not.toHaveBeenCalled();
  });

  it('存储层写失败抛 INTERNAL,不广播变更', () => {
    const { deps, onKeyChanged } = makeDeps({ set: vi.fn(() => false) });
    expectIpcError(() => builtinApiKeyStore(deps, 'gemini', 'sk-good'), 'INTERNAL');
    expect(onKeyChanged).not.toHaveBeenCalled();
  });

  it('成功路径:trim 后入库 + 广播变更;上限内长 key 放行', () => {
    const { deps, store, onKeyChanged } = makeDeps();
    builtinApiKeyStore(deps, 'openai-images', '  sk-good  ');
    expect(store.set).toHaveBeenCalledWith('openai-images', 'sk-good');
    expect(onKeyChanged).toHaveBeenCalledWith('openai-images');
    builtinApiKeyStore(deps, 'gemini', 'x'.repeat(BUILTIN_API_KEY_MAX_LENGTH));
    expect(store.set).toHaveBeenCalledWith('gemini', 'x'.repeat(BUILTIN_API_KEY_MAX_LENGTH));
  });
});

describe('builtinApiKeyRemove', () => {
  it('白名单外 providerId 拒绝(INVALID_PARAMS),不触达存储', () => {
    const { deps, store } = makeDeps();
    expectIpcError(() => builtinApiKeyRemove(deps, 'voice-asr'), 'INVALID_PARAMS');
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('存储层删失败抛 INTERNAL,不广播变更', () => {
    const { deps, onKeyChanged } = makeDeps({
      remove: vi.fn(() => ({ success: false, error: 'io' })),
    });
    expectIpcError(() => builtinApiKeyRemove(deps, 'gemini'), 'INTERNAL');
    expect(onKeyChanged).not.toHaveBeenCalled();
  });

  it('成功路径:删除 + 广播变更', () => {
    const { deps, store, onKeyChanged } = makeDeps();
    builtinApiKeyRemove(deps, 'gemini');
    expect(store.remove).toHaveBeenCalledWith('gemini');
    expect(onKeyChanged).toHaveBeenCalledWith('gemini');
  });
});

describe('builtinApiKeyHas', () => {
  it('查询语义:白名单外 / 非字符串回 false,不触达存储、不抛错', () => {
    const { deps, store } = makeDeps();
    expect(builtinApiKeyHas(deps, 'xd')).toBe(false);
    expect(builtinApiKeyHas(deps, 7)).toBe(false);
    expect(store.has).not.toHaveBeenCalled();
  });

  it('透传存储层结果;存储层异常回 false(UI 按未配置渲染)并进注入 logger', () => {
    const ok = makeDeps({ has: vi.fn(() => true) });
    expect(builtinApiKeyHas(ok.deps, 'openai-images')).toBe(true);
    expect(ok.logError).not.toHaveBeenCalled();
    const boom = makeDeps({
      has: vi.fn(() => {
        throw new Error('io');
      }),
    });
    expect(builtinApiKeyHas(boom.deps, 'gemini')).toBe(false);
    expect(boom.logError).toHaveBeenCalledOnce();
  });
});
