import { useState } from 'react';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { mountPage, subscription } from '../../ui-page/harness';
import {
  FolderPickerPopover,
  type FolderPickerOption,
} from '../../../src/renderer/components/new-chat/FolderPickerPopover';

const NAMES = ['北极星看板', '晨雾笔记', '青柠商城', '星图编辑器', '雾灯监控', '蓝鲸数据台', '纸飞机客服',
  '木星排期', '松果相册', '海盐设计库', '极光推送', '山茶表单', '白桦文档', '银杏地图', '火烈鸟测试'];
const PROJECTS: FolderPickerOption[] = NAMES.map((name, i) => ({
  path: `D:/work/${name}`,
  name,
  description: i % 2 === 0 ? `D:/work/${name}` : undefined,
}));

/**
 * The mode pill sits where it does on the new-task page: below the 46px content
 * header plus max(96px, 28vh) top padding, 22px into the content column.
 */
function ProjectMenuFixture() {
  const [open, setOpen] = useState(false);
  return (
    <div className="fixed inset-0">
      <div
        className="absolute left-1/2 w-[720px] -translate-x-1/2"
        style={{ top: 'calc(46px + max(96px, 28vh))' }}
      >
        <div className="absolute right-0 top-[22px] z-10 inline-flex items-center gap-2">
          <FolderPickerPopover
            open={open}
            onOpenChange={setOpen}
            onSelect={() => undefined}
            projectOptions={PROJECTS}
            onAddRemoteProject={() => undefined}
            onCreateProject={() => undefined}
            side="bottom"
            align="end"
            sideOffset={6}
          >
            <button type="button" data-testid="open-project-menu"
              className="inline-flex h-[30px] items-center rounded-full border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] px-3 text-12 font-medium text-[var(--create-agent-control-text)]">
              对话
            </button>
          </FolderPickerPopover>
        </div>
        <div className="mt-[60px] h-[120px] rounded-[18px] border border-[var(--create-agent-control-border)]" />
      </div>
    </div>
  );
}

setDataOwnerGeneration('fixture', 1);

mountPage({
  host: () => ({
    platform: 'win32',
    localDb: {
      projectAliases: {
        snapshot: async () => ({ aliases: [], icons: {}, platform: 'win32', settingsSupported: true,
          settingsVersion: 5, ownerStamp: { dataOwnerId: 'fixture', ownerGeneration: 1 } }),
        autoIcon: async () => ({ image: null, candidate: false, source: null, kind: 'local' }),
        list: async () => [],
        onChanged: subscription('project-aliases-changed'),
      },
    },
  }),
  render: () => <ProjectMenuFixture />,
});
