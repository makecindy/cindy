/**
 * workflowCardStreamPlacement.test.ts
 * ---------------------------------------------------------------------------
 * 守住两条 workflow 消息流语义(产品拍板 2026-07-27,对齐官方行为):
 *
 * 1. workflow 卡永远平铺 —— 完成后也不折进「已工作 Xs」工作组。它是后台任务
 *    面板的常驻入口,折叠掉等于把入口藏起来;原版完成的 workflow 行也留在对话里。
 * 2. 孤儿 local_bash update(只有任务事件、消息里无对应 toolCall,即 workflow /
 *    子 agent 内部启动的后台命令)不进聊天流刷屏 —— 只进后台任务面板。父会话
 *    自己的后台 Bash 有 toolCall,走配对卡,不受过滤影响。
 *
 * Node 环境(buildRenderItems / groupWorkRuns 均为纯函数)。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { AgentTaskUpdate, ChatMessage } from '@/lib/makerChatStore';

const mkUser = (id: string): ChatMessage => ({
  clientId: id,
  role: 'user',
  content: '跑一个 workflow 测试',
});

const mkAssistant = (id: string, content: string, turnCompleted = false): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
  ...(turnCompleted ? { turnCompleted: true } : {}),
});

const mkWorkflowCall = (id: string): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: 'Workflow',
  toolInput: { script: 'export const meta = {...}' },
});

const mkResult = (id: string, toolUseId: string): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content: '{"done":true}',
  toolUseId,
});

const mkWorkflowUpdate = (
  taskId: string,
  status: AgentTaskUpdate['status'],
  parentToolUseId: string,
): AgentTaskUpdate => ({
  provider: 'claude-code',
  taskId,
  parentToolUseId,
  status,
  taskType: 'local_workflow',
  workflowName: 'min-parallel-test',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:01:01.000Z',
});

const mkBashUpdate = (taskId: string, status: AgentTaskUpdate['status']): AgentTaskUpdate => ({
  provider: 'claude-code',
  taskId,
  status,
  taskType: 'local_bash',
  title: 'Sleep for 36 seconds',
  createdAt: '2026-07-01T00:00:10.000Z',
  updatedAt: '2026-07-01T00:00:40.000Z',
});

function isFoldedIntoWorkGroup(
  items: ReturnType<typeof groupWorkRuns>,
  clientId: string,
): boolean {
  const contains = (item: ReturnType<typeof groupWorkRuns>[number]): boolean => {
    if (item.type === 'agent_task') return item.toolCall?.clientId === clientId;
    return item.type === 'work_group' && item.children.some(contains);
  };
  return items.some((item) => item.type === 'work_group' && item.children.some(contains));
}

describe('workflow 卡的消息流位置', () => {
  it('已回答 turn 中,completed workflow 卡保持平铺,不折进工作组', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkWorkflowCall('wf1'),
      mkResult('r1', 'tu-wf1'),
      mkAssistant('a1', '跑完了,结果如上。', true),
    ];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-wf1', mkWorkflowUpdate('task-wf-1', 'completed', 'tu-wf1')],
    ]);
    const items = groupWorkRuns(buildRenderItems(messages, taskUpdates).items, false);
    expect(isFoldedIntoWorkGroup(items, 'wf1')).toBe(false);
    const flat = items.find((it) => it.type === 'agent_task' && it.toolCall?.clientId === 'wf1');
    expect(flat).toBeTruthy();
  });

  it('无 update(历史重载)的 workflow 卡同样平铺', () => {
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkWorkflowCall('wf1'),
      mkResult('r1', 'tu-wf1'),
      mkAssistant('a1', '跑完了。', true),
    ];
    const items = groupWorkRuns(buildRenderItems(messages).items, false);
    expect(isFoldedIntoWorkGroup(items, 'wf1')).toBe(false);
  });
});

describe('孤儿 local_bash 不进聊天流', () => {
  it('只有 update 无 toolCall 的 local_bash 不产出聊天卡', () => {
    const messages: ChatMessage[] = [mkUser('u1'), mkAssistant('a1', '在跑了。')];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['bash-1', mkBashUpdate('bash-1', 'running')],
    ]);
    const { items } = buildRenderItems(messages, taskUpdates);
    expect(items.some((it) => it.type === 'agent_task')).toBe(false);
  });

  it('孤儿 local_workflow update 仍渲染(过滤只针对 bash)', () => {
    const messages: ChatMessage[] = [mkUser('u1'), mkAssistant('a1', '在跑了。')];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['wf-orphan', mkWorkflowUpdate('wf-orphan', 'running', 'tu-none')],
    ]);
    const { items } = buildRenderItems(messages, taskUpdates);
    expect(items.some((it) => it.type === 'agent_task')).toBe(true);
  });

  it('父会话自己的后台 Bash(parentToolUseId 命中消息里的 Bash 调用)必须出「后台命令」卡', () => {
    // #247 存量功能:该卡的唯一渲染来源是孤儿循环(Bash toolCall 走 tool_segment,
    // 不进 agent_task 配对),过滤收窄必须放行它 —— 严格断言 agent_task 卡存在。
    const bashCall: ChatMessage = {
      clientId: 'b1',
      role: 'tool_use',
      content: '',
      toolUseId: 'tu-b1',
      toolName: 'Bash',
      toolInput: { command: 'sleep 60', run_in_background: true },
    };
    const messages: ChatMessage[] = [mkUser('u1'), bashCall];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-b1', { ...mkBashUpdate('bash-b1', 'running'), parentToolUseId: 'tu-b1' }],
    ]);
    const { items } = buildRenderItems(messages, taskUpdates);
    const card = items.find(
      (it) => it.type === 'agent_task' && it.update?.taskId === 'bash-b1',
    );
    expect(card).toBeTruthy();
  });

  it('workflow 内部 agent 的后台 Bash(parentToolUseId 不在父会话消息里)不出聊天卡', () => {
    const messages: ChatMessage[] = [mkUser('u1'), mkAssistant('a1', '在跑了。')];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['bash-sub', { ...mkBashUpdate('bash-sub', 'running'), parentToolUseId: 'tu-inside-subagent' }],
    ]);
    const { items } = buildRenderItems(messages, taskUpdates);
    expect(items.some((it) => it.type === 'agent_task')).toBe(false);
  });

  it('历史窗口未加载完时不丢弃孤儿 local_bash(父 Bash 调用可能只是还没翻到)', () => {
    // 归属判定只能靠「父 Bash 调用在不在 messages 里」,而 messages 是分页窗口
    // (首屏 50 行)。重开长会话时,用户自己还在跑的后台命令,其 Bash 调用可能在
    // 更老的页里 —— 此时丢弃会连带把聊天流里的停止按钮一起抹掉。窗口不完整就放行,
    // 宁可临时多显示 workflow 内部的卡(本 PR 前的形态)。
    const messages: ChatMessage[] = [mkUser('u1'), mkAssistant('a1', '在跑了。')];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['bash-old', { ...mkBashUpdate('bash-old', 'running'), parentToolUseId: 'tu-in-older-page' }],
    ]);
    const { items } = buildRenderItems(messages, taskUpdates, undefined, {
      historyWindowIncomplete: true,
    });
    expect(
      items.some((it) => it.type === 'agent_task' && it.update?.taskId === 'bash-old'),
    ).toBe(true);
    // 窗口加载完后过滤恢复(同一输入,仅 flag 变化)。
    const { items: complete } = buildRenderItems(messages, taskUpdates, undefined, {
      historyWindowIncomplete: false,
    });
    expect(complete.some((it) => it.type === 'agent_task')).toBe(false);
  });

  it('无最终正文的 turn(legacy 分组路径)里,stopped workflow 卡同样平铺', () => {
    // 场景:workflow 被用户 Stop,turn 没有 sealed 正文 → groupAnsweredTurnItems
    // handled:false 回落 groupLegacyWorkRuns —— 三条分组路径必须同语义。
    const messages: ChatMessage[] = [
      mkUser('u1'),
      mkWorkflowCall('wf1'),
      mkResult('r1', 'tu-wf1'),
    ];
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['tu-wf1', mkWorkflowUpdate('task-wf-1', 'stopped', 'tu-wf1')],
    ]);
    const items = groupWorkRuns(buildRenderItems(messages, taskUpdates).items, false);
    expect(isFoldedIntoWorkGroup(items, 'wf1')).toBe(false);
  });
});
