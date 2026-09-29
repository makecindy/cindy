// @vitest-environment jsdom
/**
 * markdown 表格内的文件内搜索高亮。
 *
 * 背景:markdown 表格在 live preview 里是 `Decoration.replace({block: true,
 * widget})` —— widget 覆盖区间内的文本不再由 CodeMirror 渲染,落在同一区间
 * 的 `cm-doc-search-match` mark 装饰无处可显示。这些用例锁住"命中计数 =
 * 可见高亮"这条口径:单元格文字由 widget 补高亮,表格结构字符与图片 alt
 * 从命中里剔除。
 */
import { describe, expect, it } from 'vitest';
import { EditorState, type Text as CodeMirrorText } from '@codemirror/state';
import { EditorView, type DecorationSet, type WidgetType } from '@codemirror/view';
import { SearchCursor } from '@codemirror/search';

import {
  collectMarkdownTableHiddenRanges,
  markdownTableDecorationField,
} from '@/components/markdown/markdownTableLivePreview';
import { searchHighlightField } from '@/components/markdown/PlaintextEditor';
import {
  docSearchRangesField,
  filterVisibleDocSearchRanges,
  setDocSearchRangesEffect,
  type DocSearchRange,
} from '@/components/markdown/docSearchRanges';

const DOC = [
  'alpha outside table',
  '',
  '| Name | Status |',
  '| --- | --- |',
  '| alpha | ready |',
  '| beta | blocked |',
].join('\n');

/** TableWidget 是模块私有的,测试按结构取它暴露的两个成员。 */
interface TableWidgetLike extends WidgetType {
  highlights: DocSearchRange[];
  updateDOM: (dom: HTMLElement, view: EditorView, from: WidgetType) => boolean;
}

function docOf(doc = DOC): CodeMirrorText {
  return EditorState.create({ doc }).doc;
}

function findMatches(query: string, doc: CodeMirrorText): DocSearchRange[] {
  const cursor = new SearchCursor(doc, query, 0, doc.length, (s) => s.toLowerCase());
  const out: DocSearchRange[] = [];
  while (!cursor.next().done) {
    out.push({ from: cursor.value.from, to: cursor.value.to, active: false });
  }
  return out;
}

/** 复刻 PlaintextEditor.findAll 的可见性口径(表格结构字符 + 图片 alt)。 */
function visibleMatches(query: string, doc: CodeMirrorText = docOf()): DocSearchRange[] {
  return filterVisibleDocSearchRanges(
    findMatches(query, doc),
    collectMarkdownTableHiddenRanges(doc),
  );
}

function mountView(doc = DOC): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [docSearchRangesField, markdownTableDecorationField, searchHighlightField],
    }),
    parent: host,
  });
  view.requestMeasure();
  return view;
}

function readTableWidget(view: EditorView): { dom: HTMLElement; widget: TableWidgetLike } {
  const decorations = view.state.field(markdownTableDecorationField) as DecorationSet;
  let widget: TableWidgetLike | undefined;
  decorations.between(0, view.state.doc.length, (_from, _to, decoration) => {
    if (!widget) widget = decoration.spec.widget as TableWidgetLike;
  });
  if (!widget) throw new Error('expected exactly one markdown table widget');
  const dom = view.dom.querySelector('.cm-md-table-widget') as HTMLElement | null;
  if (!dom) throw new Error('expected .cm-md-table-widget in editor DOM');
  return { dom, widget };
}

function dispatchRanges(view: EditorView, ranges: DocSearchRange[]): void {
  view.dispatch({ effects: setDocSearchRangesEffect.of(ranges) });
  view.requestMeasure();
}

describe('markdown table hidden ranges (search visibility)', () => {
  it('excludes structural characters but keeps every cell text', () => {
    const doc = docOf();
    const hidden = collectMarkdownTableHiddenRanges(doc);
    const tableFrom = doc.line(3).from;
    const tableTo = doc.line(6).to;
    const isHidden = (from: number, to: number) =>
      hidden.some((span) => from < span.to && to > span.from);

    // 表格行起点是 "|",属于结构字符
    expect(isHidden(tableFrom, tableFrom + 1)).toBe(true);
    // 表头 / 单元格文字都算可见内容(在表格块内定位,不取文档开头的同名词)
    const tableStart = DOC.indexOf('| Name');
    for (const needle of ['Name', 'Status', 'alpha', 'ready', 'beta', 'blocked']) {
      const at = DOC.indexOf(needle, tableStart);
      expect(isHidden(at, at + needle.length)).toBe(false);
    }
    // 分隔行整行没有可见文字
    const separator = doc.line(4);
    expect(isHidden(separator.from, separator.to)).toBe(true);
    // hidden 区间不溢出表格块
    for (const span of hidden) {
      expect(span.from).toBeGreaterThanOrEqual(tableFrom);
      expect(span.to).toBeLessThanOrEqual(tableTo);
    }
  });

  it('drops separator matches from the hit count but keeps cell matches', () => {
    // "---" 只出现在分隔行,用户看不见 → 不计入命中
    expect(visibleMatches('---')).toEqual([]);
    // 表外的 alpha + 表格单元格里的 alpha 都保留
    expect(visibleMatches('alpha')).toHaveLength(2);
  });

  it('keeps every match when the document has no markdown table', () => {
    const doc = docOf('plain text without tables');
    expect(collectMarkdownTableHiddenRanges(doc)).toEqual([]);
    expect(visibleMatches('plain', doc)).toHaveLength(1);
  });
});

describe('markdown table widget search highlight', () => {
  it('highlights matches inside table cells, not just in the body text', () => {
    const view = mountView();
    const ranges = visibleMatches('alpha');
    expect(ranges).toHaveLength(2);
    dispatchRanges(view, ranges);

    const bodyMarks = view.dom.querySelectorAll('.cm-content > .cm-line .cm-doc-search-match');
    const widgetMarks = view.dom.querySelectorAll('.cm-md-table-widget .cm-doc-search-match');
    expect(bodyMarks).toHaveLength(1);
    expect(widgetMarks).toHaveLength(1);
    expect(widgetMarks[0].textContent).toBe('alpha');
    expect(widgetMarks[0].closest('td, th')?.getAttribute('data-source-text')).toBe('alpha');
    view.destroy();
  });

  it('keeps the active match distinguishable inside cells', () => {
    const view = mountView();
    const ranges = visibleMatches('alpha');
    dispatchRanges(
      view,
      ranges.map((range, index) => ({ ...range, active: index === 1 })),
    );

    const active = view.dom.querySelectorAll('.cm-md-table-widget .cm-doc-search-active');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toBe('alpha');
    view.destroy();
  });

  it('paints highlighted cell text that still serializes back to the source', () => {
    const view = mountView();
    dispatchRanges(view, visibleMatches('alpha'));

    const cell = view.dom.querySelector('.cm-md-table-widget td') as HTMLTableCellElement;
    expect(cell.textContent).toBe(cell.dataset.sourceText);
    view.destroy();
  });

  it('hands the widget the matches inside its own source range', () => {
    const view = mountView();
    const ranges = visibleMatches('alpha');
    dispatchRanges(view, ranges);

    const { widget } = readTableWidget(view);
    const doc = docOf();
    expect(widget.highlights).toHaveLength(1);
    expect(doc.sliceString(widget.highlights[0].from, widget.highlights[0].to)).toBe('alpha');
    expect(doc.lineAt(widget.highlights[0].from).number).toBe(5);
    view.destroy();
  });

  it('repaints in place when the query changes, without dropping cell DOM', () => {
    const view = mountView();
    dispatchRanges(view, visibleMatches('alpha'));
    const cell = view.dom.querySelector('.cm-md-table-widget td') as HTMLTableCellElement;

    // 同一个 table widget 只换了 hits:CodeMirror 走 updateDOM 原地更新,
    // 整表重建会打断正在编辑的单元格。
    dispatchRanges(view, visibleMatches('ready'));

    expect(view.dom.querySelector('.cm-md-table-widget td')).toBe(cell);
    expect(view.dom.querySelector('.cm-md-table-widget .cm-doc-search-match')?.textContent).toBe(
      'ready',
    );
    expect(cell.textContent).toBe('alpha');
    view.destroy();
  });

  it('leaves the cell being edited untouched so typing is not interrupted', () => {
    const view = mountView();
    dispatchRanges(view, visibleMatches('alpha'));
    const cell = view.dom.querySelector('.cm-md-table-widget td') as HTMLTableCellElement;

    // jsdom 不给 contentEditable 元素派发焦点,补一个 tabIndex 模拟“正在编辑”
    cell.tabIndex = -1;
    cell.focus();
    cell.textContent = 'alpha edited';
    dispatchRanges(view, visibleMatches('ready'));

    expect(cell.textContent).toBe('alpha edited');
    cell.blur();
    view.destroy();
  });
});
