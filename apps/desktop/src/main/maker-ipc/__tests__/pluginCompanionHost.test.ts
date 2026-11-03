import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sources: [] as Array<Record<string, unknown>>,
  activities: new Map<string, Record<string, unknown>>(),
  away: new Set<string>(),
  view: { enabled: true, selfDeviceId: 'here', actors: [] as Array<Record<string, unknown>> },
  rows: [] as Array<{ role: string; createdAt: number; text: string | null }>,
  clearedAt: null as number | null,
}));
vi.mock('../../localDb/ipc/bots.js', () => ({ listBotRemoteResourceSources: async () => mocks.sources }));
vi.mock('../../localDb/ipc/botRemoteResourceProjection.js', () => ({
  visibleBotRemoteResourceSources: (sources: Array<{ hiddenAt: number | null }>) => sources.filter(source => source.hiddenAt === null),
}));
vi.mock('../../localDb/ipc/botRemoteResourceProvider.js', () => ({
  rosterBotActivities: async (sources: Array<{ id: string }>) =>
    new Map(sources.flatMap(source => mocks.activities.has(source.id) ? [[source.id, mocks.activities.get(source.id)]] : [])),
}));
vi.mock('../../companion-cloud/homes.js', () => ({
  companionHomes: { isHomeHere: (id: string) => !mocks.away.has(id), snapshot: () => mocks.view },
}));
vi.mock('../../companion-cloud/host.js', () => ({ readLatestMirrorRows: async () => mocks.rows }));
vi.mock('../../companion-cloud/mirror.js', () => ({ mirrorMessageText: (row: { text: string | null }) => row.text }));
vi.mock('../../agent-island/companionIdentity.js', () => ({ companionAvatarThumbnail: async () => 'SlBFRw==' }));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => ({
    client: { drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ clearedAt: mocks.clearedAt }] }) }) }) } },
  }),
}));

import { createPluginCompanionHost, PLUGIN_COMPANION_REPLY_MAX, type PluginCompanionRemoteDeps } from '../pluginCompanionHost.js';

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
});

beforeEach(() => {
  mocks.sources = [source('ada'), source('bo', { needsAttention: true }), source('gone', { hiddenAt: 1 }), source('far')];
  mocks.activities.clear();
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
    ['permission', expect.any(String)], ['ask_user_question', 'Which branch?'], ['input_handoff', null],
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
  interactions: [{ ref: 'r-far', kind: 'ask_user_question', title: 'Ship it?' }], lastReplyAt: 6,
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
