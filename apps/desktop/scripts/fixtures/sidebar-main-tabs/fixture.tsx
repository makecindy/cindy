import { useState } from 'react';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { ctx, mountPage } from '../../ui-page/harness';
import { SidebarMainTabs } from '../../../src/renderer/features/cc-agent/sidebar/SidebarMainTabs';
import { MachineTabStrip } from '../../../src/renderer/features/cc-agent/sidebar/MachineSwitcherMenu';
import { SessionItem } from '../../../src/renderer/features/cc-agent/sidebar/SessionItem';
import type { SidebarMainTab } from '../../../src/renderer/features/cc-agent/sidebar/sidebarMainTab';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
const noop = () => {};
const now = Date.now();
const session = (id: string, title: string, minutes: number) =>
  ({
    id, title, status: 'active', source: 'user',
    createdAt: new Date(now - minutes * 60_000).toISOString(),
    updatedAt: new Date(now - minutes * 60_000).toISOString(),
    agentKind: 'codex', pinnedAt: null, sdkSessionId: null, remoteHostId: null,
    deviceLinkDeviceId: null, workspaceKind: 'project', workingDir: '/example', _count: { messages: 3 },
  }) as Session;
const rows = [
  session('a', '通讯录中文选词与拼音搜索 #358 · 待审', 2),
  session('b', '[@zkyo·X] 研究调研一下此问题', 5),
  session('c', '模型组补全 · 伙伴 #11683 · 待重审', 90),
];
function Specimen() {
  const [tab, setTab] = useState<SidebarMainTab>('tasks');
  const content = new Set(ctx.case === 'single' ? ['local'] : ['local', 'rog', 'mini', 'studio']);
  return (
    <div data-specimen className="bg-sidebar text-foreground pt-2" style={{ width: 300 }}>
      <div className="flex flex-col">
        <SidebarMainTabs tab={tab} onTabChange={setTab} attention={{ tasks: false, buddies: true, chats: false, automations: false }}
          showFilterReminder={false} onOpenOrganize={noop} />
        <MachineTabStrip machinesWithContent={content} onCreateProject={noop} />
      </div>
      <div className="flex flex-col gap-0.5 pt-2 pl-3">
        {rows.map((s, i) => (
          <SessionItem key={s.id} session={s} isActive={false} isRunning={i < 2} hasAttentionNotification={false}
            onClick={noop} onAction={noop} onRename={noop} onTogglePin={noop} />
        ))}
      </div>
    </div>
  );
}
void mountPage({ route: '/cc-agent', render: () => <WorktreeProvider><Specimen /></WorktreeProvider> });
