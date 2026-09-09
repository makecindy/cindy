import { describe, expect, it } from 'vitest';
import { buildMessageRenderItems } from '@cindy/maker-shared/message-render';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import {
  buildMobileMessageRenderItems,
  markTurnFinalAssistants,
  scopeUnsettledToolsToActiveTail,
  type MobileMessageRenderItem,
  type MobileSubagentGroupItem,
} from '@/session/messageRenderModel';
import type { RemoteMessage } from '@/session/types';

let seq = 0;
function msg(patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'role' | 'content'>): RemoteMessage {
  seq += 1;
  const id = patch.id ?? `m${seq}`;
  return {
    id,
    clientId: id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: patch.createdAt ?? `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    ...patch,
  };
}

function agentToolUse(toolUseId: string, opts: { description?: string; subagentType?: string; parentUuid?: string; createdAt?: string } = {}): RemoteMessage {
  return msg({
    role: 'tool_use',
    content: { toolUseId, toolName: 'Agent', input: { description: opts.description, subagent_type: opts.subagentType } },
    toolUseId,
    agentMeta: opts.parentUuid ? { parentUuid: opts.parentUuid } : null,
    createdAt: opts.createdAt,
  });
}

function childTool(toolName: string, parentUuid: string, createdAt?: string): RemoteMessage {
  const toolUseId = `t-${seq + 1}`;
  return msg({
    role: 'tool_use',
    content: { toolUseId, toolName, input: {} },
    toolUseId,
    agentMeta: { parentUuid },
    createdAt,
  });
}

function agentResult(toolUseId: string, content: string, createdAt?: string): RemoteMessage {
  return msg({ role: 'tool_result', content, toolUseId, createdAt });
}

function subagentGroups(items: readonly MobileMessageRenderItem[]): MobileSubagentGroupItem[] {
  return items.filter((item): item is MobileSubagentGroupItem => item.type === 'subagent_group');
}

// 递归收集输出里所有 render item 携带的 source 消息 id(用于"恰好出现一次"不变量检查)。
function collectSourceIds(items: readonly MobileMessageRenderItem[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly MobileMessageRenderItem[]) => {
    for (const item of list) {
      if (item.type === 'message' || item.type === 'thinking') ids.push(item.message.source.id);
      else if (item.type === 'tool_group') item.tools.forEach((tool) => ids.push(tool.source.id));
      else if (item.type === 'work_group') walk(item.children as MobileMessageRenderItem[]);
      else if (item.type === 'subagent_group') walk(item.childItems);
    }
  };
  walk(items);
  return ids;
}

describe('subagent grouping (buildMobileMessageRenderItems)', () => {
  it('replaces a top-level Agent tool_use with a subagent_group nesting its children', () => {
    const items = buildMobileMessageRenderItems([
      msg({ id: 'u', role: 'user', content: { text: 'go' }, createdAt: '2026-01-01T00:00:01.000Z' }),
      agentToolUse('A1', { description: '调研', subagentType: 'Explore', createdAt: '2026-01-01T00:00:02.000Z' }),
      childTool('Bash', 'A1', '2026-01-01T00:00:03.000Z'),
      childTool('Read', 'A1', '2026-01-01T00:00:04.000Z'),
      agentResult('A1', '调研完成,结论 X', '2026-01-01T00:00:05.000Z'),
    ]);

    const groups = subagentGroups(items);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.header).toEqual({ description: '调研', subagentType: 'Explore' });
    expect(g.summary).toBe('调研完成,结论 X');
    expect(g.status).toBe('completed');
    expect(g.durationMs).toBe(3000); // 00:05 - 00:02
    // children(2 个 tool)被归一化/折叠进 childItems(tool_group),不在顶层平铺。
    expect(g.childItems.length).toBeGreaterThan(0);
    // 顶层没有裸的 Agent tool_group 行。
    const topToolGroups = items.filter((i) => i.type === 'tool_group');
    expect(topToolGroups).toHaveLength(0);
  });

  it('recurses for nested sub-agents (2 levels)', () => {
    const items = buildMobileMessageRenderItems([
      agentToolUse('A1', { subagentType: 'general-purpose', createdAt: '2026-01-01T00:00:01.000Z' }),
      agentToolUse('A2', { subagentType: 'Explore', parentUuid: 'A1', createdAt: '2026-01-01T00:00:02.000Z' }),
      childTool('Bash', 'A2', '2026-01-01T00:00:03.000Z'),
      agentResult('A2', 'inner done', '2026-01-01T00:00:04.000Z'),
      agentResult('A1', 'outer done', '2026-01-01T00:00:05.000Z'),
    ]);
    const groups = subagentGroups(items);
    expect(groups).toHaveLength(1);
    const inner = subagentGroups(groups[0].childItems);
    expect(inner).toHaveLength(1);
    expect(inner[0].header.subagentType).toBe('Explore');
    expect(inner[0].summary).toBe('inner done');
  });

  it('keeps parallel/interleaved agents separated by parentUuid, not by time order', () => {
    const items = buildMobileMessageRenderItems([
      agentToolUse('A1', { subagentType: 'one', createdAt: '2026-01-01T00:00:01.000Z' }),
      agentToolUse('A2', { subagentType: 'two', createdAt: '2026-01-01T00:00:02.000Z' }),
      childTool('Bash', 'A2', '2026-01-01T00:00:03.000Z'), // A2 的 child 时间上夹在 A1/A2 之间
      childTool('Read', 'A1', '2026-01-01T00:00:04.000Z'),
      agentResult('A1', 'a1 done', '2026-01-01T00:00:05.000Z'),
      agentResult('A2', 'a2 done', '2026-01-01T00:00:06.000Z'),
    ]);
    const groups = subagentGroups(items);
    expect(groups.map((g) => g.header.subagentType)).toEqual(['one', 'two']);
    expect(groups[0].childItems.length).toBeGreaterThan(0); // A1 got its Read child
    expect(groups[1].childItems.length).toBeGreaterThan(0); // A2 got its Bash child
  });

  it('handles an empty sub-agent (no children) without crashing', () => {
    const items = buildMobileMessageRenderItems([
      agentToolUse('A1', { subagentType: 'Explore', createdAt: '2026-01-01T00:00:01.000Z' }),
      agentResult('A1', 'nothing to do', '2026-01-01T00:00:02.000Z'),
    ]);
    const groups = subagentGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].childItems).toEqual([]);
    expect(groups[0].status).toBe('completed');
  });

  it('marks status running when no closing tool_result and session is streaming', () => {
    const items = buildMobileMessageRenderItems([
      agentToolUse('A1', { subagentType: 'Explore', createdAt: '2026-01-01T00:00:01.000Z' }),
      childTool('Bash', 'A1', '2026-01-01T00:00:02.000Z'),
    ], { isSessionStreaming: true });
    expect(subagentGroups(items)[0].status).toBe('running');
  });

  it('stays completed even when the summary text mentions error/失败 (no keyword false-positive)', () => {
    // 回归:code-review/research 类子 agent 的总结天然讨论 "error/失败/exception",此前关键词扫正文
    // 会把成功完成误判成失败。缺少结构化终态的旧历史仍只按 closing tool_result 判 completed。
    const items = buildMobileMessageRenderItems([
      agentToolUse('A1', { subagentType: 'general-purpose', createdAt: '2026-01-01T00:00:01.000Z' }),
      agentResult(
        'A1',
        '审查完成:发现 3 处 error handling 缺陷与一个会抛 exception 的失败分支,均已修复。',
        '2026-01-01T00:00:02.000Z',
      ),
    ]);
    const group = subagentGroups(items)[0];
    expect(group.status).toBe('completed');
    expect(group.status).not.toBe('failed');
  });

  it.each(['failed', 'stopped'] as const)(
    'uses the persisted %s terminal state for a nested Agent group',
    (status) => {
      const items = buildMobileMessageRenderItems([
        msg({
          id: 'agent',
          role: 'tool_use',
          toolUseId: 'toolu-agent',
          content: { toolUseId: 'toolu-agent', toolName: 'Agent', input: { description: 'Review' } },
          agentMeta: { agentTaskStatus: status },
        }),
        msg({
          id: 'result',
          role: 'tool_result',
          toolUseId: 'toolu-agent',
          content: 'finished with a terminal outcome',
        }),
      ]);

      expect(subagentGroups(items)[0].status).toBe(status);
    },
  );

  it('leaves an ordinary session (no Agent / no parentUuid) byte-identical to the shared builder', () => {
    const messages = [
      msg({ id: 'u', role: 'user', content: { text: 'hi' }, createdAt: '2026-01-01T00:00:01.000Z' }),
      msg({ id: 't', role: 'tool_use', content: { toolUseId: 'x', toolName: 'Read', input: {} }, toolUseId: 'x', createdAt: '2026-01-01T00:00:02.000Z' }),
      msg({ id: 'a', role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:03.000Z' }),
    ];
    // 对照侧同样做 mobile 后处理(buildMobileMessageRenderItems 内置这些步骤),其余逐字节一致。
    const reference = normalizeRemoteMessages(messages);
    scopeUnsettledToolsToActiveTail(reference);
    markTurnFinalAssistants(reference, false);
    expect(buildMobileMessageRenderItems(messages)).toEqual(
      buildMessageRenderItems(reference),
    );
    expect(subagentGroups(buildMobileMessageRenderItems(messages))).toHaveLength(0);
  });

  it('terminates and bounds nesting when the parent chain exceeds the depth cap', () => {
    // 构造 7 层链 A0←A1←…←A6,远超 MAX_SUBAGENT_NEST_DEPTH(5),确保不爆栈、不无限建组。
    const rows: RemoteMessage[] = [];
    for (let i = 0; i <= 6; i += 1) {
      rows.push(agentToolUse(`A${i}`, {
        subagentType: `lv${i}`,
        parentUuid: i === 0 ? undefined : `A${i - 1}`,
        createdAt: `2026-01-01T00:01:0${i}.000Z`,
      }));
    }
    let items: MobileMessageRenderItem[] = [];
    expect(() => { items = buildMobileMessageRenderItems(rows); }).not.toThrow();
    // 顶层只有 1 个 group(A0),逐层下钻深度有限。
    expect(subagentGroups(items)).toHaveLength(1);
    let depth = 0;
    let cursor = subagentGroups(items);
    while (cursor.length > 0) {
      depth += 1;
      cursor = subagentGroups(cursor[0].childItems);
      if (depth > 10) break; // 安全阀:若无限会在此断开并让断言失败
    }
    expect(depth).toBeLessThanOrEqual(5);
  });

  it('flat-renders orphan children whose parent Agent is outside the window (F1: no silent drop)', () => {
    // 复现分页窗口劈开子 agent 块:父 Agent 落窗外、children 在窗内,parentUuid 指向窗外父;窗内另有真 Agent
    // (A1)使流程走 subagent-aware 路径。修复前这些 children 进不可达孤儿桶、整段消失;修复后回退 flat。
    const orphan1 = childTool('Read', 'AGENT_OUTSIDE_WINDOW', '2026-01-01T00:00:05.000Z');
    const orphan2 = childTool('Grep', 'AGENT_OUTSIDE_WINDOW', '2026-01-01T00:00:06.000Z');
    const inWindowChild = childTool('Bash', 'A1', '2026-01-01T00:00:03.000Z');
    const items = buildMobileMessageRenderItems([
      agentToolUse('A1', { subagentType: 'Explore', createdAt: '2026-01-01T00:00:02.000Z' }),
      inWindowChild,
      agentResult('A1', 'done', '2026-01-01T00:00:04.000Z'),
      orphan1,
      orphan2,
    ]);

    const collected = collectSourceIds(items);
    // 孤儿(父在窗外)仍出现在输出 —— 直接锁死 F1。
    expect(collected).toContain(orphan1.id);
    expect(collected).toContain(orphan2.id);
    // 窗内子 agent 的 child 仍正常嵌套。
    expect(collected).toContain(inWindowChild.id);
    // 恰好出现一次:无重复(A1 自身被并入 group header,不计为 source 行)。
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toHaveLength(3);
    expect(subagentGroups(items)).toHaveLength(1);
  });
});
