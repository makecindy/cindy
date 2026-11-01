import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Settings, type LucideIcon } from 'lucide-react';
import { isGhostCardIconName, type GhostCardIconName } from '../../shared/ghost';

/** 卡内图标位用的就是 App 里的同名 Lucide 图标,不另画一份。 */
const ICONS = { settings: Settings } satisfies Record<GhostCardIconName, LucideIcon>;
const markup = new Map<GhostCardIconName, string>();

function iconMarkup(name: GhostCardIconName): string {
  const cached = markup.get(name);
  if (cached !== undefined) return cached;
  const host = document.createElement('div');
  const root = createRoot(host);
  const Icon = ICONS[name];
  // 尺寸由插件的图标位决定;颜色用 currentColor 跟随卡片文字与主题。
  flushSync(() => root.render(<Icon size="100%" aria-hidden="true" />));
  const html = host.innerHTML;
  root.unmount();
  markup.set(name, html);
  return html;
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
