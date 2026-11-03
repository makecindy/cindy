/**
 * The Reviewer ends its answer with a machine-readable count of findings so the
 * host can decide, without interpreting prose, whether the source task needs a
 * follow-up turn. The marker is stripped before the result is shown anywhere.
 */
export const REVIEW_FINDINGS_MARKER_INSTRUCTION =
  '回答的最后一行必须单独输出 `<review-findings count="N"/>`，N 是上面列出的 findings 条数（没有需要修改的问题时为 0）。这一行只供程序读取，不要在其它地方提及。';

const MARKER_PATTERN = /<review-findings\s+count\s*=\s*["']?(\d{1,4})["']?\s*\/?>/gi;

export interface ParsedReviewResult {
  /** The visible conclusion with every marker removed. */
  text: string;
  /** Null when the Reviewer did not report a usable count. */
  findingsCount: number | null;
}

export function splitReviewFindingsMarker(raw: string): ParsedReviewResult {
  let findingsCount: number | null = null;
  for (const match of raw.matchAll(MARKER_PATTERN)) {
    const value = Number.parseInt(match[1] ?? '', 10);
    // The last marker wins: a Reviewer that corrects itself restates the count.
    findingsCount = Number.isFinite(value) ? value : null;
  }
  const text = raw
    .replace(MARKER_PATTERN, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, findingsCount };
}
