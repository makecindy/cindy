import { SessionEntryList } from '../../../src/renderer/features/cc-agent/sidebar/SessionEntryList';
import { useState } from 'react';
import { mountPage, subscription, ctx } from '../../ui-page/harness';
import { ProjectNode } from '../../../src/renderer/features/cc-agent/sidebar/sections/ProjectNode';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
setDataOwnerGeneration('fixture', 1);
const noop = () => {};
const examples = [
  ['Cindy', null, ['完善项目设置界面', '检查手机端交互']],
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
    createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), agentKind:'codex',
    pinnedAt:null, sdkSessionId:null, remoteHostId:null, deviceLinkDeviceId:null, workspaceKind:'project',
    workingDir:`/Projects/${name}`, _count:{messages:5}} as Session)),
}));
const sessions = projects.flatMap(p => p.sessions);
function Preview() {
  const [collapsed, setCollapsed] = useState(new Set(projects.slice(3).map(p=>p.projectKey)));
  if (ctx.data.flat) return <aside className="bg-sidebar text-foreground min-h-screen p-3" data-ui-page-subject>
    <SessionEntryList sessions={sessions} sessionVariant={ctx.data.flat === 'list' ? 'list' : 'text'}
      sourceLabelMap={new Map(projects.flatMap(project => project.sessions.map(session => [session.id, project.displayName] as const)))}
      activeSessionId="demo-0-0" runningSessionIds={new Set()} attachedSessionIds={new Set()} notifications={new Set()}
      scheduleSessionIndex={new Map()} onSessionClick={noop} onAction={noop} onRename={noop} onTogglePin={noop} onScheduleAction={noop} />
  </aside>;
  return <aside className="bg-sidebar text-foreground min-h-screen p-3" data-ui-page-subject>
    <div className="px-3 pb-3 pt-2 text-13 text-[var(--sidebar-list-muted)]">项目</div>
    <div className="flex flex-col gap-1">{projects.map(project => <ProjectNode key={project.projectKey} project={project}
      statusFilter="active" isCollapsed={collapsed.has(project.projectKey)} parentSectionCollapsed={false}
      activeSessionId="demo-0-0" runningSessionIds={new Set()} attachedSessionIds={new Set()} notifications={new Set()}
      scheduleSessionIndex={new Map()} disableSessionCollapse={false} isProjectPinned={false}
      onToggle={key=>setCollapsed(prev=>{const next=new Set(prev); if(next.has(key))next.delete(key);else next.add(key);return next;})}
      onToggleProjectPin={noop} onRenameProject={async()=>{}} onRemoveFromSidebar={noop}
      onSessionClick={noop} onAction={noop} onRename={noop} onTogglePin={noop} onScheduleAction={noop}
      onCreateInProject={noop} onOpenConversationSearch={noop} onOpenInExplorer={noop} onImportFromTools={noop}
      onBrowseFiles={noop} onArchiveAll={noop} />)}</div>
  </aside>;
}
void mountPage({route:'/cc-agent', host:{localDb:{
  sessions:{get: async (id:string)=>sessions.find(s=>s.id===id)},
  projectAliases:{snapshot:async()=>({aliases:[],icons:Object.fromEntries(examples.filter(e=>e[1]).map(([name,icon])=>[`local:/Projects/${name}`,icon])),platform:'darwin',settingsSupported:true,settingsVersion:5,ownerStamp:{dataOwnerId:'fixture',ownerGeneration:1}}),onChanged:subscription('projectInfoChanged'),
    iconImage:async()=>ctx.data.avatarData as string,
    autoIcon:async(input:{projectKey:string})=>({image:input.projectKey==='local:/Projects/Cindy'?ctx.data.avatarData:null,source:'assets/icon.png',kind:'local',candidate:false})}
}},render:()=> <WorktreeProvider><Preview /></WorktreeProvider>});
