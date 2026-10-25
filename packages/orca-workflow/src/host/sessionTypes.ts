import type { CreateSessionOptions } from '@cindy/maker-core';

export interface MakerSessionCreateOpts extends CreateSessionOptions {
  orcaRole?: 'lead' | 'worker' | null;
  /**
   * Codex-only escape hatch for tests / special callers. Normal desktop paths
   * leave this undefined; Maker lifecycle hooks read the DB bit for every
   * maker.createSession caller (IPC / scheduler / Feishu).
   */
  codexHistoryHasProductPrompt?: boolean;
  /**
   * 用户级 system prompt 末段；renderer 的 userPromptStore 来源，不写 DB。
   * 仅 lazy-create 那一次生效，已 spawn 的 session 走 maker.getSession 直送，
   * 自然忽略此字段。
   */
  userPrompt?: string;
  /**
   * Maker Memory 启用 flag。跟 userPrompt 同语义：老 session 维持启动时快照，
   * 不 hot-reload。
   */
  makerMemoryEnabled?: boolean;
  /**
   * 附加只读引用目录列表。Claude 透传到 SDK additionalDirectories；
   * Codex 透传到 app-server runtimeWorkspaceRoots + 只读 permission profile。
   * main 端仍统一校验，防 IPC 直调 / 老 DB 残留 / bug 数据。
   */
  extraDirs?: string[];
  /** 用户逐目录明确授予的附加可读写目录；不从 extraDirs 推导。 */
  writableDirs?: string[];
  /**
   * 远端目标 host id。非空表示 session 跑在远端机器上，workingDir 必须是远端路径。
   * 目前仅 Codex 支持，Claude session 会忽略。
   */
  remoteHostId?: string;
  /** Agent 在同账号另一台电脑上运行时那台电脑的 deviceId(任务与文件仍在本机)。 */
  agentDeviceId?: string;
  /**
   * per-session 来源(供应商)显式选择。device-link 远程 create 由控制端透传被控端供应商 id
   * (见 deviceLinkCreateArgs);bootstrapSession 据此把 sessions.provider_id 落库,使新会话首个
   * 请求即按所选来源路由。本机交互建会话不经此路径(走 sessionService→sessionCreateToRow 落盘),
   * scheduler / Feishu 不传 → 不写(provider_id 留 NULL = 默认路由);Orca Worker 会传入
   * 已解析的来源,保证 Worker 与其模型选择使用同一条凭证路由。
   */
  providerId?: string | null;
  [key: string]: unknown;
}

