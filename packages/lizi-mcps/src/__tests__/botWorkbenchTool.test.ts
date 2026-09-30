import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotWorkbenchTools } from '../xdt-helper/bot_workbench.js';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') throw new Error('text expected');
  return JSON.parse(block.text) as Record<string, unknown>;
}

function setup(sessionId: string | null = 'bot-session') {
  const update = vi.fn(async ({ cards }: { cards: unknown[] }) => ({
    ok: true as const,
    updatedAt: '2026-09-30T00:00:00.000Z',
    cardCount: cards.length,
  }));
  const reg = new XdtHelperToolRegistry();
  registerBotWorkbenchTools(reg, {
    getSessionContext: () => ({ sessionId: sessionId ?? undefined, agentKind: 'claude-code', workingDir: '/w' }),
    callbacks: { update },
  });
  return { reg, update };
}

describe('update_workbench', () => {
  it('saves cards through the caller Session', async () => {
    const { reg, update } = setup();
    const cards = [
      {
        title: '资产',
        source: '星落美术',
        rows: [
          { title: '「晨曦」立绘 v2', detail: '被退回：表情太冷', flag: true, status: '草图' },
          { title: '12 张切图尺寸不符', action: { label: '批量修正', message: '把这 12 张切图按规范重新导出' } },
        ],
      },
    ];

    const result = parse(await reg.call('update_workbench', { cards }));

    expect(result).toMatchObject({ ok: true, cardCount: 1 });
    expect(update).toHaveBeenCalledWith({ callerSessionId: 'bot-session', cards });
  });

  it('rejects a row that has both a status and an action, or neither', async () => {
    const { reg, update } = setup();
    const both = parse(
      await reg.call('update_workbench', {
        cards: [{ title: '进度', rows: [{ title: '#4100', status: 'review', action: { label: '推进', message: '推进 #4100' } }] }],
      }),
    );
    const neither = parse(
      await reg.call('update_workbench', { cards: [{ title: '进度', rows: [{ title: '#4100' }] }] }),
    );

    expect(both).toMatchObject({ ok: false, errorCode: 'INVALID_ROW' });
    expect(neither).toMatchObject({ ok: false, errorCode: 'INVALID_ROW' });
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts an empty list to clear the workbench', async () => {
    const { reg, update } = setup();
    expect(parse(await reg.call('update_workbench', { cards: [] }))).toMatchObject({ ok: true, cardCount: 0 });
    expect(update).toHaveBeenCalledWith({ callerSessionId: 'bot-session', cards: [] });
  });

  it('requires a Bot session', async () => {
    const { reg, update } = setup(null);
    expect(parse(await reg.call('update_workbench', { cards: [] }))).toMatchObject({
      ok: false,
      errorCode: 'NOT_A_BOT_SESSION',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
