import { describe, expect, it } from 'vitest';

import { parseGitDiff, parseGitDiffs } from '../diffParser';

describe('git-review diffParser', () => {
  it('defaults omitted hunk counts to 1 and tracks three line indexes', () => {
    const diff = parseGitDiff(
      ':100644 100644 1111111 2222222 M\0src/a.ts\0\0diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3 +3 @@ function a()\n-old\n+new\n',
      { source: 'unstaged' },
    );

    expect(diff.path).toBe('src/a.ts');
    expect(diff.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
    expect(diff.hunks[0].lines.map((line) => ({
      type: line.type,
      old: line.oldLineNumber,
      next: line.newLineNumber,
      original: line.originalLineNumber,
    }))).toEqual([
      { type: 'delete', old: 3, next: null, original: 3 },
      { type: 'add', old: null, next: 3, original: 3 },
    ]);
  });

  it('keeps deleted "-- " and added "++ " lines that look like ---/+++ file headers', () => {
    // Git prefixes body lines, so deleting the SQL comment "-- old note" emits
    // "--- old note". Dropping it as a header shifted line numbers and made the
    // staged patch fail `git apply`.
    const diff = parseGitDiff(
      'diff --git a/q.sql b/q.sql\nindex 1111111..2222222 100644\n--- a/q.sql\n+++ b/q.sql\n' +
        '@@ -1,3 +1,3 @@\n SELECT 1;\n--- old note\n-SELECT 2;\n+++ new note\n+SELECT 3;\n',
      { source: 'unstaged', pathHint: 'q.sql' },
    );

    expect(diff).toMatchObject({ additions: 2, deletions: 2 });
    expect(diff.hunks[0].lines.map((line) => [line.type, line.content, line.oldLineNumber, line.newLineNumber]))
      .toEqual([
        ['context', 'SELECT 1;', 1, 1],
        ['delete', '-- old note', 2, null],
        ['delete', 'SELECT 2;', 3, null],
        ['add', '++ new note', null, 2],
        ['add', 'SELECT 3;', null, 3],
      ]);
  });

  it('marks no-newline marker on the previous diff line without adding a row', () => {
    const diff = parseGitDiff(
      'diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n',
      { source: 'unstaged', pathHint: 'a.txt' },
    );

    expect(diff.hunks[0].lines).toHaveLength(2);
    expect(diff.hunks[0].lines[0].noTrailingNewLine).toBe(true);
    expect(diff.hunks[0].lines[1].noTrailingNewLine).toBe(true);
  });

  it('parses rename raw header and textual rename metadata', () => {
    const diff = parseGitDiff(
      ':100644 100644 1111111 2222222 R100\0old name.txt\0new name.txt\0\0diff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n',
      { source: 'staged' },
    );

    expect(diff.status).toBe('renamed');
    expect(diff.path).toBe('new name.txt');
    expect(diff.oldPath).toBe('old name.txt');
  });

  it('keeps authoritative rename paths and unquotes textual rename headers', () => {
    const rawMetaDiff = parseGitDiff(
      ':100644 100644 1111111 2222222 R100\0old\tname.txt\0new"name.txt\0\0' +
        'diff --git "a/old\\tname.txt" "b/new\\"name.txt"\n' +
        'similarity index 100%\n' +
        'rename from "old\\tname.txt"\n' +
        'rename to "new\\"name.txt"\n',
      { source: 'staged' },
    );

    expect(rawMetaDiff).toMatchObject({
      status: 'renamed',
      oldPath: 'old\tname.txt',
      path: 'new"name.txt',
    });

    const patchOnlyDiff = parseGitDiff(
      'diff --git "a/old\\tname.txt" "b/new\\"name.txt"\n' +
        'similarity index 100%\n' +
        'rename from "old\\tname.txt"\n' +
        'rename to "new\\"name.txt"\n',
      { source: 'staged' },
    );

    expect(patchOnlyDiff).toMatchObject({
      status: 'renamed',
      oldPath: 'old\tname.txt',
      path: 'new"name.txt',
    });
  });

  it('uses textual rename paths when an unquoted diff header is ambiguous', () => {
    const diff = parseGitDiff(
      'diff --git a/plan b/old.txt b/plan b/new.txt\n' +
        'similarity index 100%\n' +
        'rename from plan b/old.txt\n' +
        'rename to plan b/new.txt\n',
      { source: 'staged' },
    );

    expect(diff).toMatchObject({
      status: 'renamed',
      oldPath: 'plan b/old.txt',
      path: 'plan b/new.txt',
    });
  });

  it('preserves leading a and b directories from textual rename headers', () => {
    const diff = parseGitDiff(
      'diff --git a/a/nested.txt b/b/moved.txt\n' +
        'similarity index 100%\n' +
        'rename from a/nested.txt\n' +
        'rename to b/moved.txt\n',
      { source: 'staged' },
    );

    expect(diff).toMatchObject({
      status: 'renamed',
      oldPath: 'a/nested.txt',
      path: 'b/moved.txt',
    });
  });

  it('parses bulk patch-with-raw output into per-file diffs', () => {
    const diffs = parseGitDiffs(
      ':100644 100644 1111111 2222222 M\0a.txt\0:100644 100644 3333333 4444444 M\0b.txt\0\0' +
        'diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' +
        'diff --git a/b.txt b/b.txt\nindex 3333333..4444444 100644\n--- a/b.txt\n+++ b/b.txt\n@@ -2 +2 @@\n-left\n+right\n',
      { source: 'unstaged' },
    );

    expect(diffs.map((diff) => diff.path)).toEqual(['a.txt', 'b.txt']);
    expect(diffs.map((diff) => diff.additions)).toEqual([1, 1]);
    expect(diffs[1].index).toEqual({ oldOid: '3333333', newOid: '4444444' });
  });

  it('matches bulk raw metadata by order when an unquoted diff header is ambiguous', () => {
    const diffs = parseGitDiffs(
      ':100644 100644 1111111 2222222 M\0plan b/file.txt\0\0' +
        'diff --git a/plan b/file.txt b/plan b/file.txt\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/plan b/file.txt\n' +
        '+++ b/plan b/file.txt\n' +
        '@@ -1 +1 @@\n' +
        '-old\n' +
        '+new\n',
      { source: 'unstaged' },
    );

    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      status: 'modified',
      path: 'plan b/file.txt',
      index: { oldOid: '1111111', newOid: '2222222' },
    });
  });

  it('matches bulk raw metadata by patch path when a typechange expands to two patch sections', () => {
    const diffs = parseGitDiffs(
      ':100644 100644 147e103 0000000 M\0a.txt\0' +
        ':100644 120000 27a453b 0000000 T\0b.txt\0' +
        ':100644 100644 c6d38af 0000000 M\0c.txt\0' +
        ':100644 100644 cde0ee9 0000000 M\0d.txt\0\0' +
        'diff --git a/a.txt b/a.txt\nindex 147e103..813eeb1 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a old\n+a new\n' +
        'diff --git a/b.txt b/b.txt\ndeleted file mode 100644\nindex 27a453b..0000000\n--- a/b.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-b old\n' +
        'diff --git a/b.txt b/b.txt\nnew file mode 120000\nindex 0000000..1de5659\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n' +
        'diff --git a/c.txt b/c.txt\nindex c6d38af..52ce5be 100644\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-c old\n+c new\n' +
        'diff --git a/d.txt b/d.txt\nindex cde0ee9..7448198 100644\n--- a/d.txt\n+++ b/d.txt\n@@ -1 +1 @@\n-d old\n+d new\n',
      { source: 'unstaged' },
    );

    expect(diffs.map((diff) => diff.path)).toEqual(['a.txt', 'b.txt', 'b.txt', 'c.txt', 'd.txt']);
    const c = diffs.find((diff) => diff.path === 'c.txt');
    const d = diffs.find((diff) => diff.path === 'd.txt');
    expect(c?.index.oldOid).toBe('c6d38af');
    expect(c?.rawPatch).toContain('+c new');
    expect(c?.rawPatch).not.toContain('+target');
    expect(d?.index.oldOid).toBe('cde0ee9');
    expect(d?.rawPatch).toContain('+d new');
  });

  it('matches bulk raw metadata for git-quoted patch paths', () => {
    const diffs = parseGitDiffs(
      ':100644 100644 1111111 2222222 M\0tab\tname.txt\0\0' +
        'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"\nindex 1111111..2222222 100644\n--- "a/tab\\tname.txt"\n+++ "b/tab\\tname.txt"\n@@ -1 +1 @@\n-old\n+new\n',
      { source: 'unstaged' },
    );

    expect(diffs[0]).toMatchObject({
      path: 'tab\tname.txt',
      index: { oldOid: '1111111', newOid: '2222222' },
    });

    const unicodeDiffs = parseGitDiffs(
      ':100644 100644 3333333 4444444 M\0中.txt\0\0' +
        'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"\nindex 3333333..4444444 100644\n--- "a/\\344\\270\\255.txt"\n+++ "b/\\344\\270\\255.txt"\n@@ -1 +1 @@\n-old\n+new\n',
      { source: 'unstaged' },
    );
    expect(unicodeDiffs[0]).toMatchObject({
      path: '中.txt',
      index: { oldOid: '3333333', newOid: '4444444' },
    });
  });
});
