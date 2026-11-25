import { annotationMatchesText, type MessageAnnotationAnchor } from '../../../shared/messageAnnotations';
import { CHAT_SELECTION_EXCLUDE_SELECTOR } from './chatSelectionClipboard';

const excluded = `${CHAT_SELECTION_EXCLUDE_SELECTOR}, .katex-mathml, input, textarea, select, button, [aria-hidden="true"]`;
export function annotationTextNodes(body: HTMLElement): Text[] {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

export function captureAnnotationSelection(range: Range, sessionId: string): MessageAnnotationAnchor | null {
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const root = startElement?.closest<HTMLElement>('[data-annotation-message]');
  const body = root?.querySelector<HTMLElement>('[data-selection-quote-body]');
  if (!root || !body || root.dataset.annotationSession !== sessionId || !body.contains(range.endContainer)) return null;
  const nodes = annotationTextNodes(body);
  let offset = 0, start = -1, end = -1;
  for (const node of nodes) {
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += node.length;
  }
  // Element endpoints are uncommon (select-all); fail closed instead of guessing a duplicate.
  if (start < 0 || end <= start || end - start > 16000) return null;
  const text = nodes.map(node => node.data).join('');
  return {
    messageClientId: root.dataset.annotationMessage!, sourceVersion: root.dataset.annotationVersion!,
    start, end, quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - 80), start), suffix: text.slice(end, end + 80),
  };
}

export function resolveAnnotationRange(body: HTMLElement, anchor: MessageAnnotationAnchor): Range | null {
  const root = body.closest<HTMLElement>('[data-annotation-message]');
  if (root?.dataset.annotationVersion !== anchor.sourceVersion) return null;
  const nodes = annotationTextNodes(body);
  if (!annotationMatchesText(anchor, nodes.map(node => node.data).join(''))) return null;
  const range = document.createRange();
  let offset = 0, hasStart = false;
  for (const node of nodes) {
    if (!hasStart && anchor.start < offset + node.length) { range.setStart(node, anchor.start - offset); hasStart = true; }
    if (hasStart && anchor.end <= offset + node.length) { range.setEnd(node, anchor.end - offset); return range; }
    offset += node.length;
  }
  return null;
}

export const MESSAGE_ANNOTATION_OPEN = 'cindy:message-annotation-open';
export function openMessageAnnotation(sessionId: string, anchor: MessageAnnotationAnchor, point: { x: number; y: number }) {
  window.dispatchEvent(new CustomEvent(MESSAGE_ANNOTATION_OPEN, { detail: { sessionId, anchor, point } }));
}
