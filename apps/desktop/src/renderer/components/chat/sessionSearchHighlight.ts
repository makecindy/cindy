const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGURE',
  'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
]);
const SKIPPED_TEXT_ANCESTOR =
  'button,input,textarea,select,script,style,[aria-hidden="true"],[data-session-search-ignore]';

interface TextSegment { node: Text; start: number; end: number }
interface NormalizedSearchText { text: string; starts: number[]; ends: number[] }

function normalizeSearchText(source: string): NormalizedSearchText {
  const lower = source.toLocaleLowerCase();
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let whitespaceStart = -1;
  for (let index = 0; index < lower.length; index += 1) {
    if (/\s/.test(lower[index])) {
      if (text && whitespaceStart < 0) whitespaceStart = index;
      continue;
    }
    if (whitespaceStart >= 0) {
      text += ' ';
      starts.push(whitespaceStart);
      ends.push(index);
      whitespaceStart = -1;
    }
    text += lower[index];
    starts.push(index);
    ends.push(index + 1);
  }
  return { text, starts, ends };
}

function blockAncestor(node: Node): Element | null {
  let current: Element | null = node.parentElement;
  while (current) {
    if (BLOCK_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return null;
}

/** Build DOM ranges for visible, non-interactive text matches without changing React's DOM tree. */
export function findSessionSearchRanges(root: Element, query: string): Range[] {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];
  const segments: TextSegment[] = [];
  let text = '';
  let previousBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const value = textNode.data;
    if (
      !parent ||
      !value ||
      parent.closest(SKIPPED_TEXT_ANCESTOR) ||
      parent.closest('[data-session-search-collapsed-body]')
    ) continue;
    const block = blockAncestor(textNode);
    if (block && previousBlock && block !== previousBlock && text.length > 0 && !/\s$/.test(text)) {
      text += ' ';
    }
    const start = text.length;
    text += value;
    segments.push({ node: textNode, start, end: text.length });
    previousBlock = block;
  }
  const normalized = normalizeSearchText(text);
  const ranges: Range[] = [];
  let startSegmentIndex = 0;
  let endSegmentIndex = 0;
  let offset = normalized.text.indexOf(normalizedQuery);
  while (offset >= 0) {
    const normalizedEnd = offset + normalizedQuery.length;
    const sourceStart = normalized.starts[offset];
    const sourceEnd = normalized.ends[normalizedEnd - 1];
    if (sourceStart === undefined || sourceEnd === undefined) break;
    while (segments[startSegmentIndex]?.end <= sourceStart) startSegmentIndex += 1;
    endSegmentIndex = Math.max(endSegmentIndex, startSegmentIndex);
    while (segments[endSegmentIndex]?.end < sourceEnd) endSegmentIndex += 1;
    const startSegment = segments[startSegmentIndex];
    const endSegment = segments[endSegmentIndex];
    if (startSegment && endSegment && startSegment.start <= sourceStart && sourceStart < startSegment.end && endSegment.start < sourceEnd && sourceEnd <= endSegment.end) {
      const range = document.createRange();
      range.setStart(startSegment.node, sourceStart - startSegment.start);
      range.setEnd(endSegment.node, sourceEnd - endSegment.start);
      ranges.push(range);
    }
    offset = normalized.text.indexOf(normalizedQuery, normalizedEnd);
  }
  return ranges;
}
