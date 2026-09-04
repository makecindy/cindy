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

function findMatchOffsets(value: string, query: string): Array<[number, number]> {
  if (!value || !query) return [];

  const normalizedValue = value.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const offsets: Array<[number, number]> = [];

  // Most scripts preserve code-unit length when lower-cased, so use the
  // normalized string for a fast scan. The fallback keeps Range offsets in
  // the original string when a case conversion changes length.
  if (normalizedValue.length === value.length && normalizedQuery.length === query.length) {
    let start = normalizedValue.indexOf(normalizedQuery);
    while (start !== -1) {
      offsets.push([start, start + query.length]);
      start = normalizedValue.indexOf(normalizedQuery, start + query.length);
    }
    return offsets;
  }

  for (let start = 0; start <= value.length - query.length; start += 1) {
    if (value.slice(start, start + query.length).toLocaleLowerCase() === normalizedQuery) {
      offsets.push([start, start + query.length]);
      start += query.length - 1;
    }
  }
  return offsets;
}

function isExcludedTextNode(
  node: Text,
  excludedRoot: HTMLElement | null,
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
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) return true;
    element = element.parentElement;
  }
  return false;
}

function collectTextMatches(query: string, excludedRoot: HTMLElement | null): TextMatch[] {
  if (!query) return [];

  const matches: TextMatch[] = [];
  const showText = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
  const walker = document.createTreeWalker(document.body, showText);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (!isExcludedTextNode(textNode, excludedRoot)) {
      for (const [start, end] of findMatchOffsets(textNode.data, query)) {
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
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      const nextActive = (activeRef.current + direction + ranges.length) % ranges.length;
      activeRef.current = nextActive;
      setActive(nextActive);
      applyFindHighlights(ranges, nextActive);
      scrollToMatch(ranges[nextActive]);
    },
    [scrollToMatch],
  );

  const close = useCallback(() => {
    setOpen(false);
    setText('');
    isComposingRef.current = false;
    clearSearchResults();
  }, [clearSearchResults]);

  useEffect(() => () => clearFindHighlights(), []);

  useEffect(() => {
    if (!open || !text) return;

    const refreshSearch = () => {
      applySearch(text, activeRef.current);
    };
    const handleResize = () => refreshSearch();
    const handleChange = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) refreshSearch();
    };

    window.addEventListener('resize', handleResize);
    document.addEventListener('change', handleChange, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('change', handleChange, true);
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
            if (isComposingRef.current || nativeIsComposing) return;
            applySearch(next, 0, true);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
            clearSearchResults();
          }}
          onCompositionEnd={(e) => {
            const committed = e.currentTarget.value;
            isComposingRef.current = false;
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
        disabled={!text || matches === 0}
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
        disabled={!text || matches === 0}
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
