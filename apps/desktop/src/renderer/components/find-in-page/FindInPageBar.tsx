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
  const normalizedQuery = unicodeCaseFold(searchableQuery);
  const offsets: Array<[number, number]> = [];

  const foldedValue = foldSearchValue(searchableValue, sourceStarts, sourceEnds);
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

// JavaScript has no native Unicode full-case-folding API. These are the
// default full-fold mappings that are not preserved by String#toLowerCase;
// the remaining one-to-one mappings are handled by toLowerCase itself.
const UNICODE_CASE_FOLD_OVERRIDES = new Map<number, string>([
  [0x00b5, '\u03bc'],
  [0x00df, 'ss'],
  [0x0149, '\u02bcn'],
  [0x017f, 's'],
  [0x01f0, 'j\u030c'],
  [0x0345, '\u03b9'],
  [0x0390, '\u03b9\u0308\u0301'],
  [0x03b0, '\u03c5\u0308\u0301'],
  [0x03c2, '\u03c3'],
  [0x03d0, '\u03b2'],
  [0x03d1, '\u03b8'],
  [0x03d5, '\u03c6'],
  [0x03d6, '\u03c0'],
  [0x03f0, '\u03ba'],
  [0x03f1, '\u03c1'],
  [0x03f5, '\u03b5'],
  [0x0587, '\u0565\u0582'],
  [0x1c80, '\u0432'],
  [0x1c81, '\u0434'],
  [0x1c82, '\u043e'],
  [0x1c83, '\u0441'],
  [0x1c84, '\u0442'],
  [0x1c85, '\u0442'],
  [0x1c86, '\u044a'],
  [0x1c87, '\u0463'],
  [0x1c88, '\ua64b'],
  [0x1e96, 'h\u0331'],
  [0x1e97, 't\u0308'],
  [0x1e98, 'w\u030a'],
  [0x1e99, 'y\u030a'],
  [0x1e9a, 'a\u02be'],
  [0x1e9b, '\u1e61'],
  [0x1f50, '\u03c5\u0313'],
  [0x1f52, '\u03c5\u0313\u0300'],
  [0x1f54, '\u03c5\u0313\u0301'],
  [0x1f56, '\u03c5\u0313\u0342'],
  [0x1f80, '\u1f00\u03b9'],
  [0x1f81, '\u1f01\u03b9'],
  [0x1f82, '\u1f02\u03b9'],
  [0x1f83, '\u1f03\u03b9'],
  [0x1f84, '\u1f04\u03b9'],
  [0x1f85, '\u1f05\u03b9'],
  [0x1f86, '\u1f06\u03b9'],
  [0x1f87, '\u1f07\u03b9'],
  [0x1f90, '\u1f20\u03b9'],
  [0x1f91, '\u1f21\u03b9'],
  [0x1f92, '\u1f22\u03b9'],
  [0x1f93, '\u1f23\u03b9'],
  [0x1f94, '\u1f24\u03b9'],
  [0x1f95, '\u1f25\u03b9'],
  [0x1f96, '\u1f26\u03b9'],
  [0x1f97, '\u1f27\u03b9'],
  [0x1fa0, '\u1f60\u03b9'],
  [0x1fa1, '\u1f61\u03b9'],
  [0x1fa2, '\u1f62\u03b9'],
  [0x1fa3, '\u1f63\u03b9'],
  [0x1fa4, '\u1f64\u03b9'],
  [0x1fa5, '\u1f65\u03b9'],
  [0x1fa6, '\u1f66\u03b9'],
  [0x1fa7, '\u1f67\u03b9'],
  [0x1fb2, '\u1f70\u03b9'],
  [0x1fb3, '\u03b1\u03b9'],
  [0x1fb4, '\u03ac\u03b9'],
  [0x1fb6, '\u03b1\u0342'],
  [0x1fb7, '\u03b1\u0342\u03b9'],
  [0x1fbe, '\u03b9'],
  [0x1fc2, '\u1f74\u03b9'],
  [0x1fc3, '\u03b7\u03b9'],
  [0x1fc4, '\u03ae\u03b9'],
  [0x1fc6, '\u03b7\u0342'],
  [0x1fc7, '\u03b7\u0342\u03b9'],
  [0x1fd2, '\u03b9\u0308\u0300'],
  [0x1fd3, '\u03b9\u0308\u0301'],
  [0x1fd6, '\u03b9\u0342'],
  [0x1fd7, '\u03b9\u0308\u0342'],
  [0x1fe2, '\u03c5\u0308\u0300'],
  [0x1fe3, '\u03c5\u0308\u0301'],
  [0x1fe4, '\u03c1\u0313'],
  [0x1fe6, '\u03c5\u0342'],
  [0x1fe7, '\u03c5\u0308\u0342'],
  [0x1ff2, '\u1f7c\u03b9'],
  [0x1ff3, '\u03c9\u03b9'],
  [0x1ff4, '\u03ce\u03b9'],
  [0x1ff6, '\u03c9\u0342'],
  [0x1ff7, '\u03c9\u0342\u03b9'],
  [0xfb00, 'ff'],
  [0xfb01, 'fi'],
  [0xfb02, 'fl'],
  [0xfb03, 'ffi'],
  [0xfb04, 'ffl'],
  [0xfb05, 'st'],
  [0xfb06, 'st'],
  [0xfb13, '\u0574\u0576'],
  [0xfb14, '\u0574\u0565'],
  [0xfb15, '\u0574\u056b'],
  [0xfb16, '\u057e\u0576'],
  [0xfb17, '\u0574\u056d'],
]);

function unicodeCaseFold(value: string): string {
  let folded = '';
  for (const character of value) {
    const lowerCharacter = character.toLowerCase();
    const codePoint = lowerCharacter.codePointAt(0);
    if (codePoint === undefined) continue;

    if (codePoint >= 0xab70 && codePoint <= 0xabbf) {
      folded += String.fromCodePoint(codePoint - 0x97d0);
    } else if (codePoint >= 0x13f8 && codePoint <= 0x13fd) {
      folded += String.fromCodePoint(codePoint - 8);
    } else {
      folded += UNICODE_CASE_FOLD_OVERRIDES.get(codePoint) ?? lowerCharacter;
    }
  }
  return folded;
}

function foldSearchValue(
  value: string,
  sourceStarts: readonly number[],
  sourceEnds: readonly number[],
): { value: string; starts: number[]; ends: number[] } {
  let foldedValue = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < value.length;) {
    const character = getCodePointAt(value, index);
    const end = index + character.length;
    const foldedCharacter = unicodeCaseFold(character);
    const sourceStart = sourceStarts[index];
    const sourceEnd = sourceEnds[end - 1];
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

function getLineClamp(style: CSSStyleDeclaration): number | null {
  const lineClampStyle = style as CSSStyleDeclaration & {
    lineClamp?: string;
    webkitLineClamp?: string;
  };
  const value =
    lineClampStyle.lineClamp ||
    lineClampStyle.webkitLineClamp ||
    style.getPropertyValue('line-clamp') ||
    style.getPropertyValue('-webkit-line-clamp');
  const lineClamp = Number.parseInt(value, 10);
  return Number.isFinite(lineClamp) && lineClamp > 0 ? lineClamp : null;
}

function getClampedAncestor(
  element: HTMLElement | null,
  clampCache: WeakMap<HTMLElement, HTMLElement | null>,
): HTMLElement | null {
  const path: HTMLElement[] = [];
  let current = element;
  let clampedAncestor: HTMLElement | null = null;
  while (current) {
    if (clampCache.has(current)) {
      clampedAncestor = clampCache.get(current) ?? null;
      break;
    }
    path.push(current);
    if (getLineClamp(window.getComputedStyle(current)) !== null) {
      clampedAncestor = current;
      break;
    }
    current = current.parentElement;
  }
  for (const pathElement of path) clampCache.set(pathElement, clampedAncestor);
  return clampedAncestor;
}

function isRangeVisibleInClampedAncestor(
  range: Range,
  clampedAncestor: HTMLElement | null,
): boolean {
  if (!clampedAncestor) return true;
  const rects =
    typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  if (rects.length === 0) return true;

  const clipRect = clampedAncestor.getBoundingClientRect();
  return rects.some(
    (rect) =>
      rect.bottom > clipRect.top &&
      rect.top < clipRect.bottom &&
      rect.right > clipRect.left &&
      rect.left < clipRect.right,
  );
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
  const clampCache = new WeakMap<HTMLElement, HTMLElement | null>();
  const walker = document.createTreeWalker(document.body, 4);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    if (!isExcludedTextNode(textNode, excludedRoot, visibilityCache)) {
      const whiteSpace = textNode.parentElement
        ? window.getComputedStyle(textNode.parentElement).whiteSpace || 'normal'
        : 'normal';
      const clampedAncestor = getClampedAncestor(textNode.parentElement, clampCache);
      for (const [start, end] of findMatchOffsets(textNode.data, query, whiteSpace)) {
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        if (isRangeVisibleInClampedAncestor(range, clampedAncestor)) {
          matches.push({ range });
        }
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
