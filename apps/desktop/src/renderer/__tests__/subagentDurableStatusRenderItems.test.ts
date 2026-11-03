/**
 * subagentDurableStatusRenderItems.test.ts
 * ---------------------------------------------------------------------------
 * A running background Agent card must stay visible in the chat, not be folded
 * into the finished work group, even when the launch receipt's wording is one
 * the text matcher does not recognise (Claude Code 2.1.280 changed it once).
 * The host's `subagent_runs` status is the structural source that decides.
 */

import { describe, expect, it } from 'vitest';
import { buildSubagentRunStatusIndex } from '@cindy/maker-shared/agent-task';

import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { AgentTaskUpdate, ChatMessage } from '@/lib/makerChatStore';

const at = (seconds: number): string =>
  new Date(Date.UTC(2026, 8, 26, 12, 0, seconds)).toISOString();

const messages: ChatMessage[] = [
  { clientId: 'u1', role: 'user', content: '帮我调研一下', createdAt: at(0) },
  {
    clientId: 'agent-call',
    role: 'tool_use',
    content: '',
    toolUseId: 'toolu_bg',
    toolName: 'Agent',
    toolInput: { description: 'background research', prompt: 'research' },
    createdAt: at(1),
  },
  {
    clientId: 'agent-receipt',
    role: 'tool_result',
    content: 'Background agent queued (a receipt wording nobody has matched yet)',
    toolUseId: 'toolu_bg',
    createdAt: at(2),
  },
  {
    clientId: 'a1',
    role: 'assistant',
    content: '已经派出一个后台调研，完成后会通知我。',
    createdAt: at(3),
    turnCompleted: true,
  },
];

const runningUpdate: AgentTaskUpdate = {
  provider: 'claude-code',
  taskId: 'agent-1',
  parentToolUseId: 'toolu_bg',
  status: 'running',
};
const taskUpdates = new Map<string, AgentTaskUpdate>([
  ['agent-1', runningUpdate],
  ['toolu_bg', runningUpdate],
]);

function topLevelAgentTask(items: ReturnType<typeof groupWorkRuns>) {
  return items.find((item) => item.type === 'agent_task');
}

describe('buildRenderItems — durable Subagent status', () => {
  it('keeps a running background Agent visible when subagent_runs says it is running', () => {
    const { items } = buildRenderItems(messages, taskUpdates, undefined, {
      subagentRunStatuses: buildSubagentRunStatusIndex([
        { parentToolUseId: 'toolu_bg', logicalAgentId: 'agent-1', status: 'running' },
      ]),
    });
    const card = topLevelAgentTask(groupWorkRuns(items, false));
    expect(card).toMatchObject({ type: 'agent_task', durableStatus: 'running' });
  });

  it('without the durable record an unknown receipt still reads as finished work (fallback path)', () => {
    const { items } = buildRenderItems(messages, taskUpdates);
    expect(topLevelAgentTask(groupWorkRuns(items, false))).toBeUndefined();
  });
});
