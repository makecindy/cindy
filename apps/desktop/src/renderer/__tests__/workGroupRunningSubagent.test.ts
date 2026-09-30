/**
 * workGroupRunningSubagent.test.ts
 * ---------------------------------------------------------------------------
 * 回归:仍在运行(未到终态)的子 Agent 卡片,不能被折进「已工作 Xs」工作组。
 *
 * 背景(复现截图):父 Agent 走 deep-research skill 把一个子 Agent 派到后台去跑,
 * 父 turn 却已经产出最终正文(「已在后台启动…用 /workflows 看进度」)。turn 一旦
 * "已回答",work-group pass 就把工作过程折成一行「已工作 15s」;可组里那张子 Agent
 * 卡此刻还是"运行中"、已经跑了 1m 1s —— 组号称 15s 却装着一个没完成、跑得更久的
 * 任务,既谎报终态又自相矛盾。修复后:运行中的子 Agent 保持平铺可见,跑完
 * (completed/failed/stopped)再按原行为折进工作组归档。
 *
 * 覆盖三条分组路径:
 *   A. 已回答 turn(groupAnsweredTurnItems)+ 后台运行中子 Agent → 平铺
 *   B. 已回答 turn + 子 Agent 已 completed → 折进工作组(不回归历史归档行为)
 *   C. 流式尾 turn(groupLegacyWorkRuns, isSessionStreaming=true)中部的运行中
 *      子 Agent → 平铺,不被 shouldCollapse 卷入
 *
 * Node 环境(buildRenderItems / groupWorkRuns 都是纯函数)。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { AgentTaskUpdate, ChatMessage } from '@/lib/makerChatStore';

// ── 工厂 ───────────────────────────────────────────────────────────────────

const mkUser = (id: string, content = '深度调研下 Higgsfield AI'): ChatMessage => ({
  clientId: id,
  role: 'user',
  content,
});

const mkAssistant = (
  id: string,
  content: string,
  turnCompleted = false,
): ChatMessage => ({
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

const mkTool = (id: string, toolName = 'Bash', toolInput: unknown = { command: 'ls' }): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
});

const mkResult = (id: string, toolUseId: string, content = 'ok'): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content,
  toolUseId,
});

/** 一个 Task(子 Agent)工具调用。toolUseId = `tu-${id}`,taskUpdates 按它索引。 */
const mkTask = (id: string, title = 'Search:竞品对比与市场定位'): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: 'Task',
  toolInput: { description: title, prompt: title },
});

const mkUpdate = (taskId: string, status: AgentTaskUpdate['status']): AgentTaskUpdate => ({
  provider: 'claude-code',
  taskId,
  status,
  title: 'Search:竞品对比与市场定位',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:01:01.000Z',
});

// ── 断言小工具 ───────────────────────────────────────────────────────────────

type RenderItems = ReturnType<typeof groupWorkRuns>;

/** 顶层平铺的 agent_task(clientId 命中)。 */
function findFlatAgentTask(items: RenderItems, clientId: string) {
  return items.find(
    (it) => it.type === 'agent_task' && it.toolCall?.clientId === clientId,
  );
}

/** 是否有任一层 work_group 的 children 里含该子 Agent。 */
function isFoldedIntoWorkGroup(items: RenderItems, clientId: string): boolean {
  const containsAgentTask = (item: RenderItems[number]): boolean => {
    if (item.type === 'agent_task') return item.toolCall?.clientId === clientId;
    return item.type === 'work_group' && item.children.some(containsAgentTask);
  };
  return items.some(
    (item) => item.type === 'work_group' && item.children.some(containsAgentTask),
  );
}

function workGroups(items: RenderItems) {
  return items.filter((it) => it.type === 'work_group');
}

// 已回答 turn 的现实序列(镜像截图结构):
//   thinking → text → tool → thinking → text → tool → 子Agent → thinking → 最终正文
// 最后一段 thinking 在子 Agent 之后 → 子 Agent 之前的中间正文会被折叠,
// 正好把子 Agent 卷进「已工作」——这是修复要拦住的点。
function answeredTurnMessages(): ChatMessage[] {
  return [
    mkUser('u1'),
    mkThinking('th1'),
    mkAssistant('a1', '我先启动深度调研 skill 来做这件事。'),
    mkTool('b1', 'Bash'),
    mkResult('r1', 'tu-b1'),
    mkThinking('th2'),
    mkAssistant('a2', '调研主题足够明确,我直接启动深度调研工作流。'),
    mkTool('b2', 'Bash'),
    mkResult('r2', 'tu-b2'),
    mkTask('task1'),
    mkThinking('th3'),
    mkAssistant('a3', '深度调研工作流已在后台启动,你可以用 /workflows 实时看进度。'),
  ];
}

// ── Scenario A:后台运行中的子 Agent 不被折进「已工作 Xs」 ──────────────────────

describe('运行中子 Agent — 已回答 turn(groupAnsweredTurnItems)', () => {
  it('A. status=running 的子 Agent 平铺可见,不进任何 work_group', () => {
    const messages = answeredTurnMessages();
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-task1', mkUpdate('task1', 'running')],
    ]);

    const items = groupWorkRuns(buildRenderItems(messages, taskUpdates).items, false);

    // 平铺可见
    expect(findFlatAgentTask(items, 'task1')).toBeDefined();
    // 不被任何工作组收纳
    expect(isFoldedIntoWorkGroup(items, 'task1')).toBe(false);
    // 子 Agent 之前的工作过程仍正常折成工作组(修复不是"整 turn 不折")
    expect(workGroups(items).length).toBeGreaterThan(0);
  });

  it('B. status=completed 的子 Agent 仍折进 work_group 归档(不回归)', () => {
    const messages = answeredTurnMessages();
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-task1', mkUpdate('task1', 'completed')],
    ]);

    const items = groupWorkRuns(buildRenderItems(messages, taskUpdates).items, false);

    expect(findFlatAgentTask(items, 'task1')).toBeUndefined();
    expect(isFoldedIntoWorkGroup(items, 'task1')).toBe(true);
  });
});

// ── Scenario C:流式尾 turn 的 legacy 折叠路径 ───────────────────────────────

describe('后台任务自动续跑 — 只有最后一次 seal 是收尾正文', () => {
  const formalSummary = [
    '## 改动总结',
    '',
    '- 实现了功能主体',
    '- 补了回归测试',
    '- 本地门禁通过',
  ].join('\n');

  it('交付正文形态的主任务总结不会被后台门禁完成后的补充回复顶进「已工作」', () => {
    const messages: ChatMessage[] = [
      mkUser('u1', '实现功能并跑完整门禁'),
      mkThinking('main-thinking'),
      mkTool('main-edit', 'Edit'),
      mkResult('main-edit-result', 'tu-main-edit'),
      mkAssistant('main-summary', formalSummary, true),
      mkTool('gate-check', 'Bash'),
      mkResult('gate-result', 'tu-gate-check', 'exit 0'),
      mkAssistant('gate-followup', '后台预跑的仓库级门禁已通过。', true),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);

    expect(topLevelMessages).toEqual(['u1', 'main-summary', 'gate-followup']);
    expect(workGroups(items)).toHaveLength(2);
    expect(items.some(
      (item) => item.type === 'work_group' && item.children.some(
        (child) => child.type === 'message' && child.message.clientId === 'main-summary',
      ),
    )).toBe(false);
  });

  // 原始形状(2026-09-27):主对话开 4 个后台子 Agent,每回来一个就被唤醒核对一次、
  // 各盖一次 seal。中间几句「还在等 / 核实了」曾各自当成最终答复留在外面,把工作过程
  // 切成 5 段「已工作」。
  it('后台唤醒产生的中间短句 seal 折进同一个「已工作」,只留最后的总结', () => {
    const messages: ChatMessage[] = [
      mkUser('u1', '对比安卓和 iOS 的交互差异'),
      mkTool('survey', 'Bash'),
      mkResult('survey-result', 'tu-survey'),
      mkAssistant('wait', 'Four agents are still running. I\'ll hold here until they report back.', true),
      mkAssistant('wake-1', '伙伴部分先回来了。我先抽查它报的两条行为差异。'),
      mkTool('check-1', 'Bash'),
      mkResult('check-1-result', 'tu-check-1'),
      mkAssistant('verified-1', 'The host rejects it rather than truncating, so that finding holds.', true),
      mkAssistant('wake-2', '最后一部分也回来了。我再核对两条。'),
      mkTool('check-2', 'Bash'),
      mkResult('check-2-result', 'tu-check-2'),
      mkAssistant('final', formalSummary, true),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);

    expect(topLevelMessages).toEqual(['u1', 'final']);
    expect(workGroups(items)).toHaveLength(1);
  });

  it('更早的交付正文 seal 仍留在组外', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkTool('work', 'Bash'),
      mkResult('work-result', 'tu-work'),
      mkAssistant('early-report', formalSummary, true),
      mkAssistant('short-wait', '还有一个子任务在跑。', true),
      mkTool('check', 'Bash'),
      mkResult('check-result', 'tu-check'),
      mkAssistant('final', '全部核对完毕。', true),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);

    expect(topLevelMessages).toEqual(['u1', 'early-report', 'final']);
  });

  it('更早 seal 的引言与交付正文作为一段整体留在组外,不被拆开', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkTool('work', 'Bash'),
      mkResult('work-result', 'tu-work'),
      mkAssistant('intro', '先给结论。'),
      mkAssistant('report', formalSummary, true),
      mkTool('check', 'Bash'),
      mkResult('check-result', 'tu-check'),
      mkAssistant('final', '后台核对也通过了。', true),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);

    expect(topLevelMessages).toEqual(['u1', 'intro', 'report', 'final']);
  });

  it('更早 seal 只带图片 / 文件附件和一句短说明时仍留在组外', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkTool('render', 'Bash'),
      mkResult('render-result', 'tu-render'),
      {
        ...mkAssistant('chart', '图表在这里。', true),
        images: [{ url: '/chart.png', mimeType: 'image/png', originalName: 'chart.png' }],
      },
      mkTool('check', 'Bash'),
      mkResult('check-result', 'tu-check'),
      mkAssistant('final', '后台核对也通过了。', true),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);

    expect(topLevelMessages).toEqual(['u1', 'chart', 'final']);
  });

  it('同一 sealed SDK turn 的连续多段正式正文都留在组外', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkTool('work', 'Bash'),
      mkResult('work-result', 'tu-work'),
      mkAssistant('summary-part-1', '第一段正式总结'),
      mkAssistant('summary-part-2', '第二段正式总结', true),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);
    expect(topLevelMessages).toEqual(['u1', 'summary-part-1', 'summary-part-2']);
  });

  it('现有 turnCostUsd 也能让已落库历史恢复 SDK turn 的 seal', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkTool('cost-work', 'Bash'),
      mkResult('cost-work-result', 'tu-cost-work'),
      { ...mkAssistant('cost-summary', '历史正式总结'), turnCostUsd: 1 },
      mkTool('cost-tool', 'Bash'),
      mkResult('cost-result', 'tu-cost-tool'),
      mkAssistant('trailing-progress', '未封口的尾部进度'),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);
    // 没有 seal 时会回退成保留最后一条正文(trailing-progress)。
    expect(topLevelMessages).toEqual(['u1', 'cost-summary']);
  });

  it('无 turn seal 的旧历史继续只保留最后一条 assistant 回退', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkAssistant('legacy-summary', '旧版正式总结'),
      mkTool('legacy-tool', 'Bash'),
      mkResult('legacy-result', 'tu-legacy-tool'),
      mkAssistant('legacy-last', '旧版最后补充'),
    ];

    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    const topLevelMessages = items
      .filter((item) => item.type === 'message')
      .map((item) => item.message.clientId);
    expect(topLevelMessages).toEqual(['u1', 'legacy-last']);
  });
});

// ── Scenario C:流式尾 turn 的 legacy 折叠路径 ───────────────────────────────

describe('运行中子 Agent — 流式尾 turn(groupLegacyWorkRuns)', () => {
  it('C. 中部的 running 子 Agent 平铺,不被 shouldCollapse 卷入', () => {
    // 尾部有普通正文(lastTextIdx 在末尾),中部的运行中子 Agent 在没修复前会被折。
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkThinking('th1'),
      mkTool('b1', 'Bash'),
      mkResult('r1', 'tu-b1'),
      mkTask('task1'),
      mkTool('b2', 'Bash'),
      mkResult('r2', 'tu-b2'),
      mkAssistant('a1', '中间进展说明,子 Agent 仍在后台跑。'),
    ];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-task1', mkUpdate('task1', 'running')],
    ]);

    const items = groupWorkRuns(buildRenderItems(messages, taskUpdates).items, true);

    expect(findFlatAgentTask(items, 'task1')).toBeDefined();
    expect(isFoldedIntoWorkGroup(items, 'task1')).toBe(false);
  });
});
