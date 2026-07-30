/**
 * apps/desktop/src/main/maker-host/maker-memory-host.ts
 *
 * Desktop 端 MakerMemoryManager 工厂. 负责注入 host-only 依赖:
 *  - sqliteFactory: better-sqlite3 实例化 (native module, 不能放 maker-core)
 *  - basePath: app.getPath('userData') (Electron API, 不能放 maker-core);
 *    manager 内部自己拼 'maker-memory' 子目录, 这里直传 userData 根
 *  - logger: LoggerAdapter 的 child scope
 *
 * 跟 createDesktopMcpProviders 的关系:
 *  manager 实例由本工厂创建后, 同时注入两处:
 *   1. agents 的 deps.makerMemory (agent 在 startSession 时拼 prompt + 创建 flush controller)
 *   2. createDesktopMcpProviders({ memory: { getManager } }) (cindy_memory MCP server 的写入路径)
 *  两处共享同一个 manager 引用, agents 跟 cindy_memory tool 看到的 enabled 状态一致。
 *
 * 鸡生蛋 (manager 需要 agents, agents 需要 manager):
 *  manager 构造期 agents 字段先传空 {}, 后续通过 attachAgents 补上 — 因为
 *  manager 的 agents 只在 enable() 时遍历, 构造期不需要它们就绪。
 */

import { app } from 'electron';
import path from 'node:path';

import {
  MakerMemoryManager,
  type AgentKind,
  type BaseAgent,
  type SqliteFactory,
} from '@cindy/maker-core';

import { desktopMakerLogger } from './logger-adapter.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';
import { readMemorySettings } from './memory-settings-store.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
import { dataOwnerStorageKey, getActiveAppSession } from '../appSessionState.js';

const sqliteFactory: SqliteFactory = (filePath) => {
  // better-sqlite3 sync open. WAL 让多 session 并发读写更稳, busyTimeout 防小撞锁。
  // Electron 运行时通过 factory 注入独立 native binding, 避免污染 Node/Vitest ABI。
  const db = createBetterSqliteDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

/**
 * 创建 desktop 用的 MakerMemoryManager 单例。
 * agents 参数允许后续 attach (因为 maker-host 装配时 agents 实例还没创建)。
 *
 * basePath 直传 userData 根; manager 内部自己拼 'maker-memory/<sanitized-workdir>/'
 * 子结构, host 不应该假设这个细节 (避免之前的双重叠加 bug)。
 */
export function createDesktopMakerMemoryManager(): MakerMemoryManager {
  const ownerId = getActiveAppSession().dataOwnerId;
  const basePath = ownerId
    ? path.join(app.getPath('userData'), 'owners', dataOwnerStorageKey(ownerId))
    : path.join(app.getPath('temp'), 'cindy-no-session', String(process.pid));
  return new MakerMemoryManager({
    basePath,
    sqliteFactory,
    agents: {}, // 占位, attachAgents 补上
    logger: desktopMakerLogger.child('maker-memory'),
    // 持久化 store 读 — 重启后保持用户上次设置，新用户默认开启。
    initialEnabled: readMemorySettings({ rootPath: basePath }).maker,
    reviewAgent: 'claude-code', // memory_review 用 claude haiku 最便宜
    // 停用轴:review 的 oneShot 是新的付费调用,默认 one-shot 路由被停用时不派发
    // (PR #744 review 第十六轮)。
    isOneShotRouteDisabled: (agent) => isAgentOneShotRouteDisabled(agent),
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
  manager.setAgents(agents);
}
