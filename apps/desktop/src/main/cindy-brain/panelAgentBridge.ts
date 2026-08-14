import type {
  GhostPanelAgentSendResult,
  GhostPanelAgentTargetResult,
} from '../../shared/ghostPanelAgent.js';
import type { GhostPipeAgentResult, GhostPipeConfirmResult } from '../../shared/ghost.js';

const PANEL_MESSAGE_PROMPT_TEMPLATE = '{{user_message}}';
const PANEL_CONTEXT_PROMPT_TEMPLATE =
  '{{user_message}}\n\n<plugin_panel_context>\n{{event_json}}\n</plugin_panel_context>';
const MAX_MESSAGE_CHARS = 16_384;
const MAX_CONTEXT_JSON_CHARS = 65_536;
const MAX_CONTEXT_DEPTH = 64;

export interface GhostPanelAgentBridgeDeps {
  panelContext(senderWebContentsId: number): {
    ghostId: string;
    hostWebContentsId: number;
  } | null;
  hasAgentPermission(ghostId: string): boolean;
  targetSessionId(hostWebContentsId: number): string | null;
  isInteractive(senderWebContentsId: number, hostWebContentsId: number): boolean;
  confirmSend(ghostId: string, message: string): Promise<GhostPipeConfirmResult>;
  issueUserActionToken(ghostId: string, sessionId: string): string | null;
  run(ghostId: string, payload: unknown): Promise<GhostPipeAgentResult>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLosslessJsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || depth > MAX_CONTEXT_DEPTH) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return false;
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isLosslessJsonValue(value[index], depth + 1, ancestors)) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) return false;
    return keys.every((key) =>
      isLosslessJsonValue((value as Record<string, unknown>)[key], depth + 1, ancestors),
    );
  } finally {
    ancestors.delete(value);
  }
}

function validateContext(value: unknown): boolean {
  if (!isLosslessJsonValue(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= MAX_CONTEXT_JSON_CHARS;
  } catch {
    return false;
  }
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
    const message = raw.message;
    const context = raw.context;
    const hasContext = context !== undefined && context !== null;
    if (hasContext && !validateContext(context)) {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: `context 必须是可无损表示且不超过 ${MAX_CONTEXT_JSON_CHARS} 字符的 JSON 值`,
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

    const confirmation = await this.deps.confirmSend(panel.ghostId, message);
    if (!confirmation.ok) {
      const errorCode =
        confirmation.errorCode === 'RATE_LIMITED' || confirmation.errorCode === 'BUSY'
          ? 'RATE_LIMITED'
          : confirmation.errorCode === 'UNAVAILABLE'
            ? 'HOST_NOT_READY'
            : confirmation.errorCode;
      return { ok: false, errorCode, message: confirmation.message };
    }
    if (!confirmation.confirmed) {
      return {
        ok: false,
        errorCode: 'USER_ACTION_REQUIRED',
        message: '用户取消了发送',
      };
    }

    // 确认框是异步边界：用户作答后重新确认 Guest 身份、插件资格和目标任务，
    // 防止在弹窗期间切换任务或卸载插件后把消息发到另一个会话。
    const confirmedPanel = this.deps.panelContext(senderWebContentsId);
    if (
      !confirmedPanel ||
      confirmedPanel.ghostId !== panel.ghostId ||
      confirmedPanel.hostWebContentsId !== panel.hostWebContentsId ||
      !this.deps.hasAgentPermission(panel.ghostId)
    ) {
      return denied();
    }
    if (this.deps.targetSessionId(panel.hostWebContentsId) !== sessionId) {
      return {
        ok: false,
        errorCode: 'NO_ACTIVE_SESSION',
        message: '确认期间当前任务已切换，请重新发送',
      };
    }
    const token = this.deps.issueUserActionToken(panel.ghostId, sessionId);
    if (!token) return denied();

    const result = await this.deps.run(panel.ghostId, {
      type: 'agent-request',
      mode: 'continue',
      trigger: 'user-action',
      promptTemplate: hasContext ? PANEL_CONTEXT_PROMPT_TEMPLATE : PANEL_MESSAGE_PROMPT_TEMPLATE,
      userMessage: message,
      event: hasContext ? context : null,
      userActionToken: token,
    });
    if (!result.ok) return result;
    return { ok: true, disposition: result.disposition };
  }
}
