/**
 * defaults.ts(Hook 新会话 agent/model/effort/permissionMode/providerId 合成)单测:
 * 取值链「显式 override > 草稿默认 > capabilities 兜底」与非法值回落;
 * permissionMode 取值链是「显式且该 agent 支持 > 显式但不支持时回落该 agent 最严档
 * > 无显式偏好时 bypassPermissions」(无草稿层; 不支持时只能更严不能更宽, 见下方
 * 安全修正注释); providerId 无 override 通道, 恒取最终 agentKind 的草稿默认
 * (空白归一 null; 连接态校验在 session-runner 异步做, 不在本纯函数)。
 */

import { describe, expect, it } from 'vitest';

import { resolveHookSessionConfig, type HookDefaultsDeps } from '../defaults';

const noopLog = { warn: () => {} };

function deps(over?: Partial<HookDefaultsDeps>): HookDefaultsDeps {
  return {
    readDefaults: () => ({
      agentKind: 'claude-code',
      agents: {
        'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
        codex: { providerId: 'xd', model: 'gpt-5.5', effort: 'high' },
      },
    }),
    getModels: (agentKind) =>
      agentKind === 'claude-code'
        ? [
            { id: 'claude-opus-4-8', efforts: ['low', 'high', 'xhigh'], defaultEffort: 'high' },
            { id: 'claude-haiku-4-5', efforts: [], defaultEffort: null },
          ]
        : [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
    getPermissionModes: (agentKind) =>
      agentKind === 'claude-code'
        ? ['ask', 'acceptEdits', 'auto', 'bypassPermissions']
        : ['ask', 'auto', 'bypassPermissions'],
    log: noopLog,
    ...over,
  };
}

/** override 缺省全 null 的快捷构造。 */
function over(
  patch?: Partial<{ agentKind: string; model: string; effort: string; permissionMode: string }>,
): { agentKind: string | null; model: string | null; effort: string | null; permissionMode: string | null } {
  return {
    agentKind: patch?.agentKind ?? null,
    model: patch?.model ?? null,
    effort: patch?.effort ?? null,
    permissionMode: patch?.permissionMode ?? null,
  };
}

describe('resolveHookSessionConfig', () => {
  it('无 override: 全部落草稿默认, 权限落 bypass', () => {
    const r = resolveHookSessionConfig(deps(), over());
    expect(r).toEqual({
      agentKind: 'claude-code',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'bypassPermissions',
      providerId: null,
    });
  });

  it('合法 override 四元组全部生效', () => {
    const r = resolveHookSessionConfig(
      deps(),
      over({ agentKind: 'codex', model: 'gpt-5.5', effort: 'low', permissionMode: 'auto' }),
    );
    expect(r).toEqual({
      agentKind: 'codex',
      model: 'gpt-5.5',
      effort: 'low',
      permissionMode: 'auto',
      providerId: 'xd',
    });
  });

  it('override 模型不在实时目录: 记录告警并降级到可用桌面默认', () => {
    const warns: string[] = [];
    const r = resolveHookSessionConfig(
      deps({ log: { warn: (message) => warns.push(message) } }),
      over({ model: 'claude-ancient-1' }),
    );
    expect(r.model).toBe('claude-opus-4-8');
    expect(warns.some((message) => message.includes('claude-ancient-1'))).toBe(true);
  });

  it('override effort 不被该模型支持: 回落草稿默认档, 草稿也不支持时用模型默认档', () => {
    const r = resolveHookSessionConfig(deps(), over({ effort: 'ultra' }));
    expect(r.effort).toBe('xhigh'); // 草稿档合法, 用草稿
    const r2 = resolveHookSessionConfig(
      deps({
        readDefaults: () => ({
          agentKind: 'claude-code',
          agents: {
            'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'ultra-draft' },
            codex: { providerId: null, model: 'gpt-5.5', effort: 'high' },
          },
        }),
      }),
      over({ effort: 'ultra' }),
    );
    expect(r2.effort).toBe('high'); // 模型 defaultEffort
  });

  it('模型不支持调档(efforts 空): effort 为 undefined', () => {
    const r = resolveHookSessionConfig(deps(), over({ model: 'claude-haiku-4-5', effort: 'high' }));
    expect(r).toMatchObject({ model: 'claude-haiku-4-5', effort: undefined });
  });

  it('普通桌面默认确实不可用: 回落当前来源目录第一项', () => {
    const r = resolveHookSessionConfig(
      deps({
        readDefaults: () => ({
          agentKind: 'claude-code',
          agents: {
            'claude-code': { providerId: null, model: 'gone-model', effort: 'high' },
            codex: { providerId: null, model: 'gpt-5.5', effort: 'high' },
          },
        }),
      }),
      over(),
    );
    expect(r.model).toBe('claude-opus-4-8');
  });

  it('permissionMode: 合法显式值生效(含 claude 专属 acceptEdits)', () => {
    expect(resolveHookSessionConfig(deps(), over({ permissionMode: 'ask' })).permissionMode).toBe('ask');
    expect(
      resolveHookSessionConfig(deps(), over({ permissionMode: 'acceptEdits' })).permissionMode,
    ).toBe('acceptEdits');
  });

  // 2026-07 安全修正:原实现在「显式档不被该 agent 支持」时回落 bypassPermissions
  // (最宽档)。用户填过显式档 = 表达过「不要默认的完全访问」,换 agent 后被静默放宽成
  // 完全访问,而这是无人值守的 IM 派发链路,没有人在旁边确认。现在一律回落该 agent 的
  // **最严**档(permissionModes 从严到宽声明,取 [0])。
  it('permissionMode: 显式档不被该 agent 支持时回落最严档而非 bypass(codex 无 acceptEdits)', () => {
    const warns: string[] = [];
    const r = resolveHookSessionConfig(
      deps({ log: { warn: (m) => warns.push(m) } }),
      over({ agentKind: 'codex', model: 'gpt-5.5', permissionMode: 'acceptEdits' }),
    );
    expect(r.permissionMode).toBe('ask');
    expect(r.permissionMode).not.toBe('bypassPermissions');
    expect(warns.some((m) => m.includes('acceptEdits'))).toBe(true);
  });

  it('permissionMode: 未知档同样回落最严档, 不因无法识别而放宽', () => {
    expect(resolveHookSessionConfig(deps(), over({ permissionMode: 'yolo' })).permissionMode).toBe(
      'ask',
    );
  });

  it('permissionMode: 从未填显式档 → bypass(无人值守历史默认, 本次不改)', () => {
    expect(resolveHookSessionConfig(deps(), over()).permissionMode).toBe('bypassPermissions');
  });

  it('permissionMode: 该 agent 无任何档位声明时才兜底 bypass', () => {
    const r = resolveHookSessionConfig(
      deps({ getPermissionModes: () => [] }),
      over({ permissionMode: 'acceptEdits' }),
    );
    expect(r.permissionMode).toBe('bypassPermissions');
  });

  it('providerId: 跟随最终 agentKind 的草稿默认(agent override 切换后取对应组)', () => {
    // 默认 agent 是 claude-code(providerId null); override 到 codex 后取 codex 组的 'xd'
    expect(resolveHookSessionConfig(deps(), over()).providerId).toBeNull();
    expect(
      resolveHookSessionConfig(deps(), over({ agentKind: 'codex' })).providerId,
    ).toBe('xd');
  });

  it('providerId: 空白串归一 null', () => {
    const r = resolveHookSessionConfig(
      deps({
        readDefaults: () => ({
          agentKind: 'codex',
          agents: {
            'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'xhigh' },
            codex: { providerId: '  ', model: 'gpt-5.5', effort: 'high' },
          },
        }),
      }),
      over(),
    );
    expect(r.providerId).toBeNull();
  });
});
