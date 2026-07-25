import { beforeEach, describe, expect, it, vi } from 'vitest';

// crashCapture.ts 顶层 import react-native(Platform)/ expo-file-system(File API),
// vitest node 环境解析不了真模块;照仓内惯例(见 jsStallWatchdog.test.ts)mock 掉。
// expo-file-system 用一份内存 fs,按文件名共享内容,让 crash.log / boot.json 的
// 读写在多次 new File(...) 之间可见——这正是要覆盖的 handler 链 + IO 接线。

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, constants: { Model: 'Y700', Brand: 'lenovo' } },
}));

vi.mock('expo-updates', () => ({
  runtimeVersion: '1.0.0',
  updateId: null,
  channel: 'production',
}));

vi.mock('expo-file-system', () => {
  const store = new Map<string, string>();
  class FakeDirectory {
    constructor(..._args: unknown[]) {}
    get exists(): boolean {
      return true;
    }
    create(): void {}
  }
  class FakeFile {
    private readonly name: string;
    constructor(_base: unknown, name: string) {
      this.name = name;
    }
    get exists(): boolean {
      return store.has(this.name);
    }
    get size(): number {
      return store.get(this.name)?.length ?? 0;
    }
    get uri(): string {
      return `file:///crash/${this.name}`;
    }
    textSync(): string {
      const value = store.get(this.name);
      if (value == null) throw new Error('ENOENT');
      return value;
    }
    write(contents: string): void {
      store.set(this.name, String(contents));
    }
    delete(): void {
      store.delete(this.name);
    }
  }
  return { Directory: FakeDirectory, File: FakeFile, Paths: { document: {} }, __store: store };
});

import * as ExpoFS from 'expo-file-system';
import {
  __resetCrashCaptureForTest,
  clearCrashLog,
  getCrashLogFile,
  hasCrashLog,
  hasPreviousAbnormalExit,
  installCrashCapture,
  markBootPhase,
  readCrashLog,
  recordReactError,
  reloadWithMarker,
} from '@/debug/crashCapture';

const store = (ExpoFS as unknown as { __store: Map<string, string> }).__store;

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

function stubErrorUtils(previous?: GlobalHandler): { current: GlobalHandler | undefined } {
  const state: { current: GlobalHandler | undefined } = { current: previous };
  (globalThis as unknown as { ErrorUtils: unknown }).ErrorUtils = {
    getGlobalHandler: () => state.current,
    setGlobalHandler: (handler: GlobalHandler) => {
      state.current = handler;
    },
  };
  return state;
}

function seedBootMarker(phase: string): void {
  store.set('boot.json', JSON.stringify({ phase, at: 1 }));
}

beforeEach(() => {
  __resetCrashCaptureForTest();
  store.clear();
  delete (globalThis as unknown as { ErrorUtils?: unknown }).ErrorUtils;
  delete (globalThis as unknown as { HermesInternal?: unknown }).HermesInternal;
});

describe('handler 链', () => {
  it('install 包裹 ErrorUtils,捕获未捕获异常并落盘,同时调用原 handler', () => {
    const previous = vi.fn();
    const state = stubErrorUtils(previous);

    installCrashCapture();
    // 装了新 handler(≠ 原 previous)。
    expect(state.current).toBeTypeOf('function');
    expect(state.current).not.toBe(previous);

    state.current?.(new Error('kaboom-uncaught'), true);
    const log = readCrashLog();
    expect(log).toContain('uncaught');
    expect(log).toContain('kaboom-uncaught');
    // 原 handler 仍被调用(保留默认崩溃流程)。
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it('正式包 Hermes:走 HermesInternal.enablePromiseRejectionTracker,回调落盘 rejection', () => {
    stubErrorUtils();
    const enable = vi.fn();
    (globalThis as unknown as { HermesInternal: unknown }).HermesInternal = {
      hasPromise: () => true,
      enablePromiseRejectionTracker: enable,
    };

    installCrashCapture();
    expect(enable).toHaveBeenCalledTimes(1);
    const options = enable.mock.calls[0][0] as {
      allRejections?: boolean;
      onUnhandled?: (id: unknown, error: unknown) => void;
    };
    expect(options.allRejections).toBe(true);

    options.onUnhandled?.(7, new Error('kaboom-rejection'));
    const log = readCrashLog();
    expect(log).toContain('unhandledRejection');
    expect(log).toContain('kaboom-rejection');
  });

  it('缺少 ErrorUtils 时静默跳过,不抛', () => {
    expect(() => installCrashCapture()).not.toThrow();
  });

  it('幂等:重复 install 不重复包裹', () => {
    const state = stubErrorUtils();
    installCrashCapture();
    const first = state.current;
    installCrashCapture();
    expect(state.current).toBe(first);
  });
});

describe('IO 接线与启动面包屑', () => {
  it('干净启动:置 boot=starting,但不写 session 头(crash.log 保持空,hasCrashLog=false)', () => {
    stubErrorUtils();
    installCrashCapture();
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('starting');
    // 惰性头:没有任何崩溃时不写内容,否则 export/clear/「无崩溃」态失效。
    expect(readCrashLog()).toBe('');
    expect(hasCrashLog()).toBe(false);
  });

  it('首条崩溃时惰性补写 session 头', () => {
    stubErrorUtils();
    installCrashCapture();
    expect(readCrashLog()).toBe('');
    recordReactError(new Error('boom'));
    const log = readCrashLog();
    expect(log).toContain('=== session');
    expect(log).toContain('boom');
    expect(hasCrashLog()).toBe(true);
  });

  it('上次卡在非终态:标记异常并补记一条(含 session 头)', () => {
    seedBootMarker('endpoints');
    stubErrorUtils();
    installCrashCapture();
    expect(hasPreviousAbnormalExit()).toBe(true);
    const log = readCrashLog();
    expect(log).toContain('=== session');
    expect(log).toContain("previous launch did not reach 'ready'");
  });

  it("上次是 crashed:判为异常并给出崩溃文案", () => {
    seedBootMarker('crashed');
    stubErrorUtils();
    installCrashCapture();
    expect(hasPreviousAbnormalExit()).toBe(true);
    expect(readCrashLog()).toContain('previous launch crashed');
  });

  it("上次是 reloading(预期内主动重载):视为正常,不补记、不写头", () => {
    seedBootMarker('reloading');
    stubErrorUtils();
    installCrashCapture();
    expect(hasPreviousAbnormalExit()).toBe(false);
    expect(readCrashLog()).toBe('');
  });

  it('致命未捕获异常把 boot 标记为 crashed', () => {
    const state = stubErrorUtils();
    installCrashCapture();
    state.current?.(new Error('fatal-boom'), true);
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('crashed');
  });

  it('recordReactError 落盘并把 boot 标记为 crashed;clearCrashLog 后 hasCrashLog=false', () => {
    stubErrorUtils();
    installCrashCapture();
    recordReactError(new Error('render-oops'), '\n  in Foo');
    expect(hasCrashLog()).toBe(true);
    expect(readCrashLog()).toContain('render-oops');
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('crashed');
    expect(getCrashLogFile().uri).toContain('crash.log');
    clearCrashLog();
    expect(hasCrashLog()).toBe(false);
  });

  it('clearCrashLog 后再崩溃会重新补写 session 头(不丢运行环境信息)', () => {
    stubErrorUtils();
    installCrashCapture();
    recordReactError(new Error('first'));
    clearCrashLog();
    recordReactError(new Error('second'));
    const log = readCrashLog();
    expect(log).toContain('=== session');
    expect(log).toContain('second');
  });

  it('markBootPhase 顺序阶段只前进不回退(子 effect 写 auth 后父 effect 写 ota 无效)', () => {
    stubErrorUtils();
    installCrashCapture();
    markBootPhase('auth');
    markBootPhase('ota'); // 父层回写更早阶段,应被忽略
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('auth');
    markBootPhase('ready'); // 继续前进有效
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('ready');
  });

  it('记录抛错场景(stack 非字符串)不吞默认 handler,仍记录并调用原 handler', () => {
    const prev = vi.fn();
    const state = stubErrorUtils(prev);
    installCrashCapture();
    const bad = new Error('weird-stack');
    Object.defineProperty(bad, 'stack', { value: { not: 'a string' } });
    expect(() => state.current?.(bad, true)).not.toThrow();
    expect(prev).toHaveBeenCalledTimes(1);
    expect(readCrashLog()).toContain('weird-stack');
  });
});

describe('reloadWithMarker(OTA 重载顺序)', () => {
  it('先写 boot=reloading,再触发 reloadAsync', async () => {
    stubErrorUtils();
    installCrashCapture();
    let phaseAtReload: string | undefined;
    const reloadAsync = vi.fn(() => {
      // reload 触发时,面包屑必须已是 reloading(顺序保证)。
      phaseAtReload = JSON.parse(store.get('boot.json') ?? '{}').phase;
      return Promise.resolve();
    });
    await reloadWithMarker(reloadAsync);
    expect(reloadAsync).toHaveBeenCalledTimes(1);
    expect(phaseAtReload).toBe('reloading');
  });

  it('reload 失败时恢复原 phase(不残留 reloading 掩盖后续异常)', async () => {
    stubErrorUtils();
    installCrashCapture();
    // 模拟已走到 ready 的正常运行态,随后手动检查更新触发 reload 但失败。
    store.set('boot.json', JSON.stringify({ phase: 'ready', at: 1 }));
    const reloadAsync = vi.fn(() => Promise.reject(new Error('reload unavailable')));
    await expect(reloadWithMarker(reloadAsync)).rejects.toThrow('reload unavailable');
    // phase 必须被恢复成 'ready',而不是残留 'reloading'。
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('ready');
  });

  it('reload 失败且原 phase 是未知/损坏值:仍照原样恢复,不残留 reloading', async () => {
    stubErrorUtils();
    installCrashCapture();
    // 前向兼容 / 损坏的 marker:不在已知枚举内。
    store.set('boot.json', JSON.stringify({ phase: 'future-phase-x', at: 1 }));
    const reloadAsync = vi.fn(() => Promise.reject(new Error('nope')));
    await expect(reloadWithMarker(reloadAsync)).rejects.toThrow('nope');
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('future-phase-x');
  });
});
