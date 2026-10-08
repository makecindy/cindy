import { useState } from 'react';
import { Check, GripVertical, Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useGhostMainViews } from '@/cindy-brain/ghostMainViews';
import { useAuth } from '@/contexts/AuthContext';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { MAIN_VIEW_ICONS } from './GhostMainViewNavEntries';
import {
  DEFAULT_SIDEBAR_NAVIGATION_VISIBLE,
  SIDEBAR_NAVIGATION_ITEMS,
  SIDEBAR_NAVIGATION_ITEM_ICONS,
  appEntryId,
  getSidebarNavigationPrefs,
  ghostIdOfEntry,
  isBuiltInEntry,
  mergeAbsentOrderEntries,
  resolveSidebarNavigationOrder,
  setSidebarNavigationPrefs,
  type SidebarNavigationAppEntryId,
  type SidebarNavigationEntryId,
  type SidebarNavigationItemId,
  useSidebarNavigationPrefs,
} from './sidebarNavigationPrefs';
import { SortableList } from './SortableList';

interface SidebarNavigationCustomizeProps {
  onDone: () => void;
}

interface CustomizeDraft {
  order: SidebarNavigationEntryId[];
  /** Built-in entries shown at the top level. */
  visible: ReadonlySet<SidebarNavigationItemId>;
  /** Plugin main views placed at the top level; the rest sit in More (their default). */
  appsAtTop: ReadonlySet<SidebarNavigationAppEntryId>;
}

/**
 * 管理一级入口(含带主视图的插件)的勾选与顺序；草稿在“完成”时一次性提交，
 * 取消离开不会改偏好。勾选只决定入口在最外层还是收进「更多」；插件是否进侧边栏
 * 由插件自己的「在侧边栏显示」开关决定，关掉的插件不会出现在这里。
 */
export function SidebarNavigationCustomize({ onDone }: SidebarNavigationCustomizeProps) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const prefs = useSidebarNavigationPrefs(dataOwnerId);
  const { sidebarVisible } = useGhostMainViews();
  const appIds = sidebarVisible.map((item) => item.ghostId);
  const apps = new Map(sidebarVisible.map((item) => [item.ghostId, item]));
  const [initial] = useState<CustomizeDraft>(() => ({
    order: resolveSidebarNavigationOrder(prefs.order, appIds),
    visible: new Set(prefs.visible),
    appsAtTop: new Set(prefs.appsAtTop),
  }));
  const [draft, setDraft] = useState<CustomizeDraft>(initial);
  const reducedMotion = useReducedMotion();
  const [resetting, setResetting] = useState(false);

  // Plugins switched on or off while the panel is open join or leave the list.
  const orderedItems = resolveSidebarNavigationOrder(draft.order, appIds);
  const checkedIn = (state: CustomizeDraft, id: SidebarNavigationEntryId) =>
    isBuiltInEntry(id)
      ? state.visible.has(id)
      : state.appsAtTop.has(id as SidebarNavigationAppEntryId);
  const isChecked = (id: SidebarNavigationEntryId) => checkedIn(draft, id);
  const labelFor = (id: SidebarNavigationEntryId) => {
    const ghostId = ghostIdOfEntry(id);
    return ghostId === null
      ? t('sidebar.navigation.items.' + id)
      : (apps.get(ghostId)?.title ?? ghostId);
  };
  // The same icon the entry shows in the sidebar, so each row is recognisable at a glance.
  const iconFor = (id: SidebarNavigationEntryId) => {
    const ghostId = ghostIdOfEntry(id);
    if (ghostId === null) return SIDEBAR_NAVIGATION_ITEM_ICONS[id as SidebarNavigationItemId];
    const app = apps.get(ghostId);
    return app ? MAIN_VIEW_ICONS[app.icon] : Puzzle;
  };
  const toggle = (id: SidebarNavigationEntryId) => {
    setDraft((current) => {
      if (isBuiltInEntry(id)) {
        const visible = new Set(current.visible);
        if (visible.has(id)) visible.delete(id);
        else visible.add(id);
        return { ...current, visible };
      }
      const appId = id as SidebarNavigationAppEntryId;
      const appsAtTop = new Set(current.appsAtTop);
      if (appsAtTop.has(appId)) appsAtTop.delete(appId);
      else appsAtTop.add(appId);
      return { ...current, appsAtTop };
    });
  };
  const move = (source: SidebarNavigationEntryId, target: SidebarNavigationEntryId) => {
    if (source === target) return;
    setDraft((current) => {
      const order = resolveSidebarNavigationOrder(current.order, appIds);
      const sourceIndex = order.indexOf(source);
      const targetIndex = order.indexOf(target);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = order.filter((id) => id !== source);
      // Downward drops go after the target; upward drops go before it.
      next.splice(targetIndex, 0, source);
      return { ...current, order: next };
    });
  };
  const moveBy = (id: SidebarNavigationEntryId, direction: -1 | 1) => {
    const index = orderedItems.indexOf(id);
    const target = orderedItems[index + direction];
    if (target) move(id, target);
  };
  const save = () => {
    if (resetting) {
      // Resetting drops every override, so future defaults keep applying: plugins fall
      // back to More, including ones whose own sidebar switch is off right now. Only
      // entries checked again after resetting are kept at the top level.
      // A reorder made after resetting is kept; an untouched reset stores the bare default.
      const resetOrder = resolveSidebarNavigationOrder(SIDEBAR_NAVIGATION_ITEMS, appIds);
      const reordered = orderedItems.some((id, index) => id !== resetOrder[index]);
      setSidebarNavigationPrefs(dataOwnerId, {
        order: reordered ? orderedItems : [...SIDEBAR_NAVIGATION_ITEMS],
        visible: SIDEBAR_NAVIGATION_ITEMS.filter((id) => draft.visible.has(id)),
        appsAtTop: [...draft.appsAtTop],
      });
      onDone();
      return;
    }
    // Preserve edits made in another window while this draft was open: only entries
    // toggled here override the latest saved state.
    const latest = getSidebarNavigationPrefs(dataOwnerId);
    const latestState: CustomizeDraft = {
      order: latest.order,
      visible: new Set(latest.visible),
      appsAtTop: new Set(latest.appsAtTop),
    };
    const resolve = (id: SidebarNavigationEntryId) =>
      checkedIn(draft, id) !== checkedIn(initial, id)
        ? checkedIn(draft, id)
        : checkedIn(latestState, id);
    // Only a drag or arrow move replaces the order; plugins switching on or off in the
    // meantime merely change which entries are listed.
    const orderChanged = draft.order !== initial.order;
    // Plugins absent from the panel (sidebar switch off) keep whatever was saved for them.
    const appEntries = new Set<SidebarNavigationAppEntryId>([
      ...latest.appsAtTop,
      ...appIds.map(appEntryId),
    ]);
    setSidebarNavigationPrefs(dataOwnerId, {
      // Plugins missing from the panel keep their saved place inside the new order.
      order: orderChanged ? mergeAbsentOrderEntries(orderedItems, latest.order) : latest.order,
      visible: SIDEBAR_NAVIGATION_ITEMS.filter(resolve),
      appsAtTop: [...appEntries].filter(resolve),
    });
    onDone();
  };

  return (
    <div
      role="dialog"
      aria-label={t('sidebar.navigation.customize.title')}
      className="mx-2 mb-2 rounded-xl border border-sidebar-border bg-[var(--surface-elevated)] p-3 shadow-[shadow:var(--shadow-menu)]"
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          {t('sidebar.navigation.customize.title')}
        </h2>
        <Button variant="primary" size="sm" compact onClick={save}>
          {t('sidebar.navigation.customize.done')}
        </Button>
      </div>
      {/* Pointer-driven sort shared with the sidebar lists: the whole row floats with
          the cursor and the others make room live, so the drop position is visible. */}
      <SortableList
        items={orderedItems}
        getId={(id) => id}
        onReorder={(ids) =>
          setDraft((current) => ({
            ...current,
            order: ids as SidebarNavigationEntryId[],
          }))
        }
        reducedMotion={reducedMotion}
        // Rows drag from their label or handle; only the checkbox stays a plain click.
        filter="[role='checkbox']"
        className="flex flex-col gap-0.5"
        renderItem={(id) => {
          const visible = isChecked(id);
          const Icon = iconFor(id);
          return (
            // The whole row toggles; the checkbox stays the focusable control, and its
            // keyboard activation bubbles here as the same click.
            <div
              onClick={() => toggle(id)}
              className="group/nav-entry flex h-9 cursor-pointer items-center gap-2 rounded-lg px-1 hover:bg-sidebar-item-hover"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={visible}
                aria-label={labelFor(id)}
                // Same round selection mark as ShareMessageCheckbox: inverse fill when
                // checked, a neutral outline otherwise. Blue stays reserved for focus.
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  visible
                    ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]'
                    : 'border border-[var(--border-default)] group-hover/nav-entry:border-[var(--text-secondary)]',
                )}
              >
                {visible && <Check size={12} strokeWidth={2.5} aria-hidden />}
              </button>
              <Icon
                aria-hidden="true"
                size={15}
                strokeWidth={1.8}
                className="shrink-0 text-[var(--sidebar-nav-text)]"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                {labelFor(id)}
              </span>
              <Tip
                text={t('sidebar.navigation.customize.reorder', { name: labelFor(id) })}
                side="right"
              >
                <button
                  type="button"
                  aria-label={t('sidebar.navigation.customize.reorder', { name: labelFor(id) })}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  // The handle is for dragging and arrow-key moves, not for toggling.
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      moveBy(id, event.key === 'ArrowUp' ? -1 : 1);
                    }
                  }}
                  className="grid size-7 shrink-0 cursor-grab place-items-center rounded-lg text-[var(--text-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <GripVertical aria-hidden="true" size={16} />
                </button>
              </Tip>
            </div>
          );
        }}
      />
      <Button
        variant="primary"
        tone="quiet"
        size="sm"
        compact
        className="mt-2"
        onClick={() => {
          setDraft({
            order: resolveSidebarNavigationOrder(SIDEBAR_NAVIGATION_ITEMS, appIds),
            visible: new Set(DEFAULT_SIDEBAR_NAVIGATION_VISIBLE),
            // Plugins default to More, the same place a newly arrived plugin starts.
            appsAtTop: new Set(),
          });
          setResetting(true);
        }}
      >
        {t('sidebar.navigation.customize.reset')}
      </Button>
    </div>
  );
}
