import { Component, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginUiView } from '@cindy/maker-shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';

/** The Host already sorted contributions. Overflow is local viewing state and
 * keeps plugin controls outside the composer's send/stop controls. */
export function PluginUiOutlet({ views, render, children }: {
  views: PluginUiView[]; render(view: PluginUiView): ReactNode; children?: ReactNode;
}) {
  const { t } = useTranslation(); const [expanded, setExpanded] = useState<string>();
  const overflow = views.slice(2), selected = overflow.find(v => v.viewId === expanded);
  if (!views.length) return null;
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2" data-plugin-ui-outlet>
    {views.slice(0, 2).map(view => <div key={view.viewId} className="min-w-0 max-w-full"><ContributionBoundary revision={view.revision} fallback={view.fallbackMarkdown}><ContributionContent view={view} render={render} /></ContributionBoundary></div>)}
    {overflow.length ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="secondary" tone="quiet" compact>{t('pluginUi.more')}</Button></DropdownMenuTrigger>
      <DropdownMenuContent>{overflow.map(view => <DropdownMenuItem key={view.viewId} onSelect={() => setExpanded(view.viewId)}>{view.contributionId}</DropdownMenuItem>)}</DropdownMenuContent>
    </DropdownMenu> : null}
    {selected ? <div className="w-full min-w-0 max-h-64 overflow-y-auto" key={selected.viewId}>
      <Button size="sm" variant="secondary" tone="quiet" compact onClick={() => setExpanded(undefined)}>{t('pluginUi.close')}</Button>
      <ContributionBoundary revision={selected.revision} fallback={selected.fallbackMarkdown}><ContributionContent view={selected} render={render} /></ContributionBoundary>
    </div> : null}
    {children}
  </div>;
}
function ContributionContent({ view, render }: { view: PluginUiView; render(view: PluginUiView): ReactNode }) { return render(view); }
class ContributionBoundary extends Component<{ children: ReactNode; fallback: string; revision: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<{ revision: string }>) { if (this.state.failed && previous.revision !== this.props.revision) this.setState({ failed: false }); }
  render() { return this.state.failed ? <span role="status">{this.props.fallback}</span> : this.props.children; }
}
