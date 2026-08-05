import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canOpenChatPathChip,
  classifyChatPathLinkTarget,
  classifyInlineCodePathCandidate,
  dropDotSegments,
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
    });
  });

  it('目录尾斜杠 → 去尾杠 + directoryShape', () => {
    expect(classifyInlineCodePathCandidate('src/components/')).toEqual({
      href: 'src/components',
      directoryShape: true,
    });
    expect(classifyInlineCodePathCandidate('./Skills/')).toEqual({
      href: './Skills',
      directoryShape: true,
    });
  });

  it('无分隔符无扩展的目录名(如 src)不候选,含分隔符无扩展候选', () => {
    // 裸词太误伤(useState / src),必须有路径形状信号。
    expect(classifyInlineCodePathCandidate('src')).toBeNull();
    expect(classifyInlineCodePathCandidate('src/components')).toEqual({
      href: 'src/components',
      directoryShape: false,
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
    });
  });
});

describe('classifyChatPathLinkTarget', () => {
  it('绝对路径 + 行号后缀 → 候选(截图实例形态)', () => {
    expect(classifyChatPathLinkTarget('/Users/me/proj/README.md:17')).toEqual({
      href: '/Users/me/proj/README.md',
      line: 17,
      directoryShape: false,
    });
  });

  it('相对 / Windows / file:// / 目录尾斜杠', () => {
    expect(classifyChatPathLinkTarget('src/App.tsx')).toEqual({
      href: 'src/App.tsx',
      directoryShape: false,
    });
    expect(classifyChatPathLinkTarget('C:\\proj\\a.json')).toEqual({
      href: 'C:\\proj\\a.json',
      directoryShape: false,
    });
    expect(classifyChatPathLinkTarget('file:///Users/me/a.md')).toEqual({
      href: 'file:///Users/me/a.md',
      directoryShape: false,
    });
    expect(classifyChatPathLinkTarget('brand/liz-logo/')).toEqual({
      href: 'brand/liz-logo',
      directoryShape: true,
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

describe('路径 chip 的可点信号(源码级守卫)', () => {
  // 行内 code 走压暗档,而路径 chip 的样式**总是**叠在 markdownInlineCode 之后:
  //   chipStyle={[baseStyle, styles.markdownInlineCode, styles.markdownPathChip]}
  // markdownPathChip 一旦不自带 color,就会继承那份压暗色 —— 可点的反而比不可点的
  // 更淡,正好把「看不出可点」这个问题做反。RN 里这类静默继承没有类型保护,只能
  // 在源码层钉住。
  it('markdownPathChip 显式钉回正文色,不继承行内 code 的压暗', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/session/MessageRenderer.tsx'),
      'utf8',
    );
    const block = /markdownPathChip:\s*\{([^}]*)\}/.exec(src);
    expect(block, '未找到 markdownPathChip 样式定义').not.toBeNull();
    expect(block![1]).toMatch(/color:\s*colors\.textPrimary/);

    // 叠加顺序也一并钉住:若将来有人把 markdownPathChip 挪到 markdownInlineCode
    // 之前,上面那条 color 就会被压暗色覆盖回去。
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
