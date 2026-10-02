import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { createBotToolCallAuthorizer, resolveBotCallerAuthority } from '../botToolCallAuthorizer.js';
import {
  decideBotToolCall,
  resolveBotTurnAuthority,
  type BotTurnAuthority,
  type BotTurnExecution,
} from '../botTurnAuthority.js';

const OWNER_INPUT: BotTurnExecution = {
  executing: true,
  input: { clientId: 'owner-msg', authoredText: '帮我把旧任务都归档' },
};
const input = (clientId: string, originKind?: string): BotTurnExecution => ({
  executing: true,
  input: { clientId, ...(originKind ? { originKind } : {}) },
});

describe('decideBotToolCall', () => {
  it('lets the owner own turn use everything, including tools not registered here', () => {
    for (const [server, tool] of [
      ['cindy_helper', 'archive_sessions'],
      ['cindy_helper', 'some_future_tool'],
      ['cindy_scheduler', 'schedule_create'],
    ] as const) {
      expect(decideBotToolCall(server, tool, {}, 'owner')).toEqual({ kind: 'allow' });
    }
  });

  it.each<[string, BotTurnAuthority]>([
    ['start_session_task', 'other'],
    ['send_to_agent', 'other'],
    ['list_sessions', 'other'],
    ['search_chat_history', 'other'],
    ['routine_history', 'other'],
    ['get_workbench', 'arranged'],
    ['continue_workbench_task', 'arranged'],
    ['create_project', 'arranged'],
    ['routine_save', 'arranged'],
    ['find_teammate_capabilities', 'other'],
  ])('allows %s in a %s turn', (tool, authority) => {
    expect(decideBotToolCall('cindy_helper', tool, {}, authority)).toEqual({ kind: 'allow' });
  });

  it.each<[string, BotTurnAuthority]>([
    ['add_task_tags', 'arranged'],
    ['set_app_default_model', 'arranged'],
    ['add_workbench_project', 'arranged'],
    ['remove_workbench_project', 'arranged'],
    ['move_session', 'arranged'],
    ['some_future_tool', 'arranged'],
    ['get_workbench', 'other'],
    ['continue_workbench_task', 'other'],
    ['routine_save', 'other'],
    ['create_project', 'other'],
    ['create_teammate', 'other'],
    ['create_teammate', 'arranged'],
    ['set_teammate_capability', 'arranged'],
    ['update_teammate_profile', 'arranged'],
    ['update_teammate_profile', 'other'],
    ['set_teammate_capability', 'other'],
    ['update_bot_profile', 'other'],
    ['set_bot_capability', 'other'],
  ])('keeps %s for the owner in a %s turn', (tool, authority) => {
    expect(decideBotToolCall('cindy_helper', tool, {}, authority)).toMatchObject({
      kind: 'deny',
      errorCode: 'OWNER_TURN_REQUIRED',
    });
  });

  it('checks the target of session control by tier, reads freely only when arranged', () => {
    const args = { session_id: 'task-1' };
    expect(decideBotToolCall('cindy_helper', 'get_session_runtime', args, 'arranged')).toEqual({ kind: 'allow' });
    expect(decideBotToolCall('cindy_helper', 'get_session_runtime', args, 'other'))
      .toEqual({ kind: 'targets', sessionIds: ['task-1'], scope: 'own' });
    expect(decideBotToolCall('cindy_helper', 'stop_session_turn', args, 'arranged'))
      .toEqual({ kind: 'targets', sessionIds: ['task-1'], scope: 'own-or-handed' });
    expect(decideBotToolCall('cindy_helper', 'steer_session', args, 'other'))
      .toEqual({ kind: 'targets', sessionIds: ['task-1'], scope: 'own' });
    expect(decideBotToolCall('cindy_helper', 'stop_session_turn', {}, 'other'))
      .toMatchObject({ kind: 'deny', errorCode: 'INVALID_ARGS' });
    // Omitted session_id means the caller's own current task.
    expect(decideBotToolCall('cindy_helper', 'get_session_runtime', {}, 'other')).toEqual({ kind: 'allow' });
    expect(decideBotToolCall('cindy_helper', 'set_session_runtime', { effort: 'high' }, 'other')).toEqual({ kind: 'allow' });
  });

  it('checks every target of rename and archive batches by tier', () => {
    expect(decideBotToolCall('cindy_helper', 'rename_sessions', {
      changes: [{ session_id: 'a', title: 'x' }, { session_id: 'b', title: 'y' }, { session_id: 'a', title: 'z' }],
    }, 'arranged')).toEqual({ kind: 'targets', sessionIds: ['a', 'b'], scope: 'own-or-handed' });
    expect(decideBotToolCall('cindy_helper', 'archive_sessions', { session_ids: ['a'] }, 'other'))
      .toEqual({ kind: 'targets', sessionIds: ['a'], scope: 'own' });
    expect(decideBotToolCall('cindy_helper', 'unarchive_sessions', { session_ids: [] }, 'other'))
      .toMatchObject({ kind: 'deny', errorCode: 'INVALID_ARGS' });
    expect(decideBotToolCall('cindy_helper', 'rename_sessions', { changes: [{ title: 'x' }] }, 'arranged'))
      .toMatchObject({ kind: 'deny', errorCode: 'INVALID_ARGS' });
  });

  it('opens a new ordinary task only on the owner turn, but can message an allowed one', () => {
    expect(decideBotToolCall('cindy_helper', 'send_to_session', { message: 'go' }, 'arranged'))
      .toMatchObject({ kind: 'deny', errorCode: 'OWNER_TURN_REQUIRED' });
    expect(decideBotToolCall('cindy_helper', 'send_to_session', { target_session_id: 't', message: 'go' }, 'arranged'))
      .toEqual({ kind: 'targets', sessionIds: ['t'], scope: 'own-or-handed' });
  });

  it('creates or changes automations only on the owner turn', () => {
    expect(decideBotToolCall('cindy_scheduler', 'schedule_list', {}, 'arranged')).toEqual({ kind: 'allow' });
    expect(decideBotToolCall('cindy_scheduler', 'schedule_notify_current_run', {}, 'other')).toEqual({ kind: 'allow' });
    for (const authority of ['arranged', 'other'] as const) {
      for (const tool of ['schedule_create', 'schedule_update', 'schedule_delete', 'schedule_run_now']) {
        expect(decideBotToolCall('cindy_scheduler', tool, {}, authority)).toMatchObject({ kind: 'deny' });
      }
    }
    expect(decideBotToolCall('cindy_scheduler', 'schedule_list', {}, 'other')).toMatchObject({ kind: 'deny' });
  });
});

let sqlite: Database.Database;
let db: Pick<DbClient, 'drizzle'>;
let clock = 1_000;

function message(sessionId: string, clientId: string, meta: object) {
  sqlite.prepare('INSERT INTO messages (session_id, client_id, role, agent_meta, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, clientId, 'user', JSON.stringify(meta), ++clock);
}
function delegation(id: string, parentSessionId: string, childSessionId: string | null = null) {
  sqlite.prepare('INSERT INTO bot_delegations (id, requesting_bot_id, parent_session_id, child_session_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'bot-1', parentSessionId, childSessionId, ++clock);
}
const ownerMeta = { delivery: 'turn', autoReviewUserText: '帮我把这个项目跑起来' };
const botDmMeta = { delivery: 'turn', origin: { kind: 'bot-dm' } };

beforeEach(() => {
  clock = 1_000;
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, status TEXT, remote_host_id TEXT, cleared_at INTEGER);
    CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER);
    CREATE TABLE bot_delegations (id TEXT PRIMARY KEY, requesting_bot_id TEXT, parent_session_id TEXT, child_session_id TEXT, created_at INTEGER);
    CREATE TABLE messages (session_id TEXT, client_id TEXT, role TEXT, agent_meta TEXT, created_at INTEGER, rewind_at INTEGER);
    INSERT INTO sessions VALUES ('bot-main', 'bot', 'active', NULL, NULL);
    INSERT INTO sessions VALUES ('bot-lane', 'bot', 'active', NULL, NULL);
    INSERT INTO sessions VALUES ('bot-remote', 'bot', 'active', 'ssh-1', NULL);
    INSERT INTO sessions VALUES ('child-1', 'desktop', 'active', NULL, NULL);
    INSERT INTO sessions VALUES ('owner-task', 'desktop', 'active', NULL, NULL);
    INSERT INTO sessions VALUES ('handed-task', 'desktop', 'active', NULL, NULL);
    INSERT INTO bot_session_links VALUES ('l1', 'bot-1', 'bot-main', 'canonical', NULL);
    INSERT INTO bot_session_links VALUES ('l2', 'bot-1', 'bot-lane', 'group', NULL);
    INSERT INTO bot_session_links VALUES ('l3', 'bot-2', 'bot-remote', 'canonical', NULL);
  `);
  db = { drizzle: drizzle(sqlite) as unknown as DbClient['drizzle'] };
});
afterEach(() => sqlite.close());

describe('resolveBotTurnAuthority', () => {
  it('reads the owner, automation and unknown sources from the host input', async () => {
    expect(await resolveBotTurnAuthority(db, 'bot-main', OWNER_INPUT)).toBe('owner');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('schedule-run:1', 'scheduler'))).toBe('arranged');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-dm:abc'))).toBe('other');
  });

  it('treats a background-task report as arranged only when the owner or an automation started that task', async () => {
    message('bot-main', 'owner-msg', ownerMeta);
    delegation('d-owner', 'bot-main');
    message('bot-main', 'bot-dm:1', botDmMeta);
    delegation('d-dm', 'bot-main');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-delegation-completion:d-owner'))).toBe('arranged');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-delegation-interaction:d-owner:req-1'))).toBe('arranged');
    // Started while another Bot was talking: its report must not lift the tier.
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-delegation-completion:d-dm:2'))).toBe('other');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-delegation-completion:missing'))).toBe('other');
  });

  it('follows a chain of reports back to the turn that started it', async () => {
    message('bot-main', 'owner-msg', ownerMeta);
    delegation('d1', 'bot-main');
    message('bot-main', 'bot-delegation-completion:d1', {});
    delegation('d2', 'bot-main');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-delegation-completion:d2'))).toBe('arranged');

    message('bot-main', 'bot-dm:2', botDmMeta);
    delegation('d3', 'bot-main');
    message('bot-main', 'bot-delegation-completion:d3', {});
    delegation('d4', 'bot-main');
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-delegation-completion:d4'))).toBe('other');
  });

  it('caps an authorization resume at the turn that asked for it', async () => {
    message('bot-main', 'owner-msg', ownerMeta);
    message('bot-main', 'bot-authorization-resume:r1', {});
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-authorization-resume:r1'))).toBe('arranged');
    message('bot-main', 'bot-dm:3', botDmMeta);
    message('bot-main', 'bot-authorization-resume:r2', {});
    expect(await resolveBotTurnAuthority(db, 'bot-main', input('bot-authorization-resume:r2'))).toBe('other');
  });

  it('drops to the lowest tier once another task or Bot steers into the turn', async () => {
    message('bot-main', 'owner-msg', ownerMeta);
    expect(await resolveBotTurnAuthority(db, 'bot-main', OWNER_INPUT)).toBe('owner');
    // The owner's own composer steer carries no origin and keeps the tier.
    message('bot-main', 'owner-steer', { delivery: 'steer', autoReviewUserText: '再加一句' });
    expect(await resolveBotTurnAuthority(db, 'bot-main', OWNER_INPUT)).toBe('owner');
    message('bot-main', 'foreign-steer', { delivery: 'steer', origin: { kind: 'session' } });
    expect(await resolveBotTurnAuthority(db, 'bot-main', OWNER_INPUT)).toBe('other');
  });

  it('falls back to the latest root input when the coordinator has none', async () => {
    message('bot-main', 'schedule-run:9', { origin: { kind: 'scheduler' } });
    expect(await resolveBotTurnAuthority(db, 'bot-main', { executing: false, input: null })).toBe('arranged');
  });
});

describe('createBotToolCallAuthorizer', () => {
  function authorizer(execution: BotTurnExecution, handed: string[] = []) {
    return createBotToolCallAuthorizer({
      getDb: () => db,
      readExecution: () => execution,
      isWorkbenchProjectSession: vi.fn(async (_botId: string, sessionId: string) => handed.includes(sessionId)),
    });
  }
  const call = (tool: string, args: unknown = {}, sessionId = 'bot-main', server: 'cindy_helper' | 'cindy_scheduler' = 'cindy_helper') =>
    ({ sessionId, server, tool, args });

  it('leaves ordinary tasks alone', async () => {
    expect(await authorizer(input('bot-dm:1'))(call('archive_sessions', {}, 'owner-task'))).toEqual({ ok: true });
  });

  it('gives the owner turn the whole surface', async () => {
    expect(await authorizer(OWNER_INPUT)(call('archive_sessions'))).toEqual({ ok: true });
    expect(await authorizer(OWNER_INPUT)(call('schedule_create', {}, 'bot-main', 'cindy_scheduler'))).toEqual({ ok: true });
  });

  it('lets other turns act only on the Bot own tasks', async () => {
    delegation('d1', 'bot-main', 'child-1');
    const auth = authorizer(input('bot-dm:1'), ['handed-task']);
    expect(await auth(call('stop_session_turn', { session_id: 'child-1' }))).toEqual({ ok: true });
    expect(await auth(call('stop_session_turn', { session_id: 'handed-task' })))
      .toMatchObject({ ok: false, errorCode: 'TASK_OUT_OF_SCOPE' });
    expect(await auth(call('stop_session_turn', { session_id: 'owner-task' })))
      .toMatchObject({ ok: false, errorCode: 'TASK_OUT_OF_SCOPE' });
  });

  it('lets arranged turns also act on tasks in handed-over projects', async () => {
    const auth = authorizer(input('schedule-run:1', 'scheduler'), ['handed-task']);
    expect(await auth(call('steer_session', { session_id: 'handed-task' }))).toEqual({ ok: true });
    expect(await auth(call('steer_session', { session_id: 'owner-task' })))
      .toMatchObject({ ok: false, errorCode: 'TASK_OUT_OF_SCOPE' });
  });

  it('judges a non-main Bot session at the lowest tier even if the owner typed', async () => {
    expect(await resolveBotCallerAuthority(db, 'bot-lane', () => OWNER_INPUT))
      .toEqual({ kind: 'bot', botId: 'bot-1', main: false, authority: 'other' });
    expect(await authorizer(OWNER_INPUT)(call('set_app_default_model', {}, 'bot-lane')))
      .toMatchObject({ ok: false, errorCode: 'OWNER_TURN_REQUIRED' });
    expect(await authorizer(OWNER_INPUT)(call('archive_sessions', { session_ids: ['owner-task'] }, 'bot-lane')))
      .toMatchObject({ ok: false, errorCode: 'TASK_OUT_OF_SCOPE' });
  });

  it('lets a non-owner turn archive only tasks the Bot owns', async () => {
    delegation('d1', 'bot-main', 'child-1');
    const auth = authorizer(input('bot-delegation-completion:missing'));
    expect(await auth(call('archive_sessions', { session_ids: ['child-1'] }))).toEqual({ ok: true });
    expect(await auth(call('archive_sessions', { session_ids: ['child-1', 'owner-task'] })))
      .toMatchObject({ ok: false, errorCode: 'TASK_OUT_OF_SCOPE' });
  });

  it('keeps remote Bots on their old helper behavior, judging only local automations by turn', async () => {
    expect(await authorizer(input('bot-dm:1'))(call('set_app_default_model', {}, 'bot-remote'))).toEqual({ ok: true });
    expect(await authorizer(OWNER_INPUT)(call('schedule_create', {}, 'bot-remote', 'cindy_scheduler'))).toEqual({ ok: true });
    expect(await authorizer(input('bot-dm:1'))(call('schedule_create', {}, 'bot-remote', 'cindy_scheduler')))
      .toMatchObject({ ok: false, errorCode: 'OWNER_TURN_REQUIRED' });
  });

  it('refuses a call it cannot attribute to a task', async () => {
    expect(await authorizer(OWNER_INPUT)({ sessionId: undefined, server: 'cindy_scheduler', tool: 'schedule_list', args: {} }))
      .toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE' });
  });

  it('refuses while the account database is unavailable or switching', async () => {
    const noDb = createBotToolCallAuthorizer({
      getDb: () => null,
      readExecution: () => OWNER_INPUT,
      isWorkbenchProjectSession: async () => false,
    });
    expect(await noDb(call('archive_sessions'))).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
    const switching = createBotToolCallAuthorizer({
      getDb: () => db,
      readExecution: () => OWNER_INPUT,
      isWorkbenchProjectSession: async () => false,
      isScopeCurrent: () => false,
    });
    expect(await switching(call('archive_sessions'))).toMatchObject({ ok: false, errorCode: 'OWNER_SCOPE_CHANGED' });
  });
});
