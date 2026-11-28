/**
 * host-daemons/attribution —— 「这条常驻任务是哪个会话做出来的」的纯判定逻辑。
 *
 * 证据只有一种：某个会话**执行过的命令**（`tool_use` 行）里出现该任务名。命令的
 * 输出（`tool_result`）不算——任何会话跑一次 `schtasks /query` 或 `crontab -l`，
 * 输出里就有机器上现成的全部条目，按输出认领等于把别人的东西都算成自己的。用户
 * 聊天里提到任务名同理不算。这就是 v2rayN 这类「用户在对话里聊过、但不是 Cindy
 * 装的」不会被误收的原因。
 *
 * 两种来源查法不同，结论口径相同：
 * - 有定义文件修改时刻的（计划任务、plist、timer）：只看该时刻前后 5 分钟。
 * - 没有时刻的（crontab 整表没有单行时间）：翻完整段工具调用历史，读到头才算数。
 *
 * 判据刻意保守：宁可漏（落到「无关」计数里）也不误收，因为清单的承诺是「这里列的
 * 都是 Cindy 留下的东西」。
 */

export interface ToolMessageRow {
  sessionId: string;
  title: string | null;
  /** 实际交给工具的文本（已从库里的转义存储解码），匹配直接在它上面做。 */
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

/** 去空白、小写后仍然够长的追溯词；为空时无论读多少行都不可能有证据。 */
export function usableNeedles(needles: readonly string[]): string[] {
  return needles
    .map((needle) => needle.trim().toLowerCase())
    .filter((needle) => needle.length >= MIN_NEEDLE_LENGTH);
}

/** 逐行累计命中的判定：行不必一次到齐（全历史回看是分页读的）。 */
export interface OwnerHitCounter {
  /** 喂一行工具调用；某个会话首次命中时记下它的标题。 */
  add(row: ToolMessageRow): void;
  /** 取命中最多的会话；一次都没命中 → null。 */
  pick(): AttributedOwner | null;
}

export function createOwnerHitCounter(needles: readonly string[]): OwnerHitCounter {
  const usable = usableNeedles(needles);
  const hits = new Map<string, { title: string | null; count: number }>();
  return {
    add(row) {
      const content = row.content.toLowerCase();
      if (!usable.some((needle) => content.includes(needle))) return;
      const current = hits.get(row.sessionId);
      if (current) current.count += 1;
      else hits.set(row.sessionId, { title: row.title, count: 1 });
    },
    pick() {
      let best: AttributedOwner | null = null;
      // 同分保留先出现的那个：rows 按创建时间升序喂入，先出现 = 时间上更早。
      for (const [sessionId, value] of hits) {
        if (!best || value.count > best.hitCount) {
          best = { sessionId, title: value.title, hitCount: value.count };
        }
      }
      return best;
    },
  };
}

/**
 * 按命中次数选归属会话；同分取时间上更早出现的那个（rows 已按创建时间升序）。
 * 没有命中或全部 needle 太短 → null。
 */
export function pickOwnerSession(
  rows: readonly ToolMessageRow[],
  needles: readonly string[],
): AttributedOwner | null {
  const counter = createOwnerHitCounter(needles);
  for (const row of rows) counter.add(row);
  return counter.pick();
}
