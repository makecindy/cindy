import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 首启亮色门三态回归(Greptile P1:AsyncStorage 未决窗口透传系统暗色 →
 * 判定后切亮 = 首启闪变)。三态语义:未决 = 'pending'(消费方不渲染品牌
 * 内容,结构上不存在错误主题帧),判定后 'light'(真首启)/'passthrough'
 * (老用户)。模块有 eager kick + 模块级缓存,每个用例 resetModules 后
 * 动态 import 以获得干净状态。
 */

type GateModule = typeof import('../loginFirstLaunchGate');

let resolveGetItem: (value: string | null) => void;
let rejectGetItem: (err: unknown) => void;
const setItem = vi.fn(() => Promise.resolve());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(
      () =>
        new Promise<string | null>((resolve, reject) => {
          resolveGetItem = resolve;
          rejectGetItem = reject;
        }),
    ),
    setItem,
  },
}));

async function importFreshGate(): Promise<GateModule> {
  vi.resetModules();
  return import('../loginFirstLaunchGate');
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  setItem.mockClear();
});

describe('loginFirstLaunchGate 三态', () => {
  it('AsyncStorage 未决时为 pending(不产出任何主题决定)', async () => {
    const gate = await importFreshGate();
    expect(gate.getLoginFirstLaunchGateState()).toBe('pending');
  });

  it('读到空标记 → light(真首启),并落盘「已展示」标记', async () => {
    const gate = await importFreshGate();
    resolveGetItem(null);
    await flushMicrotasks();
    expect(gate.getLoginFirstLaunchGateState()).toBe('light');
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('读到已有标记 → passthrough(老用户透传,不重写标记)', async () => {
    const gate = await importFreshGate();
    resolveGetItem('1750000000000');
    await flushMicrotasks();
    expect(gate.getLoginFirstLaunchGateState()).toBe('passthrough');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('存储读取失败 → passthrough(不强制亮色,跟随系统兜底)', async () => {
    const gate = await importFreshGate();
    rejectGetItem(new Error('storage unavailable'));
    await flushMicrotasks();
    expect(gate.getLoginFirstLaunchGateState()).toBe('passthrough');
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('MobileLoginHandoffStage 消费 pending(源码结构断言,仓内无 render 框架)', () => {
  it('pending 时先 return null,再进 ThemeOverrideProvider(不存在错误主题帧)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/MobileLoginHandoffStage.tsx'),
      'utf8',
    );
    const pendingReturn = source.indexOf('if (handoff.targetTheme == null)');
    const overrideProvider = source.indexOf('<ThemeOverrideProvider');
    expect(pendingReturn, 'pending 早退存在').toBeGreaterThan(-1);
    expect(overrideProvider, 'ThemeOverrideProvider 渲染存在').toBeGreaterThan(-1);
    expect(pendingReturn, 'pending 早退必须在渲染之前').toBeLessThan(overrideProvider);
  });
});
