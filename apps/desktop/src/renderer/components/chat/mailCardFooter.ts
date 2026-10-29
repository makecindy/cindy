import { readMailCard } from '@cindy/maker-shared/ghost-card-form';

/** Native mail fields are rendered by the parent. Their hidden serialized copy
 * must not navigate the footer iframe on every keystroke, including conflicts. */
export function mailCardFooterHtml(html: string): string {
  if (!readMailCard(html)) return html;
  const fragment = document.createElement('template');
  fragment.innerHTML = html;
  fragment.content.querySelectorAll('[data-cindy-mail], [data-ghost-form]').forEach(node => node.remove());
  return fragment.innerHTML;
}

/** Update the host-authored footer without navigating its browsing context.
 * Matching action nodes stay in place so a save between pointerdown and click
 * cannot discard the user's send gesture. Never used for plugin-authored cards. */
export function updateMailCardDocument(doc: Document, srcDoc: string): void {
  const next = new DOMParser().parseFromString(srcDoc, 'text/html');
  const update = (target: Node, source: Node): void => {
    if (target.nodeType === 3) {
      if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
      return;
    }
    if (target.nodeType === 1) {
      const element = target as Element;
      for (const attr of (source as Element).attributes) {
        if (element.getAttribute(attr.name) !== attr.value) element.setAttribute(attr.name, attr.value);
      }
      // Authored styles must not erase the transient host delivery feedback.
      if (element.hasAttribute('data-ghost-submit') && element.getAttribute('aria-disabled') === 'true') {
        (element as HTMLElement).style.opacity = '0.5';
        (element as HTMLElement).style.pointerEvents = 'none';
      }
    }
    const children = [...source.childNodes];
    children.forEach((child, index) => {
      const old = target.childNodes[index];
      const action = (node: Node) => node.nodeType === 1 ? (node as Element).getAttribute('data-ghost-action') : null;
      if (!old) target.appendChild(doc.importNode(child, true));
      else if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName || action(old) !== action(child)) {
        target.replaceChild(doc.importNode(child, true), old);
      } else update(old, child);
    });
    while (target.childNodes.length > children.length) target.lastChild!.remove();
  };
  update(doc.head, next.head);
  update(doc.body, next.body);
}
