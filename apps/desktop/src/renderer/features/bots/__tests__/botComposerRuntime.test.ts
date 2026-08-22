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
  createBotRuntimeMirror,
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

/*
  等待队列。盯的是一个具体故障:**冷启动后第一次改模型,改动静默丢失**,
  下次 Renew 又跳回旧值,全程没有任何反馈。根因是 store 还没 hydrate 完时
  拿不到基底能力位,回写那段代码直接 return。
*/
describe('回写等待队列', () => {
  function harness(initial: Record<string, BotCapabilities> = {}) {
    const store = new Map(Object.entries(initial));
    const listeners = new Set<() => void>();
    const writes: Array<{ botId: string; capabilities: BotCapabilities }> = [];
    const mirror = createBotRuntimeMirror({
      getCapabilities: (botId) => store.get(botId) ?? null,
      write: (botId, caps) => {
        writes.push({ botId, capabilities: caps });
        store.set(botId, caps);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    return {
      mirror,
      writes,
      listenerCount: () => listeners.size,
      hydrate(botId: string, caps: BotCapabilities) {
        store.set(botId, caps);
        for (const listener of [...listeners]) listener();
      },
    };
  }

  it('store 还没 hydrate 时先存住,等伙伴出现再补写', () => {
    const h = harness();
    h.mirror.mirror('bot-a', { model: 'gpt-5.6' });
    // 基底还拿不到 —— 一次都没写,但也没丢。
    expect(h.writes).toEqual([]);
    expect(h.listenerCount()).toBe(1);

    h.hydrate('bot-a', capabilities({ model: 'claude-sonnet-4-6' }));
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.botId).toBe('bot-a');
    expect(h.writes[0]!.capabilities.model).toBe('gpt-5.6');
    // 写完立刻退订,不留常驻监听。
    expect(h.listenerCount()).toBe(0);
  });

  it('等待期间的多次改动浅合并,后一次覆盖同名字段', () => {
    const h = harness();
    h.mirror.mirror('bot-a', { model: 'gpt-5.6' });
    h.mirror.mirror('bot-a', { permissionMode: 'ask' });
    h.mirror.mirror('bot-a', { model: 'gpt-5.6-sol' });

    h.hydrate('bot-a', capabilities({ model: 'claude-sonnet-4-6', permissions: 'trusted' }));
    expect(h.writes).toHaveLength(1);
    // 三次改动落成一次写入:模型取最后一次,权限保留。
    expect(h.writes[0]!.capabilities.model).toBe('gpt-5.6-sol');
    expect(h.writes[0]!.capabilities.permissions).toBe('ask');
  });

  it('换了伙伴就整份替换,不把前一个伙伴的选择写到后一个身上', () => {
    const h = harness();
    h.mirror.mirror('bot-a', { model: 'gpt-5.6' });
    h.mirror.mirror('bot-b', { effort: 'high' });

    h.hydrate('bot-a', capabilities());
    h.hydrate('bot-b', capabilities());
    // 只有 bot-b 那次被补写,且不带 bot-a 的模型。
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.botId).toBe('bot-b');
    expect(h.writes[0]!.capabilities.effort).toBe('high');
    expect(h.writes[0]!.capabilities.model).toBe('claude-sonnet-4-6');
  });

  it('基底已经在手时直接写,不进队列也不订阅', () => {
    const h = harness({ 'bot-a': capabilities() });
    h.mirror.mirror('bot-a', { model: 'gpt-5.6' });
    expect(h.writes).toHaveLength(1);
    expect(h.listenerCount()).toBe(0);
  });

  it('等值不写,也不会白顶版本号', () => {
    const h = harness({ 'bot-a': capabilities({ model: 'gpt-5.6' }) });
    h.mirror.mirror('bot-a', { model: 'gpt-5.6' });
    expect(h.writes).toEqual([]);
    expect(h.listenerCount()).toBe(0);
  });

  it('会话卸载时把等待中的订阅摘掉', () => {
    const h = harness();
    h.mirror.mirror('bot-a', { model: 'gpt-5.6' });
    expect(h.listenerCount()).toBe(1);
    h.mirror.dispose();
    expect(h.listenerCount()).toBe(0);
    h.hydrate('bot-a', capabilities());
    expect(h.writes).toEqual([]);
  });
});
