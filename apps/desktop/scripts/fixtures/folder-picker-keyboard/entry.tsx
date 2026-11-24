import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription } from '../../ui-page/harness';
import {
  FolderPickerPopover,
  type FolderPickerOption,
} from '../../../src/renderer/components/new-chat/FolderPickerPopover';
import { Button } from '../../../src/renderer/components/ui/button';

setDataOwnerGeneration('fixture', 1);

// 30 个项目:远超列表 252px 的可视高度,用来验证方向键把高亮带出可视区后仍看得见。
const projects: FolderPickerOption[] = Array.from({ length: 30 }, (_, index) => {
  const name = `project-${String(index + 1).padStart(2, '0')}`;
  return { path: `D:/work/${name}`, name, description: `D:/work/${name}` };
});

function Demo() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState('');
  const { t } = useTranslation();
  return (
    <div className="p-8">
      <FolderPickerPopover
        open={open}
        onOpenChange={setOpen}
        projectOptions={projects}
        onSelect={(path) => setSelected(path)}
      >
        <Button data-testid="open-picker">
          {t('newChat.folderPicker.dialogueOrSelectProject')}
        </Button>
      </FolderPickerPopover>
      <output data-testid="selected-path" className="mt-6 block text-sm">
        {selected}
      </output>
    </div>
  );
}

mountPage({
  host: () => ({
    platform: 'win32',
    localDb: {
      recentWorkdirs: { list: async () => [] },
      projectAliases: {
        snapshot: async () => ({
          aliases: [],
          icons: {},
          platform: 'win32',
          settingsSupported: true,
          settingsVersion: 5,
          ownerStamp: { dataOwnerId: 'fixture', ownerGeneration: 1 },
        }),
        autoIcon: async () => ({ image: null, candidate: false }),
        list: async () => [],
        onChanged: subscription('project-aliases-changed'),
      },
    },
  }),
  render: () => <Demo />,
});
