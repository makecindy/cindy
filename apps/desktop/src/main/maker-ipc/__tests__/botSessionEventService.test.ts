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
import {
  DEFAULT_CONTROL_BOT_EVENT_RULE,
  type BotSessionStateTransition,
  type BotSessionStateTransitionSource,
} from '../../../shared/botSessionEvents.js';

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
    CREATE TABLE bot_delegations (
      id TEXT PRIMARY KEY,
      requesting_bot_id TEXT NOT NULL,
      target_bot_id TEXT NOT NULL,
      child_session_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

function transition(
  transitionId: string,
  current: Partial<BotSessionStateTransition['current']> = {},
): BotSessionStateTransition {
  return {
    transitionId,
    sessionId: 'task-1',
    occurredAt: 20,
    title: '实现功能',
    source: 'desktop',
    workingDir: '/repo/cindy',
    previous: {
      lifecycle: 'active',
      execution: 'running',
      attention: null,
      workflow: null,
    },
    current: {
      lifecycle: 'active',
      execution: 'normal-ended',
      attention: null,
      workflow: null,
      ...current,
    },
    changedFacets: ['execution'],
  };
}

describe('Bot task-state transition inbox service', () => {
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

  function service(overrides: Partial<Parameters<typeof createBotSessionEventService>[0]> = {}) {
    return createBotSessionEventService({
      dispatch,
      enqueueDelivery,
      now: () => 100,
      createId: () => `generated-${++ids}`,
      ...overrides,
    });
  }

  it('deduplicates authoritative transitions and does not wake paused Bots', async () => {
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

    await events.recordStateTransition(transition('state-transition-1'));
    await events.recordStateTransition(transition('state-transition-1'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    expect(count(sqlite, 'bot_session_event_ledger')).toBe(1);
    expect(count(sqlite, 'bot_inbox_items')).toBe(1);
    expect(sqlite.prepare('SELECT bot_id FROM bot_inbox_items').get()).toEqual({
      bot_id: 'control-bot',
    });
  });

  it('does not settle a heartbeat activation before the Bot turn is accepted', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });
    await events.recordStateTransition(transition('state-transition-1'));
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

  it('consumes a workflow-state transition and sends only the Bot result to Telegram', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });

    await events.recordStateTransition({
      ...transition('state-transition-decision', { execution: 'running' }),
      title: '实现功能 · 待总控',
      current: {
        lifecycle: 'active',
        execution: 'running',
        attention: 'needs-user',
        workflow: { key: 'awaiting-controller', label: '待总控' },
      },
      changedFacets: ['attention', 'workflow'],
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await accepted?.();
    const [item] = await events.listInbox('control-bot');
    expect(item.event).toMatchObject({
      transitionId: 'state-transition-decision',
      workflowState: { key: 'awaiting-controller', label: '待总控' },
      currentState: { workflow: { key: 'awaiting-controller', label: '待总控' } },
    });

    await events.settleProcessingForSession({
      sessionId: 'control-session',
      outcome: 'completed',
      resultText: '需要你确认是否发布。',
    });
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'control-bot',
        routeId: 'telegram-route',
        payload: {
          version: 1,
          kind: 'channel-final-recovery',
          text: '需要你确认是否发布。',
          mediaRefs: [],
        },
      }),
    );
    expect(JSON.stringify(enqueueDelivery.mock.calls)).not.toContain('实现功能 · 待总控');
  });

  it('binds the control-plane transition source and resolves logical relationships at match time', async () => {
    const listeners: Array<(value: BotSessionStateTransition) => void> = [];
    const unsubscribe = vi.fn();
    const source: BotSessionStateTransitionSource = {
      subscribe: vi.fn((next) => {
        listeners.push(next);
        return unsubscribe;
      }),
    };
    const events = service({
      stateTransitionSource: source,
      resolveSessionRelations: vi.fn(async () => ['delegated-by-bot']),
    });
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '我委派的任务',
      rule: {
        sessionRelations: ['delegated-by-bot'],
        executionStates: ['normal-ended'],
        activationMode: 'heartbeat-turn',
        resultDelivery: 'none',
      },
    });

    expect(listeners).toHaveLength(1);
    listeners[0]!(transition('state-transition-delegated'));
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    events.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps earlier Draft inbox rows readable without treating them as current state', async () => {
    sqlite.prepare(`
      INSERT INTO bot_event_subscriptions VALUES
        ('legacy-subscription', 'control-bot', '旧订阅', 'active', ?, 1, 1)
    `).run(JSON.stringify(DEFAULT_CONTROL_BOT_EVENT_RULE));
    sqlite.prepare(`
      INSERT INTO bot_session_event_ledger VALUES
        ('legacy-event', 'legacy-key', 'task-1', 'session.decision.required', ?, NULL, '[]', 0, 20)
    `,
      )
      .run(
        JSON.stringify({
          sessionId: 'task-1',
          eventType: 'session.decision.required',
          title: '实现功能 · 待总控',
          status: 'active',
          source: 'desktop',
          workingDir: '/repo/cindy',
          occurredAt: 20,
          decisionState: '待总控',
        }),
      );
    sqlite.prepare(`
      INSERT INTO bot_inbox_items
        (id, bot_id, subscription_id, event_id, status, attempts,
         result_delivery_status, received_at, updated_at)
      VALUES ('legacy-inbox', 'control-bot', 'legacy-subscription', 'legacy-event',
        'pending', 0, 'none', 20, 20)
    `).run();

    const events = service();
    await events.restore();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[0].message).toContain(
      'Legacy Draft notification: session.decision.required',
    );
    expect((await events.listInbox('control-bot'))[0]?.event.decisionState).toBe('待总控');
  });

  it('recovers interrupted activation after restart through the same inbox row', async () => {
    const events = service();
    await events.upsertSubscription({
      id: 'subscription-control',
      botId: 'control-bot',
      name: '总控订阅',
      rule: DEFAULT_CONTROL_BOT_EVENT_RULE,
    });
    await events.recordStateTransition(
      transition('state-transition-error', {
        execution: 'error-ended',
      }),
    );
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await accepted?.();
    dispatch.mockClear();

    await events.restore();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(count(sqlite, 'bot_inbox_items')).toBe(1);
    expect(
      sqlite.prepare('SELECT status, attempts, last_error FROM bot_inbox_items').get(),
    ).toMatchObject({
      status: 'processing',
      attempts: 2,
      last_error: null,
    });
  });

  it('keeps healthy guardian checks zero-token and hides the system subscription', async () => {
    sqlite
      .prepare(
        `
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `,
      )
      .run();
    const scheduleGuardianTick = vi.fn(() => vi.fn());
    const source: BotSessionStateTransitionSource = {
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => ({
        lifecycle: 'active',
        execution: 'running',
        attention: null,
        workflow: null,
        lastActivityAtMs: 95,
        turnGeneration: 1,
      })),
    };
    const events = service({
      scheduleGuardianTick,
      guardianThresholds: { staleRunningMs: 20 },
    });
    events.bindStateTransitionSource(source);
    await events.runGuardianTick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(count(sqlite, 'bot_session_event_ledger')).toBe(0);
    expect(count(sqlite, 'bot_inbox_items')).toBe(0);
    expect(await events.listSubscriptions('control-bot')).toEqual([]);
    expect(scheduleGuardianTick).toHaveBeenCalledTimes(1);
    events.dispose();
  });

  it('activates once for a stale task and deduplicates the same anomaly durably', async () => {
    sqlite
      .prepare(
        `
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `,
      )
      .run();
    const source: BotSessionStateTransitionSource = {
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => ({
        lifecycle: 'active',
        execution: 'running',
        attention: null,
        workflow: null,
        lastActivityAtMs: 50,
        turnGeneration: 1,
      })),
    };
    const events = service({
      scheduleGuardianTick: () => () => undefined,
      guardianThresholds: { staleRunningMs: 20 },
    });
    events.bindStateTransitionSource(source);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await events.runGuardianTick();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(count(sqlite, 'bot_session_event_ledger')).toBe(1);
    expect(count(sqlite, 'bot_inbox_items')).toBe(1);
    expect((await events.listInbox('control-bot'))[0]?.event.guardianAnomaly?.kind).toBe(
      'stale-running',
    );
    expect(await events.listSubscriptions('control-bot')).toEqual([]);
    events.dispose();
  });

  it('does not let an inbox-only item hide or starve an unclaimed-decision anomaly', async () => {
    sqlite
      .prepare(
        `
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'waiting', 10)
    `,
      )
      .run();
    const events = service({
      scheduleGuardianTick: () => () => undefined,
      guardianThresholds: { unclaimedDecisionMs: 20 },
    });
    await events.upsertSubscription({
      id: 'inbox-only-watch',
      botId: 'control-bot',
      name: '只记录待总控',
      rule: {
        sessionRelations: ['all-local'],
        workflowStates: ['awaiting-controller'],
        activationMode: 'inbox-only',
        resultDelivery: 'none',
      },
    });
    await events.recordStateTransition({
      ...transition('state-transition-inbox-only', { execution: 'running' }),
      previous: {
        lifecycle: 'active',
        execution: 'running',
        attention: null,
        workflow: null,
      },
      current: {
        lifecycle: 'active',
        execution: 'needs-interaction',
        attention: 'needs-user',
        workflow: { key: 'awaiting-controller', label: '待总控', waitingOn: 'automation' },
        lastActivityAtMs: 50,
      },
      changedFacets: ['attention', 'workflow'],
    });
    expect(dispatch).not.toHaveBeenCalled();

    events.bindStateTransitionSource({
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => ({
        lifecycle: 'active',
        execution: 'needs-interaction',
        attention: 'needs-user',
        workflow: { key: 'awaiting-controller', label: '待总控', waitingOn: 'automation' },
        lastActivityAtMs: 50,
      })),
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    const inbox = await events.listInbox('control-bot');
    expect(inbox.some((item) => item.subscriptionId === 'inbox-only-watch')).toBe(true);
    expect(inbox.some((item) => item.event.guardianAnomaly?.kind === 'unclaimed-decision')).toBe(
      true,
    );
    events.dispose();
  });

  it('fails closed on a snapshot read error and keeps the next deterministic check scheduled', async () => {
    sqlite
      .prepare(
        `
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `,
      )
      .run();
    const scheduleGuardianTick = vi.fn(() => vi.fn());
    const events = service({ scheduleGuardianTick });
    events.bindStateTransitionSource({
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => {
        throw new Error('snapshot unavailable');
      }),
    });
    await events.runGuardianTick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(count(sqlite, 'bot_session_event_ledger')).toBe(0);
    expect(scheduleGuardianTick).toHaveBeenCalledTimes(1);
    events.dispose();
  });

  it('stops scheduling when the supervision set becomes empty', async () => {
    sqlite
      .prepare(
        `
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `,
      )
      .run();
    const cancel = vi.fn();
    const scheduleGuardianTick = vi.fn(() => cancel);
    const events = service({ scheduleGuardianTick });
    events.bindStateTransitionSource({
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => ({
        lifecycle: 'active',
        execution: 'running',
        attention: null,
        workflow: null,
        lastActivityAtMs: 100,
      })),
    });
    await events.runGuardianTick();
    expect(scheduleGuardianTick).toHaveBeenCalledTimes(1);

    sqlite
      .prepare(`UPDATE bot_delegations SET status = 'completed' WHERE id = 'delegation-1'`)
      .run();
    await events.refreshGuardian();
    expect(cancel).toHaveBeenCalled();
    expect(scheduleGuardianTick).toHaveBeenCalledTimes(1);
    events.dispose();
  });

  it('rescans after a concurrent refresh and does not leave a timer for cleared supervision', async () => {
    sqlite.prepare(`
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `).run();
    let releaseSnapshot!: () => void;
    let markSnapshotStarted!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const scheduleGuardianTick = vi.fn(() => vi.fn());
    const events = service({ scheduleGuardianTick });
    events.bindStateTransitionSource({
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => {
        markSnapshotStarted();
        await snapshotGate;
        return {
          lifecycle: 'active',
          execution: 'running',
          attention: null,
          workflow: null,
          lastActivityAtMs: 100,
        };
      }),
    });
    await snapshotStarted;
    sqlite.prepare(`UPDATE bot_delegations SET status = 'completed' WHERE id = 'delegation-1'`).run();
    const refreshed = events.refreshGuardian();
    releaseSnapshot();
    await refreshed;

    expect(scheduleGuardianTick).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    events.dispose();
  });

  it('fails closed when legacy data collides with the reserved guardian subscription owner', async () => {
    sqlite.prepare(`
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_event_subscriptions VALUES
        ('bot-guardian:control-bot', 'paused-bot', '冲突数据', 'active', '{}', 1, 1)
    `).run();
    const events = service({
      scheduleGuardianTick: () => () => undefined,
      guardianThresholds: { staleRunningMs: 20 },
    });
    events.bindStateTransitionSource({
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => ({
        lifecycle: 'active',
        execution: 'running',
        attention: null,
        workflow: null,
        lastActivityAtMs: 50,
      })),
    });
    await events.runGuardianTick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(count(sqlite, 'bot_session_event_ledger')).toBe(0);
    expect(count(sqlite, 'bot_inbox_items')).toBe(0);
    expect(sqlite.prepare(`SELECT bot_id FROM bot_event_subscriptions`).get()).toEqual({
      bot_id: 'paused-bot',
    });
    events.dispose();
  });

  it('stops scheduling and does not enqueue a late anomaly after the Bot is paused', async () => {
    sqlite
      .prepare(
        `
      INSERT INTO bot_delegations VALUES
        ('delegation-1', 'control-bot', 'control-bot', 'task-1', 'running', 10)
    `,
      )
      .run();
    const cancel = vi.fn();
    const scheduleGuardianTick = vi.fn(() => cancel);
    const events = service({
      scheduleGuardianTick,
      guardianThresholds: { staleRunningMs: 20 },
    });
    events.bindStateTransitionSource({
      subscribe: () => () => undefined,
      readSnapshot: vi.fn(async () => ({
        lifecycle: 'active',
        execution: 'running',
        attention: null,
        workflow: null,
        lastActivityAtMs: 95,
      })),
    });
    await events.runGuardianTick();
    sqlite.prepare(`UPDATE bot_profiles SET status = 'paused' WHERE id = 'control-bot'`).run();
    await events.refreshGuardian();

    expect(cancel).toHaveBeenCalled();
    expect(scheduleGuardianTick).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(count(sqlite, 'bot_session_event_ledger')).toBe(0);
    events.dispose();
  });
});
