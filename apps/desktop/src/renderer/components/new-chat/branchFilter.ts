/**
 * branchFilter — 分支下拉搜索框的过滤语义(纯函数,与 UI 解耦便于单测)。
 *
 * 与 branchPick 分开:那边管"点中一项之后产生什么 effect",这边只管"哪些项该显示",
 * 两者出于不同原因变化(前者跟 worktree 语义走,后者跟搜索体验走),不合并。
 *
 * 匹配口径刻意保持朴素:大小写不敏感的子串匹配,不做模糊 / 乱序 / 分词。分支名短
 * 且常含 `/`(`cindy/auto-k6cgvq`),子串就能直接搜中间段,引模糊匹配只会带来
 * "搜 abc 却排出八竿子打不着的分支"这类噪音。
 */

/**
 * 按搜索词过滤分支名。
 *
 * 空白搜索词(含只有空格)返回原数组**引用本身**,不复制——上层拿它进 useMemo,
 * 保持引用相等能让未搜索时的重渲染少一次列表 diff。
 */
export function filterBranches(branches: readonly string[], query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  if (!q) return branches;
  return branches.filter((b) => b.toLowerCase().includes(q));
}
