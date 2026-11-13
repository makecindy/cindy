import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectedReplyQuote } from '../selectedReplyQuote';

// Unit: the new selection must survive stream events but never leak into another turn/runtime.
// Host entry covers unavailable targets and a turn changing during the database await.
const fixture = vi.hoisted(() => {
  const session = { id: 's', instanceId: 'instance', getTurnGeneration: vi.fn(() => 1), isTurnRunning: () => true };
  const row = { clientId: 'u1', role: 'user', content: JSON.stringify({ text: 'Earlier question' }), agentMeta: null, rewindAt: null };
  return { session, row, read: vi.fn(), surface: vi.fn() };
});
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({ getSession: () => fixture.session }) }));
vi.mock('../../mcp-integrations/helperSurface.js', () => ({ resolveHelperSurface: fixture.surface }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {
  select: () => ({ from: () => ({ where: () => ({ limit: fixture.read }) }) }),
} }) }));
import { selectReplyQuote } from '../selectedReplyQuote.desktop';
const context = { sessionId: 's', sessionInstanceId: 'instance', mcpCallerKind: 'root' };
beforeEach(() => {
  fixture.session.getTurnGeneration.mockReturnValue(1);
  fixture.read.mockResolvedValue([fixture.row]);
  fixture.surface.mockResolvedValue('bot-main');
});
describe('explicit reply quote selection', () => {
  it('stores a host snapshot, supports clearing and expires on the next turn or instance', async () => {
    expect(await selectReplyQuote(context, 'u1')).toEqual({ ok: true });
    expect(selectedReplyQuote(fixture.session, 1)).toEqual({ clientId: 'u1', role: 'user', excerpt: 'Earlier question' });
    expect(selectedReplyQuote(fixture.session, 2)).toBeUndefined();
    expect(selectedReplyQuote({ ...fixture.session }, 1)).toBeUndefined();
    await selectReplyQuote(context, null);
    expect(selectedReplyQuote(fixture.session, 1)).toBeUndefined();
  });
  it('rejects missing or rewound originals and stale callers', async () => {
    fixture.read.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...fixture.row, rewindAt: 5 }]);
    expect(await selectReplyQuote(context, 'missing')).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(await selectReplyQuote(context, 'rewound')).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(await selectReplyQuote({ ...context, sessionInstanceId: 'old' }, 'u1')).toMatchObject({ errorCode: 'NO_ACTIVE_TURN' });
    expect(await selectReplyQuote({ ...context, mcpCallerKind: 'descendant' }, 'u1')).toMatchObject({ errorCode: 'NOT_SUPPORTED' });
  });
  it('does not apply a delayed selection to a newer turn', async () => {
    fixture.read.mockImplementationOnce(async () => {
      fixture.session.getTurnGeneration.mockReturnValue(2);
      return [fixture.row];
    });
    expect(await selectReplyQuote(context, 'u1')).toMatchObject({ errorCode: 'TURN_CHANGED' });
    expect(selectedReplyQuote(fixture.session, 2)).toBeUndefined();
  });
  // Regression: coordinator persists silent continuation as user text with autoResume metadata.
  // The host entry must reject that row while accepting identical text typed by the owner.
  it('rejects automatic continuation without rejecting the same words from the owner', async () => {
    await selectReplyQuote(context, null);
    const continuation = { ...fixture.row, content: JSON.stringify({ text: '继续' }) };
    fixture.read.mockResolvedValueOnce([{ ...continuation, agentMeta: JSON.stringify({ autoResume: true }) }]);
    expect(await selectReplyQuote(context, 'u1')).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(selectedReplyQuote(fixture.session, 1)).toBeUndefined();

    fixture.read.mockResolvedValueOnce([continuation]);
    expect(await selectReplyQuote(context, 'u1')).toEqual({ ok: true });
    expect(selectedReplyQuote(fixture.session, 1)).toEqual({ clientId: 'u1', role: 'user', excerpt: '继续' });
  });
});
