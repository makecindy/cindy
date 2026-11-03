import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Settings, type LucideIcon } from 'lucide-react';
import { isGhostCardIconName, type GhostCardIconName } from '../../shared/ghost';

/** 卡内图标位用的就是 App 里的同名 Lucide 图标,不另画一份。 */
const ICONS = { settings: Settings } satisfies Record<GhostCardIconName, LucideIcon>;
const markup = new Map<LucideIcon, string>();

/**
 * App 里某个 Lucide 图标的静态 SVG(按图标缓存)。尺寸跟随所在位置的宽高,颜色用
 * currentColor 跟随卡片文字与主题。宿主往卡片里填内容(图标位、PR 状态位)时共用。
 *
 * 同步渲染在 React 的 effect 里不会立即完成,得到的是空串:空串不缓存,下次再试。
 * 会在 effect 里填写的调用方先用 preloadAppIconMarkup 在模块加载时备好。
 */
export function appIconMarkup(Icon: LucideIcon): string {
  const cached = markup.get(Icon);
  if (cached) return cached;
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<Icon size="100%" aria-hidden="true" />));
  const html = host.innerHTML;
  root.unmount();
  if (html) markup.set(Icon, html);
  return html;
}

/** 在 React 渲染之外(模块加载时)备好这些图标的 SVG。 */
export function preloadAppIconMarkup(icons: readonly LucideIcon[]): void {
  if (typeof document === 'undefined') return;
  for (const Icon of icons) appIconMarkup(Icon);
}

function iconMarkup(name: GhostCardIconName): string {
  return appIconMarkup(ICONS[name]);
}

/** 把卡片文档里的 data-ghost-icon 位换成 App 的图标(重复调用无副作用)。 */
export function fillGhostCardIcons(doc: Document): void {
  doc.querySelectorAll<HTMLElement>('[data-ghost-icon]').forEach((slot) => {
    const name = slot.dataset.ghostIcon ?? '';
    if (!isGhostCardIconName(name) || slot.dataset.xdtIconFilled === name) return;
    slot.innerHTML = iconMarkup(name);
    slot.dataset.xdtIconFilled = name;
  });
}
