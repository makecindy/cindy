import type { NativePullDownAction } from "@/platform/chrome/NativePullDownMenu";

export type PullDownMenuSection = {
  key: string;
  /** UIMenu 内联分组的标题;没有标题的连续条目合成一个无标题分组。 */
  title?: string;
  rows: NativePullDownAction[];
};

/**
 * 把 UIMenu 形态的 actions 整理成 Cindy 自绘菜单的一页:内联分组(displayInline)成为
 * 带标题的分组,分组之间画分隔线;普通子菜单(subactions 且非内联)保留为一行,点开
 * 进入下一页,与 UIMenu 的层级一致。
 */
export function buildPullDownMenuSections(
  actions: readonly NativePullDownAction[],
): PullDownMenuSection[] {
  const sections: PullDownMenuSection[] = [];
  let loose: NativePullDownAction[] = [];
  const flushLoose = () => {
    if (!loose.length) return;
    sections.push({ key: `loose:${loose[0].id}`, rows: loose });
    loose = [];
  };
  for (const action of actions) {
    if (action.displayInline && action.subactions?.length) {
      flushLoose();
      sections.push({
        key: `group:${action.id}`,
        title: action.title.trim() || undefined,
        rows: action.subactions.flatMap((item) =>
          item.displayInline && item.subactions?.length
            ? item.subactions
            : [item],
        ),
      });
      continue;
    }
    loose.push(action);
  }
  flushLoose();
  return sections;
}

/** 按 id 路径逐层找到子菜单;路径失效(actions 已变化)时返回 null,由调用方回到根页。 */
export function resolvePullDownSubmenu(
  actions: readonly NativePullDownAction[],
  path: readonly string[],
): NativePullDownAction | null {
  let level: readonly NativePullDownAction[] = actions;
  let found: NativePullDownAction | null = null;
  for (const id of path) {
    const candidates = level.flatMap((item) =>
      item.displayInline && item.subactions?.length ? item.subactions : [item],
    );
    found =
      candidates.find((item) => item.id === id && !!item.subactions?.length) ??
      null;
    if (!found) return null;
    level = found.subactions ?? [];
  }
  return found;
}
