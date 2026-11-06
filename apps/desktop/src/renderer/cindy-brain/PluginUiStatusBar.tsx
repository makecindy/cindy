import { useTranslation } from 'react-i18next';
import { usePluginUiContributions } from './usePluginUiContributions';
import { usePluginUiVisibilityValues } from './usePluginUiVisibility';

/** Inline content in the existing footer. The surrounding row owns its height
 * and space; an empty contribution does not create a placeholder. */
export function PluginUiStatusBar({ sessionId, deviceId, active = true, readOnly = false }: {
  sessionId?: string; deviceId?: string; active?: boolean; readOnly?: boolean;
}) {
  const visibility = usePluginUiVisibilityValues();
  const state = usePluginUiContributions({ sessionId, deviceId, point: 'session.statusbar',
    active: active && visibility.workspace, readOnly });
  const { t } = useTranslation();
  if (!state.views.length) return null;
  return <div data-plugin-ui-statusbar className="flex h-5 min-w-0 flex-1 items-center gap-2 overflow-hidden text-12 font-medium leading-none text-[var(--text-secondary)]">
    {state.views.map(view => <div key={view.viewId} className="flex min-w-0 items-center gap-1" aria-busy={state.pending.has(view.viewId)}>
      {view.controls.map(control => control.kind === 'status'
        ? <span key={control.id} aria-label={control.label} title={control.text} className="min-w-0 truncate">{control.text}</span>
        : control.kind === 'button'
          ? <button key={control.id} type="button" title={control.label}
              className="h-5 min-w-0 truncate rounded-full px-1 transition-colors hover:bg-[var(--button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50"
              disabled={state.disabled || state.pending.has(view.viewId) || control.disabled ||
                !view.actions.some(action => action.id === control.actionId && !action.disabled)}
              onClick={() => { void state.invoke(view, control.actionId, {}); }}>{control.label}</button>
          : null)}
      {!view.controls.length ? <span title={view.fallbackMarkdown} className="min-w-0 truncate">{view.fallbackMarkdown}</span> : null}
    </div>)}
    {state.error ? <span role="status" className="min-w-0 truncate">{t(`pluginUi.${state.error}`)}</span> : null}
  </div>;
}
