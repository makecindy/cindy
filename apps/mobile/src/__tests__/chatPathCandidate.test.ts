import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canOpenChatPathChip,
  chatPathLabelReadsAsFileReference,
  classifyChatPathLinkTarget,
  classifyInlineCodePathCandidate,
  dropDotSegments,
  findBareFilePathMatch,
  isAbsolutePathShape,
  looksLikeBareFileReference,
  looksLikeFilePath,
  pathDisplayName,
  resolveChatAbsPath,
  splitChatPathLineSuffix,
  toWorkdirRel,
} from '@/session/chatPathCandidate';

describe('splitChatPathLineSuffix', () => {
  it('拆 path:line 与 path:line:column', () => {
    expect(splitChatPathLineSuffix('src/App.tsx:42')).toEqual({ href: 'src/App.tsx', line: 42 });
    expect(splitChatPathLineSuffix('src/App.tsx:42:7')).toEqual({ href: 'src/App.tsx', line: 42, column: 7 });
  });

  it('拆 path:start-end 行区间(取起始行)', () => {
    expect(splitChatPathLineSuffix('src/App.tsx:10-20')).toEqual({ href: 'src/App.tsx', line: 10 });
  });

  it('非法区间 / 非数字后缀原样返回', () => {
    expect(splitChatPathLineSuffix('src/App.tsx:20-10')).toEqual({ href: 'src/App.tsx:20-10' });
    expect(splitChatPathLineSuffix('foo:bar')).toEqual({ href: 'foo:bar' });
  });

  it('http URL 不拆(端口冒号不是行号)', () => {
    expect(splitChatPathLineSuffix('http://x.com:8080')).toEqual({ href: 'http://x.com:8080' });
  });
});

describe('looksLikeFilePath / looksLikeBareFileReference', () => {
  it('接受相对带分隔符带扩展 / 绝对 / Windows 绝对', () => {
    expect(looksLikeFilePath('src/App.tsx')).toBe(true);
    expect(looksLikeFilePath('./docs/readme.md')).toBe(true);
    expect(looksLikeFilePath('/Users/me/foo.md')).toBe(true);
    expect(looksLikeFilePath('C:\\proj\\foo.ts')).toBe(true);
  });

  it('拒绝命令 / URL / 目录尾斜杠', () => {
    expect(looksLikeFilePath('npm run build')).toBe(false);
    expect(looksLikeFilePath('https://x.com/a.ts')).toBe(false);
    expect(looksLikeFilePath('src/components/')).toBe(false);
  });

  it('裸文件名走 bare reference', () => {
    expect(looksLikeBareFileReference('package.json')).toBe(true);
    expect(looksLikeBareFileReference('useState')).toBe(false);
  });
});

describe('classifyInlineCodePathCandidate', () => {
  it('文件路径 + 行号 → 候选', () => {
    expect(classifyInlineCodePathCandidate('src/App.tsx:42')).toEqual({
      href: 'src/App.tsx',
      line: 42,
      directoryShape: false,
      ambiguousShape: false,
    });
  });

  it('目录尾斜杠 → 去尾杠 + directoryShape', () => {
    expect(classifyInlineCodePathCandidate('src/components/')).toEqual({
      href: 'src/components',
      directoryShape: true,
      ambiguousShape: false,
    });
    expect(classifyInlineCodePathCandidate('./Skills/')).toEqual({
      href: './Skills',
      directoryShape: true,
      ambiguousShape: false,
    });
  });

  it('无分隔符无扩展的目录名(如 src)不候选,含分隔符无扩展候选', () => {
    // 裸词太误伤(useState / src),必须有路径形状信号。
    expect(classifyInlineCodePathCandidate('src')).toBeNull();
    expect(classifyInlineCodePathCandidate('src/components')).toEqual({
      href: 'src/components',
      directoryShape: false,
      // 有分隔符但无扩展名 → 与 `and/or` 同形,进歧义档(仍是候选,只是点亮需远端确认)。
      ambiguousShape: true,
    });
  });

  it('标识符 / 命令 / scheme / 多行 / 带首尾空白不候选', () => {
    expect(classifyInlineCodePathCandidate('useState')).toBeNull();
    expect(classifyInlineCodePathCandidate('pnpm --filter desktop typecheck')).toBeNull();
    expect(classifyInlineCodePathCandidate('mailto:a@b.com')).toBeNull();
    expect(classifyInlineCodePathCandidate('git+ssh://host/repo')).toBeNull();
    expect(classifyInlineCodePathCandidate('a.ts\nb.ts')).toBeNull();
    expect(classifyInlineCodePathCandidate(' src/App.tsx')).toBeNull();
  });

  it('裸文件名候选(存在性交给远端 stat)', () => {
    expect(classifyInlineCodePathCandidate('package.json')).toEqual({
      href: 'package.json',
      directoryShape: false,
      // 裸文件名 → 与 `array.map` 同形,进歧义档。
      ambiguousShape: true,
    });
  });
});

describe('classifyChatPathLinkTarget', () => {
  it('绝对路径 + 行号后缀 → 候选(截图实例形态)', () => {
    expect(classifyChatPathLinkTarget('/Users/me/proj/README.md:17')).toEqual({
      href: '/Users/me/proj/README.md',
      line: 17,
      directoryShape: false,
      ambiguousShape: false,
    });
  });

  it('相对 / Windows / file:// / 目录尾斜杠', () => {
    expect(classifyChatPathLinkTarget('src/App.tsx')).toEqual({
      href: 'src/App.tsx',
      directoryShape: false,
      ambiguousShape: false,
    });
    expect(classifyChatPathLinkTarget('C:\\proj\\a.json')).toEqual({
      href: 'C:\\proj\\a.json',
      directoryShape: false,
      ambiguousShape: false,
    });
    expect(classifyChatPathLinkTarget('file:///Users/me/a.md')).toEqual({
      href: 'file:///Users/me/a.md',
      directoryShape: false,
      ambiguousShape: false,
    });
    expect(classifyChatPathLinkTarget('brand/liz-logo/')).toEqual({
      href: 'brand/liz-logo',
      directoryShape: true,
      ambiguousShape: false,
    });
  });

  it('http / 锚点 / mailto / 非路径形状 → null', () => {
    expect(classifyChatPathLinkTarget('https://x.com/a.ts')).toBeNull();
    expect(classifyChatPathLinkTarget('#section')).toBeNull();
    expect(classifyChatPathLinkTarget('mailto:a@b.com')).toBeNull();
    expect(classifyChatPathLinkTarget('xdt-maker://session/abc')).toBeNull();
    expect(classifyChatPathLinkTarget('2')).toBeNull();
  });
});

describe('resolveChatAbsPath', () => {
  it('POSIX workdir join 相对路径', () => {
    expect(resolveChatAbsPath('src/App.tsx', '/w/proj')).toBe('/w/proj/src/App.tsx');
    expect(resolveChatAbsPath('./a.md', '/w/proj/')).toBe('/w/proj/./a.md');
  });

  it('Windows workdir 按反斜杠 join 并归一 href 分隔符', () => {
    expect(resolveChatAbsPath('src/App.tsx', 'C:\\proj')).toBe('C:\\proj\\src\\App.tsx');
  });

  it('绝对路径原样返回', () => {
    expect(resolveChatAbsPath('/abs/x.ts', '/w')).toBe('/abs/x.ts');
    expect(resolveChatAbsPath('D:\\x\\y.ts', 'C:\\proj')).toBe('D:\\x\\y.ts');
  });

  it('file:// 解包(含 Windows 形态)', () => {
    expect(resolveChatAbsPath('file:///w/a.ts', '/w')).toBe('/w/a.ts');
    expect(resolveChatAbsPath('file:///C:/x/a.ts', 'C:\\proj')).toBe('C:/x/a.ts');
  });

  it('file:// 含非法百分号序列不 throw,回退原文', () => {
    expect(resolveChatAbsPath('file:///w/50%off.md', '/w')).toBe('/w/50%off.md');
  });
});

describe('toWorkdirRel', () => {
  it('POSIX:workdir 内 → POSIX 相对;`.` 段归一', () => {
    expect(toWorkdirRel('/w/proj', '/w/proj/src/a.ts')).toBe('src/a.ts');
    expect(toWorkdirRel('/w/proj', '/w/proj/./src/a.ts')).toBe('src/a.ts');
  });

  it('POSIX:workdir 外 / 自身 / `..` 逃逸 → null', () => {
    expect(toWorkdirRel('/w/proj', '/etc/passwd')).toBeNull();
    expect(toWorkdirRel('/w/proj', '/w/proj')).toBeNull();
    expect(toWorkdirRel('/w/proj', '/w/proj/../x')).toBeNull();
    // 前缀相似但不是路径边界:/w/proj2 不在 /w/proj 内。
    expect(toWorkdirRel('/w/proj', '/w/proj2/a.ts')).toBeNull();
  });

  it('Windows:大小写不敏感前缀,输出 POSIX 分隔', () => {
    expect(toWorkdirRel('C:\\Proj', 'c:\\proj\\src\\a.ts')).toBe('src/a.ts');
    expect(toWorkdirRel('C:\\Proj', 'D:\\other\\a.ts')).toBeNull();
  });

  it('风格不匹配 → null', () => {
    expect(toWorkdirRel('/w/proj', 'C:\\x\\a.ts')).toBeNull();
  });
});

describe('dropDotSegments', () => {
  it('去 `.` 段并保留绝对前缀', () => {
    expect(dropDotSegments('/w/./a')).toBe('/w/a');
    expect(dropDotSegments('./a/b')).toBe('a/b');
  });
});

describe('isAbsolutePathShape / pathDisplayName', () => {
  it('绝对形态:POSIX 与 Windows 盘符;相对路径不算', () => {
    expect(isAbsolutePathShape('/tmp/a.png')).toBe(true);
    expect(isAbsolutePathShape('C:\\tmp\\a.png')).toBe(true);
    expect(isAbsolutePathShape('src/a.ts')).toBe(false);
    expect(isAbsolutePathShape('a.ts')).toBe(false);
  });

  it('显示名取最后一段,兼容反斜杠与尾分隔符', () => {
    expect(pathDisplayName('/tmp/cindy-web-hero.png')).toBe('cindy-web-hero.png');
    expect(pathDisplayName('C:\\tmp\\shot.png')).toBe('shot.png');
    expect(pathDisplayName('src/components/')).toBe('components');
    expect(pathDisplayName('a.md')).toBe('a.md');
  });
});

describe('canOpenChatPathChip', () => {
  it('文件始终可开(workdir 内 relPath / workdir 外 null 均可)', () => {
    expect(canOpenChatPathChip('file', 'src/a.ts')).toBe(true);
    expect(canOpenChatPathChip('file', null)).toBe(true);
  });

  it('目录仅 workdir 内可开(文件浏览器以 workdir 为根)', () => {
    expect(canOpenChatPathChip('directory', 'src/components')).toBe(true);
    expect(canOpenChatPathChip('directory', null)).toBe(false);
  });
});

describe('歧义候选的点亮门槛(DESIGN.md §14.5 规则 5)', () => {
  // 缺陷背景:行内 code 的候选口径必须宽松(`src/components` 这类真实目录引用与
  // `and/or` 词法完全同形,想排除后者就会连前者一起砍掉),而手机端对 verdict
  // `unknown`(链路断)是乐观点亮的 —— 两者叠起来,链路一抖满屏普通行内 code 就变成
  // 可点的假链接。精度靠 ambiguousShape 在点亮门槛上分档,而不是靠砍候选。
  const ambiguity = (text: string) => {
    const c = classifyInlineCodePathCandidate(text);
    if (!c) return 'not-candidate';
    return c.ambiguousShape ? 'needs-confirmation' : 'optimistic-ok';
  };

  it('形状明确是路径 → 断链时仍乐观点亮(不因断链把整条消息 chip 全灭)', () => {
    expect(ambiguity('src/App.tsx')).toBe('optimistic-ok');
    expect(ambiguity('/Users/me/out/hero.png')).toBe('optimistic-ok');
    expect(ambiguity('C:\\proj\\a.ts')).toBe('optimistic-ok');
    expect(ambiguity('src/components/')).toBe('optimistic-ok'); // 尾斜杠 = 显式目录信号
  });

  it('与属性访问同形的裸名 → 必须远端确认才点亮', () => {
    for (const sample of ['array.map', 'console.log', 'Date.now', 'obj.value', 'React.memo', '1.2', 'v1.0']) {
      expect(ambiguity(sample), sample).toBe('needs-confirmation');
    }
    // 真实裸文件名与它们同形,同样进歧义档 —— 存在即点亮,不存在保持纯文本。
    expect(ambiguity('package.json')).toBe('needs-confirmation');
  });

  it('分隔符无扩展 → 同档:真实目录可点,and/or 这类永不存在自然不点亮', () => {
    expect(ambiguity('src/components')).toBe('needs-confirmation');
    for (const sample of ['and/or', 'read/write', 'n/a', 'w/o', 'A/B', 'text/plain']) {
      expect(ambiguity(sample), sample).toBe('needs-confirmation');
    }
  });

  // ── 点亮门槛对**所有候选来源**同口径(不变量 B)────────────────────────────
  // 这里曾断言「显式链接不进歧义档」并钉住了实现 —— 那是把 §14.5 **规则 4(候选门槛)**
  // 的来源豁免误用到**规则 5(点亮门槛)**上。作者声明「这是链接」并不能让远端在链路断
  // 时知道 package.json 是否存在,而点亮了却点不开正是规则 1 要防的反例;桌面
  // isAmbiguousPathShape 对全部 local-candidate 一视同仁,两端曾因此不对称
  // (PR #1144 review 实捉,2026-07-31 检查点统一)。
  const linkAmbiguity = (url: string) => {
    const c = classifyChatPathLinkTarget(url);
    if (!c) return 'not-candidate';
    return c.ambiguousShape ? 'needs-confirmation' : 'optimistic-ok';
  };

  it('显式链接的点亮门槛与行内 code 完全一致(逐样本对照,不留来源豁免)', () => {
    for (const sample of [
      '/Users/me/out/hero.png', 'src/App.tsx', 'C:\\proj\\a.ts', 'src/components/',
      'package.json', 'array.map', 'src/components', 'and/or', 'text/plain',
    ]) {
      expect(linkAmbiguity(sample), `链接入口 ${sample} 与行内 code 不同档`)
        .toBe(ambiguity(sample));
    }
  });

  it('候选门槛的来源豁免仍在:链接入口比行内 code 宽(规则 4 未被连带收紧)', () => {
    // 宽松兜底(looksLikeLocalHref)是链接入口独有的;修点亮门槛不得顺手砍掉它,
    // 否则这些目标会连候选都进不去、连 stat 都不发,变成能力倒退。
    expect(classifyChatPathLinkTarget('2')).toBeNull(); // 非路径形状仍拒
    for (const sample of ['package.json', 'src/components']) {
      expect(classifyChatPathLinkTarget(sample), `${sample} 掉出候选`).not.toBeNull();
    }
  });

  it('file:// 永不歧义 —— 最明确的形态不得被判成最可疑的', () => {
    // looksLikeFilePath 会被 URL_SCHEME_RE 挡掉而回 false,直接照抄它就会把
    // file:///abs/a.md 打进歧义档(2026-07-31 检查点自查发现,reviewer 未提)。
    expect(linkAmbiguity('file:///Users/me/a.md')).toBe('optimistic-ok');
    expect(linkAmbiguity('file:///Users/me/no-ext-dir')).toBe('optimistic-ok');
  });

  it('正文裸路径入口不受影响:词法强制带扩展名 → 恒非歧义', () => {
    // 这条钉住「修链接入口不是一刀切全判歧义」:裸路径的能力必须一寸不退。
    const prose = '见 src/App.tsx、./a/b.py、../x/y.json、/abs/hero.png 与 C:\\p\\a.ts';
    let from = 0;
    const hits: string[] = [];
    for (;;) {
      const m = findBareFilePathMatch(prose, from);
      if (!m) break;
      hits.push(m.value);
      from = m.end;
    }
    expect(hits.length).toBeGreaterThanOrEqual(5);
    for (const value of hits) {
      expect(linkAmbiguity(value), `裸路径 ${value} 被降级成需确认`).toBe('optimistic-ok');
    }
  });
});

describe('ambiguousShape 只能由单一判据产出(源码级守卫)', () => {
  // 三个入口(行内 code / 显式链接 / 裸路径)历史上各自硬写过字面量,于是同一语义
  // 在代码里有三份判据、改一处漏两处。收敛后只允许调 isAmbiguousChatPathShape。
  it('chatPathCandidate.ts 里不出现 `ambiguousShape: true/false` 字面量', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/session/chatPathCandidate.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src, 'ambiguousShape 被硬写成字面量 —— 应统一走 isAmbiguousChatPathShape')
      .not.toMatch(/ambiguousShape:\s*(true|false)\b/);
  });
});

describe('chatPathLabelReadsAsFileReference(决定手写链接是否保留等宽 chip)', () => {
  // 桌面 shouldRenderCodeReferenceLabel 的移植,两端口径需同步。
  const c = (url: string) => {
    const cand = classifyChatPathLinkTarget(url);
    expect(cand, `期望 ${url} 是路径候选`).not.toBeNull();
    return cand!;
  };

  it('label 是 href 原文 / 末段文件名 / 文件名带行号 → 是文件引用', () => {
    const url = '/Users/me/proj/README.md:17';
    const cand = c(url);
    expect(chatPathLabelReadsAsFileReference('/Users/me/proj/README.md', cand, url)).toBe(true);
    expect(chatPathLabelReadsAsFileReference(url, cand, url)).toBe(true);
    expect(chatPathLabelReadsAsFileReference('README.md', cand, url)).toBe(true);
    expect(chatPathLabelReadsAsFileReference('README.md:17', cand, url)).toBe(true);
  });

  it('label 自身长得像路径 / 文件名 → 形状兜底也算', () => {
    const url = 'docs/design-rules/DESIGN.md';
    expect(chatPathLabelReadsAsFileReference('src/App.tsx', c(url), url)).toBe(true);
    expect(chatPathLabelReadsAsFileReference('package.json', c(url), url)).toBe(true);
  });

  it('散文 label → 不是文件引用(走正文字体 + 下划线)', () => {
    const url = 'docs/design-rules/DESIGN.md';
    expect(chatPathLabelReadsAsFileReference('看这份规则', c(url), url)).toBe(false);
    expect(chatPathLabelReadsAsFileReference('设计规范', c(url), url)).toBe(false);
    expect(chatPathLabelReadsAsFileReference('', c(url), url)).toBe(false);
    expect(chatPathLabelReadsAsFileReference('第一行\n第二行', c(url), url)).toBe(false);
  });
});

describe('findBareFilePathMatch(正文纯文本裸路径词法)', () => {
  // 用例逐条对照桌面 apps/desktop/src/renderer/__tests__/remarkLocalPathLinks.test.ts,
  // 两端口径必须一致;桌面那份改了这份要跟。
  /** 从头扫一遍,列出全部命中(桌面 linkUrls 的等价物)。 */
  const allValues = (text: string): string[] => {
    const out: string[] = [];
    let cursor = 0;
    for (;;) {
      const match = findBareFilePathMatch(text, cursor);
      if (!match) return out;
      out.push(match.value);
      cursor = match.end;
    }
  };

  // ── 应该识别的场景 ──

  it('正文里的相对路径(带分隔符 + 扩展名),并给出精确区间', () => {
    const match = findBareFilePathMatch('见 src/App.tsx 第 20 行', 0);
    expect(match).toEqual({ index: 2, end: 13, value: 'src/App.tsx' });
    // 区间外是纯文本,分词层据此切前后两段。
    expect('见 src/App.tsx 第 20 行'.slice(0, match!.index)).toBe('见 ');
    expect('见 src/App.tsx 第 20 行'.slice(match!.end)).toBe(' 第 20 行');
  });

  it('深层相对路径', () => {
    expect(allValues('改的是 apps/desktop/src/main/pathResolver.ts 这个文件'))
      .toEqual(['apps/desktop/src/main/pathResolver.ts']);
  });

  it('Windows 绝对路径', () => {
    expect(allValues('文件在 C:\\Users\\me\\proj\\app.tsx 里')).toEqual(['C:\\Users\\me\\proj\\app.tsx']);
  });

  it('POSIX 绝对路径', () => {
    expect(allValues('路径 /Users/me/proj/app.tsx 打开看看')).toEqual(['/Users/me/proj/app.tsx']);
  });

  it('带 :line / :line:column 行号后缀整体进 value,渲染层再拆', () => {
    expect(allValues('见 src/App.tsx:42 那行')).toEqual(['src/App.tsx:42']);
    expect(allValues('见 src/App.tsx:42:7 那列')).toEqual(['src/App.tsx:42:7']);
  });

  it('一段里多个路径都识别', () => {
    expect(allValues('对比 src/a.ts 和 src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('剥两侧包裹标点:括号 / 句末逗号 / 前置 ASCII 冒号', () => {
    expect(allValues('(见 src/App.tsx)')).toEqual(['src/App.tsx']);
    expect(allValues('改了 src/App.tsx,然后呢')).toEqual(['src/App.tsx']);
    expect(allValues('文件:src/App.tsx。完')).toEqual(['src/App.tsx']);
  });

  it('含 CJK 目录名的相对路径', () => {
    expect(allValues('在 docs/设计稿/index.md 里')).toEqual(['docs/设计稿/index.md']);
  });

  it('./ ../ ~/ 锚点的相对路径(单层也认)', () => {
    expect(allValues('打开 ./foo.md 看')).toEqual(['./foo.md']);
    expect(allValues('在 ../sib/foo.json 里')).toEqual(['../sib/foo.json']);
    expect(allValues('日志 ~/logs/app.log 末尾')).toEqual(['~/logs/app.log']);
  });

  it('图片扩展名同样识别(桌面「点开看图」的手机对等入口)', () => {
    expect(allValues('生成好了:/Users/me/out/hero.png 看看'))
      .toEqual(['/Users/me/out/hero.png']);
  });

  it('from 之后才开始扫(分词器按 cursor 推进)', () => {
    const text = 'a/b.ts 和 c/d.ts';
    expect(findBareFilePathMatch(text, 0)?.value).toBe('a/b.ts');
    expect(findBareFilePathMatch(text, 6)?.value).toBe('c/d.ts');
  });

  // ── 不应该识别的场景 ──

  it('裸文件名(无分隔符)不识别——正文里太歧义(严于 inline code)', () => {
    expect(allValues('改一下 package.json 配置')).toEqual([]);
    // 同一串在 inline code 形态下是候选,口径差异是刻意的。
    expect(looksLikeBareFileReference('package.json')).toBe(true);
  });

  it('普通带斜杠的词不识别:and/or、读写比', () => {
    expect(allValues('支持 and/or 两种')).toEqual([]);
    expect(allValues('读/写 比例')).toEqual([]);
  });

  it('URL 不识别(裸文本形态)', () => {
    expect(allValues('看 https://example.com/path/page 这个')).toEqual([]);
    // 带扩展名的 URL 同样不被切出内部路径段(左边界卡死 + scheme 复核)。
    expect(allValues('图在 https://example.com/a/b.png')).toEqual([]);
  });

  it('目录(尾部分隔符)不识别', () => {
    expect(allValues('放在 src/components/ 下')).toEqual([]);
  });

  it('没有任何分隔符的句子走短路,直接不命中', () => {
    expect(findBareFilePathMatch('这是一句普通的中文,没有任何路径。', 0)).toBeNull();
  });

  it('已知限制:中文紧贴路径无空白边界时,前导中文被并入 token', () => {
    // CJK 既可能是 prose(见)也可能是真实目录名(我的看板),词法层无法区分。
    // 并进去的 token 解析不到真实文件 → 经 stat 闸门后仍是纯文本(与现状一致,非回退)。
    expect(allValues('见src/App.tsx')).toEqual(['见src/App.tsx']);
  });

  it('已知限制:中文黏连两条真路径会吞成一个 token,两条都点不亮', () => {
    // 救它只能把 CJK 当分隔符,但会反过来切断 docs/设计稿/index.md,得不偿失。
    expect(allValues('改了 a/b.ts和c/d.ts')).toEqual(['a/b.ts和c/d.ts']);
  });

  it('负例:版本号 / 宽高比进候选,靠远端 stat 兜底不变 chip', () => {
    // 形状上满足「带分隔符 + 扩展名」,词法层无法排除;stat 判 nonfile → 纯文本。
    expect(allValues('比例 16/9.0 居中')).toEqual(['16/9.0']);
    expect(allValues('记作 a/b.c 即可')).toEqual(['a/b.c']);
  });
});

describe('路径 chip 的可点信号(源码级守卫)', () => {
  // DESIGN.md §14.5:可点与不可点的差异**只应是那条下划线**(对齐 GitHub ——
  // `.markdown-body code` 不定义 color、纯靠继承,`.markdown-body a` 只加
  // text-decoration、不加 font-weight)。RN 的样式合成没有类型保护,只能源码层钉。
  const readRenderer = () =>
    readFileSync(join(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

  it('markdownPathChip 只有下划线:不改文字颜色、不改字重', () => {
    const block = /markdownPathChip:\s*\{([^}]*)\}/.exec(readRenderer());
    expect(block, '未找到 markdownPathChip 样式定义').not.toBeNull();
    const body = block![1];
    expect(body, '缺少下划线').toMatch(/textDecorationLine:\s*'underline'/);
    // 可点的行内 code 必须与不可点的同色同字重 —— 多一个信号,「有横线 = 能点」
    // 这条规则就少一分可信。
    expect(body, '路径 chip 不得改文字颜色(应继承行内 code 的压暗档)').not.toMatch(/\bcolor:/);
    expect(body, '路径 chip 不得改字重').not.toMatch(/fontWeight:/);
  });

  it('markdownLink 只有正文色 + 下划线,不加粗', () => {
    const block = /markdownLink:\s*\{([^}]*)\}/.exec(readRenderer());
    expect(block, '未找到 markdownLink 样式定义').not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/textDecorationLine:\s*'underline'/);
    expect(body, '外链不得加粗(GitHub 的 a 也只有 text-decoration)').not.toMatch(/fontWeight:/);
  });

  it('LinkPathChipSpan 的等宽 chip 是按来源 + label 条件套的,不是无条件开或关', () => {
    const src = readRenderer();
    const start = src.indexOf('function LinkPathChipSpan');
    expect(start, '未找到 LinkPathChipSpan').toBeGreaterThan(-1);
    const body = src.slice(start, start + 2400);
    // 必须先按来源分流(bare = 正文裸写),再过 label 形态判定 —— 无条件去掉
    // markdownInlineCode 会把作者手写的 `[README.md](path)` 一起降级成正文
    // (PR #1144 review 实捉);无条件套上又会让裸路径点亮时形态跳变。
    expect(body, '未按 bare 来源分流').toMatch(/!bare/);
    expect(body, '未复用 label 形态判定').toContain('chatPathLabelReadsAsFileReference');
    // 两个分支都在:套 chip 的与不套的。
    expect(body, '缺少套等宽 chip 的分支').toMatch(/markdownInlineCode[\s\S]*markdownPathChip/);
    expect(body, '缺少不套等宽的分支').toMatch(/\[baseStyle, styles\.markdownPathChip\]/);
  });

  // ── 收敛检查点(PR #1144 两轮 review 各捉到一个「有下划线却点不动」) ──
  // 不变量:**下划线 ⇔ 可点**,双向成立。根因是「加不加下划线」与「有没有 onPress」
  // 在各分支独立决定 → 必然漂移。判据已收成 clickableInlineStyle 一处,这里钉住它
  // 不被重新拆散。能区分错误修法:只修某一处 case 分支的写法过不了第一条。
  it('markdownLink 只能经 clickableInlineStyle 取用,不得在 case 分支里直接写', () => {
    const src = readRenderer();
    const helperStart = src.indexOf('function clickableInlineStyle');
    expect(helperStart, '未找到 clickableInlineStyle —— 判据被拆散了?').toBeGreaterThan(-1);
    const helperEnd = src.indexOf('\n}', helperStart);
    const helperBody = src.slice(helperStart, helperEnd);
    // helper 自己必须按 onPress 决定下划线。
    expect(helperBody, 'helper 未按 onPress 分流').toMatch(/onPress \? styles\.markdownLink : undefined/);
    // 除 helper 自身外,全文件不应再出现 styles.markdownLink 的**用法**。
    // 注释行(含 helper 的 JSDoc,它会引用这个名字来说明规则)不算用法。
    const lines = src.split('\n');
    const others = lines
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => line.includes('styles.markdownLink'))
      .filter(({ line }) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .filter(({ no }) => {
        const at = lines.slice(0, no - 1).join('\n').length;
        return at < helperStart || at > helperEnd;
      });
    expect(
      others.map((o) => `${o.no}: ${o.line.trim()}`),
      '有 case 分支绕过 clickableInlineStyle 直接用 markdownLink —— 会造出「有下划线却点不动」',
    ).toEqual([]);
  });

  it('可点 inline 的 onPress 与样式取同一个值(不出现一边条件、一边无条件)', () => {
    const src = readRenderer();
    // 每个 clickableInlineStyle(styles, X, ...) 的 X 都必须同时是某处的 onPress={X}。
    const handlers = [...src.matchAll(/clickableInlineStyle\(styles,\s*([A-Za-z_$][\w$]*)\s*[,)]/g)]
      .map((m) => m[1]);
    expect(handlers.length, '未找到 clickableInlineStyle 的调用').toBeGreaterThan(0);
    for (const h of handlers) {
      expect(src, `${h} 用作下划线判据却没有作为 onPress 传下去`).toContain(`onPress={${h}}`);
    }
  });

  it('行内 code 形态仍叠在 markdownInlineCode 之后(顺序错了下划线会被覆盖)', () => {
    const src = readRenderer();
    const sites = src.match(/chipStyle=\{\[[^\]]*\]\}/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      const inline = site.indexOf('markdownInlineCode');
      const chip = site.indexOf('markdownPathChip');
      if (inline === -1 || chip === -1) continue;
      expect(chip, `叠加顺序反了:${site}`).toBeGreaterThan(inline);
    }
  });
});
