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
