const SKIPPED_TEXT_ANCESTOR =
  'button,input,textarea,select,script,style,[aria-hidden="true"],[data-session-search-ignore]';

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/** Build DOM ranges for visible, non-interactive text matches without changing React's DOM tree. */
export function findSessionSearchRanges(root: Element, query: string): Range[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const segments: TextSegment[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const parent = textNode.parentElement;
    const value = textNode.data;
    if (!parent || !value || parent.closest(SKIPPED_TEXT_ANCESTOR)) continue;
    const start = text.length;
    text += value;
    segments.push({ node: textNode, start, end: text.length });
  }

  const normalizedText = text.toLocaleLowerCase();
  const ranges: Range[] = [];
  let startSegmentIndex = 0;
  let endSegmentIndex = 0;
  let offset = normalizedText.indexOf(normalizedQuery);
  while (offset >= 0) {
    const end = offset + normalizedQuery.length;
    while (segments[startSegmentIndex]?.end <= offset) startSegmentIndex += 1;
    endSegmentIndex = Math.max(endSegmentIndex, startSegmentIndex);
    while (segments[endSegmentIndex]?.end < end) endSegmentIndex += 1;
    const startSegment = segments[startSegmentIndex];
    const endSegment = segments[endSegmentIndex];
    if (
      startSegment &&
      endSegment &&
      startSegment.start <= offset &&
      offset < startSegment.end &&
      endSegment.start < end &&
      end <= endSegment.end
    ) {
      const range = document.createRange();
      range.setStart(startSegment.node, offset - startSegment.start);
      range.setEnd(endSegment.node, end - endSegment.start);
      ranges.push(range);
    }
    offset = normalizedText.indexOf(normalizedQuery, end);
  }
  return ranges;
}
