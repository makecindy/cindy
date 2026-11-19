export interface PluginCatalogAnchor { id: string; top: number; following?: string[] }
export function readPluginCatalogAnchor(root: HTMLElement): PluginCatalogAnchor | null {
  const top = root.getBoundingClientRect().top;
  const visibleTop = Math.max(top, root.querySelector<HTMLElement>('.sticky')?.getBoundingClientRect().bottom ?? top);
  const cards = [...root.querySelectorAll<HTMLElement>('[data-plugin-id]')].filter(node => !node.closest('[hidden]'));
  const card = cards
    .find(node => node.getBoundingClientRect().bottom > visibleTop && node.getBoundingClientRect().top < top + root.clientHeight);
  return card ? { id: card.dataset.pluginId!, top: card.getBoundingClientRect().top - top,
    following: cards.slice(cards.indexOf(card) + 1).map(node => node.dataset.pluginId!) } : null;
}
export function restorePluginCatalogAnchor(root: HTMLElement, anchor: PluginCatalogAnchor | null) {
  if (!anchor) return false;
  const cards = [...root.querySelectorAll<HTMLElement>('[data-plugin-id]')].filter(node => !node.closest('[hidden]'));
  const card = [anchor.id, ...(anchor.following ?? [])].map(id => cards.find(node => node.dataset.pluginId === id)).find(Boolean);
  if (!card) return false;
  root.scrollTop += card.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.top;
  return true;
}
