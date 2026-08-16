import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { Maker } from '@cindy/maker-core';
import * as schema from '../../localDb/schema';
import {
  botAutomationRuns,
  botSessionLinks,
  scheduleRuns,
  sessions,
} from '../../localDb/schema';
import {
  reconcileBotAutomationRuns,
  requireStrictAutomationRuntime,
} from '../bot-automation-runner';

function createDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      canonical_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY NOT NULL,
      schedule_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result_text TEXT,
      finished_at INTEGER,
      heartbeat_at INTEGER
    );
    CREATE TABLE bot_automation_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      schedule_id TEXT
    );
    CREATE TABLE bot_automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      automation_link_id TEXT NOT NULL,
      schedule_run_id TEXT,
      session_id TEXT,
      target_route_id_snapshot TEXT,
      target_route_owner_generation_snapshot INTEGER,
      delivery_outbox_id TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'not-requested',
      delivery_error TEXT,
      result_text_snapshot TEXT,
      output_artifacts_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE bot_runtime_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL,
      agent_kind TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      memory_scope_key TEXT,
      configured_json TEXT NOT NULL DEFAULT '{}',
      resolved_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      prepared_at INTEGER NOT NULL DEFAULT 0,
      applied_at INTEGER,
      failed_at INTEGER,
      failure_json TEXT
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      channel_id TEXT,
      route_key TEXT,
      archived_at INTEGER
    );
    CREATE TABLE bot_routes (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL,
      current_session_id TEXT,
      channel_id TEXT,
      owner_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe('Bot automation restart recovery', () => {
  it('fails closed before dispatch when the frozen runtime is degraded', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare(`
      INSERT INTO bot_runtime_snapshots (
        id, bot_id, session_id, profile_version, agent_kind, working_dir,
        resolved_json, status, prepared_at
      ) VALUES ('runtime-1', 'bot-1', 'automation-session', 3, 'pi', '/tmp/bot', ?, 'degraded', 10)
    `).run(JSON.stringify({ unavailableSkills: ['release-review'] }));
    const plan = {
      version: 1 as const,
      createdAt: 1,
      deadlineAt: 100,
      botId: 'bot-1',
      profile: {
        profileVersion: 3,
        agentKind: 'pi' as const,
        model: 'grok-4.5',
        capabilitiesSha256: 'capabilities',
        identitySha256: 'identity',
        skills: ['release-review'],
        skillMode: 'allowlist' as const,
        mcpServers: [],
        mcpMode: 'inherit' as const,
        toolsets: [],
        toolsetMode: 'inherit' as const,
        memoryEnabled: true,
        automationEnabled: true,
      },
      workspace: null,
      delivery: { targetRouteId: null, ownerGeneration: null },
      limits: { timeoutMs: 99, budgetTokens: null, maxDelegationDepth: 1 },
      delegation: { mode: 'none' as const, targets: [] },
    };

    await expect(
      requireStrictAutomationRuntime(db, 'automation-session', plan),
    ).rejects.toThrow(/degraded/);

    sqlite.prepare(`
      UPDATE bot_runtime_snapshots
      SET status = 'applied', resolved_json = '{"unavailableSkills":[],"memoryRefs":[]}'
      WHERE id = 'runtime-1'
    `).run();
    await expect(
      requireStrictAutomationRuntime(db, 'automation-session', plan),
    ).resolves.toBeUndefined();
    sqlite.close();
  });

  it('persists and delivers a captured completion before archiving its task', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('parent', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'parent')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Daily report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', 'Recovered report.', 'completing', 10)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    const archiveSession = vi.fn(async (sessionId: string) => {
      db.update(sessions)
        .set({ status: 'archived', updatedAt: 20 })
        .where(eq(sessions.id, sessionId))
        .run();
    });
    const closeSession = vi.fn(async () => undefined);
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession } as unknown as Maker,
      archiveSession,
      enqueueDelivery,
    });

    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'bot-1',
      sessionId: 'parent',
      idempotencyKey: 'bot-automation-completion:schedule-run-1',
      payload: expect.objectContaining({
        targetSessionId: 'parent',
        message: expect.stringContaining('Recovered report.'),
      }),
    }));
    expect(
      db.select({
        status: botAutomationRuns.status,
        outboxId: botAutomationRuns.deliveryOutboxId,
        deliveryStatus: botAutomationRuns.deliveryStatus,
      }).from(botAutomationRuns).get(),
    ).toEqual({ status: 'success', outboxId: 'outbox-1', deliveryStatus: 'queued' });
    expect(
      db.select({ status: scheduleRuns.status, resultText: scheduleRuns.resultText })
        .from(scheduleRuns).get(),
    ).toEqual({ status: 'success', resultText: 'Recovered report.' });
    expect(db.select({ status: sessions.status }).from(sessions).where(
      eq(sessions.id, 'child'),
    ).get()).toEqual({ status: 'archived' });
    expect(db.select({ role: botSessionLinks.role }).from(botSessionLinks).get())
      .toEqual({ role: 'history' });
    expect(archiveSession).toHaveBeenCalledWith('child');
    expect(closeSession).toHaveBeenCalledWith('child');
    sqlite.close();
  });

  it('restores the frozen IM Route target when a completing run recovers after restart', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('canonical', 'active', 1), ('route-task', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', 'canonical')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Route report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_routes (
        id, bot_id, current_session_id, channel_id, owner_generation, status
      ) VALUES ('route-1', 'bot-1', 'route-task', 'telegram-account-1', 7, 'active')
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        target_route_id_snapshot, target_route_owner_generation_snapshot,
        delivery_status, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'route-1', 7, 'not-requested', 'Recovered route report.', 'completing', 10)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-route-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      archiveSession: vi.fn(async () => undefined),
      enqueueDelivery,
    });

    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'bot-1',
      channelId: 'telegram-account-1',
      routeId: 'route-1',
      sessionId: 'route-task',
      ownerGeneration: 7,
      idempotencyKey: 'bot-automation-completion:schedule-run-1',
      payload: expect.objectContaining({
        targetSessionId: 'route-task',
        message: expect.stringContaining('Recovered route report.'),
      }),
    }));
    expect(db.select({
      status: botAutomationRuns.status,
      outboxId: botAutomationRuns.deliveryOutboxId,
      deliveryStatus: botAutomationRuns.deliveryStatus,
    }).from(botAutomationRuns).get()).toEqual({
      status: 'success',
      outboxId: 'outbox-route-1',
      deliveryStatus: 'queued',
    });
    sqlite.close();
  });

  it('does not deliver a recovered completion after the Bot was paused', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('parent', 'active', 1), ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id, status) VALUES ('bot-1', 'parent', 'paused')").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Daily report')").run();
    sqlite.prepare("INSERT INTO schedule_runs (id, schedule_id, status) VALUES ('schedule-run-1', 'schedule-1', 'running')").run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, result_text_snapshot, status, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', 'Recovered report.', 'completing', 10)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      enqueueDelivery,
    });

    expect(enqueueDelivery).not.toHaveBeenCalled();
    expect(db.select({
      status: botAutomationRuns.status,
      deliveryStatus: botAutomationRuns.deliveryStatus,
      deliveryError: botAutomationRuns.deliveryError,
    }).from(botAutomationRuns).get()).toEqual({
      status: 'success',
      deliveryStatus: 'enqueue-failed',
      deliveryError: 'Bot is no longer active; completion was not delivered',
    });
    sqlite.close();
  });

  it('repairs a Scheduler run interrupted after the Bot result was durably completed', async () => {
    const { sqlite, db } = createDb();
    sqlite.prepare("INSERT INTO sessions (id, status, updated_at) VALUES ('child', 'active', 1)").run();
    sqlite.prepare("INSERT INTO bot_profiles (id, canonical_session_id) VALUES ('bot-1', NULL)").run();
    sqlite.prepare("INSERT INTO schedules (id, name) VALUES ('schedule-1', 'Crash window')").run();
    sqlite.prepare(`
      INSERT INTO schedule_runs (id, schedule_id, status, result_text, finished_at)
      VALUES ('schedule-run-1', 'schedule-1', 'interrupted', NULL, 20)
    `).run();
    sqlite.prepare("INSERT INTO bot_automation_links (id, bot_id, schedule_id) VALUES ('automation-1', 'bot-1', 'schedule-1')").run();
    sqlite.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, schedule_run_id, session_id,
        delivery_status, result_text_snapshot, status, updated_at, finished_at
      ) VALUES ('automation-run-1', 'automation-1', 'schedule-run-1', 'child',
        'not-requested', 'Durable result.', 'success', 19, 19)
    `).run();
    sqlite.prepare(`
      INSERT INTO bot_session_links (id, session_id, role, channel_id, route_key)
      VALUES ('link-1', 'child', 'route', 'bot-1:local', 'automation:schedule-run-1')
    `).run();

    await reconcileBotAutomationRuns({
      getDb: () => db,
      maker: { closeSession: vi.fn(async () => undefined) } as unknown as Maker,
      archiveSession: async (sessionId) => {
        db.update(sessions)
          .set({ status: 'archived', updatedAt: 21 })
          .where(eq(sessions.id, sessionId))
          .run();
      },
    });

    expect(
      db.select({ status: scheduleRuns.status, resultText: scheduleRuns.resultText })
        .from(scheduleRuns)
        .get(),
    ).toEqual({ status: 'success', resultText: 'Durable result.' });
    expect(db.select({ status: botAutomationRuns.status }).from(botAutomationRuns).get())
      .toEqual({ status: 'success' });
    expect(db.select({ status: sessions.status }).from(sessions).get())
      .toEqual({ status: 'archived' });
    sqlite.close();
  });
});
