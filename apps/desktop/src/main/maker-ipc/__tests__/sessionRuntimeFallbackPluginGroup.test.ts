/**
 * 生产入口与可观察结果：createSessionRuntimeFallback 对绑定模型组的任务执行自动接替（内置↔插件引擎、
 * 插件引擎→另一插件引擎、同插件引擎换模型），提交后推进模型组绑定。
 * 规则依据：2026-11-27 全系统放开插件引擎；模型组恢复路径必须对 acp 会话与 acp 候选同等生效。
 * 覆盖缺口：此前 sessionRuntimeFallback 仅对 source='bot' 读取 acp 行，且排除 agentKind==='acp'
 * 参与模型组恢复与绑定更新。
 * 最小失败输入与 tier：unit（内存 SQLite sessions 表 + createSessionRuntimeFallback）。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasExplicitSessionTaskModel: vi.fn(async () => false),
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: mocks.db }),
}));
vi.mock('../botDelegationHistory.js', () => ({
  hasExplicitSessionTaskModel: () => mocks.hasExplicitSessionTaskModel(),
}));
vi.mock('../sendToSessionLock.js', () => ({
  withSendToSessionLock: async <T>(_id: string, fn: () => Promise<T>) => fn(),
}));
vi.mock('../../maker-host/rehydrateCloseSuppression.js', () => ({
  withRehydrateCloseSuppressed: async <T>(_id: string, fn: () => Promise<T>) => fn(),
}));

import { sessions } from '../../localDb/schema.js';
import { createSessionRuntimeFallback, type FallbackRouteProfile } from '../sessionRuntimeFallback.js';

function createMemoryDb() {
  const sqlite = new Database(':memory:');
  const table = getTableConfig(sessions);
  sqlite.exec(`CREATE TABLE ${table.name} (
    id TEXT PRIMARY KEY,
    source TEXT DEFAULT 'desktop',
    status TEXT NOT NULL DEFAULT 'active',
    agent_kind TEXT NOT NULL DEFAULT 'cc',
    model TEXT NOT NULL DEFAULT '',
    provider_id TEXT,
    agent_device_id TEXT,
    effort TEXT NOT NULL DEFAULT ''
  )`);
  return { sqlite, db: drizzle(sqlite) };
}

describe('createSessionRuntimeFallback with plugin engine model groups', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    const mem = createMemoryDb();
    sqlite = mem.sqlite;
    mocks.db = mem.db;
    mocks.hasExplicitSessionTaskModel.mockResolvedValue(false);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('switches a built-in model-group session onto a plugin engine candidate and updates group binding', async () => {
    const committed: FallbackRouteProfile[] = [];
    const performSessionAgentSwitch = vi.fn(async () => ({ switched: true, engineReady: true }));
    const fallback = createSessionRuntimeFallback({
      maker: { getSession: () => undefined, closeSession: vi.fn(async () => {}) },
      readSessionRuntimeProfiles: async () => ({
        effective: {
          agentKind: 'codex',
          agentDeviceId: null,
          model: 'gpt-5.4',
          providerId: 'openai',
          effort: 'high',
          fastMode: false,
        },
        control: { pending: null, generation: 1, visitedRoutes: [], fallbackHop: 0 },
      }),
      canApplyAutomaticRuntimeSelection: () => true,
      readBotFallbackCandidate: async () => ({ isBot: false, candidate: null }),
      readModelGroupFallbackCandidate: async () => ({
        candidate: {
          agentKind: 'acp',
          agentDeviceId: null,
          model: 'deepseek-v4',
          providerId: 'acp-plugin:dsh:dsh',
          effort: null,
          fastMode: false,
        },
        labels: { from: 'GPT-5.4', to: 'DeepSeek V4 · DSH' },
        bindCommittedRoute: (profile) => { committed.push(profile); },
      }),
      readSessionAgentDeviceId: async () => null,
      readSessionRuntimeFallbackSettings: () => ({ enabled: false }),
      getDesktopProviderService: vi.fn() as never,
      pendingSessionRuntimeFallbackRebuilds: new Map(),
      applySessionRuntimeSelection: vi.fn() as never,
      getPendingCredentialSwitchTarget: () => null,
      clearPendingCredentialSwitchForSession: vi.fn(),
      broadcastSessionRuntimeProjection: vi.fn(async () => {}),
      agentSwitchDeps: {} as never,
      performSessionAgentSwitch: performSessionAgentSwitch as never,
      runtimeSelectionRequiresModelWindowConfirmation: () => false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    const result = await fallback('s-builtin-to-acp', 1, 1, true, () => true, {
      accountUnavailable: true,
      retrySameSource: false,
      hasImages: false,
    });
    expect(result).toMatchObject({
      outcome: 'switched',
      sourceSwitch: { from: 'GPT-5.4', to: 'DeepSeek V4 · DSH' },
    });
    expect(performSessionAgentSwitch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 's-builtin-to-acp',
        targetAgentKind: 'acp',
        providerId: 'acp-plugin:dsh:dsh',
        model: 'deepseek-v4',
        applyNow: true,
      }),
    );
    expect(committed).toEqual([
      expect.objectContaining({ agentKind: 'acp', providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-v4' }),
    ]);
  });

  it('recovers an active desktop plugin-engine session across plugin engines and within the same plugin engine', async () => {
    sqlite.prepare(
      `INSERT INTO sessions (id, source, status, agent_kind, model, provider_id, effort)
       VALUES (?, 'desktop', 'active', 'acp', 'deepseek-v4', 'acp-plugin:dsh:dsh', '')`,
    ).run('s-acp-cross');
    sqlite.prepare(
      `INSERT INTO sessions (id, source, status, agent_kind, model, provider_id, effort)
       VALUES (?, 'desktop', 'active', 'acp', 'deepseek-v4', 'acp-plugin:dsh:dsh', '')`,
    ).run('s-acp-same');

    const committedCross: FallbackRouteProfile[] = [];
    const performSessionAgentSwitch = vi.fn(async () => ({ switched: true, engineReady: true }));
    const crossFallback = createSessionRuntimeFallback({
      maker: { getSession: () => undefined, closeSession: vi.fn(async () => {}) },
      // Real readSessionRuntimeProfiles returns null for acp sessions.
      readSessionRuntimeProfiles: async () => null,
      canApplyAutomaticRuntimeSelection: () => true,
      readBotFallbackCandidate: async () => ({ isBot: false, candidate: null }),
      readModelGroupFallbackCandidate: async (_id, current) => {
        expect(current).toMatchObject({ agentKind: 'acp', providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-v4' });
        return {
          candidate: {
            agentKind: 'acp',
            agentDeviceId: null,
            model: 'gemini-3-pro',
            providerId: 'acp-plugin:agy:agy',
            effort: null,
            fastMode: false,
          },
          labels: { from: 'DeepSeek V4', to: 'Gemini 3 Pro · AGY' },
          bindCommittedRoute: (profile) => { committedCross.push(profile); },
        };
      },
      readSessionAgentDeviceId: async () => null,
      readSessionRuntimeFallbackSettings: () => ({ enabled: false }),
      getDesktopProviderService: vi.fn() as never,
      pendingSessionRuntimeFallbackRebuilds: new Map(),
      applySessionRuntimeSelection: vi.fn() as never,
      getPendingCredentialSwitchTarget: () => null,
      clearPendingCredentialSwitchForSession: vi.fn(),
      broadcastSessionRuntimeProjection: vi.fn(async () => {}),
      agentSwitchDeps: {} as never,
      performSessionAgentSwitch: performSessionAgentSwitch as never,
      runtimeSelectionRequiresModelWindowConfirmation: () => false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    const crossRes = await crossFallback('s-acp-cross', 1, 1, true, () => true, {
      accountUnavailable: true,
      retrySameSource: false,
      hasImages: false,
    });
    expect(crossRes).toMatchObject({ outcome: 'switched' });
    expect(performSessionAgentSwitch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 's-acp-cross',
        targetAgentKind: 'acp',
        providerId: 'acp-plugin:agy:agy',
        model: 'gemini-3-pro',
        applyNow: true,
      }),
    );
    expect(committedCross).toEqual([
      expect.objectContaining({ agentKind: 'acp', providerId: 'acp-plugin:agy:agy', model: 'gemini-3-pro' }),
    ]);

    const committedSame: FallbackRouteProfile[] = [];
    const applySessionRuntimeSelection = vi.fn(async () => ({
      deferred: false,
      superseded: false,
      persistedRoute: true as const,
      effectiveModelId: 'deepseek-r1',
      effectiveProviderId: 'acp-plugin:dsh:dsh',
    }));
    const sameFallback = createSessionRuntimeFallback({
      maker: { getSession: () => undefined, closeSession: vi.fn(async () => {}) },
      readSessionRuntimeProfiles: async () => null,
      canApplyAutomaticRuntimeSelection: () => true,
      readBotFallbackCandidate: async () => ({ isBot: false, candidate: null }),
      readModelGroupFallbackCandidate: async () => ({
        candidate: {
          agentKind: 'acp',
          agentDeviceId: null,
          model: 'deepseek-r1',
          providerId: 'acp-plugin:dsh:dsh',
          effort: null,
          fastMode: false,
        },
        labels: { from: 'DeepSeek V4', to: 'DeepSeek R1 · DSH' },
        bindCommittedRoute: (profile) => { committedSame.push(profile); },
      }),
      readSessionAgentDeviceId: async () => null,
      readSessionRuntimeFallbackSettings: () => ({ enabled: false }),
      getDesktopProviderService: vi.fn() as never,
      pendingSessionRuntimeFallbackRebuilds: new Map(),
      applySessionRuntimeSelection: applySessionRuntimeSelection as never,
      getPendingCredentialSwitchTarget: () => null,
      clearPendingCredentialSwitchForSession: vi.fn(),
      broadcastSessionRuntimeProjection: vi.fn(async () => {}),
      agentSwitchDeps: {} as never,
      performSessionAgentSwitch: vi.fn() as never,
      runtimeSelectionRequiresModelWindowConfirmation: () => false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    });

    const sameRes = await sameFallback('s-acp-same', 1, 1, true, () => true, {
      accountUnavailable: false,
      retrySameSource: false,
      hasImages: false,
    });
    expect(sameRes).toMatchObject({ outcome: 'switched' });
    expect(applySessionRuntimeSelection).toHaveBeenCalledWith(
      's-acp-same',
      'deepseek-r1',
      'acp-plugin:dsh:dsh',
      { effort: null, fastMode: false },
      expect.objectContaining({ source: 'fallback', sessionLockHeld: true }),
    );
    expect(committedSame).toEqual([
      expect.objectContaining({ agentKind: 'acp', providerId: 'acp-plugin:dsh:dsh', model: 'deepseek-r1' }),
    ]);
  });
});
