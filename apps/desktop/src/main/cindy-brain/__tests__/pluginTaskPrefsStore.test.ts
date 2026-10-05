/**
 * pluginTaskPrefsStore.test.ts — 派活配置存储的 normalize 单测。
 * 存储真身经 createOverrideSettingsFile 落 userData,依赖 electron;这里
 * 只测纯函数(坏形态清洗与权限档白名单),读写链路由 IPC 层与 runner 测试覆盖。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing, validatePluginTaskConfig, setPluginTaskConfigValidator } = await import('../pluginTaskPrefsStore');

describe('normalizeConfig(单插件配置清洗)', () => {
  it('合法字段保留,非法值逐字段丢弃(= 回到跟随默认)', () => {
    expect(
      __testing.normalizeConfig({
        agentKind: 'codex',
        model: 'gpt-x',
        effort: 'high',
        fastMode: true,
        providerId: 'openai',
        permissionMode: 'acceptEdits',
        workingDir: '/proj/demo',
      }),
    ).toEqual({
      agentKind: 'codex',
      model: 'gpt-x',
      effort: 'high',
      fastMode: true,
      providerId: 'openai',
      permissionMode: 'acceptEdits',
      workingDir: '/proj/demo',
    });
    expect(
      __testing.normalizeConfig({
        agentKind: 'claude',
        model: '',
        effort: 'unknown',
        fastMode: 'yes',
        permissionMode: 'bypassPermissions',
        workingDir: 42,
      }),
    ).toEqual({});
  });

  it('保留普通任务的 ask 和旧 plan 配置，拒绝完全访问', () => {
    expect(__testing.normalizeConfig({ permissionMode: 'plan' })).toEqual({
      permissionMode: 'plan',
    });
    expect(__testing.normalizeConfig({ permissionMode: 'auto' })).toEqual({
      permissionMode: 'auto',
    });
    expect(__testing.normalizeConfig({ permissionMode: 'bypassPermissions' })).toEqual({});
    expect(__testing.normalizeConfig({ permissionMode: 'ask' })).toEqual({ permissionMode: 'ask' });
  });

  it('Pi 是合法的代办 agent', () => {
    expect(__testing.normalizeConfig({ agentKind: 'pi' })).toEqual({ agentKind: 'pi' });
  });

  it('非对象入参 → 空配置', () => {
    expect(__testing.normalizeConfig(null)).toEqual({});
    expect(__testing.normalizeConfig('x')).toEqual({});
  });
});

describe('normalize(整文件清洗)', () => {
  it('errand 与 sessions 两区各自清洗;空配置条目剔除', () => {
    expect(
      __testing.normalize({
        errand: {
          helper: { agentKind: 'cc' },
          junk: { agentKind: 'nope' },
          broken: 'not-an-object',
        },
        sessions: { helper: 'sess-1', bad: 42, empty: '' },
      }),
    ).toEqual({
      errand: { helper: { agentKind: 'cc' } },
      sessions: { helper: 'sess-1' },
    });
  });

  it('带钥匙的 sessions 条目(ghostId#key)原样保留', () => {
    expect(
      __testing.normalize({
        errand: {},
        sessions: { helper: 'sess-1', 'helper#pr-123': 'sess-2' },
      }),
    ).toEqual({
      errand: {},
      sessions: { helper: 'sess-1', 'helper#pr-123': 'sess-2' },
    });
  });

  it('非对象/缺区 → 全空', () => {
    expect(__testing.normalize(null)).toEqual({ errand: {}, sessions: {} });
    expect(__testing.normalize({})).toEqual({ errand: {}, sessions: {} });
  });
});

describe('sessionMapKey(会话映射键)', () => {
  it('缺省 = ghostId 本身;带钥匙 = ghostId#key(两侧字符集都不含 #,无歧义)', () => {
    expect(__testing.sessionMapKey('helper')).toBe('helper');
    expect(__testing.sessionMapKey('helper', undefined)).toBe('helper');
    expect(__testing.sessionMapKey('helper', 'pr-123')).toBe('helper#pr-123');
  });
});


describe('validating user task preferences before saving', () => {
  it('rejects unavailable explicit routes and malformed authority instead of silently saving defaults', async () => {
    const validate = vi.fn(async () => { throw new Error('供应商未连接，请修复连接'); });
    setPluginTaskConfigValidator(validate);
    await expect(validatePluginTaskConfig({ agentKind: 'codex', model: 'selected', providerId: 'removed' }))
      .rejects.toThrow('修复连接');
    await expect(validatePluginTaskConfig({ permissionMode: 'bypassPermissions' })).rejects.toThrow('permissionMode');
    expect(validate).toHaveBeenCalledOnce();
  });
  it('lets the user clear a broken model without losing independent permissions or directory', async () => {
    const validate = vi.fn(async () => { throw new Error('model unavailable'); });
    setPluginTaskConfigValidator(validate);
    await expect(validatePluginTaskConfig({ permissionMode: 'auto', workingDir: '/user-selected' })).resolves.toBeUndefined();
    await expect(validatePluginTaskConfig(null)).resolves.toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  });
});
