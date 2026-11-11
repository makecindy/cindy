import { afterEach, expect, it, vi } from 'vitest';
import {
  COMPANION_HEARTBEAT_MS,
  COMPANION_PUSH_INTERVAL_MS,
  createCompanionWatchHub,
  handlePluginCompanionRequest,
  parsePluginCompanionAnswer,
  type PluginCompanionAdapter,
  type PluginCompanionContext,
} from '../pluginCompanionSlot.js';
import type { PluginCompanion } from '../../../shared/pluginCompanions.js';

const companion: PluginCompanion = {
  id: 'b1', name: 'Ada', description: '', home: { isSelf: true, online: true, deviceName: null }, status: 'running',
  activity: { phase: 'running', workingPhase: 'thinking', summary: null, startedAt: 1, lastActivityAt: 2 },
  interactions: [], lastReplyAt: null,
};
const adapter = (): PluginCompanionAdapter => ({
  list: vi.fn(async (guard: () => void) => { guard(); return [companion]; }),
  avatar: vi.fn(async () => ({ src: null, fallback: 'A' })),
  reply: vi.fn(async () => ({ text: 'done', createdAt: 3, truncated: false })),
  open: vi.fn(async () => {}),
  interaction: vi.fn(async (_companionId: string, ref: string) => ({ ref, kind: 'plan' as const, plan: 'Plan', truncated: false, allowHere: true })),
  answer: vi.fn(async () => ({ answered: true })),
  history: vi.fn(async () => ({ messages: [{ role: 'user' as const, text: 'hi', createdAt: 1, truncated: false }], more: false })),
});
const ctx = (over: Partial<PluginCompanionContext> = {}): PluginCompanionContext =>
  ({ ghostId: 'p', assertAuthorized: () => {}, ...over });
const hub = () => createCompanionWatchHub({ send: () => true, approved: () => true });

afterEach(() => { vi.useRealTimers(); });

// unit: request parsing and fail-closed authorization around the adapter; no Host, database or Electron.
it('lists companions, reads the latest reply and opens through the guarded adapter', async () => {
  const a = adapter();
  const h = hub();
  expect(await handlePluginCompanionRequest(a, h, { kind: 'capabilities' }, ctx())).toEqual({ ok: true, data: { version: 1 } });
  expect(await handlePluginCompanionRequest(a, h, { kind: 'list' }, ctx())).toMatchObject({ ok: true, data: { companions: [companion] } });
  expect(await handlePluginCompanionRequest(a, h, { kind: 'reply', companionId: 'b1' }, ctx()))
    .toEqual({ ok: true, data: { reply: { text: 'done', createdAt: 3, truncated: false } } });
  expect(await handlePluginCompanionRequest(a, h, { kind: 'open', companionId: 'b1', interactionRef: 'r' }, ctx()))
    .toEqual({ ok: true, data: { opened: true } });
  expect(a.open).toHaveBeenCalledWith('b1', 'r', expect.any(Function));
});

it.each([
  [{ kind: 'avatar' }],
  [{ kind: 'avatar', companionId: ' ' }],
  [{ kind: 'reply', companionId: 42 }],
  [{ kind: 'open', companionId: 'b1', interactionRef: 7 }],
  [{ kind: 'open', companionId: 'x'.repeat(4097) }],
  [{ kind: 'unwatch' }],
  [{ kind: 'send', companionId: 'b1', text: 'hi' }],
  [{ kind: 'interaction', companionId: 'b1' }],
  [{ kind: 'history', companionId: 'b1', limit: 0 }],
  [{ kind: 'history', companionId: 'b1', limit: 51 }],
  [{ kind: 'history', companionId: 'b1', limit: 2.5 }],
  [{ kind: 'history' }],
  [{ kind: 'answer', companionId: 'b1', interactionRef: 'r' }],
  [{ kind: 'answer', companionId: 'b1', interactionRef: 'r', answer: { kind: 'permission', decision: 'yes' } }],
  [null],
])('rejects %j before touching the adapter', async payload => {
  const a = adapter();
  expect(await handlePluginCompanionRequest(a, hub(), payload, ctx()))
    .toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled();
});

it('fails closed when authorization changes mid-read and hides unexpected errors', async () => {
  const a = adapter();
  let current = true;
  const guarded = ctx({ assertAuthorized: () => { if (!current) throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }); } });
  (a.list as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { current = false; return [companion]; });
  expect(await handlePluginCompanionRequest(a, hub(), { kind: 'list' }, guarded)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  (a.avatar as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT /Users/me/secret.png'));
  expect(await handlePluginCompanionRequest(a, hub(), { kind: 'avatar', companionId: 'b1' }, ctx()))
    .toEqual({ ok: false, error: { code: 'HOST_NOT_READY', message: 'HOST_NOT_READY', retryable: false } });
  expect(await handlePluginCompanionRequest(null, hub(), { kind: 'list' }, ctx())).toMatchObject({ ok: false, error: { code: 'HOST_NOT_READY' } });
});

it('coalesces change notices per plugin, keeps a heartbeat and drops plugins that lost approval or their page', () => {
  vi.useFakeTimers();
  const sent: Array<[string, unknown]> = [];
  const approved = new Set(['p', 'q']);
  let qPageOpen = true;
  const h = createCompanionWatchHub({
    send: (id, payload) => { sent.push([id, payload]); return id !== 'q' || qPageOpen; },
    approved: id => approved.has(id),
  });
  h.invalidate();
  expect(vi.getTimerCount()).toBe(0);
  const sub = h.watch('p');
  h.watch('q');
  for (let i = 0; i < 5; i++) h.invalidate();
  vi.advanceTimersByTime(0);
  expect(sent).toEqual([['p', { type: 'companions-changed', subscriptionId: sub, seq: 1 }], ['q', expect.objectContaining({ seq: 1 })]]);
  h.invalidate();
  vi.advanceTimersByTime(COMPANION_PUSH_INTERVAL_MS - 1);
  expect(sent).toHaveLength(2);
  qPageOpen = false;
  vi.advanceTimersByTime(1);
  expect(sent).toHaveLength(4);
  approved.delete('p');
  vi.advanceTimersByTime(COMPANION_HEARTBEAT_MS);
  // p lost approval (not sent), q's page is gone (dropped on its failed send): nobody is left watching.
  expect(sent.slice(4)).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('lets only the current subscription stop watching', () => {
  vi.useFakeTimers();
  const h = hub();
  const first = h.watch('p');
  const second = h.watch('p');
  expect(h.unwatch('p', first)).toBe(false);
  expect(h.unwatch('other', second)).toBe(false);
  expect(h.unwatch('p', second)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('reads one request and hands a well-formed answer to the adapter with the plugin id', async () => {
  const a = adapter();
  expect(await handlePluginCompanionRequest(a, hub(), { kind: 'interaction', companionId: 'b1', interactionRef: 'r' }, ctx()))
    .toEqual({ ok: true, data: { interaction: { ref: 'r', kind: 'plan', plan: 'Plan', truncated: false, allowHere: true } } });
  const answer = { kind: 'question', answers: [{ choices: ['A'], text: 'more' }] };
  expect(await handlePluginCompanionRequest(a, hub(), { kind: 'answer', companionId: 'b1', interactionRef: 'r', answer }, ctx()))
    .toEqual({ ok: true, data: { answered: true } });
  expect(a.answer).toHaveBeenCalledWith('b1', 'r', answer, { ghostId: 'p', guard: expect.any(Function) });
  // Both reach the plugin as they are: wait for the open dialog, or allow it in Cindy (open) instead.
  for (const code of ['TASK_BUSY', 'ALLOW_IN_CINDY']) {
    (a.answer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('x'), { code }));
    expect(await handlePluginCompanionRequest(a, hub(), { kind: 'answer', companionId: 'b1', interactionRef: 'r', answer: { kind: 'plan', decision: 'allow' } }, ctx()))
      .toMatchObject({ ok: false, error: { code } });
  }
});

it.each([
  [{ kind: 'permission', decision: 'allow', updatedInput: { command: 'ls' } }],
  [{ kind: 'plan', decision: 'allow', feedback: 'why' }],
  [{ kind: 'plan', decision: 'deny', feedback: 7 }],
  [{ kind: 'question', answers: [] }],
  [{ kind: 'question', answers: [{ choices: 'A' }] }],
  [{ kind: 'question', answers: [{ choices: [1] }] }],
  [{ kind: 'question', answers: [{ choices: [], text: 'x'.repeat(8001) }] }],
  [{ kind: 'question', answers: Array.from({ length: 21 }, () => ({ choices: ['A'] })) }],
  [{ kind: 'ask_user_question', answers: {} }],
  ['allow'],
])('refuses the answer %j', value => {
  expect(parsePluginCompanionAnswer(value)).toBeNull();
});

it('reads the recent conversation, 20 messages unless asked for up to 50', async () => {
  const a = adapter();
  expect(await handlePluginCompanionRequest(a, hub(), { kind: 'history', companionId: 'b1' }, ctx()))
    .toEqual({ ok: true, data: { history: { messages: [{ role: 'user', text: 'hi', createdAt: 1, truncated: false }], more: false } } });
  expect(a.history).toHaveBeenLastCalledWith('b1', 20, expect.any(Function));
  await handlePluginCompanionRequest(a, hub(), { kind: 'history', companionId: 'b1', limit: 50 }, ctx());
  expect(a.history).toHaveBeenLastCalledWith('b1', 50, expect.any(Function));
});
