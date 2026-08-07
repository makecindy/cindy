import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  beginGroupHistoryAccess,
  resetGroupHistoryAccessForTests,
} from '../../im/shared/groupHistoryAccess';
import type {
  GroupHistorySearchHit,
  GroupHistorySearchLane,
} from '../../im/shared/groupHistorySearch';
import { createGroupHistoryMcpServer } from '../groupHistoryMcpServer';

const LANE_A = { provider: 'telegram-personal:bot-a', chatId: '-100', threadId: '' } as const;
const LANE_B = { provider: 'telegram-personal:bot-a', chatId: '-200', threadId: '7' } as const;

async function callSearch(
  args: Record<string, unknown>,
  scope?: Parameters<typeof beginGroupHistoryAccess>[0]['scope'],
  options: { scopeInstanceId?: string; contextInstanceId?: string } = {},
) {
  const release = scope
    ? beginGroupHistoryAccess({
        sessionId: 'session-1',
        sessionInstanceId: options.scopeInstanceId ?? 'instance-1',
        scope,
      })
    : null;
  const search = vi.fn(
    async ({ lane }: { lane: GroupHistorySearchLane; query: string; limit?: number }) => [
      {
        id: 1,
        messageId: 'm-1',
        chatName: null,
        author: 'alice',
        isBot: false,
        text: '历史正文',
        fileNames: [],
        sentAt: 1,
        snippet: '<mark>历史</mark>正文',
        score: 1,
        source: 'fts' as const,
      } satisfies GroupHistorySearchHit,
    ],
  );
  const server = createGroupHistoryMcpServer({
    getSessionContext: () => ({
      agentKind: 'claude-code',
      workingDir: '/tmp',
      sessionId: 'session-1',
      sessionInstanceId: options.contextInstanceId ?? 'instance-1',
    }),
    search,
  });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'group-history-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const result = await client.callTool({ name: 'search', arguments: args });
    return { result, search };
  } finally {
    release?.();
    await client.close();
    await server.close();
  }
}

describe('cindy_group_history search permission boundary', () => {
  afterEach(() => resetGroupHistoryAccessForTests());

  it('guest defaults to the current lane and cannot select another lane', async () => {
    const current = await callSearch(
      { query: '历史' },
      { access: 'lane', provider: LANE_A.provider, lane: LANE_A },
    );
    expect(JSON.stringify(current.result)).toContain('telegram-personal:bot-a');
    expect(current.search).toHaveBeenCalledWith(expect.objectContaining({ lane: LANE_A }));

    const denied = await callSearch(
      { query: '历史', lane: LANE_B },
      { access: 'lane', provider: LANE_A.provider, lane: LANE_A },
    );
    expect(JSON.stringify(denied.result)).toContain('PERMISSION_DENIED');
    expect(denied.search).not.toHaveBeenCalled();
  });

  it('owner may select a precise other lane, but never gets an implicit global search', async () => {
    const owner = await callSearch(
      { query: '历史', lane: LANE_B },
      { access: 'owner', provider: LANE_A.provider, lane: LANE_A },
    );
    expect(owner.search).toHaveBeenCalledWith(expect.objectContaining({ lane: LANE_B }));

    const dm = await callSearch(
      { query: '历史' },
      { access: 'owner', provider: LANE_A.provider, lane: null },
    );
    expect(JSON.stringify(dm.result)).toContain('NO_CURRENT_LANE');
    expect(dm.search).not.toHaveBeenCalled();
  });

  it('released or stale session-instance scopes fail closed', async () => {
    const released = await callSearch({ query: '历史' });
    expect(JSON.stringify(released.result)).toContain('NO_ACTIVE_TELEGRAM_SCOPE');
    expect(released.search).not.toHaveBeenCalled();

    const stale = await callSearch(
      { query: '历史' },
      { access: 'owner', provider: LANE_A.provider, lane: LANE_A },
      { scopeInstanceId: 'instance-old', contextInstanceId: 'instance-new' },
    );
    expect(JSON.stringify(stale.result)).toContain('NO_ACTIVE_TELEGRAM_SCOPE');
    expect(stale.search).not.toHaveBeenCalled();
  });
});
