import { useState } from 'react';
import { FolderPickerPopover } from '../../../src/renderer/components/new-chat/FolderPickerPopover';
import { Button } from '../../../src/renderer/components/ui/button';
import { ProjectChip } from '../../../src/renderer/features/scheduler/components/ScheduleChips';
import { ctx, mountPage } from '../../ui-page/harness';

function PickerFixture() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [kind, setKind] = useState<'dialogue' | 'project'>('dialogue');
  const [destination, setDestination] = useState('');
  const recent = ctx.case === 'recent';
  const projects = Array.from({ length: 12 }, (_, i) => ({
    name: `Project ${i}`, path: `/synthetic/project-${i}`, description: `/synthetic/project-${i}`,
  }));
  return <div style={{ position: 'fixed', top: '28vh', right: 32 }}>
    {ctx.case === 'schedule' ? <div data-testid="schedule-trigger">
      <ProjectChip value={selected} workspaceKind={kind} projectOptions={projects}
        onChange={setSelected} onChangeWorkspaceKind={setKind} onChangeDestination={setDestination} />
    </div> :
    <FolderPickerPopover open={open} onOpenChange={setOpen}
      projectOptions={recent ? undefined : projects}
      onSelect={path => setSelected(path)}
      onAddRemoteProject={recent ? undefined : () => setSelected('remote')}
      onCreateProject={recent ? undefined : () => setSelected('create')}>
      <Button data-testid="open-picker">Choose project</Button>
    </FolderPickerPopover>}
    <output data-testid="selected-path" data-kind={kind} data-destination={destination} data-ui-page-control>{selected}</output>
  </div>;
}

mountPage({
  host: () => ({ platform: 'darwin', showOpenDirectoryDialog: async () => ({ canceled: true }) }),
  render: () => {
    if (ctx.case === 'recent') localStorage.setItem('cc-agent-recent-folders', JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({ name: `Recent ${i}`, path: `/synthetic/recent-${i}` })),
    ));
    return <PickerFixture />;
  },
});
