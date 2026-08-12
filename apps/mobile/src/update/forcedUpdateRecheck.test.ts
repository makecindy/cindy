import { describe, expect, it, vi } from 'vitest';
import {
  createForcedUpdateRechecker,
  type ForcedUpdateRecheckDeps,
} from './forcedUpdateRecheck';

/** 有效的 /latest 记录;默认带门槛(当前 version 1.0.0 < 2.0.0 → 仍强更)。 */
function latestRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: '2.0.0',
    buildNumber: 20,
    runtimeVersion: '2',
    installUrl: 'https://cdn.example/install',
    itmsUrl: 'itms-services://?action=download-manifest&url=https://cdn.example/m.plist',
    minVersion: '2.0.0',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ForcedUpdateRecheckDeps> = {}) {
  let nowMs = 1_000_000;
  const deps: ForcedUpdateRecheckDeps & { advance: (ms: number) => void } = {
    fetchLatest: vi.fn(async () => latestRecord()),
    getCurrentRuntimeVersion: () => '1',
    getCurrentVersion: () => '1.0.0',
    onCleared: vi.fn(),
    onStillForced: vi.fn(),
    getRevision: () => 7,
    now: () => nowMs,
    advance: (ms: number) => { nowMs += ms; },
    ...overrides,
  };
  return deps;
}

/** 模拟一次「切后台再回前台」。 */
function resume(rechecker: ReturnType<typeof createForcedUpdateRechecker>) {
  rechecker.handleAppStateChange('background');
  return rechecker.handleAppStateChange('active');
}

describe('createForcedUpdateRechecker 触发条件', () => {
  it('创建后立刻回前台:间隔不足 → 不检查(阻断屏刚挂载时那次检查刚跑完)', () => {
    const deps = makeDeps();
    const rechecker = createForcedUpdateRechecker(deps);
    expect(resume(rechecker)).toBeNull();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('没进过后台的 active 抖动 → 不检查', () => {
    const deps = makeDeps();
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    expect(rechecker.handleAppStateChange('inactive')).toBeNull();
    expect(rechecker.handleAppStateChange('active')).toBeNull();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('挂载时已在后台(阻断态被迟到的 /latest 置位)→ 回前台第一次就核对', async () => {
    // 没有这条 seeding,本实例见不到 'background' 事件,回前台首次会被 wasBackground
    // 门挡掉,用户得再走一个完整的切后台→回前台周期才自愈。
    const deps = makeDeps({ getAppState: () => 'background' });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    const result = rechecker.handleAppStateChange('active');
    expect(result).not.toBeNull();
    await result;
    expect(deps.fetchLatest).toHaveBeenCalledOnce();
  });

  it('挂载时处于 inactive(iOS 抖动 / 系统弹框)→ 同样按已离开前台处理', async () => {
    const deps = makeDeps({ getAppState: () => 'inactive' });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    expect(rechecker.handleAppStateChange('active')).not.toBeNull();
  });

  it('挂载时在前台 → 维持原行为(首次 active 不检查)', () => {
    const deps = makeDeps({ getAppState: () => 'active' });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    expect(rechecker.handleAppStateChange('active')).toBeNull();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('挂载时已在后台但用户很快回来 → 节流仍然生效(刚查过,重查冗余)', () => {
    const deps = makeDeps({ getAppState: () => 'background' });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 30_000 });
    deps.advance(1000); // 远小于节流间隔
    expect(rechecker.handleAppStateChange('active')).toBeNull();
  });

  it('间隔不足的连续回前台 → 只检查一次(节流)', async () => {
    const deps = makeDeps();
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 1000 });
    deps.advance(1001);
    await resume(rechecker);
    deps.advance(1); // 远小于间隔
    expect(resume(rechecker)).toBeNull();
    expect(deps.fetchLatest).toHaveBeenCalledOnce();
  });
});

describe('createForcedUpdateRechecker 定时兜底', () => {
  it('挂载后立刻 tick:间隔不足 → 不检查', () => {
    const deps = makeDeps();
    const rechecker = createForcedUpdateRechecker(deps);
    expect(rechecker.handleTick()).toBeNull();
    expect(deps.fetchLatest).not.toHaveBeenCalled();
  });

  it('用户停在阻断屏不动(无任何 AppState 跳变)→ 间隔满足后 tick 会核对', async () => {
    const deps = makeDeps();
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 1000 });
    deps.advance(1001);
    const result = rechecker.handleTick();
    expect(result).not.toBeNull();
    await result;
    expect(deps.fetchLatest).toHaveBeenCalledOnce();
  });

  it('在后台被置位、用户在节流窗口内回来 → 那次 active 被丢掉,但 tick 随后补上', async () => {
    const deps = makeDeps({ getAppState: () => 'background' });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 1000 });
    deps.advance(500); // 窗口内回前台
    expect(rechecker.handleAppStateChange('active')).toBeNull();
    deps.advance(600); // 窗口过去
    expect(rechecker.handleTick()).not.toBeNull();
  });

  it('tick 与 AppState 共用节流:刚查过就 tick → 不重复发起', async () => {
    const deps = makeDeps();
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 1000 });
    deps.advance(1001);
    await resume(rechecker);
    expect(rechecker.handleTick()).toBeNull();
    expect(deps.fetchLatest).toHaveBeenCalledOnce();
  });
});

describe('createForcedUpdateRechecker 解除判定', () => {
  const runOnce = (deps: ReturnType<typeof makeDeps>) => {
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    const result = resume(rechecker);
    expect(result).not.toBeNull();
    return result!;
  };

  it('门槛已撤回 → 解除阻断', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => latestRecord({ minVersion: undefined })) });
    await expect(runOnce(deps)).resolves.toBe('cleared');
    expect(deps.onCleared).toHaveBeenCalledOnce();
  });

  it('门槛降到当前 version 之下 → 解除阻断', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => latestRecord({ minVersion: '1.0.0' })) });
    await expect(runOnce(deps)).resolves.toBe('cleared');
    expect(deps.onCleared).toHaveBeenCalledOnce();
  });

  it('门槛仍在 → 维持阻断,并把最新 target 写回', async () => {
    const deps = makeDeps();
    await expect(runOnce(deps)).resolves.toBe('still-forced');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).toHaveBeenCalledOnce();
  });

  it('落地时回传发起时的 revision(compare-and-set 的依据)', async () => {
    // 发起后 store 被更新的观察改写时,revision 会变;这里断言回传的是**发起时**读到的值。
    let rev = 7;
    const deps = makeDeps({
      getRevision: () => rev,
      fetchLatest: vi.fn(async () => { rev = 9; return latestRecord({ minVersion: undefined }); }),
    });
    await expect(runOnce(deps)).resolves.toBe('cleared');
    expect(deps.onCleared).toHaveBeenCalledWith(7);
  });

  it('仍强更时刷新 target 也带上发起时的 revision', async () => {
    const deps = makeDeps();
    await expect(runOnce(deps)).resolves.toBe('still-forced');
    expect(deps.onStillForced).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0' }), 7);
  });

  it('门槛仍在但服务端修正了安装地址 → 刷新 target(否则按钮一直打开旧链接)', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({
        installUrl: 'https://cdn.example/fixed',
        itmsUrl: 'itms-services://?action=download-manifest&url=https://cdn.example/fixed.plist',
      })),
    });
    await expect(runOnce(deps)).resolves.toBe('still-forced');
    expect(deps.onStillForced).toHaveBeenCalledWith(expect.objectContaining({
      installUrl: 'https://cdn.example/fixed',
      itmsUrl: 'itms-services://?action=download-manifest&url=https://cdn.example/fixed.plist',
    }), 7);
  });

  it('门槛仍在且换了更高的强更目标 → 刷新 target', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ version: '3.0.0', runtimeVersion: '3', minVersion: '3.0.0' })),
    });
    await expect(runOnce(deps)).resolves.toBe('still-forced');
    expect(deps.onStillForced).toHaveBeenCalledWith(expect.objectContaining({
      version: '3.0.0',
      runtimeVersion: '3',
    }), 7);
  });

  it('读到比阻断目标更旧的记录(CDN 边缘旧值)→ 维持阻断,不解除', async () => {
    // /latest 背后是可变指针且请求不带 cache-buster,边缘可能回一条旧记录;
    // 旧记录没有 minVersion,若照它解除就会把仍需强更的用户放进业务树。
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ version: '1.5.0', minVersion: undefined })),
      getHeldTarget: () => ({ version: '2.0.0' }),
    });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).not.toHaveBeenCalled();
  });

  it('阻断目标缺 version(理论不可达)→ 不做版本比较,也不死锁', async () => {
    // evaluateBundleUpdate 要求 record 带 version 才判 forced,所以正常路径下 held.version
    // 必然非空。万一为空,也不能靠"维持阻断"兜着 —— 那会把用户永久钉在阻断屏上,
    // 定时与回前台核对都过不去。此时退化成无新鲜度约束,照常评估门槛。
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ version: '1.5.0', minVersion: undefined })),
      getHeldTarget: () => ({ version: '' }),
    });
    await expect(runOnce(deps)).resolves.toBe('cleared');
    expect(deps.onCleared).toHaveBeenCalledOnce();
  });

  it('记录缺 version → 证明不了新鲜度,维持阻断', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ version: '', minVersion: undefined })),
      getHeldTarget: () => ({ version: '2.0.0' }),
    });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
  });

  it('同版本记录撤回门槛(最常见的撤回形态)→ 正常解除', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ version: '2.0.0', minVersion: undefined })),
      getHeldTarget: () => ({ version: '2.0.0' }),
    });
    await expect(runOnce(deps)).resolves.toBe('cleared');
    expect(deps.onCleared).toHaveBeenCalledOnce();
  });

  it('更新版本的记录且不再强更 → 正常解除', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ version: '2.1.0', minVersion: undefined })),
      getHeldTarget: () => ({ version: '2.0.0' }),
    });
    await expect(runOnce(deps)).resolves.toBe('cleared');
  });

  it('服务端 404(整包记录被撤下)→ 解除阻断(冷启动同样不会阻断,运行中不该更严)', async () => {
    // fetchLatestRelease 只在 404 时返回 null(网络 / 5xx 都抛错),这是服务端明确声明
    // "该平台当前没有整包记录" —— 记录不存在,门槛也不存在。
    const deps = makeDeps({ fetchLatest: vi.fn(async () => null) });
    await expect(runOnce(deps)).resolves.toBe('cleared');
    expect(deps.onCleared).toHaveBeenCalledWith(7);
  });

  it('拿不到本机 runtimeVersion → 维持阻断(不能靠 expo-updates 异常绕过)', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ minVersion: undefined })),
      getCurrentRuntimeVersion: () => null,
    });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).not.toHaveBeenCalled();
  });

  it('/latest 拉取失败 → 维持阻断(不能靠断网绕过强更)', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).not.toHaveBeenCalled();
  });

  it('/latest 记录解析不出 → 维持阻断(一条坏记录不得放行所有被强更装机)', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn(async () => ({})) });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).not.toHaveBeenCalled();
  });

  it('记录有效但缺 runtimeVersion / 安装地址 → 维持阻断', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ installUrl: '', itmsUrl: '', minVersion: undefined })),
    });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).not.toHaveBeenCalled();
  });

  it('拿不到本机 version → 维持阻断(比不出来不放行)', async () => {
    const deps = makeDeps({
      fetchLatest: vi.fn(async () => latestRecord({ minVersion: undefined })),
      getCurrentVersion: () => null,
    });
    await expect(runOnce(deps)).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
    expect(deps.onStillForced).not.toHaveBeenCalled();
  });

  it('/latest 挂起 → withTimeout 兜底为 error,维持阻断', async () => {
    const deps = makeDeps({ fetchLatest: vi.fn((): Promise<unknown> => new Promise(() => {})) });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0, latestTimeoutMs: 20 });
    deps.advance(1);
    const result = resume(rechecker);
    expect(result).not.toBeNull();
    await expect(result!).resolves.toBe('error');
    expect(deps.onCleared).not.toHaveBeenCalled();
  });

  it('阻断屏已卸载(isCurrent=false)→ 迟到结果不解除', async () => {
    let current = true;
    let release!: (value: unknown) => void;
    const deps = makeDeps({
      fetchLatest: vi.fn(() => new Promise((resolve) => { release = resolve; })),
      isCurrent: () => current,
    });
    const rechecker = createForcedUpdateRechecker(deps, { minIntervalMs: 0 });
    deps.advance(1);
    const pending = resume(rechecker);
    expect(pending).not.toBeNull();
    current = false;
    release(latestRecord({ minVersion: undefined })); // 已不再强更,但屏已卸载
    await expect(pending!).resolves.toBe('still-forced');
    expect(deps.onCleared).not.toHaveBeenCalled();
  });
});
