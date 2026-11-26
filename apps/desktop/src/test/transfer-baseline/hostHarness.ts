/**
 * Controlled-computer side of the transfer baseline.
 *
 * Production pieces in use:
 *  - the real Desktop SQLite schema (full `drizzle/` migration replay) and
 *    `createDbClientForHandle`, so `local-db:*` handlers read real rows;
 *  - `installInvokeCapture` + `registerMessageIpc` / `registerSessionIpc`: the
 *    same `ipcMain.handle` registrations remote invokes are dispatched to;
 *  - `dispatch.desktop` (`createInboundDispatch` with Desktop ports): admission,
 *    subscriptions, history notices / work patches, maker:event batching, mobile
 *    projection, list-message reuse and `invoke-result` transfer encoding;
 *  - `DeviceLinkClient` with `desktopTransferCodec` (gzip + content tags) and the
 *    reliable transport, over a real WebSocket to the loopback relay.
 *
 * Not production: the Electron shell (stubbed by the Desktop vitest config), the
 * `RoutedDeviceLinkClient` direct-path layer (relay only here) and the Agent runtime.
 * Live-turn events are injected at the main-process broadcast boundary
 * (`tapWindowBroadcast`, the call `broadcastToAllWindows` makes) with the payload
 * shape `register.ts` publishes, and persisted rows go through the real
 * `createMessage`, which emits the real `local-db:messages:created` broadcast.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ipcMain } from 'electron';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  DeviceLinkClient,
  PROVIDER_SHARE_RELAY_CAPABILITY,
  SHARED_TASK_CAPABILITY,
  type DeviceLinkTiming,
} from '@cindy/device-link';
import * as schema from '../../main/localDb/schema';
import { messages, sessions, sessionTaskTags, taskTags } from '../../main/localDb/schema';
import { createBetterSqliteDatabase } from '../../main/localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../main/localDb/migrationRunner';
import { configureSqliteVecExtPath, loadSqliteVec } from '../../main/localDb/sqliteVecLoader';
import { createDbClientForHandle } from '../../main/localDb/client/createDbClientForHandle';
import { clearCurrentDbClient, setCurrentDbClient } from '../../main/localDb/client/current';
import { installInvokeCapture } from '../../main/device-link/invoke-registry';
import { registerMessageIpc, createMessage } from '../../main/localDb/ipc/messages';
import { registerSessionIpc } from '../../main/localDb/ipc/sessions';
import * as dispatch from '../../main/device-link/dispatch.desktop';
import { tapWindowBroadcast, captureDataOwnerBroadcastScope } from '../../main/device-link/broadcast-tap';
import { desktopTransferCodec } from '../../main/device-link/transferCodec';
import { writeDeviceLinkSetting } from '../../main/device-link/settings-store.desktop';
import { setControllerPlatform, clearControllerPlatforms } from '../../main/device-link/controllerPlatform';
import { MAKER_PUSH } from '../../main/maker-ipc/channels';
import { setRemoteBotSessionLookup } from '../../main/device-link/remoteBotSessionBoundary';
import { readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch } from '../../main/localDb/ipc/botRemoteSessionAccess';
import type { Message } from '../../renderer/lib/ccAgent.types';
import type { FixtureMessageRow, FixtureSessionRow, FixtureTag } from './fixture';
import { pmdOption, readHarnessSwitches } from './switches';
import type { WireMeter } from './wireMeter';

const desktopRoot = path.resolve(__dirname, '../../..');

/** Heartbeats are periodic, not part of any stage; keep them out of the measured window. */
export const QUIET_TIMING: Partial<DeviceLinkTiming> = { pingIntervalMs: 3_600_000 };

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

let ipcRegistered = false;
const runningSessions = new Set<string>();
const toolNames = new Map<string, string>();

export interface BaselineHost {
  client: DeviceLinkClient;
  deviceId: string;
  /** Mark a task as running/idle for the history projection (`registerMessageIpc` running reader). */
  setRunning(sessionId: string, running: boolean): void;
  /** Main-process broadcast boundary, as `broadcastToAllWindows` taps it. */
  broadcast(channel: string, payload: unknown): void;
  makerEvent(sessionId: string, event: { type: string; data: unknown }, persistId?: string): void;
  /** Persist through the real `createMessage` (emits `local-db:messages:created`). */
  persist(sessionId: string, row: Omit<FixtureMessageRow, 'id' | 'sessionId'>): Promise<Message>;
  patchSession(sessionId: string, patch: Record<string, unknown>): void;
  noteToolName(toolUseId: string, toolName: string): void;
  /** How many times this host has seen a controller's presence go offline (`online === false`). */
  peerOfflineCount(deviceId: string): number;
  close(): Promise<void>;
}

async function openFixtureDatabase(dir: string, fixture: { sessions: FixtureSessionRow[]; messages: FixtureMessageRow[]; tags?: FixtureTag[] }) {
  const db = createBetterSqliteDatabase(path.join(dir, 'baseline.db'));
  // The migration chain creates vec0 tables; load the bundled extension through the
  // same loader the DB worker uses (file names as in sqliteVecLoader.ts libFilename).
  const vecFile = process.platform === 'win32' ? 'vec0.dll' : process.platform === 'linux' ? 'vec0.so' : 'vec0.dylib';
  configureSqliteVecExtPath(path.join(desktopRoot, 'native', 'sqlite-vec', `${process.platform}-${process.arch}`, vecFile));
  const vec = loadSqliteVec(db);
  if (!vec.loaded) {
    db.close();
    throw new Error(`sqlite-vec could not be loaded: ${vec.error ?? 'unknown error'}`);
  }
  runMigrationReplay(db, { drizzleDir: path.join(desktopRoot, 'drizzle') });
  const orm = drizzle(db, { schema });
  for (const row of fixture.sessions) {
    await orm.insert(sessions).values({
      id: row.id,
      title: row.title,
      workingDir: '/workspace/demo',
      workspaceKind: 'project',
      agentKind: 'cc',
      model: 'claude-sonnet-5',
      effort: 'medium',
      permissionMode: 'default',
      status: 'active',
      source: 'desktop',
      listPreview: row.preview,
      listPreviewRole: 'assistant',
      listMessageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      // Realistic-row mode (TRANSFER_BASELINE_REALISTIC_ROWS) fills the remaining columns.
      ...row.columns,
    } as typeof sessions.$inferInsert);
  }
  if (fixture.tags?.length) await orm.insert(taskTags).values(fixture.tags);
  const links = fixture.sessions.flatMap((row) => (row.tagIds ?? []).map((tagId) => ({ sessionId: row.id, tagId })));
  if (links.length) await orm.insert(sessionTaskTags).values(links);
  for (let offset = 0; offset < fixture.messages.length; offset += 200) {
    await orm.insert(messages).values(fixture.messages.slice(offset, offset + 200).map((row) => ({
      id: row.id,
      clientId: row.clientId,
      sessionId: row.sessionId,
      role: row.role,
      content: JSON.stringify(row.content),
      toolUseId: row.toolUseId,
      ...(row.agentMeta ? { agentMeta: JSON.stringify(row.agentMeta) } : {}),
      createdAt: row.createdAt,
    }) as typeof messages.$inferInsert));
  }
  return { db, orm };
}

/**
 * Small reads the controllers issue alongside history whose real handlers live in the
 * Maker runtime / settings modules (not assembled here). They answer with the empty
 * value an idle fixture host would return, so request counts and envelope overhead
 * stay real while their (tiny) bodies are fixtures. Reported as `stub` channels.
 */
export const STUB_CHANNELS: Record<string, (...args: unknown[]) => unknown> = {
  'maker:get-pending-interactions': () => [],
  'maker:input:get-projection': (_event, sessionId) => ({ sessionId, queue: [], queuePaused: false }),
  'maker:list-active': () => ({ snapshotVersion: 2, sessions: [] }),
  'maker:goal:get-status': () => null,
  'sidebar-settings:get-project-aliases': () => ({}),
  'local-db:history:query': () => ({ sessions: [], nextCursor: null }),
  'maker:schedule:list-sidebar-index-runs': () => [],
  'maker:schedule:list': () => [],
};

function registerStubHandlers(): void {
  for (const [channel, handler] of Object.entries(STUB_CHANNELS)) ipcMain.handle(channel, handler as never);
}

export async function startBaselineHost(options: {
  wsUrl: string;
  deviceId: string;
  credential: string;
  meter: WireMeter;
  fixture: { sessions: FixtureSessionRow[]; messages: FixtureMessageRow[]; tags?: FixtureTag[] };
}): Promise<BaselineHost> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-transfer-baseline-host-'));
  let opened: Awaited<ReturnType<typeof openFixtureDatabase>>;
  try {
    opened = await openFixtureDatabase(dir, options.fixture);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const { db, orm } = opened;
  const dbClient = createDbClientForHandle({ db, drizzle: orm });
  setCurrentDbClient(dbClient, 'transfer-baseline-user');
  if (!ipcRegistered) {
    ipcRegistered = true;
    installInvokeCapture();
    registerMessageIpc((sessionId) => runningSessions.has(sessionId), () => []);
    registerSessionIpc();
    registerStubHandlers();
    dispatch.setHistoryToolNameReader((_sessionId, toolUseId) => toolNames.get(toolUseId) ?? '');
  }
  // Same lookup the Node host assembles (apps/host/src/device-link.ts); Desktop bootstrap wires the equivalent.
  setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
  await writeDeviceLinkSetting('remoteControlEnabled', true);
  const client = new DeviceLinkClient({
    getWsUrl: () => options.wsUrl,
    getToken: async () => options.credential,
    authorizationScheme: 'CindyRelay',
    getHello: () => ({
      capabilities: [SHARED_TASK_CAPABILITY, PROVIDER_SHARE_RELAY_CAPABILITY],
      deviceName: 'Baseline host',
      platform: 'darwin',
      appVersion: '0.0.0-baseline',
      remoteControlEnabled: true,
      busy: false,
    }),
    // Same options as apps/desktop/src/main/device-link/index.ts connectionOptions.
    transferCodec: desktopTransferCodec,
    peerResetReadRetry: true,
    timing: QUIET_TIMING,
    logger: quietLogger,
    createWebSocket: (url, headers) => options.meter.tap(
      new WebSocket(url, { headers, ...pmdOption(readHarnessSwitches().pmdHost) }), 'host'),
  });
  const unbind = dispatch.wireInboundDispatch(client);
  const offStatus = client.onStatusChange((status) => {
    if (status !== 'online') {
      dispatch.deactivateAllControllers('relay-disconnected');
      clearControllerPlatforms();
    } else {
      dispatch.flushMakerEventBatchesOnReconnect();
      dispatch.flushRemoteInvokeResultOutboxOnReconnect();
    }
  });
  const offlineEvents = new Map<string, number>();
  const offPresence = client.onPresenceChanged((presence) => {
    // Same reading as the client: only an explicit `online: false` is a departure.
    if (presence.online === false) offlineEvents.set(presence.deviceId, (offlineEvents.get(presence.deviceId) ?? 0) + 1);
    if (presence.online) {
      setControllerPlatform(presence.deviceId, presence.platform ?? null);
      if (presence.deviceName) dispatch.setControllerDisplayName(presence.deviceId, presence.deviceName);
    } else {
      setControllerPlatform(presence.deviceId, null);
      dispatch.handleControllerOffline(presence.deviceId);
    }
  });
  client.start();
  const broadcast = (channel: string, payload: unknown) => {
    const scope = captureDataOwnerBroadcastScope();
    tapWindowBroadcast(channel, payload, scope.ownerStamp);
  };
  return {
    client,
    deviceId: options.deviceId,
    setRunning(sessionId, running) {
      if (running) runningSessions.add(sessionId);
      else runningSessions.delete(sessionId);
    },
    broadcast,
    makerEvent(sessionId, event, persistId) {
      broadcast(MAKER_PUSH.EVENT, { sessionId, event, ...(persistId ? { persistId } : {}) });
    },
    async persist(sessionId, row) {
      return createMessage(sessionId, {
        clientId: row.clientId,
        role: row.role,
        content: row.content,
        ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
        ...(row.agentMeta ? { agentMeta: row.agentMeta as never } : {}),
        agentKind: 'cc',
        createdAt: row.createdAt,
      });
    },
    patchSession(sessionId, patch) {
      broadcast('local-db:sessions:patched', { sessionId, patch });
    },
    noteToolName(toolUseId, toolName) {
      toolNames.set(toolUseId, toolName);
    },
    peerOfflineCount: (deviceId) => offlineEvents.get(deviceId) ?? 0,
    async close() {
      offStatus();
      offPresence();
      unbind();
      dispatch.dropAllControllers(client, 'shutdown');
      client.stop();
      dispatch.__testing.reset();
      runningSessions.clear();
      toolNames.clear();
      clearCurrentDbClient(dbClient);
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
