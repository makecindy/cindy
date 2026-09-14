import { performance } from 'node:perf_hooks';
import type { AgentTaskUpdate } from '@cindy/maker-shared/agent-task';
import { describe, expect, it } from 'vitest';
import { buildMobileMessageRenderItems, type MobileMessageRenderItem } from '@/session/messageRenderModel';
import { reconcileMobileMessageRenderItems } from '@/session/messageRenderReconcile';
import {
  buildMobileStreamingRenderWindow,
  commitMobileStreamingPrefixItems,
  committedMobileStreamingPrefixItemCount,
} from '@/session/messageRenderStreamingCache';
import { countMobileRenderItemDiffs } from '@/session/messagePresentation';
import type { RemoteMessage } from '@/session/types';

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function message(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: timestamp(0),
    ...patch,
  };
}

function timestamp(offsetSeconds: number): string {
  return new Date(BASE_TIME + offsetSeconds * 1000).toISOString();
}

function createLargeDesktopMessageFixture(turns: number): RemoteMessage[] {
  const messages: RemoteMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const offset = turn * 5;
    const toolUseId = `tool-${turn}`;
    const isTodoTurn = turn % 10 === 0;
    messages.push(
      message({
        id: `user-${turn}`,
        role: 'user',
        content: { text: `Request ${turn}`, images: [], files: [] },
        createdAt: timestamp(offset),
      }),
      message({
        id: `thinking-${turn}`,
        role: 'thinking',
        content: {
          kind: 'thinking',
          text: `Inspecting request ${turn}`,
          durationMs: 1200,
          isRedacted: false,
        },
        createdAt: timestamp(offset + 1),
      }),
      message({
        id: toolUseId,
        role: 'tool_use',
        toolUseId,
        content: isTodoTurn
          ? {
              toolUseId,
              toolName: 'TodoWrite',
              input: {
                todos: [
                  { content: `Inspect turn ${turn}`, status: 'completed' },
                  { content: `Patch turn ${turn}`, status: 'in_progress' },
                ],
              },
            }
          : {
              toolUseId,
              toolName: 'Read',
              input: { file_path: `/repo/src/file-${turn}.ts` },
            },
        createdAt: timestamp(offset + 2),
      }),
      message({
        id: `tool-result-${turn}`,
        role: 'tool_result',
        toolUseId,
        content: isTodoTurn ? 'todo updated' : `contents ${turn}`,
        createdAt: timestamp(offset + 3),
      }),
      message({
        id: `assistant-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: `Answer ${turn}` }],
        createdAt: timestamp(offset + 4),
      }),
    );
  }
  return messages;
}

describe('message render performance', () => {
  it('normalizes and groups a 1000-message desktop transcript without losing stable structure', () => {
    const rawMessages = createLargeDesktopMessageFixture(200);

    const start = performance.now();
    const items = buildMobileMessageRenderItems(rawMessages);
    const durationMs = performance.now() - start;

    expect(rawMessages).toHaveLength(1000);
    expect(durationMs).toBeLessThan(1500);
    // 桌面共享实现把 transcript 中的 plan/todo 卡拆成顶层独立项,较旧的「折叠进 work_group」多出 1 项。
    // 计划所有权边界后,20 个隔着 user turn 的未完成 TodoWrite 不再被串成一张卡
    // (那是历史串号病),而是每个 turn 各自一张:601 + 19 = 620。
    expect(items).toHaveLength(620);
    // turn 0 是 todo turn:所有权边界后它的清单卡锚在本 turn(不再被后续 turn
    // 的更新拖到 transcript 尾部合并),紧跟在 work_group 之后。
    expect(items.slice(0, 6).map((item) => item.type)).toEqual([
      'message',
      'work_group',
      'todo',
      'message',
      'message',
      'work_group',
    ]);

    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice(0, 5)).toEqual([
      'message-user-0',
      'work-thinking-0',
      'todo-tool-0',
      'message-assistant-0',
      'message-user-1',
    ]);
  });

  it('keeps historical row references stable across 250 streaming tail updates', () => {
    const messages: RemoteMessage[] = [];
    for (let turn = 0; turn < 100; turn += 1) {
      const offset = turn * 2;
      messages.push(
        message({
          id: `user-${turn}`,
          role: 'user',
          content: { text: `Request ${turn}`, images: [], files: [] },
          createdAt: timestamp(offset),
        }),
        message({
          id: `assistant-${turn}`,
          role: 'assistant',
          content: [{ type: 'text', text: `Answer ${turn}` }],
          agentMeta: { isStreaming: turn === 99 },
          createdAt: timestamp(offset + 1),
        }),
      );
    }

    let previous: readonly MobileMessageRenderItem[] = buildMobileMessageRenderItems(
      messages,
      { isSessionStreaming: true },
    );
    for (let delta = 1; delta <= 250; delta += 1) {
      const nextMessages = messages.slice();
      nextMessages[nextMessages.length - 1] = {
        ...nextMessages[nextMessages.length - 1],
        content: [{ type: 'text', text: `Answer 99 ${delta}` }],
      };
      const next = buildMobileMessageRenderItems(nextMessages, { isSessionStreaming: true });
      const reconciled = reconcileMobileMessageRenderItems(previous, next);
      const changedRows = reconciled.reduce(
        (count, item, index) => count + (item === previous[index] ? 0 : 1),
        0,
      );
      expect(changedRows).toBe(1);
      previous = reconciled;
    }
  });

  it.each([
    { turnCompleted: true },
    { turnCostUsd: 0.5 },
    { turnUsageDetails: { totalTokens: 10 } },
  ])('invalidates an active prefix on completion %j and keeps it folded on send', (completion) => {
    const messages = [
      message({ id: 'u1', role: 'user', content: 'start', createdAt: timestamp(1) }),
      message({ id: 't1', role: 'tool_use', toolUseId: 't1', content: { toolName: 'Read', input: {} }, createdAt: timestamp(2) }),
      message({ id: 'p1', role: 'assistant', content: 'Checking more.', createdAt: timestamp(3) }),
      message({ id: 't2', role: 'tool_use', toolUseId: 't2', content: { toolName: 'Read', input: {} }, createdAt: timestamp(4) }),
      message({ id: 'p2', role: 'assistant', content: 'Checking again.', createdAt: timestamp(5) }),
      message({ id: 'final', role: 'assistant', content: 'Done.', agentMeta: { isStreaming: true }, createdAt: timestamp(7) }),
    ];
    const prefixCache = { current: null as ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'] };
    const build = (input: RemoteMessage[], isSessionStreaming: boolean) => buildMobileStreamingRenderWindow({
      cacheKey: 'en', messages: input, options: { isSessionStreaming, sessionId: 's1' }, prefixCache,
    });
    expect(build(messages, true).prefix).not.toBeNull();
    const sealed = messages.map((item) => item.id === 'final'
      ? { ...item, agentMeta: completion }
      : item);
    const completedItems = buildMobileMessageRenderItems(sealed, { isSessionStreaming: false });
    expect(build(sealed, true).items).toEqual(completedItems);
    expect(build(sealed, false).items).toEqual(completedItems);
    expect(build(sealed, true).items).toEqual(completedItems);
    const echoed = [...sealed, message({ id: 'u2', role: 'user', content: 'next', createdAt: timestamp(8) })];
    expect(build(echoed, true).items.slice(0, completedItems.length)).toEqual(completedItems);
  });

  it('reuses the normalized historical prefix while only the active turn streams', () => {
    const messages = createLargeDesktopMessageFixture(20);
    const messageStructureToken = {};
    const messageStructureChangedIndexes = new Set([messages.length + 1]);
    const activeUser = message({
      id: 'active-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(101),
    });
    const activeAssistant = message({
      id: 'active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(102),
    });
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [...messages, activeUser, activeAssistant],
      messageStructureChangedIndexes,
      messageStructureToken,
      options: { isSessionStreaming: true, sessionId: 's1' },
    });
    expect(first.prefix).not.toBeNull();

    const next = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [
        ...messages,
        activeUser,
        { ...activeAssistant, content: 'Partial update' },
      ],
      messageStructureChangedIndexes,
      messageStructureToken,
      options: { isSessionStreaming: true, sessionId: 's1' },
      previousPrefix: first.prefix,
    });

    expect(next.prefix).toBe(first.prefix);
    expect(next.prefix?.items).toBe(first.prefix?.items);
    expect(next.stablePrefixItemCount).toBe(first.prefix?.items.length);
    expect(next.diffCount).toBe(countMobileRenderItemDiffs(next.items));
    expect(next.items.slice(0, first.prefix!.items.length)).toEqual(first.prefix!.items);
  });

  it('does not read a 2000-message historical prefix again for a trusted text delta', () => {
    const history = createLargeDesktopMessageFixture(1_000);
    const activeUser = message({
      id: 'active-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(2_001),
    });
    const activeAssistant = message({
      id: 'active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(2_002),
    });
    const messageStructureToken = {};
    const messageStructureChangedIndexes = new Set([history.length + 1]);
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [...history, activeUser, activeAssistant],
      messageStructureChangedIndexes,
      messageStructureToken,
      options: { isSessionStreaming: true, sessionId: 's1' },
    });
    let historicalReads = 0;
    const nextMessages = new Proxy(
      [...history, activeUser, { ...activeAssistant, content: 'Partial update' }],
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            const index = Number(property);
            if (index < history.length) historicalReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const next = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: nextMessages,
      messageStructureChangedIndexes,
      messageStructureToken,
      options: { isSessionStreaming: true, sessionId: 's1' },
      previousPrefix: first.prefix,
    });

    expect(historicalReads).toBe(0);
    expect(next.stablePrefixItemCount).toBe(first.prefix?.items.length);
  });

  it('falls back to reference validation when no structure token is supplied', () => {
    const historicalAssistant = message({
      id: 'historical-assistant',
      role: 'assistant',
      content: 'Original history',
      createdAt: timestamp(1),
    });
    const activeUser = message({
      id: 'active-user-without-token',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(2),
    });
    const activeAssistant = message({
      id: 'active-assistant-without-token',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(3),
    });
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [historicalAssistant, activeUser, activeAssistant],
      options,
    });
    const changedMessages = [
      { ...historicalAssistant, content: 'Corrected history' },
      activeUser,
      activeAssistant,
    ];
    const changed = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: changedMessages,
      options,
      previousPrefix: first.prefix,
    });

    expect(changed.prefix).not.toBe(first.prefix);
    expect(changed.items).toEqual(buildMobileMessageRenderItems(changedMessages, options));
  });

  it('invalidates a historical prefix changed under the same structure token', () => {
    const historicalAssistant = message({
      id: 'historical-assistant-with-token',
      role: 'assistant',
      content: 'Original history',
      createdAt: timestamp(1),
    });
    const activeUser = message({
      id: 'active-user-with-history-change',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(2),
    });
    const activeAssistant = message({
      id: 'active-assistant-with-history-change',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(3),
    });
    const messageStructureToken = {};
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [historicalAssistant, activeUser, activeAssistant],
      messageStructureChangedIndexes: new Set([2]),
      messageStructureToken,
      options,
    });
    const changedMessages = [
      { ...historicalAssistant, content: 'Corrected history' },
      activeUser,
      activeAssistant,
    ];
    const changed = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: changedMessages,
      messageStructureChangedIndexes: new Set([0, 2]),
      messageStructureToken,
      options,
      previousPrefix: first.prefix,
    });

    expect(changed.prefix).not.toBe(first.prefix);
    expect(changed.items).toEqual(buildMobileMessageRenderItems(changedMessages, options));
  });

  it('invalidates the reusable prefix when its render cache key changes', () => {
    const historicalAssistant = message({
      id: 'cache-key-history',
      role: 'assistant',
      content: 'Earlier result',
      createdAt: timestamp(1),
    });
    const stableAssistant = message({
      id: 'cache-key-boundary',
      role: 'assistant',
      content: 'First phase complete',
      createdAt: timestamp(2),
    });
    const activeThinking = message({
      id: 'cache-key-thinking',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(3),
    });
    const activeAssistant = message({
      id: 'cache-key-active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(4),
    });
    const messages = [
      historicalAssistant,
      stableAssistant,
      activeThinking,
      activeAssistant,
    ];
    const messageStructureToken = {};
    const messageStructureChangedIndexes = new Set([messages.length - 1]);
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      messageStructureChangedIndexes,
      messageStructureToken,
      options,
    });
    expect(first.prefix?.mode).toBe('truncated-turn');

    const changed = buildMobileStreamingRenderWindow({
      cacheKey: 'zh-CN',
      messages,
      messageStructureChangedIndexes,
      messageStructureToken,
      options,
      previousPrefix: first.prefix,
    });

    expect(changed.prefix).not.toBe(first.prefix);
    expect(changed.prefix?.cacheKey).toBe('zh-CN');
    expect(changed.stablePrefixItemCount).toBe(0);
    expect(changed.items).toEqual(buildMobileMessageRenderItems(messages, options));

    const cacheKeyChangedItems = reconcileMobileMessageRenderItems(
      first.items,
      changed.items,
      committedMobileStreamingPrefixItemCount(changed, first.prefix),
    );
    expect(changed.prefix).not.toBeNull();
    commitMobileStreamingPrefixItems(changed.prefix!, cacheKeyChangedItems);

    const updatedMessages = [
      historicalAssistant,
      stableAssistant,
      activeThinking,
      { ...activeAssistant, content: 'Partial update' },
    ];
    const updated = buildMobileStreamingRenderWindow({
      cacheKey: 'zh-CN',
      messages: updatedMessages,
      messageStructureChangedIndexes,
      messageStructureToken,
      options,
      previousPrefix: changed.prefix,
    });
    expect(updated.prefix).toBe(changed.prefix);
    const updatedItems = reconcileMobileMessageRenderItems(
      cacheKeyChangedItems,
      updated.items,
      committedMobileStreamingPrefixItemCount(updated, changed.prefix),
    );
    const changedRows = updatedItems.reduce(
      (count, item, index) => count + (item === cacheKeyChangedItems[index] ? 0 : 1),
      0,
    );
    expect(changedRows).toBe(1);
  });

  it('reconciles a speculative changed prefix before reusing committed rows', () => {
    const historicalAssistant = message({
      id: 'speculative-prefix-history',
      role: 'assistant',
      content: 'Original history',
      createdAt: timestamp(1),
    });
    const activeUser = message({
      id: 'speculative-prefix-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(2),
    });
    const activeAssistant = message({
      id: 'speculative-prefix-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(3),
    });
    const initialMessages = [historicalAssistant, activeUser, activeAssistant];
    const messageStructureToken = {};
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const committedWindow = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: initialMessages,
      messageStructureChangedIndexes: new Set([2]),
      messageStructureToken,
      options,
      prefixCache,
    });
    const committedItems = reconcileMobileMessageRenderItems([], committedWindow.items);

    const changedHistoricalAssistant = {
      ...historicalAssistant,
      content: 'Corrected history',
    };
    const changedMessages = [changedHistoricalAssistant, activeUser, activeAssistant];
    const interruptedWindow = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: changedMessages,
      messageStructureChangedIndexes: new Set([0, 2]),
      messageStructureToken,
      options,
      prefixCache,
    });
    expect(interruptedWindow.prefix).not.toBe(committedWindow.prefix);

    // Model a retry after React abandons the render above. The speculative prefix is reusable by
    // the builder, but it has never been reconciled against the last committed rows.
    const retryWindow = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: changedMessages,
      messageStructureChangedIndexes: new Set([2]),
      messageStructureToken,
      options,
      prefixCache,
    });
    expect(retryWindow.prefix).toBe(interruptedWindow.prefix);
    expect(retryWindow.stablePrefixItemCount).toBeGreaterThan(0);
    const retryStablePrefixItemCount = committedMobileStreamingPrefixItemCount(
      retryWindow,
      committedWindow.prefix,
    );
    expect(retryStablePrefixItemCount).toBe(0);

    const correctedItems = reconcileMobileMessageRenderItems(
      committedItems,
      retryWindow.items,
      retryStablePrefixItemCount,
    );
    expect(correctedItems).not.toBe(committedItems);
    expect(correctedItems).toEqual(buildMobileMessageRenderItems(changedMessages, options));
    commitMobileStreamingPrefixItems(retryWindow.prefix!, correctedItems);

    // Once that prefix commits, identical input should retain the complete list reference and not
    // schedule duplicate row renders.
    const unchangedWindow = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: changedMessages,
      messageStructureChangedIndexes: new Set([2]),
      messageStructureToken,
      options,
      prefixCache,
    });
    const unchangedItems = reconcileMobileMessageRenderItems(
      correctedItems,
      unchangedWindow.items,
      committedMobileStreamingPrefixItemCount(unchangedWindow, retryWindow.prefix),
    );
    expect(unchangedItems).toBe(correctedItems);
    expect(new Set(unchangedItems.map((item) => item.key)).size).toBe(unchangedItems.length);

    const tailUpdatedMessages = [
      changedHistoricalAssistant,
      activeUser,
      { ...activeAssistant, content: 'Partial update' },
    ];
    const tailUpdatedWindow = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: tailUpdatedMessages,
      messageStructureChangedIndexes: new Set([2]),
      messageStructureToken,
      options,
      prefixCache,
    });
    const tailUpdatedItems = reconcileMobileMessageRenderItems(
      correctedItems,
      tailUpdatedWindow.items,
      committedMobileStreamingPrefixItemCount(tailUpdatedWindow, retryWindow.prefix),
    );
    const changedRows = tailUpdatedItems.reduce(
      (count, item, index) => count + (item === correctedItems[index] ? 0 : 1),
      0,
    );
    expect(changedRows).toBe(1);
  });

  it('invalidates a historical prefix only when one of its task updates changes', () => {
    const prefixTask = message({
      id: 'historical-prefix-task',
      role: 'tool_use',
      toolUseId: 'historical-prefix-task',
      content: {
        toolUseId: 'historical-prefix-task',
        toolName: 'collab:spawn',
        input: { task: 'Review the historical prefix' },
      },
      createdAt: timestamp(1),
    });
    const stableAssistant = message({
      id: 'historical-prefix-assistant',
      role: 'assistant',
      content: 'The review has started.',
      createdAt: timestamp(2),
    });
    const activeUser = message({
      id: 'historical-prefix-active-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(3),
    });
    const activeAssistant = message({
      id: 'historical-prefix-active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(4),
    });
    const prefixUpdate: AgentTaskUpdate = {
      provider: 'codex',
      taskId: 'historical-prefix-task',
      status: 'running',
    };
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };
    const options = {
      isSessionStreaming: true,
      renderOrphanTaskUpdates: true,
      sessionId: 's1',
    } as const;
    const messages = [prefixTask, stableAssistant, activeUser, activeAssistant];
    const firstUpdates = new Map<string, AgentTaskUpdate>([
      ['historical-prefix-task', prefixUpdate],
    ]);
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
      taskUpdates: firstUpdates,
    });

    expect(first.prefix?.mode).toBe('history');
    expect(first.items.filter((item) => item.type === 'agent_task')).toMatchObject([
      { key: 'task-historical-prefix-task', update: prefixUpdate },
    ]);

    const unrelatedUpdate: AgentTaskUpdate = {
      provider: 'codex',
      taskId: 'active-orphan-task',
      status: 'running',
    };
    const unrelatedUpdates = new Map<string, AgentTaskUpdate>([
      ['historical-prefix-task', prefixUpdate],
      ['active-orphan-task', unrelatedUpdate],
    ]);
    const unrelated = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
      taskUpdates: unrelatedUpdates,
    });

    expect(unrelated.prefix).toBe(first.prefix);
    expect(unrelated.items.filter((item) => item.type === 'agent_task')).toMatchObject([
      { key: 'task-historical-prefix-task', update: prefixUpdate },
      { key: 'task-update-active-orphan-task', update: unrelatedUpdate },
    ]);

    const changedPrefixUpdate = { ...prefixUpdate, title: 'Updated historical task' };
    const changedUpdates = new Map<string, AgentTaskUpdate>([
      ['historical-prefix-task', changedPrefixUpdate],
      ['active-orphan-task', unrelatedUpdate],
    ]);
    const changed = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
      taskUpdates: changedUpdates,
    });

    expect(changed.prefix).not.toBe(first.prefix);
    expect(changed.items.filter((item) => item.type === 'agent_task')).toMatchObject([
      { key: 'task-historical-prefix-task', update: changedPrefixUpdate },
      { key: 'task-update-active-orphan-task', update: unrelatedUpdate },
    ]);
  });

  it('publishes a reusable prefix before a streaming render commits', () => {
    const history = createLargeDesktopMessageFixture(20);
    const activeUser = message({
      id: 'active-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(101),
    });
    const activeAssistant = message({
      id: 'active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(102),
    });
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };

    const interrupted = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [...history, activeUser, activeAssistant],
      options: { isSessionStreaming: true, sessionId: 's1' },
      prefixCache,
    });
    expect(prefixCache.current).toBe(interrupted.prefix);

    const retry = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [
        ...history,
        activeUser,
        { ...activeAssistant, content: 'Partial update' },
      ],
      options: { isSessionStreaming: true, sessionId: 's1' },
      prefixCache,
    });

    expect(retry.prefix).toBe(interrupted.prefix);
    expect(prefixCache.current).toBe(interrupted.prefix);
  });

  it('reuses a stable assistant boundary when the active user row is outside the window', () => {
    const toolUse = message({
      id: 'tool-use',
      role: 'tool_use',
      toolUseId: 'tool-use',
      content: { toolUseId: 'tool-use', toolName: 'Read', input: { file_path: '/repo/a.ts' } },
      createdAt: timestamp(1),
    });
    const toolResult = message({
      id: 'tool-result',
      role: 'tool_result',
      toolUseId: 'tool-use',
      content: 'contents',
      createdAt: timestamp(2),
    });
    const stableAssistant = message({
      id: 'stable-assistant',
      role: 'assistant',
      content: 'The first check is complete.',
      createdAt: timestamp(3),
    });
    const activeThinking = message({
      id: 'active-thinking',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(4),
    });
    const activeAssistant = message({
      id: 'active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(5),
    });
    const messages = [toolUse, toolResult, stableAssistant, activeThinking, activeAssistant];
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;

    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
    });
    expect(first.prefix?.mode).toBe('truncated-turn');
    expect(first.prefix?.boundaryMessage).toBe(stableAssistant);
    expect(first.items).toEqual(buildMobileMessageRenderItems(messages, options));

    const updatedMessages = [
      toolUse,
      toolResult,
      stableAssistant,
      activeThinking,
      { ...activeAssistant, content: 'Partial update' },
    ];
    const retry = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: updatedMessages,
      options,
      prefixCache,
    });

    expect(retry.prefix).toBe(first.prefix);
    expect(retry.items).toEqual(buildMobileMessageRenderItems(updatedMessages, options));
  });

  it('does not rescan a retained 2000-message prefix to rediscover a truncated-turn boundary', () => {
    const history = Array.from({ length: 2_000 }, (_, index) => message({
      id: `retained-assistant-${index}`,
      role: 'assistant',
      content: `Completed ${index}`,
      createdAt: timestamp(index),
    }));
    const activeThinking = message({
      id: 'retained-active-thinking',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(2_001),
    });
    const activeAssistant = message({
      id: 'retained-active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(2_002),
    });
    const messageStructureToken = {};
    const changedIndexes = new Set([2_001]);
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [...history, activeThinking, activeAssistant],
      messageStructureChangedIndexes: changedIndexes,
      messageStructureToken,
      options,
    });
    expect(first.prefix?.mode).toBe('truncated-turn');

    let historicalReads = 0;
    const nextMessages = new Proxy(
      [...history, activeThinking, { ...activeAssistant, content: 'Partial update' }],
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            const index = Number(property);
            if (index < history.length - 1) historicalReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const next = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: nextMessages,
      messageStructureChangedIndexes: changedIndexes,
      messageStructureToken,
      options,
      previousPrefix: first.prefix,
    });

    expect(historicalReads).toBe(0);
    expect(next.prefix).toBe(first.prefix);
    expect(next.stablePrefixItemCount).toBe(first.prefix?.items.length);
  });

  it('advances the reusable prefix into a long visible active turn', () => {
    const history = createLargeDesktopMessageFixture(20);
    const activeUser = message({
      id: 'active-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(101),
    });
    const stableAssistant = message({
      id: 'stable-assistant',
      role: 'assistant',
      content: 'The first pass is complete.',
      createdAt: timestamp(102),
    });
    const activeThinking = message({
      id: 'active-thinking',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(103),
    });
    const activeAssistant = message({
      id: 'active-assistant',
      role: 'assistant',
      content: 'Partial',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(104),
    });
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;

    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [...history, activeUser, stableAssistant, activeThinking, activeAssistant],
      options,
      prefixCache,
    });
    expect(first.prefix?.mode).toBe('truncated-turn');
    expect(first.prefix?.boundaryMessage).toBe(stableAssistant);

    const updatedMessages = [
      ...history,
      activeUser,
      stableAssistant,
      activeThinking,
      { ...activeAssistant, content: 'Partial update' },
    ];
    const retry = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: updatedMessages,
      options,
      prefixCache,
    });

    expect(retry.prefix).toBe(first.prefix);
    expect(retry.items).toEqual(buildMobileMessageRenderItems(updatedMessages, options));
  });

  it('invalidates only when a task update used by the stable prefix changes', () => {
    const prefixTask = message({
      id: 'prefix-task',
      role: 'tool_use',
      toolUseId: 'prefix-task',
      content: {
        toolUseId: 'prefix-task',
        toolName: 'collab:spawn',
        input: { task: 'Review the prefix' },
      },
      createdAt: timestamp(1),
    });
    const stableAssistant = message({
      id: 'stable-after-task',
      role: 'assistant',
      content: 'The review has started.',
      createdAt: timestamp(2),
    });
    const activeThinking = message({
      id: 'active-thinking-after-task',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(3),
    });
    const prefixUpdate: AgentTaskUpdate = {
      provider: 'codex',
      taskId: 'prefix-task',
      status: 'running',
    };
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };
    const options = {
      isSessionStreaming: true,
      renderOrphanTaskUpdates: true,
      sessionId: 's1',
    } as const;
    const messages = [prefixTask, stableAssistant, activeThinking];
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
      taskUpdates: new Map<string, AgentTaskUpdate>([['prefix-task', prefixUpdate]]),
    });

    const unrelatedUpdate: AgentTaskUpdate = {
      provider: 'codex',
      taskId: 'tail-task',
      status: 'running',
    };
    const unrelated = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
      taskUpdates: new Map<string, AgentTaskUpdate>([
        ['prefix-task', prefixUpdate],
        ['tail-task', unrelatedUpdate],
      ]),
    });
    expect(unrelated.prefix).toBe(first.prefix);

    const completedPrefixUpdate = { ...prefixUpdate, status: 'completed' as const };
    const changedUpdates = new Map<string, AgentTaskUpdate>([
      ['prefix-task', completedPrefixUpdate],
      ['tail-task', unrelatedUpdate],
    ]);
    const changed = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
      taskUpdates: changedUpdates,
    });

    expect(changed.prefix).not.toBe(first.prefix);
    expect(changed.items).toEqual(
      buildMobileMessageRenderItems(messages, options, changedUpdates),
    );
  });

  it('keeps whole-turn transforms together until a later stable assistant boundary', () => {
    const stableAssistant = message({
      id: 'stable-assistant-before-structural-tail',
      role: 'assistant',
      content: 'The first phase is complete.',
      createdAt: timestamp(2),
    });
    const activeThinking = message({
      id: 'active-thinking-structural-tail',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(3),
    });
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;

    const scenarios: RemoteMessage[][] = [
      [
        message({
          id: 'agent-before-boundary',
          role: 'tool_use',
          toolUseId: 'agent-before-boundary',
          content: {
            toolUseId: 'agent-before-boundary',
            toolName: 'Agent',
            input: { prompt: 'Inspect the code' },
          },
          createdAt: timestamp(1),
        }),
        stableAssistant,
        message({
          id: 'late-subagent-child',
          role: 'assistant',
          content: 'Late child output',
          agentMeta: { parentUuid: 'agent-before-boundary', isStreaming: true },
          createdAt: timestamp(3),
        }),
      ],
      [
        message({
          id: 'plan-before-boundary',
          role: 'tool_use',
          toolUseId: 'plan-before-boundary',
          content: {
            toolUseId: 'plan-before-boundary',
            toolName: 'update_plan',
            input: { plan: [{ step: 'First', status: 'completed' }] },
          },
          createdAt: timestamp(1),
        }),
        stableAssistant,
        message({
          id: 'plan-after-boundary',
          role: 'tool_use',
          toolUseId: 'plan-after-boundary',
          content: {
            toolUseId: 'plan-after-boundary',
            toolName: 'update_plan',
            input: { plan: [{ step: 'Second', status: 'in_progress' }] },
          },
          createdAt: timestamp(3),
        }),
      ],
      [
        message({
          id: 'tool-before-boundary',
          role: 'tool_use',
          toolUseId: 'tool-before-boundary',
          content: {
            toolUseId: 'tool-before-boundary',
            toolName: 'Read',
            input: { file_path: '/repo/image.png' },
          },
          createdAt: timestamp(1),
        }),
        stableAssistant,
        message({
          id: 'late-tool-result',
          role: 'tool_result',
          toolUseId: 'tool-before-boundary',
          content: 'late result',
          createdAt: timestamp(3),
        }),
      ],
      [
        message({
          id: 'tool-image-before-boundary',
          role: 'tool_use',
          toolUseId: 'tool-image-before-boundary',
          content: {
            toolUseId: 'tool-image-before-boundary',
            toolName: 'Read',
            input: { file_path: '/repo/image.png' },
          },
          createdAt: timestamp(1),
        }),
        stableAssistant,
        message({
          id: 'assistant-image-after-boundary',
          role: 'assistant',
          content: '![Preview](https://example.com/image.png)',
          agentMeta: { isStreaming: true },
          createdAt: timestamp(3),
        }),
      ],
    ];

    for (const messages of scenarios) {
      const result = buildMobileStreamingRenderWindow({
        cacheKey: 'en',
        messages: [...messages, activeThinking],
        options,
      });
      expect(result.prefix).toBeNull();
      expect(result.items).toEqual(
        buildMobileMessageRenderItems([...messages, activeThinking], options),
      );
    }
  });

  it('does not treat steering or auto-resume user rows as the active turn root', () => {
    const history = createLargeDesktopMessageFixture(4);
    const activeUser = message({
      id: 'real-active-user',
      role: 'user',
      content: 'Continue',
      createdAt: timestamp(50),
    });
    const stableAssistant = message({
      id: 'stable-before-synthetic-user',
      role: 'assistant',
      content: 'First phase complete.',
      createdAt: timestamp(51),
    });
    const syntheticUsers = [
      message({
        id: 'steer-user',
        role: 'user',
        content: 'Adjust the current work',
        agentMeta: { delivery: 'steer' },
        createdAt: timestamp(52),
      }),
      message({
        id: 'auto-resume-user',
        role: 'user',
        content: '',
        agentMeta: { autoResume: true },
        createdAt: timestamp(52),
      }),
    ];

    for (const syntheticUser of syntheticUsers) {
      const messages = [
        ...history,
        activeUser,
        stableAssistant,
        syntheticUser,
        message({
          id: `streaming-after-${syntheticUser.id}`,
          role: 'assistant',
          content: 'Partial',
          agentMeta: { isStreaming: true },
          createdAt: timestamp(53),
        }),
      ];
      const result = buildMobileStreamingRenderWindow({
        cacheKey: 'en',
        messages,
        options: { isSessionStreaming: true, sessionId: 's1' },
      });

      expect(result.prefix?.mode).toBe('history');
      expect(result.prefix?.messages).toEqual(history);
      expect(result.items).toEqual(
        buildMobileMessageRenderItems(messages, { isSessionStreaming: true, sessionId: 's1' }),
      );
    }
  });

  it('invalidates a truncated-turn prefix when a late tool result settles it', () => {
    const toolUse = message({
      id: 'late-tool-use',
      role: 'tool_use',
      toolUseId: 'late-tool-use',
      content: {
        toolUseId: 'late-tool-use',
        toolName: 'Read',
        input: { file_path: '/repo/late.ts' },
      },
      createdAt: timestamp(1),
    });
    const stableAssistant = message({
      id: 'stable-after-tool',
      role: 'assistant',
      content: 'Waiting for the remaining work.',
      createdAt: timestamp(2),
    });
    const activeThinking = message({
      id: 'late-active-thinking',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(3),
    });
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };
    const first = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [toolUse, stableAssistant, activeThinking],
      options,
      prefixCache,
    });
    const lateResult = message({
      id: 'late-tool-result',
      role: 'tool_result',
      toolUseId: 'late-tool-use',
      content: 'late contents',
      createdAt: timestamp(4),
    });
    const settledMessages = [toolUse, stableAssistant, activeThinking, lateResult];

    const settled = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: settledMessages,
      options,
      prefixCache,
    });

    expect(settled.prefix).not.toBe(first.prefix);
    expect(settled.items).toEqual(buildMobileMessageRenderItems(settledMessages, options));

    const retry = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: settledMessages,
      options,
      prefixCache,
    });
    expect(retry.items).toEqual(buildMobileMessageRenderItems(settledMessages, options));
  });

  it('keeps full-turn image dedupe when an image assistant becomes the split boundary in one batch', () => {
    const imageUrl = 'xdt-image://lizi-art-media-images/cache-boundary.png';
    const toolUse = message({
      id: 'image-tool-use',
      role: 'tool_use',
      toolUseId: 'image-tool-use',
      content: {
        toolUseId: 'image-tool-use',
        toolName: 'Read',
        input: { file_path: '/repo/image.png' },
      },
      createdAt: timestamp(1),
    });
    const toolResult = message({
      id: 'image-tool-result',
      role: 'tool_result',
      toolUseId: 'image-tool-use',
      content: JSON.stringify({ xdt_image_url: imageUrl }),
      createdAt: timestamp(2),
    });
    const firstBoundary = message({
      id: 'first-boundary',
      role: 'assistant',
      content: 'First phase complete.',
      createdAt: timestamp(3),
    });
    const initialTail = message({
      id: 'initial-tail',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(4),
    });
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };

    buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [toolUse, toolResult, firstBoundary, initialTail],
      options,
      prefixCache,
    });

    const imageBoundary = message({
      id: 'image-boundary',
      role: 'assistant',
      content: `![Preview](${imageUrl})`,
      createdAt: timestamp(5),
    });
    const nextTail = message({
      id: 'next-tail',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Still working', isStreaming: true },
      createdAt: timestamp(6),
    });
    const messages = [toolUse, toolResult, firstBoundary, imageBoundary, nextTail];
    const result = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
    });

    expect(result.items).toEqual(buildMobileMessageRenderItems(messages, options));
  });

  it('keeps full-turn image dedupe between an earlier assistant and a tail tool result', () => {
    const imageUrl = 'xdt-image://lizi-art-media-images/cache-prefix.png';
    const user = message({
      id: 'image-prefix-user',
      role: 'user',
      content: 'Create an image',
      createdAt: timestamp(1),
    });
    const imageAssistant = message({
      id: 'image-prefix-assistant',
      role: 'assistant',
      content: `![Preview](${imageUrl})`,
      createdAt: timestamp(2),
    });
    const textBoundary = message({
      id: 'image-prefix-text-boundary',
      role: 'assistant',
      content: 'The first phase is complete.',
      createdAt: timestamp(3),
    });
    const initialTail = message({
      id: 'image-prefix-initial-tail',
      role: 'thinking',
      content: { kind: 'thinking', text: 'Continuing', isStreaming: true },
      createdAt: timestamp(4),
    });
    const options = { isSessionStreaming: true, sessionId: 's1' } as const;
    const prefixCache: {
      current: ReturnType<typeof buildMobileStreamingRenderWindow>['prefix'];
    } = { current: null };

    buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages: [user, imageAssistant, textBoundary, initialTail],
      options,
      prefixCache,
    });

    const tailToolUse = message({
      id: 'image-prefix-tail-tool',
      role: 'tool_use',
      toolUseId: 'image-prefix-tail-tool',
      content: {
        toolUseId: 'image-prefix-tail-tool',
        toolName: 'image_generate',
        input: { prompt: 'variant' },
      },
      createdAt: timestamp(5),
    });
    const tailToolResult = message({
      id: 'image-prefix-tail-result',
      role: 'tool_result',
      toolUseId: 'image-prefix-tail-tool',
      content: JSON.stringify({ xdt_image_url: imageUrl }),
      createdAt: timestamp(6),
    });
    const streamingTail = message({
      id: 'image-prefix-streaming-tail',
      role: 'assistant',
      content: 'Still working',
      agentMeta: { isStreaming: true },
      createdAt: timestamp(7),
    });
    const messages = [
      user,
      imageAssistant,
      textBoundary,
      tailToolUse,
      tailToolResult,
      streamingTail,
    ];
    const result = buildMobileStreamingRenderWindow({
      cacheKey: 'en',
      messages,
      options,
      prefixCache,
    });

    expect(result.items).toEqual(buildMobileMessageRenderItems(messages, options));
    expect(result.items.some((item) => item.type === 'tool_media')).toBe(false);
  });
});
