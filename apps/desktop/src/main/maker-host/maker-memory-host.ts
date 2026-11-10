/**
 * apps/desktop/src/main/maker-host/maker-memory-host.ts
 *
 * Desktop adapter for the shared Maker Memory host wiring: it supplies the
 * Electron-backed facts (userData path, live app session, settings, Bot Home,
 * sqlite factory) and maker-core owns the composition.
 *
 * 鸡生蛋 (manager 需要 agents, agents 需要 manager):
 *  manager 构造期 agents 字段先传空 {}, 后续通过 attachAgents 补上 — 因为
 *  manager 的 agents 只在 enable() 时遍历, 构造期不需要它们就绪。
 */

import {
  attachAgentsToMakerMemory as attachSharedAgents,
  createMakerMemoryManagerForHost,
  type MakerMemoryManager,
  type AgentKind,
  type BaseAgent,
  type MakerMemoryManagerDeps,
  type SqliteFactory,
} from '@cindy/maker-core';

import { app } from 'electron';

import { desktopMakerLogger } from './logger-adapter.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';
import { readMemorySettings } from './memory-settings-store.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
import {
  dataOwnerStorageKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { botProfileMemoryDir } from '../maker-ipc/botProfileFolder.js';

const sqliteFactory: SqliteFactory = (filePath) => {
  // better-sqlite3 sync open. WAL 让多 session 并发读写更稳, busyTimeout 防小撞锁。
  // Electron 运行时通过 factory 注入独立 native binding, 避免污染 Node/Vitest ABI。
  const db = createBetterSqliteDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

/** Desktop 端 MakerMemoryManager 工厂；composition 由 maker-core 共享实现。 */
export function createDesktopMakerMemoryManager(
  options: { reviewOneShot?: MakerMemoryManagerDeps['reviewOneShot'] } = {},
): MakerMemoryManager {
  return createMakerMemoryManagerForHost({
    userDataDir: app.getPath('userData'),
    readSession: () => {
      const session = getActiveAppSession();
      return {
        dataOwnerId: session.dataOwnerId,
        generation: session.generation,
        mode: session.mode,
        boundaryPending: isAppSessionBoundaryPending(),
      };
    },
    ownerSegment: (ownerId) => dataOwnerStorageKey(ownerId),
    readEnabled: (ownerRoot) => readMemorySettings({ rootPath: ownerRoot ?? undefined }).maker,
    sqliteFactory,
    logger: desktopMakerLogger.child('maker-memory'),
    botMemoryDir: botProfileMemoryDir,
    isOneShotRouteDisabled: (agent) => isAgentOneShotRouteDisabled(agent),
    reviewAgent: 'claude-code',
    ...(options.reviewOneShot ? { reviewOneShot: options.reviewOneShot } : {}),
  });
}

/**
 * 把 agents 实例 attach 到 manager — 装配顺序: manager 先建 (agents={}) → agents 创建时
 * 拿 manager 引用 → 最后 attachAgents 把 agents 挂回。
 *
 * manager.setAgents 是一次性 bootstrap setter, 不应该在运行期改。
 */
export function attachAgentsToMakerMemory(
  manager: MakerMemoryManager,
  agents: Partial<Record<AgentKind, BaseAgent>>,
): void {
  attachSharedAgents(manager, agents);
}
