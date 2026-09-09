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
const SEARCH_REFRESH_DEBOUNCE_MS = 120;

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

function applyFindHighlights(matches: readonly TextMatch[], activeIndex: number) {
  const registry = getHighlightRegistry();
  if (!registry) return;

  registry.delete(MATCH_HIGHLIGHT_NAME);
  registry.delete(ACTIVE_HIGHLIGHT_NAME);
  if (matches.length === 0) return;

  const matchHighlight = new Highlight();
  for (const match of matches) matchHighlight.add(match.range);
  registry.set(MATCH_HIGHLIGHT_NAME, matchHighlight);
  const activeMatch = matches[activeIndex];
  if (activeMatch) {
    const activeHighlight = new Highlight();
    activeHighlight.add(activeMatch.range);
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
      const previousCharacter = getCodePointBefore(value, runStart);
      const nextCharacter = getCodePointAt(value, runEnd);
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
  const normalizedQuery = unicodeCaseFold(searchableQuery.normalize('NFC'));
  const offsets: Array<[number, number]> = [];

  const foldedValue = foldSearchValue(
    normalizeSearchValue(searchableValue, sourceStarts, sourceEnds),
  );
  let start = 0;
  while (start <= foldedValue.value.length - normalizedQuery.length) {
    const matchStart = foldedValue.value.indexOf(normalizedQuery, start);
    if (matchStart < 0) break;
    const matchEnd = matchStart + normalizedQuery.length - 1;
    offsets.push([foldedValue.starts[matchStart], foldedValue.ends[matchEnd]]);
    start = matchStart + normalizedQuery.length;
  }
  return offsets;
}

function unicodeCaseFold(value: string): string {
  // Keep case-insensitive matching locale-independent without maintaining a
  // second Unicode full-fold table. Final sigma is the one contextual form
  // that JavaScript lower-casing does not make equivalent in both directions.
  return value.toLowerCase().replace(/\u03c2/g, '\u03c3');
}

function normalizeSearchValue(
  value: string,
  sourceStarts: readonly number[],
  sourceEnds: readonly number[],
): { value: string; starts: number[]; ends: number[] } {
  const characters: Array<{ value: string; start: number; end: number }> = [];
  for (let index = 0; index < value.length; ) {
    const character = getCodePointAt(value, index);
    const end = index + character.length;
    characters.push({
      value: character,
      start: sourceStarts[index],
      end: sourceEnds[end - 1],
    });
    index = end;
  }

  let normalizedValue = '';
  const normalizedStarts: number[] = [];
  const normalizedEnds: number[] = [];
  for (let index = 0; index < characters.length; ) {
    let end = index + 1;
    if (
      isHangulLeadingJamo(characters[index].value) &&
      isHangulVowelJamo(characters[end]?.value)
    ) {
      end += 1;
      if (isHangulTrailingJamo(characters[end]?.value)) end += 1;
    } else if (
      isHangulLvSyllable(characters[index].value) &&
      isHangulTrailingJamo(characters[end]?.value)
    ) {
      end += 1;
    }
    while (end < characters.length && isCombiningMark(characters[end].value)) end += 1;

    const normalizedChunk = characters
      .slice(index, end)
      .map((character) => character.value)
      .join('')
      .normalize('NFC');
    const sourceStart = characters[index].start;
    const sourceEnd = characters[end - 1].end;
    normalizedValue += normalizedChunk;
    for (let offset = 0; offset < normalizedChunk.length; offset += 1) {
      normalizedStarts.push(sourceStart);
      normalizedEnds.push(sourceEnd);
    }
    index = end;
  }

  return { value: normalizedValue, starts: normalizedStarts, ends: normalizedEnds };
}

function isCombiningMark(value: string): boolean {
  return /^\p{M}$/u.test(value);
}

function getCodePoint(value: string | undefined): number | undefined {
  return value?.codePointAt(0);
}

function isHangulLeadingJamo(value: string | undefined): boolean {
  const codePoint = getCodePoint(value);
  if (codePoint === undefined) return false;
  return codePoint >= 0x1100 && codePoint <= 0x1112;
}

function isHangulVowelJamo(value: string | undefined): boolean {
  const codePoint = getCodePoint(value);
  if (codePoint === undefined) return false;
  return codePoint >= 0x1161 && codePoint <= 0x1175;
}

function isHangulTrailingJamo(value: string | undefined): boolean {
  const codePoint = getCodePoint(value);
  if (codePoint === undefined) return false;
  return codePoint >= 0x11a8 && codePoint <= 0x11c2;
}

function isHangulLvSyllable(value: string | undefined): boolean {
  const codePoint = getCodePoint(value);
  return (
    codePoint !== undefined &&
    codePoint >= 0xac00 &&
    codePoint <= 0xd7a3 &&
    (codePoint - 0xac00) % 28 === 0
  );
}

function foldSearchValue(
  normalizedValue: { value: string; starts: number[]; ends: number[] },
): { value: string; starts: number[]; ends: number[] } {
  let foldedValue = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < normalizedValue.value.length; ) {
    const character = getCodePointAt(normalizedValue.value, index);
    const end = index + character.length;
    const foldedCharacter = unicodeCaseFold(character);
    const sourceStart = normalizedValue.starts[index];
    const sourceEnd = normalizedValue.ends[end - 1];
    foldedValue += foldedCharacter;
    for (let offset = 0; offset < foldedCharacter.length; offset += 1) {
      starts.push(sourceStart);
      ends.push(sourceEnd);
    }
    index = end;
  }
  return { value: foldedValue, starts, ends };
}

function getCodePointBefore(value: string, index: number): string {
  if (index <= 0) return '';
  let start = index - 1;
  const codeUnit = value.charCodeAt(start);
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
    const previousCodeUnit = value.charCodeAt(start - 1);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) start -= 1;
  }
  return value.slice(start, index);
}

function getCodePointAt(value: string, index: number): string {
  if (index < 0 || index >= value.length) return '';
  const codeUnit = value.charCodeAt(index);
  if (
    codeUnit >= 0xd800 &&
    codeUnit <= 0xdbff &&
    index + 1 < value.length &&
    value.charCodeAt(index + 1) >= 0xdc00 &&
    value.charCodeAt(index + 1) <= 0xdfff
  ) {
    return value.slice(index, index + 2);
  }
  return value[index];
}

function isVisuallyClipped(style: CSSStyleDeclaration): boolean {
  const clip = style.clip.trim().toLowerCase();
  const clipPath = style.clipPath.trim().toLowerCase();
  const hasZeroRectClip = /^rect\(\s*0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?[ ,]+0(?:px)?\s*\)$/.test(
    clip,
  );
  if (hasZeroRectClip) return true;
  if (clipPath === 'none' || clipPath === '') return false;

  const width = Number.parseFloat(style.width);
  const height = Number.parseFloat(style.height);
  const isTiny = Number.isFinite(width) && Number.isFinite(height) && width <= 1 && height <= 1;
  return isTiny && (style.position === 'absolute' || style.position === 'fixed');
}

function isCjkCharacter(value: string): boolean {
  if (!value) return false;
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x2fff) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  );
}

function getCachedComputedStyle(
  element: HTMLElement,
  styleCache: WeakMap<HTMLElement, CSSStyleDeclaration>,
): CSSStyleDeclaration {
  const cachedStyle = styleCache.get(element);
  if (cachedStyle) return cachedStyle;
  const style = window.getComputedStyle(element);
  styleCache.set(element, style);
  return style;
}

function isExcludedTextNode(
  node: Text,
  excludedRoot: HTMLElement | null,
  visibilityCache: WeakMap<HTMLElement, boolean>,
  styleCache: WeakMap<HTMLElement, CSSStyleDeclaration>,
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
    if (element.hidden) return true;
    const cachedHidden = visibilityCache.get(element);
    if (cachedHidden !== undefined) {
      if (cachedHidden) return true;
    } else {
      const style = getCachedComputedStyle(element, styleCache);
      const hiddenByStyle =
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0' ||
        isVisuallyClipped(style);
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
  const styleCache = new WeakMap<HTMLElement, CSSStyleDeclaration>();
  // Keep off-screen and scrollable content searchable. Geometry-based clipping
  // guesses cannot distinguish a closed drawer from history outside a scroll
  // viewport, so only explicit hidden styles are excluded here.
  const walker = document.createTreeWalker(document.body, 4);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (!isExcludedTextNode(textNode, excludedRoot, visibilityCache, styleCache)) {
      const parentElement = textNode.parentElement;
      const parentStyle = parentElement ? getCachedComputedStyle(parentElement, styleCache) : null;
      const whiteSpace = parentStyle?.whiteSpace || 'normal';
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
  const rangesRef = useRef<TextMatch[]>([]);
  const activeRef = useRef(0);
  const pendingScrollFrameRef = useRef<number | null>(null);
  const pendingRefreshTimerRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const compositionCommitRef = useRef<string | null>(null);

  const clearSearchResults = useCallback(() => {
    rangesRef.current = [];
    activeRef.current = 0;
    setMatches(0);
    setActive(0);
    clearFindHighlights();
  }, []);

  const cancelPendingScroll = useCallback(() => {
    const frame = pendingScrollFrameRef.current;
    pendingScrollFrameRef.current = null;
    if (frame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame);
    }
  }, []);

  const scrollToMatch = useCallback(
    (range: Range | undefined) => {
      cancelPendingScroll();
      if (!range) return;
      const element = range.startContainer.parentElement;
      if (!element || isInsideRoot(element, rootRef.current)) return;
      scrollRangeIntoView(range);
      if (typeof requestAnimationFrame === 'function') {
        pendingScrollFrameRef.current = requestAnimationFrame(() => {
          pendingScrollFrameRef.current = null;
          if (
            range.startContainer.isConnected &&
            rangesRef.current[activeRef.current]?.range === range
          ) {
            scrollRangeIntoView(range);
          }
        });
      }
    },
    [cancelPendingScroll],
  );

  const applySearch = useCallback(
    (query: string, requestedActive = 0, shouldScroll = false) => {
      const nextRanges = collectTextMatches(query, rootRef.current);
      rangesRef.current = nextRanges;
      const nextActive = nextRanges.length
        ? ((requestedActive % nextRanges.length) + nextRanges.length) % nextRanges.length
        : 0;
      activeRef.current = nextActive;
      setMatches(nextRanges.length);
      setActive(nextActive);
      applyFindHighlights(nextRanges, nextActive);
      if (shouldScroll) scrollToMatch(nextRanges[nextActive]?.range);
    },
    [scrollToMatch],
  );

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      const hadMatches = rangesRef.current.length > 0;
      if (text) applySearch(text, activeRef.current);
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      const nextActive = hadMatches
        ? (activeRef.current + direction + ranges.length) % ranges.length
        : direction === 1
          ? 0
          : ranges.length - 1;
      activeRef.current = nextActive;
      setActive(nextActive);
      applyFindHighlights(ranges, nextActive);
      scrollToMatch(ranges[nextActive]?.range);
    },
    [applySearch, scrollToMatch, text],
  );

  const close = useCallback(() => {
    cancelPendingScroll();
    setOpen(false);
    setText('');
    isComposingRef.current = false;
    compositionCommitRef.current = null;
    clearSearchResults();
  }, [cancelPendingScroll, clearSearchResults]);

  useEffect(() => () => clearFindHighlights(), []);

  useEffect(() => {
    if (!open || !text) return;

    const refreshSearch = () => {
      if (isComposingRef.current) return;
      applySearch(text, activeRef.current);
    };
    const scheduleRefresh = () => {
      if (isComposingRef.current) return;
      const pendingTimer = pendingRefreshTimerRef.current;
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);

      pendingRefreshTimerRef.current = window.setTimeout(() => {
        pendingRefreshTimerRef.current = null;
        refreshSearch();
      }, SEARCH_REFRESH_DEBOUNCE_MS);
    };
    const handleResize = () => scheduleRefresh();
    const handleChange = (event: Event) => {
      if (event.target instanceof HTMLSelectElement) refreshSearch();
    };
    const handleTransitionEnd = (event: Event) => {
      const target = event.target;
      const propertyName = (event as TransitionEvent).propertyName;
      if (
        !(target instanceof Node) ||
        isInsideRoot(target, rootRef.current) ||
        ![
          'opacity',
          'visibility',
          'width',
          'height',
          'max-width',
          'max-height',
          'transform',
        ].includes(propertyName)
      ) {
        return;
      }
      scheduleRefresh();
    };
    const handlePotentialVisibilityChange = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || isInsideRoot(target, rootRef.current)) return;
      scheduleRefresh();
    };
    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver((records) => {
            const root = rootRef.current;
            if (!root || records.every((record) => isInsideRoot(record.target, root))) return;
            scheduleRefresh();
          })
        : null;

    window.addEventListener('resize', handleResize);
    document.addEventListener('change', handleChange);
    document.addEventListener('transitionend', handleTransitionEnd);
    document.addEventListener('mouseover', handlePotentialVisibilityChange);
    document.addEventListener('mouseout', handlePotentialVisibilityChange);
    document.addEventListener('focusin', handlePotentialVisibilityChange);
    document.addEventListener('focusout', handlePotentialVisibilityChange);
    observer?.observe(document.body, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
      subtree: true,
    });
    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('change', handleChange);
      document.removeEventListener('transitionend', handleTransitionEnd);
      document.removeEventListener('mouseover', handlePotentialVisibilityChange);
      document.removeEventListener('mouseout', handlePotentialVisibilityChange);
      document.removeEventListener('focusin', handlePotentialVisibilityChange);
      document.removeEventListener('focusout', handlePotentialVisibilityChange);
      observer?.disconnect();
      const timer = pendingRefreshTimerRef.current;
      pendingRefreshTimerRef.current = null;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
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
