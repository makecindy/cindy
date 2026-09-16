// @vitest-environment jsdom
//
// 回归:审查面板虚拟文件列表在异步预览落地后整列压叠。
//
// 触发链(修复前):MarkdownDiffPreview 富文本预览落地 → onPreviewSettled →
// DiffList.handleImagePreviewLoad → fileVirtualizer.measure()。measure() 清空的是
// **全部**已测行高,而 @tanstack/virtual-core 的 _flatMeasurements 仍留旧值,使紧随其后的
// measureElement 判定 delta===0 不回填;尺寸未变的行既不会收到新的 ResizeObserver entry,
// ref 也不会重挂 —— 列表于是永久停在 estimateSize(此处全展开,360),每张文件卡片都压在
// 前一张卡片正文上。滚动多少次都不恢复,与实机现象一致。
//
// jsdom 没有布局引擎,这里用受控的 offsetHeight / ResizeObserver 桩模拟真实卡片高度,
// 断言行 wrapper 的 translateY 必须等于前面各卡片真实高度之和(即不重叠)。
// MarkdownDiffPreview 被替换为「落地后触发一次 onPreviewSettled」的最小替身,只保留
// 本回归关心的契约;真实组件在 loaded 分支用 rAF 触发同一个回调。

import { createElement, useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileDiff, Hunk } from '@/lib/gitReview.types';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key} ${options.count}`,
  }),
}));

vi.mock('../DiffViewer/MarkdownDiffPreview', () => ({
  MarkdownDiffPreview: ({ onPreviewSettled }: { onPreviewSettled?: () => void }) => {
    useEffect(() => {
      const frame = requestAnimationFrame(() => onPreviewSettled?.());
      return () => cancelAnimationFrame(frame);
    }, [onPreviewSettled]);
    return createElement('div', { 'data-review-markdown-preview': 'true' });
  },
}));

import { DiffList } from '../ReviewTabBody';

const ROW_LINES = 60;
const VIEWPORT_HEIGHT = 800;

/** 每张卡片在真实布局里的高度(jsdom 里由 offsetHeight 桩提供)。 */
const CARD_HEIGHTS: Record<string, number> = {
  'unstaged:AGENTS.md': 520,
  'unstaged:first.ts': 300,
  'unstaged:second.ts': 640,
  'unstaged:third.ts': 280,
};
const EXPECTED_STARTS = [0, 520, 820, 1460];
// 折叠/展开两档 estimateSize 为 45 / 360,行高测量一旦丢失就会退回这一组位置。
const BASE_CARD_HEIGHTS = { ...CARD_HEIGHTS };

function hunkOfContextLines(index: number, count: number): Hunk {
  const lines = Array.from({ length: count }, (_, i) => ({
    index: i,
    type: 'context' as const,
    content: `line ${i}`,
    oldLineNumber: i + 1,
    newLineNumber: i + 1,
    originalLineNumber: i + 1,
    selectable: false,
    noTrailingNewLine: false,
    raw: ` line ${i}`,
  }));
  return {
    index,
    header: `@@ -1,${count} +1,${count} @@`,
    oldStart: 1,
    oldLines: count,
    newStart: 1,
    newLines: count,
    section: '',
    lines,
    selectableLines: [],
    raw: '',
  };
}

function makeDiff(path: string): FileDiff {
  const hunk = hunkOfContextLines(0, ROW_LINES);
  return {
    id: `unstaged:${path}`,
    source: 'unstaged',
    path,
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: null,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [hunk],
    error: null,
  };
}

const DIFFS: FileDiff[] = [
  makeDiff('AGENTS.md'),
  makeDiff('first.ts'),
  makeDiff('second.ts'),
  makeDiff('third.ts'),
];

let pendingObservations: { target: Element; callback: ResizeObserverCallback }[] = [];
/** 真实 ResizeObserver 会持续观察,这里保留已观察目标以便模拟「尺寸变化」。 */
const observedTargets = new Map<Element, ResizeObserverCallback>();

class StubResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    observedTargets.set(target, this.callback);
    pendingObservations.push({ target, callback: this.callback });
  }
  unobserve(target: Element) {
    observedTargets.delete(target);
  }
  disconnect() {}
}

/** 按真实 ResizeObserver 的语义投递一次观测:只在 observe 后补发一次当前尺寸。 */
function flushObservations() {
  let rounds = 0;
  while (pendingObservations.length > 0 && rounds < 20) {
    const pending = pendingObservations;
    pendingObservations = [];
    for (const { target, callback } of pending) {
      callback([{ target } as ResizeObserverEntry], {} as ResizeObserver);
    }
    rounds += 1;
  }
}

/** 模拟已观察元素尺寸发生变化:浏览器再投递一次 entry。 */
function redeliverObservedSizes() {
  for (const [target, callback] of observedTargets) {
    if (!target.isConnected) continue;
    callback([{ target } as ResizeObserverEntry], {} as ResizeObserver);
  }
}

let originalOffsetHeight: PropertyDescriptor | undefined;
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;

beforeEach(() => {
  Object.assign(CARD_HEIGHTS, BASE_CARD_HEIGHTS);
  pendingObservations = [];
  observedTargets.clear();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;

  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute('data-virtualized-file-list') !== null) return VIEWPORT_HEIGHT;
      const fileId = this.querySelector('[data-review-file-id]')?.getAttribute('data-review-file-id');
      if (fileId) return CARD_HEIGHTS[fileId] ?? 0;
      return 0;
    },
  });

  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 300,
      bottom: VIEWPORT_HEIGHT,
      width: 300,
      height: VIEWPORT_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  }
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function rowStarts(container: HTMLElement): number[] {
  // 只取文件行 wrapper(top-level virtual row),排除卡片内部 diff 行。
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-virtualized-file-list] > div > [data-index]'),
  );
  return rows.map((row) => {
    const match = /translateY\((-?[\d.]+)px\)/.exec(row.style.transform);
    if (!match) throw new Error(`row wrapper missing translateY: "${row.style.transform}"`);
    return Math.round(Number(match[1]));
  });
}

function renderDiffList() {
  return render(
    createElement(DiffList, {
      diffs: DIFFS,
      expandedSet: new Set(DIFFS.map((diff) => diff.id)),
      onToggleDiff: () => {},
      onRefresh: () => {},
      refreshPending: false,
      viewMode: 'unified',
      onViewModeChange: () => {},
      richMarkdownPreview: true,
      onRichMarkdownPreviewChange: () => {},
      wordWrap: false,
      wordDiff: false,
      fileTreeVisible: false,
      jumpRequest: null,
      loadImagePreview: async () => {
        throw new Error('not used');
      },
      loadMarkdownPreview: async (diff) => ({
        diffId: diff.id,
        content: '# preview',
        size: 9,
        baseDir: null,
        maxBytes: 1024,
        reason: null,
        error: null,
      }),
    }),
  );
}

async function flushAsyncWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe('ReviewTabBody virtualized file list layout', () => {
  it('keeps measured card heights when an async markdown preview settles', async () => {
    const { container } = renderDiffList();

    await act(async () => {
      container
        .querySelector('[data-virtualized-file-list]')!
        .dispatchEvent(new Event('scroll'));
      flushObservations();
    });

    // 前提:列表已进入虚拟分支,且首次测量已落地。
    expect(container.querySelector('[data-virtualized-file-list]')).toBeTruthy();
    expect(rowStarts(container)).toEqual(EXPECTED_STARTS);

    // 富文本预览落地 —— 修复前这里会触发 fileVirtualizer.measure(),把整列打回 estimate。
    await flushAsyncWork();
    expect(container.querySelector('[data-review-markdown-preview="true"]')).toBeTruthy();

    // 每张卡片都从上一张卡片真实高度之后开始 —— 卡片之间不重叠。
    expect(rowStarts(container)).toEqual(EXPECTED_STARTS);
  });

  // 修复的前提是「卡片高度变化由 item wrapper 的 ResizeObserver 兜住」。这是异步内容
  // (Markdown 富文本、图片)落地后布局仍然正确的**唯一**机制,必须单独钉住:一旦这条
  // 路断掉,就不能再靠 measure() 去补,而只能重新设计高度同步方式。
  it('re-measures a card through the resize observer when async content grows it', async () => {
    const { container } = renderDiffList();

    await act(async () => {
      container.querySelector('[data-virtualized-file-list]')!.dispatchEvent(new Event('scroll'));
      flushObservations();
    });
    expect(rowStarts(container)).toEqual(EXPECTED_STARTS);

    // 第一张 Markdown 卡片富文本落地后变高 520 → 900。后续卡片整体下移:
    // 变高前是 [0, 520, 820],变高后是 [0, 900, 1200](卡片变高后视口内行数减少)。
    await act(async () => {
      CARD_HEIGHTS['unstaged:AGENTS.md'] = 900;
      redeliverObservedSizes();
    });
    expect(rowStarts(container)).toEqual([0, 900, 1200]);
  });
});
