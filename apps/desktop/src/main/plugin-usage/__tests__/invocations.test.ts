import { describe, expect, it } from 'vitest';
import { PluginInvocations } from '../invocations.js';

/*
 * 生产入口与结果：宿主调用关联确认后生成一条事件，子步骤和重试不增量。
 * 依据：通用调用统计 scope；现有工具派发测试不覆盖主动执行关联。
 * 最小失败输入：同一调用的工具派发与投递各确认一次；伪造跨插件父调用。
 * tier：unit，注入身份/时钟/事件账本，不启动 Electron 或真实任务。
 */
function harness() {
  let epoch = 'owner-1';
  let clock = 100;
  let sequence = 0;
  let historyCurrent = true;
  let enabled = true;
  const events = new Map<string, { pluginId: string; kind: string; at: number }>();
  const outcomes = new Map<string, string>();
  const invocations = new PluginInvocations({
    scope: pluginId => enabled ? `${epoch}:${pluginId}:approved-1` : null,
    id: () => `host-${++sequence}`,
    now: () => clock,
    observe: pluginId => {
      const owner = epoch;
      return {
        isCurrent: () => owner === epoch && historyCurrent,
        accepted: (id, kind, at) => events.set(id, { pluginId, kind, at }),
        settled: (id, outcome) => outcomes.set(id, outcome),
      };
    },
  });
  return { invocations, events, outcomes, changeOwner: () => { epoch = 'owner-2'; },
    clear: () => { historyCurrent = false; },
    disable: () => { enabled = false; },
    expire: () => { clock += 600_001; } };
}

describe('Host-owned plugin invocations', () => {
  it('counts a confirmed tool once and keeps its child input in the same invocation', () => {
    const h = harness();
    const tool = h.invocations.begin('plugin-a', 'tool');
    expect(h.events.size).toBe(0);
    h.invocations.accept(tool);
    const input = h.invocations.begin('plugin-a', 'execution', { parentId: tool.id });
    h.invocations.accept(input);
    h.invocations.accept(tool);
    expect([...h.events.values()]).toEqual([{ pluginId: 'plugin-a', kind: 'tool', at: 100 }]);
    expect(input.id).toBe(tool.id);
  });

  it('keeps overlapping independent calls separate and binds children to their exact parent', () => {
    const h = harness();
    const first = h.invocations.begin('plugin-a', 'tool', { id: 'tool-first' });
    const second = h.invocations.begin('plugin-a', 'tool', { id: 'tool-second' });
    h.invocations.accept(first);
    h.invocations.accept(second);
    const child = h.invocations.begin('plugin-a', 'execution', { parentId: second.id });
    h.invocations.accept(child);
    expect(child.id).toBe('tool-second');
    expect([...h.events.keys()]).toEqual(['tool-first', 'tool-second']);
  });

  it('rejects unknown, unconfirmed and cross-plugin parent identities without recording', () => {
    const h = harness();
    const parent = h.invocations.begin('plugin-a', 'tool');
    for (const [pluginId, parentId] of [['plugin-a', 'forged'], ['plugin-a', parent.id], ['plugin-b', parent.id]]) {
      expect(() => h.invocations.begin(pluginId!, 'execution', { parentId })).toThrow('INVALID_INVOCATION');
    }
    h.invocations.accept(parent);
    expect(() => h.invocations.begin('plugin-b', 'execution', { parentId: parent.id })).toThrow('INVALID_INVOCATION');
    expect(h.events.size).toBe(1);
  });

  it('never records a late input after account scope changes', () => {
    const h = harness();
    const pending = h.invocations.begin('plugin-a', 'tool');
    h.changeOwner();
    expect(() => h.invocations.accept(pending)).toThrow('INVALID_INVOCATION');
    expect(h.events.size).toBe(0);
  });

  it('expires correlation instead of attaching new input to an old invocation', () => {
    const h = harness();
    const parent = h.invocations.begin('plugin-a', 'tool');
    h.invocations.accept(parent);
    h.expire();
    expect(() => h.invocations.begin('plugin-a', 'execution', { parentId: parent.id })).toThrow('INVALID_INVOCATION');
    expect(h.events.size).toBe(1);
  });

  it('keeps an accepted invocation when its later work is cancelled', () => {
    const h = harness();
    const root = h.invocations.begin('plugin-a', 'execution');
    h.invocations.accept(root);
    h.invocations.settle(root, 'cancelled');
    expect(h.events.size).toBe(1);
  });

  it('settles an in-flight tool after its parent-correlation window expires', () => {
    const h = harness();
    const tool = h.invocations.begin('plugin-a', 'tool');
    h.invocations.accept(tool);
    h.expire();
    h.invocations.begin('plugin-a', 'execution'); // Prunes expired correlation entries.
    h.invocations.settle(tool, 'succeeded');
    expect(h.outcomes.get(tool.id)).toBe('succeeded');
    expect(() => h.invocations.settle({ ...tool }, 'failed')).toThrow('INVALID_INVOCATION');
    h.changeOwner();
    expect(() => h.invocations.settle(tool, 'failed')).toThrow('INVALID_INVOCATION');
  });

  it('does not associate a new input with a cleared usage history', () => {
    const h = harness();
    const root = h.invocations.begin('plugin-a', 'tool');
    h.invocations.accept(root);
    h.clear();
    expect(() => h.invocations.begin('plugin-a', 'execution', { parentId: root.id })).toThrow('INVALID_INVOCATION');
  });

  it('retains cancellation outcome when disabling prevents further calls', () => {
    const h = harness();
    const tool = h.invocations.begin('plugin-a', 'tool');
    h.invocations.accept(tool);
    h.disable();
    expect(() => h.invocations.begin('plugin-a', 'execution', { parentId: tool.id })).toThrow('INVALID_INVOCATION');
    h.invocations.settle(tool, 'cancelled');
    expect(h.outcomes.get(tool.id)).toBe('cancelled');
    expect(h.events.size).toBe(1);
  });
});
