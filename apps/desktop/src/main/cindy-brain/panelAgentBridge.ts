import type {
  GhostPanelAgentSendRequest,
  GhostPanelAgentSendResult,
  GhostPanelAgentTargetResult,
} from '../../shared/ghostPanelAgent.js';
import type { GhostPipeAgentResult } from '../../shared/ghost.js';

const PANEL_MESSAGE_PROMPT_TEMPLATE = '{{user_message}}';
const PANEL_CONTEXT_PROMPT_TEMPLATE =
  '{{user_message}}\n\n<plugin_panel_context>\n{{event_json}}\n</plugin_panel_context>';
const MAX_MESSAGE_CHARS = 16_384;

export interface GhostPanelAgentBridgeDeps {
  panelContext(senderWebContentsId: number): {
    ghostId: string;
    hostWebContentsId: number;
  } | null;
  hasAgentPermission(ghostId: string): boolean;
  targetSessionId(hostWebContentsId: number): string | null;
  isInteractive(senderWebContentsId: number, hostWebContentsId: number): boolean;
  issueUserActionToken(ghostId: string, sessionId: string): string | null;
  run(ghostId: string, payload: unknown): Promise<GhostPipeAgentResult>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function denied(message = '插件未申请 Agent 新回合权限，或当前未启用') {
  return { ok: false, errorCode: 'PERMISSION_DENIED', message } as const;
}

/** 插件面板到当前任务的窄桥；Electron handler 只负责提供真实 sender id。 */
export class GhostPanelAgentBridge {
  constructor(private readonly deps: GhostPanelAgentBridgeDeps) {}

  getTarget(senderWebContentsId: number): GhostPanelAgentTargetResult {
    const panel = this.deps.panelContext(senderWebContentsId);
    if (!panel || !this.deps.hasAgentPermission(panel.ghostId)) return denied();
    return {
      ok: true,
      available: this.deps.targetSessionId(panel.hostWebContentsId) !== null,
    };
  }

  async send(senderWebContentsId: number, raw: unknown): Promise<GhostPanelAgentSendResult> {
    const panel = this.deps.panelContext(senderWebContentsId);
    if (!panel || !this.deps.hasAgentPermission(panel.ghostId)) return denied();
    if (!this.deps.isInteractive(senderWebContentsId, panel.hostWebContentsId)) {
      return denied('只有当前可见、聚焦的插件面板可以发送');
    }
    if (!isPlainObject(raw)) {
      return { ok: false, errorCode: 'INVALID_REQUEST', message: '请求必须是对象' };
    }
    const keys = Object.keys(raw);
    if (keys.some((key) => key !== 'message' && key !== 'context')) {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: '请求只允许 message 和 context 字段',
      };
    }
    if (
      typeof raw.message !== 'string' ||
      raw.message.trim().length === 0 ||
      raw.message.length > MAX_MESSAGE_CHARS
    ) {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: `message 必须是 1–${MAX_MESSAGE_CHARS} 字符的非空字符串`,
      };
    }

    const sessionId = this.deps.targetSessionId(panel.hostWebContentsId);
    if (!sessionId) {
      return {
        ok: false,
        errorCode: 'NO_ACTIVE_SESSION',
        message: '请先在 Cindy 中打开一个任务',
      };
    }
    const token = this.deps.issueUserActionToken(panel.ghostId, sessionId);
    if (!token) return denied();

    const request: GhostPanelAgentSendRequest = raw;
    const hasContext = request.context !== undefined && request.context !== null;
    const result = await this.deps.run(panel.ghostId, {
      type: 'agent-request',
      mode: 'continue',
      trigger: 'user-action',
      promptTemplate: hasContext ? PANEL_CONTEXT_PROMPT_TEMPLATE : PANEL_MESSAGE_PROMPT_TEMPLATE,
      userMessage: request.message,
      event: hasContext ? request.context : null,
      userActionToken: token,
    });
    if (!result.ok) return result;
    return { ok: true, disposition: result.disposition };
  }
}
