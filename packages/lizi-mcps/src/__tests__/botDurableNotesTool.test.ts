import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotDurableNoteTools } from '../xdt-helper/bot_durable_notes.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('Bot durable note tools', () => {
  it('always supplies the host-owned caller Session and never accepts botId', async () => {
    const set = vi.fn(async () => ({
      ok: true as const,
      note: { namespace: 'automation', key: 'cursor', value: { page: 2 } },
    }));
    const registry = new XdtHelperToolRegistry();
    registerBotDurableNoteTools(registry, {
      getSessionContext: () => ({ sessionId: 'bot-session' }),
      callbacks: {
        list: vi.fn(),
        get: vi.fn(),
        set,
        delete: vi.fn(),
      },
    });

    const result = await registry.call('set_bot_note', {
      namespace: 'automation',
      key: 'cursor',
      value: { page: 2 },
    });

    expect(parse(result)).toMatchObject({ ok: true });
    expect(set).toHaveBeenCalledWith({
      callerSessionId: 'bot-session',
      namespace: 'automation',
      key: 'cursor',
      value: { page: 2 },
    });
  });

  it('fails closed without a bound Session', async () => {
    const registry = new XdtHelperToolRegistry();
    registerBotDurableNoteTools(registry, {
      getSessionContext: () => ({}),
      callbacks: { list: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    });
    const result = await registry.call('list_bot_notes', {});
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
  });
});
