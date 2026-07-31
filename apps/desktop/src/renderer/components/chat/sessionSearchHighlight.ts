const SKIPPED_TEXT_ANCESTOR = 'button,input,textarea,select,script,style,[aria-hidden="true"]';

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
  let offset = normalizedText.indexOf(normalizedQuery);
  while (offset >= 0) {
    const end = offset + normalizedQuery.length;
    const startSegment = segments.find((segment) => segment.start <= offset && offset < segment.end);
    const endSegment = segments.find((segment) => segment.start < end && end <= segment.end);
    if (startSegment && endSegment) {
      const range = document.createRange();
      range.setStart(startSegment.node, offset - startSegment.start);
      range.setEnd(endSegment.node, end - endSegment.start);
      ranges.push(range);
    }
    offset = normalizedText.indexOf(normalizedQuery, end);
  }
  return ranges;
}
