import { SessionEntryList } from '../../../src/renderer/features/cc-agent/sidebar/SessionEntryList';
import { useState } from 'react';
import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { ProjectNode } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectNode';
import { SessionGroupNode } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectsSection';
import { SidebarActivityClock } from '../../../src/renderer/features/cc-agent/sidebar/SidebarActivityClock';
import { SIDEBAR_IDLE_COLLAPSE_KEY } from '../../../src/renderer/features/cc-agent/lib/sidebarCollapseConfig';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
setDataOwnerGeneration('fixture', 1);
if (ctx.data.idleDisabled) {
  // Verify the legacy activity window independently of the count floor.
  localStorage.setItem('sidebar.collapse.projectSessionLimit', '0');
} else if (ctx.data.inactive || ctx.data.idleOptIn) {
  localStorage.setItem(SIDEBAR_IDLE_COLLAPSE_KEY, 'true');
}
const noop = () => {};
const examples = [
  ['Cindy', null, ['完善项目设置界面，让桌面和手机保持一致', '检查手机端交互']],
  ['移动客户端', 'symbol:Smartphone:blue', ['适配窄屏布局']],
  ['设计规范', '🎨', ['整理组件与间距规范']],
  ['品牌网站', 'text:CY:blue', ['更新首页文案']],
  ['工具库', null, ['整理开发脚本']],
] as const;
const projects = examples.map(([name, icon, tasks], i) => ({
  projectKey: `local:/Projects/${name}`, workingDir: `/Projects/${name}`, displayName: name,
  scope: 'local' as const, remoteHostId: null, deviceLinkDeviceId: null, deviceLinkDeviceName: null,
  deviceLinkConnectionStatus: null, segments: 1, latestActivityAt: '',
  sessions: tasks.map((title, j) => ({id:`demo-${i}-${j}`, title, status:'active', source:'manual',
    createdAt:new Date().toISOString(),
    updatedAt:new Date(Date.now() - (ctx.data.inactive && (i > 0 || j > 0) ? 31 * 60_000 : 0)).toISOString(), agentKind:'codex',
    pinnedAt:null, sdkSessionId:null, remoteHostId:null, deviceLinkDeviceId:null, workspaceKind:'project',
    workingDir:`/Projects/${name}`, _count:{messages:5}} as Session)),
}));
const sessions = projects.flatMap(p => p.sessions);
function GroupsPreview() {
  const { t } = useTranslation();
  const shared = {
    collapsed: false, parentSectionCollapsed: false, disableSessionCollapse: false,
    isCreateDisabled: false, sessionVariant: 'text' as const,
    runningSessionIds: new Set<string>(), attachedSessionIds: new Set<string>(),
    notifications: new Set<string>(), scheduleSessionIndex: new Map(),
    onToggle: noop, onSessionClick: noop, onAction: noop, onRename: noop,
    onTogglePin: noop, onScheduleAction: noop,
  };
  const automation: Session = { ...projects[1].sessions[0], source: 'scheduler', title: '每周用量报告' };
  return <aside className="bg-sidebar text-foreground min-h-screen space-y-3 p-3" data-ui-page-subject>
    <section aria-label="Automation fixture">
      <SessionGroupNode {...shared} sessions={[automation]} groupTitle={t('ccAgent.layout.automations')} groupIcon={<Timer size={15} aria-hidden />}
        collapsed={!!ctx.data.collapsedAutomation}
        lamp={ctx.data.collapsedAutomation ? { running: false, dotTone: 'error' } : undefined} />
    </section>
    <section aria-label="Dialogue fixture">
      <SessionGroupNode {...shared} sessions={projects[0].sessions} onCreateDialogue={noop} />
    </section>
  </aside>;
}
function Preview() {
  const [collapsed, setCollapsed] = useState(new Set(projects.slice(3).map(p=>p.projectKey)));
  if (ctx.data.groups) return <GroupsPreview />;
  if (ctx.data.flat) return <aside className="bg-sidebar text-foreground min-h-screen p-3" data-ui-page-subject>
    <SessionEntryList sessions={sessions} collapsible={!!ctx.data.inactive} sessionVariant={ctx.data.flat === 'list' ? 'list' : 'text'}
      sourceLabelMap={new Map(projects.flatMap(project => project.sessions.map(session => [session.id, project.displayName] as const)))}
      activeSessionId="demo-0-0" runningSessionIds={new Set()} attachedSessionIds={new Set()} notifications={new Set()}
      scheduleSessionIndex={new Map()} onSessionClick={noop} onAction={noop} onRename={noop} onTogglePin={noop} onScheduleAction={noop} />
  </aside>;
  return <aside className="bg-sidebar text-foreground min-h-screen p-3" data-ui-page-subject>
    <div className="px-3 pb-3 pt-2 text-13 text-[var(--sidebar-list-muted)]">项目</div>
    <div className="flex flex-col gap-1">{projects.map(project => <ProjectNode key={project.projectKey} project={project}
      statusFilter="active" isCollapsed={collapsed.has(project.projectKey)} parentSectionCollapsed={false}
      activeSessionId="demo-0-0" runningSessionIds={new Set()} attachedSessionIds={new Set()} notifications={new Set()}
      scheduleSessionIndex={new Map()} disableSessionCollapse={!!ctx.data.filtered}
      onToggle={key=>setCollapsed(prev=>{const next=new Set(prev); if(next.has(key))next.delete(key);else next.add(key);return next;})}
      onSettings={noop} onRenameProject={async()=>{}}
      onSessionClick={noop} onAction={noop} onRename={noop} onTogglePin={noop} onScheduleAction={noop}
      onCreateInProject={noop} onOpenConversationSearch={noop} onOpenInExplorer={noop}
      onBrowseFiles={noop} onArchiveAll={noop} />)}</div>
  </aside>;
}
void mountPage({route:'/cc-agent', host:{localDb:{
  sessions:{get: async (id:string)=>sessions.find(s=>s.id===id)},
  projectAliases:{snapshot:async()=>({aliases:[],icons:Object.fromEntries(examples.filter(e=>e[1]).map(([name,icon])=>[`local:/Projects/${name}`,icon])),platform:'darwin',settingsSupported:true,settingsVersion:5,ownerStamp:{dataOwnerId:'fixture',ownerGeneration:1}}),onChanged:subscription('projectInfoChanged'),
    iconImage:async()=>ctx.data.avatarData as string,
    autoIcon:async(input:{projectKey:string})=>({image:input.projectKey==='local:/Projects/Cindy'?ctx.data.avatarData:null,source:'assets/icon.png',kind:'local',candidate:false})}
}},render:()=> <WorktreeProvider><SidebarActivityClock enabled={false}><Preview /></SidebarActivityClock></WorktreeProvider>});
