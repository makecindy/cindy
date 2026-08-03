/**
 * In-page host for tab-form Ghost panels, owned exclusively by the Plugin page.
 *
 * Inputs: the installed Ghost whose panel is open plus a close callback.
 * Outputs: the sandboxed panel body beside the catalog; unmounting on route
 * leave is the "面板收束" contract (panels never persist outside the Plugin page).
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { Puzzle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { GhostChipPanelBody, GhostPanelError } from '@/cindy-brain/ghostPanelBody';
import { useGhostRuntimeState } from '@/cindy-brain/runtimeStates';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import type { InstalledGhost } from '../../../shared/ghost';

/**
 * 面板收束(设计定稿):插件小侧边只从插件页进入,同一时刻至多一个,
 * 离开插件页(本组件随路由卸载)即关闭,不在右侧栏页签体系里常驻。
 * 面板体(webview 供片/主题注入/崩溃接管)与停靠形态共用 ghostPanelBody,
 * 沙箱边界零变化。
 */
export function GhostPagePanelHost({
  ghost,
  onClose,
}: {
  ghost: InstalledGhost;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { manifest } = ghost;
  const runtimeState = useGhostRuntimeState(manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  const width = Math.max(manifest.panel?.minWidth ?? 320, 320);
  return (
    <aside
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l-[0.5px] border-[var(--border-default)] bg-[var(--panel-bg)]"
      style={{ width }}
      aria-label={manifest.panel?.title ?? manifest.name}
    >
      <div
        className="flex h-11 shrink-0 items-center gap-2 border-b-[0.5px] border-[var(--border-default)] px-3"
        style={WINDOW_NO_DRAG_STYLE}
      >
        <Puzzle size={14} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]">
          {manifest.panel?.title ?? manifest.name}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('settings.ghosts.panelHost.close')}
          className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {broken ? (
          <GhostPanelError manifest={manifest} state={runtimeState} />
        ) : (
          <GhostChipPanelBody manifest={manifest} />
        )}
      </div>
    </aside>
  );
}
