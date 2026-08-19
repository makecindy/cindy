/**
 * 伙伴对话输入框 → 伙伴 Profile 的运行时回写判定。
 *
 * 这一层存在的唯一理由:伙伴主任务会在 Renew 时**按 Profile 重建**,输入框只写
 * 会话行的话,用户在对话里选的模型会在 Renew 之后悄悄跳回去。
 */
import { describe, expect, it } from 'vitest';

import {
  botComposerRuntimePatch,
  botPermissionsForSessionMode,
  mergeBotComposerRuntime,
} from '../botComposerRuntime';
import type { BotCapabilities } from '../botStore';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-sonnet-4-6',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: true,
    permissions: 'trusted',
    sessionControlMode: 'none',
    ...overrides,
  };
}

describe('权限映射', () => {
  it('与 main 侧 botSessionPermissionMode 互为逆运算', () => {
    expect(botPermissionsForSessionMode('bypassPermissions')).toBe('trusted');
    expect(botPermissionsForSessionMode('ask')).toBe('ask');
    expect(botPermissionsForSessionMode('acceptEdits')).toBe('ask');
    expect(botPermissionsForSessionMode(null)).toBe('ask');
  });
});

describe('会话快照折算成 Profile 的运行时子集', () => {
  it('缺字段回落当前值,不会把伙伴的模型清空', () => {
    const patch = botComposerRuntimePatch(capabilities({ model: 'gpt-5.5' }), {});
    expect(patch.model).toBe('gpt-5.5');
    expect(patch.effort).toBe('medium');
    expect(patch.permissions).toBe('trusted');
  });

  it('空串等同于缺失(冷启动首帧的 session 行可能还没回流)', () => {
    const patch = botComposerRuntimePatch(capabilities(), { model: '  ', effort: '' });
    expect(patch.model).toBe('claude-sonnet-4-6');
    expect(patch.effort).toBe('medium');
  });

  it('显式 null 的 providerId 是「清除选择」,不是缺失', () => {
    const patch = botComposerRuntimePatch(capabilities({ providerId: 'xd' }), {
      providerId: null,
    });
    expect(patch.providerId).toBeNull();
  });
});

describe('等值短路', () => {
  it('没有变化时返回 null —— 否则每次刷新都会白顶一次 Profile 版本号', () => {
    expect(
      mergeBotComposerRuntime(capabilities(), {
        model: 'claude-sonnet-4-6',
        effort: 'medium',
        permissionMode: 'bypassPermissions',
        fastMode: false,
        providerId: null,
      }),
    ).toBeNull();
    expect(mergeBotComposerRuntime(capabilities(), {})).toBeNull();
  });

  it('真的换了模型才写回,而且只动运行时那几个字段', () => {
    const current = capabilities({ skills: undefined } as Partial<BotCapabilities>);
    const next = mergeBotComposerRuntime(current, { model: 'gpt-5.5' });
    expect(next).not.toBeNull();
    expect(next?.model).toBe('gpt-5.5');
    // harness / skills / mcp 等 Profile 内容一律原样带过去。
    expect(next?.harness).toBe(current.harness);
    expect(next?.skillMode).toBe(current.skillMode);
    expect(next?.sessionControlMode).toBe(current.sessionControlMode);
    expect(next?.automation).toBe(current.automation);
  });

  it('权限从「放手做」收回「每步确认」也会持久化', () => {
    const next = mergeBotComposerRuntime(capabilities({ permissions: 'trusted' }), {
      permissionMode: 'ask',
    });
    expect(next?.permissions).toBe('ask');
  });

  it('fast 与供应商各自独立触发写回', () => {
    expect(mergeBotComposerRuntime(capabilities(), { fastMode: true })?.fastMode).toBe(true);
    expect(mergeBotComposerRuntime(capabilities(), { providerId: 'xd' })?.providerId).toBe('xd');
  });
});
