/**
 * Framework-free live work preview shared by Slack hook, Feishu and Discord.
 *
 * The full desktop/mobile transcript keeps every work segment. Remote cards
 * have much less room, so they show the latest five readable activities while
 * the assistant's own progress text continues below the preview. Tool wording
 * comes from maker-shared; thinking deltas update one row by block id instead
 * of flooding the card with raw stream events.
 */

import { summarizeToolUseText } from '@cindy/maker-shared/message-presentation';
import { tokenizeThinkingText } from '@cindy/maker-shared/thinking-text';

/** Keep parity with the desktop/mobile running work preview. */
export const MAX_VISIBLE_STEPS = 5;

/** One-line remote previews must not let a command or thought dominate a card. */
const STEP_LABEL_MAX = 80;

export interface TurnActivityStep {
  key: string;
  kind: 'thinking' | 'tool';
  label: string;
}

export interface TurnActivityState {
  /** Latest unique activities in chronological order. */
  recentSteps: TurnActivityStep[];
  /** Unique activities seen this turn, including rows that rolled out. */
  totalSteps: number;
  /** Turn dispatch time used by the elapsed indicator. */
  startedAt: number;
  /** True only when the most recent visible event is assistant progress text. */
  writing: boolean;
  /**
   * 一行临时状态说明(当前只用于「上游过载, 正在自动重试」), 不占 step 槽位、
   * 不计入 totalSteps —— 它描述的是"这一刻卡在哪", 而不是已完成的工作项。
   *
   * 为什么必须与 step 分开: 过载自动重试只在本 turn **零产出**时发生
   * (maker-core 的 currentTurnProducedOutput 守卫), 那时 totalSteps 恒为 0、
   * 正文也是空 —— 若走 step 通道, 它会在重试成功后永久留在时间线里冒充一项
   * 工作; 而若不渲染, 渠道那条占位消息在整个退避窗口(~22-38s)内一个字都不
   * 变, 用户看到的就是"卡住了"。所以它是可覆盖、可清除的单行状态。
   *
   * 清除时机: 任何正常进展事件(工具 / 思考 / 正文)到达即置 null, 与 renderer
   * ErrorBanner「恢复后由后续正常事件自动清除」同口径。
   */
  notice: string | null;
  /**
   * 一行**等用户**状态(等授权 / 等回答 / 等审阅), 与上面的 notice 分开存。
   *
   * 为什么不能共用 notice: notice 的语义是"这一刻卡在哪, 有真实进展就作废", 所以
   * pushToolStep / pushThinkingStep / markActivityWriting 都会 clearNotice。而"在等
   * 你确认"恰恰要在**有进展的时候也留着** —— 权限请求挂起期间 agent 的其它子任务
   * 照样会吐 thinking / tool_use / 正文, 那些事件一到就把提示抹掉, 于是剩下的授权
   * 最长要等 30 分钟而过程区一个字都不提(2026-08-03 review P2)。
   *
   * 只由交互挂起/收口显式设置与清除, 进展事件一律不动它。
   */
  interactionNotice: string | null;
}

/** Replay/delta bookkeeping stays private and is never serialized with card state. */
interface TurnActivityInternalState {
  seenKeys: Set<string>;
  thinkingTextByBlockId: Map<string, string>;
  sequence: number;
}

const internalStateByActivity = new WeakMap<TurnActivityState, TurnActivityInternalState>();

function getInternalState(activity: TurnActivityState): TurnActivityInternalState {
  const internal = internalStateByActivity.get(activity);
  if (!internal) throw new Error('Turn activity must be created with createTurnActivity()');
  return internal;
}

export function createTurnActivity(startedAt: number): TurnActivityState {
  const activity: TurnActivityState = {
    recentSteps: [],
    totalSteps: 0,
    startedAt,
    writing: false,
    notice: null,
    interactionNotice: null,
  };
  internalStateByActivity.set(activity, {
    seenKeys: new Set(),
    thinkingTextByBlockId: new Map(),
    sequence: 0,
  });
  return activity;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function appendStep(activity: TurnActivityState, step: TurnActivityStep): boolean {
  const internal = getInternalState(activity);
  if (internal.seenKeys.has(step.key)) return false;
  internal.seenKeys.add(step.key);
  activity.totalSteps += 1;
  activity.recentSteps.push(step);
  if (activity.recentSteps.length > MAX_VISIBLE_STEPS) activity.recentSteps.shift();
  return true;
}

/**
 * 设置 / 清除单行状态说明。返回是否真的变了 —— 调用方据此决定要不要触发一帧
 * 渠道刷新, 同 push*Step 的返回值语义(重复内容不浪费 chat.update 配额)。
 */
export function setActivityNotice(activity: TurnActivityState, notice: string | null): boolean {
  const next = notice && notice.trim().length > 0 ? truncate(notice, STEP_LABEL_MAX) : null;
  if (activity.notice === next) return false;
  activity.notice = next;
  return true;
}

/**
 * 设置 / 清除"在等你确认"那一行。返回是否真的变了(同 setActivityNotice 的语义)。
 * 与 setActivityNotice 的区别只有一个: 进展事件不会清掉它。
 */
export function setInteractionNotice(
  activity: TurnActivityState,
  notice: string | null,
): boolean {
  const next = notice && notice.trim().length > 0 ? truncate(notice, STEP_LABEL_MAX) : null;
  if (activity.interactionNotice === next) return false;
  activity.interactionNotice = next;
  return true;
}

/** 有真实进展 = 上一条状态说明(如"正在重试")已过期。 */
function clearNotice(activity: TurnActivityState): void {
  activity.notice = null;
}

/** Raw tool_use -> desktop/mobile-compatible readable title. */
export function formatToolStep(toolName: string, input: unknown): string {
  return truncate(summarizeToolUseText(toolName, input).label || toolName, STEP_LABEL_MAX);
}

/**
 * Record one tool call. Stable toolUseId de-duplicates transcript replay after
 * compaction/reconnect; legacy events without an id still get a local key.
 */
export function pushToolStep(
  activity: TurnActivityState,
  toolName: string,
  input: unknown,
  toolUseId?: string,
): boolean {
  const internal = getInternalState(activity);
  const key = toolUseId ? `tool:${toolUseId}` : `tool:auto:${++internal.sequence}`;
  if (internal.seenKeys.has(key)) return false;
  activity.writing = false;
  clearNotice(activity);
  return appendStep(activity, {
    key,
    kind: 'tool',
    label: formatToolStep(toolName, input),
  });
}

function thinkingPlainText(value: string): string {
  return tokenizeThinkingText(value)
    .map((token) => token.value)
    .join('')
    // Streaming deltas can stop halfway through a strong span. Do not flash
    // the unmatched Codex delimiter while waiting for the closing delta.
    .replace(/\*\*/g, '');
}

/** Paired ** markers and code delimiters are removed before Slack mrkdwn sees them. */
export function formatThinkingStep(value: string): string {
  return truncate(thinkingPlainText(value), STEP_LABEL_MAX);
}

/**
 * Apply one thinking start/delta/final event. The first non-empty text creates
 * the row; later deltas update it in place and final replaces it canonically.
 */
export function pushThinkingStep(activity: TurnActivityState, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.stage === 'redacted') return false;
  const text = typeof record.text === 'string' ? record.text : '';
  const blockId = typeof record.blockId === 'string' && record.blockId
    ? record.blockId
    : 'current';
  const internal = getInternalState(activity);
  const previous = internal.thinkingTextByBlockId.get(blockId) ?? '';
  const next = record.stage === 'final' ? text : `${previous}${text}`;
  if (next === previous) return false;
  internal.thinkingTextByBlockId.set(blockId, next);

  const label = formatThinkingStep(next);
  if (!label) return false;
  const key = `thinking:${blockId}`;
  const existing = activity.recentSteps.find((step) => step.key === key);
  if (existing) {
    activity.writing = false;
    clearNotice(activity);
    existing.label = label;
    return true;
  }
  // A final replay for a row that already rolled out should not pull old work
  // back into the latest-five window.
  if (internal.seenKeys.has(key)) return false;
  activity.writing = false;
  clearNotice(activity);
  return appendStep(activity, { key, kind: 'thinking', label });
}

/** Assistant progress text stays visible below the activity list. */
export function markActivityWriting(activity: TurnActivityState): void {
  activity.writing = true;
  clearNotice(activity);
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60 ? `${sec % 60}s` : ''}`;
}

/**
 * Render the running-only markdown block. Final channel messages omit it.
 *
 * 只有状态说明、没有任何工作项时同样要渲染: 过载自动重试恰好发生在零产出的
 * turn 上, 那是渠道消息唯一可能整段静止的窗口(见 TurnActivityState.notice)。
 * 此时省掉"N 项"段 —— 报"0 项"没有信息量。
 */
export function renderActivity(activity: TurnActivityState, now: number): string {
  if (activity.totalSteps === 0 && activity.notice === null && activity.interactionNotice === null)
    return '';
  const elapsed = formatElapsed(now - activity.startedAt);
  const lines = [
    activity.totalSteps > 0
      ? `⚙️ 工作中 · ${activity.totalSteps} 项 · ${elapsed}`
      : `⚙️ 工作中 · ${elapsed}`,
  ];
  const last = activity.recentSteps.length - 1;
  activity.recentSteps.forEach((step, index) => {
    // 有状态说明时它才是"当前在做的事", 已完成的工作项一律收成 ✓。
    const isTail =
      index === last &&
      !activity.writing &&
      activity.notice === null &&
      activity.interactionNotice === null;
    const marker = isTail ? '▸' : '✓';
    const prefix = step.kind === 'thinking' ? '✦ ' : '';
    lines.push(`> ${marker} ${prefix}${step.label}`);
  });
  if (activity.notice !== null) lines.push(`> ⏳ ${activity.notice}`);
  // 等用户那一行放最后: 它是此刻唯一需要用户动手的事。
  if (activity.interactionNotice !== null) lines.push(`> ⏳ ${activity.interactionNotice}`);
  return lines.join('\n');
}
