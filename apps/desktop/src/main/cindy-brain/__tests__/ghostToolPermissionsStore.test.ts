/**
 * ghostToolPermissionsStore.test.ts — 插件工具粒度授权配置的 normalize / 档位解析单测。
 * 存储真身经 createOverrideSettingsFile 落 userData,依赖 electron;这里只测纯函数
 * (坏形态清洗与档位解析),落盘链路由 IPC 层与派发器测试覆盖(与 errandPrefsStore 同口径)。
 */

import { describe, it, expect, vi } from 'vitest';

import type { ToolApprovalMode } from '../../../shared/ghost';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/never-used-here' } }));
vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const storeModule = await import('../ghostToolPermissionsStore');
const { __testing, ghostToolBlockVerdict } = storeModule;
const { normalizeConfig, normalize, resolveModeFromConfig } = __testing;

describe('normalizeConfig(单插件授权配置清洗)', () => {
  it('合法档位保留,非法档位逐项丢弃(= 回到默认 needs-approval)', () => {
    expect(
      normalizeConfig({
        globalPolicy: 'always-allow',
        tools: { a: 'blocked', b: 'needs-approval', c: 'always-allow' },
      }),
    ).toEqual({
      globalPolicy: 'always-allow',
      tools: { a: 'blocked', b: 'needs-approval', c: 'always-allow' },
    });

    expect(
      normalizeConfig({
        globalPolicy: 'invalid_value',
        tools: { a: 'invalid_mode', b: 'blocked', '': 'blocked', c: 42 },
      }),
    ).toEqual({ tools: { b: 'blocked' } });
  });

  it('custom 是合法的全局策略(派生态,表示各工具档位不一致)', () => {
    expect(normalizeConfig({ globalPolicy: 'custom' }).globalPolicy).toBe('custom');
  });

  it('非对象输入与数组形态的 tools 都清成空配置', () => {
    expect(normalizeConfig(null)).toEqual({});
    expect(normalizeConfig('always-allow')).toEqual({});
    expect(normalizeConfig({ tools: ['always-allow'] })).toEqual({});
  });
});

describe('normalize(整份授权文件清洗)', () => {
  it('丢弃空配置条目,只保留真正钉了档位的插件', () => {
    expect(
      normalize({
        permissions: {
          kept: { globalPolicy: 'blocked' },
          keptTools: { tools: { a: 'always-allow' } },
          dropped: { globalPolicy: 'nonsense' },
          droppedEmpty: {},
          droppedNotObject: 7,
        },
      }),
    ).toEqual({
      permissions: {
        kept: { globalPolicy: 'blocked' },
        keptTools: { tools: { a: 'always-allow' } },
      },
    });
  });

  it('坏形态整体回落到空表', () => {
    expect(normalize(null)).toEqual({ permissions: {} });
    expect(normalize({ permissions: 'nope' })).toEqual({ permissions: {} });
  });
});

describe('resolveModeFromConfig(档位解析)', () => {
  it('没有任何配置时默认 needs-approval(fail closed,绝不默认免审批)', () => {
    expect(resolveModeFromConfig({}, 'some_tool')).toBe('needs-approval');
  });

  it('未知工具绝不继承 always-allow,但可继承安全收紧的全局策略', () => {
    expect(resolveModeFromConfig({ globalPolicy: 'always-allow' }, 'new_tool')).toBe(
      'needs-approval',
    );
    expect(resolveModeFromConfig({ globalPolicy: 'blocked' }, 'new_tool')).toBe('blocked');
    expect(resolveModeFromConfig({ globalPolicy: 'needs-approval' }, 'new_tool')).toBe(
      'needs-approval',
    );
  });

  it('单工具配置优先于全局策略', () => {
    const cfg = {
      globalPolicy: 'always-allow' as const,
      tools: { sensitive_tool: 'blocked' as const, ask_tool: 'needs-approval' as const },
    };
    expect(resolveModeFromConfig(cfg, 'sensitive_tool')).toBe('blocked');
    expect(resolveModeFromConfig(cfg, 'ask_tool')).toBe('needs-approval');
    expect(resolveModeFromConfig(cfg, 'normal_tool')).toBe('needs-approval');
  });

  it('globalPolicy=custom 不当作档位用,未单独设定的工具落回 needs-approval', () => {
    expect(
      resolveModeFromConfig({ globalPolicy: 'custom', tools: { a: 'always-allow' } }, 'b'),
    ).toBe('needs-approval');
  });
});

describe('ghostToolBlockVerdict(「已阻止」裁决)', () => {
  const TOOLS = [
    { name: 'read_thing', description: '' },
    { name: 'write_thing', description: '' },
  ];
  const resolver =
    (map: Record<string, ToolApprovalMode>) =>
    (_ghostId: string, toolName: string): ToolApprovalMode =>
      map[toolName] ?? 'needs-approval';

  describe('普通调用', () => {
    it('被点名的工具是 blocked → 拒', () => {
      const verdict = ghostToolBlockVerdict(
        'demo',
        'write_thing',
        TOOLS,
        false,
        resolver({ write_thing: 'blocked' }),
      );
      expect(verdict).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
      expect(verdict?.message).toContain('write_thing');
    });

    it('always-allow / needs-approval 都放行(免审批不归本函数管)', () => {
      expect(
        ghostToolBlockVerdict('demo', 'read_thing', TOOLS, false, resolver({ read_thing: 'always-allow' })),
      ).toBeNull();
      expect(ghostToolBlockVerdict('demo', 'read_thing', TOOLS, false, resolver({}))).toBeNull();
    });

    it('同插件的另一个工具被禁不连坐', () => {
      expect(
        ghostToolBlockVerdict('demo', 'read_thing', TOOLS, false, resolver({ write_thing: 'blocked' })),
      ).toBeNull();
    });
  });

  // grant_only 只过户不派发,走不到 pipeDispatcher 的资格审——判据错了就等于
  // 给被禁插件留了一条拿文件的后门。
  describe('grant_only', () => {
    it('工具被全禁 → 拒:没有合法的后续调用,预授权只剩绕过禁用一个用途', () => {
      const verdict = ghostToolBlockVerdict(
        'demo',
        'anything',
        TOOLS,
        true,
        resolver({ read_thing: 'blocked', write_thing: 'blocked' }),
      );
      expect(verdict).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
      expect(verdict?.message).toContain('全部工具');
    });

    it('显式点名一个已声明且被禁的工具 → 拒(比协议上的「忽略 tool」更保守)', () => {
      expect(
        ghostToolBlockVerdict('demo', 'write_thing', TOOLS, true, resolver({ write_thing: 'blocked' })),
      ).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    });

    it('还有工具没被禁、且点名的不是被禁工具 → 放行', () => {
      expect(
        ghostToolBlockVerdict('demo', 'read_thing', TOOLS, true, resolver({ write_thing: 'blocked' })),
      ).toBeNull();
      // tool 是垃圾值(协议允许忽略)时按插件层判据走。
      expect(
        ghostToolBlockVerdict('demo', 'not_a_tool', TOOLS, true, resolver({ write_thing: 'blocked' })),
      ).toBeNull();
    });

    it('未声明任何工具的插件不适用本判据,交回原有 TOOL_NOT_FOUND 链路', () => {
      expect(ghostToolBlockVerdict('demo', 'anything', [], true, resolver({}))).toBeNull();
      expect(ghostToolBlockVerdict('demo', 'anything', undefined, true, resolver({}))).toBeNull();
    });
  });
});
