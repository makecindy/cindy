import { describe, expect, it, vi } from 'vitest';
import { runStartupOtaUpdate, withTimeout } from './startupOtaUpdate';

function deps(overrides: Partial<Parameters<typeof runStartupOtaUpdate>[0]> = {}) {
  return {
    enabled: true,
    configureUpdateUrl: vi.fn(),
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
    fetchUpdateAsync: vi.fn(async () => ({ isNew: false })),
    reloadAsync: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('runStartupOtaUpdate', () => {
  it('enabled=false → skipped,且不发起任何调用', async () => {
    const d = deps({ enabled: false });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('skipped');
    expect(d.configureUpdateUrl).not.toHaveBeenCalled();
    expect(d.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });

  it('无可用更新 → up-to-date,不 fetch/reload', async () => {
    const d = deps({ checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })) });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('up-to-date');
    expect(d.fetchUpdateAsync).not.toHaveBeenCalled();
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });

  it('先配置 endpoint 下发的更新 URL,再发起 check', async () => {
    const calls: string[] = [];
    const d = deps({
      configureUpdateUrl: vi.fn(() => calls.push('configure')),
      checkForUpdateAsync: vi.fn(async () => {
        calls.push('check');
        return { isAvailable: false };
      }),
    });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('up-to-date');
    expect(calls).toEqual(['configure', 'check']);
  });

  it('运行时 URL 覆写失败 → error(fail-open),不访问旧地址', async () => {
    const d = deps({ configureUpdateUrl: vi.fn(() => { throw new Error('override failed'); }) });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('error');
    expect(d.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('有更新但 fetch 非新 → up-to-date,不 reload', async () => {
    const d = deps({
      checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
      fetchUpdateAsync: vi.fn(async () => ({ isNew: false })),
    });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('up-to-date');
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });

  it('fetch 到新 bundle → reload,返回 reloading', async () => {
    const d = deps({
      checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
      fetchUpdateAsync: vi.fn(async () => ({ isNew: true })),
    });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('reloading');
    expect(d.reloadAsync).toHaveBeenCalledOnce();
  });

  it('check 抛错 → error(fail-open),不 reload', async () => {
    const d = deps({ checkForUpdateAsync: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(runStartupOtaUpdate(d)).resolves.toBe('error');
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });

  it('check 超时 → error(fail-open)', async () => {
    const d = deps({ checkForUpdateAsync: vi.fn((): Promise<{ isAvailable: boolean }> => new Promise(() => {})) }); // 永不 resolve
    await expect(runStartupOtaUpdate(d, { checkTimeoutMs: 20 })).resolves.toBe('error');
  });

  it('fetch 超时 → error(fail-open),不 reload', async () => {
    const d = deps({
      checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })),
      fetchUpdateAsync: vi.fn((): Promise<{ isNew: boolean }> => new Promise(() => {})),
    });
    await expect(runStartupOtaUpdate(d, { fetchTimeoutMs: 20 })).resolves.toBe('error');
    expect(d.reloadAsync).not.toHaveBeenCalled();
  });
});

describe('withTimeout', () => {
  it('按时 resolve 透传值', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
  });
  it('超时 reject', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toThrow(/timeout/);
  });
});
