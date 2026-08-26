import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { PR_WATCH_EXPANDED_BLANK_FIXTURE } from '@/__tests__/fixtures/prWatchExpandedBlank';
import {
  collectMobileMarkdownImages,
  isMobileMarkdownImageDirectUrl,
  mobileMarkdownImageTitle,
  mobileMarkdownImageUrlForWorkdir,
  mobileMarkdownImageAltChipText,
  MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH,
  mobileMarkdownInlineImageSize,
  parseMobileMarkdown,
  parseMobileMarkdownInlines,
  groupMobileMarkdownSelectableBlocks,
} from '@/session/messageMarkdown';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('messageMarkdown', () => {
  it('parses the reported PR-watch long message without creating an oversized inline image', () => {
    const blocks = parseMobileMarkdown(PR_WATCH_EXPANDED_BLANK_FIXTURE);

    expect(blocks.length).toBeGreaterThan(1);
    // badge Markdown 位于 strong 标记内,当前解析为文本而非图片;空白不是图片尺寸撑高导致。
    expect(collectMobileMarkdownImages(PR_WATCH_EXPANDED_BLANK_FIXTURE)).toEqual([]);
    expect(blocks.some((block) => block.type === 'code')).toBe(true);
  });

  it('parses paragraphs, list items and fenced code blocks', () => {
    expect(parseMobileMarkdown([
      'Intro line',
      'continues',
      '',
      '- first item',
      '2. second item',
      '',
      '```ts',
      'const value = 1;',
      '```',
      'Done',
    ].join('\n'))).toEqual([
      {
        type: 'paragraph',
        key: 'p:2:0',
        inlines: [{ type: 'text', text: 'Intro line\ncontinues' }],
      },
      {
        type: 'list_item',
        key: 'li:3:1',
        ordered: false,
        marker: '-',
        inlines: [{ type: 'text', text: 'first item' }],
      },
      {
        type: 'list_item',
        key: 'li:4:2',
        ordered: true,
        marker: '2.',
        inlines: [{ type: 'text', text: 'second item' }],
      },
      {
        type: 'code',
        key: 'code:6:3',
        language: 'ts',
        text: 'const value = 1;',
      },
      {
        type: 'paragraph',
        key: 'p:10:4',
        inlines: [{ type: 'text', text: 'Done' }],
      },
    ]);
  });

  // 无语言标注的围栏:桌面端曾因「按 className 判定行内 code」把这种块整段套上
  // 行内底色(rehype-highlight 只给带语言的围栏下发 className)。移动端解析器在
  // 块级就分出 code 块、与行内 code 是两个类型,天然不会误判——这条测试把该性质
  // 钉住,防止将来有人把「无语言就当普通文本/行内」塞进解析器。
  // 桌面端同一形态的回归见 apps/desktop 的 markdownFencedCodeInline.test.ts。
  it('无语言标注的围栏仍是 code 块(language 缺席),不降级成 inline code', () => {
    const blocks = parseMobileMarkdown([
      '```',
      '任务(Session)',
      '└─ 对话(Chat)',
      '```',
    ].join('\n'));
    expect(blocks).toEqual([
      {
        type: 'code',
        key: 'code:0:0',
        language: undefined,
        text: '任务(Session)\n└─ 对话(Chat)',
      },
    ]);
    // 关键:整块内容没有任何一段变成行内 code inline。
    expect(JSON.stringify(blocks)).not.toContain('"inlines"');
  });

  it('keeps unclosed fenced code as a code block', () => {
    expect(parseMobileMarkdown('```bash\npnpm test')).toEqual([
      {
        type: 'code',
        key: 'code:0:0',
        language: 'bash',
        text: 'pnpm test',
      },
    ]);
  });

  it('parses indented fenced terminal blocks after list items', () => {
    expect(parseMobileMarkdown([
      '1. Windows 更新缓存（620MB）- 管理员 PowerShell 跑这条:',
      '   ```powershell',
      '   Stop-Service wuauserv -Force; Remove-Item',
      '   "C:\\Windows\\SoftwareDistribution\\Download\\*"',
      '   -Recurse -Force; Start-Service wuauserv',
      '   ```',
      'Done',
    ].join('\n'))).toEqual([
      {
        type: 'list_item',
        key: 'li:0:0',
        ordered: true,
        marker: '1.',
        inlines: [{ type: 'text', text: 'Windows 更新缓存（620MB）- 管理员 PowerShell 跑这条:' }],
      },
      {
        type: 'code',
        key: 'code:1:1',
        language: 'powershell',
        text: [
          'Stop-Service wuauserv -Force; Remove-Item',
          '"C:\\Windows\\SoftwareDistribution\\Download\\*"',
          '-Recurse -Force; Start-Service wuauserv',
        ].join('\n'),
      },
      {
        type: 'paragraph',
        key: 'p:7:2',
        inlines: [{ type: 'text', text: 'Done' }],
      },
    ]);
  });

  it('treats malformed two-backtick terminal fences as code without leaking the language line', () => {
    expect(parseMobileMarkdown([
      '管理员 PowerShell 跑这条:',
      '``',
      'powershell',
      'Stop-Service wuauserv -Force',
      '``',
      'Done',
    ].join('\n'))).toEqual([
      {
        type: 'paragraph',
        key: 'p:1:0',
        inlines: [{ type: 'text', text: '管理员 PowerShell 跑这条:' }],
      },
      {
        type: 'code',
        key: 'code:1:1',
        language: 'powershell',
        text: 'Stop-Service wuauserv -Force',
      },
      {
        type: 'paragraph',
        key: 'p:6:2',
        inlines: [{ type: 'text', text: 'Done' }],
      },
    ]);
  });

  it('parses tilde fenced code blocks with info strings', () => {
    expect(parseMobileMarkdown([
      '~~~bash title="cleanup"',
      'rm -rf /tmp/cache',
      '~~~',
    ].join('\n'))).toEqual([
      {
        type: 'code',
        key: 'code:0:0',
        language: 'bash',
        text: 'rm -rf /tmp/cache',
      },
    ]);
  });

  it('parses mermaid fenced code as a diagram block', () => {
    expect(parseMobileMarkdown([
      '```mermaid',
      'graph TD',
      'A --> B',
      '```',
    ].join('\n'))).toEqual([
      {
        type: 'mermaid',
        key: 'mermaid:0:0',
        text: 'graph TD\nA --> B',
      },
    ]);
  });

  it('parses headings, blockquotes and task list items', () => {
    expect(parseMobileMarkdown([
      '## Plan',
      '',
      '> Keep desktop state authoritative.',
      '> Mirror it on mobile.',
      '',
      '- [x] Preserve message order',
      '- [ ] Verify native screenshots',
    ].join('\n'))).toEqual([
      {
        type: 'heading',
        key: 'h:0:0',
        level: 2,
        inlines: [{ type: 'text', text: 'Plan' }],
      },
      {
        type: 'blockquote',
        key: 'quote:2:1',
        inlines: [{ type: 'text', text: 'Keep desktop state authoritative.\nMirror it on mobile.' }],
      },
      {
        type: 'list_item',
        key: 'li:5:2',
        ordered: false,
        marker: '-',
        checked: true,
        inlines: [{ type: 'text', text: 'Preserve message order' }],
      },
      {
        type: 'list_item',
        key: 'li:6:3',
        ordered: false,
        marker: '-',
        checked: false,
        inlines: [{ type: 'text', text: 'Verify native screenshots' }],
      },
    ]);
  });

  it('splits http links into inline tokens', () => {
    expect(parseMobileMarkdownInlines('Open https://example.com/path, then continue')).toEqual([
      { type: 'text', text: 'Open ' },
      { type: 'link', text: 'https://example.com/path', url: 'https://example.com/path' },
      { type: 'text', text: ', then continue' },
    ]);
  });

  it('does not swallow fullwidth parentheses or CJK punctuation after a bare URL', () => {
    expect(parseMobileMarkdownInlines(
      '诊断已写在 https://github.com/example/app/issues/3561#issuecomment-5391602790（无 @）。',
    )).toEqual([
      { type: 'text', text: '诊断已写在 ' },
      {
        type: 'link',
        text: 'https://github.com/example/app/issues/3561#issuecomment-5391602790',
        url: 'https://github.com/example/app/issues/3561#issuecomment-5391602790',
      },
      { type: 'text', text: '（无 @）。' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://example.com/path（说明）然后')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://example.com/path', url: 'https://example.com/path' },
      { type: 'text', text: '（说明）然后' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://example.com/path。然后')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://example.com/path', url: 'https://example.com/path' },
      { type: 'text', text: '。然后' },
    ]);
    expect(parseMobileMarkdownInlines('见 https://en.wikipedia.org/wiki/Foo_(bar) 词条')).toEqual([
      { type: 'text', text: '见 ' },
      {
        type: 'link',
        text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
        url: 'https://en.wikipedia.org/wiki/Foo_(bar)',
      },
      { type: 'text', text: ' 词条' },
    ]);
    expect(parseMobileMarkdownInlines('见 (https://example.com/path) 收尾')).toEqual([
      { type: 'text', text: '见 (' },
      { type: 'link', text: 'https://example.com/path', url: 'https://example.com/path' },
      { type: 'text', text: ') 收尾' },
    ]);
    expect(parseMobileMarkdownInlines('~https://example.com/~alice')).toEqual([
      { type: 'text', text: '~' },
      {
        type: 'link',
        text: 'https://example.com/~alice',
        url: 'https://example.com/~alice',
      },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://example.com/api/[id] 看')).toEqual([
      { type: 'text', text: '打开 ' },
      {
        type: 'link',
        text: 'https://example.com/api/[id]',
        url: 'https://example.com/api/[id]',
      },
      { type: 'text', text: ' 看' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://子域。例子。测试 看')).toEqual([
      { type: 'text', text: '打开 ' },
      { type: 'link', text: 'https://子域。例子。测试', url: 'https://子域。例子。测试' },
      { type: 'text', text: ' 看' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://пример。онлайн/path 看')).toEqual([
      { type: 'text', text: '打开 ' },
      {
        type: 'link',
        text: 'https://пример。онлайн/path',
        url: 'https://пример。онлайн/path',
      },
      { type: 'text', text: ' 看' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://例子。测试。这是说明')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://例子。测试', url: 'https://例子。测试' },
      { type: 'text', text: '。这是说明' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://例子。ファッション/path 看')).toEqual([
      { type: 'text', text: '打开 ' },
      {
        type: 'link',
        text: 'https://例子。ファッション/path',
        url: 'https://例子。ファッション/path',
      },
      { type: 'text', text: ' 看' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://example.com。这是说明')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://example.com', url: 'https://example.com' },
      { type: 'text', text: '。这是说明' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://子域。四字域名。测试 看')).toEqual([
      { type: 'text', text: '打开 ' },
      {
        type: 'link',
        text: 'https://子域。四字域名。测试',
        url: 'https://子域。四字域名。测试',
      },
      { type: 'text', text: ' 看' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://例子。测试。')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://例子。测试', url: 'https://例子。测试' },
      { type: 'text', text: '。' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://example.com/path・说明')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://example.com/path', url: 'https://example.com/path' },
      { type: 'text', text: '・说明' },
    ]);
    expect(parseMobileMarkdownInlines('看 http://localhost:3000。然后')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'http://localhost:3000', url: 'http://localhost:3000' },
      { type: 'text', text: '。然后' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://例子。测试/path 看')).toEqual([
      { type: 'text', text: '打开 ' },
      { type: 'link', text: 'https://例子。测试/path', url: 'https://例子。测试/path' },
      { type: 'text', text: ' 看' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://example.com/路径 与 https://例子.测试/path')).toEqual([
      { type: 'text', text: '打开 ' },
      { type: 'link', text: 'https://example.com/路径', url: 'https://example.com/路径' },
      { type: 'text', text: ' 与 ' },
      { type: 'link', text: 'https://例子.测试/path', url: 'https://例子.测试/path' },
    ]);
    expect(parseMobileMarkdownInlines('打开 https://example.com/ＡＢＣ 与 https://example.com/abc々def')).toEqual([
      { type: 'text', text: '打开 ' },
      { type: 'link', text: 'https://example.com/ＡＢＣ', url: 'https://example.com/ＡＢＣ' },
      { type: 'text', text: ' 与 ' },
      { type: 'link', text: 'https://example.com/abc々def', url: 'https://example.com/abc々def' },
    ]);
    expect(parseMobileMarkdownInlines('看 https://example.com/path\u00A0然后')).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: 'https://example.com/path', url: 'https://example.com/path' },
      { type: 'text', text: '\u00A0然后' },
    ]);
  });

  it('parses common inline formatting tokens', () => {
    expect(parseMobileMarkdownInlines(
      'Use **bold**, *em*, `code`, ~~gone~~, [docs](https://example.com/docs).',
    )).toEqual([
      { type: 'text', text: 'Use ' },
      { type: 'strong', text: 'bold' },
      { type: 'text', text: ', ' },
      { type: 'emphasis', text: 'em' },
      { type: 'text', text: ', ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ', ' },
      { type: 'strikethrough', text: 'gone' },
      { type: 'text', text: ', ' },
      { type: 'link', text: 'docs', url: 'https://example.com/docs' },
      { type: 'text', text: '.' },
    ]);
  });

  it('parses emphasis at the beginning of a line', () => {
    expect(parseMobileMarkdownInlines('*em* first')).toEqual([
      { type: 'emphasis', text: 'em' },
      { type: 'text', text: ' first' },
    ]);
  });

  it('parses markdown tables with inline formatting', () => {
    expect(parseMobileMarkdown([
      '| Name | Status |',
      '| --- | --- |',
      '| **Build** | `pass` |',
      '| Result | https://example.com/result |',
    ].join('\n'))).toEqual([
      {
        type: 'table',
        key: 'table:0:0',
        header: [
          [{ type: 'text', text: 'Name' }],
          [{ type: 'text', text: 'Status' }],
        ],
        rows: [
          {
            key: 'tr:2:0',
            cells: [
              [{ type: 'strong', text: 'Build' }],
              [{ type: 'code', text: 'pass' }],
            ],
          },
          {
            key: 'tr:3:1',
            cells: [
              [{ type: 'text', text: 'Result' }],
              [{
                type: 'link',
                text: 'https://example.com/result',
                url: 'https://example.com/result',
              }],
            ],
          },
        ],
      },
    ]);
  });

  it('parses compact pipe tables without a markdown separator row', () => {
    expect(parseMobileMarkdown([
      '找到了:',
      '',
      '项目 | 大小 | 处理',
      '用户临时文件 Temp | ~529MB | 现在直接清',
      'Windows 更新缓存 | ~621MB | 现在直接清',
      'Downloads\\RJ406835.zip | 8.42GB | 删除前再确认',
      '',
      '先清前两项。',
    ].join('\n'))).toEqual([
      {
        type: 'paragraph',
        key: 'p:1:0',
        inlines: [{ type: 'text', text: '找到了:' }],
      },
      {
        type: 'table',
        key: 'table:2:1',
        header: [
          [{ type: 'text', text: '项目' }],
          [{ type: 'text', text: '大小' }],
          [{ type: 'text', text: '处理' }],
        ],
        rows: [
          {
            key: 'tr:3:0',
            cells: [
              [{ type: 'text', text: '用户临时文件 Temp' }],
              [{ type: 'text', text: '~529MB' }],
              [{ type: 'text', text: '现在直接清' }],
            ],
          },
          {
            key: 'tr:4:1',
            cells: [
              [{ type: 'text', text: 'Windows 更新缓存' }],
              [{ type: 'text', text: '~621MB' }],
              [{ type: 'text', text: '现在直接清' }],
            ],
          },
          {
            key: 'tr:5:2',
            cells: [
              // 表格单元格同样过 inline 分词:`Downloads\RJ406835.zip` 是「带分隔符 +
              // 扩展名」的相对路径形态,按裸路径识别成 link 候选(渲染层再经被控端
              // stat 决定点亮 chip 还是保持纯文本)。本用例断言的是紧凑表格的分块,
              // 路径形态的口径见 describe('bare file paths(正文纯文本形态)')。
              [{ type: 'link', text: 'Downloads\\RJ406835.zip', url: 'Downloads\\RJ406835.zip', bare: true }],
              [{ type: 'text', text: '8.42GB' }],
              [{ type: 'text', text: '删除前再确认' }],
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        key: 'p:8:2',
        inlines: [{ type: 'text', text: '先清前两项。' }],
      },
    ]);
  });

  it('keeps one-off pipe text as a paragraph', () => {
    expect(parseMobileMarkdown('项目 A | 项目 B')).toEqual([
      {
        type: 'paragraph',
        key: 'p:1:0',
        inlines: [{ type: 'text', text: '项目 A | 项目 B' }],
      },
    ]);
  });

  it('keeps escaped pipes inside compact table cells', () => {
    const blocks = parseMobileMarkdown([
      'Name | Detail',
      'Item | literal \\| pipe',
    ].join('\n'));
    expect(blocks).toEqual([
      {
        type: 'table',
        key: 'table:0:0',
        header: [
          [{ type: 'text', text: 'Name' }],
          [{ type: 'text', text: 'Detail' }],
        ],
        rows: [
          {
            key: 'tr:1:0',
            cells: [
              [{ type: 'text', text: 'Item' }],
              [{ type: 'text', text: 'literal | pipe' }],
            ],
          },
        ],
      },
    ]);
  });



  it('parses markdown images into image inlines', () => {
    expect(parseMobileMarkdownInlines('看这张 ![部署截图](https://example.com/shot.png) 收尾')).toEqual([
      { type: 'text', text: '看这张 ' },
      { type: 'image', alt: '部署截图', url: 'https://example.com/shot.png' },
      { type: 'text', text: ' 收尾' },
    ]);
    // 空 alt 也是合法图片,不回退成 link/裸 URL。
    expect(parseMobileMarkdownInlines('![](https://example.com/a.png)')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/a.png' },
    ]);
  });

  it('parses desktop-local markdown image paths and resolves them through xdt-file once', () => {
    expect(parseMobileMarkdownInlines('![相对图](docs/screen shot.png)')).toEqual([
      { type: 'image', alt: '相对图', url: 'docs/screen shot.png' },
    ]);
    expect(parseMobileMarkdownInlines('![绝对图](</Users/me/My Files/a%20b.png>)')).toEqual([
      { type: 'image', alt: '绝对图', url: '/Users/me/My Files/a%20b.png' },
    ]);
    expect(mobileMarkdownImageUrlForWorkdir('docs/screen shot.png', '/repo')).toBe(
      'xdt-file://open?path=%2Frepo%2Fdocs%2Fscreen%20shot.png',
    );
    // file URL 按 URL 语义只解码一次:%2520 表示文件名里的字面 "%20"。
    expect(mobileMarkdownImageUrlForWorkdir('file:///repo/a%2520b.png', '/ignored')).toBe(
      'xdt-file://open?path=%2Frepo%2Fa%2520b.png',
    );
    expect(mobileMarkdownImageUrlForWorkdir('docs/a.png')).toBeNull();
    expect(mobileMarkdownImageUrlForWorkdir('docs/a.png', '/repo', 'message:2')).toBe(
      'xdt-file://open?path=%2Frepo%2Fdocs%2Fa.png&v=message%3A2',
    );
    expect(mobileMarkdownImageUrlForWorkdir(
      'artifacts/plot.png',
      '/home/u/proj',
      'message:2',
      'ssh-host-1',
      'session-ssh',
    )).toBe(
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fartifacts%2Fplot.png'
      + '&sessionId=session-ssh&remoteHostId=ssh-host-1&workdir=%2Fhome%2Fu%2Fproj&v=message%3A2',
    );
    expect(mobileMarkdownImageUrlForWorkdir(
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fartifacts%2Fplot.png'
        + '&remoteHostId=forged-host&workdir=%2Ftmp&v=stale',
      '/home/u/proj',
      'message:3',
      'ssh-host-1',
      'session-ssh',
    )).toBe(
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fartifacts%2Fplot.png'
      + '&sessionId=session-ssh&remoteHostId=ssh-host-1&workdir=%2Fhome%2Fu%2Fproj&v=message%3A3',
    );
    expect(mobileMarkdownImageUrlForWorkdir(
      'xdt-file://open?path=%2Fhome%2Fu%2Fproj%2Fa.png',
      undefined,
      'message:3',
      'ssh-host-1',
      'session-ssh',
    )).toBeNull();
    expect(mobileMarkdownImageUrlForWorkdir(
      'artifacts/plot.png',
      '/home/u/proj',
      'message:3',
      'ssh-host-1',
    )).toBeNull();
    expect(mobileMarkdownImageUrlForWorkdir(
      'xdt-file://open?path=%2Frepo%2Fa.png&sessionId=forged-session&remoteHostId=forged-host&workdir=%2F&v=stale',
      '/repo',
      'message:4',
    )).toBe('xdt-file://open?path=%2Frepo%2Fa.png&v=message%3A4');
    // 直连地址本身已内容寻址/由源站控制缓存,不追加消息版本。
    expect(mobileMarkdownImageUrlForWorkdir('https://example.com/a.png', '/repo', 'message:2')).toBe(
      'https://example.com/a.png',
    );
    expect(parseMobileMarkdownInlines('![危险](javascript:alert.png)')).toEqual([
      { type: 'text', text: '![危险](javascript:alert.png)' },
    ]);
  });

  it('keeps balanced parentheses in desktop-local markdown image paths', () => {
    expect(parseMobileMarkdownInlines('结果 ![截图](artifacts/build(1).png) 收尾')).toEqual([
      { type: 'text', text: '结果 ' },
      { type: 'image', alt: '截图', url: 'artifacts/build(1).png' },
      { type: 'text', text: ' 收尾' },
    ]);
  });

  it('strips standard optional titles from local markdown image destinations', () => {
    expect(parseMobileMarkdownInlines('![图](artifacts/plot.png "Plot")')).toEqual([
      { type: 'image', alt: '图', url: 'artifacts/plot.png' },
    ]);
    expect(parseMobileMarkdownInlines("![图](artifacts/plot.png 'Plot')")).toEqual([
      { type: 'image', alt: '图', url: 'artifacts/plot.png' },
    ]);
    expect(parseMobileMarkdownInlines('![图](artifacts/plot.png (Plot))')).toEqual([
      { type: 'image', alt: '图', url: 'artifacts/plot.png' },
    ]);
    expect(parseMobileMarkdownInlines('![空格](docs/a b.png) ![括号](artifacts/build(1).png)')).toEqual([
      { type: 'image', alt: '空格', url: 'docs/a b.png' },
      { type: 'text', text: ' ' },
      { type: 'image', alt: '括号', url: 'artifacts/build(1).png' },
    ]);
  });

  it('continues scanning after commented or escaped image examples', () => {
    expect(parseMobileMarkdownInlines(
      '\\![示例](https://example.com/old.png) 实图 ![结果](https://example.com/new.png)',
    ).filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: '结果', url: 'https://example.com/new.png' },
    ]);
    expect(parseMobileMarkdownInlines(
      '<!-- ![示例](docs/old.png) --> 实图 ![结果](docs/new.png)',
    ).filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: '结果', url: 'docs/new.png' },
    ]);
  });

  it('converts safe raw HTML img tags and keeps only whitelisted attributes', () => {
    expect(parseMobileMarkdownInlines('<img src="https://example.com/b.png" width="150" onerror="alert(1)">')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/b.png', width: 150 },
    ]);
    expect(parseMobileMarkdownInlines("<img src='https://example.com/c.png' alt='房源图' width='120' height='90'/>")).toEqual([
      { type: 'image', alt: '房源图', url: 'https://example.com/c.png', width: 120, height: 90 },
    ]);
    // HTML entity 解码;非数字尺寸丢弃。
    expect(parseMobileMarkdownInlines('<img src="https://example.com/d.png?a=1&amp;b=2" width="abc">')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/d.png?a=1&b=2' },
    ]);
  });

  it('keeps unsafe img tags and arbitrary HTML as plain text', () => {
    expect(parseMobileMarkdownInlines('<img src="javascript:alert(1)">')).toEqual([
      { type: 'text', text: '<img src="javascript:alert(1)">' },
    ]);
    expect(parseMobileMarkdownInlines('<img src="file:///etc/passwd">')).toEqual([
      { type: 'text', text: '<img src="file:///etc/passwd">' },
    ]);
    expect(parseMobileMarkdownInlines('<script>alert(1)</script>')).toEqual([
      { type: 'text', text: '<script>alert(1)</script>' },
    ]);
  });

  it('rejects img tags nested inside other HTML tags (standalone-only policy)', () => {
    // <div><img></div> / <a><img></a> 属于「任意 HTML」,对齐桌面口径不转换
    // (其内的裸 URL 仍可能按既有 autolink 规则变链接,这里只断言不产出 image)。
    const nested = parseMobileMarkdownInlines('<div><img src="https://example.com/a.png"></div>');
    expect(nested.some((inline) => inline.type === 'image')).toBe(false);
    const linked = parseMobileMarkdownInlines('<a href="https://example.com"><img src="https://example.com/a.png"></a>');
    expect(linked.some((inline) => inline.type === 'image')).toBe(false);
    // 并排多个独立 img(表格缩略图行的合法形态)仍逐个转换。
    expect(parseMobileMarkdownInlines('<img src="https://example.com/a.png"> <img src="https://example.com/b.png">')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/a.png' },
      { type: 'text', text: ' ' },
      { type: 'image', alt: '', url: 'https://example.com/b.png' },
    ]);
    // 前后是普通文字不受影响。
    expect(parseMobileMarkdownInlines('前 <img src="https://example.com/c.png"> 后')).toEqual([
      { type: 'text', text: '前 ' },
      { type: 'image', alt: '', url: 'https://example.com/c.png' },
      { type: 'text', text: ' 后' },
    ]);
    // 下划线/点号标签名(<foo_bar>)同属 tag-like 包裹,不能因字符集缺口绕过(codex P2)。
    const underscored = parseMobileMarkdownInlines('<foo_bar><img src="https://example.com/a.png"></foo_bar>');
    expect(underscored.some((inline) => inline.type === 'image')).toBe(false);
    // 命名空间标签(<svg:svg>)同属「任意 HTML」,不能因 ":" 中断标签名匹配而绕过拒转(codex P2)。
    const namespaced = parseMobileMarkdownInlines('<svg:svg><img src="https://example.com/a.png"></svg:svg>');
    expect(namespaced.some((inline) => inline.type === 'image')).toBe(false);
  });

  it('ignores markdown images inside HTML comments but keeps siblings outside', () => {
    // 注释里的图是被注释掉的内容,不渲染、不进图集;注释外的合法图不受影响(codex P2)。
    expect(parseMobileMarkdownInlines('<!-- ![隐藏](https://example.com/a.png) -->')
      .some((inline) => inline.type === 'image')).toBe(false);
    const mixed = parseMobileMarkdownInlines('![可见](https://example.com/b.png) <!-- ![隐藏](https://example.com/a.png) -->');
    const images = mixed.filter((inline) => inline.type === 'image');
    expect(images).toEqual([{ type: 'image', alt: '可见', url: 'https://example.com/b.png' }]);
    // 未闭合注释视为延伸到段尾。
    expect(parseMobileMarkdownInlines('<!-- ![隐藏](https://example.com/a.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
  });

  it('keeps cindy-remote-media urls as literal text (no mobile resolver support)', () => {
    // cindy-remote-media:// 不在手机 resolver 门(isPayloadDesktopLocalMediaUrl)内,点开必失败;
    // 不收进白名单,保持字面文本(codex P2)。xdt-image / xdt-file 仍正常解析。
    expect(parseMobileMarkdownInlines('![图](cindy-remote-media://host/a.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
    expect(parseMobileMarkdownInlines('<img src="cindy-remote-media://host/a.png">')
      .some((inline) => inline.type === 'image')).toBe(false);
    expect(parseMobileMarkdownInlines('![图](xdt-file://workspace/a.png)')).toEqual([
      { type: 'image', alt: '图', url: 'xdt-file://workspace/a.png' },
    ]);
  });

  it('rejects markdown images wrapped by raw HTML blocks (same policy as raw img)', () => {
    // <div> 包裹的多行段落:桌面端 skipHtml 会把 raw HTML 块整体丢弃,其中的 Markdown 图
    // 不该在移动端被渲染/进图集(codex P2)。
    const wrapped = parseMobileMarkdownInlines('<div>\n![hidden](https://example.com/a.png)\n</div>');
    expect(wrapped.some((inline) => inline.type === 'image')).toBe(false);
    // doctype / 处理指令同属任意 HTML,整段拒转。
    expect(parseMobileMarkdownInlines('<!DOCTYPE html> ![x](https://example.com/a.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
  });

  it('does not let comment contents trigger segment-level rejection', () => {
    // 注释里的 <div> 只属于注释内容(span 压制通道),不应喂给段级标签守卫,
    // 否则注释外的合法图会被整段误杀(codex P2)。
    expect(parseMobileMarkdownInlines('<!-- <div>note</div> --> ![visible](https://example.com/a.png)')
      .filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: 'visible', url: 'https://example.com/a.png' },
    ]);
    // 注释外的真实标签仍整段拒转。
    expect(parseMobileMarkdownInlines('<div>note</div> ![hidden](https://example.com/a.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
    // raw <img> 路径同口径:注释内容不触发整段拒转,注释外的 <img> 照常转换;
    // 注释里的 <img> 是被注释掉的内容,按 span 跳过。
    expect(parseMobileMarkdownInlines('<!-- <div>note</div> --> <img src="https://example.com/b.png">')
      .filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/b.png' },
    ]);
    expect(parseMobileMarkdownInlines('<!-- <img src="https://example.com/a.png"> --> 后文')
      .some((inline) => inline.type === 'image')).toBe(false);
  });

  it('carries HTML comment state across blank-line separated blocks', () => {
    // <!-- 与 --> 之间隔空行会被拆成多个块,中间块自身没有注释标记;
    // 注释状态必须跨块携带,否则注释里的图会被当正常图渲染/进图集(codex P2)。
    const commented = ['<!--', '', '![hidden](https://example.com/a.png)', '', '-->'].join('\n');
    expect(collectMobileMarkdownImages(commented)).toEqual([]);
    // 注释闭合后的图不受影响。
    const afterClose = ['<!--', '', '-->', '', '![visible](https://example.com/b.png)'].join('\n');
    expect(collectMobileMarkdownImages(afterClose)).toEqual([
      { type: 'image', alt: 'visible', url: 'https://example.com/b.png' },
    ]);
    // 段中闭合:--> 之后同段的图正常转换。
    const closesMidBlock = ['<!--', '', '尾注 --> ![visible](https://example.com/c.png)'].join('\n');
    expect(collectMobileMarkdownImages(closesMidBlock)).toEqual([
      { type: 'image', alt: 'visible', url: 'https://example.com/c.png' },
    ]);
    // 跨块注释里的 raw <img> 同样不转换。
    const htmlInComment = ['<!--', '', '<img src="https://example.com/d.png">', '', '-->'].join('\n');
    expect(collectMobileMarkdownImages(htmlInComment)).toEqual([]);
  });

  it('tracks comment state per table row, not per table', () => {
    // 注释在表格中途开启/闭合:注释行之后、--> 之前的行内图不渲染;--> 之后的行恢复正常
    // (此前所有单元格沿用表头行状态近似,review 实捉两个方向都会出错)。
    const rows = [
      '| 图 | 备注 |',
      '| --- | --- |',
      '| ![可见一](https://example.com/1.png) | 正常 |',
      '| 开始 <!-- | 注释开启 |',
      '| ![隐藏](https://example.com/2.png) | 注释中 |',
      '| --> 结束 | 注释闭合 |',
      '| ![可见二](https://example.com/3.png) | 恢复 |',
    ].join('\n');
    expect(collectMobileMarkdownImages(rows).map((image) => image.url)).toEqual([
      'https://example.com/1.png',
      'https://example.com/3.png',
    ]);
  });


  it('does not reject images because of escaped literal HTML markers', () => {
    // \<div> 是 CommonMark 字面文本,不是 raw HTML,不应整段拒转后面的合法图(codex P2)。
    expect(parseMobileMarkdownInlines('\\<div> example \\</div> ![visible](https://example.com/a.png)')
      .filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: 'visible', url: 'https://example.com/a.png' },
    ]);
    expect(parseMobileMarkdownInlines('\\<div> 示例 <img src="https://example.com/b.png">')
      .some((inline) => inline.type === 'image')).toBe(true);
    // 未转义的真标签仍整段拒转。
    expect(parseMobileMarkdownInlines('<div> example </div> ![hidden](https://example.com/a.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
  });

  it('does not let literal comment markers inside code spans poison image matching', () => {
    // code span 里的字面 <!-- 是代码文本,不能把段尾全部毒化成"注释内"(CI reviewer P2);
    // 拒转判定在 code-span 空白填充(偏移保持)的副本上做,与 raw <img> 路径同口径。
    expect(parseMobileMarkdownInlines('用法 `<!--` 之后 ![可见](https://example.com/b.png)')).toEqual([
      { type: 'text', text: '用法 ' },
      { type: 'code', text: '<!--' },
      { type: 'text', text: ' 之后 ' },
      { type: 'image', alt: '可见', url: 'https://example.com/b.png' },
    ]);
    // 跨块状态推进同口径:字面 `<!--` 不能把 inHtmlComment 卡住、吞掉下一段落的图(codex P2)。
    const blocks = parseMobileMarkdown('用法 `<!--` 说明\n\n![可见](https://example.com/c.png)');
    const inlines = blocks.flatMap((block) => (
      block.type === 'paragraph' || block.type === 'heading' || block.type === 'blockquote' || block.type === 'list_item'
        ? block.inlines
        : []
    ));
    expect(inlines.filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: '可见', url: 'https://example.com/c.png' },
    ]);
    // 真正的跨块注释仍然吞图(3987ebea1 的行为不回退)。
    expect(collectMobileMarkdownImages('<!--\n\n![隐藏](https://example.com/a.png)\n\n-->')).toEqual([]);
  });

  it('parses xdt scheme markdown images as non-direct images (MCP contract)', () => {
    // MCP Jira/Confluence 合同在 Markdown 里内嵌 ![](xdt-image://...);解析为 image inline,
    // scheme 归一小写;isMobileMarkdownImageDirectUrl 判定其非直连(查看器走 resolver)。
    expect(parseMobileMarkdownInlines('![附件图](xdt-image://cache/jira-1.png)')).toEqual([
      { type: 'image', alt: '附件图', url: 'xdt-image://cache/jira-1.png' },
    ]);
    expect(parseMobileMarkdownInlines('<img src="XDT-IMAGE://cache/a.png">')).toEqual([
      { type: 'image', alt: '', url: 'xdt-image://cache/a.png' },
    ]);
    expect(isMobileMarkdownImageDirectUrl('https://example.com/a.png')).toBe(true);
    expect(isMobileMarkdownImageDirectUrl('xdt-image://cache/a.png')).toBe(false);
  });

  it('parses cindy-media blob markdown images as non-direct images (媒体总仓新地址)', () => {
    // 媒体总仓迁移后生成图的 Markdown 形态是 ![](cindy-media://blobs/<指纹>.<ext>);
    // 与 xdt-image 同口径:解析为 image inline、scheme 归一小写、非直连走 resolver。
    expect(parseMobileMarkdownInlines('![生成图](cindy-media://blobs/aa11bb22cc33.png)')).toEqual([
      { type: 'image', alt: '生成图', url: 'cindy-media://blobs/aa11bb22cc33.png' },
    ]);
    expect(parseMobileMarkdownInlines('<img src="CINDY-MEDIA://blobs/a.png">')).toEqual([
      { type: 'image', alt: '', url: 'cindy-media://blobs/a.png' },
    ]);
    expect(isMobileMarkdownImageDirectUrl('cindy-media://blobs/a.png')).toBe(false);
  });

  it('rejects img-prefixed non-img tags exactly (img must be followed by whitespace, / or >)', () => {
    // \b 把 -/./: 当边界,<img-wrapper src=...> 会被误当 img 解析出 src(codex P2);
    // 守卫与匹配器都要求标签名"恰好是 img"。
    expect(parseMobileMarkdownInlines('<img-wrapper src="https://example.com/a.png">')
      .some((inline) => inline.type === 'image')).toBe(false);
    // img-* 包裹同时作为非 img 标签,拒转段内其它合法 img。
    expect(parseMobileMarkdownInlines('<img-wrapper><img src="https://example.com/a.png"></img-wrapper>')
      .some((inline) => inline.type === 'image')).toBe(false);
    // 真 img 的三种合法收尾不受影响。
    expect(parseMobileMarkdownInlines('<img src="https://example.com/a.png"/>')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/a.png' },
    ]);
  });

  it('keeps sibling markdown images when benign inline tags appear in the segment', () => {
    // <br>/<b> 等无害行内标签是模型常见输出,桌面端 skipHtml 逐节点丢弃、并列的 ![]() 仍渲染;
    // 整段拒转会把本该显示的图误杀(CI reviewer P2)。容器/可包裹标签(<div>/<a>)仍整段拒转。
    expect(parseMobileMarkdownInlines('对比结果 <br> ![图](https://example.com/a.png)')
      .filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: '图', url: 'https://example.com/a.png' },
    ]);
    expect(parseMobileMarkdownInlines('<b>加粗</b> <sub>注</sub> ![图](https://example.com/b.png)')
      .some((inline) => inline.type === 'image')).toBe(true);
    expect(parseMobileMarkdownInlines('<br/> <img src="https://example.com/c.png">')
      .some((inline) => inline.type === 'image')).toBe(true);
    expect(parseMobileMarkdownInlines('<a href="https://example.com">x</a> ![图](https://example.com/d.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
  });

  it('does not treat custom tags with benign prefixes as benign', () => {
    // <b-card> / <br-wrapper> 不是白名单标签,\b 边界会让它们蒙混过关(codex P2);
    // 标签名后必须紧跟空白 / "/" / ">"。
    expect(parseMobileMarkdownInlines('<b-card><img src="https://example.com/a.png"></b-card>')
      .some((inline) => inline.type === 'image')).toBe(false);
    expect(parseMobileMarkdownInlines('<br-wrapper>![x](https://example.com/a.png)</br-wrapper>')
      .some((inline) => inline.type === 'image')).toBe(false);
    // 真正的白名单标签(含带属性/自闭合)仍放行。
    expect(parseMobileMarkdownInlines('<br/> <b class="x">粗</b> ![图](https://example.com/b.png)')
      .some((inline) => inline.type === 'image')).toBe(true);
  });

  it('carries comment state across table cells within one row', () => {
    // 同一表格行内注释跨单元格:注释区间内的 cell 图片不渲染,--> 之后的 cell 恢复(codex P2)。
    const blocks = parseMobileMarkdown([
      '| a | b | c | d |',
      '| --- | --- | --- | --- |',
      '| start <!-- | ![hidden](https://example.com/a.png) | --> 尾 | ![visible](https://example.com/b.png) |',
    ].join('\n'));
    const table = blocks[0];
    if (table.type !== 'table') throw new Error('expected table');
    const images = table.rows[0].cells.flat().filter((inline) => inline.type === 'image');
    expect(images).toEqual([
      { type: 'image', alt: 'visible', url: 'https://example.com/b.png' },
    ]);
  });

  it('honors backslash-escaped markdown image markers', () => {
    // \![alt](url) 是在示范语法,按 CommonMark 转义保持字面(codex P2);\\![...] 转义的
    // 是反斜杠本身,图片照常渲染。
    expect(parseMobileMarkdownInlines('示例:\\![alt](https://example.com/a.png)')
      .some((inline) => inline.type === 'image')).toBe(false);
    expect(parseMobileMarkdownInlines('反斜杠字面:\\\\![图](https://example.com/b.png)')
      .filter((inline) => inline.type === 'image')).toEqual([
      { type: 'image', alt: '图', url: 'https://example.com/b.png' },
    ]);
    // raw <img> 同口径:\<img ...> 的转义 < 使标签保持字面(codex P2)。
    expect(parseMobileMarkdownInlines('示范:\\<img src="https://example.com/c.png">')
      .some((inline) => inline.type === 'image')).toBe(false);
    expect(parseMobileMarkdownInlines('反斜杠字面:\\\\<img src="https://example.com/d.png">')
      .some((inline) => inline.type === 'image')).toBe(true);
  });

  it('parses markdown images with uppercase scheme and normalizes it (greptile P1)', () => {
    // 与 HTML <img> 路径口径一致:协议大小写不敏感,产出归一为小写。
    expect(parseMobileMarkdownInlines('![图](HTTPS://example.com/a.png)')).toEqual([
      { type: 'image', alt: '图', url: 'https://example.com/a.png' },
    ]);
  });

  it('rejects img conversion when the segment contains wrapping non-img HTML with text between', () => {
    // 紧邻检查会被 <div>caption <img> more</div> 绕过;现在段内出现任何非 img 标签即整段拒转。
    const wrapped = parseMobileMarkdownInlines('<div>caption <img src="https://example.com/a.png"> more</div>');
    expect(wrapped.some((inline) => inline.type === 'image')).toBe(false);
    const linkWrapped = parseMobileMarkdownInlines('<a href="https://example.com">看 <img src="https://example.com/a.png"> 图</a>');
    expect(linkWrapped.some((inline) => inline.type === 'image')).toBe(false);
    // 尖括号 URL 不是 HTML 标签,不触发拒转。
    expect(parseMobileMarkdownInlines('<https://example.com> <img src="https://example.com/a.png">')
      .some((inline) => inline.type === 'image')).toBe(true);
    // code span 里的字面标签是代码文本,不连坐禁掉同段的合法 <img>(codex P2)。
    expect(parseMobileMarkdownInlines('用 `<div>` 布局,示例 <img src="https://example.com/a.png">')
      .some((inline) => inline.type === 'image')).toBe(true);
    // 注释 / doctype / 处理指令同属任意 HTML,被注释掉的 <img> 不应被渲染出来(codex P2)。
    expect(parseMobileMarkdownInlines('<!-- <img src="https://example.com/a.png"> -->')
      .some((inline) => inline.type === 'image')).toBe(false);
    expect(parseMobileMarkdownInlines('<!DOCTYPE html> <img src="https://example.com/a.png">')
      .some((inline) => inline.type === 'image')).toBe(false);
  });

  it('normalizes uppercase url scheme in html img src', () => {
    // RFC 3986 scheme 大小写不敏感;归一为小写让 bridge 校验、图集匹配与
    // isPayloadDirectPreviewableUrl(大小写敏感 startsWith)全链路一致。
    expect(parseMobileMarkdownInlines('<img src="HTTPS://example.com/A.png">')).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/A.png' },
    ]);
  });

  it('does not convert img markup inside code spans and code blocks', () => {
    expect(parseMobileMarkdownInlines('`<img src="https://example.com/x.png">`')).toEqual([
      { type: 'code', text: '<img src="https://example.com/x.png">' },
    ]);
    expect(parseMobileMarkdown([
      '```html',
      '<img src="https://example.com/y.png">',
      '```',
    ].join('\n'))).toEqual([
      {
        type: 'code',
        key: 'code:0:0',
        language: 'html',
        text: '<img src="https://example.com/y.png">',
      },
    ]);
  });

  it('parses images inside table cells (desktop PR #410 scenario)', () => {
    const blocks = parseMobileMarkdown([
      '| 图片 | 名称 |',
      '| --- | --- |',
      '| <img src="https://example.com/h1.jpg" width="150"> | 房源一 |',
    ].join('\n'));
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    if (table.type !== 'table') throw new Error('expected table block');
    expect(table.rows[0].cells[0]).toEqual([
      { type: 'image', alt: '', url: 'https://example.com/h1.jpg', width: 150 },
    ]);
  });

  it('collects body images from paragraphs and table cells, skipping code blocks', () => {
    expect(collectMobileMarkdownImages([
      '开头 ![一](https://example.com/1.png)',
      '',
      '| 图 | 名 |',
      '| --- | --- |',
      '| <img src="https://example.com/2.jpg" width="150"> | 二 |',
      '',
      '```html',
      '<img src="https://example.com/code.png">',
      '```',
    ].join('\n'))).toEqual([
      { type: 'image', alt: '一', url: 'https://example.com/1.png' },
      { type: 'image', alt: '', url: 'https://example.com/2.jpg', width: 150 },
    ]);
    // 无图片时廉价短路。
    expect(collectMobileMarkdownImages('纯文本消息')).toEqual([]);
  });

  it('clamps streaming thumbnail size including extreme declared aspect ratios', () => {
    // 默认 150 宽 4:3;声明宽高按比例换算但两边都封顶 220——height="9999" 这类
    // 白名单内的极端值不能在流式阶段渲染出近万像素高的图。
    expect(mobileMarkdownInlineImageSize({ type: 'image', alt: '', url: 'https://e.com/a.png' }))
      .toEqual({ width: 150, height: 113 });
    expect(mobileMarkdownInlineImageSize({ type: 'image', alt: '', url: 'https://e.com/a.png', width: 120, height: 90 }))
      .toEqual({ width: 120, height: 90 });
    expect(mobileMarkdownInlineImageSize({ type: 'image', alt: '', url: 'https://e.com/a.png', width: 150, height: 9999 }))
      .toEqual({ width: 150, height: 220 });
    expect(mobileMarkdownInlineImageSize({ type: 'image', alt: '', url: 'https://e.com/a.png', width: 9999, height: 10 }))
      .toEqual({ width: 220, height: 1 });
    expect(mobileMarkdownInlineImageSize({ type: 'image', alt: '', url: 'https://e.com/a.png', height: 9999 }))
      .toEqual({ width: 150, height: 220 });
  });

  it('derives image titles from alt or url filename', () => {
    expect(mobileMarkdownImageTitle('https://example.com/a.png', '部署截图')).toBe('部署截图');
    expect(mobileMarkdownImageTitle('https://example.com/pics/b%20c.png?x=1')).toBe('b c.png');
    expect(mobileMarkdownImageTitle('https://example.com/')).toBe('图片');
  });









  it('tokenizes bare and explicit session deep links as inline links', () => {
    const url = 'xdt-maker://session/03e0c22d-19db-4ac5-814f-1ea04040b471?message=m1';
    expect(parseMobileMarkdownInlines(`看 ${url}。收尾`)).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', text: url, url },
      { type: 'text', text: '。收尾' },
    ]);
    expect(parseMobileMarkdownInlines(`[会话](${url}) 后文`)).toEqual([
      { type: 'link', text: '会话', url },
      { type: 'text', text: ' 后文' },
    ]);
    // 尾部英文句读留在链接外
    expect(parseMobileMarkdownInlines(`see ${url}.`)).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: url, url },
      { type: 'text', text: '.' },
    ]);
  });

  it('keeps session deep links literal inside inline and fenced code', () => {
    const url = 'cindy://session/session-a?message=message-a';
    expect(parseMobileMarkdownInlines(`\`${url}\` then ${url}`)).toEqual([
      { type: 'code', text: url },
      { type: 'text', text: ' then ' },
      { type: 'link', text: url, url },
    ]);
    expect(parseMobileMarkdown(['```text', url, '```'].join('\n'))).toEqual([
      { type: 'code', key: 'code:0:0', language: 'text', text: url },
    ]);
  });

  it('tokenizes bare and explicit project deep links as inline links (review P1)', () => {
    // 桌面端粘贴 chip 化后按 [标题](深链) 发送;不 tokenize 会把整段渲染成
    // 原始 markdown 源码。renderInline 对非 session 深链显示 label 纯文本。
    const url = 'xdt-maker://project/%2FUsers%2Fdash%2FCode%2FTools%2Fxdt-maker';
    expect(parseMobileMarkdownInlines(`[主仓](${url}) 后文`)).toEqual([
      { type: 'link', text: '主仓', url },
      { type: 'text', text: ' 后文' },
    ]);
    expect(parseMobileMarkdownInlines(`项目在 ${url} 这里`)).toEqual([
      { type: 'text', text: '项目在 ' },
      { type: 'link', text: url, url },
      { type: 'text', text: ' 这里' },
    ]);
    // 其它 xdt-maker:// 形态仍不 tokenize(维持纯文本)
    expect(parseMobileMarkdownInlines('xdt-maker://other/foo')).toEqual([
      { type: 'text', text: 'xdt-maker://other/foo' },
    ]);
  });

  it('keeps sentence punctuation after a bare project link as text (review P2)', () => {
    // project 白名单含 `.`:正则会把句号吞进 match,trimUrlPunctuation 只修
    // 展示不修 cursor 推进,句号从渲染输出里整个消失。
    const url = 'xdt-maker://project/%2FUsers%2Fdash%2FCode%2FTools%2Fxdt-maker';
    expect(parseMobileMarkdownInlines(`see ${url}.`)).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: url, url },
      { type: 'text', text: '.' },
    ]);
    expect(parseMobileMarkdownInlines(`${url}. 后文`)).toEqual([
      { type: 'link', text: url, url },
      { type: 'text', text: '. 后文' },
    ]);
  });

  it('leaves legacy project links with raw delimiters as plain text (review P2)', () => {
    // 旧编码放行 `'()`;白名单截断出的前缀会显示成指错项目的链接,
    // 整段维持纯文本(与桌面 PROJECT_DEEP_LINK_RE_SOURCE 的尾部前瞻同口径)。
    expect(parseMobileMarkdownInlines('xdt-maker://project/%2Ftmp%2Ffoo(copy)')).toEqual([
      { type: 'text', text: 'xdt-maker://project/%2Ftmp%2Ffoo(copy)' },
    ]);
    expect(parseMobileMarkdownInlines("xdt-maker://project/%2FJohn's%20Repo")).toEqual([
      { type: 'text', text: "xdt-maker://project/%2FJohn's%20Repo" },
    ]);
  });







  it('preserves balanced parentheses in markdown image urls', () => {
    // CommonMark 允许 URL 含平衡括号;截断成 screenshot(1 会让渲染/图集拿到坏 URL(codex P2)。
    expect(parseMobileMarkdownInlines('![截图](https://example.com/screenshot(1).png)')).toEqual([
      { type: 'image', alt: '截图', url: 'https://example.com/screenshot(1).png' },
    ]);
    expect(parseMobileMarkdownInlines('![v2](https://example.com/dir_(v2)/a.png)')).toEqual([
      { type: 'image', alt: 'v2', url: 'https://example.com/dir_(v2)/a.png' },
    ]);
  });







});

describe('parseMobileMarkdown srcLines 选项', () => {
  it('开启时每块带源码起始行(段落取首行,不是 flush 行)', () => {
    const blocks = parseMobileMarkdown([
      '# 标题',        // 0
      '',
      '第一段',        // 2
      '跨两行',        // 3
      '',
      '- 列表项',      // 5
      '',
      '> 引用',        // 7
      '',
      '```ts',         // 9
      'const a = 1;',
      '```',
    ].join('\n'), { srcLines: true });
    expect(blocks.map((b) => [b.type, b.srcLine])).toEqual([
      ['heading', 0],
      ['paragraph', 2],
      ['list_item', 5],
      ['blockquote', 7],
      ['code', 9],
    ]);
  });

  it('默认关闭:输出形状与既有消费方一致(无 srcLine 字段)', () => {
    const blocks = parseMobileMarkdown('段落');
    expect('srcLine' in blocks[0]).toBe(false);
  });
});

describe('local path links(文件 chip 链路的链接形态)', () => {
  it('[label](/abs/path) 解析为 link inline(URL 保留行号后缀)', () => {
    expect(parseMobileMarkdownInlines('见 [README.md](/Users/me/proj/README.md:17) 补充')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'link', text: 'README.md', url: '/Users/me/proj/README.md:17' },
      { type: 'text', text: ' 补充' },
    ]);
  });

  it('相对路径 / Windows 路径 / file:// 同样解析', () => {
    expect(parseMobileMarkdownInlines('[入口](src/App.tsx)')).toEqual([
      { type: 'link', text: '入口', url: 'src/App.tsx' },
    ]);
    expect(parseMobileMarkdownInlines('[配置](C:\\proj\\a.json)')).toEqual([
      { type: 'link', text: '配置', url: 'C:\\proj\\a.json' },
    ]);
    expect(parseMobileMarkdownInlines('[本地](file:///Users/me/a.md)')).toEqual([
      { type: 'link', text: '本地', url: 'file:///Users/me/a.md' },
    ]);
  });

  it('http / 会话深链不受影响,mailto 等 scheme 仍保持字面', () => {
    expect(parseMobileMarkdownInlines('[站点](https://x.com/a.ts)')).toEqual([
      { type: 'link', text: '站点', url: 'https://x.com/a.ts' },
    ]);
    expect(parseMobileMarkdownInlines('[联系](mailto:a@b.com)')).toEqual([
      { type: 'text', text: '[联系](mailto:a@b.com)' },
    ]);
  });

  it('带可选 title 的本地链接完整成链,不被裸路径 matcher 拆成三段', () => {
    // 回归:destination 原先卡在 `[^)\s]+`,带 title 的整段不匹配 → 退回字面文本,
    // 而裸路径 matcher 会从括号里命中 `src/App.ts`,渲染成
    // 「字面 `[源码](` + 可点路径 + 字面 ` "实现")`」(PR #1144 review 实捉)。
    expect(parseMobileMarkdownInlines('见 [源码](src/App.ts "实现") 的实现')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'link', text: '源码', url: 'src/App.ts' },
      { type: 'text', text: ' 的实现' },
    ]);
    // 单引号 title、括号 title、尖括号包裹含空格路径,同图片侧一套口径。
    expect(parseMobileMarkdownInlines("[配置](src/a.json '说明')")).toEqual([
      { type: 'link', text: '配置', url: 'src/a.json' },
    ]);
    expect(parseMobileMarkdownInlines('[配置](src/a.json (说明))')).toEqual([
      { type: 'link', text: '配置', url: 'src/a.json' },
    ]);
    expect(parseMobileMarkdownInlines('[图](<docs/a b.png>)')).toEqual([
      { type: 'link', text: '图', url: 'docs/a b.png' },
    ]);
  });

  it('非路径形状的 [x](y) 保持字面文本', () => {
    expect(parseMobileMarkdownInlines('数组 [1](2) 形态')).toEqual([
      { type: 'text', text: '数组 [1](2) 形态' },
    ]);
  });

  it('![alt](/abs.png) 图片语法由本地图片能力接管,不被链接规则吞掉', () => {
    expect(parseMobileMarkdownInlines('![图](/Users/me/a.png)')).toEqual([
      { type: 'image', alt: '图', url: '/Users/me/a.png' },
    ]);
  });
});

describe('bare file paths(正文纯文本形态)', () => {
  // 与桌面 remarkLocalPathLinks 补齐的同一个入口:正文里裸写的路径切成 link inline,
  // 与 `[label](path)` 形态共用 LinkPathChipSpan → 远端 stat → 点亮 chip / 纯文本。
  // 词法口径(哪些形状算路径、CJK 已知限制)由 chatPathCandidate.test.ts 固化,
  // 这里只钉「分词结果」与「不抢走既有包裹语法」。

  it('句中裸路径切成 link,前后纯文本保留', () => {
    expect(parseMobileMarkdownInlines('见 src/App.tsx 第 20 行')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'link', text: 'src/App.tsx', url: 'src/App.tsx', bare: true },
      { type: 'text', text: ' 第 20 行' },
    ]);
  });

  it('绝对路径 / 行号后缀 / 一段多条', () => {
    expect(parseMobileMarkdownInlines('图在 /Users/me/out/hero.png')).toEqual([
      { type: 'text', text: '图在 ' },
      { type: 'link', text: '/Users/me/out/hero.png', url: '/Users/me/out/hero.png', bare: true },
    ]);
    expect(parseMobileMarkdownInlines('见 src/App.tsx:42 那行')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'link', text: 'src/App.tsx:42', url: 'src/App.tsx:42', bare: true },
      { type: 'text', text: ' 那行' },
    ]);
    expect(parseMobileMarkdownInlines('对比 a/b.ts 和 c/d.ts')).toEqual([
      { type: 'text', text: '对比 ' },
      { type: 'link', text: 'a/b.ts', url: 'a/b.ts', bare: true },
      { type: 'text', text: ' 和 ' },
      { type: 'link', text: 'c/d.ts', url: 'c/d.ts', bare: true },
    ]);
  });

  it('裸文件名不识别(严于 inline code:反引号是作者的显式格式信号)', () => {
    expect(parseMobileMarkdownInlines('改一下 package.json 配置')).toEqual([
      { type: 'text', text: '改一下 package.json 配置' },
    ]);
    expect(parseMobileMarkdownInlines('改一下 `package.json` 配置')).toEqual([
      { type: 'text', text: '改一下 ' },
      { type: 'code', text: 'package.json' },
      { type: 'text', text: ' 配置' },
    ]);
  });

  // ── 不抢走既有包裹语法(index 升序排序天然保证,这里把它钉住) ──

  it('inline code 里的路径仍归 code,不被裸路径抢走', () => {
    expect(parseMobileMarkdownInlines('见 `src/App.tsx` 那个')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'code', text: 'src/App.tsx' },
      { type: 'text', text: ' 那个' },
    ]);
  });

  it('markdown 链接 / 图片形态不被裸路径抢走(标签里含路径也不拆)', () => {
    expect(parseMobileMarkdownInlines('[src/App.tsx](/abs/src/App.tsx)')).toEqual([
      { type: 'link', text: 'src/App.tsx', url: '/abs/src/App.tsx' },
    ]);
    expect(parseMobileMarkdownInlines('![图](/Users/me/a.png)')).toEqual([
      { type: 'image', alt: '图', url: '/Users/me/a.png' },
    ]);
  });

  it('裸 URL 不被切出内部路径段', () => {
    expect(parseMobileMarkdownInlines('图在 https://x.com/a/b.png 这里')).toEqual([
      { type: 'text', text: '图在 ' },
      { type: 'link', text: 'https://x.com/a/b.png', url: 'https://x.com/a/b.png' },
      { type: 'text', text: ' 这里' },
    ]);
  });

  it('未闭合反引号不构成 code span,裸路径照常识别(与桌面 remark 同口径)', () => {
    // 流式中途的常见中间态;闭合后下一轮重解析自然回到 code 形态。
    expect(parseMobileMarkdownInlines('见 `src/App.tsx 还没闭合')).toEqual([
      { type: 'text', text: '见 `' },
      { type: 'link', text: 'src/App.tsx', url: 'src/App.tsx', bare: true },
      { type: 'text', text: ' 还没闭合' },
    ]);
  });

  it('HTML 注释里的裸路径不识别(桌面侧注释是 html 节点、插件看不到)', () => {
    expect(parseMobileMarkdownInlines('<!-- 见 src/App.tsx -->')).toEqual([
      { type: 'text', text: '<!-- 见 src/App.tsx -->' },
    ]);
    // 注释外的照常识别,注释内的压制。
    expect(parseMobileMarkdownInlines('<!-- a/b.ts --> 但 c/d.ts 要改')).toEqual([
      { type: 'text', text: '<!-- a/b.ts --> 但 ' },
      { type: 'link', text: 'c/d.ts', url: 'c/d.ts', bare: true },
      { type: 'text', text: ' 要改' },
    ]);
  });

  it('跨块注释状态同样压制(段起点仍在上一块开启的注释里)', () => {
    expect(parseMobileMarkdownInlines('见 src/App.tsx --> 之后 c/d.ts', true)).toEqual([
      { type: 'text', text: '见 src/App.tsx --> 之后 ' },
      { type: 'link', text: 'c/d.ts', url: 'c/d.ts', bare: true },
    ]);
  });

  it('标签标记内部的路径不识别(属性值命中会拆坏标签结构)', () => {
    // `<span title="src/App.tsx">x</span>` 若命中会被拆成
    // `<span title="` + 链接 + `">x</span>` —— 那是在破坏标签,不是给正文加链接
    // (PR #1144 review 实捉)。
    expect(parseMobileMarkdownInlines('<span title="src/App.tsx">x</span>')).toEqual([
      { type: 'text', text: '<span title="src/App.tsx">x</span>' },
    ]);
    expect(parseMobileMarkdownInlines('<img src="docs/a.png" alt="x">')).toEqual([
      { type: 'text', text: '<img src="docs/a.png" alt="x">' },
    ]);
  });

  it('属性值里合法的 `>` 不截断标签区间(守卫的覆盖面要等于它声称的范围)', () => {
    // 带引号的属性值里出现 `>` 完全合法。按 `[^<>]*` 扫会在属性内的 `>` 提前收尾,
    // 后面的 src/App.tsx 重新暴露给裸路径 matcher,标签被拆成三段 —— 守卫在它自称
    // 保护的一部分属性值上失效(PR #1144 review 实捉)。
    expect(parseMobileMarkdownInlines('<span title="a > src/App.tsx">x</span>')).toEqual([
      { type: 'text', text: '<span title="a > src/App.tsx">x</span>' },
    ]);
    // 单引号同理;同一标签内混用两种引号也要整段吃掉。
    expect(parseMobileMarkdownInlines("<img src=\"a.png\" alt='b > docs/c.png'>")).toEqual([
      { type: 'text', text: "<img src=\"a.png\" alt='b > docs/c.png'>" },
    ]);
    // 未闭合引号已是坏 HTML:退化为「不成立标签区间」,与本守卫加入前一致,
    // 不为它另造语义(这条同时钉住修法没有把区间贪心延伸到段尾)。
    expect(parseMobileMarkdownInlines('<span title="x > src/App.tsx')).toEqual([
      { type: 'text', text: '<span title="x > ' },
      { type: 'link', text: 'src/App.tsx', url: 'src/App.tsx', bare: true },
    ]);
  });

  it('元素内容里的路径照常识别(与既有 strong / code / 裸 URL matcher 同口径)', () => {
    // 刻意**不**挡元素内容:实测既有 matcher 在字面 HTML 的内容里同样会解析
    // (`<div>**加粗**</div>` → strong、`<div>https://x.com</div>` → link),
    // 单独把裸路径排除反而造成本文件内部不一致。
    expect(parseMobileMarkdownInlines('<div>src/App.tsx</div>')).toEqual([
      { type: 'text', text: '<div>' },
      { type: 'link', text: 'src/App.tsx', url: 'src/App.tsx', bare: true },
      { type: 'text', text: '</div>' },
    ]);
    // 同段的既有行为作对照,证明口径一致而非特例。
    expect(parseMobileMarkdownInlines('<div>**加粗**</div>')).toEqual([
      { type: 'text', text: '<div>' },
      { type: 'strong', text: '加粗' },
      { type: 'text', text: '</div>' },
    ]);
  });

  it('散文里的 `<` 不构成标签区间,不影响路径识别', () => {
    expect(parseMobileMarkdownInlines('若 a < b 则看 src/App.tsx')).toEqual([
      { type: 'text', text: '若 a < b 则看 ' },
      { type: 'link', text: 'src/App.tsx', url: 'src/App.tsx', bare: true },
    ]);
  });

  it('已知取舍:被强调包裹的路径不成 chip(手机 inline 模型扁平,不支持嵌套)', () => {
    // 桌面 remark 能在 strong 的子 text 里继续 linkify;手机端 inline 无嵌套,
    // 强调整段吃掉。属既有架构限制,本次不扩,先把现状钉住。
    expect(parseMobileMarkdownInlines('**src/App.tsx**')).toEqual([
      { type: 'strong', text: 'src/App.tsx' },
    ]);
  });

  it('标题 / 列表项 / 引用 / 表格单元格都走同一条分词', () => {
    expect(parseMobileMarkdown('## 见 src/a.ts')[0]).toMatchObject({
      type: 'heading',
      inlines: [
        { type: 'text', text: '见 ' },
        { type: 'link', text: 'src/a.ts', url: 'src/a.ts', bare: true },
      ],
    });
    expect(parseMobileMarkdown('- 改 src/a.ts')[0]).toMatchObject({
      type: 'list_item',
      inlines: [
        { type: 'text', text: '改 ' },
        { type: 'link', text: 'src/a.ts', url: 'src/a.ts', bare: true },
      ],
    });
    expect(parseMobileMarkdown('> 见 src/a.ts')[0]).toMatchObject({
      type: 'blockquote',
      inlines: [
        { type: 'text', text: '见 ' },
        { type: 'link', text: 'src/a.ts', url: 'src/a.ts', bare: true },
      ],
    });
  });

  it('代码围栏内是字面代码,不进 inline 分词', () => {
    expect(parseMobileMarkdown(['```', '见 src/App.tsx', '```'].join('\n'))).toEqual([
      { type: 'code', key: 'code:0:0', language: undefined, text: '见 src/App.tsx' },
    ]);
  });
});

describe('groupMobileMarkdownSelectableBlocks', () => {
  it('merges consecutive text blocks into one run so native selection can cross paragraphs', () => {
    const blocks = parseMobileMarkdown([
      '# 标题',
      '',
      '第一段',
      '',
      '- 列表项 A',
      '- 列表项 B',
      '',
      '```',
      'code',
      '```',
      '',
      '第二段',
    ].join('\n'));
    const groups = groupMobileMarkdownSelectableBlocks(blocks);
    expect(groups.map((group) => group.type)).toEqual(['text_run', 'single', 'text_run']);
    const firstRun = groups[0];
    if (firstRun.type !== 'text_run') throw new Error('expected text_run');
    expect(firstRun.blocks.map((block) => block.type)).toEqual([
      'heading', 'paragraph', 'list_item', 'list_item',
    ]);
  });

  it('keeps blocks with direct inline images out of text runs', () => {
    const blocks = parseMobileMarkdown('前一段\n\n![图](https://example.com/a.png)\n\n后一段');
    const groups = groupMobileMarkdownSelectableBlocks(blocks);
    const kinds = groups.map((group) => group.type);
    expect(kinds.filter((kind) => kind === 'single').length).toBeGreaterThanOrEqual(1);
    // 直连图所在块必须是 single(Text 内嵌 View 不能进合并文本树)。
    for (const group of groups) {
      if (group.type !== 'single') continue;
      const hasImage = 'inlines' in group.block
        && group.block.inlines.some((inline) => inline.type === 'image');
      const isComplex = group.block.type === 'code' || group.block.type === 'table' || group.block.type === 'mermaid';
      expect(hasImage || isComplex).toBe(true);
    }
  });

  it('can bound text runs by block count for tall native selectable text views', () => {
    const blocks = parseMobileMarkdown([
      '# 标题',
      '',
      '第一段',
      '',
      '- 列表项 A',
      '- 列表项 B',
      '',
      '第二段',
    ].join('\n'));
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunBlocks: 2 });
    expect(groups.map((group) => group.type)).toEqual(['text_run', 'text_run', 'text_run']);
    expect(groups.map((group) => (group.type === 'text_run' ? group.blocks.length : 0))).toEqual([2, 2, 1]);
  });

  it('can bound text runs by rendered inline text length', () => {
    const blocks = parseMobileMarkdown([
      '短段',
      '',
      '这是一段超过阈值的正文',
      '',
      '尾段',
    ].join('\n'));
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunUtf16Length: 8 });
    expect(groups.map((group) => group.type)).toEqual(['text_run', 'text_run', 'text_run']);
    expect(groups.map((group) => (group.type === 'text_run' ? group.blocks.length : 0))).toEqual([1, 1, 2]);
  });

  it('counts rendered block separators when bounding text runs by text length', () => {
    const blocks = parseMobileMarkdown(['aaaa', '', 'bbbb'].join('\n'));
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunUtf16Length: 8 });

    expect(groups.map((group) => group.type)).toEqual(['text_run', 'text_run']);
    expect(groups.map((group) => (group.type === 'text_run' ? group.blocks.length : 0))).toEqual([1, 1]);
  });

  it('splits a single oversized text block by rendered inline text length', () => {
    const blocks = parseMobileMarkdown('a'.repeat(21));
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunUtf16Length: 8 });
    expect(groups.map((group) => group.type)).toEqual(['text_run', 'text_run', 'text_run']);

    const chunks = groups.flatMap((group) => (group.type === 'text_run' ? group.blocks : []));
    expect(chunks.map((block) => (
      block.inlines.map((inline) => (inline.type === 'image' ? inline.alt : inline.text)).join('')
    ))).toEqual([
      'a'.repeat(8),
      'a'.repeat(8),
      'a'.repeat(5),
    ]);
    expect(chunks.map((block) => block.textRunContinuation === true)).toEqual([false, true, true]);
    expect(groups.map((group) => (
      group.type === 'text_run' && group.textRunContinuation === true
    ))).toEqual([false, true, true]);
  });

  it('does not split surrogate pairs when a limit falls before an emoji', () => {
    const text = `${'a'.repeat(7)}😀b`;
    const blocks = parseMobileMarkdown(text);
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunUtf16Length: 8 });
    const chunks = groups.flatMap((group) => (group.type === 'text_run' ? group.blocks : []));

    const chunkText = chunks.map((block) => (
      block.inlines.map((inline) => (inline.type === 'image' ? inline.alt : inline.text)).join('')
    ));
    expect(chunkText).toEqual(['a'.repeat(7), '😀b']);
    expect(chunkText.join('')).toBe(text);
  });

  it('keeps oversized non-direct image alt text in one image inline while bounding rendered chip text', () => {
    const alt = 'a'.repeat(MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH + 21);
    const blocks = parseMobileMarkdown(`![${alt}](docs/local-image.png)`);
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunUtf16Length: 1800 });
    const chunks = groups.flatMap((group) => (group.type === 'text_run' ? group.blocks : []));
    const imageInlines = chunks.flatMap((block) => block.inlines.filter((inline) => inline.type === 'image'));

    expect(groups.map((group) => group.type)).toEqual(['text_run']);
    expect(imageInlines).toHaveLength(1);
    expect(imageInlines[0]).toMatchObject({ alt, url: 'docs/local-image.png' });
    expect(mobileMarkdownImageAltChipText(imageInlines[0].alt)).toHaveLength(
      MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH,
    );
    expect(mobileMarkdownImageAltChipText(imageInlines[0].alt).endsWith('…')).toBe(true);
  });

  it('does not split surrogate pairs when truncating oversized image alt chip text', () => {
    const alt = `${'a'.repeat(MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH - 1)}😀b`;
    const chipText = mobileMarkdownImageAltChipText(alt);

    expect(chipText).toHaveLength(MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH);
    expect(chipText).toBe(`${'a'.repeat(MOBILE_MARKDOWN_IMAGE_ALT_CHIP_MAX_UTF16_LENGTH - 1)}…`);
    expect(chipText).not.toContain('\uD83D');
    expect(chipText).not.toContain('\uDE00');
  });

  it('counts rendered list marker spaces when splitting long list items', () => {
    const blocks = parseMobileMarkdown('- abcdefghij');
    const groups = groupMobileMarkdownSelectableBlocks(blocks, { maxTextRunUtf16Length: 8 });
    const chunks = groups.flatMap((group) => (group.type === 'text_run' ? group.blocks : []));

    expect(chunks.map((block) => (
      block.inlines.map((inline) => (inline.type === 'image' ? inline.alt : inline.text)).join('')
    ))).toEqual(['abcdef', 'ghij']);
    expect(chunks.map((block) => block.textRunContinuation === true)).toEqual([false, true]);
  });

  it('treats fractional text run limits below one as disabled', () => {
    const blocks = parseMobileMarkdown(['first', '', 'second'].join('\n'));
    const groups = groupMobileMarkdownSelectableBlocks(blocks, {
      maxTextRunBlocks: 0.5,
      maxTextRunUtf16Length: 0.5,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('text_run');
    if (groups[0].type !== 'text_run') throw new Error('expected text_run');
    expect(groups[0].blocks).toHaveLength(2);
  });
});

describe('LaTeX math(块级 $$ 围栏与 inline $ 定界符)', () => {
  it('多行 $$ 围栏 → math 块', () => {
    expect(parseMobileMarkdown('$$\nE = mc^2\n$$')).toEqual([
      { type: 'math', key: 'math:0:0', text: 'E = mc^2' },
    ]);
  });

  it('单行 $$x$$ 独占一行 → math 块', () => {
    const blocks = parseMobileMarkdown('前文\n$$\\int_0^1 x dx$$\n后文');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'math', 'paragraph']);
    expect(blocks[1]).toMatchObject({ type: 'math', text: '\\int_0^1 x dx' });
  });

  it('\\[...\\] 经归一化后成为 math 块(共用 normalizeMathDelimiters)', () => {
    const blocks = parseMobileMarkdown('推导:\n\\[\nx = 1\n\\]');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'math']);
    expect(blocks[1]).toMatchObject({ type: 'math', text: 'x = 1' });
  });

  it('未闭合 $$ 围栏(streaming 中途)按原文段落展示,不升级 math 块', () => {
    // math 块是 WebView 渲染,流式中 source 每 tick 变化会整页 reload;
    // 未闭合围栏保持段落形态,闭合后下一轮重解析才升级(对齐 mermaid 口径)。
    const blocks = parseMobileMarkdown('$$\n\\frac{1}{2}');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
    const closed = parseMobileMarkdown('$$\n\\frac{1}{2}\n$$');
    expect(closed).toEqual([{ type: 'math', key: 'math:0:0', text: '\\frac{1}{2}' }]);
  });

  it('空 $$ 围栏不产出 math 块,保持原文段落(规避空公式占位文案)', () => {
    const blocks = parseMobileMarkdown('$$\n\n$$');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'paragraph' });
  });

  it('code fence 内的 $$ 行不开 math 围栏', () => {
    const blocks = parseMobileMarkdown('```\n$$\nnot math\n$$\n```');
    expect(blocks.map((block) => block.type)).toEqual(['code']);
  });

  it('inline $x$ → math inline;\\(x\\) 归一化后同形态', () => {
    expect(parseMobileMarkdownInlines('质能方程 $E=mc^2$ 成立')).toEqual([
      { type: 'text', text: '质能方程 ' },
      { type: 'math', text: 'E=mc^2' },
      { type: 'text', text: ' 成立' },
    ]);
    const blocks = parseMobileMarkdown('圆面积 \\(A = \\pi r^2\\) 公式');
    expect(blocks[0]).toMatchObject({
      type: 'paragraph',
      inlines: [
        { type: 'text', text: '圆面积 ' },
        { type: 'math', text: 'A = \\pi r^2' },
        { type: 'text', text: ' 公式' },
      ],
    });
  });

  it('inline $$x$$ 双 dollar 行内形态 → math inline', () => {
    expect(parseMobileMarkdownInlines('说明 $$a+b$$ 结束')).toEqual([
      { type: 'text', text: '说明 ' },
      { type: 'math', text: 'a+b' },
      { type: 'text', text: ' 结束' },
    ]);
  });

  it('货币文本不误判:$5 和 $10(闭合 $ 前是空白 / 后是数字)', () => {
    expect(parseMobileMarkdownInlines('价格在 $5 和 $10 之间')).toEqual([
      { type: 'text', text: '价格在 $5 和 $10 之间' },
    ]);
  });

  it('公式体内的 * / _ 不被强调规则拆走', () => {
    expect(parseMobileMarkdownInlines('$a_1 * b_2$')).toEqual([
      { type: 'math', text: 'a_1 * b_2' },
    ]);
  });

  it('货币 + code span 混排不跨 code 边界配对:$10 …`$HOME`(模拟器实捉)', () => {
    // 「$10 之间;环境变量 `$HOME`」曾被解析成一个横跨 code span 的公式
    // ($10 的 $ 与 `$HOME` 里的 $ 配对),吞掉中间整段文本。内容排除
    // backtick 后,这段应保持货币原文 + code span 原样。
    expect(parseMobileMarkdownInlines('价格在 $5 和 $10 之间;环境变量 `$HOME`;结束')).toEqual([
      { type: 'text', text: '价格在 $5 和 $10 之间;环境变量 ' },
      { type: 'code', text: '$HOME' },
      { type: 'text', text: ';结束' },
    ]);
  });

  it('inline code 里的 $ 不进公式:`$HOME`', () => {
    expect(parseMobileMarkdownInlines('用 `$HOME` 变量')).toEqual([
      { type: 'text', text: '用 ' },
      { type: 'code', text: '$HOME' },
      { type: 'text', text: ' 变量' },
    ]);
  });

  it('math 块不进 text_run 合并组(独立渲染)', () => {
    const blocks = parseMobileMarkdown('段落一\n$$\nx=1\n$$\n段落二');
    const groups = groupMobileMarkdownSelectableBlocks(blocks);
    expect(groups.map((group) => group.type)).toEqual(['text_run', 'single', 'text_run']);
  });
});

describe('title 剥离不得灾难性回溯(ReDoS)', () => {
  // 引号内的字符类若写成 `[^\n]`,它与 `\\.` 在反斜杠上重叠:一个 `\` 既能被前者当
  // 1 个字符吃、也能作为后者的开头吃 2 个,一串反斜杠就有 Fib(n) 种切法;引号未闭合时
  // 末尾的 `\2$` 必然失配,回溯把所有切法枚举一遍 → 时间指数增长(实测 42 个反斜杠
  // 3575ms,每 +4 慢约 7 倍)。触发面是聊天正文里一条 `[x](a "\\…`,而本函数在渲染热
  // 路径上,手机端会冻住整个 JS 线程(PR #1144 review 实捉)。
  //
  // 断言用时间上限:改前 46 个反斜杠约 25s,改后恒 0ms,1s 的上限有 20 倍以上余量,
  // 不会因 CI 抖动误报。
  it('未闭合引号 + 长反斜杠串:必须线性完成', () => {
    const payload = `[x](a "${'\\'.repeat(46)}`;
    const started = Date.now();
    parseMobileMarkdownInlines(payload);
    expect(Date.now() - started, 'title 剥离出现灾难性回溯').toBeLessThan(1000);
  });

  it('合法 title 仍被正确剥离(修法未改变功能)', () => {
    expect(parseMobileMarkdownInlines('见 [说明](/abs/a.md "标题") 补充')).toEqual([
      { type: 'text', text: '见 ' },
      { type: 'link', text: '说明', url: '/abs/a.md' },
      { type: 'text', text: ' 补充' },
    ]);
  });
});
