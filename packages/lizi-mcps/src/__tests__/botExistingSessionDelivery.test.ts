import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { BotSessionDeliveryCallbacks } from '../xdt-helper/botSessionDeliveryTools.js';

const target = '11111111-1111-4111-8111-111111111111';
const input = {
  target_session_id: target,
  message: 'Delivery test only; do not start engineering work.',
  idempotency_key: 'one-test',
};
function payload(result: unknown): Record<string, unknown> {
  const first = (result as { content: Array<{ text?: string }> }).content[0];
  return JSON.parse(first.text!);
}

async function withClient(
  send: BotSessionDeliveryCallbacks['send'] | undefined,
  run: (client: Client) => Promise<void>,
  resolveSurface: () => Promise<'bot' | 'default' | 'restricted'> = async () => 'bot',
) {
  const unrestrictedSend = vi.fn();
  const server = createXdtHelperMcpServer({
    resolveSurface,
    ...(send ? { botSessionDelivery: { send } } : {}),
    sendToSession: unrestrictedSend,
  }, { agentKind: 'codex', workingDir: '/repo', sessionId: 'bot-parent' });
  const client = new Client({ name: 'bot-existing-session-delivery-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    await run(client);
    expect(unrestrictedSend).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
}
const deliver = (client: Client, args: Record<string, unknown> = input) => client.callTool({
  name: 'call_tool', arguments: { name: 'send_to_existing_session', args },
});

describe('Bot delivery to an existing user-authorized Session', () => {
  it.each([true, false])('preserves the host decision (allowed=%s) without opening global handoff', async (allowed) => {
    const send = vi.fn(async () => allowed
      ? { ok: true as const, targetSessionId: target, wakeKind: 'queued' as const }
      : { ok: false as const, errorCode: 'TARGET_NOT_AUTHORIZED', message: 'User authorization is required for this target.' });
    await withClient(send, async (client) => {
      const discovery = payload(await client.callTool({ name: 'list_tools', arguments: { category: 'bots' } }));
      expect(discovery.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'send_to_existing_session' }),
      ]));
      expect(payload(await deliver(client))).toMatchObject(allowed
        ? { ok: true, target_session_id: target, wake_kind: 'queued' }
        : { ok: false, errorCode: 'TARGET_NOT_AUTHORIZED' });
      expect(send).toHaveBeenCalledExactlyOnceWith({
        callerSessionId: 'bot-parent', targetSessionId: target,
        message: input.message, idempotencyKey: input.idempotency_key,
      });
      expect(payload(await client.callTool({ name: 'list_tools', arguments: { category: 'handoff' } })))
        .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
    });
  });

  it('does not advertise delivery without an authorizing Host implementation', async () => {
    await withClient(undefined, async (client) => {
      const discovery = payload(await client.callTool({ name: 'list_tools', arguments: { category: 'bots' } }));
      expect(discovery.tools).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'send_to_existing_session' }),
      ]));
      expect(payload(await deliver(client))).toMatchObject({ ok: false });
    });
  });
  it('uses the shared error payload so callers can read the refusal and recovery hint', async () => {
    const send = vi.fn(async () => ({ ok: false as const, errorCode: 'DELIVERY_UNVERIFIED', message: 'Retry only with the same delivery key and message.' }));
    await withClient(send, async client => {
      const result = await deliver(client);
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({ ok: false, errorCode: 'DELIVERY_UNVERIFIED',
        data: { hint: 'Retry only with the same delivery key and message.' } });
    });
  });

  it.each(['default', 'restricted'] as const)('rechecks the surface after discovery changes to %s', async (next) => {
    let surface: 'bot' | 'default' | 'restricted' = 'bot';
    const send = vi.fn();
    await withClient(send, async (client) => {
      await client.callTool({ name: 'list_tools', arguments: { category: 'bots' } });
      surface = next;
      expect(payload(await deliver(client))).toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
      expect(send).not.toHaveBeenCalled();
    }, async () => surface);
  });

  it('refuses self-delivery before calling the Host', async () => {
    const send = vi.fn();
    await withClient(send, async (client) => {
      expect(payload(await deliver(client, { ...input, target_session_id: 'bot-parent' })))
        .toMatchObject({ ok: false, errorCode: 'INVALID_TARGET' });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('rejects caller identity or execution overrides supplied by the model', async () => {
    const send = vi.fn(async () => ({ ok: true as const, targetSessionId: target, wakeKind: 'queued' as const }));
    await withClient(send, async (client) => {
      expect(payload(await deliver(client, { ...input, callerSessionId: 'other-bot', model: 'replacement', workingDir: '/other', create: true })))
        .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('does not report success or retry when the Host returns another Session', async () => {
    const send = vi.fn(async () => ({ ok: true as const, targetSessionId: 'different', wakeKind: 'resumed' as const }));
    await withClient(send, async (client) => {
      expect(payload(await deliver(client))).toMatchObject({ ok: false, errorCode: 'DELIVERY_RESULT_MISMATCH' });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
