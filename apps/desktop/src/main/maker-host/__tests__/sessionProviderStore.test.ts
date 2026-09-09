/**
 * session-provider-store 启动派发边界单测(Refs #4154)。
 * 不变量:三态 id / null / undefined —— 把 undefined 折叠成 null 会清掉
 * learn-host 等在 createSession 之前自行写好 store 的路径。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllSessionProviders,
  freezeSessionProviderAtStart,
  getSessionProvider,
  hasSessionProvider,
  setSessionProvider,
} from '../session-provider-store';

describe('freezeSessionProviderAtStart', () => {
  beforeEach(() => {
    clearAllSessionProviders();
  });

  it('显式来源在 spawn 前即可被路由层读到', () => {
    freezeSessionProviderAtStart('s-custom', 'my-relay');
    expect(getSessionProvider('s-custom')).toBe('my-relay');
  });

  it('显式 null 登记为「已知的默认路由」,不是未登记', () => {
    freezeSessionProviderAtStart('s-default', null);
    expect(hasSessionProvider('s-default')).toBe(true);
    expect(getSessionProvider('s-default')).toBeNull();
  });

  it('undefined 表示调用方未携带选择:不登记,也不清掉已写入的选择', () => {
    expect(hasSessionProvider('s-untouched')).toBe(false);
    freezeSessionProviderAtStart('s-untouched', undefined);
    expect(hasSessionProvider('s-untouched')).toBe(false);

    // learn-host / cardActionHandler 会在 createSession 之前自己写 store。
    setSessionProvider('s-preset', 'my-relay');
    freezeSessionProviderAtStart('s-preset', undefined);
    expect(getSessionProvider('s-preset')).toBe('my-relay');
  });

  it('空白字符串按清除处理,与 setSessionProvider 同口径', () => {
    freezeSessionProviderAtStart('s-blank', '  ');
    expect(hasSessionProvider('s-blank')).toBe(true);
    expect(getSessionProvider('s-blank')).toBeNull();
  });
});

/**
 * 接线本身也要钉住,否则删掉调用点这组三态断言照样全绿。钩子早于
 * `agent.startSession` 那半由 maker-core 的 order 断言保证,这里不重复。
 */
describe('启动边界接线', () => {
  it('冻结挂在 prepareStartOptions 内,且排在账号就绪门之后', () => {
    const makerHostSource = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
    const hook = makerHostSource.indexOf('prepareStartOptions: async');
    const gate = makerHostSource.indexOf('!providerReady', hook);
    const freeze = makerHostSource.indexOf('freezeSessionProviderAtStart(sessionId', hook);

    expect(hook).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(hook);
    expect(freeze).toBeGreaterThan(gate);
  });
});
