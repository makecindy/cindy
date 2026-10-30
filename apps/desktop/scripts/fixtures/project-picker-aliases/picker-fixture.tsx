import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { useProjectPickerOptions } from '../../../src/renderer/hooks/useProjectPickerOptions';
import { FolderPickerPopover } from '../../../src/renderer/components/new-chat/FolderPickerPopover';
import { SessionProjectMoveSubmenu } from '../../../src/renderer/features/cc-agent/sidebar/SessionProjectMoveSubmenu';
import { Button } from '../../../src/renderer/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../../src/renderer/components/ui/dropdown-menu';

function PickerFixture() {
  const options = useProjectPickerOptions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const { t } = useTranslation();
  return <div className="p-8">
    {ctx.case.startsWith('move') ? <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild><Button data-testid="open-picker">{t('ccAgent.sidebar.sessionMenu.moveToProjectHeading')}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <SessionProjectMoveSubmenu projectOptions={options}
          currentSession={{ projectDir: 'D:/work/cindy', workingDir: 'D:/tmp/checkout' }}
          isDialogue={ctx.case !== 'move-explicit-project'} onSelectProject={setSelected} />
      </DropdownMenuContent>
    </DropdownMenu> : <FolderPickerPopover open={open} onOpenChange={setOpen} projectOptions={options}
      onSelect={path => setSelected(path)}>
      <Button data-testid="open-picker">{t('newChat.folderPicker.dialogueOrSelectProject')}</Button>
    </FolderPickerPopover>}
    <output data-testid="selected-path" className="mt-6 block text-sm">{selected}</output>
  </div>;
}

mountPage({
  host: () => ({
    platform: 'win32',
    localDb: {
      recentWorkdirs: { list: async () => [
        { path: 'D:/work/cindy', exists: true, lastUsedAt: '2026-10-29T00:00:00.000Z' },
        { path: 'D:/archive/cindy', exists: true, lastUsedAt: '2026-10-28T00:00:00.000Z' },
      ] },
      projectAliases: {
        list: async () => [{ projectKey: 'local:d:/WORK/Cindy', alias: '项目新名称 · Cindy', updatedAt: '2026-10-29T00:00:00.000Z' }],
        onChanged: subscription('project-aliases-changed'),
      },
    },
  }),
  render: () => <PickerFixture />,
});
