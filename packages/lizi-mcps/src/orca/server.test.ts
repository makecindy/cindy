import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createOrcaMcpServer, type OrcaMcpDeps, type OrcaMcpSessionCtx } from './server.js';

const BASE = {
  ok: true as const,
  worker_id: 'w-1',
  session_id: 's-1',
  status: 'done',
  session_status: 'idle',
  idle_ms: 0,
  restored_from_storage: false,
  result: 'partial output',
};

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const first = content[0];
  if (!first?.text) throw new Error('missing text payload');
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function harness(readWorker: OrcaMcpDeps['readWorker']) {
  const server = createOrcaMcpServer({ readWorker } as unknown as OrcaMcpDeps, {
    agentKind: 'claude-code',
    workingDir: '/tmp',
    sessionId: 'lead-1',
  } as OrcaMcpSessionCtx);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'orca-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('cindy_orca.read_worker', () => {
  it('把本轮 terminal error 一并交给 Lead', async () => {
    const turnError = {
      message: 'Rate limit reached',
      reason: 'rate_limit',
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    const h = await harness(async () => ({ ...BASE, turnError }));
    const payload = payloadOf(
      await h.client.callTool({ name: 'read_worker', arguments: { worker_id: 'w-1' } }),
    );
    expect(payload.ok).toBe(true);
    expect(payload.turnError).toEqual(turnError);
    await h.cleanup();
  });

  it('本轮没有失败时 turnError 为 null,而不是悄悄缺字段', async () => {
    const h = await harness(async () => ({ ...BASE, turnError: null }));
    const payload = payloadOf(
      await h.client.callTool({ name: 'read_worker', arguments: { worker_id: 'w-1' } }),
    );
    expect(payload.ok).toBe(true);
    expect(payload.turnError).toBeNull();
    await h.cleanup();
  });
});
