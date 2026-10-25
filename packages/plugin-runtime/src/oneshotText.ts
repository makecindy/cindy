import type { AgentKind } from '@cindy/maker-core';
import { GHOST_ONESHOT_TEXT_MAX_PROMPT_CHARS, GHOST_ONESHOT_TEXT_TIMEOUT_MS, type InstalledGhost, type GhostPipeModelResult } from './shared/ghost.js';

type ModelSelection = { providerId?: string; agentKind: AgentKind; model: string };
type OneshotRoute = ModelSelection & { kind: 'catalog' };
export interface OneshotTextDeps {
  getGhost(id: string): InstalledGhost | null;
  getInflightLimit?(id: string): number | null;
  getOneshotModelSelection?(id: string): ModelSelection | null;
  resolveOneshotModel?(model: string): (ModelSelection & { providerId: string }) | null;
  oneshotText?(params: { prompt: string; maxTokens?: number; timeoutMs: number; route?: OneshotRoute }): Promise<
    { ok: true; text: string; model?: string } | { ok: false; reason: 'no_candidate' | 'timeout' | 'failed'; message: string }
  >;
  log?: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
}
const MAX_CALL_ID_LEN = 128;
function isPositiveIntWithin(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const m = /^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return m ? m[1].trim() : trimmed;
}

/** Same plugin capability, model pin and result contract on every host. */
export function createOneshotTextHandler(deps: OneshotTextDeps, counts = new Map<string, number>()) {
  return async (ghostId: string, payload: unknown): Promise<GhostPipeModelResult> => {
    const ghost = deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态', errorCode: 'PERMISSION_DENIED' };
    }
    if (!ghost.manifest.cindy) {
      return {
        ok: false,
        message: '本意识未声明 cindy 能力,无权请 Cindy 代办',
        errorCode: 'PERMISSION_DENIED',
      };
    }
    const declared: readonly string[] = ghost.manifest.cindy?.text ?? [];
    if (!declared.includes('oneshot')) {
      return {
        ok: false,
        message:
          '本意识未声明文本「快问快答」能力(身份卡 cindy.text 缺 "oneshot"),请意识作者更新声明',
        errorCode: 'PERMISSION_DENIED',
      };
    }
    const p = payload as {
      prompt?: unknown;
      expectJson?: unknown;
      maxTokens?: unknown;
      callId?: unknown;
    };
    if (typeof p.prompt !== 'string' || p.prompt.trim().length === 0) {
      return { ok: false, message: 'prompt 不能为空', errorCode: 'INVALID_PARAMS' };
    }
    if (p.prompt.length > GHOST_ONESHOT_TEXT_MAX_PROMPT_CHARS) {
      return {
        ok: false,
        message: `prompt 过长(上限 ${GHOST_ONESHOT_TEXT_MAX_PROMPT_CHARS} 字符)`,
        errorCode: 'INVALID_PARAMS',
      };
    }
    if (p.expectJson !== undefined && typeof p.expectJson !== 'boolean') {
      return { ok: false, message: 'expectJson 必须是布尔值(或不传)', errorCode: 'INVALID_PARAMS' };
    }
    // 插件显式传 maxTokens 只做基本正整数校验,不设实际上限——宿主不限制
    // 输出 token 数(与宿主会话一致,用户主动使用插件的成本由用户承担)。
    if (p.maxTokens !== undefined && !isPositiveIntWithin(p.maxTokens, Number.MAX_SAFE_INTEGER)) {
      return {
        ok: false,
        message: 'maxTokens 不合法(正整数,或不传)',
        errorCode: 'INVALID_PARAMS',
      };
    }
    if (
      p.callId !== undefined &&
      (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > MAX_CALL_ID_LEN)
    ) {
      return { ok: false, message: 'callId 不合法(1–128 字符的字符串,或不传)', errorCode: 'INVALID_PARAMS' };
    }
    const callId = (p.callId as string | undefined) ?? 'unattributed';
    const oneshot = deps.oneshotText;
    if (!oneshot) {
      return { ok: false, message: '主机当前不支持快问快答(能力未接线)', errorCode: 'INTERNAL' };
    }

    const inflight = counts.get(ghostId) ?? 0;
    const inflightLimit = deps.getInflightLimit?.(ghostId) ?? null;
    if (inflightLimit !== null && inflight >= inflightLimit) {
      return {
        ok: false,
        message: `同时进行的代办已达上限(${inflightLimit} 单),请稍后再试`,
        errorCode: 'RATE_LIMITED',
      };
    }
    counts.set(ghostId, inflight + 1);
    try {
      deps.log?.info('ghost cindy-request oneshot_text start', { ghostId, callId });
      const expectJson = p.expectJson === true;
      // JSON 期望用确定性代码拼进 prompt(不甩给链路侧自由发挥),校验也在
      // 本层做——链只负责"问一句答一句"。
      const prompt = expectJson
        ? `${p.prompt}\n\n(只输出 JSON 本体,不要任何解释、前后缀或代码围栏)`
        : p.prompt;
      // 选型优先级:用户在详情页选的模型 > 身份卡声明的偏好模型 > 系统辅助模型链。
      // 用户选的是一组完整的 供应商×agent×模型,钉死不回落(失败如实返回,不悄悄
      // 换链路烧钱);声明解析不到(目录没有/已停用/不可路由)按未声明处理。
      // 每单现读,不缓存:系统辅助模型改动后,跟随默认的插件下一单即跟随。
      const selected = deps.getOneshotModelSelection?.(ghostId) ?? null;
      let route: OneshotRoute | undefined;
      if (selected) {
        route = { kind: 'catalog', ...selected };
      } else {
        const declaredModel = ghost.manifest.cindy?.oneshotModel;
        const resolved = declaredModel ? deps.resolveOneshotModel?.(declaredModel) : null;
        if (resolved) route = { kind: 'catalog', ...resolved };
      }
      const outcome = await oneshot({
        prompt,
        // 缺省不设输出上限:各供应商/模型按自然输出,60s 超时是实际边界;
        // 插件可显式传 maxTokens 自限(1–81920)。(2026-08-07:曾给缺省加
        // 81920,但 Codex / OpenAI 路径无法落实该参数,撤回为无上限设计。)
        maxTokens: p.maxTokens as number | undefined,
        timeoutMs: GHOST_ONESHOT_TEXT_TIMEOUT_MS,
        route,
      });
      if (!outcome.ok) {
        const errorCode =
          outcome.reason === 'no_candidate'
            ? 'NO_CANDIDATE'
            : outcome.reason === 'timeout'
              ? 'TIMEOUT'
              : 'INTERNAL';
        deps.log?.warn('ghost cindy-request oneshot_text failed', {
          ghostId,
          callId,
          reason: outcome.reason,
        });
        return { ok: false, message: outcome.message, errorCode };
      }
      let text = outcome.text;
      if (expectJson) {
        const cleaned = stripJsonFences(text);
        try {
          JSON.parse(cleaned);
          text = cleaned;
        } catch {
          // 不落原始输出(内容敏感度);长度足够让插件侧 fallback_detail 与
          // 日志对得上同一次调用。
          deps.log?.warn('ghost cindy-request oneshot_text bad json', {
            ghostId,
            callId,
            chars: text.length,
          });
          return {
            ok: false,
            errorCode: 'BAD_MODEL_OUTPUT',
            message: `模型未按 JSON 输出(原始输出开头:${text.slice(0, 200)})`,
          };
        }
      }
      deps.log?.info('ghost cindy-request oneshot_text done', {
        ghostId,
        callId,
        chars: text.length,
      });
      return { ok: true, text, ...(outcome.model !== undefined ? { model: outcome.model } : {}) };
    } finally {
      const left = (counts.get(ghostId) ?? 1) - 1;
      if (left <= 0) counts.delete(ghostId);
      else counts.set(ghostId, left);
    }
  };
}
