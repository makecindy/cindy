import type { ClipboardEvent } from 'react';

const MEDIA_SELECTOR = 'img, video, audio, canvas, iframe, object, embed';

// Chromium serializes a lone list item with its <ol>/<ul>/<li> ancestors, so rich-text targets
// (Slack, TextEdit) rebuild a number or bullet the user never selected (#7416). For exactly that
// selection return the selected content without the list wrapper; null means "use native copy".
function selectionWithoutListWrapper(
  selection: Selection,
  container: HTMLElement,
): { text: string; html: string } | null {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startElement =
    startNode.nodeType === Node.ELEMENT_NODE ? (startNode as Element) : startNode.parentElement;
  const item = startElement?.closest('li');
  // shortcut: nested-list items keep native copy, upgrade if sub-item copies leak markers.
  if (
    !item ||
    !['OL', 'UL'].includes(item.parentElement?.tagName ?? '') ||
    item.querySelector('li')
  ) {
    return null;
  }
  if (!item.contains(range.endContainer)) return null;
  // React portals bubble copy events here too (e.g. a Markdown preview opened from a reply).
  if (!container.contains(item)) return null;
  const fragment = range.cloneContents();
  // Link context-menu anchors are zero-size fixed spans, not content; TextEdit breaks the line on them.
  fragment.querySelectorAll('[data-fixed-menu-anchor]').forEach((el) => el.remove());
  // Keep Chromium's own flavors for non-text selections (e.g. a copied image).
  if (fragment.querySelector(MEDIA_SELECTOR)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  // cloneContents() drops ancestors of a selection inside one inline element (link text only);
  // re-wrap with shallow clones up to the <li> so href and formatting survive.
  let html: Node = fragment;
  const common = range.commonAncestorContainer;
  for (
    let el = common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement;
    el && el !== item;
    el = el.parentElement
  ) {
    const shell = el.cloneNode(false);
    shell.appendChild(html);
    html = shell;
  }
  const holder = document.createElement('div');
  holder.appendChild(html);
  return { text, html: holder.innerHTML };
}

/** The one `onCopy` for assistant message content. Put assistant-reply clipboard fixes here. */
export function handleAssistantCopy(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  const picked = selection ? selectionWithoutListWrapper(selection, event.currentTarget) : null;
  if (!picked) return;
  event.clipboardData?.setData('text/plain', picked.text);
  event.clipboardData?.setData('text/html', picked.html);
  event.preventDefault();
}
