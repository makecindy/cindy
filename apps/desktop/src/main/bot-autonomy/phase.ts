/**
 * 伙伴自主跟进 · 层 0：状态推导（纯函数，不碰 IO / 模型）。
 *
 * 本机任务的事实来源：灵动岛活动快照（运行 / 等交互 / 完成 / 出错）、输入协调器投影
 * （出错横幅 / 用量上限等待）。远程电脑来源：`maker:list-active` v2 的活动相位。
 * 规则见 docs/product-rules/cindy-bots-runtime.md §6.3。
 */
import type { WatchedPhase } from '../../shared/botAutonomy.js';

/** 一句话摘要上限（等你 / 出错），与契约 `pendingQuestion ≤ 140` 一致。 */
export const SUMMARY_MAX_CHARS = 140;

export interface LocalPhaseFacts {
  /** 灵动岛 canonical 活动相位；没有条目（空闲）时为 null。 */
  activityPhase: string | null;
  interactionKind?: string | null;
  /** 输入协调器投影：本轮出错（横幅）文案存在与否。 */
  inputError: boolean;
  /** 输入协调器投影：撞上用量上限、正在等待重置。 */
  usageLimitWait: boolean;
}

/** 活动相位 → 跟进相位。用量上限优先：它也会以 error 呈现，但宿主已在等待自动继续。 */
export function deriveLocalPhase(facts: LocalPhaseFacts): WatchedPhase {
  if (facts.usageLimitWait) return 'usage-limit';
  switch (facts.activityPhase) {
    case 'running':
      return 'running';
    case 'needs-interaction':
      return facts.interactionKind === 'permission' ? 'waiting-permission' : 'waiting-answer';
    case 'error':
      return 'errored';
    case 'completed':
      return facts.inputError ? 'errored' : 'finished';
    default:
      return facts.inputError ? 'errored' : 'idle';
  }
}

/**
 * 远程电脑的活动只有相位与是否在跑（`maker:list-active` v2）。等交互的种类要另读挂起交互，
 * 读不到时按「等回答」处理；旧被控端不带 activityPhase 时只能从 isTurnRunning 判断在跑与否。
 */
export function deriveRemotePhase(row: {
  isTurnRunning?: unknown;
  activityPhase?: unknown;
  interactionKind?: string | null;
}): WatchedPhase {
  const phase = typeof row.activityPhase === 'string' ? row.activityPhase : null;
  if (phase === null) return row.isTurnRunning === true ? 'running' : 'idle';
  return deriveLocalPhase({
    activityPhase: phase,
    interactionKind: row.interactionKind ?? null,
    inputError: false,
    usageLimitWait: false,
  });
}

/** 相位变化后决定 phaseSince：同一相位沿用原时刻，保证同一 (phase, phaseSince) 只发一次事件。 */
export function nextPhaseSince(
  previous: { phase: WatchedPhase; phaseSince: number } | null,
  phase: WatchedPhase,
  candidate: number,
): number {
  if (previous && previous.phase === phase) return previous.phaseSince;
  return candidate;
}

export function truncateSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(compact);
  return chars.length <= max ? compact : `${chars.slice(0, max - 1).join('')}…`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** `mcp__<server>__<tool>` 这种原始工具名在「等你」里太像代码，改成「server · tool」；其它名字原样。 */
function readableToolName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/u.exec(name.trim());
  return match ? `${match[1]} · ${match[2]}` : name;
}

/**
 * 挂起交互 → 一句摘要（≤140 字，可能为 null）。只取问题本身或权限名，不带工具入参、计划正文
 * 与代输入内容：代输入卡的填写值永远只交给宿主（docs/product-rules/input-handoff.md）。
 * 没有具体内容时返回 null，由界面按 waitingFor 本地化（「等你确认」「等你回答」）。
 */
export interface InteractionSummary {
  summary: string | null;
  waitingFor: 'permission' | 'answer';
  /** 权限请求的 id（只对 kind=permission 给出）：工作台「允许」只回应这一条。 */
  requestId: string | null;
  /** 任何挂起交互的 id（回答、确认卡也有）：只用来认出「换成了另一条请求」，不用于批准。 */
  interactionId: string | null;
}

export function summarizeInteraction(raw: unknown): InteractionSummary | null {
  const request = record(raw);
  if (!request) return null;
  const kind = text(request.kind);
  if (kind === 'permission') {
    const name = text(request.title) ?? text(request.displayName) ?? text(request.toolName);
    return { summary: name ? truncateSummary(readableToolName(name)) : null, waitingFor: 'permission', requestId: text(request.requestId), interactionId: text(request.requestId) };
  }
  if (kind === 'ask_user_question') {
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const first = record(questions[0]);
    const question = text(first?.question) ?? text(first?.header);
    return { summary: question ? truncateSummary(question) : null, waitingFor: 'answer', requestId: null, interactionId: text(request.requestId) };
  }
  // plan_review / input_handoff / plugin_setup / 宿主确认卡：只报种类，不带正文。
  return { summary: null, waitingFor: kind?.includes('confirm') ? 'permission' : 'answer', requestId: null, interactionId: text(request.requestId) };
}

/**
 * `maker:list-active` 的返回：新版被控端认 `snapshotVersion: 2`，回 `active-sessions-v2` 包装；更旧的版本
 * 忽略这个参数，仍回原来的数组。两种都收；都不是返回 null，由调用方按读取失败处理（不能当成「没有任务」）。
 */
export function parseActiveSessionList(response: unknown): unknown[] | null {
  if (Array.isArray(response)) return response;
  const wrapped = record(response);
  return wrapped && Array.isArray(wrapped.sessions) ? wrapped.sessions : null;
}
