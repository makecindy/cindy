/**
 * filterFiles —— 文件名子串筛选(Codex / VSCode Cmd+P 风格)。
 *
 * 输入 query → 在扁平文件名列表中找匹配。返回截前 `limit` 条。
 *
 * 排序策略(用户最常的检索意图优先):
 *  1. basename 命中(关键词出现在文件名最后一段) — 用户多半要找的就是这个;
 *  2. path 中段命中(关键词出现在目录路径里) — 二级匹配。
 *
 * case-insensitive。性能:5w 文件 substring 遍历 ~5-10ms,够实时 onChange。
 *
 * 抽到 workdir-browse/lib 下,RSB plugin 和 doc 模式 sidebar 都从这里 import,
 * 同一份算法两边一致。
 */

/** 文件名筛选结果展示上限。匹配再多也只渲染前 N 条,避免列表爆 + 用户分不清重点。 */
export const FILTER_RESULT_LIMIT = 200;

export interface FilterFileResults {
  files: string[];
  truncated: boolean;
}

export interface FilterTreeRow {
  kind: 'directory' | 'file';
  /** The complete workdir-relative POSIX path represented by this row. */
  relPath: string;
  /** The visible path segment(s); directory chains may be compacted here. */
  label: string;
  depth: number;
}

export function filterFiles(
  query: string,
  files: readonly string[],
  limit = FILTER_RESULT_LIMIT,
): string[] {
  return filterFilesWithMeta(query, files, limit).files;
}

export function filterFilesWithMeta(
  query: string,
  files: readonly string[],
  limit = FILTER_RESULT_LIMIT,
): FilterFileResults {
  const q = query.trim().toLowerCase();
  if (!q) return { files: [], truncated: false };
  const basenameMatches: string[] = [];
  const pathMatches: string[] = [];
  let matchCount = 0;
  for (const f of files) {
    const lower = f.toLowerCase();
    if (!lower.includes(q)) continue;
    matchCount += 1;
    if (matchCount > limit) break;
    const slash = lower.lastIndexOf('/');
    const basename = slash < 0 ? lower : lower.slice(slash + 1);
    if (basename.includes(q)) basenameMatches.push(f);
    else pathMatches.push(f);
  }
  return {
    files: [...basenameMatches, ...pathMatches],
    truncated: matchCount > limit,
  };
}

interface FilterTreeNode {
  name: string;
  relPath: string;
  directories: Map<string, FilterTreeNode>;
  files: string[];
}

/**
 * Turn flat filename matches into the smallest useful tree for search.
 * A directory chain is compacted only while it has one directory child and no
 * direct matching files, preserving both hierarchy and useful path context.
 */
export function buildFilterTreeRows(files: readonly string[]): FilterTreeRow[] {
  const root: FilterTreeNode = { name: '', relPath: '', directories: new Map(), files: [] };

  for (const file of files) {
    const segments = file.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const relPath = node.relPath ? `${node.relPath}/${segment}` : segment;
      let child = node.directories.get(segment);
      if (!child) {
        child = { name: segment, relPath, directories: new Map(), files: [] };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.push(segments[segments.length - 1]);
  }

  const rows: FilterTreeRow[] = [];
  const visit = (node: FilterTreeNode, depth: number) => {
    for (const directory of node.directories.values()) {
      let compacted = directory;
      const labels = [directory.name];
      while (compacted.files.length === 0 && compacted.directories.size === 1) {
        const onlyChild = compacted.directories.values().next().value as FilterTreeNode | undefined;
        if (!onlyChild) break;
        compacted = onlyChild;
        labels.push(compacted.name);
      }
      rows.push({
        kind: 'directory',
        relPath: compacted.relPath,
        label: labels.join(' / '),
        depth,
      });
      visit(compacted, depth + 1);
    }
    for (const file of node.files) {
      rows.push({
        kind: 'file',
        relPath: node.relPath ? `${node.relPath}/${file}` : file,
        label: file,
        depth,
      });
    }
  };

  visit(root, 0);
  return rows;
}
