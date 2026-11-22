/** Unified hunk context shared by diff-file previews and Markdown fences. */
export type DiffLineType = 'add' | 'del' | 'ctx';

export function* classifyDiffLines(
  lines: Iterable<string>,
): Generator<{ text: string; type: DiffLineType }> {
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const text of lines) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      yield { text, type: 'ctx' };
      continue;
    }
    // Metadata ends an incomplete hunk. No-newline markers consume no rows.
    if (!/^[ +\\-]/.test(text)) oldRemaining = newRemaining = 0;
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    let type: DiffLineType = 'ctx';
    // Outside a hunk +++ / --- are file headers; inside they may be changes.
    if (text.startsWith('+') && (inHunk || !text.startsWith('+++'))) type = 'add';
    else if (text.startsWith('-') && (inHunk || !text.startsWith('---'))) type = 'del';
    if (inHunk) {
      if (text.startsWith('-') || text.startsWith(' '))
        oldRemaining = Math.max(0, oldRemaining - 1);
      if (text.startsWith('+') || text.startsWith(' '))
        newRemaining = Math.max(0, newRemaining - 1);
    }
    yield { text, type };
  }
}
