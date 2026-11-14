/**
 * host-daemons/attribution —— 「这条常驻任务是哪个会话做出来的」的纯判定逻辑。
 *
 * 证据只有一种：任务定义文件的修改时刻（创建时刻的代理）前后 5 分钟里，某个会话的
 * 工具调用文本出现该任务名。这些工具调用行只可能是 agent 自己发出的命令（或结果），
 * 用户聊天里提到任务名不算 —— 这就是 v2rayN 这类「用户在对话里聊过、但不是 Cindy
 * 装的」不会被误收的原因。
 *
 * 判据刻意保守：宁可漏（落到「无关」计数里）也不误收，因为清单的承诺是「这里列的
 * 都是 Cindy 留下的东西」。
 */

export interface ToolMessageRow {
  sessionId: string;
  title: string | null;
  content: string;
}

/** 追溯窗口：任务定义写入前后各 5 分钟。 */
export const ATTRIBUTION_WINDOW_MS = 5 * 60_000;

/** 过短的任务名（如 `Start`）在命令文本里太容易撞，直接不用于归属。 */
const MIN_NEEDLE_LENGTH = 5;

export interface AttributedOwner {
  sessionId: string;
  title: string | null;
  hitCount: number;
}

/**
 * 按命中次数选归属会话；同分取时间上更早出现的那个（rows 已按创建时间升序）。
 * 没有命中或全部 needle 太短 → null。
 */
export function pickOwnerSession(
  rows: readonly ToolMessageRow[],
  needles: readonly string[],
): AttributedOwner | null {
  const usable = needles
    .map((needle) => needle.trim().toLowerCase())
    .filter((needle) => needle.length >= MIN_NEEDLE_LENGTH);
  if (usable.length === 0) return null;

  const hits = new Map<string, { title: string | null; count: number }>();
  for (const row of rows) {
    const content = row.content.toLowerCase();
    if (!usable.some((needle) => content.includes(needle))) continue;
    const current = hits.get(row.sessionId);
    if (current) current.count += 1;
    else hits.set(row.sessionId, { title: row.title, count: 1 });
  }

  let best: AttributedOwner | null = null;
  for (const [sessionId, value] of hits) {
    if (!best || value.count > best.hitCount) {
      best = { sessionId, title: value.title, hitCount: value.count };
    }
  }
  return best;
}
