import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ owner: 'one', hidden: false, list: vi.fn(), save: vi.fn(), createOnce: vi.fn(), remove: vi.fn(), run: vi.fn(), history: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.owner, isAppSessionBoundaryPending: () => false }));
vi.mock('../../localDb/ipc/bots.js', () => ({ getBotRemoteResourceSource: async () => ({ id: 'bot', status: 'active', hiddenAt: h.hidden ? 1 : null }) }));
vi.mock('../service.js', () => ({ routineTools: { list: h.list, save: h.save, createOnce: h.createOnce, remove: h.remove, runNow: h.run, history: h.history, sources: async () => [] } }));
import { getBotRoutineRemoteResource, invokeBotRoutineRemoteAction } from '../companionResource.js';
const routine = { id: 'rule', botId: 'bot', revision: 4, createdAt: 1, updatedAt: 1, name: 'Review', prompt: 'Review changes', enabled: true, triggers: [{ id: 'daily', kind: 'cron', expression: '0 9 * * *', timezone: 'UTC' }] };
const request = (actionId: string, revision = 4) => ({ client: { protocolVersion: 1, primitives: ['routine-detail'] }, collectionId: 'routines', resourceRef: { collectionId: 'routines', kind: 'routine', id: 'bot:bot/rule' }, actionId, input: { revision, definition: routine } });
beforeEach(() => { vi.clearAllMocks(); h.owner = 'one'; h.hidden = false; h.list.mockResolvedValue([routine]); h.history.mockResolvedValue([]); });
it('preserves complete definitions and takes the newest run history first', async () => {
  h.history.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({ id: `run-${index}`, status: 'success', createdAt: 100 - index })));
  const result = await getBotRoutineRemoteResource('bot/rule');
  expect(result.ref.id).toBe('bot:bot/rule');
  expect(result.blocks?.[0].data).toMatchObject({ input: { name: routine.name, prompt: routine.prompt, triggers: routine.triggers }, history: [{ id: 'run-0' }, ...Array.from({ length: 19 }, (_, index) => ({ id: `run-${index + 1}` }))] });
});
it('passes the exact observed revision into the existing engine for save, run and delete', async () => {
  await invokeBotRoutineRemoteAction('bot/rule', request('routine-save'));
  expect(h.save).toHaveBeenCalledWith('bot', expect.objectContaining({ name: 'Review' }), 'rule', 4);
  await invokeBotRoutineRemoteAction('bot/rule', request('routine-run'));
  expect(h.run).toHaveBeenCalledWith('bot', 'rule', 4);
  await invokeBotRoutineRemoteAction('bot/rule', request('routine-delete'));
  expect(h.remove).toHaveBeenCalledWith('bot', 'rule', 4);
});
it('rejects stale or hidden resources before any mutation', async () => {
  await expect(invokeBotRoutineRemoteAction('bot/rule', request('routine-save', 3))).rejects.toThrow();
  h.hidden = true;
  await expect(getBotRoutineRemoteResource('bot/rule')).rejects.toThrow();
  await expect(invokeBotRoutineRemoteAction('bot/rule', request('routine-run'))).rejects.toThrow();
  expect(h.save).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
});
it('does not disclose a result after an account switch during a read', async () => {
  h.list.mockImplementation(async () => { h.owner = 'two'; return [routine]; });
  await expect(getBotRoutineRemoteResource('bot/rule')).rejects.toThrow('Account changed');
});

it('uses a stable bot-scoped creation identity for an acknowledgement retry', async () => {
  const create = { ...request('routine-create', 0), input: { revision: 0, requestId: 'mobile-request-123456', definition: routine } };
  await invokeBotRoutineRemoteAction('bot/new', create);
  await invokeBotRoutineRemoteAction('bot/new', create);
  expect(h.createOnce).toHaveBeenCalledTimes(2);
  expect(h.createOnce.mock.calls[0]).toEqual(h.createOnce.mock.calls[1]);
  expect(h.createOnce.mock.calls[0][2]).toMatch(/^[a-f0-9]{64}$/);
  expect(h.save).not.toHaveBeenCalled();
});
