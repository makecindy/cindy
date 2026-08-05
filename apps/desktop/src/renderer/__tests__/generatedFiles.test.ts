import { describe, expect, it } from 'vitest';

import { collectGeneratedFiles, extractCommandPathCandidates } from '../lib/generatedFiles';

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

  it('collects script-generated paths from Bash commands as command-source candidates', () => {
    // Issue 场景:xlsx 由 python openpyxl 脚本生成,没有文件工具记录。
    const cmd =
      'python -c "\nimport openpyxl\nwb = openpyxl.Workbook()\n' +
      "wb.save(r'C:\\Users\\Admin\\Documents\\测试表格.xlsx')\nprint('done')\n\"\n";
    const files = collectGeneratedFiles([toolUse('Bash', { command: cmd })], 'C:/work');
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('测试表格.xlsx');
    expect(files[0].source).toBe('command');
  });

  it('canonicalizes Windows-shaped paths to backslashes and dedupes across slash forms', () => {
    // 正斜杠 Windows 路径(命令文本常见)必须归一成反斜杠本机形态:Explorer
    // /select 与 shell.openPath 对正斜杠会失败;且与 Write 记录的反斜杠形态
    // 是同一文件,不归一会重复出 chip。
    const files = collectGeneratedFiles(
      [
        toolUse('Write', { file_path: 'C:\\work\\report.docx', content: 'x' }),
        toolUse('Bash', { command: "open 'C:/work/report.docx'" }),
        toolUse('Bash', { command: "save 'C:/work/输出/表格.xlsx'" }),
      ],
      'C:\\work',
    );
    expect(files.map((f) => f.path)).toEqual(['C:\\work\\report.docx', 'C:\\work\\输出\\表格.xlsx']);
    expect(files[0].source).toBe('tool');
  });

  it('excludes command mentions of files edited by file tools this turn', () => {
    // 编码会话形态:Edit 改了源码文件,随后命令引用它(跑测试)。它是编辑不是
    // 新建,不能因 mtime 落在本轮窗口就被当成产物。
    const files = collectGeneratedFiles(
      [
        toolUse('Bash', { command: 'pnpm vitest run C:/work/src/openWithApps.test.ts' }),
        toolUse('Edit', {
          file_path: 'C:/work/src/openWithApps.test.ts',
          old_string: 'a',
          new_string: 'b',
        }),
        toolUse('Bash', { command: "python gen.py > 'C:/work/out/report.csv'" }),
      ],
      'C:/work',
    );
    // Edit 出现在命令之后也要生效(两遍扫描),真产物 report.csv 不受影响。
    expect(files.map((f) => f.name)).toEqual(['report.csv']);
  });

  it('marks file-tool creates as tool source and wins over command mentions of the same path', () => {
    const files = collectGeneratedFiles(
      [
        toolUse('Bash', { command: 'ls C:/work/report.md' }),
        toolUse('Write', { file_path: 'C:/work/report.md', content: 'x' }),
      ],
      'C:/work',
    );
    expect(files).toHaveLength(1);
    expect(files[0].source).toBe('tool');
  });
});

describe('extractCommandPathCandidates', () => {
  it('extracts quoted paths (CJK, spaces) and bare absolute paths', () => {
    expect(
      extractCommandPathCandidates("wb.save(r'C:\\Users\\A\\My Docs\\报表 v2.xlsx')"),
    ).toEqual(['C:\\Users\\A\\My Docs\\报表 v2.xlsx']);
    expect(extractCommandPathCandidates('node gen.js > C:/out/result.json')).toContain(
      'C:/out/result.json',
    );
    expect(extractCommandPathCandidates('cp a "/home/u/输出/report.pdf"')).toContain(
      '/home/u/输出/report.pdf',
    );
  });

  it('skips temp dirs, extension-less tokens, plain filenames and URLs', () => {
    expect(extractCommandPathCandidates("save('/tmp/x.xlsx')")).toEqual([]);
    expect(extractCommandPathCandidates("save('C:\\Users\\A\\AppData\\Local\\Temp\\x.xlsx')")).toEqual([]);
    expect(extractCommandPathCandidates('cat /dev/null && echo done')).toEqual([]);
    // 纯文件名不收(随机带点 token 误报率太高),相对路径需含分隔符。
    expect(extractCommandPathCandidates("save('输出.xlsx')")).toEqual([]);
    expect(extractCommandPathCandidates("save('out/输出.xlsx')")).toEqual(['out/输出.xlsx']);
    expect(extractCommandPathCandidates('curl https://x.com/a.js')).toEqual([]);
    expect(extractCommandPathCandidates('')).toEqual([]);
  });

  it('dedupes the same path appearing quoted and bare', () => {
    expect(
      extractCommandPathCandidates('python gen.py C:/out/a.csv && stat "C:/out/a.csv"'),
    ).toEqual(['C:/out/a.csv']);
  });
});
