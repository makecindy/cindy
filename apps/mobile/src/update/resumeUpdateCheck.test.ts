import { describe, expect, it, vi } from 'vitest';
import { createResumeUpdateChecker, type ResumeUpdateCheckDeps } from './resumeUpdateCheck';

/** 有效的 /latest 记录(runtimeVersion 与当前 '1' 不同 → 有整包更新)。 */
function latestRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: '2.0.0',
    buildNumber: 20,
    runtimeVersion: '2',
    installUrl: 'https://npkg.example/install',
    itmsUrl: 'itms-services://?action=download-manifest&url=https://npkg.example/m.plist',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ResumeUpdateCheckDeps> = {}) {
  let nowMs = 1_000_000;
  const deps: ResumeUpdateCheckDeps & { advance: (ms: number) => void } = {
    otaEnabled: true,
    checkForUpdateAsync: vi.fn(async () => ({ isAvailable: false })),
    fetchUpdateAsync: vi.fn(async () => ({ isNew: true })),
    bundleCheckEnabled: true,
    fetchLatest: vi.fn(async () => null),
    getCurrentRuntimeVersion: () => '1',
    getCurrentVersion: () => '1.0.0',
    // 真实 callback 是 promptBundleUpdate → enterForcedUpdate(幂等,不需要去重)。
    onForcedUpdate: vi.fn(),
    now: () => nowMs,
    advance: (ms: number) => { nowMs += ms; },
    ...overrides,
  };
  return deps;
}

/** 模拟一次「切后台再回前台」;返回 handleAppStateChange('active') 的结果。 */
function resume(checker: ReturnType<typeof createResumeUpdateChecker>) {
  checker.handleAppStateChange('background');
  return checker.handleAppStateChange('active');
}

describe('createResumeUpdateChecker 触发条件', () => {
  it('创建后立刻 resume:间隔不足 → 不检查(冷启动刚查过)', () => {
    const deps = makeDeps();
    const checker = createResumeUpdateChecker(deps);
    expect(resume(checker)).toBeNull();
    expect(deps.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('间隔满足后 resume → 触发检查', async () => {
    const deps = makeDeps();
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 1000 });
    deps.advance(1001);
    const result = resume(checker);
    expect(result).not.toBeNull();
    await result;
    expect(deps.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(deps.fetchLatest).toHaveBeenCalledOnce();
  });

  it('inactive 抖动(未进 background)回 active → 不触发', () => {
    const deps = makeDeps();
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    checker.handleAppStateChange('inactive');
    expect(checker.handleAppStateChange('active')).toBeNull();
  });

  it('检查在途时再次 resume → 不重入', async () => {
    const deps = makeDeps();
    let release!: () => void;
    deps.checkForUpdateAsync = vi.fn(() => new Promise<{ isAvailable: boolean }>((resolve) => {
      release = () => resolve({ isAvailable: false });
    }));
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 1000 });
    deps.advance(1001);
    const first = resume(checker);
    expect(first).not.toBeNull();
    deps.advance(1001);
    expect(resume(checker)).toBeNull(); // 在途,拒绝重入
    release();
    await first;
  });

  it('节流:两次 resume 间隔不足只跑一次', async () => {
    const deps = makeDeps();
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 1000 });
    deps.advance(1001);
    await resume(checker);
    deps.advance(500);
    expect(resume(checker)).toBeNull();
    deps.advance(501);
    expect(resume(checker)).not.toBeNull();
  });
});

describe('createResumeUpdateChecker OTA 静默路径', () => {
  async function runOnce(deps: ReturnType<typeof makeDeps>, opts: Parameters<typeof createResumeUpdateChecker>[1] = {}) {
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 0, ...opts });
    deps.advance(1);
    const result = resume(checker);
    expect(result).not.toBeNull();
    return result!;
  }

  it('otaEnabled=false → skipped,不调 expo-updates', async () => {
    const deps = makeDeps({ otaEnabled: false });
    const { ota } = await runOnce(deps);
    expect(ota).toBe('skipped');
    expect(deps.checkForUpdateAsync).not.toHaveBeenCalled();
  });

  it('无可用更新 → up-to-date,不 fetch', async () => {
    const deps = makeDeps();
    const { ota } = await runOnce(deps);
    expect(ota).toBe('up-to-date');
    expect(deps.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('有更新 → 静默 fetch,返回 fetched(无 reload 依赖,构造上不可能重启)', async () => {
    const deps = makeDeps({ checkForUpdateAsync: vi.fn(async () => ({ isAvailable: true })) });
    const { ota } = await runOnce(deps);
    expect(ota).toBe('fetched');
    expect(deps.fetchUpdateAsync).toHaveBeenCalledOnce();
  });

  it('check 抛错 → error(fail-open),不影响整包检查', async () => {
    const deps = makeDeps({ checkForUpdateAsync: vi.fn(async () => { throw new Error('offline'); }) });
    const { ota, bundle } = await runOnce(deps);
    expect(ota).toBe('error');
    expect(bundle).toBe('up-to-date');
  });

  it('check 超时 → error(fail-open)', async () => {
    const deps = makeDeps({
      checkForUpdateAsync: vi.fn((): Promise<{ isAvailable: boolean }> => new Promise(() => {})),
    });
    const { ota } = await runOnce(deps, { checkTimeoutMs: 20 });
    expect(ota).toBe('error');
  });
});

describe('createResumeUpdateChecker 整包路径', () => {
  async function runOnce(deps: ReturnType<typeof makeDeps>) {
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    const result = resume(checker);
    expect(result).not.toBeNull();
    return result!;
  }

  it('bundleCheckEnabled=false → skipped,不拉 /latest', async () => {
    const deps = makeDeps({ bundleCheckEnabled: false });
    const { ota, bundle } = await runOnce(deps);
    expect(ota).toBe('up-to-date');
    expect(bundle).toBe('skipped');
    expect(deps.checkForUpdateAsync).toHaveBeenCalledOnce();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('/latest 无记录 → up-to-date', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => null) });
    const { bundle } = await runOnce(deps);
    expect(bundle).toBe('up-to-date');
  });

  it('非强更整包更新 → update-available 但完全静默(不回调)', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => latestRecord()) });
    const { bundle } = await runOnce(deps);
    expect(bundle).toBe('update-available');
    expect(deps.onForcedUpdate).not.toHaveBeenCalled();
  });

  it('强更(minVersion)→ forced 且回调一次', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => latestRecord({ minVersion: '2.0.0' })) });
    const { bundle } = await runOnce(deps);
    expect(bundle).toBe('forced');
    expect(deps.onForcedUpdate).toHaveBeenCalledOnce();
  });

  it('同一强更目标多次 resume → 每次都上报(阻断态幂等,本层不去重)', async () => {
    // 去重曾是必需的(强更是一次性 Alert);改成阻断态后 enterForcedUpdate 幂等,
    // 本层不再持有"已提示过"状态 —— 也就不会因为一次未展示而让强更永久失声。
    const deps = makeDeps({ fetchLatest: vi.fn(async () => latestRecord({ minVersion: '2.0.0' })) });
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    await resume(checker);
    deps.advance(1);
    await resume(checker);
    expect(deps.onForcedUpdate).toHaveBeenCalledTimes(2);
  });

  it('同 runtimeVersion 但低于 minVersion → 依旧上报强更', async () => {
    // 服务端事后给某个已发布版本下发门槛时,装机 runtimeVersion 与 /latest 相同,
    // 但 version 低于门槛 —— 不能因为"指纹没变"就放过。
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ runtimeVersion: '1', minVersion: '2.0.0' })),
    });
    const { bundle } = await runOnce(deps);
    expect(bundle).toBe('forced');
    expect(deps.onForcedUpdate).toHaveBeenCalledOnce();
  });

  it('/latest 拉取失败 → error(fail-open),不影响 OTA 结果', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => { throw new Error('http 500'); }) });
    const { ota, bundle } = await runOnce(deps);
    expect(bundle).toBe('error');
    expect(ota).toBe('up-to-date');
  });

  it('/latest 挂起 → withTimeout backstop 触发 error(fail-open),不影响 OTA', async () => {
    // 注入一个永不 resolve 的 fetchLatest:模拟注入实现无内部超时时纯逻辑层的兜底。
    const deps = makeDeps({ fetchLatest: vi.fn((): Promise<unknown> => new Promise(() => {})) });
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 0, latestTimeoutMs: 20 });
    deps.advance(1);
    const result = resume(checker);
    expect(result).not.toBeNull();
    const { ota, bundle } = await result!;
    expect(bundle).toBe('error');
    expect(ota).toBe('up-to-date');
  });

  it('channel 切换后旧检查迟到不再触发强更提示', async () => {
    let current = true;
    let release!: (value: unknown) => void;
    const deps = makeDeps({
      fetchLatest: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      isCurrent: () => current,
    });
    const checker = createResumeUpdateChecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    const pending = resume(checker);
    expect(pending).not.toBeNull();
    current = false;
    release(latestRecord({ minVersion: '2.0.0' }));
    const result = await pending!;
    expect(result.bundle).toBe('skipped');
    expect(deps.onForcedUpdate).not.toHaveBeenCalled();
  });
});
