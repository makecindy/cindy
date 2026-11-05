import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PluginUiControls } from './PluginUiControls';
import { PluginUiPageView } from './PluginUiPageView';
import { useElementVisible } from './ghostUnreadStore';
import { usePluginUiContributions } from './usePluginUiContributions';

/** Keep the saved record available even when its chosen renderer disappears. */
export function PluginUiRendererView({ sessionId, point, target, active = true, children }: {
  sessionId: string; point: 'message.body' | 'tool.body'; target: { kind: string; id: string };
  active?: boolean; children: ReactNode;
}) {
  if (!active) return children;
  return <ActivePluginUiRendererView sessionId={sessionId} point={point} target={target}>{children}</ActivePluginUiRendererView>;
}

function ActivePluginUiRendererView({ sessionId, point, target, children }: {
  sessionId: string; point: 'message.body' | 'tool.body'; target: { kind: string; id: string }; children: ReactNode;
}) {
  const { t } = useTranslation();
  const visibility = useElementVisible();
  const state = usePluginUiContributions({ sessionId, point, target, active: visibility.visible, readOnly: true });
  const view = state.renderer?.selected ? state.views[0] : undefined;
  return <div ref={visibility.ref} className="min-w-0 max-w-full">
    {state.renderer?.candidates.length ? <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="sm" variant="secondary" tone="quiet" disabled={state.choosing}>{t('pluginUi.renderer')}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => { void state.chooseRenderer(null); }}>{t('pluginUi.original')}</DropdownMenuItem>
        {state.renderer.candidates.map(candidate => <DropdownMenuItem
          key={JSON.stringify([candidate.instanceId, candidate.contributionId])}
          onSelect={() => { void state.chooseRenderer({ instanceId: candidate.instanceId, contributionId: candidate.contributionId }); }}>
          {candidate.pluginName} · {candidate.contributionId}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu> : null}
    {view ? <RendererBoundary key={view.viewId} revision={view.revision} fallback={children}>
      {view.page ? <PluginUiPageView sessionId={sessionId} viewId={view.viewId} revision={view.revision}
        title={view.contributionId} fallback={children}>
        <details><summary className="cursor-pointer text-12 text-[var(--text-secondary)]">{t('chat.ghostHook.viewOriginal')}</summary>{children}</details>
      </PluginUiPageView> : <>
        <PluginUiControls view={view} disabled={state.disabled} pending={state.pending.has(view.viewId)}
          onAction={(actionId, values) => { void state.invoke(view, actionId, values); }} />
        <details><summary className="cursor-pointer text-12 text-[var(--text-secondary)]">{t('chat.ghostHook.viewOriginal')}</summary>{children}</details>
      </>}
    </RendererBoundary> : children}
    {state.error ? <span role="status" className="text-12 text-[var(--text-secondary)]">{t(`pluginUi.${state.error}`)}</span> : null}
  </div>;
}

class RendererBoundary extends Component<{ children: ReactNode; fallback: ReactNode; revision: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<{ revision: string }>) {
    if (this.state.failed && previous.revision !== this.props.revision) this.setState({ failed: false });
  }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
