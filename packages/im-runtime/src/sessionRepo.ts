import type { IdentityKey } from "@cindy/im";
import type { AgentKind, Effort, PermissionMode } from "@cindy/maker-core";
import type { ProviderView } from "@cindy/model-providers";

export function toCoreAgentKind(kind: string): AgentKind {
  return kind === "codex" || kind === "pi" ? kind : "claude-code";
}

export interface ImSessionRow {
  agentDeviceId?: string | null;
  id: string;
  agentKind: AgentKind;
  workingDir: string;
  model: string;
  /** Latest persisted effort (may be changed by user via /model card later). */
  effort: Effort;
  /** Latest persisted permission mode. */
  permissionMode: PermissionMode;
  fastMode: boolean | "ultrafast";
  sdkSessionId: string | null;
  /** Non-empty means workingDir and Agent file paths live on an SSH host. */
  remoteHostId?: string | null;
  /**
   * 该会话显式选定的供应商 id(路由用,null = 跟随默认路由)。/model 卡片选行时一并持久化,
   * IM turn 启动前 hydrate 进 session-provider-store,保证按选中供应商路由。
   */
  providerId: string | null;
  /**
   * 该会话的归属分组。`dialogue` = 托管目录里的临时对话, 它的目录末段是内部
   * 名字(UUID / `telegram-<botId>`), **不是项目名**。
   *
   * schema 里 workspaceKind 与路径是解耦的 —— 只比对目录等于不等于渠道托管目录
   * 判不出来(接管一条 desktop 的 dialogue 会话时路径根本不是渠道自己那条)。
   * 只读路径按需带出, 建会话路径不填(那时归属由 ns.workspaceKind 决定)。
   */
  workspaceKind?: "project" | "dialogue" | null;
  /**
   * 仅 prepareNewSession 产出的行带: 解析这组默认值时所读渠道设置的指纹。
   * 建任务 / `/new` 把它连同路由写进 `im_default_route`(跟随记录)。
   */
  defaultRouteFingerprint?: string;
}

export interface SessionModelRouteSnapshot {
  agentDeviceId?: string | null;
  model: string;
  effort: Effort;
  providerId: string | null;
}

/** 渠道维度的 session 查找/创建仓库 — per adapter 一个实例。 */
export interface ImSessionRepo {
  sessionIdFor(botContextId: string, userId: string, scopeKey?: string): string;
  findActiveSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<ImSessionRow | null>;
  /**
   * 纯只读地看一眼这对身份的通道行 —— **不创建、不复活、不广播**。
   *
   * findActiveSession 会把软删行翻回 active 并广播 created(用户从 IM 侧继续
   * 发消息就该恢复对话)。那对「发消息」是对的, 对只读查询就是副作用: 问一句
   * 「我现在什么配置」不该把用户已删的会话拉回列表。
   *
   * 软删行照样返回它的配置 —— 用户下次发消息复活的正是这一行、沿用的正是这份
   * 设置, 报默认值反而误导。
   */
  peekSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<ImSessionRow | null>;
  /**
   * 按 session id 只读一行 —— `/ctr` 接管期间要读的是**被接管的 desktop 会话**,
   * 它的 id 不由 `sessionIdFor` 推得出来。同样不创建、不复活、不广播。
   *
   * `workingDir` 为空视为无效(binding 指向的行已被删/数据异常), 返回 null 让
   * 调用方回落到渠道自身的会话 —— 与 turnRunner 命中无效 binding 时的落点一致。
   */
  peekSessionById(sessionId: string): Promise<ImSessionRow | null>;
  prepareNewSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    providerSnapshot?: ProviderView[] | null,
  ): Promise<ImSessionRow>;
  createSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    prepared?: ImSessionRow,
  ): Promise<ImSessionRow>;
  /**
   * Create a distinct task from current channel defaults, then retire the
   * previous channel-native task. Only namespaces with createTaskOnNew opt in.
   */
  createFreshSession?(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    prepared?: ImSessionRow,
    detachBinding?: { identity: IdentityKey; targetSessionId: string } | null,
  ): Promise<{ current: ImSessionRow; previous: ImSessionRow | null }>;
  /**
   * 该渠道语境下 model 的默认 effort:
   *   1. config.effortOverrides[modelId] — IM 产品决策
   *   2. ModelDescriptor.defaultEffort — agent 自身推荐
   *   3. 'high' — DB NOT NULL 兜底(到这说明上游有 bug)
   */
  getDefaultEffortFor(modelId: string, agentKind?: AgentKind): Effort;
}
