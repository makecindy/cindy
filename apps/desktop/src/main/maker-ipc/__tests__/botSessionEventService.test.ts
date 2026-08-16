import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { createBotSessionEventService } from '../botSessionEventService.js';
import { BOT_SESSION_EVENT, DEFAULT_CONTROL_BOT_EVENT_RULE } from '../../../shared/botSessionEvents.js';

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      working_dir TEXT,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      active_turn_started_at INTEGER,
      last_turn_ended_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      rewind_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      canonical_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_channels (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_routes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      current_session_id TEXT,
      owner_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_event_ledger (
      id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      origin_bot_id TEXT,
      lineage_json TEXT NOT NULL DEFAULT '[]',
      hop_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bot_event_subscriptions (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      rule_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_inbox_items (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      processing_session_id TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      result_text TEXT,
      result_delivery_status TEXT NOT NULL DEFAULT 'none',
      result_delivery_error TEXT,
      received_at INTEGER NOT NULL,
      started_at INTEGER,
      handled_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(subscription_id, event_id)
    );

    INSERT INTO sessions VALUES
      ('control-session', '总控 Bot', '/repo/cindy', 'active', 'bot', NULL, NULL, 1),
      ('task-1', '实现功能', '/repo/cindy', 'active', 'desktop', 5, 10, 10),
      ('telegram-session', 'Telegram route', '/repo/cindy', 'active', 'bot', NULL, NULL, 1);
    INSERT INTO bot_profiles VALUES
      ('control-bot', '总控', 'active', 'control-session', 1, 1),
      ('paused-bot', '暂停 Bot', 'paused', 'control-session', 1, 1);
    INSERT INTO bot_channels VALUES
      ('telegram-channel', 'control-bot', 'telegram', 1, 1, 1);
    INSERT INTO bot_routes VALUES
      ('telegram-route', 'control-bot', 'telegram-channel', 'telegram-session', 3, 'active', 1, 1);
  `);
  return sqlite;
}

function count(sqlite: Database.Database, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe('Bot task-event inbox service', () => {
  let sqlite: Database.Database;
  let ids: number;
  let accepted: (() => void | Promise<void>) | undefined;
  let dispatch: ReturnType<typeof vi.fn>;
  let enqueueDelivery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sqlite = createDatabase();
    h.db = drizzle(sqlite);
    ids = 0;
    accepted = undefined;
    dispatch = vi.fn(async (input: { onAccepted?: () => void | Promise<void> }) => {
      accepted = input.onAccepted;
      return { ok: true as const, targetSessionId: 'control-session', wakeKind: 'queued' as const };
    });
    enqueueDelivery = vi.fn(async () => ({ id: 'delivery-1' }));
  });

  function service() {
    return createBotSessionEventService({
      dispatch,
      enqueueDelivery,
      now: () => 100,
      createId: () => `generated-${++ids}`,
    });
  }

  it('deduplicates repeated terminal facts and does not wake paused Bots', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });
    await events.upsertSubscription({
      id: 'subscription-paused',
      botId: 'paused-bot',
      name: '暂停订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });

    await events.recordTurnEvent({ sessionId: 'task-1', outcome: 'completed', attemptToken: 5 });
    await events.recordTurnEvent({ sessionId: 'task-1', outcome: 'completed', attemptToken: 5 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    expect(count(sqlite, 'bot_session_event_ledger')).toBe(1);
    expect(count(sqlite, 'bot_inbox_items')).toBe(1);
    expect(sqlite.prepare('SELECT bot_id FROM bot_inbox_items').get()).toEqual({
      bot_id: 'control-bot',
    });
  });

  it('does not settle a queued notification before the Bot turn is accepted', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });
    await events.recordTurnEvent({ sessionId: 'task-1', outcome: 'completed', attemptToken: 5 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    await events.settleProcessingForSession({
      sessionId: 'control-session',
      outcome: 'completed',
      resultText: '不应结算',
    });
    expect(sqlite.prepare('SELECT status, started_at FROM bot_inbox_items').get()).toEqual({
      status: 'processing',
      started_at: null,
    });

    await accepted?.();
    await events.settleProcessingForSession({
      sessionId: 'control-session',
      outcome: 'completed',
      resultText: '任务已完成，可以继续发布。',
    });
    expect(sqlite.prepare('SELECT status, result_text FROM bot_inbox_items').get()).toEqual({
      status: 'handled',
      result_text: '任务已完成，可以继续发布。',
    });
  });

  it('turns a decision title into an inbox event and sends only the Bot result to Telegram', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });
    sqlite.prepare("UPDATE sessions SET title = '实现功能 · 待总控', updated_at = 20 WHERE id = 'task-1'").run();

    await events.recordMetadataPatch('task-1', { title: '实现功能 · 待总控' }, 20);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await accepted?.();
    const [item] = await events.listInbox('control-bot');
    expect(item.event).toMatchObject({
      eventType: BOT_SESSION_EVENT.DECISION_REQUIRED,
      decisionState: '待总控',
    });

    await events.settleProcessingForSession({
      sessionId: 'control-session',
      outcome: 'completed',
      resultText: '需要你确认是否发布。',
    });
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'control-bot',
      routeId: 'telegram-route',
      payload: {
        version: 1,
        kind: 'channel-final-recovery',
        text: '需要你确认是否发布。',
        mediaRefs: [],
      },
    }));
    expect(JSON.stringify(enqueueDelivery.mock.calls)).not.toContain('实现功能 · 待总控');
  });

  it('recovers interrupted processing after restart and retries it through the same inbox row', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });
    await events.recordTurnEvent({ sessionId: 'task-1', outcome: 'failed', attemptToken: 5 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await accepted?.();
    dispatch.mockClear();

    await events.restore();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(count(sqlite, 'bot_inbox_items')).toBe(1);
    expect(sqlite.prepare('SELECT status, attempts, last_error FROM bot_inbox_items').get()).toMatchObject({
      status: 'processing',
      attempts: 2,
      last_error: null,
    });
  });
});
