// @vitest-environment jsdom
import React, { act, Fragment, useCallback, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownBlockContent } from '@/session/MarkdownBlockContent';
import { useMarkdownSessionLinkTitles } from '@/session/useMarkdownSessionLinkTitles';
import {
  groupMobileMarkdownSelectableBlocks,
  parseMobileMarkdownIncremental,
  type MobileMarkdownBlock,
  type MobileMarkdownParseResult,
  type MobileMarkdownTextRunGroupingOptions,
} from '@/session/messageMarkdown';

type RenderBlock = (block: MobileMarkdownBlock, leadingGap: boolean) => ReactNode;

// Host spans stand in for the native text spans. The production memo component
// and immutable incremental parser are real; this measures React work, not RN
// layout, native selection, or device frame rate.
const renderText: RenderBlock = (block, leadingGap) => {
  if (!('inlines' in block)) return <span>{block.type}</span>;
  return <>
    {leadingGap ? <span>{'\n\n'}</span> : null}
    {block.inlines.map((inline, index) => (
      <span key={index}>{'text' in inline ? inline.text : inline.alt}</span>
    ))}
  </>;
};

function Body({ parse, renderBlock, baseline = false, options }: {
  parse: MobileMarkdownParseResult;
  renderBlock: RenderBlock;
  baseline?: boolean;
  options?: MobileMarkdownTextRunGroupingOptions;
}) {
  return <>{groupMobileMarkdownSelectableBlocks(parse.blocks, options).map((group) => (
    <div key={group.key} data-text-run={group.type === 'text_run' ? '' : undefined}>
      {(group.type === 'text_run' ? group.blocks : [group.block]).map((block, index) => {
        const leadingGap = index > 0 && !('textRunContinuation' in block && block.textRunContinuation);
        return baseline
          // The previous renderer eagerly built every block's inline tree.
          ? <Fragment key={block.key}>{renderBlock(block, leadingGap)}</Fragment>
          : <MarkdownBlockContent key={block.key} block={block} leadingGap={leadingGap} renderBlock={renderBlock} />;
      })}
    </div>
  ))}</>;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
});

describe('streaming Markdown React block boundaries', () => {
  it('re-renders only the changing tail while retaining the text view and completed spans', () => {
    const prefix = Array.from({ length: 160 }, (_, n) => `Paragraph ${n} **bold** and \`code\` and *emphasis*.`).join('\n\n');
    const versions: MobileMarkdownParseResult[] = [];
    let parse = parseMobileMarkdownIncremental(`${prefix}\n\ntail`);
    for (let update = 0; update <= 30; update += 1) {
      parse = parseMobileMarkdownIncremental(`${prefix}\n\ntail ${'x'.repeat(update)}`, parse);
      versions.push(parse);
    }
    const measure = (baseline: boolean) => {
      const renderBlock = vi.fn(renderText);
      act(() => root.render(<Body parse={versions[0]} renderBlock={renderBlock} baseline={baseline} />));
      const run = host.firstElementChild;
      const firstSpan = run?.firstElementChild;
      renderBlock.mockClear();
      const started = performance.now();
      for (const version of versions.slice(1)) {
        act(() => root.render(<Body parse={version} renderBlock={renderBlock} baseline={baseline} />));
      }
      const durationMs = performance.now() - started;
      expect(host.firstElementChild).toBe(run);
      expect(run?.firstElementChild).toBe(firstSpan);
      expect(host.querySelectorAll('[data-text-run]')).toHaveLength(1);
      // Memo boundaries add no host wrappers inside the selectable text run.
      expect([...run!.children].every((child) => child.tagName === 'SPAN')).toBe(true);
      return { blocks: renderBlock.mock.calls.length, durationMs, text: host.textContent };
    };
    const before = measure(true);
    act(() => root.render(null));
    const after = measure(false);
    expect(before.blocks).toBe(161 * 30);
    expect(after.blocks).toBe(30);
    expect(after.text).toBe(before.text);
    console.info('[markdown-block-perf]', JSON.stringify({
      updates: 30, stableParagraphs: 160,
      before: { blocks: before.blocks, reactDomMs: before.durationMs },
      after: { blocks: after.blocks, reactDomMs: after.durationMs },
    }));
  }, 20_000);

  it('refreshes completed blocks when rendering context changes or a prefix is edited', () => {
    let parse = parseMobileMarkdownIncremental('first **bold**\n\nsecond');
    const firstRenderer = vi.fn(renderText);
    act(() => root.render(<Body parse={parse} renderBlock={firstRenderer} />));
    const updatedRenderer = vi.fn<RenderBlock>((block, gap) => <span data-new-context>{renderText(block, gap)}</span>);
    act(() => root.render(<Body parse={parse} renderBlock={updatedRenderer} />));
    expect(updatedRenderer).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[data-new-context]')).toHaveLength(2);

    parse = parseMobileMarkdownIncremental('changed **bold**\n\nsecond', parse);
    act(() => root.render(<Body parse={parse} renderBlock={updatedRenderer} />));
    expect(host.textContent).toBe('changed bold\n\nsecond');
    expect(host.textContent).not.toContain('first');
  });

  it('preserves Android run splitting, continuation gaps, and full text across appends', () => {
    const options = { maxTextRunBlocks: 2, maxTextRunUtf16Length: 48, maxTextRunInlineFragments: 8 };
    let parse = parseMobileMarkdownIncremental(`first\n\n${'long😀 text '.repeat(16)}\n\nlast`);
    const renderBlock = vi.fn(renderText);
    for (const suffix of ['', ' more', '\n\n```ts\nlet x = 1;\n```\n\nafter']) {
      parse = parseMobileMarkdownIncremental(`${parse.source}${suffix}`, parse);
      act(() => root.render(<Body parse={parse} renderBlock={renderBlock} options={options} baseline />));
      const expected = host.innerHTML;
      act(() => root.render(<Body parse={parse} renderBlock={renderBlock} options={options} />));
      expect(host.innerHTML).toBe(expected);
    }
  });

  it('reuses Android chunks of a completed oversized paragraph while appending to the tail', () => {
    const options = { maxTextRunUtf16Length: 48, maxTextRunInlineFragments: 8 };
    let parse = parseMobileMarkdownIncremental(`${'long😀 **bold** text '.repeat(80)}\n\ntail`);
    const renderBlock = vi.fn(renderText);
    act(() => root.render(<Body parse={parse} renderBlock={renderBlock} options={options} />));
    expect(renderBlock.mock.calls.length).toBeGreaterThan(20);
    const firstSpan = host.firstElementChild?.firstElementChild;
    renderBlock.mockClear();
    for (let n = 0; n < 10; n += 1) {
      parse = parseMobileMarkdownIncremental(`${parse.source}x`, parse);
      act(() => root.render(<Body parse={parse} renderBlock={renderBlock} options={options} />));
    }
    expect(renderBlock).toHaveBeenCalledTimes(10);
    expect(host.firstElementChild?.firstElementChild).toBe(firstSpan);
  });

  it('invalidates equal-text spans when link targets, formatting, or selection gaps change', () => {
    const renderBlock = vi.fn(renderText);
    let block: MobileMarkdownBlock = { type: 'paragraph', key: 'p', inlines: [{ type: 'link', text: 'link', url: 'https://a.test' }] };
    act(() => root.render(<MarkdownBlockContent block={block} renderBlock={renderBlock} />));
    block = { ...block, inlines: [{ type: 'link', text: 'link', url: 'https://b.test' }] };
    act(() => root.render(<MarkdownBlockContent block={block} renderBlock={renderBlock} />));
    block = { ...block, inlines: [{ type: 'strong', text: 'link' }] };
    act(() => root.render(<MarkdownBlockContent block={block} renderBlock={renderBlock} />));
    act(() => root.render(<MarkdownBlockContent block={block} renderBlock={renderBlock} leadingGap />));
    expect(renderBlock).toHaveBeenCalledTimes(4);
    expect(host.textContent).toBe('\n\nlink');
  });

  it('keeps deep-link render context stable until a referenced title actually changes', () => {
    const sessionId = '03e0c22d-19db-4ac5-814f-1ea04040b471';
    const linkedText = `[task](cindy://session/${sessionId})\n\ntail`;
    let parse = parseMobileMarkdownIncremental(linkedText);
    const renders = vi.fn();
    function LinkedBody({ document, sessions }: {
      document: MobileMarkdownParseResult;
      sessions: { id: string; title: string }[];
    }) {
      const titles = useMarkdownSessionLinkTitles(document.source, sessions);
      const renderBlock = useCallback<RenderBlock>((block, gap) => {
        renders();
        return <span data-title={titles?.[sessionId]}>{renderText(block, gap)}</span>;
      }, [titles]);
      return <Body parse={document} renderBlock={renderBlock} />;
    }
    const sessions = [{ id: sessionId, title: 'First title' }];
    act(() => root.render(<LinkedBody document={parse} sessions={sessions} />));
    renders.mockClear();
    for (let n = 0; n < 10; n += 1) {
      parse = parseMobileMarkdownIncremental(`${parse.source}x`, parse);
      act(() => root.render(<LinkedBody document={parse} sessions={[...sessions, { id: 'other', title: `Other ${n}` }]} />));
    }
    expect(renders).toHaveBeenCalledTimes(10);
    renders.mockClear();
    act(() => root.render(<LinkedBody document={parse} sessions={[{ id: sessionId, title: 'Renamed' }]} />));
    expect(renders).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[data-title="Renamed"]')).toHaveLength(2);
    act(() => root.render(<LinkedBody document={parse} sessions={[]} />));
    expect(host.querySelector('[data-title]')).toBeNull();
  });
});
