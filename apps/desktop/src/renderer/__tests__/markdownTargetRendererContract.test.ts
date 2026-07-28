import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const markdownRenderer = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'MarkdownRenderer.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

const localPathResolver = readFileSync(
  resolve(__dirname, '..', 'lib', 'localPathResolver.ts'),
  'utf8',
).replace(/\r\n?/g, '\n');

const textLightbox = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'TextLightbox.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('Markdown target rendering contract', () => {
  it('funnels markdown links and inline code through the shared target classifier', () => {
    expect(markdownRenderer).toContain('classifyMarkdownLinkTarget');
    expect(markdownRenderer).toContain('classifyInlineCodeTarget');
    expect(markdownRenderer).toContain('<MarkdownTargetLink');
    expect(markdownRenderer).toContain('<InlineCodeWithTarget');
  });

  it('only renders a chip for uniquely-resolved local files — everything else is plain text', () => {
    // Design (chosen 2026-05-29 after follow-up review): the chip visual is
    // ONLY a confirmation that the path resolved to a single existing file
    // in workingDir. Unresolved / ambiguous / not-found / directory /
    // unsupported-scheme cases render as plain <span> or vanilla <code>, not
    // as a non-interactive chip. The chip is always interactive when shown.
    expect(markdownRenderer).toContain('FileTargetChip');
    expect(markdownRenderer).toContain("target.kind === 'resolved-local'");
    expect(markdownRenderer).toContain('shouldRenderCodeReferenceLabel');
    expect(markdownRenderer).toContain('isResolvedForTarget');
    expect(markdownRenderer).toMatch(/`\$\{baseName\}:\$\{line\}`/);
    // FileTargetChip is always interactive — no `interactive` prop, no
    // disabled / cursor-default branch. Chip = clickable, period.
    expect(markdownRenderer).toContain('cursor-pointer hover:bg-[var(--cmd-palette-item-hover)]');
    expect(markdownRenderer).not.toContain('cursor-default');
    expect(markdownRenderer).not.toContain('interactive: boolean');
    expect(markdownRenderer).not.toContain('interactive={interactive}');
    // Non-resolved local kinds fall through to plain text — assert MarkdownTargetLink
    // explicitly handles code-reference / local-candidate as <span>.
    expect(markdownRenderer).toContain(
      "if (target.kind === 'code-reference' || target.kind === 'local-candidate')",
    );
    // InlineCodeWithTarget only chips on resolved-local; everything else is a
    // vanilla <code>. The guard must use !== 'resolved-local'.
    expect(markdownRenderer).toContain("if (target.kind !== 'resolved-local')");
    // Old standalone MarkdownCodeReference / FilePathChip were merged into
    // FileTargetChip — keep them gone so we don't regress to two visuals.
    expect(markdownRenderer).not.toContain('function MarkdownCodeReference');
    expect(markdownRenderer).not.toContain('function FilePathChip');
  });

  it('renders the path chip as <code>, so copied messages survive an external paste', () => {
    // 复制一段聊天消息时 Chromium 把选区原样序列化进 text/html。`<button>` 是交互
    // 控件,不属于富文本内容模型:Slack / 飞书 / Notion / Word 按标签白名单解析
    // 粘贴内容,会把整个节点连同路径文字丢掉,只在原位留下一个断行——用户看到的
    // 就是"文件名凭空消失"。`<code>` 既是语义正解(这个 chip 本来就是行内代码
    // 升级来的),粘出去还会落成对方的行内代码。
    const chipBody = markdownRenderer.match(
      /function FileTargetChip\([\s\S]*?\r?\n}\r?\n/,
    )?.[0];
    expect(chipBody).toBeDefined();
    expect(chipBody).toContain('<code');
    expect(chipBody).not.toContain('<button');
    // 原生按钮语义靠 role/tabIndex/onKeyDown 补齐,不要退回 <button>。
    expect(chipBody).toContain('role="button"');
    expect(chipBody).toContain('tabIndex={0}');
    expect(chipBody).toContain('onKeyDown');
    // 同理:chip 文字必须能进剪贴板,不得 select-none。
    expect(chipBody).not.toContain('select-none');
  });

  it('resolves targets through the renderer cache so session switches do not re-flash', () => {
    // Eager render-time resolution (chip only when unique) re-fires the IPC and
    // re-flashes plain-text → chip on every session switch unless results are
    // remembered. The hook must read the synchronous cache first and resolve
    // misses through the de-duped cached wrapper — not call the raw resolver.
    expect(markdownRenderer).toContain('peekResolveLocalPathSmart');
    expect(markdownRenderer).toContain('resolveLocalPathSmartCached');
    expect(markdownRenderer).not.toContain('resolveLocalPathSmart(');
  });

  it('allows file:// through urlTransform so local file links can be classified safely', () => {
    expect(markdownRenderer).toContain("url.startsWith('file://')");
    expect(markdownRenderer).toContain('WINDOWS_ABSOLUTE_HREF_RE.test(url)');
  });

  it('passes already-rewritten remote media image URLs through normalization', () => {
    expect(markdownRenderer).toContain('remarkPreserveLocalImagePaths');
    expect(markdownRenderer).toContain('normalizeMarkdownImageSrc(');
    const normalizeBlock = localPathResolver.match(
      /export function normalizeMarkdownImageSrc[\s\S]*?return toLocalFileUrl/,
    );
    expect(normalizeBlock).not.toBeNull();
    expect(normalizeBlock![0]).toContain("src.startsWith('cindy-remote-media://')");
  });

  it('wraps long markdown link text instead of widening the message column', () => {
    expect(markdownRenderer).toContain('[overflow-wrap:anywhere]');
    expect(markdownRenderer).toContain('const MARKDOWN_LINK_CLASS');
    // 2 处:anchor 链接 + MarkdownTargetLink;xdt-maker://session/ 分支已升级为
    // SessionLinkChip(自带 chip 样式),不再计入。
    expect(markdownRenderer.match(/className=\{MARKDOWN_LINK_CLASS\}/g) ?? []).toHaveLength(2);
  });

  it('passes parsed line numbers into TextLightbox and TextLightbox scrolls on open', () => {
    expect(markdownRenderer).toContain('initialLine={textLightboxFile.line}');
    expect(textLightbox).toContain('initialLine?: number');
    expect(textLightbox).toContain('data-source-line');
    // Markdown anchor selection lives in a pure helper (unit-tested in
    // textLightboxLineScroll.test.ts); the effect wires it to DOM rect based scrolling.
    expect(textLightbox).toContain('pickSourceLineAnchor(entries, line)');
    expect(textLightbox).toContain(
      'scroller.scrollTop = targetRect.top - scrollerRect.top + scroller.scrollTop',
    );
  });
});
