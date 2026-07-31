import { describe, expect, it } from 'vitest';

import {
  classifyInlineCodeTarget,
  decideRemoteLit,
  isAmbiguousPathShape,
  classifyMarkdownLinkTarget,
  looksLikeBareFileReference,
  splitLocalLineSuffix,
} from '../lib/markdownTarget';

describe('splitLocalLineSuffix', () => {
  it('parses path:line and path:line:column for local references', () => {
    expect(splitLocalLineSuffix('apps/desktop/src/App.tsx:42')).toEqual({
      href: 'apps/desktop/src/App.tsx',
      line: 42,
    });
    expect(splitLocalLineSuffix('D:/AI/xdt-maker/a.ts:12:3')).toEqual({
      href: 'D:/AI/xdt-maker/a.ts',
      line: 12,
      column: 3,
    });
    expect(splitLocalLineSuffix('C:\\repo\\src\\App.tsx:100:2')).toEqual({
      href: 'C:\\repo\\src\\App.tsx',
      line: 100,
      column: 2,
    });
    expect(splitLocalLineSuffix('file:///C:/repo/src/App.tsx:9')).toEqual({
      href: 'file:///C:/repo/src/App.tsx',
      line: 9,
    });
    expect(splitLocalLineSuffix('apps/server/src/services/skills.ts:316-320')).toEqual({
      href: 'apps/server/src/services/skills.ts',
      line: 316,
    });
  });

  it('does not strip ports from http URLs', () => {
    expect(splitLocalLineSuffix('http://localhost:3000')).toEqual({
      href: 'http://localhost:3000',
    });
    expect(splitLocalLineSuffix('https://example.com/a.ts:42')).toEqual({
      href: 'https://example.com/a.ts:42',
    });
  });
});

describe('looksLikeBareFileReference', () => {
  it('accepts bare code filenames and rejects ordinary identifiers', () => {
    expect(looksLikeBareFileReference('MarkdownRenderer.tsx')).toBe(true);
    expect(looksLikeBareFileReference('package.json')).toBe(true);
    expect(looksLikeBareFileReference('useState')).toBe(false);
    expect(looksLikeBareFileReference('npm run build')).toBe(false);
  });
});

describe('classifyMarkdownLinkTarget', () => {
  it('keeps supported external links clickable', () => {
    expect(classifyMarkdownLinkTarget('https://example.com/docs')).toEqual({
      kind: 'external',
      href: 'https://example.com/docs',
    });
  });

  it('keeps anchors and xdt audio as first-class targets', () => {
    expect(classifyMarkdownLinkTarget('#section')).toEqual({
      kind: 'anchor',
      id: 'section',
      href: '#section',
    });
    expect(classifyMarkdownLinkTarget('#%E9%93%BE%E6%8E%A5%E6%B5%8B%E8%AF%95%E6%A0%87%E9%A2%98')).toEqual({
      kind: 'anchor',
      id: '链接测试标题',
      href: '#%E9%93%BE%E6%8E%A5%E6%B5%8B%E8%AF%95%E6%A0%87%E9%A2%98',
    });
    expect(classifyMarkdownLinkTarget('xdt-audio://local/?path=%2Ftmp%2Fa.mp3')).toEqual({
      kind: 'audio',
      href: 'xdt-audio://local/?path=%2Ftmp%2Fa.mp3',
    });
  });

  it('routes xdt image/file URLs as direct image preview targets', () => {
    expect(classifyMarkdownLinkTarget('xdt-image://sess/a.png')).toEqual({
      kind: 'local-image-url',
      href: 'xdt-image://sess/a.png',
    });
    expect(classifyMarkdownLinkTarget('xdt-file://local/?path=%2Ftmp%2Fa.png')).toEqual({
      kind: 'local-image-url',
      href: 'xdt-file://local/?path=%2Ftmp%2Fa.png',
    });
  });

  it('turns explicit local links into pending local candidates until fs resolution proves them', () => {
    expect(classifyMarkdownLinkTarget('apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx',
      originalHref: 'apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx',
      localKind: 'text',
    });
    expect(classifyMarkdownLinkTarget('D:/AI/xdt-maker/apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx:832')).toEqual({
      kind: 'local-candidate',
      href: 'D:/AI/xdt-maker/apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx',
      originalHref: 'D:/AI/xdt-maker/apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx:832',
      localKind: 'text',
      line: 832,
    });
    expect(classifyMarkdownLinkTarget('C:\\repo\\apps\\desktop\\src\\App.tsx:12')).toEqual({
      kind: 'local-candidate',
      href: 'C:\\repo\\apps\\desktop\\src\\App.tsx',
      originalHref: 'C:\\repo\\apps\\desktop\\src\\App.tsx:12',
      localKind: 'text',
      line: 12,
    });
    expect(classifyMarkdownLinkTarget('file:///C:/repo/apps/desktop/src/App.tsx:12')).toEqual({
      kind: 'local-candidate',
      href: 'file:///C:/repo/apps/desktop/src/App.tsx',
      originalHref: 'file:///C:/repo/apps/desktop/src/App.tsx:12',
      localKind: 'text',
      line: 12,
    });
    expect(classifyMarkdownLinkTarget('apps/server/src/services/skills.ts:316-320')).toEqual({
      kind: 'local-candidate',
      href: 'apps/server/src/services/skills.ts',
      originalHref: 'apps/server/src/services/skills.ts:316-320',
      localKind: 'text',
      line: 316,
    });
  });

  it('keeps bare filenames as resolvable code references instead of unsafe external links', () => {
    expect(classifyMarkdownLinkTarget('MarkdownRenderer.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'MarkdownRenderer.tsx',
      originalHref: 'MarkdownRenderer.tsx',
      localKind: 'text',
    });
  });

  it("classifies 3D model files as localKind 'model' (link + inline code)", () => {
    expect(classifyMarkdownLinkTarget('~/Downloads/character.fbx')).toEqual({
      kind: 'local-candidate',
      href: '~/Downloads/character.fbx',
      originalHref: '~/Downloads/character.fbx',
      localKind: 'model',
    });
    // .gltf 是 JSON 文本;model 判定必须先于 text fallback,否则会拿到 'text'。
    expect(classifyMarkdownLinkTarget('assets/scene.gltf')).toEqual({
      kind: 'local-candidate',
      href: 'assets/scene.gltf',
      originalHref: 'assets/scene.gltf',
      localKind: 'model',
    });
    expect(classifyInlineCodeTarget('/abs/models/char.glb')).toEqual({
      kind: 'local-candidate',
      href: '/abs/models/char.glb',
      originalHref: '/abs/models/char.glb',
      localKind: 'model',
    });
  });

  it('resolves uploaded local file refs synchronously when the basename is unique', () => {
    expect(classifyMarkdownLinkTarget('Report.DOCX', [
      { name: 'Report.DOCX', path: 'C:\\Users\\me\\Downloads\\Report.DOCX' },
    ])).toEqual({
      kind: 'resolved-local',
      href: 'Report.DOCX',
      absPath: 'C:\\Users\\me\\Downloads\\Report.DOCX',
      localKind: 'text',
    });
  });

  it('does not render unsupported schemes or directories as clickable links', () => {
    expect(classifyMarkdownLinkTarget('mailto:me@example.com')).toEqual({
      kind: 'plain-text',
      href: 'mailto:me@example.com',
      reason: 'unsupported-scheme',
    });
    // 目录形态(尾斜杠)现在 candidate 化:去尾杠后走存在性解析,真实存在的
    // 目录点亮为 chip(点击定位进侧边栏文件浏览器),不存在保持纯文本。
    expect(classifyMarkdownLinkTarget('src/components/')).toEqual({
      kind: 'local-candidate',
      href: 'src/components',
      originalHref: 'src/components/',
      localKind: 'text',
    });
    expect(classifyMarkdownLinkTarget('ftp://example.com/a.ts')).toEqual({
      kind: 'plain-text',
      href: 'ftp://example.com/a.ts',
      reason: 'unsupported-scheme',
    });
  });

  it('keeps non-target markdown hrefs as plain text', () => {
    expect(classifyMarkdownLinkTarget('hello')).toEqual({
      kind: 'plain-text',
      href: 'hello',
      reason: 'not-a-target',
    });
  });
});

describe('classifyInlineCodeTarget', () => {
  it('promotes path-shaped inline code to local candidates', () => {
    expect(classifyInlineCodeTarget('src/App.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'src/App.tsx',
      originalHref: 'src/App.tsx',
      localKind: 'text',
    });
    expect(classifyInlineCodeTarget('src/App.tsx:18')).toEqual({
      kind: 'local-candidate',
      href: 'src/App.tsx',
      originalHref: 'src/App.tsx:18',
      localKind: 'text',
      line: 18,
    });
    expect(classifyInlineCodeTarget('C:\\repo\\src\\App.tsx:18')).toEqual({
      kind: 'local-candidate',
      href: 'C:\\repo\\src\\App.tsx',
      originalHref: 'C:\\repo\\src\\App.tsx:18',
      localKind: 'text',
      line: 18,
    });
    expect(classifyInlineCodeTarget('file:///C:/repo/src/App.tsx')).toEqual({
      kind: 'local-candidate',
      href: 'file:///C:/repo/src/App.tsx',
      originalHref: 'file:///C:/repo/src/App.tsx',
      localKind: 'text',
    });
    expect(classifyInlineCodeTarget('apps/server/src/services/skills.ts:316-320')).toEqual({
      kind: 'local-candidate',
      href: 'apps/server/src/services/skills.ts',
      originalHref: 'apps/server/src/services/skills.ts:316-320',
      localKind: 'text',
      line: 316,
    });
  });

  it('keeps ordinary inline code as non-target code', () => {
    expect(classifyInlineCodeTarget('useState')).toBeNull();
    expect(classifyInlineCodeTarget('npm run build')).toBeNull();
    expect(classifyInlineCodeTarget('https://example.com/a.ts')).toBeNull();
  });
});

describe('decideRemoteLit(远程会话点亮的唯一判据)', () => {
  const lit = (v: Parameters<typeof decideRemoteLit>[0], href = 'src/App.tsx', orig?: string) =>
    decideRemoteLit(v, href, orig);

  it('每个 verdict 都有返回值 —— 没有「什么都不做」这个分支', () => {
    // 这是本函数存在的全部理由:调用方拿返回值**无条件覆盖**旧结论,于是「忘了撤销」
    // 在结构上不可表达。若哪天有人给某个 verdict 加回早返回,这条就会挂。
    for (const v of ['file', 'directory', 'nonfile', 'unknown', undefined] as const) {
      expect(lit(v), String(v)).toHaveProperty('lit');
    }
  });

  it('file / directory → 点亮并带对应 kind', () => {
    expect(lit('file')).toEqual({ lit: true, kind: 'file' });
    expect(lit('directory')).toEqual({ lit: true, kind: 'directory' });
  });

  it('nonfile / 尚未验证 → 纯文本', () => {
    expect(lit('nonfile')).toEqual({ lit: false });
    expect(lit(undefined)).toEqual({ lit: false });
  });

  it('unknown 按形状分档(§14.5 规则 5)', () => {
    expect(lit('unknown', 'src/App.tsx')).toEqual({ lit: true, kind: 'file' });
    expect(lit('unknown', '/etc/hosts')).toEqual({ lit: true, kind: 'file' });
    expect(lit('unknown', 'src/components')).toEqual({ lit: false });
    expect(lit('unknown', 'array.map')).toEqual({ lit: false });
    // 尾斜杠目录:回看 originalHref,**且要保住 directory 类型** —— 回 'file' 的话
    // 点击会进文本预览 / 取件链路,而不是目录导航分支(review 实捉)。
    expect(lit('unknown', 'src/components', 'src/components/')).toEqual({ lit: true, kind: 'directory' });
    // 确定态本来就带类型,不受尾斜杠影响。
    expect(lit('directory', 'src/components', 'src/components/')).toEqual({ lit: true, kind: 'directory' });
  });

  it('交错序列:先按 unknown 乐观点亮,重验确认 nonfile 后必须退回纯文本', () => {
    // TTL 到期重验(不变量 A)让这条迁移第一次成为可能。原实现是
    // `if (verdict === 'nonfile') return;` 早返回 —— 不存在的路径会一直带着下划线
    // 可点,直到组件重挂(PR #1144 review 实捉)。
    const first = lit('unknown', 'src/App.tsx');
    expect(first).toEqual({ lit: true, kind: 'file' });
    const second = lit('nonfile', 'src/App.tsx');
    expect(second, '确认不存在后仍然点亮 —— 有下划线却点不开').toEqual({ lit: false });
  });

  it('反向交错:unknown 时未点亮的歧义路径,拿到 file 后要点亮', () => {
    expect(lit('unknown', 'src/components')).toEqual({ lit: false });
    expect(lit('file', 'src/components')).toEqual({ lit: true, kind: 'file' });
  });
});

describe('isAmbiguousPathShape(远程会话 unknown 的乐观点亮门槛)', () => {
  // 与移动端 chatPathCandidate 的 ambiguousShape 同一判据,两端需同步。
  it('形状明确是路径 → 不歧义(断链仍可乐观点亮)', () => {
    for (const p of ['/Users/me/a.png', 'C:\\proj\\a.ts', 'src/App.tsx', './docs/readme.md']) {
      expect(isAmbiguousPathShape(p), p).toBe(false);
    }
  });

  it('绝对路径不歧义,**且不要求扩展名**(不靠 looksLikeFilePath 顺带判)', () => {
    // looksLikeFilePath 的两条排除项是为别的用途写的:URL_SCHEME_RE 为「别把 https://
    // 当本地路径」、POSIX 分支要求扩展名为「别让无扩展名引用触发 TextLightbox」。
    // 照抄它会继承一串与歧义判定无关的排除,把最明确的形态判成最可疑的 —— 同一根因
    // 的两个分支:file:// (检查点自查发现) 与 /etc/hosts (PR #1144 review 实捉)。
    for (const p of [
      'file:///Users/me/a.md', 'file:///Users/me/no-ext',
      '/etc/hosts', '/usr/bin/node', '/Users/dash/Code/Cindy',
      'C:\\Windows\\System32',
    ]) {
      expect(isAmbiguousPathShape(p), p).toBe(false);
    }
    // 带行号后缀时 href 已剥掉后缀,两个参数都要判对。
    expect(isAmbiguousPathShape('/etc/hosts', '/etc/hosts:12')).toBe(false);
  });

  it('已知取舍:以 `/` 开头的正则字面量跟着进非歧义档', () => {
    // 与 POSIX 绝对路径形状无法区分。刻意接受:只影响断链这一个降级态(链路正常时
    // stat 回 nonfile → 纯文本),而代价的另一边是 /etc/hosts、/usr/bin/node 这类
    // 开发对话里最常见的绝对路径在断链时全部不点亮 —— 那个错更醒目也更常见。
    // 写成显式已知项,避免后人当成新 bug 又反向改一轮。
    expect(isAmbiguousPathShape('/\\d+/g')).toBe(false);
  });

  it('无分隔符裸名 → 歧义(与属性访问同形)', () => {
    for (const p of ['package.json', 'array.map', 'console.log', 'Date.now', '1.2']) {
      expect(isAmbiguousPathShape(p), p).toBe(true);
    }
  });

  it('有分隔符但无扩展名 → 歧义(src/components 与 and/or 词法同形)', () => {
    for (const p of ['src/components', 'and/or', 'n/a', 'read/write', 'text/plain']) {
      expect(isAmbiguousPathShape(p), p).toBe(true);
    }
  });

  it('尾斜杠目录 → 不歧义,且必须回看 originalHref(classify* 已剥掉尾杠)', () => {
    // classifyInlineCodeTarget / classifyMarkdownLinkTarget 产出 candidate 前就把
    // 尾斜杠剥了,只看 href 会把显式目录引用误判成歧义、断链时退化成纯文本
    // (PR #1144 review 实捉)。
    expect(isAmbiguousPathShape('src/components'), '只看 href 时仍是歧义').toBe(true);
    expect(isAmbiguousPathShape('src/components', 'src/components/'), '回看 originalHref 后不歧义').toBe(false);
    expect(isAmbiguousPathShape('docs', 'docs/')).toBe(false);
    expect(isAmbiguousPathShape('C:\\proj', 'C:\\proj\\')).toBe(false);
    // originalHref 无尾杠时不受影响。
    expect(isAmbiguousPathShape('array.map', 'array.map')).toBe(true);
  });

  it('尾斜杠目录候选的 originalHref 真的保留了尾杠(与上一条形成端到端)', () => {
    const t = classifyInlineCodeTarget('src/components/');
    expect(t?.kind).toBe('local-candidate');
    const c = t as Extract<typeof t, { kind: 'local-candidate' }>;
    expect(c.href, 'href 已剥尾杠').toBe('src/components');
    expect(c.originalHref, 'originalHref 保留尾杠').toBe('src/components/');
    expect(isAmbiguousPathShape(c.href, c.originalHref)).toBe(false);
  });
});
