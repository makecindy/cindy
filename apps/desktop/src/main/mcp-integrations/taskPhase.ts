/**
 * Pending-interaction summaries and `maker:list-active` parsing (pure, no IO / model).
 * Used by the plugin companion host and the task digest.
 */

/** 一句话摘要上限（等你 / 出错），与契约 `pendingQuestion ≤ 140` 一致。 */
export const SUMMARY_MAX_CHARS = 140;

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
