/**
 * 侧栏「伙伴」段的行数收敛(2026-10-16 用户裁决)。
 *
 * 伙伴段是侧栏第一层,和任务列表并存在同一条滚动轴上:伙伴一多,整段就能把下面的
 * 任务挤出视野。默认只展开最近对话的一批,其余收进段尾的「展开全部」,需要时一条
 * 点击看全 —— 段本身仍然是一段,不新增滚动区。
 *
 * 两类「不占上限」的例外,和收起态头像行的同一条规则:
 *   - 置顶的伙伴:用户显式钉住的,不能因为排序靠后被折叠起来;
 *   - 当前正在看的聊天:这一行突然从列表里消失,比列表变长更难解释。
 * 例外行停在原排序位置,其余行按原顺序补足上限。
 */
export const TEAMMATE_ROWS_BY_DEFAULT = 5;

export function limitTeammateRows<T>(
  rows: readonly T[],
  options: { keep: (row: T) => boolean; limit?: number },
): { rows: T[]; hiddenCount: number } {
  const limit = options.limit ?? TEAMMATE_ROWS_BY_DEFAULT;
  if (limit <= 0) return { rows: [...rows], hiddenCount: 0 };

  const shown = new Set<number>();
  rows.forEach((row, index) => {
    if (options.keep(row)) shown.add(index);
  });

  let remaining = limit;
  rows.forEach((row, index) => {
    if (remaining <= 0 || shown.has(index)) return;
    shown.add(index);
    remaining -= 1;
  });

  const visible = rows.filter((_, index) => shown.has(index));
  return { rows: visible, hiddenCount: rows.length - visible.length };
}
