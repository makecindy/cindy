import { describe, expect, it } from 'vitest';

import {
  isLongPasteText,
  countPasteLines,
  htmlCarriesOwnChipMarkup,
  segmentPastedContent,
  trimPathCandidate,
  toWorkdirRelativePath,
  pastedProjectChipAttrs,
  serializeProjectChipText,
  LONG_PASTE_LINE_THRESHOLD,
  LONG_PASTE_CHAR_THRESHOLD,
  LONG_PASTE_MAX_CHARS,
} from '../components/new-chat/pastePipeline';

const SESSION_URL = 'xdt-maker://session/ee59672a-5591-48a7-a44d-aa97e3808c64';
const PROJECT_URL = 'xdt-maker://project/%2FUsers%2Fdash%2FCode%2FTools%2Fxdt-maker';
const WORKDIR = '/Users/alice/Code/Tools/xdt-maker';
const WIN_WORKDIR = 'C:\\Code\\XDMaker';

describe('isLongPasteText / countPasteLines', () => {
  it('folds by line threshold', () => {
    const under = Array(LONG_PASTE_LINE_THRESHOLD - 1).fill('line').join('\n');
    const over = Array(LONG_PASTE_LINE_THRESHOLD).fill('line').join('\n');
    expect(isLongPasteText(under)).toBe(false);
    expect(isLongPasteText(over)).toBe(true);
  });

  it('folds single-line pastes by char threshold (compact JSON / base64)', () => {
    expect(isLongPasteText('x'.repeat(LONG_PASTE_CHAR_THRESHOLD - 1))).toBe(false);
    expect(isLongPasteText('x'.repeat(LONG_PASTE_CHAR_THRESHOLD))).toBe(true);
  });

  it('counts lines for the chip label, including CRLF and a trailing empty line', () => {
    expect(countPasteLines('a')).toBe(1);
    expect(countPasteLines('a\nb\nc')).toBe(3);
    expect(countPasteLines('a\r\nb\r\n')).toBe(3);
  });

  it('detects own chip markup in clipboard HTML (review P2: chip 回环不走管线)', () => {
    expect(htmlCarriesOwnChipMarkup('<span data-pasted-text-chip="" data-pasted-text="x">t</span>')).toBe(true);
    expect(htmlCarriesOwnChipMarkup('<span data-mention-chip="" data-kind="file">a.ts</span>')).toBe(true);
    expect(htmlCarriesOwnChipMarkup('<span data-composer-quote="" data-quote-text="q">q</span>')).toBe(true);
    expect(htmlCarriesOwnChipMarkup('<a href="https://example.com">普通链接</a>')).toBe(false);
  });

  it('falls back to default paste beyond the max cap (DOM attr payload guard)', () => {
    // 超上限不折叠:原文会写进 data-pasted-text(剪贴板回环),超大文本挂
    // DOM attribute 代价过高 → 走默认粘贴,内容无损。
    expect(isLongPasteText('x'.repeat(LONG_PASTE_MAX_CHARS))).toBe(true);
    expect(isLongPasteText('x'.repeat(LONG_PASTE_MAX_CHARS + 1))).toBe(false);
  });
});

describe('segmentPastedContent — deep links', () => {
  it('returns null when nothing is transformable', () => {
    expect(segmentPastedContent('普通文本 https://example.com')).toBeNull();
    expect(segmentPastedContent('xdt-maker://other/foo')).toBeNull();
  });

  it('splits bare session and project links out of surrounding text', () => {
    expect(segmentPastedContent(`看 ${SESSION_URL} 和 ${PROJECT_URL} 两个`)).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'session', href: SESSION_URL, label: null },
      { kind: 'text', text: ' 和 ' },
      { kind: 'project', href: PROJECT_URL, label: null },
      { kind: 'text', text: ' 两个' },
    ]);
  });

  it('extracts explicit labels from markdown-form links (both kinds)', () => {
    expect(
      segmentPastedContent(`[修复白屏](${SESSION_URL}) 与 [主仓](${PROJECT_URL})`),
    ).toEqual([
      { kind: 'session', href: SESSION_URL, label: '修复白屏' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'project', href: PROJECT_URL, label: '主仓' },
    ]);
  });

  it('keeps square brackets inside markdown labels intact (PR #970 review P1)', () => {
    expect(segmentPastedContent(`[[WIP] 修复白屏](${SESSION_URL})`)).toEqual([
      { kind: 'session', href: SESSION_URL, label: '[WIP] 修复白屏' },
    ]);
    expect(segmentPastedContent(`[[主] 仓库](${PROJECT_URL})`)).toEqual([
      { kind: 'project', href: PROJECT_URL, label: '[主] 仓库' },
    ]);
  });

  it('treats escaped brackets in labels as literals (PR #970 review P1 round 3)', () => {
    // `\]` 不参与括号配对 → 整段仍是一个带标题的链接,展示时反转义。
    expect(segmentPastedContent(`[修复 \\] 白屏](${SESSION_URL})`)).toEqual([
      { kind: 'session', href: SESSION_URL, label: '修复 ] 白屏' },
    ]);
    expect(segmentPastedContent(`[\\[WIP\\] 修复](${SESSION_URL})`)).toEqual([
      { kind: 'session', href: SESSION_URL, label: '[WIP] 修复' },
    ]);
    // 锚点 `]` 自身被转义 → 不是链接收尾,内部 href 走裸链接降级。
    expect(segmentPastedContent(`[标题\\](${PROJECT_URL})`)).toEqual([
      { kind: 'text', text: '[标题\\](' },
      { kind: 'project', href: PROJECT_URL, label: null },
      { kind: 'text', text: ')' },
    ]);
    // `\\]` 是「字面反斜杠 + 真括号」(偶数反斜杠),照常配对收尾。
    expect(segmentPastedContent(`[标题\\\\](${SESSION_URL})`)).toEqual([
      { kind: 'session', href: SESSION_URL, label: '标题\\\\' },
    ]);
  });

  it('strips trailing english punctuation from bare links only', () => {
    expect(segmentPastedContent(`see ${PROJECT_URL}.`)).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'project', href: PROJECT_URL, label: null },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves malformed deep links as plain text', () => {
    expect(segmentPastedContent('xdt-maker://session/')).toBeNull();
    expect(segmentPastedContent('xdt-maker://project/')).toBeNull();
  });

  // 双 scheme 收敛:主 scheme cindy:// 与历史 xdt-maker://(上方全部用例)
  // 走同一条分段管线。
  it('segments primary-scheme cindy:// links (bare + markdown, mixed with legacy)', () => {
    const cindySession = 'cindy://session/ee59672a-5591-48a7-a44d-aa97e3808c64';
    const cindyProject = 'cindy://project/%2Ftmp%2Fx';
    expect(segmentPastedContent(`看 ${cindySession} 和 [主仓](${cindyProject})`)).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'session', href: cindySession, label: null },
      { kind: 'text', text: ' 和 ' },
      { kind: 'project', href: cindyProject, label: '主仓' },
    ]);
    expect(segmentPastedContent(`${SESSION_URL} 与 ${cindySession}`)).toEqual([
      { kind: 'session', href: SESSION_URL, label: null },
      { kind: 'text', text: ' 与 ' },
      { kind: 'session', href: cindySession, label: null },
    ]);
    expect(segmentPastedContent('cindy://session/')).toBeNull();
    expect(segmentPastedContent('cindy://other/foo')).toBeNull();
  });

  it('rejects legacy project links with raw delimiters instead of prefix-matching (review P2)', () => {
    // 旧编码(普通 encodeURIComponent)放行 `'()`,历史已复制的链接可能含
    // 裸字符;白名单在此截断会得到「合法但指错项目」的前缀——整段降级纯文本。
    expect(segmentPastedContent('xdt-maker://project/%2Ftmp%2Ffoo(copy)')).toBeNull();
    expect(segmentPastedContent("xdt-maker://project/%2FJohn's%20Repo")).toBeNull();
  });

  it('still matches a bare project link wrapped in prose parentheses', () => {
    expect(segmentPastedContent(`(${PROJECT_URL})`)).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'project', href: PROJECT_URL, label: null },
      { kind: 'text', text: ')' },
    ]);
  });
});

describe('segmentPastedContent — path candidates', () => {
  it('keeps paths embedded in prose as literal text', () => {
    const inPath = `${WORKDIR}/apps/desktop/src/main.ts`;
    expect(
      segmentPastedContent(`报错在 ${inPath} 附近,系统文件 /etc/hosts 无关`, {
        workingDir: WORKDIR,
      }),
    ).toBeNull();
  });

  it('keeps multiline terminal output containing a Windows workspace path unchanged', () => {
    const script = 'C:\\Code\\XDMaker\\scripts\\build.sh';
    const output = `running build\n/bin/bash: ${script}: No such file or directory\nexit 127`;
    expect(segmentPastedContent(output, { workingDir: WIN_WORKDIR })).toBeNull();
  });

  it('emits a path segment when the entire paste is one workspace path', () => {
    const inPath = `${WORKDIR}/apps/desktop/src/main.ts`;
    expect(segmentPastedContent(inPath, { workingDir: WORKDIR })).toEqual([
      { kind: 'path', path: inPath },
    ]);
    expect(segmentPastedContent(`  ${inPath}\n`, { workingDir: WORKDIR })).toEqual([
      { kind: 'text', text: '  ' },
      { kind: 'path', path: inPath },
      { kind: 'text', text: '\n' },
    ]);
  });

  it('does not treat the workingDir itself as a path segment', () => {
    expect(segmentPastedContent(`目录是 ${WORKDIR} 本体`, { workingDir: WORKDIR })).toBeNull();
  });

  it('does not treat the workingDir itself with a trailing separator as a path segment (review P2)', () => {
    // `cd <workdir>/` 从终端复制的常见形态:尾斜杠变体绕过本体守卫会升级成
    // 空 chip(相对路径为空串),原文丢失。归一后同样保持原文。
    expect(segmentPastedContent(`cd ${WORKDIR}/`, { workingDir: WORKDIR })).toBeNull();
  });

  it('does not upgrade a path used as part of a shell command', () => {
    const dir = `${WORKDIR}/apps/desktop`;
    expect(segmentPastedContent(`cd ${dir}/`, { workingDir: WORKDIR })).toBeNull();
  });

  it('keeps a path with diagnostic suffix and prose as literal text', () => {
    const p = `${WORKDIR}/src/index.ts`;
    expect(segmentPastedContent(`${p}:12:5 报错`, { workingDir: WORKDIR })).toBeNull();
  });

  it('recognizes paths with CJK dir / file names (review P2)', () => {
    const cjkPath = `${WORKDIR}/文档/需求说明.md`;
    expect(segmentPastedContent(cjkPath, { workingDir: WORKDIR })).toEqual([
      { kind: 'path', path: cjkPath },
    ]);
    // 全角标点终止路径(， 全角逗号不吞进候选;ASCII 逗号是合法路径
    // 字符,紧贴场景按文档注释走「吞入候选 → stat miss 安全降级」)
    expect(segmentPastedContent(`${cjkPath}，另外`, { workingDir: WORKDIR })).toBeNull();
  });

  it('matches Windows paths case-insensitively against the workingDir', () => {
    const winPath = 'c:\\code\\xdmaker\\Apps\\main.ts';
    expect(segmentPastedContent(winPath, { workingDir: WIN_WORKDIR })).toEqual([
      { kind: 'path', path: winPath },
    ]);
  });

  it('matches Windows slash-form paths against a backslash workingDir (review P2)', () => {
    // Git Bash / Node 输出常用 C:/... 斜杠形态,workdir 存的是 C:\... 反斜杠形态。
    const slashPath = 'C:/Code/XDMaker/src/a.ts';
    expect(segmentPastedContent(slashPath, { workingDir: WIN_WORKDIR })).toEqual([
      { kind: 'path', path: slashPath },
    ]);
    expect(toWorkdirRelativePath(slashPath, WIN_WORKDIR)).toBe('src/a.ts');
  });

  it('skips path detection when workingDir is absent from the text (fast path)', () => {
    expect(segmentPastedContent('/some/other/root/file.ts', { workingDir: WORKDIR })).toBeNull();
  });

  it('keeps paths literal while still converting deep links in the same paste', () => {
    const p = `${WORKDIR}/README.md`;
    expect(
      segmentPastedContent(`${SESSION_URL} 里改了 ${p}`, { workingDir: WORKDIR }),
    ).toEqual([
      { kind: 'session', href: SESSION_URL, label: null },
      { kind: 'text', text: ` 里改了 ${p}` },
    ]);
  });
});

describe('trimPathCandidate / toWorkdirRelativePath', () => {
  it('trims line suffixes, punctuation and closing brackets', () => {
    expect(trimPathCandidate('/a/b.ts:12')).toBe('/a/b.ts');
    expect(trimPathCandidate('/a/b.ts:12:5')).toBe('/a/b.ts');
    expect(trimPathCandidate('/a/b.ts,')).toBe('/a/b.ts');
    expect(trimPathCandidate('/a/b.ts)')).toBe('/a/b.ts');
  });

  it('trims interleaved line suffixes and punctuation to a fixpoint (review P2)', () => {
    // `path:line, …` / `path:line:col.` 是 agent 输出的常见形态:行号后缀
    // 跟着句读时单遍剥离会残留 `:12`,stat 必 miss。
    expect(trimPathCandidate('/a/b.ts:12,')).toBe('/a/b.ts');
    expect(trimPathCandidate('/a/b.ts:12:5.')).toBe('/a/b.ts');
    expect(trimPathCandidate('/a/b.ts:12),')).toBe('/a/b.ts');
    expect(trimPathCandidate('/a/b.ts:12:5):')).toBe('/a/b.ts');
  });

  it('trims trailing path separators (review P2)', () => {
    // shell 补全 / `cd xxx/` 的尾分隔符不剥会产出 `apps/desktop//` chip。
    expect(trimPathCandidate('/a/b/')).toBe('/a/b');
    expect(trimPathCandidate('C:\\Code\\XDMaker\\apps\\')).toBe('C:\\Code\\XDMaker\\apps');
    expect(trimPathCandidate('/a/b/.')).toBe('/a/b');
  });

  it('converts to workdir-relative with forward slashes', () => {
    expect(toWorkdirRelativePath(`${WORKDIR}/apps/desktop/main.ts`, WORKDIR)).toBe(
      'apps/desktop/main.ts',
    );
    expect(toWorkdirRelativePath('C:\\Code\\XDMaker\\apps\\main.ts', WIN_WORKDIR)).toBe(
      'apps/main.ts',
    );
  });
});

describe('pastedProjectChipAttrs / serializeProjectChipText', () => {
  it('uses the explicit label as titled, else the dir basename untitled', () => {
    expect(pastedProjectChipAttrs({ kind: 'project', href: PROJECT_URL, label: '主仓' })).toEqual({
      kind: 'project',
      label: '主仓',
      path: PROJECT_URL,
      titled: true,
    });
    expect(pastedProjectChipAttrs({ kind: 'project', href: PROJECT_URL, label: null })).toEqual({
      kind: 'project',
      label: 'xdt-maker',
      path: PROJECT_URL,
      titled: false,
    });
  });

  it('serializes titled chips to markdown links and untitled to the bare href', () => {
    expect(
      serializeProjectChipText({ kind: 'project', label: '主仓', path: PROJECT_URL, titled: true }),
    ).toBe(`[主仓](${PROJECT_URL})`);
    expect(
      serializeProjectChipText({ kind: 'project', label: 'xdt-maker', path: PROJECT_URL, titled: false }),
    ).toBe(PROJECT_URL);
  });
});
