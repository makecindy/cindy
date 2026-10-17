/**
 * Opt-in end-to-end proof against a REAL chat-server (cloud-companions.md): two "devices"
 * of one owner, each with its own state file and in-memory local host, drive the real
 * companion-cloud modules. Skipped unless CINDY_CHAT_HARNESS_URL points at a throwaway
 * server whose stub auth accepts `<owner>@<device>` bearer tokens.
 *
 *   CINDY_CHAT_HARNESS_URL=http://127.0.0.1:3018 npx vitest run --project standard \
 *     src/main/companion-cloud/__tests__/twoDevices.harness.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../shared/interruptedTurn.js';
import { DIRECT_ROOM_COMPLETION, deliverDirectRoomMessage } from '../directRoom.js';
import { companionSnapshot, createCompanionHomeRegistry, registerCompanionHomes } from '../homes.js';
import type { CompanionMirrorRow } from '../mirror.js';
import { startCompanionCloud, type CompanionCloudHost, type CompanionCloudRuntime, type CompanionRuntimeActor } from '../runtime.js';
import { createCompanionCloudState } from '../state.js';
import type { CompanionApi } from '../types.js';
import { COMPANION_MEMORY_PREFIX, COMPANION_PROFILE_KEY, COMPANION_SKILL_PREFIX, type CompanionPreferenceValue } from '../uploader.js';

const BASE = process.env.CINDY_CHAT_HARNESS_URL?.replace(/\/$/, '');
const OWNER = `e2e${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
const BOT = `bot_e2e_${randomUUID().slice(0, 8)}`;
const tempDirs: string[] = [];

/** Same error contract as chatServer.ts: code as message, `status` and `details` on the error. */
function harnessApi(token: string, calls: Array<{ route: string; method: string }>): CompanionApi {
  return async <T>(route: string, method = 'GET', data?: unknown, actorId?: string): Promise<T> => {
    calls.push({ route, method });
    const response = await fetch(`${BASE}/v1${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(actorId ? { 'X-Chat-Actor': actorId } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    let value: { error?: { code?: string; details?: unknown } } & Record<string, unknown>;
    try { value = JSON.parse(text); } catch { throw Object.assign(new Error('INVALID_CHAT_RESPONSE'), { status: response.status }); }
    if (response.status >= 400) {
      throw Object.assign(new Error(typeof value?.error?.code === 'string' ? value.error.code : 'REQUEST_FAILED'),
        { status: response.status, details: value?.error?.details });
    }
    return value as T;
  };
}

interface LocalBot { status: string; displayName: string; description: string; soul: string; user: string; systemPrompt: string }

/** One computer: its own token/device claim, state file and in-memory local companion data. */
async function createDevice(name: string, peers: () => DeviceLinkDeviceView[], options: { installationId?: string } = {}) {
  const calls: Array<{ route: string; method: string }> = [];
  const api = harnessApi(`${OWNER}@${name}`, calls);
  const dir = mkdtempSync(path.join(os.tmpdir(), `companion-${name}-`));
  tempDirs.push(dir);
  const profiles = new Map<string, LocalBot>();
  const memories = new Map<string, Map<string, string>>();
  const skills = new Map<string, Map<string, string>>();
  const sessions = new Map<string, string>();
  const rows = new Map<string, CompanionMirrorRow[]>();
  const deliveries: Array<{ botId: string; text: string; clientId: string }> = [];
  const rebuilds: string[] = [];
  let alive = true;
  let rowClock = Date.now();
  const sessionRows = (sessionId: string) => rows.get(sessionId) ?? (rows.set(sessionId, []), rows.get(sessionId)!);
  const visible = (sessionId: string) => sessionRows(sessionId).filter(row => row.role === 'user' || row.role === 'assistant')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const addRow = (sessionId: string, role: string, content: unknown, clientId = `c-${randomUUID()}`, createdAt = (rowClock = Math.max(rowClock + 1, Date.now()))) => {
    const row = { id: `m-${randomUUID()}`, clientId, role, content: typeof content === 'string' ? content : JSON.stringify(content), agentMeta: null, createdAt };
    sessionRows(sessionId).push(row);
    return row;
  };
  const ensureSession = (botId: string) => {
    if (!sessions.has(botId)) sessions.set(botId, `session-${name}-${randomUUID().slice(0, 8)}`);
    return sessions.get(botId)!;
  };

  const homes = createCompanionHomeRegistry();
  const host: CompanionCloudHost = {
    homes,
    openState: (_endpoint, _human, current) => createCompanionCloudState({ filePath: path.join(dir, 'state.json'), current }),
    // Same value shapes as host.ts readCompanionValues.
    readValues: async (botId) => {
      const profile = profiles.get(botId);
      if (!profile) return [];
      const values: CompanionPreferenceValue[] = [{ key: COMPANION_PROFILE_KEY, value: {
        name: profile.displayName, description: profile.description, soul: profile.soul, systemPrompt: profile.systemPrompt, user: profile.user } }];
      for (const [filename, content] of memories.get(botId) ?? []) values.push({ key: `${COMPANION_MEMORY_PREFIX}${filename}`, value: { filename, content } });
      for (const [slug, content] of skills.get(botId) ?? []) values.push({ key: `${COMPANION_SKILL_PREFIX}${slug}`, value: { slug, content } });
      return values;
    },
    canonicalSession: async (botId) => sessions.get(botId) ?? null,
    rowsAfter: async (sessionId, cursor, limit) => visible(sessionId)
      .filter(row => row.createdAt > cursor.createdAt || (row.createdAt === cursor.createdAt && row.id > cursor.id)).slice(0, limit),
    latestRows: async (sessionId, limit, options) => visible(sessionId).reverse()
      .filter(row => !options?.excludeClientIdPrefix || !row.clientId.startsWith(options.excludeClientIdPrefix)).slice(0, limit),
    deliverToCanonical: async (botId, text, clientId) => {
      deliveries.push({ botId, text, clientId });
      addRow(ensureSession(botId), 'user', text, clientId);
      return { ok: true };
    },
    materializer: {
      readProfile: async (botId) => profiles.get(botId) ?? null,
      createProfile: async (input) => {
        profiles.set(input.id, { status: 'active', displayName: input.name, description: input.description,
          soul: input.identitySource, user: input.userContextSource, systemPrompt: '' });
      },
      updateProfile: async (input) => {
        const current = profiles.get(input.id)!;
        profiles.set(input.id, { ...current, status: 'active', displayName: input.name,
          description: input.description ?? current.description, soul: input.identitySource ?? current.soul, user: input.userContextSource ?? current.user });
      },
      writeSystemPrompt: async (botId, text) => { profiles.get(botId)!.systemPrompt = text; },
      readMemory: async (botId, filename) => memories.get(botId)?.get(filename) ?? null,
      restoreMemory: async (botId, filename, raw) => { (memories.get(botId) ?? (memories.set(botId, new Map()), memories.get(botId)!)).set(filename, raw); },
      removeMemory: async (botId, filename) => { memories.get(botId)?.delete(filename); },
      readSkill: async (botId, slug) => skills.get(botId)?.get(slug) ?? null,
      saveSkill: async (botId, slug, content, _enabled) => { (skills.get(botId) ?? (skills.set(botId, new Map()), skills.get(botId)!)).set(slug, content); },
      removeSkill: async (botId, slug) => { skills.get(botId)?.delete(slug); },
      ensureCanonicalSession: async (botId) => ensureSession(botId),
      localMessageTimes: async (sessionId, fromMs) => visible(sessionId).filter(row => row.createdAt >= fromMs)
        .map(row => ({ role: row.role, createdAt: row.createdAt, clientId: row.clientId })),
      insertHistory: async (sessionId, row) => {
        addRow(sessionId, row.role, row.role === 'user' ? { text: row.text, images: [], files: [] } : [{ type: 'text', text: row.text }], row.clientId, row.createdAt);
      },
      rebuildContext: async (sessionId) => { rebuilds.push(sessionId); return 'rebuilt'; },
    },
    listDevices: async () => peers(),
    probeCompanionCloud: async () => true,
    ...(options.installationId ? { installationId: () => options.installationId! } : {}),
  };

  let selfDeviceId = '';
  let humanActorId = '';
  let actors: CompanionRuntimeActor[] = [];
  let runtime: CompanionCloudRuntime;
  const publish = () => {
    homes.update(companionSnapshot({ enabled: true, selfDeviceId, humanActorId, actors, demotedBotIds: runtime.shadowIds() }));
  };
  /** The companion part of chatServer.register(), forced. */
  const refresh = async () => {
    const me = await api<{ actor: { id: string }; deviceId: string; capabilities?: { companionHome?: boolean } }>('/me');
    expect(me.capabilities?.companionHome).toBe(true);
    expect(me.deviceId).toBe(name);
    actors = await api<CompanionRuntimeActor[]>('/actors');
    for (const [id, profile] of profiles) {
      if (profile.status !== 'active' || actors.some(actor => actor.kind === 'bot' && actor.externalId === id)) continue;
      actors.push(await api<CompanionRuntimeActor>('/actors', 'POST', { operationId: randomUUID(), kind: 'bot', externalId: id, name: profile.displayName }));
    }
    await registerCompanionHomes({ api, selfDeviceId, actors, isDemoted: botId => runtime.state.isDemoted(botId),
      botIds: [...profiles].filter(([, profile]) => profile.status === 'active').map(([id]) => id) });
    runtime.reconcile([...profiles].map(([id, profile]) => ({ id, status: profile.status })));
    publish();
  };
  const start = () => {
    alive = true;
    runtime = startCompanionCloud({ api, host, endpoint: BASE!, humanActorId, selfDeviceId, current: () => alive,
      bots: () => actors.filter(actor => actor.kind === 'bot' && !actor.disabled && actor.homeDeviceId === selfDeviceId
        && profiles.get(actor.externalId)?.status === 'active' && !runtime.isShadowed(actor.externalId))
        .map(actor => ({ botId: actor.externalId, actorId: actor.id, name: actor.name })),
      actors: () => actors, refresh, publish, initialKick: false, uploadIntervalMs: 3_600_000, mirrorIntervalMs: 3_600_000 });
  };
  const me = await api<{ actor: { id: string }; deviceId: string }>('/me');
  humanActorId = me.actor.id;
  selfDeviceId = me.deviceId;
  start();
  return {
    name, api, calls, deliver: host.deliverToCanonical, profiles, memories, skills, sessions, rows, deliveries, rebuilds, homes, addRow, ensureSession, visible, refresh,
    get runtime() { return runtime; },
    get humanActorId() { return humanActorId; },
    actor: (botId: string) => actors.find(actor => actor.kind === 'bot' && actor.externalId === botId),
    /** Go offline: every loop stops and nothing reaches the server. */
    stop: () => { alive = false; runtime.dispose(); },
    /** Come back with whatever (possibly stale) actor list it had. */
    restart: () => start(),
  };
}

const eligible = (deviceId: string): DeviceLinkDeviceView => ({ deviceId, name: deviceId, platform: 'darwin', appVersion: '1',
  lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false });
const waitFor = async <T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, label: string, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
};

describe.skipIf(!BASE)('cloud companions against a real chat-server (two devices)', () => {
  afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

  it('registers, syncs, takes over, conflicts, hands over and retires one companion', { timeout: 120_000 }, async () => {
    const macmini = await createDevice('macmini', () => [eligible('laptop')]);
    const laptop = await createDevice('laptop', () => [eligible('macmini')]);
    const prefsOf = async (actorId: string) => new Map((await macmini.api<Array<{ key: string; value: unknown; revision: number }>>(
      '/preferences', 'GET', undefined, actorId)).map(row => [row.key, row.value]));

    // 1. macmini registers the companion and becomes its home; laptop sees that.
    macmini.profiles.set(BOT, { status: 'active', displayName: 'E2E Mia', description: 'tester', soul: 'I am Mia v1', user: 'Owner likes tea', systemPrompt: 'Be brief' });
    macmini.memories.set(BOT, new Map([['user_tea.md', '---\ntitle: Tea\n---\nlikes tea'], ['reference_old.md', '---\ntitle: Old\n---\nold fact']]));
    macmini.skills.set(BOT, new Map([['brew', '---\nname: "brew"\n---\n\nsteps v1\n']]));
    const macSession = macmini.ensureSession(BOT);
    await macmini.refresh();
    const actorId = macmini.actor(BOT)!.id;
    expect(macmini.actor(BOT)!.homeDeviceId).toBe('macmini');
    expect(macmini.homes.isHomeHere(BOT)).toBe(true);
    await laptop.refresh();
    expect(laptop.homes.homeOf(BOT)).toBe('macmini');
    expect(laptop.homes.isHomeHere(BOT)).toBe(false);

    // 2. Profile, memories and a skill change; the uploader pushes them, a removed memory is tombstoned.
    await macmini.runtime.syncNow();
    macmini.profiles.get(BOT)!.soul = 'I am Mia v2';
    macmini.memories.get(BOT)!.delete('reference_old.md');
    macmini.memories.get(BOT)!.set('project_launch.md', '---\ntitle: Launch\n---\nship on Friday');
    macmini.skills.get(BOT)!.set('brew', '---\nname: "brew"\n---\n\nsteps v2\n');
    await macmini.runtime.syncNow();
    const prefs = await prefsOf(actorId);
    expect(prefs.get(COMPANION_PROFILE_KEY)).toEqual({ name: 'E2E Mia', description: 'tester', soul: 'I am Mia v2', user: 'Owner likes tea', systemPrompt: 'Be brief' });
    expect(prefs.get(`${COMPANION_MEMORY_PREFIX}user_tea.md`)).toEqual({ filename: 'user_tea.md', content: '---\ntitle: Tea\n---\nlikes tea' });
    expect(prefs.get(`${COMPANION_MEMORY_PREFIX}project_launch.md`)).toEqual({ filename: 'project_launch.md', content: '---\ntitle: Launch\n---\nship on Friday' });
    expect(prefs.has(`${COMPANION_MEMORY_PREFIX}reference_old.md`)).toBe(true);
    expect(prefs.get(`${COMPANION_MEMORY_PREFIX}reference_old.md`)).toBeNull();
    expect(prefs.get(`${COMPANION_SKILL_PREFIX}brew`)).toEqual({ slug: 'brew', content: '---\nname: "brew"\n---\n\nsteps v2\n' });

    // 3. Only visible user/assistant rows reach the deterministic 1:1 room; a rerun imports nothing.
    macmini.addRow(macSession, 'user', { text: 'hello', images: [], files: [] });
    macmini.addRow(macSession, 'user', `${UI_ACTION_TRIGGER_PREFIX}hidden continuation`);
    macmini.addRow(macSession, 'tool_use', { name: 'Bash' });
    macmini.addRow(macSession, 'assistant', [{ type: 'text', text: 'hi there' }]);
    macmini.addRow(macSession, 'user', 'already in the room', 'chat-direct:earlier:00000000-0000-4000-8000-000000000000');
    await macmini.runtime.syncNow();
    const roomId = macmini.runtime.roomIdFor(BOT)!;
    expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
    const importsBefore = macmini.calls.filter(call => call.route.endsWith('/import')).length;
    await macmini.runtime.syncNow();
    expect(macmini.calls.filter(call => call.route.endsWith('/import')).length).toBe(importsBefore);
    const first = await laptop.runtime.transcript(BOT);
    expect(first.messages.map(m => [m.role, m.text])).toEqual([['user', 'hello'], ['assistant', 'hi there']]);
    expect(laptop.runtime.roomIdFor(BOT)).toBe(roomId);

    // 4. A message written straight into the room is claimed only by the home and delivered to its main task.
    const posted = await laptop.api<{ id: string }>(`/conversations/${roomId}/messages`, 'POST',
      { operationId: `e2e-post-${randomUUID()}`, content: [{ type: 'text', text: 'from laptop' }], mentions: [] });
    const queued = await waitFor(async () => (await laptop.api<Array<{ id: string; source_message_id: string; status: string }>>(
      `/conversations/${roomId}/executions`)).find(e => e.source_message_id === posted.id && e.status === 'queued'), 'queued execution');
    const claim = { executorId: 'desktop:e2e', accessPolicyVersion: 1, planVersion: 1 };
    const laptopClaim = await laptop.api<{ execution: unknown }>('/executions/claim', 'POST', { operationId: randomUUID(), ...claim }, actorId);
    expect(laptopClaim.execution).toBeNull();
    const execution = await waitFor(async () => (await macmini.api<{ execution: { id: string; epoch: number; source_message_id: string } | null }>(
      '/executions/claim', 'POST', { operationId: randomUUID(), ...claim }, actorId)).execution, 'macmini claim');
    expect(execution.id).toBe(queued.id);
    const clientId = await deliverDirectRoomMessage({ api: macmini.api, roomId, executionId: execution.id, sourceMessageId: execution.source_message_id,
      humanActorId: macmini.humanActorId, botId: BOT, deliver: macmini.deliver,
      beforeDeliver: async () => { await macmini.api(`/conversations/${roomId}/executions/${execution.id}`, 'POST', { operationId: randomUUID(), executorId: 'desktop:e2e', epoch: execution.epoch, action: 'heartbeat' }, actorId); } });
    expect(clientId).toBe(`chat-direct:${execution.id}:${posted.id}`);
    expect(macmini.deliveries).toEqual([{ botId: BOT, text: 'from laptop', clientId }]);
    const roomBefore = (await laptop.api<unknown[]>(`/conversations/${roomId}/messages?limit=100`)).length;
    await macmini.api(`/conversations/${roomId}/executions/${execution.id}`, 'POST', {
      operationId: `chat:${execution.id}:${execution.epoch}:complete`, executorId: 'desktop:e2e', epoch: execution.epoch, action: 'complete', ...DIRECT_ROOM_COMPLETION,
    }, actorId);
    const settled = (await laptop.api<Array<{ id: string; status: string; output_message_id: string | null }>>(`/conversations/${roomId}/executions`))
      .find(e => e.id === execution.id)!;
    expect(settled.status).toBe('succeeded');
    expect(settled.output_message_id).toBeNull();
    expect((await laptop.api<unknown[]>(`/conversations/${roomId}/messages?limit=100`)).length).toBe(roomBefore);
    // The reply reaches the room through the mirror; the delivered input itself is not mirrored again.
    macmini.addRow(macSession, 'assistant', [{ type: 'text', text: 'reply to laptop' }]);
    await macmini.runtime.syncNow();
    const second = await laptop.runtime.transcript(BOT);
    expect(second.messages.map(m => [m.role, m.text])).toEqual([
      ['user', 'hello'], ['assistant', 'hi there'], ['user', 'from laptop'], ['assistant', 'reply to laptop']]);

    // 5. macmini goes offline; laptop takes over and builds the companion from the cloud.
    macmini.stop();
    expect(await laptop.runtime.takeOver(BOT)).toEqual({ ok: true });
    expect(laptop.actor(BOT)!.homeDeviceId).toBe('laptop');
    expect(laptop.profiles.get(BOT)).toEqual({ status: 'active', displayName: 'E2E Mia', description: 'tester',
      soul: 'I am Mia v2', user: 'Owner likes tea', systemPrompt: 'Be brief' });
    expect([...laptop.memories.get(BOT)!.keys()].sort()).toEqual(['project_launch.md', 'user_tea.md']);
    expect(laptop.skills.get(BOT)!.get('brew')).toBe('---\nname: "brew"\n---\n\nsteps v2\n');
    const lapSession = laptop.sessions.get(BOT)!;
    const history = laptop.visible(lapSession);
    expect(history.map(row => [row.role, row.clientId.startsWith('cloud-history:')])).toEqual([
      ['user', true], ['assistant', true], ['user', true], ['assistant', true]]);
    expect(laptop.rebuilds).toEqual([lapSession]);
    expect(laptop.runtime.state.bot(BOT)?.demoted).toBeUndefined();
    // Taking over again is idempotent: nothing is inserted twice and no second rebuild.
    expect(await laptop.runtime.takeOver(BOT)).toEqual({ ok: true });
    expect(laptop.visible(lapSession)).toHaveLength(4);
    expect(laptop.rebuilds).toHaveLength(1);

    // 6. macmini comes back with a stale actor list: its take-over loses the compare-and-set.
    macmini.restart();
    expect(macmini.actor(BOT)!.homeDeviceId).toBe('macmini');
    expect(await macmini.runtime.takeOver(BOT)).toEqual({ ok: false, code: 'HOME_CONFLICT', homeDeviceId: 'laptop' });
    expect(macmini.runtime.state.isDemoted(BOT)).toBe(true);
    expect(macmini.homes.snapshot().demotedBotIds).toEqual([BOT]);
    expect(macmini.homes.isHomeHere(BOT)).toBe(false);
    const macCallsBefore = macmini.calls.length;
    macmini.memories.get(BOT)!.set('user_stale.md', '---\ntitle: Stale\n---\nmust not upload');
    macmini.addRow(macSession, 'assistant', [{ type: 'text', text: 'stale reply' }]);
    await macmini.runtime.syncNow();
    expect(macmini.calls.slice(macCallsBefore).filter(call => call.method !== 'GET')).toEqual([]);

    // 7. laptop hands the companion back: flush first, then the move, then macmini picks it up.
    laptop.addRow(lapSession, 'user', { text: 'on laptop', images: [], files: [] });
    laptop.addRow(lapSession, 'assistant', [{ type: 'text', text: 'laptop reply' }]);
    const lapCallsBefore = laptop.calls.length;
    expect(await laptop.runtime.transfer(BOT, 'macmini')).toEqual({ ok: true });
    const transferCalls = laptop.calls.slice(lapCallsBefore).map(call => `${call.method} ${call.route}`);
    const patchAt = transferCalls.indexOf(`PATCH /actors/${actorId}`);
    expect(patchAt).toBeGreaterThan(-1);
    expect(transferCalls.findIndex(call => call.endsWith('/import'))).toBeLessThan(patchAt);
    expect(laptop.runtime.state.isDemoted(BOT)).toBe(true);
    expect(laptop.homes.snapshot().demotedBotIds).toEqual([BOT]);
    await macmini.refresh();
    await waitFor(() => !macmini.runtime.state.isDemoted(BOT), 'macmini auto-materialize');
    await waitFor(() => macmini.rebuilds.length === 1, 'macmini rebuild');
    const macHistory = macmini.visible(macSession);
    const inserted = macHistory.filter(row => row.clientId.startsWith('cloud-history:'));
    // Rows mirrored from here and the delivered room message are recognised; only laptop's are new.
    expect(inserted.map(row => [row.role, JSON.parse(row.content)])).toEqual([
      ['user', { text: 'on laptop', images: [], files: [] }], ['assistant', [{ type: 'text', text: 'laptop reply' }]]]);
    expect(macmini.homes.isHomeHere(BOT)).toBe(true);
    const third = await macmini.runtime.transcript(BOT);
    expect(third.messages.map(m => m.text)).toEqual(['hello', 'hi there', 'from laptop', 'reply to laptop', 'on laptop', 'laptop reply']);

    // 8. Deleting on the current home retires the cloud companion; the other device drops it.
    macmini.profiles.delete(BOT);
    await macmini.runtime.retire(BOT);
    await laptop.refresh();
    expect(laptop.homes.snapshot().actors.some(actor => actor.externalId === BOT)).toBe(false);
    const retired = (await laptop.api<Array<{ id: string; disabled: boolean }>>('/actors')).find(actor => actor.id === actorId);
    expect(retired?.disabled).toBe(true);
    macmini.stop();
    laptop.stop();
  });

  it('lets only one Cindy installation on the same computer run a companion', { timeout: 60_000 }, async () => {
    const bot = `bot_e2e_inst_${randomUUID().slice(0, 8)}`;
    const local = { status: 'active', displayName: 'E2E Twin', description: '', soul: 'twin', user: '', systemPrompt: '' };
    const release = await createDevice('studio', () => [], { installationId: `release-${randomUUID()}` });
    const dev = await createDevice('studio', () => [], { installationId: `dev-${randomUUID()}` });
    release.profiles.set(bot, { ...local });
    dev.profiles.set(bot, { ...local });
    await release.refresh();
    const actorId = release.actor(bot)!.id;
    expect(release.actor(bot)!.homeDeviceId).toBe('studio');
    const installOf = async () => (await release.api<Array<{ key: string; value: { installationId?: string } }>>('/preferences', 'GET', undefined, actorId))
      .find(row => row.key === 'companion.install.v1')?.value.installationId;
    await waitFor(installOf, 'release claims the companion');
    await release.refresh();
    expect(release.runtime.isShadowed(bot)).toBe(false);
    // The second installation shares the device id, so the home matches, but the claim is not its own.
    await dev.refresh();
    await waitFor(() => dev.runtime.isShadowed(bot), 'dev install sees the other claim');
    await dev.refresh();
    expect(dev.homes.isShadowed(bot)).toBe(true);
    const devWritesBefore = dev.calls.filter(call => call.method !== 'GET').length;
    await dev.runtime.syncNow();
    expect(dev.calls.filter(call => call.method !== 'GET').length).toBe(devWritesBefore);
    // Taking over needs the home's profile snapshot; without it the take-over waits.
    expect(await dev.runtime.takeOver(bot)).toEqual({ ok: false, code: 'FAILED' });
    await release.runtime.syncNow();
    // Taking over from the dev installation overwrites the claim.
    expect(await dev.runtime.takeOver(bot)).toEqual({ ok: true });
    expect(dev.runtime.isShadowed(bot)).toBe(false);
    expect(await installOf()).toMatch(/^dev-/);
    release.stop();
    dev.stop();
  });
});
