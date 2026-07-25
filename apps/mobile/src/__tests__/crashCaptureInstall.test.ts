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
  it('写会话头 + 置 boot=starting', () => {
    stubErrorUtils();
    installCrashCapture();
    expect(readCrashLog()).toContain('=== session');
    expect(JSON.parse(store.get('boot.json') ?? '{}').phase).toBe('starting');
  });

  it('上次卡在非终态:标记异常并补记一条', () => {
    seedBootMarker('endpoints');
    stubErrorUtils();
    installCrashCapture();
    expect(hasPreviousAbnormalExit()).toBe(true);
    expect(readCrashLog()).toContain("previous launch did not reach 'ready'");
  });

  it("上次是 reloading(预期内主动重载):视为正常,不补记", () => {
    seedBootMarker('reloading');
    stubErrorUtils();
    installCrashCapture();
    expect(hasPreviousAbnormalExit()).toBe(false);
    expect(readCrashLog()).not.toContain('previous launch did not reach');
  });

  it('recordReactError 落盘;clearCrashLog 后 hasCrashLog=false', () => {
    stubErrorUtils();
    installCrashCapture();
    recordReactError(new Error('render-oops'), '\n  in Foo');
    expect(hasCrashLog()).toBe(true);
    expect(readCrashLog()).toContain('render-oops');
    expect(getCrashLogFile().uri).toContain('crash.log');
    clearCrashLog();
    expect(hasCrashLog()).toBe(false);
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
});
