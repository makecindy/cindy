import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  isNoAccountHomeMode,
  resolveHomeInitialPhase,
  runHomeRemoteSync,
} from '@/session/homeRemoteSyncGate';

/**
 * 「跳过登录」无账号态首页兜底专测(修 final-review P1-1)。
 *
 * 主判据是**行为断言**:`runHomeRemoteSync` 是 HomeScreen `loadHome` 真正调用的同一个闸门,
 * 测试用 spy 注入 sync,直接断言「无账号态 0 次 / 有账号 1 次」,换语法或改写调用点都会红。
 * 源码字符串断言只作**辅助**(证明 loadHome 的整个同步体确实包在闸门里、REST 只此一处),
 * 因为 HomeScreen 依赖 expo-router / RN 运行时,本仓 vitest 是 node 环境挂不起组件树。
 */
const homeSource = readFileSync(
  resolve(process.cwd(), 'app/devices/index.tsx'),
  'utf8',
);

describe('isNoAccountHomeMode(无账号态判定)', () => {
  it('仅「跳过登录 ∧ 无账号」为真:有账号路径一律照常同步', () => {
    expect(isNoAccountHomeMode({ hasAccount: false, isLocalMode: true })).toBe(true);
    // 有账号即照常同步——即便 localMode 标记尚未被 applyUser 清掉的交叠瞬间
    expect(isNoAccountHomeMode({ hasAccount: true, isLocalMode: true })).toBe(false);
    expect(isNoAccountHomeMode({ hasAccount: true, isLocalMode: false })).toBe(false);
    // 已登出(理论上路由已跳登录页)不进入无账号态,保持原有 loading/error 语义
    expect(isNoAccountHomeMode({ hasAccount: false, isLocalMode: false })).toBe(false);
  });
});

describe('resolveHomeInitialPhase(首屏相位)', () => {
  const base = {
    deviceIdentityCacheReady: true,
    hasConnectionError: false,
    lastSyncedAt: null as number | null,
    noAccountMode: false,
  };

  it('无账号态直接 ready:既不 spinner 也不 error(不可能有 lastSyncedAt)', () => {
    expect(resolveHomeInitialPhase({ ...base, noAccountMode: true })).toBe('ready');
    // 身份缓存尚未就绪时同样 ready:无账号态没有任何可等的远程结果
    expect(resolveHomeInitialPhase({
      ...base,
      deviceIdentityCacheReady: false,
      noAccountMode: true,
    })).toBe('ready');
    // 即使有残留 connectionError(例如登出瞬间),无账号态也不再展示「同步失败」
    expect(resolveHomeInitialPhase({
      ...base,
      hasConnectionError: true,
      noAccountMode: true,
    })).toBe('ready');
  });

  it('有账号路径逐条保持原判定', () => {
    expect(resolveHomeInitialPhase(base)).toBe('loading');
    expect(resolveHomeInitialPhase({ ...base, hasConnectionError: true })).toBe('error');
    expect(resolveHomeInitialPhase({ ...base, lastSyncedAt: 1 })).toBe('ready');
    // 首轮已成功后再出错仍算已定态(空态不退回 loading / error 首屏)
    expect(resolveHomeInitialPhase({ ...base, hasConnectionError: true, lastSyncedAt: 1 })).toBe('ready');
    // 身份缓存未就绪 → 仍在 loading,不因 lastSyncedAt 有值就提前定态
    expect(resolveHomeInitialPhase({
      ...base,
      deviceIdentityCacheReady: false,
      lastSyncedAt: 1,
    })).toBe('loading');
  });
});

describe('runHomeRemoteSync(行为:无账号态零远程同步调用)', () => {
  const ready = { noAccountMode: false, deviceIdentityCacheReady: true };

  it('无账号态:sync 一次都不调用,返回 undefined', () => {
    const sync = vi.fn(() => Promise.resolve());
    const out = runHomeRemoteSync({ ...ready, noAccountMode: true }, sync);
    expect(sync).toHaveBeenCalledTimes(0);
    expect(out).toBeUndefined();
  });

  it('有账号路径:sync 恰好调用 1 次,且原样交回其返回值(下拉刷新 await 依赖它)', () => {
    const task = Promise.resolve();
    const sync = vi.fn(() => task);
    const out = runHomeRemoteSync(ready, sync);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(out).toBe(task);
  });

  it('闸门与 isNoAccountHomeMode 串起来:只有「跳过登录 ∧ 无账号」被掐,其余三组合照常同步', () => {
    const calls = ([
      { hasAccount: false, isLocalMode: true },
      { hasAccount: true, isLocalMode: true },
      { hasAccount: true, isLocalMode: false },
      { hasAccount: false, isLocalMode: false },
    ] as const).map((auth) => {
      const sync = vi.fn(() => Promise.resolve());
      runHomeRemoteSync(
        { noAccountMode: isNoAccountHomeMode(auth), deviceIdentityCacheReady: true },
        sync,
      );
      return sync.mock.calls.length;
    });
    expect(calls).toEqual([0, 1, 1, 1]);
  });

  it('三入口(冷启动 effect / 同步钮 / 下拉刷新)连打:无账号态累计 0 次,有账号累计 3 次', () => {
    const localSync = vi.fn(() => Promise.resolve());
    const accountSync = vi.fn(() => Promise.resolve());
    for (let i = 0; i < 3; i += 1) {
      runHomeRemoteSync({ ...ready, noAccountMode: true }, localSync);
      runHomeRemoteSync(ready, accountSync);
    }
    expect(localSync).toHaveBeenCalledTimes(0);
    expect(accountSync).toHaveBeenCalledTimes(3);
  });

  it('身份缓存未就绪仍不发请求(原 early return 语义不变),且优先级在无账号态之后不影响结果', () => {
    const sync = vi.fn(() => Promise.resolve());
    expect(runHomeRemoteSync({ noAccountMode: false, deviceIdentityCacheReady: false }, sync))
      .toBeUndefined();
    expect(runHomeRemoteSync({ noAccountMode: true, deviceIdentityCacheReady: false }, sync))
      .toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(0);
  });
});

describe('HomeScreen 接线(辅助断言:证明同步体整体在闸门内)', () => {
  it('loadHome 用 runHomeRemoteSync 包住整个同步体,REST 只在闸门内一处', () => {
    expect(homeSource).toContain(
      "const noAccountMode = isNoAccountHomeMode({ hasAccount: user !== null, isLocalMode });",
    );
    const start = homeSource.indexOf('const loadHome = useCallback(');
    expect(start).toBeGreaterThan(0);
    const gateAt = homeSource.indexOf(
      'return runHomeRemoteSync({ noAccountMode, deviceIdentityCacheReady }, () => {',
      start,
    );
    expect(gateAt).toBeGreaterThan(start);
    // 闸门是 loadHome 体内的第一条语句(之前只有注释)→ 短路时走不到任何请求
    expect(homeSource.slice(start, gateAt)).not.toContain('apiFetch');
    // 设备清单 REST 只有这一处,且在闸门之后
    const fetchAt = homeSource.indexOf("apiFetch<{ devices: DeviceView[] }>('/api/device-link/devices'");
    expect(fetchAt).toBeGreaterThan(gateAt);
  });

  it('全部同步入口都只经 loadHome,没有旁路的鉴权请求', () => {
    // 同步钮 / 下拉刷新都走 loadHome({ visible: true }),effect 走 loadHome({ visible: false })
    expect(homeSource).toContain("onPress={() => void loadHome({ visible: true })}");
    expect(homeSource).toContain('onRefresh={() => void loadHome({ visible: true })}');
    expect(homeSource).toContain("void loadHome({ visible: false });");
    // 首页只有设备清单与重命名两处 apiFetch(重命名需已有设备,无账号态不可达)
    expect(homeSource.match(/apiFetch</g)).toHaveLength(2);
  });

  it('首屏相位 / 连接条 / 下拉刷新按闸门分支(无 spinner、无错误条、无死手势)', () => {
    expect(homeSource).toContain('const initialHomePhase = resolveHomeInitialPhase({');
    expect(homeSource).toContain("const initialHomeSettled = initialHomePhase === 'ready';");
    expect(homeSource).toContain("const initialHomeError = initialHomePhase === 'error';");
    expect(homeSource).toContain(
      "const showConnectionRow = !noAccountMode && (!!connectionError || status !== 'online');",
    );
    expect(homeSource).toContain('refreshControl={noAccountMode');
    // syncError 空态仍只由 initialHomeError 驱动(闸门下它恒 false)
    expect(homeSource).toContain("testID={initialHomeError ? 'home.syncError' : 'home.empty'}");
    // 设备筛选偏好校验也要跳过:无账号态的 settled 不代表同步过设备清单,
    // 拿空清单校验会清掉上一个登录账号存的选择
    expect(homeSource).toContain('if (noAccountMode || !initialHomeSettled || !selectedDeviceId) return;');
  });
});
