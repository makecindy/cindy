/**
 * SessionStorage — Session 元数据持久化抽象（host 注入）。
 *
 * desktop host：复用现有 apps/desktop/src/main/localDb/sessions 表。
 * CLI host：可以写 ~/.config/lizi-maker/sessions.json 或纯内存。
 */

import type { AgentKind, Effort, PermissionMode, WorkspaceKind } from '../types/common.js';

export interface SessionMeta {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  title: string;
  model: string;
  workspaceKind?: WorkspaceKind;
  effort?: Effort;
  permissionMode?: PermissionMode;
  fastMode?: boolean;
  /** Persist the host-owned Review purpose atomically with session creation. */
  reviewMode?: true;
  createdAt: number;
  updatedAt: number;
  /** SDK 内部生成的 sessionId（与本地 id 不同），用于 resume */
  sdkSessionId?: string;
  parentSessionId?: string;
  /**
   * 远端目标 host id (`@cindy/maker-remote-ssh` ConnectionPool 里的 alias)。
   * 不为空 = 这个 session 跑在远端机器上 (codex agent 进程在远端、workDir 是远端路径)。
   * 落地后, 应用重启 / session 切换都能记住该 session 的远端目标。
   * 仅 Codex 支持; Claude 暂忽略此字段。
   */
  remoteHostId?: string;
}
// 历史: 这里曾有 status: 'active'|'closed'|'error'。
// 这是 SDK 子进程的运行时瞬态, 不该持久化 —— 它跟 desktop DB 的产品语义 status
// ('active'|'archived'|'deleted') 名字撞车, 通过 storage adapter 写入时被错误地 coerce
// 成 'archived', 把正在运行的 session 误标归档。当前架构:
//   - 运行态: 内存 (Maker.activeSessions / Session.status / chatStore.runningSnapshot)
//   - 持久态: DB status 列, 由产品层 IPC 直接管, 与 maker-core 解耦

export interface SessionStorage {
  create(meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>): Promise<SessionMeta>;
  get(id: string): Promise<SessionMeta | null>;
  list(): Promise<SessionMeta[]>;
  update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta>;
  /** 仅当当前 vendor id 仍等于 expectedSdkSessionId 时原子清空，避免旧失败覆盖并发新值。 */
  compareAndClearSdkSessionId(id: string, expectedSdkSessionId: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}
