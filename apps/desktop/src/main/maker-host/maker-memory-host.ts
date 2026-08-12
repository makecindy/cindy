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
import {
  dataOwnerStorageKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';

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
 *
 * 修复 #2341 (owner 静默降级到 %TEMP%\cindy-no-session):
 *  - basePath 不再在构造时冻结 —— 通过 resolveBasePath 每次访问时按
 *    getActiveAppSession().dataOwnerId 现取; owner 未就绪 (signed-out / 认证
 *    未落定) 返回 null, manager 将 fail-closed 抛 MAKER_MEMORY_NOT_READY,
 *    绝不写临时目录。
 *  - ownerScopeKey 注入脱敏作用域键 (mode + owner hash + generation), 登录/
 *    登出/切账号 (commit 使 generation+1) 后 manager 自动关闭旧 store 重建新根。
 */
export function createDesktopMakerMemoryManager(): MakerMemoryManager {
  // owner 存储根: 有 owner → userData/owners/<hash>; 无 owner → null (fail-closed,
  // 不再退到 %TEMP%\cindy-no-session\<pid>\, 那是 #2341 静默丢失的根源)。
  const resolveBasePath = (): string | null => {
    // 会话边界窗口 (beginAppSessionBoundary 已调、commitActiveAppSession 未落定)
    // 期间 getActiveAppSession() 仍返回旧 owner — 此时也必须 fail-closed,
    // 否则边界期读写会继续落旧账号 (review #2388 P1)。
    if (isAppSessionBoundaryPending()) return null;
    const ownerId = getActiveAppSession().dataOwnerId;
    if (!ownerId) return null;
    return path.join(app.getPath('userData'), 'owners', dataOwnerStorageKey(ownerId));
  };
  // 脱敏作用域键: owner id 经 sha256 前 20 hex 隐藏, 日志可直接记录。
  // 追加 boundary 位 (review #2388 第二轮 P1): beginAppSessionBoundary() 后、
  // commitActiveAppSession() 前 getActiveAppSession() 仍返回旧 owner —— 若 key
  // 不含 boundary 状态, 已捕获 scopeAtEntry 的在途异步操作跨 await 复核会放行,
  // 把旧 owner store 缓存入池。追加 ':boundary' 后 boundary 开始即 key 变化,
  // 所有在途操作复核必失败, fail-closed 到新 commit。
  const ownerScopeKey = (): string => {
    const session = getActiveAppSession();
    const ownerSegment = session.dataOwnerId ? dataOwnerStorageKey(session.dataOwnerId) : 'none';
    const boundary = isAppSessionBoundaryPending() ? ':boundary' : '';
    return `${session.mode}:${ownerSegment}:${session.generation}${boundary}`;
  };
  // 构造时快照仅用于 initialEnabled 读取与日志; 运行期以 resolveBasePath 为准。
  const basePath = resolveBasePath();
  return new MakerMemoryManager({
    basePath: basePath ?? app.getPath('userData'),
    resolveBasePath,
    ownerScopeKey,
    // owner 作用域变化（首次解析 / 换根）后按新 owner 根重新读取 enabled —
    // 修复冷启动竞态里 initialEnabled 冻结为全局默认、owner 就绪后不重绑定的
    // 问题 (review #2388 Codex 4th P1)。
    reloadEnabled: () =>
      readMemorySettings({ rootPath: resolveBasePath() ?? undefined }).maker,
    sqliteFactory,
    agents: {}, // 占位, attachAgents 补上
    logger: desktopMakerLogger.child('maker-memory'),
    // 持久化 store 读 — 重启后保持用户上次设置，新用户默认开启。
    // owner 未就绪时读全局 userData 默认 (不读 temp 一次性目录)。
    initialEnabled: readMemorySettings({ rootPath: basePath ?? undefined }).maker,
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
