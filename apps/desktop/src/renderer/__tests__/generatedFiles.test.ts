import { describe, expect, it } from 'vitest';

import { collectGeneratedFiles, extractCommandOutputPathCandidates } from '../lib/generatedFiles';

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
    expect(files.map((f) => f.path)).toEqual([
      'C:\\work\\report.docx',
      'C:\\work\\输出\\表格.xlsx',
    ]);
    expect(files[0].source).toBe('tool');
  });

  it('collapses doubled backslashes so escaped wrapper commands do not duplicate chips', () => {
    // 包装脚本里的写出路径可能带转义残留(`C:\\Users\\...`);同轮另一条命令用
    // 正斜杠形态。fs 层它们是同一文件(Windows 归并重复分隔符),不折叠会出两个同名 chip。
    const files = collectGeneratedFiles(
      [
        toolUse('Bash', {
          command: 'node -e "save(\'C:\\\\Users\\\\U\\\\pr-watch\\\\registry.json\')"',
        }),
        toolUse('Bash', {
          command: 'node -e "save(\'C:/Users/U/pr-watch/registry.json\')"',
        }),
      ],
      'C:\\Users\\U\\pr-watch',
    );
    const registry = files.filter((f) => f.name === 'registry.json');
    expect(registry).toHaveLength(1);
    // 画布路径本身也折叠成单反斜杠本机形态,不带转义残留。
    expect(registry[0].path).toBe('C:\\Users\\U\\pr-watch\\registry.json');
  });

  it('keeps the UNC leading double backslash while collapsing inner separator runs', () => {
    const files = collectGeneratedFiles(
      [
        toolUse('Bash', { command: "copy out '\\\\server\\share\\\\dir\\report.csv'" }),
        toolUse('Bash', { command: "open '\\\\server\\share\\dir\\report.csv'" }),
      ],
      'C:\\work',
    );
    const reports = files.filter((f) => f.name === 'report.csv');
    expect(reports).toHaveLength(1);
    expect(reports[0].path.startsWith('\\\\server\\')).toBe(true);
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

describe('extractCommandOutputPathCandidates', () => {
  it('extracts paths from explicit save, redirection and copy destinations', () => {
    expect(
      extractCommandOutputPathCandidates("wb.save(r'C:\\Users\\A\\My Docs\\报表 v2.xlsx')"),
    ).toEqual(['C:\\Users\\A\\My Docs\\报表 v2.xlsx']);
    expect(extractCommandOutputPathCandidates('node gen.js > C:/out/result.json')).toContain(
      'C:/out/result.json',
    );
    expect(extractCommandOutputPathCandidates('cp a "/home/u/输出/report.pdf"')).toContain(
      '/home/u/输出/report.pdf',
    );
    expect(
      extractCommandOutputPathCandidates(
        'Get-Content "inputs/source.md" && copy "inputs/source.md" \'artifacts/report.md\'',
      ),
    ).toEqual(['artifacts/report.md']);
    expect(
      extractCommandOutputPathCandidates(
        "python -c \"from pathlib import Path; Path('out/report.md').write_text('ok')\"",
      ),
    ).toEqual(['out/report.md']);
    expect(extractCommandOutputPathCandidates("Path('out/data.bin').write_bytes(payload)")).toEqual(
      ['out/data.bin'],
    );
    expect(
      extractCommandOutputPathCandidates("df.to_csv(path_or_buf='out/report.csv', index=False)"),
    ).toEqual(['out/report.csv']);
    expect(
      extractCommandOutputPathCandidates("df.to_csv(index=False, path_or_buf='out/report.csv')"),
    ).toEqual(['out/report.csv']);
    expect(
      extractCommandOutputPathCandidates("torch.save(model.state_dict(), 'out/model.pt')"),
    ).toEqual(['out/model.pt']);
    expect(extractCommandOutputPathCandidates("joblib.dump(model, 'out/model.pkl')")).toEqual([
      'out/model.pkl',
    ]);
    expect(
      extractCommandOutputPathCandidates('workbook.to_excel(excel_writer="out/report.xlsx")'),
    ).toEqual(['out/report.xlsx']);
    expect(extractCommandOutputPathCandidates("plt.savefig('out/chart.png')")).toEqual([
      'out/chart.png',
    ]);
    expect(
      extractCommandOutputPathCandidates("plt.savefig(fname='out/chart.pdf', bbox_inches='tight')"),
    ).toEqual(['out/chart.pdf']);
    expect(extractCommandOutputPathCandidates("printf 'report' | tee 'out/report.md'")).toEqual([
      'out/report.md',
    ]);
    expect(extractCommandOutputPathCandidates('tee /work/out/report.txt')).toEqual([
      '/work/out/report.txt',
    ]);
    expect(
      extractCommandOutputPathCandidates(
        "wget --output-document='out/report.pdf' https://example.com/report.pdf",
      ),
    ).toEqual(['out/report.pdf']);
    expect(extractCommandOutputPathCandidates('cp source.txt output/')).toEqual([
      'output/source.txt',
    ]);
    expect(extractCommandOutputPathCandidates('copy source.txt output\\')).toEqual([
      'output\\source.txt',
    ]);
    expect(extractCommandOutputPathCandidates('cp inputs/a.txt inputs/b.txt output/')).toEqual([
      'output/a.txt',
      'output/b.txt',
    ]);
    expect(extractCommandOutputPathCandidates('cp -t output source.txt')).toEqual([
      'output/source.txt',
    ]);
    expect(extractCommandOutputPathCandidates('mv --target-directory output source.txt')).toEqual([
      'output/source.txt',
    ]);
    expect(extractCommandOutputPathCandidates("cp 'source file.txt' output/")).toEqual([
      'output/source file.txt',
    ]);
    expect(extractCommandOutputPathCandidates('cp source\\ file.txt output/')).toEqual([
      'output/source file.txt',
    ]);
    expect(extractCommandOutputPathCandidates('cp -t /dest /src/a.txt')).toEqual(['/dest/a.txt']);
    expect(extractCommandOutputPathCandidates('cp --target-directory=/dest /src/a.txt')).toEqual([
      '/dest/a.txt',
    ]);
    expect(
      extractCommandOutputPathCandidates(
        'Get-ChildItem inputs/source.txt | Copy-Item -Destination output/',
      ),
    ).toEqual(['output/source.txt']);
    expect(
      extractCommandOutputPathCandidates('Get-ChildItem inputs/ | Copy-Item -Destination output/'),
    ).toEqual(['output/']);
    expect(
      extractCommandOutputPathCandidates('Copy-Item -Destination output/ -Path inputs/source.txt'),
    ).toEqual(['output/source.txt']);
    expect(
      extractCommandOutputPathCandidates("Copy-Item 'inputs/source.txt' 'artifacts/report.txt'"),
    ).toEqual(['artifacts/report.txt']);
    expect(extractCommandOutputPathCandidates('Copy-Item inputs/source.txt output/')).toEqual([
      'output/source.txt',
    ]);
    expect(extractCommandOutputPathCandidates('Copy-Item inputs/source.txt report.txt')).toEqual([
      'report.txt',
    ]);
    expect(extractCommandOutputPathCandidates('cp source.txt report.txt')).toEqual(['report.txt']);
    expect(extractCommandOutputPathCandidates('copy source.txt report.txt')).toEqual([
      'report.txt',
    ]);
    expect(
      extractCommandOutputPathCandidates("mv 'tmp/report.pdf' 'artifacts/report.pdf'"),
    ).toEqual(['artifacts/report.pdf']);
    expect(extractCommandOutputPathCandidates("mv 'tmp/report.pdf' 'artifacts/'")).toEqual([
      'artifacts/report.pdf',
    ]);
    expect(extractCommandOutputPathCandidates('mv source.txt report.txt')).toEqual(['report.txt']);
    expect(extractCommandOutputPathCandidates('move source.txt report.txt')).toEqual([
      'report.txt',
    ]);
    expect(
      extractCommandOutputPathCandidates('Move-Item -Destination output/ -Path inputs/source.txt'),
    ).toEqual(['output/source.txt']);
  });

  it('skips temp dirs, extension-less tokens, plain filenames and URLs', () => {
    expect(extractCommandOutputPathCandidates("save('/tmp/x.xlsx')")).toEqual([]);
    expect(
      extractCommandOutputPathCandidates("save('C:\\Users\\A\\AppData\\Local\\Temp\\x.xlsx')"),
    ).toEqual([]);
    expect(extractCommandOutputPathCandidates('cat /dev/null && echo done')).toEqual([]);
    // 纯文件名不收(随机带点 token 误报率太高),相对路径需含分隔符。
    expect(extractCommandOutputPathCandidates("save('输出.xlsx')")).toEqual([]);
    expect(extractCommandOutputPathCandidates("save('out/输出.xlsx')")).toEqual(['out/输出.xlsx']);
    expect(extractCommandOutputPathCandidates('curl https://x.com/a.js')).toEqual([]);
    expect(extractCommandOutputPathCandidates('')).toEqual([]);
  });

  it('dedupes the same output path', () => {
    expect(
      extractCommandOutputPathCandidates(
        'python gen.py > C:/out/a.csv && node gen.js --output "C:/out/a.csv"',
      ),
    ).toEqual(['C:/out/a.csv']);
  });

  it('does not treat paths in PowerShell and shell read commands as outputs', () => {
    const powershellRead =
      'powershell.exe -Command \'$p="docs/design-rules/DESIGN.md"; ' +
      "$l=[System.IO.File]::ReadAllLines($p); $l[0..20]'";
    expect(extractCommandOutputPathCandidates(powershellRead)).toEqual([]);
    expect(
      extractCommandOutputPathCandidates(
        "Get-Content 'docs/dev-rules/repo-map.md'; rg foo 'apps/desktop/src/index.tsx'",
      ),
    ).toEqual([]);
  });

  it('keeps only the explicit output when a command also names input files', () => {
    expect(
      extractCommandOutputPathCandidates(
        "python convert.py 'inputs/source.md' --output 'artifacts/report.pdf'",
      ),
    ).toEqual(['artifacts/report.pdf']);
    expect(
      extractCommandOutputPathCandidates(
        "open('inputs/source.txt', 'r'); open('artifacts/result.txt', 'wb')",
      ),
    ).toEqual(['artifacts/result.txt']);
    expect(extractCommandOutputPathCandidates("open('artifacts/result.txt', mode='w')")).toEqual([
      'artifacts/result.txt',
    ]);
    expect(
      extractCommandOutputPathCandidates(
        "open('artifacts/result.bin', encoding='utf8', mode='wb')",
      ),
    ).toEqual(['artifacts/result.bin']);
    expect(extractCommandOutputPathCandidates("open('inputs/source.txt', mode='r')")).toEqual([]);
    expect(
      extractCommandOutputPathCandidates(
        "Set-Content -Path 'artifacts/result.txt' -Value (Get-Content 'inputs/source.txt')",
      ),
    ).toEqual(['artifacts/result.txt']);
    expect(
      extractCommandOutputPathCandidates(
        "Set-Content -Value (Get-Content 'inputs/source.txt') -Path 'artifacts/result.txt'",
      ),
    ).toEqual(['artifacts/result.txt']);
    expect(
      extractCommandOutputPathCandidates(
        "Set-Content -Value (Get-Content -Path 'inputs/source.txt') -Path 'artifacts/result.txt'",
      ),
    ).toEqual(['artifacts/result.txt']);
    expect(
      extractCommandOutputPathCandidates(
        `Set-Content -Value '${'x'.repeat(300)}' -Path 'artifacts/result.txt'`,
      ),
    ).toEqual(['artifacts/result.txt']);
    expect(
      extractCommandOutputPathCandidates(
        "Set-Content -Value (Get-Content -Path 'inputs/source.txt')",
      ),
    ).toEqual([]);
    expect(
      extractCommandOutputPathCandidates(
        "Set-Content $output ([System.IO.File]::ReadAllText('inputs/source.txt'))",
      ),
    ).toEqual([]);
    expect(
      extractCommandOutputPathCandidates(
        "node convert.js 'inputs/source.md' --output='artifacts/result.html'",
      ),
    ).toEqual(['artifacts/result.html']);
  });
});
