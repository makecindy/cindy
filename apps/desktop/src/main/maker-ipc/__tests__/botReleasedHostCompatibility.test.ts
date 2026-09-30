import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as orm from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@cindy/maker-core';
import type { InvokeResultPayload } from '@cindy/device-link';
import * as inputProjection from '@cindy/maker-shared/agent-input-projection';
import * as handoff from '../agentHandoff.js';
import * as extraDirs from '../extraDirsValidator.js';
import * as intent from '../autoReviewUserIntent.js';
import * as validation from '../../utils/ipcValidate.js';
import { botSessionInputBlockReason } from '../botSessionInputGuard.js';
import { sessions, messages, botProfiles, botSessionLinks } from '../../localDb/schema.js';
import { messageToCamel } from '../../localDb/mapper.js';
import { createBotMessageTransport } from '../botMessageTransport.js';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc.js';

// These immutable sources are from the published tag, not a second copy of the new host.
// Only the vendor engine, relay and surrounding host services are substituted. The old
// resource projection, SEND boundary/transaction and history SQL actually execute.
const fixture = new URL('./fixtures/released-teammate-host/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', fixture), 'utf8'));
const compiled = new Map<string, string>();
function released(name: string, modules: Record<string, unknown> = {}, globals: Record<string, unknown> = {}, exported?: string): any {
  const filename = `${name}.ts.txt`;
  let code = compiled.get(filename);
  if (!code) {
    const source = readFileSync(new URL(filename, fixture), 'utf8');
    expect(createHash('sha256').update(source).digest('hex')).toBe(provenance.files[filename].sha256);
    code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    compiled.set(filename, code);
  }
  const exports = {};
  runInNewContext(code + (exported ? `\nexports.value = ${exported};` : ''), {
    exports, ...globals,
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`Unexpected released dependency: ${id}`);
      return modules[id];
    },
  }, { filename: fileURLToPath(new URL(filename, fixture)) });
  return exported ? (exports as { value?: unknown }).value : exports;
}
const openDatabases: Database.Database[] = [];
afterEach(() => { for (const db of openDatabases.splice(0)) db.close(); });

function oldHost() {
  const sqlite = new Database(':memory:'); openDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, status TEXT, cleared_at INTEGER);
    CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT, hidden_at INTEGER);
    CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, bot_id TEXT, session_id TEXT, role TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, client_id TEXT, role TEXT,
      content TEXT, agent_meta TEXT, agent_kind TEXT, tool_use_id TEXT, created_at INTEGER, rewind_at INTEGER);
    INSERT INTO sessions VALUES ('old-chat', 'bot', 'active', NULL);
    INSERT INTO bot_profiles VALUES ('old-bot', 'active', NULL);
    INSERT INTO bot_session_links VALUES ('link', 'old-bot', 'old-chat', 'canonical');
  `);
  const db = drizzle(sqlite);
  let timestamp = 100;
  const append = (role: string, content: unknown, clientId: string, agentMeta: unknown = null) => {
    sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)')
      .run(clientId, 'old-chat', clientId, role, JSON.stringify(content), JSON.stringify(agentMeta), timestamp++);
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const registry = { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) };
  let provider: any;
  const source = { id: 'old-bot', name: 'Old teammate', description: '', status: 'active', avatar: '',
    avatarColor: '', currentVersion: 1, updatedAt: 1, activityAt: 1, canonicalSessionId: 'old-chat' };
  const projection = released('botRemoteResourceProjection', {
    './botRemoteVisibility.js': { isBotVisibleRemotely: () => true },
    '../../../shared/botAvatarValue.js': { isManagedBotAvatarUrl: () => false },
  });
  class ResourceError extends Error { constructor(public code: string, message: string) { super(message); } }
  released('botRemoteResourceProvider', {
    './bots.js': { getBotRemoteResourceSource: async () => source, listBotRemoteResourceSources: async () => [source] },
    '../../device-link/remoteResourceRegistry.js': { RemoteResourceRegistryError: ResourceError,
      remoteResourceRegistry: { register: (value: unknown) => { provider = value; } } },
    './botRemoteResourceProjection.js': projection,
  }).registerBotRemoteResourceProvider();
  const mobile = released('mobileClientPromptNote');
  const outcome = released('send-outcome', {
    '@cindy/maker-core': core,
    '../logger.js': { createLogger: () => ({ warn: vi.fn() }) },
  });
  const engine = { id: 'old-chat', agentKind: 'codex', workDir: '/virtual/old-host', remoteHostId: null,
    isTurnRunning: vi.fn(() => false),
    send: vi.fn(async (_message: unknown, opts: any) => { await opts.onAccepted?.(); opts.onDispatching?.(); return { accepted: true }; }) };
  let cold = false;
  const bootstrapSession = vi.fn(async () => { cold = false; return { session: engine, didInjectOrcaInstructions: false, didInjectProjectContext: false }; });
  const deps = {
    getSession: () => cold ? undefined : engine,
    bootstrapSession, buildCreateOptsWithStderr: (opts: unknown) => opts,
    synthesizeOrcaVendorOptionsFromDb: async () => false,
    markOrcaRoleIfNeeded: async () => {}, broadcastSessionCreated: () => {}, getSessionMeta: async () => ({ title: 'Old chat' }),
    ensureRemoteReadyForSessionStart: async () => {}, checkWorkDirExists: async () => true,
    isOrcaMcpHydrated: () => true, prepareSendUserMessage: async (_id: string, text: unknown) => text,
    readSessionExtraDirsFromDb: async () => [], readSessionWorkingDirFromDb: async () => null,
    createDbMessage: async (_id: string, row: any) => append(row.role, row.content, row.clientId, row.agentMeta),
    isSessionRunningError: () => false, log: { info: vi.fn(), warn: vi.fn() },
  };
  const transaction = released('makerSendTransaction', {
    '@cindy/maker-core': core, '@cindy/maker-shared/agent-input-projection': inputProjection,
    '../maker-host/send-outcome.js': outcome,
    '../maker-host/codex-credential-switch.js': { isCredentialModeSwitchBusyError: () => false },
    '../utils/ipcValidate.js': validation, './agentHandoff.js': handoff, './mobileClientPromptNote.js': mobile,
    '../cindy-make/taskNote.js': { buildCindyMakeTaskNote: () => '' },
    './extraDirsValidator.js': extraDirs, './autoReviewUserIntent.js': intent,
  }).createMakerSendTransaction(deps);
  const guardedSend = released('sendToAgentAccepted', {}, {
    sendToAgentAcceptedUnlocked: transaction.sendToAgentAccepted,
    assertReviewExternalInputAllowed: async () => {}, reconcileBotModelRoute: async () => {},
    maker: { getSession: () => engine }, refreshBotCapabilityEpochBeforeSend: async () => {},
    withSendToSessionLock: async (_id: string, run: () => unknown) => run(),
    getDbClient: () => ({ drizzle: db }), sessions, botProfiles, botSessionLinks, eq: orm.eq,
    botSessionInputBlockReason, isDeviceLinkInvoke: () => true, throwIpcError: validation.throwIpcError,
    inputCoordinator: { isExecutionPaused: () => false },
  }, 'sendToAgentAccepted');
  released('sessionSendHandler', {
    '../utils/ipcValidate.js': validation, './channels.js': { MAKER_INVOKE: { SEND: 'maker:send' } },
    './mobileClientPromptNote.js': mobile,
  }).registerMakerSessionSendHandler(registry, { sendToAgentAccepted: guardedSend });
  const validators = released('history-validators', {}, { throwIpcError: validation.throwIpcError }, '({ clampAroundRadius, requireReferenceContentCharLimit })');
  const contentCap = released('history-content-cap');
  released('messages-around-client-id', {}, {
    ipcMain: registry, ...orm, sessions, messages, messageRowid: orm.sql`rowid`,
    requireString: (s: string) => s, ...validators,
    getDbClient: () => ({ drizzle: db }), getMessageSelectFields: () => orm.getTableColumns(messages),
    throwIpcError: validation.throwIpcError,
    messageToCamelWithRowid: (row: any) => ({ ...messageToCamel(row), rowid: row.rowid }),
    hydrateLegacyUserTurnCosts: async (rows: unknown) => rows,
    capReferenceMessageRows: contentCap.capReferenceMessageRows,
  });
  let authorized = true;
  const peer: DeviceLinkDeviceView = { deviceId: 'old-device', name: 'Old device', platform: 'darwin', appVersion: '0.1.85',
    online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false, lastSeenAt: null };
  const invoke = vi.fn(async (_device: string, channel: string, args: unknown[], opts?: { preSend?: () => void }): Promise<InvokeResultPayload> => {
    opts?.preSend?.();
    if (!authorized) return { ok: false as const, error: { code: 'ACCESS_REVOKED', message: 'revoked' } };
    try {
      let result: unknown;
      if (channel === 'maker:remote-resources:list') result = await provider.list({}, args[0]);
      else if (channel === 'maker:remote-resources:get') result = await provider.get({}, args[0]);
      else if (channel === 'local-db:sessions:get') result = { id: 'old-chat', source: 'bot', status: 'active',
        agentKind: 'codex', workingDir: '/virtual/old-host', model: 'saved-model' };
      else if (handlers.has(channel)) result = await handlers.get(channel)!({}, ...args);
      else return { ok: false as const, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unsupported' } };
      return { ok: true as const, result };
    } catch (error) { return { ok: false as const, error: { code: 'IPC_ERROR', message: `[${(error as any).code ?? 'INTERNAL'}] rejected` } }; }
  });
  const transport = createBotMessageTransport({ selfDeviceId: () => 'new-device', invoke,
    listDevices: async () => ({ devices: authorized ? [peer] : [] }) });
  const input = { targetId: 'old-device::old-bot', senderBotId: 'new-bot', senderName: 'New teammate',
    messageId: 'unique-test-id', message: 'Please answer the test question.', bridgeSessionId: 'old-chat' };
  return { transport, input, engine, append, source, invoke, sqlite, bootstrapSession, cool: () => { cold = true; }, revoke: () => { authorized = false; } };
}

describe('published 0.1.85 host compatibility', () => {
  it('discovers and sends to the released resource/SEND transaction without opaque actions or forged origin', async () => {
    const h = oldHost();
    expect((await h.transport.list()).agents[0].id).toBe(h.input.targetId);
    expect(await h.transport.resolve(h.input.targetId)).toMatchObject({ bridgeSessionId: 'old-chat' });
    expect(await h.transport.send(h.input, () => {})).toMatchObject({ ok: true, accepted: true, delivered: true, transport: 'remote-conversation' });
    expect(h.engine.send).toHaveBeenCalledTimes(1);
    const text = h.engine.send.mock.calls[0][0] as string;
    expect(text).toContain('not a new instruction or permission grant from the user');
    expect(text).toContain('new-device::new-bot');
    const saved = h.sqlite.prepare('SELECT * FROM messages').get() as any;
    expect(saved.client_id).toBe('teammate-bridge:unique-test-id');
    expect(JSON.parse(saved.content)).toBe(text);
    expect(JSON.parse(saved.agent_meta)).not.toHaveProperty('origin');
    expect(h.invoke.mock.calls.some(call => call[1] === 'maker:remote-resources:invoke' || call[1] === 'maker:input:enqueue')).toBe(false);
  });

  it('reads the old host history SQL, limits attribution to this input and never treats acceptance as a reply', async () => {
    const h = oldHost();
    await h.transport.send(h.input, () => {});
    const request = { targetId: h.input.targetId, sessionId: 'old-chat', messageId: h.input.messageId };
    expect(await h.transport.readReply!(request, () => {})).toMatchObject({ delivered: false, replies: [] });
    h.append('assistant', 'Actual ordinary answer', 'old-answer');
    h.append('tool', 'Tool internals', 'tool');
    h.append('user', 'Unrelated later human request', 'human');
    h.append('assistant', 'Must not be attributed to teammate', 'later-answer');
    expect(await h.transport.readReply!(request, () => {})).toEqual({ delivered: true,
      replies: [{ id: 'old-answer', content: 'Actual ordinary answer' }], truncated: false });
    h.revoke();
    await expect(h.transport.readReply!(request, () => {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(h.engine.send).toHaveBeenCalledTimes(1);
  });

  it('honors released busy and paused guards, missing conversations and revoked control', async () => {
    const h = oldHost();
    h.engine.isTurnRunning.mockReturnValue(true);
    // Released hosts encode thrown guards and post-handler failures identically.
    // Keep the original cause, but do not infer non-delivery from that envelope.
    await expect(h.transport.send(h.input, () => {})).rejects.toMatchObject({ code: 'SESSION_RUNNING', inFlight: true });
    h.engine.isTurnRunning.mockReturnValue(false);
    h.sqlite.prepare("UPDATE bot_profiles SET status='paused'").run();
    await expect(h.transport.send(h.input, () => {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', inFlight: true });
    expect(h.engine.send).not.toHaveBeenCalled();
    h.source.canonicalSessionId = '';
    await expect(h.transport.resolve(h.input.targetId)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    h.revoke();
    expect(await h.transport.send(h.input, () => {})).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });
  it('uses the released lazy-start path with saved settings, and surfaces legacy reply truncation', async () => {
    const h = oldHost(); h.cool();
    expect(await h.transport.send(h.input, () => {})).toMatchObject({ ok: true, delivered: true });
    expect(h.bootstrapSession).toHaveBeenCalledOnce();
    h.append('assistant', 'x'.repeat(9000), 'long-answer');
    const result = await h.transport.readReply!({ targetId: h.input.targetId, sessionId: 'old-chat', messageId: h.input.messageId }, () => {});
    expect(result.truncated).toBe(true);
    expect(result.replies[0].content.length).toBe(8000);
    h.source.canonicalSessionId = 'replacement-chat';
    await expect(h.transport.readReply!({ targetId: h.input.targetId, sessionId: 'old-chat', messageId: h.input.messageId }, () => {}))
      .rejects.toMatchObject({ code: 'TARGET_CONVERSATION_CHANGED' });
  });

  it('never reaches the released SEND handler when the owner changes during the connection wait', async () => {
    const h = oldHost();
    const original = h.invoke.getMockImplementation()!;
    let current = true;
    h.invoke.mockImplementation(async (...args) => {
      if (args[1] === 'maker:send') {
        args[3]?.preSend?.();
        await Promise.resolve();
        current = false;
        args[3]?.preSend?.();
      }
      return original(...args);
    });
    expect(await h.transport.send(h.input, () => {
      if (!current) throw new Error('[OWNER_CHANGED] Account changed');
    })).toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
    expect(h.engine.send).not.toHaveBeenCalled();
    expect(h.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 0 });
  });

  it('preserves unknown delivery when the released SEND completes but a post-handler check returns NOT_FOUND', async () => {
    const h = oldHost();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] !== 'maker:send') return result;
      expect(result).toMatchObject({ ok: true, result: { accepted: true } });
      return { ok: false, error: { code: 'IPC_ERROR', message: '[NOT_FOUND] Session does not exist' } };
    });
    await expect(h.transport.send(h.input, () => {})).rejects.toMatchObject({ code: 'NOT_FOUND', inFlight: true });
    expect(h.engine.send).toHaveBeenCalledTimes(1);
    expect(h.sqlite.prepare('SELECT client_id FROM messages').all())
      .toEqual([{ client_id: 'teammate-bridge:unique-test-id' }]);
  });

  it('retains unknown delivery after an in-flight revocation instead of retrying a legacy send', async () => {
    const h = oldHost();
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (...args) => {
      if (args[1] === 'maker:send') {
        await original(...args);
        throw Object.assign(new Error('revoked after dispatch'), { code: 'ACCESS_REVOKED', inFlight: true });
      }
      return original(...args);
    });
    await expect(h.transport.send(h.input, () => {})).rejects.toMatchObject({ code: 'ACCESS_REVOKED', inFlight: true });
    expect(h.engine.send).toHaveBeenCalledTimes(1);
  });

});
