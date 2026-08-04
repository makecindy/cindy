/**
 * workGroupDeliveryProse.test.ts
 * ---------------------------------------------------------------------------
 * 回归:交付正文(简报 / 分析 / 总结)不能因为后面还跟了一个收尾动作就被折进
 * 「已工作 Xs」。
 *
 * 背景(2026-07-31 定时巡检实例):agent 先输出 3250 字的产品决策简报,再调
 * schedule_notify_current_run 发通知,最后说一句 110 字的「已触发通知」。SDK 的
 * done seal 只盖在 turn 最后一条 assistant 上,而「最终答复」的回溯遇到任何工具
 * 动作就停 —— 于是简报排在收尾动作之前,被整段折进「已工作 3m 4s」,消息流里只
 * 剩那句收尾元数据。
 *
 * 修复口径(isDeliveryProseItem → maker-shared 的 isDeliveryProseText):正文达到
 * 长度阈值、或带块级 markdown 结构(标题 / 表格 / ≥3 项列表)时,与位置无关一律
 * 平铺。短进度旁白照旧折叠,不把消息流撑长。
 *
 * Node 环境(buildRenderItems / groupWorkRuns 都是纯函数)。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

// ── 工厂 ───────────────────────────────────────────────────────────────────

const mkUser = (id: string, content = '巡检待放行的 PR,给一份产品决策简报'): ChatMessage => ({
  clientId: id,
  role: 'user',
  content,
});

const mkAssistant = (id: string, content: string, turnCompleted = false): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
  ...(turnCompleted ? { turnCompleted: true } : {}),
});

const mkThinking = (id: string, content = 'Thought'): ChatMessage => ({
  clientId: id,
  role: 'thinking',
  content,
});

const mkTool = (id: string, toolName = 'Bash'): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput: { command: 'gh pr diff 1111' },
});

const mkResult = (id: string, toolUseId: string, content = 'ok'): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content,
  toolUseId,
});

// ── 断言小工具 ───────────────────────────────────────────────────────────────

type RenderItems = ReturnType<typeof groupWorkRuns>;

function topLevelMessageIds(items: RenderItems): string[] {
  return items
    .filter((item) => item.type === 'message')
    .map((item) => item.message.clientId);
}

/** 是否有任一层 work_group 的 children 里含这条 assistant 正文。 */
function isFoldedIntoWorkGroup(items: RenderItems, clientId: string): boolean {
  const containsMessage = (item: RenderItems[number]): boolean => {
    if (item.type === 'message') return item.message.clientId === clientId;
    return item.type === 'work_group' && item.children.some(containsMessage);
  };
  return items.some(
    (item) => item.type === 'work_group' && item.children.some(containsMessage),
  );
}

function workGroups(items: RenderItems) {
  return items.filter((it) => it.type === 'work_group');
}

/** 只靠长度过阈值的正文(无标题 / 无列表 / 无表格),用来单独覆盖长度信号。 */
const longPlainProse = `本轮 7 条有活动,3 条首次亮相。${'逐条核对了改动落在哪些产品面。'.repeat(50)}`;

/**
 * 「正文 → 收尾副作用动作 → 一句话收尾」——被折叠问题的原始形状。
 * `body` 是要检验的那条正文,收尾句带 seal。
 */
function briefThenNotifyTurn(body: string): ChatMessage[] {
  return [
    mkUser('u1'),
    mkThinking('th1'),
    mkTool('diff', 'Bash'),
    mkResult('diff-result', 'tu-diff', 'diff --git a/apps/mobile/app/devices/index.tsx'),
    mkAssistant('brief', body),
    mkTool('notify', 'mcp__cindy_scheduler__schedule_notify_current_run'),
    mkResult('notify-result', 'tu-notify', '{"ok":true}'),
    mkAssistant('wrap', '本轮有 3 条首次亮相的 PR 需要你决策,已触发通知。', true),
  ];
}

// ── 主 case ────────────────────────────────────────────────────────────────

describe('交付正文不被收尾动作顶进「已工作 Xs」', () => {
  it('长正文排在收尾动作之前也平铺可见', () => {
    expect(longPlainProse.length).toBeGreaterThanOrEqual(600);

    const items = groupWorkRuns(buildRenderItems(briefThenNotifyTurn(longPlainProse)).items, false);

    expect(topLevelMessageIds(items)).toEqual(['u1', 'brief', 'wrap']);
    expect(isFoldedIntoWorkGroup(items, 'brief')).toBe(false);
    // 修复不是「整 turn 不折」:正文之前的工作过程照旧折成工作组。
    expect(workGroups(items).length).toBeGreaterThan(0);
    expect(isFoldedIntoWorkGroup(items, 'th1')).toBe(true);
  });

  it('带 markdown 标题的短正文同样平铺(结构信号,不靠长度)', () => {
    const headed = '## 产品决策简报\n\n本轮 7 条有活动。';
    expect(headed.length).toBeLessThan(600);

    const items = groupWorkRuns(buildRenderItems(briefThenNotifyTurn(headed)).items, false);

    expect(topLevelMessageIds(items)).toEqual(['u1', 'brief', 'wrap']);
    expect(isFoldedIntoWorkGroup(items, 'brief')).toBe(false);
  });

  it('≥3 项列表算交付结构,平铺', () => {
    const listed = '需要你决定的三条:\n- #1111 手机离线缓存\n- #692 effort 阻断发送\n- #1080 插件授权重构';

    const items = groupWorkRuns(buildRenderItems(briefThenNotifyTurn(listed)).items, false);

    expect(topLevelMessageIds(items)).toEqual(['u1', 'brief', 'wrap']);
  });

  it('表格正文平铺', () => {
    const tabled = 'PR 一览:\n\n| PR | 建议 |\n| --- | --- |\n| #1111 | 放行 |';

    const items = groupWorkRuns(buildRenderItems(briefThenNotifyTurn(tabled)).items, false);

    expect(topLevelMessageIds(items)).toEqual(['u1', 'brief', 'wrap']);
  });
});

// ── 不回归:短进度旁白照旧折叠 ────────────────────────────────────────────────

describe('进度旁白仍然折进「已工作 Xs」', () => {
  it('一句话旁白被折叠,消息流不因此变长', () => {
    const items = groupWorkRuns(
      buildRenderItems(briefThenNotifyTurn('我已经读完所有必要信息,现在写简报。')).items,
      false,
    );

    expect(topLevelMessageIds(items)).toEqual(['u1', 'wrap']);
    expect(isFoldedIntoWorkGroup(items, 'brief')).toBe(true);
  });

  it('只有 2 项列表的旁白不算交付,仍折叠', () => {
    const items = groupWorkRuns(
      buildRenderItems(briefThenNotifyTurn('接下来两件事:\n- 读 diff\n- 写简报')).items,
      false,
    );

    expect(topLevelMessageIds(items)).toEqual(['u1', 'wrap']);
    expect(isFoldedIntoWorkGroup(items, 'brief')).toBe(true);
  });

  it('单独的 --- 水平线不被误判成表格', () => {
    const items = groupWorkRuns(
      buildRenderItems(briefThenNotifyTurn('先跑脚本生成简报数据。\n\n---\n\n然后读结果。')).items,
      false,
    );

    expect(topLevelMessageIds(items)).toEqual(['u1', 'wrap']);
    expect(isFoldedIntoWorkGroup(items, 'brief')).toBe(true);
  });
});
