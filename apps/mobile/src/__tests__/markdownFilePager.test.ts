import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_FILE_PAGER_SCRIPT, parseMarkdownPageSwipe } from '@/session/markdownFilePager';

function reader(formulaTag = 'DIV', formulaWidth = 1200) {
  const listeners = new Map<string, (event: unknown) => void>();
  const messages: string[] = [];
  const body = { nodeType: 1, parentElement: null };
  const paragraph = { nodeType: 1, tagName: 'P', parentElement: body };
  const formula = {
    nodeType: 1, tagName: formulaTag, parentElement: body,
    overflowX: 'auto', scrollWidth: formulaWidth, clientWidth: 380,
  };
  const formulaChild = { nodeType: 1, tagName: 'SPAN', parentElement: formula };
  let selected = false;
  const context = {
    window: {
      getSelection: () => ({ isCollapsed: !selected }),
      getComputedStyle: (element: { overflowX?: string }) => ({ overflowX: element.overflowX }),
      ReactNativeWebView: { postMessage: (message: string) => messages.push(message) },
    },
    document: {
      body,
      addEventListener: (type: string, listener: (event: unknown) => void, options: unknown) => {
        expect(options).toEqual({ passive: true });
        listeners.set(type, listener);
      },
    },
  };
  runInNewContext(MARKDOWN_FILE_PAGER_SCRIPT, context);
  function touch(type: string, x: number, y: number, time = 0, target: unknown = paragraph, count = 1) {
    const point = { identifier: 1, clientX: x, clientY: y };
    listeners.get(type)?.({
      target, timeStamp: time,
      touches: type === 'touchend' ? [] : Array.from({ length: count }, () => point),
      changedTouches: [point],
    });
  }
  return { messages, touch, formulaChild, paragraph, select: () => { selected = true; } };
}

describe('Markdown reader paging', () => {
  it.each([[-100, 'next'], [100, 'previous']])('pages after a deliberate %s px swipe', (dx, direction) => {
    const r = reader();
    r.touch('touchstart', 200, 100);
    r.touch('touchmove', 200 + Number(dx), 103, 150);
    expect(r.messages).toEqual([]);
    r.touch('touchend', 200 + Number(dx), 103, 200);
    expect(r.messages).toEqual([`markdown-page:${direction}`]);
  });

  it('lets vertical reading win permanently, even if the finger later moves horizontally', () => {
    const r = reader();
    r.touch('touchstart', 200, 300);
    r.touch('touchmove', 203, 285, 30);
    r.touch('touchmove', 80, 200, 200);
    r.touch('touchend', 80, 200, 250);
    expect(r.messages).toEqual([]);
  });

  it.each(['DIV', 'SPAN'])('keeps wide %s formula drags inside their scroll container, including at its edges', (tag) => {
    const r = reader(tag);
    for (const dx of [-200, 200]) {
      r.touch('touchstart', 200, 100, 0, r.formulaChild);
      r.touch('touchmove', 200 + dx, 100, 100, r.formulaChild);
      r.touch('touchend', 200 + dx, 100, 200, r.formulaChild);
    }
    expect(r.messages).toEqual([]);
    // A subsequent gesture in ordinary text can still page.
    r.touch('touchstart', 200, 300);
    r.touch('touchend', 80, 300, 200);
    expect(r.messages).toEqual(['markdown-page:next']);
  });

  it('allows paging over an inline formula that fits without horizontal overflow', () => {
    const r = reader('SPAN', 380);
    r.touch('touchstart', 200, 100, 0, r.formulaChild);
    r.touch('touchmove', 80, 100, 150, r.formulaChild);
    r.touch('touchend', 80, 100, 200, r.formulaChild);
    expect(r.messages).toEqual(['markdown-page:next']);
  });

  it('ignores slow short swipes but accepts a deliberate short flick', () => {
    const r = reader();
    r.touch('touchstart', 200, 100);
    r.touch('touchmove', 170, 100, 150);
    r.touch('touchend', 170, 100, 400);
    expect(r.messages).toEqual([]);
    r.touch('touchstart', 200, 100);
    r.touch('touchend', 170, 100, 40);
    expect(r.messages).toEqual(['markdown-page:next']);
  });

  it.each(['selection', 'long-press', 'multi-touch', 'cancel', 'link'])('does not page during %s', (kind) => {
    const r = reader();
    const target = kind === 'link' ? { nodeType: 1, tagName: 'A', parentElement: r.paragraph } : r.paragraph;
    r.touch('touchstart', 200, 100, 0, target);
    if (kind === 'selection') r.select();
    if (kind === 'multi-touch') r.touch('touchstart', 200, 100, 10, target, 2);
    if (kind === 'cancel') r.touch('touchcancel', 200, 100, 10);
    r.touch('touchmove', 80, 100, kind === 'long-press' ? 700 : 100, target);
    r.touch('touchend', 80, 100, 800, target);
    expect(r.messages).toEqual([]);
  });

  it('accepts only the two page messages at the host boundary', () => {
    expect(parseMarkdownPageSwipe('markdown-page:next')).toBe('next');
    expect(parseMarkdownPageSwipe('markdown-page:previous')).toBe('previous');
    for (const data of ['', '{}', 'markdown-page:other', 'markdown-page:next\n']) {
      expect(parseMarkdownPageSwipe(data)).toBeNull();
    }
  });
});
