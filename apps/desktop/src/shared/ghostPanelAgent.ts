/** 插件面板最小 Agent 桥的固定 IPC 通道。面板不能自选通道或上报身份。 */
export const GHOST_PANEL_AGENT_TARGET_CHANNEL = 'ghost-panel:agent-target';
export const GHOST_PANEL_AGENT_SEND_CHANNEL = 'ghost-panel:agent-send';

/** 面板只能提交普通用户消息和可 JSON 化的结构化界面上下文。 */
export interface GhostPanelAgentSendRequest {
  message: string;
  context?: unknown;
}

export type GhostPanelAgentErrorCode =
  | 'INVALID_REQUEST'
  | 'PERMISSION_DENIED'
  | 'USER_ACTION_REQUIRED'
  | 'NO_ACTIVE_SESSION'
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'HOST_NOT_READY'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_UNAVAILABLE'
  | 'FORK_FAILED'
  | 'INTERNAL';

export type GhostPanelAgentTargetResult =
  | { ok: true; available: boolean }
  | { ok: false; errorCode: GhostPanelAgentErrorCode; message: string };

/** 面板不获得内部 sessionId；目标任务始终由 Host 在发送瞬间解析。 */
export type GhostPanelAgentSendResult =
  | { ok: true; disposition: 'created' | 'resumed' | 'active' | 'queued' | 'forked' }
  | { ok: false; errorCode: GhostPanelAgentErrorCode; message: string };
