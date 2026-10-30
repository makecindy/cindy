import { describe, expect, it, vi } from 'vitest';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import { AUTO_REVIEW_DELEGATED_CONTINUATION } from '../../maker-ipc/autoReviewUserIntent.js';
import { appMessageInput, MCP_APP_MESSAGE_CLIENT_PREFIX, MCP_APP_MESSAGE_GUARD, queuedAppMessageGuard, type McpAppMessageGuard } from '../message.js';
import { createAppMessageSender } from '../messageSender.js';

const record: McpAppRecord = {
  version: 1, serverId: 'example', serverRevision: 'revision', resourceUri: 'ui://example/app',
  tool: { name: 'form', inputSchema: { type: 'object' } }, arguments: {},
};
const content = [{ type: 'text', text: '/compact' }];

function fixture(queue: boolean) {
  let owner: object = {}, boundary: number | null = null, visible = true;
  let waitingStage = '';
  let started!: () => void, release!: () => void;
  let barrier: Promise<void>;
  const wait = async (stage: string) => {
    if (stage !== waitingStage) return;
    started();
    await barrier;
  };
  const delivered = vi.fn();
  const sendToAgentAccepted = vi.fn();
  sendToAgentAccepted.mockImplementation(async (
    _id: string, _message: unknown, _create: unknown, options: Record<PropertyKey, unknown>,
  ) => {
    await wait('send');
    await (options[MCP_APP_MESSAGE_GUARD] as McpAppMessageGuard)();
    delivered();
    return { accepted: true };
  });
  const deps = {
    owner: () => owner,
    readClearBoundary: vi.fn(async () => { await wait('session'); return boundary; }),
    restoreQueue: vi.fn(async () => { await wait('queue'); }),
    clearBoundary: () => boundary,
    shouldQueue: () => queue,
    getSessionMeta: vi.fn(async () => { await wait('meta'); return { title: 'Task' }; }),
    createClientId: () => 'input',
    buildQueueItem: vi.fn(async (params: unknown) => {
      await wait('build');
      return params as AgentInputQueuedMessage;
    }),
    enqueue: vi.fn(),
    sendToAgentAccepted,
  };
  const guard = vi.fn(async () => {
    if (!visible) throw new Error('MCP_APP_CARD_UNAVAILABLE');
  });
  const send = createAppMessageSender(deps);
  return {
    deps, guard, delivered, send: () => send('task', record, content, guard),
    revokeCard: () => { visible = false; },
    changeOwner: () => { owner = {}; },
    clearTask: () => { boundary = 100; },
    hold(stage: string) {
      waitingStage = stage;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      barrier = new Promise<void>((resolve) => { release = resolve; });
      return { ready, release: () => release() };
    },
  };
}

describe('MCP App message input and dispatch', () => {
  it.each(['/compact', '  /compact focus', '\n/plugin install', '/'])
  ('escapes App-authored native command %j while preserving its authored history', (text) => {
    const input = appMessageInput([{ type: 'text', text }]);
    expect(input.text.trimStart()).toMatch(/^\\\//);
    expect(input.persistedContent).toBe(text);
    expect(input.blocks[0].text).toBe(input.text);
  });

  it('escapes every text block, including commands supplied through resource-link names', () => {
    const input = appMessageInput([
      { type: 'text', text: '' },
      { type: 'text', text: '/compact' },
      { type: 'resource_link', name: '/extension', uri: 'https://example.org' },
    ]);
    expect(input.blocks.map((block) => block.text)).toEqual([
      '', '\\/compact', '\\/extension: https://example.org',
    ]);
    expect(input.persistedContent).toBe('\n/compact\n/extension: https://example.org');
  });

  it.each([false, true])('keeps Main-stamped provenance and authored history (queue=%s)', async (queue) => {
    const f = fixture(queue);
    await f.send();
    const sourcePlugin = { pluginId: 'mcp-app:example', name: 'example' };
    if (queue) {
      expect(f.deps.buildQueueItem).toHaveBeenCalledWith(expect.objectContaining({
        message: '\\/compact', persistedContent: '/compact', sourcePlugin,
        autoReviewUserText: { kind: 'delegated-continuation' },
      }));
      expect(f.deps.enqueue).toHaveBeenCalledOnce();
      expect(f.deps.sendToAgentAccepted).not.toHaveBeenCalled();
    } else {
      expect(f.deps.sendToAgentAccepted).toHaveBeenCalledWith(
        'task', { type: 'user', content: [{ type: 'text', text: '\\/compact' }] }, undefined,
        expect.objectContaining({
          [MCP_APP_MESSAGE_GUARD]: expect.any(Function),
          [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
          persistUserMessage: expect.objectContaining({ content: '/compact', sourcePlugin }),
        }),
      );
      expect(f.delivered).toHaveBeenCalledOnce();
    }
  });

  it.each(['session', 'queue', 'meta', 'build'])
  ('rejects a card revoked during %s preparation before enqueuing it', async (stage) => {
    const f = fixture(true);
    const held = f.hold(stage);
    const rejected = expect(f.send()).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
    await held.ready;
    f.revokeCard();
    held.release();
    await rejected;
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.deps.sendToAgentAccepted).not.toHaveBeenCalled();
  });

  it('passes a live guard through direct-send preparation instead of accepting a stale View', async () => {
    const f = fixture(false);
    const held = f.hold('send');
    const rejected = expect(f.send()).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
    await held.ready;
    f.revokeCard();
    held.release();
    await rejected;
    expect(f.delivered).not.toHaveBeenCalled();
    expect(f.deps.sendToAgentAccepted).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'clear'] as const)('preserves the %s boundary after queued preparation', async (kind) => {
    const f = fixture(true);
    const held = f.hold('build');
    const rejected = expect(f.send()).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
    await held.ready;
    if (kind === 'owner') f.changeOwner();
    else f.clearTask();
    held.release();
    await rejected;
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the live grant on a queued message and rejects revocation after enqueue', async () => {
    const f = fixture(true);
    await f.send();
    const item = f.deps.enqueue.mock.calls[0][1];
    expect(item.clientId).toBe(`${MCP_APP_MESSAGE_CLIENT_PREFIX}input`);
    const guard = queuedAppMessageGuard(item);
    expect(guard).toBeTypeOf('function');
    await expect(guard!()).resolves.toBeUndefined();
    f.revokeCard();
    await expect(guard!()).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
  });

  it.each(['JSON', 'IPC'])('rejects a queued App grant lost across %s serialization', async (kind) => {
    const f = fixture(true);
    await f.send();
    const item = f.deps.enqueue.mock.calls[0][1];
    const restored = kind === 'JSON' ? JSON.parse(JSON.stringify(item)) : structuredClone(item);
    expect(Object.getOwnPropertySymbols(restored)).toHaveLength(0);
    expect(JSON.stringify(restored)).not.toContain('MCP_APP_MESSAGE_GUARD');
    await expect(queuedAppMessageGuard(restored)!()).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
  });

  it('does not create a card guard for ordinary owner queue input', () => {
    expect(queuedAppMessageGuard({ clientId: 'owner-input' })).toBeUndefined();
    expect(queuedAppMessageGuard({ clientId: 'plugin-input', sourcePlugin: { pluginId: 'other-plugin' } })).toBeUndefined();
  });

  it('rejects legacy App queue rows without treating display provenance as a live grant', async () => {
    await expect(queuedAppMessageGuard({
      clientId: 'legacy-input', sourcePlugin: { pluginId: 'mcp-app:example' },
    })!()).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
  });
});
