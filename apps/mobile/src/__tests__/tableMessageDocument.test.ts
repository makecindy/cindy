// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TableMessageDocument as TableView, TableDocumentRowContext, useTableDocumentList } from '@/session/TableMessageDocument';
import { RichContentContext } from '@/session/richContentContext';
import { RichContentRuntime } from '@/session/richContentRuntime';
import { SelectionQuoteContext } from '@/session/selectionQuote';
import { parseMobileMarkdown } from '@/session/messageMarkdown';
import { buildMessageContentLayout } from '@/session/messageContentLayout';
import { buildTableMessageContent, parseTableMessageObservation, supportsTableMessageDocument,
  TABLE_MESSAGE_SHELL, tableMessageUpdateScript, type TableMessageDocument } from '@/session/tableMessageHtml';

const native = vi.hoisted(() => ({ props: null as any, layout: null as any, height: 0, live: 0,
  fontScale: 1, inject: vi.fn(), open: vi.fn(), pin: vi.fn(), quote: vi.fn(), side: vi.fn() }));
vi.mock('react-native', () => ({
  View: (props: any) => {
    if (props.testID === 'message.tableTextDocument') {
      native.layout = props.onLayout; native.height = props.style.height;
    }
    return props.children;
  }, StyleSheet: { hairlineWidth: 1 },
}));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return { WebView: forwardRef((props: any, ref) => {
  native.props = props;
  useImperativeHandle(ref, () => ({ injectJavaScript: native.inject }));
  useEffect(() => { native.live++; return () => { native.live--; }; }, []);
  return null;
}) }; });
vi.mock('@/theme', async () => {
  const { lightColors, lineHeight } = await import('@/theme/tokens');
  return { useTheme: () => ({ colors: lightColors }), lineHeight };
});
vi.mock('@/components/AppText', () => ({ MAX_FONT_SIZE_MULTIPLIER: 1.2 }));
vi.mock('@/platform/windowDimension', () => ({ useWindowFontScale: () => native.fontScale }));
vi.mock('@/session/MarkdownBlockCopyButton', () => ({ MarkdownBlockCopyButton: () => null }));
vi.mock('@/session/MailLinkSpan', () => ({ useOpenMailLink: () => native.open }));
vi.mock('@/session/ChatPathChipSpan', () => ({ useChatPathInteraction: () => ({ lit: true, onPress: native.open }) }));
vi.mock('@/session/SettingsLinkSpan', () => ({ useOpenSettingsLink: () => native.open }));
vi.mock('@/session/useMarkdownSessionLink', () => ({ useMarkdownSessionLink: () => ({ text: '任务', onPress: native.open }) }));
vi.mock('@/session/useMarkdownSessionLinkTitles', () => ({ useMarkdownSessionLinkTitles: () => ({}) }));
vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Test value: production HTML/bridge entry protects full table text and rejects
// stale document results. Existing file-reader tests have no message revisions,
// native copy slots or link-id dispatch. Minimal failure: a two-row table with
// an empty cell followed by an old document height/link event. Tier: unit,
// Isolated file wall clock: 2.43s (2026-11-18).
// in-memory DOM only; this never substitutes for real Android handle acceptance.
const markdown = '表前 中文 空格 🙂\n\n| A | B | C |\n|---|---|---|\n| 甲 | | 右端 |\n| 乙 | 两 个 | 末列 |\n\n表后 终点';
const layout = buildMessageContentLayout({ screenWidth: 390 });
const build = (text = markdown) => buildTableMessageContent(parseMobileMarkdown(text),
  { width: 340, layout, copyEnabled: true, streaming: false });

describe('table message production content', () => {
  it('keeps before/table/after and empty cells; native copy text contains no controls', () => {
    const result = build(); const root = document.createElement('div'); root.innerHTML = result.html;
    expect(root.firstElementChild?.textContent).toBe('表前 中文 空格 🙂');
    expect(root.lastElementChild?.textContent).toBe('表后 终点');
    expect([...root.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent)))
      .toEqual([['甲', '', '右端'], ['乙', '两 个', '末列']]);
    expect(result.copies).toEqual([{ id: '0', kind: 'table', text: 'A\tB\tC\n甲\t\t右端\n乙\t两 个\t末列' }]);
    expect(root.querySelector('[data-copy-slot]')?.textContent).toBe('');
    expect(root.querySelector('button')).toBeNull();
  });
  it('retains the native full grid when an authored row omits its last cell', () => {
    const result = build('| A | B | C |\n|---|---|---|\n| 短行 | 内容 |\n| 正常 | 两 个 | 末列 |');
    const root = document.createElement('div'); root.innerHTML = result.html;
    const rows = [...root.querySelectorAll('tr')];
    expect(rows.map(row => row.children.length)).toEqual([3, 3, 3]);
    expect(rows[1].lastElementChild?.textContent).toBe('');
    expect([...rows[2].children].map(cell => (cell as HTMLElement).style.width))
      .toEqual([...rows[0].children].map(cell => (cell as HTMLElement).style.width));
  });
  it('routes authored links and code paths by parser id without putting URLs into navigation', () => {
    const result = build('[外链](https://example.test/?q=secret) 和 [规则](/repo/AGENTS.md:2) 与 `src/a.ts`');
    const root = document.createElement('div'); root.innerHTML = result.html;
    expect(result.links.map(link => link.id)).toEqual(['0', '1', '2']);
    expect(root.querySelectorAll('[data-chat-link]')).toHaveLength(3);
    expect(root.querySelector('[href]')).toBeNull();
    expect(root.textContent).toBe('外链 和 规则 与 src/a.ts');
    expect(result.html).not.toContain('q=secret');
  });
  it('escapes author markup and preserves the original code payload for the native button', () => {
    const code = '<script>window.pwned=true</script>\n`中文`';
    const result = build('```js\n' + code + '\n```');
    const root = document.createElement('div'); root.innerHTML = result.html;
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('pre')?.textContent).toBe(code);
    expect(result.copies).toEqual([{ id: '0', kind: 'code', text: code }]);
    expect(supportsTableMessageDocument(parseMobileMarkdown(markdown))).toBe(true);
    for (const rich of ['![image](https://example.test/x.png)', '$$\nx^2\n$$', '```mermaid\ngraph TD;A-->B\n```']) {
      expect(supportsTableMessageDocument(parseMobileMarkdown(rich))).toBe(false);
    }
  });
});

describe('bounded message document protocol', () => {
  it('rejects stale callbacks, invalid height/slots and arbitrary action payloads', () => {
    const read = (value: unknown) => parseTableMessageObservation(JSON.stringify(value), 'current', 10000);
    expect(read({ kind: 'height', revision: 'old', height: 10, width: 340, slots: [] })).toBeNull();
    expect(read({ kind: 'link', revision: 'old', id: '0', action: 'open' })).toBeNull();
    expect(read({ kind: 'link', revision: 'current', id: 'https://attacker', action: 'open' })).toBeNull();
    expect(read({ kind: 'clipboard', revision: 'current', text: 'injected' })).toBeNull();
    for (const height of [0, -1, 10001, null]) {
      expect(read({ kind: 'height', revision: 'current', height, width: 340, slots: [] })).toBeNull();
    }
    expect(read({ kind: 'height', revision: 'current', height: 100, width: 340,
      slots: [{ id: '0', top: 101, height: 20 }] })).toBeNull();
    expect(read({ kind: 'height', revision: 'current', height: 100, width: 340, slots: [] }))
      .toEqual({ kind: 'height', revision: 'current', height: 100, width: 340, slots: [] });
  });
});

describe('trusted shell updates', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = new DOMParser().parseFromString(TABLE_MESSAGE_SHELL, 'text/html').documentElement.innerHTML;
    Object.assign(window, { ResizeObserver: class { observe() {} disconnect() {} },
      ReactNativeWebView: { postMessage: vi.fn() }, requestAnimationFrame: (run: () => void) => { run(); return 1; } });
    for (const script of document.querySelectorAll('script')) window.eval(script.textContent ?? '');
  });
  it('preserves an existing selected text node during style/link updates and treats author JS as data', () => {
    const result = build('[中文 空格](https://example.test)\n\n' + markdown);
    const payload: TableMessageDocument = { revision: '1', css: '', html: result.html, selectable: true,
      links: { '0': { text: '中文 空格', lit: true } } };
    window.eval(tableMessageUpdateScript(payload));
    const el = document.querySelector('[data-chat-link]')!; const node = el.firstChild!;
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    window.eval(tableMessageUpdateScript({ ...payload, revision: '2', css: 'body{font-size:19px}' }));
    expect(el.firstChild).toBe(node);
    expect(String(window.getSelection())).toBe('中文 空格');
    window.eval(tableMessageUpdateScript({ ...payload, revision: '3', links: {
      '0': { text: '</span><script>window.pwned=true</script>', lit: true },
    } }));
    expect(el.textContent).toBe('</span><script>window.pwned=true</script>');
    expect((window as any).pwned).toBeUndefined();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const messages = (window as any).ReactNativeWebView.postMessage.mock.calls.map(([value]: [string]) => JSON.parse(value));
    expect(messages.at(-1)).toEqual({ kind: 'link', revision: '3', id: '0', action: 'open' });
  });
});

// React lifecycle coverage: unlike the pure HTML checks above, these exercise
// first/revised link registration, recycled late height/quote callbacks, and
// the existing admission/selection pin. Minimal failure: one link + one table,
// then a body revision or viewport exit. In-memory unit, no device substitution.

describe('actual message carrier lifecycle', () => {
  let root: Root, runtime: RichContentRuntime;
  const source = '[外链](https://example.test)\n\n' + markdown;
  const context = { commitQuote: native.quote, askInSideChat: native.side };
  beforeEach(() => {
    vi.useFakeTimers(); native.fontScale = 1;
    native.inject.mockClear(); native.open.mockClear(); native.pin.mockClear(); native.quote.mockClear();
    runtime = new RichContentRuntime(); root = createRoot(document.createElement('div'));
  });
  afterEach(() => { act(() => root.unmount()); runtime.clear(); vi.useRealTimers(); });
  const draw = (text = source, visible = true) => {
    act(() => root.render(createElement(RichContentContext.Provider, { value: runtime },
      createElement(TableDocumentRowContext.Provider, { value: { key: 'row', visible, pin: native.pin } },
        createElement(SelectionQuoteContext.Provider, { value: context },
          createElement(TableView, { text, blocks: parseMobileMarkdown(text), layout,
            documentKey: 'one-message', selectable: true, initialHeight: 120 }))))));
    act(() => native.layout({ nativeEvent: { layout: { width: 360 } } }));
    act(() => vi.advanceTimersByTime(250));
  };
  const payload = () => {
    const script = native.inject.mock.calls.at(-1)![0] as string;
    return JSON.parse(script.slice(script.indexOf('?.(') + 3, -7)) as TableMessageDocument;
  };
  const load = () => { act(() => native.props.onLoadEnd()); return payload(); };
  const send = (value: unknown, props = native.props) => act(() => props.onMessage({ nativeEvent: { data: JSON.stringify(value) } }));
  it('registers first/revised link actions, rejects stale height and quote, and applies the AppText font cap', () => {
    draw(); let current = load();
    expect(current.links['0']).toMatchObject({ text: '外链', lit: true });
    send({ kind: 'link', revision: current.revision, id: '0', action: 'open' });
    expect(native.open).toHaveBeenCalledTimes(1);
    const old = native.props, oldRevision = current.revision, oldKey = old.menuItems[0].key;
    send({ kind: 'height', revision: current.revision, height: 420, width: 360.76, slots: [] });
    expect(native.height).toBe(420);
    draw(source + '\n\n修订'); current = load();
    expect(current.links['0'].lit).toBe(true);
    send({ kind: 'height', revision: oldRevision, height: 999, width: 360, slots: [] }, old);
    expect(native.height).not.toBe(999);
    act(() => old.onCustomMenuSelection({ nativeEvent: { key: oldKey, selectedText: '旧正文' } }));
    expect(native.quote).not.toHaveBeenCalled();
    act(() => native.props.onCustomMenuSelection({ nativeEvent: { key: native.props.menuItems[0].key, selectedText: '中文 🙂' } }));
    expect(native.quote).toHaveBeenCalledWith('中文 🙂');
    native.fontScale = 1.6; draw(source + '\n\n修订'); current = payload();
    expect(native.props.textZoom).toBe(100);
    const style = document.createElement('style'); style.textContent = current.css; document.head.append(style);
    expect(getComputedStyle(document.body).fontSize).toBe('20.4px');
    style.remove();
    send({ kind: 'height', revision: oldRevision, height: 800, width: 360, slots: [] });
    expect(native.height).not.toBe(800);
  });
  it('keeps the new carrier pinned when an old carrier in the same message releases its range', () => {
    let list!: ReturnType<typeof useTableDocumentList>;
    function Probe() { list = useTableDocumentList(runtime); return null; }
    act(() => root.render(createElement(Probe)));
    act(() => list.context.pin('row', true, 'first'));
    act(() => list.context.pin('row', true, 'second'));
    act(() => list.context.pin('row', false, 'first'));
    expect(list.alwaysRender?.keys).toEqual(['row']);
    act(() => list.context.pin('row', false, 'second'));
    expect(list.alwaysRender).toBeUndefined();
  });
  it('retains the selected document outside the viewport, then releases and restores its measured height', () => {
    draw(); const first = load();
    send({ kind: 'height', revision: first.revision, height: 430, width: 360, slots: [] });
    send({ kind: 'selection', revision: first.revision, active: true });
    draw(source, false);
    expect(native.live).toBe(1); expect(native.pin).toHaveBeenLastCalledWith('row', true, expect.any(String));
    send({ kind: 'selection', revision: payload().revision, active: false });
    expect(native.live).toBe(0);
    draw(); load(); expect(native.live).toBe(1); expect(native.height).toBe(430);
  });
});
