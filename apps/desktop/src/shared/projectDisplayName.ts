/**
 * 根据 workingDir 与全集，提取最短可识别的 displayName。
 * 算法（按 prod_spec F-PJ-2 扩展）：
 *   1. 取 basename
 *   2. 若全集内无其他 workingDir 的 basename 与之相同 → 1 段
 *   3. 否则逐步加上父目录段，直到不冲突；若完整路径仍冲突，则接受完整路径
 *
 * minSegments：从该段数起步搜索（默认 1）。groupSessions 在"先创建保留 basename"
 * 规则下，会把后创建的同名 Project 传 minSegments=2，强制至少加上 parent 段。
 */
export function extractDisplayName(
  workingDir: string,
  allWorkingDirs: readonly string[],
  minSegments: number = 1,
): { name: string; segments: number } {
  const segs = splitPathSegments(workingDir);
  const ownSegs = segs;
  const ownBasename = ownSegs[ownSegs.length - 1] ?? workingDir;

  // 收集其它 workingDir 的逐段拆分
  const others: string[][] = [];
  let maxSegments = Math.max(1, ownSegs.length, minSegments);
  for (const w of allWorkingDirs) {
    if (w === workingDir) continue;
    const parts = splitPathSegments(w);
    if (parts.length > 0) {
      others.push(parts);
      maxSegments = Math.max(maxSegments, parts.length);
    }
  }

  for (let n = minSegments; n <= maxSegments; n += 1) {
    const myTail = tailJoin(ownSegs, n);
    const collision = others.some((parts) => tailJoin(parts, n) === myTail);
    if (!collision) {
      return { name: myTail || ownBasename, segments: n };
    }
  }

  const fallback = tailJoin(ownSegs, maxSegments) || ownBasename;
  return { name: fallback, segments: maxSegments };
}

export function splitPathSegments(workingDir: string): string[] {
  return workingDir.split('/').filter(Boolean);
}

// 取从尾部往前 N 段（如 segments=2 → `parent/basename`）。
export function tailJoin(parts: readonly string[], n: number): string {
  return parts.slice(Math.max(0, parts.length - n)).join('/');
}
