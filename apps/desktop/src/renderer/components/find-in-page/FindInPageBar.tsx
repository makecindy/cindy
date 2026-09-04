import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { isFindInPageClaimed } from './findInPageOwnership';

const MATCH_HIGHLIGHT_NAME = 'cindy-find-in-page-match';
const ACTIVE_HIGHLIGHT_NAME = 'cindy-find-in-page-active';
const SEARCH_MATCH_BACKGROUND = 'hsl(var(--search-match-bg))';
const SEARCH_MATCH_FOREGROUND = 'hsl(var(--search-match-fg))';

interface TextMatch {
  range: Range;
}

function getHighlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') {
    return null;
  }
  return CSS.highlights;
}

function clearFindHighlights() {
  const registry = getHighlightRegistry();
  if (!registry) return;
  registry.delete(MATCH_HIGHLIGHT_NAME);
  registry.delete(ACTIVE_HIGHLIGHT_NAME);
}

function applyFindHighlights(ranges: readonly Range[], activeIndex: number) {
  const registry = getHighlightRegistry();
  if (!registry) return;

  registry.delete(MATCH_HIGHLIGHT_NAME);
  registry.delete(ACTIVE_HIGHLIGHT_NAME);
  if (ranges.length === 0) return;

  const matchHighlight = new Highlight();
  for (const range of ranges) matchHighlight.add(range);
  registry.set(MATCH_HIGHLIGHT_NAME, matchHighlight);
  const activeRange = ranges[activeIndex];
  if (activeRange) {
    const activeHighlight = new Highlight();
    activeHighlight.add(activeRange);
    registry.set(ACTIVE_HIGHLIGHT_NAME, activeHighlight);
  }
}

function findMatchOffsets(
  value: string,
  query: string,
  whiteSpace = 'normal',
): Array<[number, number]> {
  if (!value || !query) return [];

  const collapseWhitespace = ['normal', 'nowrap', 'pre-line'].includes(whiteSpace);
  const sourceStarts: number[] = [];
  const sourceEnds: number[] = [];
  let searchableValue = '';
  for (let index = 0; index < value.length; index += 1) {
    if (collapseWhitespace && /\s/.test(value[index])) {
      const runStart = index;
      while (index + 1 < value.length && /\s/.test(value[index + 1])) index += 1;
      const runEnd = index + 1;
      const hasSegmentBreak = /[\r\n\f]/.test(value.slice(runStart, runEnd));
      const previousCharacter = value[runStart - 1] ?? '';
      const nextCharacter = value[runEnd] ?? '';
      if (hasSegmentBreak && isCjkCharacter(previousCharacter) && isCjkCharacter(nextCharacter)) {
        continue;
      }
      if (searchableValue.at(-1) !== ' ') {
        searchableValue += ' ';
        sourceStarts.push(runStart);
        sourceEnds.push(runEnd);
      } else {
        sourceEnds[sourceEnds.length - 1] = runEnd;
      }
      continue;
    }
    searchableValue += value[index];
    sourceStarts.push(index);
    sourceEnds.push(index + 1);
  }

  const searchableQuery = collapseWhitespace ? query.replace(/\s+/g, ' ') : query;
  const normalizedQuery = searchableQuery.toLocaleLowerCase();
  const offsets: Array<[number, number]> = [];

  // Lower-case each candidate independently instead of normalizing the whole
  // text node first. Whole-string lower-casing is context-sensitive for some
  // scripts (for example Greek final sigma), which can make a standalone
  // query fail to match the same character in surrounding text.
  for (let start = 0; start <= searchableValue.length - searchableQuery.length; start += 1) {
    if (
      searchableValue.slice(start, start + searchableQuery.length).toLocaleLowerCase() ===
      normalizedQuery
    ) {
      const end = start + searchableQuery.length - 1;
      offsets.push([sourceStarts[start], sourceEnds[end]]);
      start += searchableQuery.length - 1;
    }
  }
  return offsets;
}

function isCjkCharacter(value: string): boolean {
  if (!value) return false;
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x2fff) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  );
}

function isExcludedTextNode(
  node: Text,
  excludedRoot: HTMLElement | null,
  visibilityCache: WeakMap<HTMLElement, boolean>,
): boolean {
  let element = node.parentElement;
  while (element) {
    if (element === excludedRoot) return true;
    const tagName = element.tagName.toLowerCase();
    if (
      tagName === 'script' ||
      tagName === 'style' ||
      tagName === 'noscript' ||
      tagName === 'template'
    ) {
      return true;
    }
    if (tagName === 'option') {
      const select = element.closest('select');
      const option = element as HTMLOptionElement;
      if (select && !select.multiple && select.size <= 1 && !option.selected) return true;
    }
    if (tagName === 'details' && !element.hasAttribute('open')) {
      const summary = Array.from(element.children).find(
        (child) => child.tagName.toLowerCase() === 'summary',
      );
      if (!summary || !summary.contains(node)) return true;
    }
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return true;
    const cachedHidden = visibilityCache.get(element);
    if (cachedHidden !== undefined) {
      if (cachedHidden) return true;
    } else {
      const style = window.getComputedStyle(element);
      const hiddenByStyle =
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0';
      visibilityCache.set(element, hiddenByStyle);
      if (hiddenByStyle) return true;
    }
    element = element.parentElement;
  }
  return false;
}

function collectTextMatches(query: string, excludedRoot: HTMLElement | null): TextMatch[] {
  if (!query) return [];

  const matches: TextMatch[] = [];
  const visibilityCache = new WeakMap<HTMLElement, boolean>();
  const showText = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
  const walker = document.createTreeWalker(document.body, showText);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (!isExcludedTextNode(textNode, excludedRoot, visibilityCache)) {
      const whiteSpace = textNode.parentElement
        ? window.getComputedStyle(textNode.parentElement).whiteSpace || 'normal'
        : 'normal';
      for (const [start, end] of findMatchOffsets(textNode.data, query, whiteSpace)) {
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        matches.push({ range });
      }
    }
    node = walker.nextNode();
  }
  return matches;
}

function isInsideRoot(node: Node, root: HTMLElement | null): boolean {
  return Boolean(root && (node === root || root.contains(node)));
}

function getRangeRect(range: Range): DOMRect | null {
  const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : [];
  const rect =
    rects[0] ??
    (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null);
  if (!rect) return null;
  if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.bottom === 0) return null;
  return rect;
}

function scrollRangeIntoView(range: Range) {
  const element = range.startContainer.parentElement;
  if (!element) return;

  let ancestor: HTMLElement | null = element;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    const canScrollY =
      /(auto|scroll|overlay|hidden)/.test(style.overflowY) &&
      ancestor.scrollHeight > ancestor.clientHeight;
    const canScrollX =
      /(auto|scroll|overlay|hidden)/.test(style.overflowX) &&
      ancestor.scrollWidth > ancestor.clientWidth;
    if (!canScrollY && !canScrollX) {
      ancestor = ancestor.parentElement;
      continue;
    }

    const rect = getRangeRect(range);
    const containerRect = ancestor.getBoundingClientRect();
    if (!rect) return;
    if (canScrollY) {
      if (rect.top < containerRect.top) ancestor.scrollTop -= containerRect.top - rect.top;
      else if (rect.bottom > containerRect.bottom)
        ancestor.scrollTop += rect.bottom - containerRect.bottom;
    }
    if (canScrollX) {
      if (rect.left < containerRect.left) ancestor.scrollLeft -= containerRect.left - rect.left;
      else if (rect.right > containerRect.right)
        ancestor.scrollLeft += rect.right - containerRect.right;
    }
    ancestor = ancestor.parentElement;
  }

  const rect = getRangeRect(range);
  if (!rect || typeof window.scrollBy !== 'function') return;
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  if (rect.top < 0 || rect.bottom > viewportHeight) {
    window.scrollBy({
      top: rect.top < 0 ? rect.top : rect.bottom - viewportHeight,
      behavior: 'auto',
    });
  }
  if (rect.left < 0 || rect.right > viewportWidth) {
    window.scrollBy({
      left: rect.left < 0 ? rect.left : rect.right - viewportWidth,
      behavior: 'auto',
    });
  }
}

/**
 * F-FIP-1 — Find in Page overlay (Ctrl/Cmd+F).
 *
 * Searches renderer text nodes directly, excluding this bar's subtree and
 * hidden/non-content nodes. Matches are painted with CSS Custom Highlight so
 * the query input stays a normal editable control throughout the search.
 * Enter / Shift+Enter and the arrow buttons walk the collected ranges.
 *
 * Search intentionally does not join text across element boundaries. That
 * keeps matching synchronous and avoids the native find-in-page focus and
 * font-metric races that made CJK/proportional-font input unreliable.
 */
export function FindInPageBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [matches, setMatches] = useState(0);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const activeRef = useRef(0);
  const isComposingRef = useRef(false);
  const compositionCommitRef = useRef<string | null>(null);

  const clearSearchResults = useCallback(() => {
    rangesRef.current = [];
    activeRef.current = 0;
    setMatches(0);
    setActive(0);
    clearFindHighlights();
  }, []);

  const scrollToMatch = useCallback((range: Range | undefined) => {
    if (!range) return;
    const element = range.startContainer.parentElement;
    if (!element || isInsideRoot(element, rootRef.current)) return;
    scrollRangeIntoView(range);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (range.startContainer.isConnected) scrollRangeIntoView(range);
      });
    }
  }, []);

  const applySearch = useCallback(
    (query: string, requestedActive = 0, shouldScroll = false) => {
      const nextRanges = collectTextMatches(query, rootRef.current).map(({ range }) => range);
      rangesRef.current = nextRanges;
      const nextActive = nextRanges.length
        ? ((requestedActive % nextRanges.length) + nextRanges.length) % nextRanges.length
        : 0;
      activeRef.current = nextActive;
      setMatches(nextRanges.length);
      setActive(nextActive);
      applyFindHighlights(nextRanges, nextActive);
      if (shouldScroll) scrollToMatch(nextRanges[nextActive]);
    },
    [scrollToMatch],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (text) applySearch(text, activeRef.current);
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      const nextActive = (activeRef.current + direction + ranges.length) % ranges.length;
      activeRef.current = nextActive;
      setActive(nextActive);
      applyFindHighlights(ranges, nextActive);
      scrollToMatch(ranges[nextActive]);
    },
    [applySearch, scrollToMatch, text],
  );

  const close = useCallback(() => {
    setOpen(false);
    setText('');
    isComposingRef.current = false;
    compositionCommitRef.current = null;
    clearSearchResults();
  }, [clearSearchResults]);

  useEffect(() => () => clearFindHighlights(), []);

  useEffect(() => {
    if (!open || !text) return;

    const refreshSearch = () => {
      if (isComposingRef.current) return;
      applySearch(text, activeRef.current);
    };
    const handleResize = () => refreshSearch();
    const handleChange = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) refreshSearch();
    };

    window.addEventListener('resize', handleResize);
    document.addEventListener('change', handleChange);
    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('change', handleChange);
    };
  }, [applySearch, open, text]);

  // Global find-in-page shortcut (registry 默认 Ctrl/Cmd+F, 用户可改绑) →
  // open + focus. Capture phase means editable page controls do not swallow
  // the chord before the global bar sees it.
  useAppShortcut('find-in-page', () => {
    // 局部接管者(如 doc 模式的 FileBodyView)存在时让位。
    if (isFindInPageClaimed()) return false;
    setOpen(true);
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return true;
  });

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className={cn(
        // Title bar is 46px tall — sit just below it so it never overlaps.
        'fixed right-4 top-[54px] z-50',
        'flex items-center gap-1',
        'rounded-lg border border-border',
        'bg-popover text-popover-foreground',
        'shadow-lg',
        'px-2 py-1.5',
        'min-w-[280px]',
        // mount-only 入场:Cmd+F 呼出时从右上角(标题栏方向)轻长出;
        // 关闭走 unmount 直接消失(查找栏关闭要"立即让路",不做 exit)。
        'origin-top-right animate-float-in',
      )}
      role="dialog"
      aria-label={t('findInPage.dialogAriaLabel')}
    >
      <style>{`
        ::highlight(${MATCH_HIGHLIGHT_NAME}) {
          background-color: ${SEARCH_MATCH_BACKGROUND};
          color: ${SEARCH_MATCH_FOREGROUND};
        }
        ::highlight(${ACTIVE_HIGHLIGHT_NAME}) {
          background-color: ${SEARCH_MATCH_BACKGROUND};
          color: ${SEARCH_MATCH_FOREGROUND};
          text-decoration: underline;
          text-decoration-color: ${SEARCH_MATCH_FOREGROUND};
          text-decoration-thickness: 2px;
        }
      `}</style>
      <div className="relative flex-1 min-w-0 overflow-hidden">
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={t('findInPage.placeholder')}
          autoComplete="off"
          value={text}
          placeholder={t('findInPage.placeholder')}
          onChange={(e) => {
            const next = e.target.value;
            const nativeIsComposing =
              'isComposing' in e.nativeEvent && e.nativeEvent.isComposing === true;
            setText(next);
            if (compositionCommitRef.current === next) {
              compositionCommitRef.current = null;
              return;
            }
            compositionCommitRef.current = null;
            if (isComposingRef.current || nativeIsComposing) return;
            applySearch(next, 0, true);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
            compositionCommitRef.current = null;
            clearSearchResults();
          }}
          onCompositionEnd={(e) => {
            const committed = e.currentTarget.value;
            isComposingRef.current = false;
            compositionCommitRef.current = committed;
            setText(committed);
            applySearch(committed, 0, true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (
              e.key === 'Enter' &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              moveActive(e.shiftKey ? -1 : 1);
            }
          }}
          className={cn(
            'w-full min-w-0',
            'bg-transparent outline-none',
            'text-sm',
            'placeholder:text-muted-foreground',
          )}
        />
      </div>
      <span
        className="text-xs tabular-nums text-muted-foreground select-none whitespace-nowrap px-1"
        aria-live="polite"
      >
        {text ? (matches > 0 ? `${active + 1}/${matches}` : '0/0') : ''}
      </span>
      <button
        type="button"
        aria-label={t('findInPage.previous')}
        disabled={!text}
        onClick={() => moveActive(-1)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded',
          'hover:bg-titlebar-button-hover',
          'disabled:opacity-40 disabled:hover:bg-transparent',
          'focus-visible:outline-none',
        )}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        aria-label={t('findInPage.next')}
        disabled={!text}
        onClick={() => moveActive(1)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded',
          'hover:bg-titlebar-button-hover',
          'disabled:opacity-40 disabled:hover:bg-transparent',
          'focus-visible:outline-none',
        )}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        aria-label={t('findInPage.close')}
        onClick={close}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded',
          'hover:bg-titlebar-button-hover',
          'focus-visible:outline-none',
        )}
      >
        <X size={14} />
      </button>
    </div>
  );
}
