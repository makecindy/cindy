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
const { normalizeConfig, normalize, resolveModeFromConfig, undeclaredToolPermissionKeys } =
  __testing;

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

describe('undeclaredToolPermissionKeys(manifest 写入白名单)', () => {
  const declared = [
    { name: 'read', description: '' },
    { name: 'write', description: '' },
  ];

  it('只允许当前已安装 manifest 声明的工具键', () => {
    expect(
      undeclaredToolPermissionKeys(
        { tools: { read: 'blocked', write: 'needs-approval' } },
        declared,
      ),
    ).toEqual([]);
    expect(
      undeclaredToolPermissionKeys(
        { tools: { read: 'blocked', new_sensitive: 'always-allow', future: 'blocked' } },
        declared,
      ),
    ).toEqual(['new_sensitive', 'future']);
  });

  it('空配置与无 tools 的全局收紧策略不会产生伪键', () => {
    expect(undeclaredToolPermissionKeys(null, declared)).toEqual([]);
    expect(undeclaredToolPermissionKeys({ globalPolicy: 'blocked' }, declared)).toEqual([]);
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

  // 工具名由插件作者完全控制。普通 `{}` 上 `tools['constructor']` 读到的是
  // Object.prototype.constructor(truthy 但不是档位),旧实现会据此 return 并
  // **跳过下面的 globalPolicy 继承** —— 用户选了「全部阻止」,插件更新后新增的
  // 同名工具反而拿不到 blocked。
  const PROTOTYPE_KEYS = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
  ];

  it('原型链上的键不算「已配置」:全局 blocked 仍然覆盖这些工具名', () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(resolveModeFromConfig({ globalPolicy: 'blocked', tools: { other: 'blocked' } }, key)).toBe(
        'blocked',
      );
      // 没有全局策略时同样必须落到 fail-closed 的默认档,而不是返回一个函数。
      expect(resolveModeFromConfig({ tools: { other: 'blocked' } }, key)).toBe('needs-approval');
    }
  });

  it('normalizeConfig 产出的 tools 表是 null 原型,查不到继承成员', () => {
    const cfg = normalizeConfig({ tools: { real_tool: 'blocked' } });
    expect(Object.getPrototypeOf(cfg.tools)).toBeNull();
    for (const key of PROTOTYPE_KEYS) {
      expect(cfg.tools?.[key]).toBeUndefined();
    }
    expect(cfg.tools?.real_tool).toBe('blocked');
  });

  it('叫这些名字的工具被显式设定时照常生效(修复不能误伤合法配置)', () => {
    const cfg = normalizeConfig({ tools: { constructor: 'always-allow', toString: 'blocked' } });
    expect(resolveModeFromConfig(cfg, 'constructor')).toBe('always-allow');
    expect(resolveModeFromConfig(cfg, 'toString')).toBe('blocked');
  });

  it('叫 __proto__ 的工具能真正落表(普通对象上赋值是改原型的空操作,存不进去)', () => {
    // 对象字面量写 `__proto__:` 不产生自有键;renderer 经 IPC 送来的形态
    // 与 JSON.parse 一致,`__proto__` 是货真价实的自有键,必须存得住也读得到。
    const raw = JSON.parse('{"tools":{"__proto__":"blocked","real":"always-allow"}}') as unknown;
    const cfg = normalizeConfig(raw);
    expect(Object.keys(cfg.tools ?? {})).toContain('__proto__');
    expect(resolveModeFromConfig(cfg, '__proto__')).toBe('blocked');
    expect(resolveModeFromConfig(cfg, 'real')).toBe('always-allow');
    // 写入白名单同样看得见它,未声明就会被 IPC 边界挡掉。
    expect(undeclaredToolPermissionKeys(raw, [{ name: 'real', description: '' }])).toEqual([
      '__proto__',
    ]);
  });

  it('自有键上的非法值不被当档位用,回落到全局策略/默认档', () => {
    const bogus = { tools: { weird: 42 } } as unknown as Parameters<typeof resolveModeFromConfig>[0];
    expect(resolveModeFromConfig(bogus, 'weird')).toBe('needs-approval');
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
