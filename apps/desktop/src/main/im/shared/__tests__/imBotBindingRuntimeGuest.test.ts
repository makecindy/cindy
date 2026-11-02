/**
 * unit: the IM companion route's guest refusal, through createImCompanionRouteDeps.
 * #8359 review: a bound guest is refused when its engine cannot keep it in the
 * project (Pi, or an engine on another computer). The decision must follow the
 * route the next start will use: a lane whose stored row still names a remote
 * engine must be served once the owner moves the model chain back to this computer.
 * Minimal input: one bound guest lane, stored as remote, previewed as local / remote.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sqlite: null as import('better-sqlite3').Database | null,
  route: null as { agentKind: string; agentDeviceId: string | null } | null,
}));

vi.mock('../../../localDb/client/current', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  return { getDbClient: () => ({ drizzle: drizzle(h.sqlite!) }) };
});
vi.mock('../../../maker-ipc/botWorkspaceRuntime', () => ({
  resolveBotGuestLaneAccess: async () => ({
    kind: 'bound', route: { channel: 'telegram', botContextId: '777', guestId: '555' },
    projectPath: '/work/client-a', memoryScopeKey: 'bot:mimi:guest:telegram:555',
  }),
}));
vi.mock('../../../localDb/ipc/bots', () => ({
  archiveBotChannelLanes: vi.fn(), ensureBotChannelLaneSession: vi.fn(), findBotChannelLaneSession: vi.fn(),
}));
vi.mock('../../../maker-ipc/botCanonicalSessionRegistry', () => ({ resolveBotCanonicalSession: vi.fn() }));
vi.mock('../../../maker-ipc/register', () => ({
  prepareBotSessionForImSend: vi.fn(async () => null),
  previewBotSessionRoute: vi.fn(async () => h.route),
  tryGetBotDelegationService: vi.fn(),
}));

import { createImCompanionRouteDeps } from '../imBotBindingRuntime';

beforeEach(() => {
  h.sqlite = new Database(':memory:');
  h.sqlite.exec(`
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, profile_version INTEGER,
      role TEXT NOT NULL, route_key TEXT, created_at INTEGER, archived_at INTEGER
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_kind TEXT NOT NULL, agent_device_id TEXT);
    INSERT INTO sessions VALUES ('lane', 'claude-code', 'device-2');
    INSERT INTO bot_session_links (id, bot_id, session_id, role, route_key)
      VALUES ('a', 'mimi', 'lane', 'channel', 'im:telegram:777:dm:555');
  `);
});

afterEach(() => h.sqlite?.close());

it('refuses a bound guest by the route its next start will use, not the stored one', async () => {
  const deps = createImCompanionRouteDeps('mimi');
  h.route = { agentKind: 'claude-code', agentDeviceId: null };
  expect(await deps.guestRefused!('lane')).toBe(false);
  h.route = { agentKind: 'codex', agentDeviceId: 'device-3' };
  expect(await deps.guestRefused!('lane')).toBe(true);
  h.route = { agentKind: 'pi', agentDeviceId: null };
  expect(await deps.guestRefused!('lane')).toBe(true);
  // No preview (reconciler not ready): the stored row still decides.
  h.route = null;
  expect(await deps.guestRefused!('lane')).toBe(true);
});
