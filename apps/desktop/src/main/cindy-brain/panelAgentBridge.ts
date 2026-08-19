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
const MAX_FINAL_PROMPT_CHARS = 65_536;
const MAX_CONTEXT_DEPTH = 64;
// 拒绝会改变视觉顺序或隐藏确认内容的控制字符；保留 tab/newline/CR
// 以及 emoji/文字成形所需的 ZWNJ/ZWJ。
const UNSAFE_CONFIRMATION_CONTROL_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

export interface GhostPanelAgentBridgeDeps {
  panelContext(senderWebContentsId: number): {
    ghostId: string;
    hostWebContentsId: number;
  } | null;
  hasAgentPermission(ghostId: string): boolean;
  targetSessionId(hostWebContentsId: number): string | null;
  isInteractive(senderWebContentsId: number, hostWebContentsId: number): boolean;
  confirmSend(
    ghostId: string,
    finalPrompt: string,
    hostWebContentsId: number,
    sessionId: string,
  ): Promise<GhostPipeConfirmResult>;
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

function serializeContext(value: unknown): string | null {
  if (!isLosslessJsonValue(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length <= MAX_CONTEXT_JSON_CHARS
      ? serialized
      : null;
  } catch {
    return null;
  }
}

/** 与 Agent Slot 的固定面板模板生成同一份最终 user prompt，供宿主逐字确认。 */
function panelFinalPrompt(message: string, contextJson: string | null): string {
  if (contextJson === null) return message;
  return `${message}\n\n<plugin_panel_context>\n${contextJson}\n</plugin_panel_context>`;
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
    // 确认框、Agent 和持久化共用同一份去除首尾空白的消息，
    // 避免前导空行把真实指令压到确认框首屏之外。
    const message = raw.message.trim();
    const context = raw.context;
    const hasContext = context !== undefined && context !== null;
    const contextJson = hasContext ? serializeContext(context) : null;
    if (hasContext && contextJson === null) {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: `context 必须是可无损表示且不超过 ${MAX_CONTEXT_JSON_CHARS} 字符的 JSON 值`,
      };
    }
    const finalPrompt = panelFinalPrompt(message, contextJson);
    if (finalPrompt.length > MAX_FINAL_PROMPT_CHARS) {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: `message 与 context 组合后不能超过 ${MAX_FINAL_PROMPT_CHARS} 字符`,
      };
    }
    if (UNSAFE_CONFIRMATION_CONTROL_RE.test(finalPrompt)) {
      return {
        ok: false,
        errorCode: 'INVALID_REQUEST',
        message: 'message 和 context 不能包含会伪装确认内容的隐藏或方向控制字符',
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

    const confirmation = await this.deps.confirmSend(
      panel.ghostId,
      finalPrompt,
      panel.hostWebContentsId,
      sessionId,
    );
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
