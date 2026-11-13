// UI-check scene data only; this entry is never imported by the application.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuTrigger } from '../../../src/renderer/components/ui/dropdown-menu';
import { SessionTaskMenu } from '../../../src/renderer/features/cc-agent/sidebar/SessionTaskMenu';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

function Fixture({ removed }: { removed: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  const session = { id: 'fixture-task', title: 'Fixture task', status: 'active', agentKind: 'pi',
    runtimePluginsSelected: removed } as Session;
  return <div className="p-8">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger ref={trigger} data-ui-page-control>Fixture menu</DropdownMenuTrigger>
      <SessionTaskMenu session={session} open={open} writeBlocked={false}
        returnFocus={() => trigger.current?.focus()}
        onRename={forbid('rename')} onPin={forbid('pin')} onArchive={forbid('archive')}
        onUnarchive={forbid('unarchive')} onDelete={forbid('delete')}
        onOpenInNewWindow={forbid('openInNewWindow')}
        move={null} tags={null} copy={null} exportShare={null} />
    </DropdownMenu>
    <p data-ui-page-control>{t('runtimePlugins.title')} — UI-check fixture only</p>
  </div>;
}

void mountPage({
  route: '/',
  host: ctx => ({
    ghosts: {
      listSync: () => ({ ghosts: ctx.case === 'one-control' ? [{ manifest: {
        id: 'fixture-context', subscribe: { hooks: ['will-compose-context'] },
      } }] : [] }),
      onChanged: subscription('installedGhosts'),
      runtimePlugins: async (_id: string, value?: unknown) => {
        if (value !== undefined) return forbid('runtimePlugins.save')();
        return ctx.case === 'removed-selection'
          ? { 'will-compose-context': [{ pluginId: 'removed', onFailure: 'block' }] } : {};
      },
      listControlPointCandidates: async (point: string) => ctx.case === 'one-control' && point === 'will-compose-context'
        ? [{ pluginId: 'fixture-context', name: 'Context fixture plugin' }] : [],
    },
    sharedTask: { host: async () => ({ available: false, detail: null }) },
  }),
  render: ctx => <Fixture removed={ctx.case === 'removed-selection'} />,
});
