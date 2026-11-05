import { useTranslation } from 'react-i18next';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import type { PluginUiClientTarget } from './pluginUiClient';
import { PluginUiCommandIcon } from './PluginUiCommandIcon';
import { usePluginShortcutDefinitions } from './usePluginShortcutDefinitions';
import { usePluginUiContributions } from './usePluginUiContributions';

/** Keep the binding in the owning view so closing the menu does not cancel an action. */
export function usePluginUiCommandMenu(input: PluginUiClientTarget & {
  active?: boolean; connected?: boolean; readOnly?: boolean;
}) {
  const definitions = usePluginShortcutDefinitions();
  const declared = definitions.some(definition => definition.points?.includes(input.point));
  const state = usePluginUiContributions({ ...input, active: input.active !== false && declared });
  return { ...state, views: state.views.filter(view => !!view.command) };
}

export function PluginUiCommandMenuItems({ menu }: { menu: ReturnType<typeof usePluginUiCommandMenu> }) {
  return <>{menu.views.map(view => {
    const action = view.actions.find(item => item.id === 'run');
    if (!action) return null;
    return <DropdownMenuItem key={view.viewId} className={MENU_ITEM_CLASS}
      disabled={menu.disabled || menu.pending.has(view.viewId) || action.disabled}
      onSelect={event => { event.stopPropagation(); void menu.invoke(view, 'run', {}); }}>
      {view.command ? <PluginUiCommandIcon shortcutId={view.command.shortcutId} /> : null}
      {action.label}
    </DropdownMenuItem>;
  })}</>;
}

export function PluginUiCommandMenuStatus({ menu }: { menu: ReturnType<typeof usePluginUiCommandMenu> }) {
  const { t } = useTranslation();
  return menu.error && menu.views.length
    ? <span role="status" className="text-12 text-[var(--text-secondary)]">{t(`pluginUi.${menu.error}`)}</span>
    : null;
}
