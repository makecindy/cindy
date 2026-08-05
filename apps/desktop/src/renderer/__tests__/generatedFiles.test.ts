import { describe, expect, it } from 'vitest';

import { collectGeneratedFiles } from '../lib/generatedFiles';

const WORKDIR = '/work';

function toolUse(toolName: string, toolInput: unknown) {
  return { role: 'tool_use', toolName, toolInput };
}

describe('collectGeneratedFiles', () => {
  it('collects Write (claude) and write (pi) created files', () => {
    const files = collectGeneratedFiles(
      [
        toolUse('Write', { file_path: 'report.md', content: 'x' }),
        toolUse('write', { path: 'data/out.csv', content: 'y' }),
      ],
      WORKDIR,
    );
    expect(files.map((f) => f.name)).toEqual(['report.md', 'out.csv']);
    // 相对路径按 workingDir 解析成绝对路径。
    expect(files[0].path.replace(/\\/g, '/')).toContain('/work/report.md');
  });

  it('collects codex file_change add entries but not updates', () => {
    // codex 协议形态:change 需带 kind.type 与 diff 字符串,缺任一整次降级 generic。
    const files = collectGeneratedFiles(
      [
        toolUse('file_change', {
          changes: [
            { path: 'new.txt', kind: { type: 'add' }, diff: '+hi' },
            { path: 'existing.txt', kind: { type: 'update' }, diff: '-a\n+b' },
          ],
        }),
      ],
      WORKDIR,
    );
    expect(files.map((f) => f.name)).toEqual(['new.txt']);
  });

  it('excludes edits, reads and searches', () => {
    const files = collectGeneratedFiles(
      [
        toolUse('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
        toolUse('Read', { file_path: 'b.ts' }),
        toolUse('Grep', { pattern: 'foo' }),
      ],
      WORKDIR,
    );
    expect(files).toEqual([]);
  });

  it('dedupes the same created path across tool calls, keeping first order', () => {
    const files = collectGeneratedFiles(
      [
        toolUse('Write', { file_path: 'dup.md', content: '1' }),
        toolUse('Write', { file_path: 'other.md', content: '2' }),
        toolUse('Write', { file_path: 'dup.md', content: '3' }),
      ],
      WORKDIR,
    );
    expect(files.map((f) => f.name)).toEqual(['dup.md', 'other.md']);
  });

  it('folds case only for Windows-shaped paths, keeps POSIX case-sensitive', () => {
    // Windows 绝对路径:大小写不敏感,C:/A.md 与 c:/a.md 视为同一文件。
    const win = collectGeneratedFiles(
      [
        toolUse('Write', { file_path: 'C:/work/A.md', content: '1' }),
        toolUse('Write', { file_path: 'c:/work/a.md', content: '2' }),
      ],
      'C:/work',
    );
    expect(win).toHaveLength(1);

    // POSIX 绝对路径:大小写敏感,/w/A.txt 与 /w/a.txt 是两个不同文件,不合并。
    const posix = collectGeneratedFiles(
      [
        toolUse('write', { path: '/w/A.txt', content: '1' }),
        toolUse('write', { path: '/w/a.txt', content: '2' }),
      ],
      '/w',
    );
    expect(posix.map((f) => f.name).sort()).toEqual(['A.txt', 'a.txt']);
  });

  it('ignores non-tool_use messages', () => {
    const files = collectGeneratedFiles(
      [
        { role: 'assistant', toolName: 'Write', toolInput: { file_path: 'no.md' } },
        toolUse('Write', { file_path: 'yes.md', content: 'x' }),
      ],
      WORKDIR,
    );
    expect(files.map((f) => f.name)).toEqual(['yes.md']);
  });
});
