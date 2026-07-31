/**
 * errandPrefsStore.test.ts — 派活配置存储的 normalize 单测。
 * 存储真身经 createOverrideSettingsFile 落 userData,依赖 electron;这里
 * 只测纯函数(坏形态清洗与权限档白名单),读写链路由 IPC 层与 runner 测试覆盖。
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { __testing } = await import('../errandPrefsStore');

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
        effort: 'minimal',
        fastMode: 'yes',
        permissionMode: 'bypassPermissions',
        workingDir: 42,
      }),
    ).toEqual({});
  });

  it('permissionMode 白名单:bypassPermissions / ask 等一律清掉', () => {
    expect(__testing.normalizeConfig({ permissionMode: 'plan' })).toEqual({
      permissionMode: 'plan',
    });
    expect(__testing.normalizeConfig({ permissionMode: 'auto' })).toEqual({
      permissionMode: 'auto',
    });
    expect(__testing.normalizeConfig({ permissionMode: 'bypassPermissions' })).toEqual({});
    expect(__testing.normalizeConfig({ permissionMode: 'ask' })).toEqual({});
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

  it('非对象/缺区 → 全空', () => {
    expect(__testing.normalize(null)).toEqual({ errand: {}, sessions: {} });
    expect(__testing.normalize({})).toEqual({ errand: {}, sessions: {} });
  });
});
