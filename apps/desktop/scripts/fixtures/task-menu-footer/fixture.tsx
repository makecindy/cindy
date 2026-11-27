// Scene data only: exercise the production menu without modifying real tasks.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from '../../../src/renderer/components/ui/dropdown-menu';
import { SessionTaskMenu } from '../../../src/renderer/features/cc-agent/sidebar/SessionTaskMenu';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { mountPage, subscription } from '../../ui-page/harness';

function Fixture() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const slot = (key: string) => <DropdownMenuItem>{t(`ccAgent.sidebar.sessionMenu.${key}`)}</DropdownMenuItem>;
  return <div className="flex h-screen items-center justify-center">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger ref={trigger} onContextMenu={event => { event.preventDefault(); setOpen(true); }}>Fixture task</DropdownMenuTrigger>
      <SessionTaskMenu session={{ id: 'fixture-task', title: 'Fixture task', status: 'active', _count: { messages: 1 } } as Session}
        open={open} writeBlocked={false} returnFocus={() => trigger.current?.focus()}
        onRename={() => {}} onPin={() => {}} onArchive={() => {}} onUnarchive={() => {}}
        onDelete={() => setConfirmation(true)} onOpenInNewWindow={() => {}}
        move={slot('moveToProject')} tags={<DropdownMenuItem>{t('taskTags.title')}</DropdownMenuItem>} copy={slot('copySessionLink')} exportShare={slot('exportShare')} />
    </DropdownMenu>
    {confirmation && <div role="dialog"><button onClick={() => setConfirmation(false)}>Cancel fixture deletion</button></div>}
  </div>;
}

void mountPage({
  route: '/',
  host: () => ({
    ghosts: { listSync: () => ({ ghosts: [] }), onChanged: subscription('installedGhosts') },
    deviceLink: { listDevices: async () => ({ devices: [] }) },
    sharedTask: { host: async () => ({ available: false, detail: null }) },
  }),
  render: () => <Fixture />,
});
