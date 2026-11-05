import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import type { PluginUiView, PluginUiInvokeInput } from '@cindy/maker-shared';
import { PluginUiBlocks } from './PluginUiBlocks';
import { PluginUiCommandIcon } from './PluginUiCommandIcon';
import { PluginUiOutlet } from './PluginUiOutlet';
import { PluginUiPageView } from './PluginUiPageView';
import { usePluginUiContributions } from './usePluginUiContributions';
import { usePluginUiVisibilityValues } from './usePluginUiVisibility';
import type { PluginUiClientTarget } from './pluginUiClient';

function actionAppearance(point: PluginUiView['point']) {
  const inline = point !== 'message.body' && point !== 'tool.body';
  return { size: inline ? 'sm' : 'md', tone: inline ? 'quiet' : 'default', compact: inline } as const;
}

export function PluginUiControls({ view, onAction, pending = false, disabled = false }: {
  view: PluginUiView; pending?: boolean; disabled?: boolean;
  onAction(actionId: string, values: PluginUiInvokeInput['values']): void;
}) {
  const appearance = actionAppearance(view.point);
  const unavailable = (actionId: string) => !view.actions.some(a => a.id === actionId && !a.disabled);
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2" aria-busy={pending}>
    {view.controls.map(control => control.kind === 'status'
      ? <span key={control.id} aria-label={control.label} className="min-w-0 break-words text-12 text-[var(--text-secondary)]">{control.text}</span>
      : control.kind === 'button'
        ? <Button key={control.id} variant="secondary" {...appearance}
            className={`h-auto ${appearance.compact ? 'min-h-7' : 'min-h-8 py-1'} max-w-full whitespace-normal break-words`}
            disabled={disabled || pending || control.disabled || unavailable(control.actionId)}
            onClick={() => onAction(control.actionId, {})}>
            {view.command ? <PluginUiCommandIcon shortcutId={view.command.shortcutId} /> : null}{control.label}</Button>
        : <Select key={control.id} label={control.label} value={control.value} options={control.options}
            className="max-w-full" disabled={disabled || pending || control.disabled || unavailable(control.actionId)}
            onValueChange={value => onAction(control.actionId, { [control.id]: value })} />)}
    <PluginUiBlocks blocks={view.blocks} fallback={!view.controls.length ? view.fallbackMarkdown : undefined} />
  </div>;
}

export function PluginUiContributionControls(props: PluginUiClientTarget & { active?: boolean; connected?: boolean; readOnly?: boolean }) {
  const state = usePluginUiContributions(props); const { t } = useTranslation();
  if (!state.views.length) return null;
  return <PluginUiOutlet views={state.views} render={view => view.page && props.sessionId
    ? <PluginUiPageTrigger key={view.viewId} sessionId={props.sessionId} view={view} disabled={state.disabled}
        pending={state.pending.has(view.viewId)} onAction={(actionId, values) => { void state.invoke(view, actionId, values); }} />
    : <PluginUiControls key={view.viewId} view={view}
      pending={state.pending.has(view.viewId)} disabled={state.disabled}
      onAction={(actionId, values) => { void state.invoke(view, actionId, values); }} />}>
    {state.error ? <span role="status" className="w-full text-12 text-[var(--text-secondary)]">{t(`pluginUi.${state.error}`)}</span> : null}
  </PluginUiOutlet>;
}

function PluginUiPageTrigger({ sessionId, view, disabled, pending, onAction }: {
  sessionId: string; view: PluginUiView; disabled: boolean; pending: boolean;
  onAction(actionId: string, values: PluginUiInvokeInput['values']): void;
}) {
  const [open, setOpen] = useState(false);
  const visibility = usePluginUiVisibilityValues();
  // Refreshing disables stale actions, not an already open page. The parent
  // unmounts this trigger when its contribution or viewing scope disappears.
  const available = visibility.workspace;
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  const label = view.controls.find(control => control.kind === 'button')?.label ?? view.actions[0]?.label ?? view.contributionId;
  return <Popover open={open && available} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="secondary" {...actionAppearance(view.point)} disabled={disabled}>{label}</Button></PopoverTrigger>
    {open && available ? <PopoverContent align="start" className="w-[min(360px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-2">
      <PluginUiPageView sessionId={sessionId} viewId={view.viewId} revision={view.revision} title={view.contributionId}
        fallback={<PluginUiControls view={view} pending={pending} disabled={disabled} onAction={onAction} />} />
    </PopoverContent> : null}
  </Popover>;
}
