/**
 * agentSlot — 插件请求 Cindy Agent 新回合的主机守门层。
 *
 * 安全边界：
 * - 插件必须在 ghost.json 声明 `agent` 槽；
 * - 常规调用必须消费真实卡片点击签发的一次性票据，票据绑定 ghost + session；
 * - 后台调用必须额外声明 `agent.background`，且只能访问真人曾为该插件点击过的会话；
 * - 插件模板只会成为普通 user 消息，绝不进入 system prompt；
 * - 模板替换、长度限制、单次消费和并发限制全部由主机执行。
 *
 * 真正的 session 创建 / fork / 排队通过 runner 注入，避免本模块反向依赖
 * maker-ipc。这样规则可单测，Electron handler 只做身份反查和转发。
 */

import { randomUUID } from 'node:crypto';

import {
  GHOST_AGENT_RUN_MODES,
  GHOST_AGENT_TRIGGER_KINDS,
  type GhostAgentRunMode,
  type GhostPipeAgentResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

const USER_MESSAGE_PLACEHOLDER = '{{user_message}}';
const TOKEN_TTL_MS = 2 * 60_000;
const MAX_LIVE_TOKENS = 256;
const MAX_TEMPLATE_CHARS = 32_768;
const MAX_USER_MESSAGE_CHARS = 16_384;
const MAX_EVENT_JSON_CHARS = 65_536;
const MAX_FINAL_PROMPT_CHARS = 65_536;
const BACKGROUND_MIN_INTERVAL_MS = 10_000;
const MAX_SESSIONS_PER_GHOST = 128;

interface UserActionGrant {
  ghostId: string;
  sessionId: string;
  expiresAt: number;
}

export interface GhostAgentTurnRunRequest {
  ghostId: string;
  ghostVersion: string;
  sourceSessionId: string;
  mode: GhostAgentRunMode;
  prompt: string;
  persistedContent: string;
  title?: string;
}

export type GhostAgentTurnRunResult =
  | {
      ok: true;
      sessionId: string;
      disposition: 'created' | 'resumed' | 'active' | 'queued' | 'forked';
    }
  | {
      ok: false;
      errorCode: string;
      message: string;
    };

export type GhostAgentTurnRunner = (
  request: GhostAgentTurnRunRequest,
) => Promise<GhostAgentTurnRunResult>;

export interface GhostAgentSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  runner?: GhostAgentTurnRunner | null;
  now?: () => number;
  createToken?: () => string;
  log?: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /**
   * 执行落到一条可见任务时，由主机把左侧切过去。
   * 只对 user-action 调用 — 后台 continue/new/fork 不能抢当前任务。
   */
  onRevealSession?: (sessionId: string) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): GhostPipeAgentResult {
  return { ok: false, errorCode: 'INVALID_REQUEST', message };
}

/** 插件 Agent 回合的权限、模板和一次性票据守门器。 */
export class GhostAgentSlot {
  private readonly grants = new Map<string, UserActionGrant>();
  private readonly associatedSessions = new Map<string, Set<string>>();
  private readonly inFlightGhosts = new Set<string>();
  private readonly lastBackgroundAt = new Map<string, number>();
  private runner: GhostAgentTurnRunner | null;
  private onRevealSession: ((sessionId: string) => void) | null;

  constructor(private readonly deps: GhostAgentSlotDeps) {
    this.runner = deps.runner ?? null;
    this.onRevealSession = deps.onRevealSession ?? null;
  }

  /** maker-ipc 初始化完成后注入真实 session runner；传 null 用于退出清理。 */
  setRunner(runner: GhostAgentTurnRunner | null): void {
    this.runner = runner;
  }

  /** maker-ipc 初始化完成后注入任务聚焦；传 null 用于退出清理。 */
  setRevealSession(reveal: ((sessionId: string) => void) | null): void {
    this.onRevealSession = reveal;
  }

  /** 插件停用/卸载时清除该 ghost 的所有会话关联和节流状态，防止权限残留。 */
  clearGhost(ghostId: string): void {
    this.associatedSessions.delete(ghostId);
    this.lastBackgroundAt.delete(ghostId);
    // 活票同清:旧包代码已拿到的点击通行票不得跨更新/重装被新装入的
    // 同 id 包继续消费(票据 TTL 两分钟,窗口虽小但语义必须干净)。
    for (const [token, grant] of this.grants) {
      if (grant.ghostId === ghostId) this.grants.delete(token);
    }
  }

  /**
   * 为一次已由宿主验证的真实卡片点击签发通行票。
   * 没有会话归属或插件未申请 agent 槽时不签发。
   */
  issueUserActionToken(ghostId: string, sessionId: string | null): string | null {
    if (!sessionId) return null;
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.agent) return null;

    this.sweepExpiredGrants();
    while (this.grants.size >= MAX_LIVE_TOKENS) {
      const oldest = this.grants.keys().next().value as string | undefined;
      if (!oldest) break;
      this.grants.delete(oldest);
    }

    const token = (this.deps.createToken ?? randomUUID)();
    this.grants.set(token, {
      ghostId,
      sessionId,
      expiresAt: this.now() + TOKEN_TTL_MS,
    });
    let sessions = this.associatedSessions.get(ghostId);
    if (!sessions) {
      sessions = new Set<string>();
      this.associatedSessions.set(ghostId, sessions);
    }
    if (sessions.size >= MAX_SESSIONS_PER_GHOST) {
      const oldest = sessions.values().next().value as string | undefined;
      if (oldest) sessions.delete(oldest);
    }
    sessions.add(sessionId);
    return token;
  }

  /** 消费卡片点击票。派活切任务与 agent.run 共用，一次作废。 */
  consumeUserActionToken(token: string, ghostId: string): boolean {
    const peeked = this.peekGrant(token, ghostId);
    if (!peeked.ok) return false;
    this.grants.delete(token);
    return true;
  }

  /** 处理电子脑的 agent-request；所有失败都折叠成结构化返回。 */
  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeAgentResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.agent) {
      return {
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: '插件未申请 Agent 新回合权限，或当前未启用',
      };
    }
    if (!isPlainObject(payload) || payload.type !== 'agent-request') {
      return invalid('agent-request 载荷必须是对象');
    }

    const mode = payload.mode;
    if (typeof mode !== 'string' || !(GHOST_AGENT_RUN_MODES as readonly string[]).includes(mode)) {
      return invalid(`mode 必须是 ${GHOST_AGENT_RUN_MODES.join(' / ')}`);
    }
    const trigger = payload.trigger ?? 'user-action';
    if (
      typeof trigger !== 'string' ||
      !(GHOST_AGENT_TRIGGER_KINDS as readonly string[]).includes(trigger)
    ) {
      return invalid(`trigger 必须是 ${GHOST_AGENT_TRIGGER_KINDS.join(' / ')}`);
    }
    if (
      typeof payload.promptTemplate !== 'string' ||
      payload.promptTemplate.length === 0 ||
      payload.promptTemplate.length > MAX_TEMPLATE_CHARS
    ) {
      return invalid(`promptTemplate 必须是 1–${MAX_TEMPLATE_CHARS} 字符的字符串`);
    }
    const placeholderCount = payload.promptTemplate.split(USER_MESSAGE_PLACEHOLDER).length - 1;
    if (placeholderCount !== 1) {
      return invalid(`promptTemplate 必须且只能包含一次 ${USER_MESSAGE_PLACEHOLDER}`);
    }
    if (
      typeof payload.userMessage !== 'string' ||
      payload.userMessage.length > MAX_USER_MESSAGE_CHARS
    ) {
      return invalid(`userMessage 必须是 ≤${MAX_USER_MESSAGE_CHARS} 字符的字符串`);
    }
    const userMessage = payload.userMessage;
    if (
      payload.title !== undefined &&
      (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 100)
    ) {
      return invalid('title 必须是 1–100 字符的字符串');
    }

    let eventJson: string;
    try {
      eventJson = JSON.stringify(payload.event ?? null);
    } catch {
      return invalid('event 必须可以转换成 JSON');
    }
    if (eventJson.length > MAX_EVENT_JSON_CHARS) {
      return invalid(`event 转成 JSON 后不能超过 ${MAX_EVENT_JSON_CHARS} 字符`);
    }

    // 只扫描作者写下的模板一次。若用户文字本身刚好包含 {{event_json}}，
    // 不能把用户原文里的这几个字再次当成模板占位符改掉。
    const prompt = payload.promptTemplate.replace(
      /\{\{user_message\}\}|\{\{event_json\}\}/g,
      (placeholder) =>
        placeholder === USER_MESSAGE_PLACEHOLDER ? userMessage : eventJson,
    );
    if (prompt.length > MAX_FINAL_PROMPT_CHARS) {
      return invalid(`最终发送内容不能超过 ${MAX_FINAL_PROMPT_CHARS} 字符`);
    }

    let sourceSessionId: string;
    if (trigger === 'user-action') {
      if (typeof payload.userActionToken !== 'string' || payload.userActionToken.length > 128) {
        return {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: '需要使用本次用户点击产生的一次性通行票',
        };
      }
      const grant = this.peekGrant(payload.userActionToken, ghostId);
      if (!grant.ok) return grant.result;
      sourceSessionId = grant.grant.sessionId;
    } else {
      if (ghost.manifest.agent?.background !== true) {
        return {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: '插件没有后台唤起 Agent 的权限',
        };
      }
      if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0 || payload.sessionId.length > 128) {
        return invalid('后台触发必须提供合法的 sessionId');
      }
      if (!this.associatedSessions.get(ghostId)?.has(payload.sessionId)) {
        return {
          ok: false,
          errorCode: 'PERMISSION_DENIED',
          message: '该会话尚未由用户为此插件建立关联',
        };
      }
      const last = this.lastBackgroundAt.get(ghostId) ?? 0;
      if (this.now() - last < BACKGROUND_MIN_INTERVAL_MS) {
        return {
          ok: false,
          errorCode: 'RATE_LIMITED',
          message: '后台唤起太频繁，请稍后再试',
        };
      }
      sourceSessionId = payload.sessionId;
    }

    if (this.inFlightGhosts.has(ghostId)) {
      return {
        ok: false,
        errorCode: 'RATE_LIMITED',
        message: '这个插件已有一条 Agent 请求正在处理',
      };
    }
    if (!this.runner) {
      return {
        ok: false,
        errorCode: 'HOST_NOT_READY',
        message: 'Agent 会话服务尚未准备好',
      };
    }

    // 所有输入与主机可用性检查通过后才消费票据；runner 失败也不退票，
    // 防止插件利用重试把一次点击放大成多次 Agent 回合。
    if (trigger === 'user-action') this.grants.delete(payload.userActionToken as string);
    else this.lastBackgroundAt.set(ghostId, this.now());

    const persistedContent = JSON.stringify({
      text: prompt,
      ghostAgent: {
        schemaVersion: 1,
        ghostId,
        ghostVersion: ghost.manifest.version,
        mode,
        trigger,
        promptTemplate: payload.promptTemplate,
        userMessage,
        eventJson,
      },
    });

    this.inFlightGhosts.add(ghostId);
    try {
      const result = await this.runner({
        ghostId,
        ghostVersion: ghost.manifest.version,
        sourceSessionId,
        mode: mode as GhostAgentRunMode,
        prompt,
        persistedContent,
        ...(typeof payload.title === 'string' ? { title: payload.title.trim() } : {}),
      });
      if (!result.ok) return this.mapRunnerFailure(result);
      this.deps.log?.info('ghost agent turn accepted', {
        ghostId,
        sourceSessionId,
        targetSessionId: result.sessionId,
        mode,
        trigger,
        disposition: result.disposition,
      });
      this.maybeRevealSession(trigger, mode as GhostAgentRunMode, result.sessionId);
      return {
        ok: true,
        sessionId: result.sessionId,
        mode: mode as GhostAgentRunMode,
        disposition: result.disposition,
      };
    } catch (err) {
      this.deps.log?.warn('ghost agent runner failed', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, errorCode: 'INTERNAL', message: 'Agent 回合启动失败' };
    } finally {
      this.inFlightGhosts.delete(ghostId);
    }
  }

  private maybeRevealSession(
    trigger: string,
    _mode: GhostAgentRunMode,
    sessionId: string,
  ): void {
    // 只认用户当次点击。后台 new/fork 也会开可见任务，但不能抢前台。
    if (trigger !== 'user-action') return;
    try {
      this.onRevealSession?.(sessionId);
    } catch {
      // 聚焦失败不能让已经成功的回合对插件变失败。
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sweepExpiredGrants(): void {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }

  private peekGrant(
    token: string,
    ghostId: string,
  ):
    | { ok: true; grant: UserActionGrant }
    | { ok: false; result: GhostPipeAgentResult } {
    const grant = this.grants.get(token);
    if (!grant) {
      return {
        ok: false,
        result: { ok: false, errorCode: 'TOKEN_EXPIRED', message: '通行票不存在、已用过或已过期' },
      };
    }
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(token);
      return {
        ok: false,
        result: { ok: false, errorCode: 'TOKEN_EXPIRED', message: '通行票已过期，请重新点击' },
      };
    }
    if (grant.ghostId !== ghostId) {
      return {
        ok: false,
        result: { ok: false, errorCode: 'PERMISSION_DENIED', message: '通行票不属于这个插件' },
      };
    }
    return { ok: true, grant };
  }

  private mapRunnerFailure(result: Extract<GhostAgentTurnRunResult, { ok: false }>): GhostPipeAgentResult {
    const code = result.errorCode;
    if (code === 'HOST_NOT_READY' || code === 'AGENT_NOT_READY') {
      return { ok: false, errorCode: 'HOST_NOT_READY', message: result.message };
    }
    if (code === 'NOT_FOUND') {
      return { ok: false, errorCode: 'SESSION_NOT_FOUND', message: result.message };
    }
    if (code.startsWith('FORK_') || code === 'SOURCE_NEVER_RAN' || code === 'NO_PRIOR_ASSISTANT') {
      return { ok: false, errorCode: 'FORK_FAILED', message: result.message };
    }
    if (code === 'ARCHIVED' || code === 'DELETED' || code === 'BUSY') {
      return { ok: false, errorCode: 'SESSION_UNAVAILABLE', message: result.message };
    }
    return { ok: false, errorCode: 'INTERNAL', message: result.message };
  }
}
