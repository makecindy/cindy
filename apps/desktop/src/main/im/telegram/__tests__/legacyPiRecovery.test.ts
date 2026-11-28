import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, expect, it, vi } from 'vitest';
import { Maker, type AgentEvent, type AgentSessionHandle, type BaseAgent, type SessionStorage } from '@cindy/maker-core';
import type { IMMessageEvent, InteractiveCardSpec, TelegramIM } from '@cindy/im';
import type { ProviderView } from '@cindy/model-providers';

import { clearModelVisibilityMirror, setModelVisibilityMirror } from '../../../maker-host/model-visibility-mirror';
import { setMainLocale } from '../../../i18n.desktop';
import { createDbClientForHandle } from '../../../localDb/client/createDbClientForHandle';
import { clearCurrentDbClient, setCurrentDbClient } from '../../../localDb/client/current';
import { setSessionOpeningModelAdmission } from '../../../localDb/sessionOpening';
import * as schema from '../../../localDb/schema';
import { configureUserDataDir, getUserDataDir } from '../../../userDataPath';
import { IM_DEFAULT_SETTINGS } from '../../../../shared/imDefaultSettings';
import { wireTelegramOrchestrator } from '..';
import { ownerScopedImUserDataPath } from '../../ownerScopedStorage';

const mocks = vi.hoisted(() => ({ getMaker: vi.fn(), listProviders: vi.fn() }));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  maskPath: (value: string) => value,
}));
vi.mock('../../../maker-host', () => ({ getMaker: mocks.getMaker }));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: mocks.listProviders }),
}));
vi.mock('../../../maker-host/provider-route', () => ({ hasCustomProviderKey: () => false }));
vi.mock('../../shared/apiKey', () => ({ readXdGatewayApiKey: () => null }));
vi.mock('../../defaultSettingsStore', () => ({
  readImDefaultSettings: () => ({
    ...IM_DEFAULT_SETTINGS,
    agentKind: 'pi',
    agents: { ...IM_DEFAULT_SETTINGS.agents, pi: {
      ...IM_DEFAULT_SETTINGS.agents.pi, model: 'fixture-current', providerId: 'fixture-byom',
    } },
  }),
}));
vi.mock('../../../maker-ipc/register', () => ({
  registerSwitchedSessionVendorOptionsResolver: () => () => {},
  acquirePendingAgentSwitchForImSend: async (_id: string, sync: () => Promise<boolean>) => {
    await sync();
    return () => {};
  },
  prepareUnhealthySessionForSend: async () => {},
  wireSessionToIpcExternal: () => {},
  beginTurnChangeSetAtDispatch: async () => {},
  noteSilentStopUserSend: () => {},
  noteSilentStopSessionReset: () => {},
}));
vi.mock('../../messagePersistence', () => ({ persistUserMessage: async () => {} }));
vi.mock('../../shared/cardActionHandler', () => ({ createCardActionHandler: () => () => {} }));
vi.mock('../../shared/ambientReplyJudgeRuntime', () => ({ getAmbientReplyJudge: () => undefined }));
vi.mock('../../../goal-host/inactiveNote', () => ({ peekGoalInactiveNote: async () => null }));
vi.mock('../../../localDb/ipc/messages', () => ({ listMessagesForAgentHandoff: async () => [] }));

const provider: ProviderView = {
  id: 'fixture-byom',
  name: 'Fixture BYOM',
  source: 'user',
  connected: true,
  agents: ['pi'],
  auth: { method: 'apiKey' },
  routing: { pi: { upstream: 'https://example.invalid', authStrategy: 'none' } },
  models: { pi: [{
    id: 'fixture-current', name: 'Current model', contextWindow: 128_000,
    efforts: ['high'], defaultEffort: 'high',
  }] },
};

function createTable(sqlite: Database.Database, table: SQLiteTable): void {
  const { name, columns, indexes, primaryKeys } = getTableConfig(table);
  const definitions = columns.map((col) => {
    const parts = [`"${col.name}"`, col.getSQLType()];
    if (col.primary) parts.push('PRIMARY KEY');
    if (col.notNull) parts.push('NOT NULL');
    if (col.default !== undefined && typeof col.default !== 'object') {
      parts.push(`DEFAULT ${typeof col.default === 'string' ? `'${col.default}'` : Number(col.default)}`);
    }
    return parts.join(' ');
  });
  for (const key of primaryKeys) definitions.push(`PRIMARY KEY (${key.columns.map(col => col.name).join(', ')})`);
  sqlite.exec(`CREATE TABLE "${name}" (${definitions.join(', ')})`);
  for (const { config } of indexes) {
    if (config.unique && config.columns.every(col => 'name' in col)) {
      sqlite.exec(`CREATE UNIQUE INDEX "${config.name}" ON "${name}" (${config.columns.map(col => 'name' in col && col.name).join(', ')})`);
    }
  }
}

afterEach(() => setMainLocale('en'));

// #2141. The auth unit tests stop at a verdict and the slash tests use a fake
// repository. This unit-tier fixture trips the real Telegram inbound refusal
// with one legacy model ID, then sends the recovery command through the same
// entry point and checks the real SQLite rotation and subsequent dispatch.
it('tells a legacy Telegram Pi task how to start a new context after a route mismatch', async () => {
  setMainLocale('en');
  const previousUserData = getUserDataDir();
  const userData = mkdtempSync(path.join(tmpdir(), 'cindy-telegram-route-'));
  configureUserDataDir(userData);
  const sqlite = new Database(':memory:');
  for (const table of [schema.sessions, schema.imBindings, schema.sharedTaskEvents]) createTable(sqlite, table);
  const db = drizzle(sqlite, { schema });
  const client = createDbClientForHandle({ db: sqlite, drizzle: db });
  setCurrentDbClient(client, 'fixture-owner');
  const workingDir = ownerScopedImUserDataPath('im-working-dir', 'telegram-fixture');
  const legacy = {
    id: 'telegram_fixture_101', source: 'telegram', imBotContextId: 'fixture', imUserId: '101',
    model: 'fixture-retired', providerId: provider.id, agentKind: 'pi', sdkSessionId: 'fixture-old-context',
    permissionMode: 'ask', workingDir, workspaceKind: 'dialogue', createdAt: 1, updatedAt: 1,
  } as const;
  db.insert(schema.sessions).values({ ...legacy, model: 'fixture-current' }).run();
  setModelVisibilityMirror({});
  setSessionOpeningModelAdmission(async body => {
    expect(body).toMatchObject({ model: 'fixture-current', providerId: provider.id, agentKind: 'pi' });
    return body;
  });
  mocks.listProviders.mockResolvedValue([provider]);

  const delivered = vi.fn(async (_userId: string, _text: string) => ({ messageId: 'outbound-message' }));
  const sendInteractiveCard = vi.fn(async (_userId: string, _card: InteractiveCardSpec) => ({ messageId: 'card' }));
  const modelCalls = vi.fn(async () => {});
  const startSession = vi.fn(async (options: { model: string }) => {
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    return {
      id: 'fixture-runtime', agentKind: 'pi', model: options.model,
      send: modelCalls, abort: async () => {}, close: async () => { stop(); }, isTurnRunning: () => false,
      setInteractionResolver() {},
      async *events() { await stopped; yield* [] as AgentEvent[]; },
    } as unknown as AgentSessionHandle;
  });
  const storage = {
    get: async () => null,
    create: async (meta: object) => ({ ...meta, createdAt: 1, updatedAt: 1 }),
    update: async () => {}, list: async () => [], delete: async () => {},
  } as unknown as SessionStorage;
  const logger = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; },
  };
  const maker = new Maker({
    agents: { pi: {
      kind: 'pi', startSession, get capabilities() { return { availableModels: provider.models.pi }; },
    } as unknown as BaseAgent },
    storage, logger,
  });
  mocks.getMaker.mockReturnValue(maker);

  let inbound!: (event: IMMessageEvent) => Promise<unknown>;
  const transport = {
    getOwnerUserId: () => '101',
    onMessage(handler: typeof inbound) { inbound = handler; return () => {}; },
    onCardAction: () => () => {},
    onGroupWindowMessage: () => () => {},
    sendInteractiveCard,
    sendText: delivered,
    sendMarkdownText: delivered,
  } as unknown as TelegramIM;
  const orchestrator = wireTelegramOrchestrator(transport, {
    agentKind: 'pi', defaultModel: 'fixture-current', defaultPermissionMode: 'ask', effortOverrides: {},
  }, { sessionAuthIpc: false });
  let seq = 0;
  const send = (senderId: string, text: string) => inbound({
    channelName: 'telegram', senderId, chatId: senderId, contextId: 'fixture',
    messageId: `${senderId}|${++seq}`, text, attachments: [], unsupported: [],
  });

  try {
    await send('101', 'ordinary message');
    expect(modelCalls, JSON.stringify(delivered.mock.calls)).toHaveBeenCalledOnce();
    expect(startSession).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'fixture-current', providerId: provider.id, resumeSessionId: legacy.sdkSessionId,
    }));

    await orchestrator.turnRunner.disposeOneSession(legacy.id);
    db.update(schema.sessions).set({ model: legacy.model })
      .where(eq(schema.sessions.id, legacy.id)).run();
    delivered.mockClear();
    await send('101', 'message in the old context');
    expect(startSession).toHaveBeenCalledOnce();
    expect(delivered).toHaveBeenCalledOnce();
    const receipt = delivered.mock.calls[0]?.[1];
    expect(receipt).toEqual(expect.stringContaining(legacy.model));
    expect(db.select().from(schema.sessions).all().find(row => row.id === legacy.id)).toMatchObject({
      model: legacy.model, providerId: legacy.providerId, sdkSessionId: legacy.sdkSessionId,
      permissionMode: legacy.permissionMode, status: 'active',
    });

    await send('101', '/model');
    expect(sendInteractiveCard).toHaveBeenCalledOnce();
    expect(JSON.stringify(sendInteractiveCard.mock.calls[0]?.[1])).toContain('Current model');

    delivered.mockClear();
    await send('101', '/new');
    expect(delivered.mock.calls[0]?.slice(0, 2)).toEqual(['101', expect.stringContaining('New session created')]);
    const rows = db.select().from(schema.sessions).all();
    expect(rows.find(row => row.id === legacy.id)).toMatchObject({
      status: 'archived', model: legacy.model, providerId: legacy.providerId, sdkSessionId: legacy.sdkSessionId,
    });
    const fresh = rows.find(row => row.imUserId === '101' && row.status === 'active');
    expect(fresh).toMatchObject({ model: 'fixture-current', providerId: provider.id, sdkSessionId: null });
    expect(startSession).toHaveBeenCalledOnce();

    await send('101', 'message in the new context');
    expect(modelCalls).toHaveBeenCalledTimes(2);
    expect(startSession).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: fresh?.id, model: 'fixture-current', providerId: provider.id,
    }));
    expect(startSession.mock.lastCall?.[0]).not.toHaveProperty('resumeSessionId', legacy.sdkSessionId);
    expect(receipt).toEqual(expect.stringMatching(/send .*\/new.*new context/i));
    expect(receipt).toContain('doesn’t offer this task’s model');
  } finally {
    await orchestrator.disposeAllSessions();
    orchestrator.unregister();
    clearModelVisibilityMirror();
    clearCurrentDbClient(client);
    sqlite.close();
    configureUserDataDir(previousUserData);
    rmSync(userData, { recursive: true, force: true });
  }
});
