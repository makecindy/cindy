import * as React from 'react';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import type { ProjectNode } from '../../../src/renderer/features/cc-agent/lib/projectGrouping';
import type { SidebarTaskInput } from '../../../src/renderer/features/cc-agent/lib/sidebarTaskPresentation';
import { mountPage } from '../../ui-page/harness';
import { createSidebarTaskPresentation } from '../../../src/renderer/features/cc-agent/sidebar/sidebarTaskPresentationView';
import '../../../src/renderer/features/cc-agent/sidebar/sidebarTaskPresentation.css';
const owner = { dataOwnerId: 'fixture', generation: 1 };
const snapshot = {
  owner,
  scopes: [{ botId: 'cindy', delegatedSessionIds: ['child'] }],
  profiles: [{ id: 'cindy', name: 'Cindy', sessions: [{ id: 'parent', role: 'canonical' }] }],
};
const v = createSidebarTaskPresentation(React, {
  useSnapshot: () => snapshot,
  isOwnerCurrent: () => true,
  useLanguage: () => 'zh-CN',
  readSession: async () => null,
});
const base = { status: 'active', remoteHostId: null, deviceLinkDeviceId: null };
const normal = {
  ...base,
  id: 'normal',
  title: '正常工作项目',
  workingDir: '/work/product',
} as Session;
const manual = {
  ...base,
  id: 'manual',
  title: '明确新建的验收任务',
  workingDir: '/Home/bots/cindy/workspace/diagnostics/2026-10-27-terra',
} as Session;
const child = {
  ...base,
  id: 'child',
  parentSessionId: 'parent',
  title: 'Terra 选择 Claude Code 后实际调用验证',
  workingDir: manual.workingDir,
} as Session;
const project = (key: string, dir: ProjectNode['workingDir'], sessions: Session[]) =>
  ({
    projectKey: key,
    workingDir: dir,
    scope: 'local',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    sessions,
  }) as ProjectNode;
function List(p: SidebarTaskInput) {
  return (
    <>
      {p.projects.map((x) => (
        <div key={x.projectKey} style={{ margin: '10px 0' }}>
          <div style={{ padding: '8px 12px', color: 'var(--text-secondary)' }}>
            ▱ {x.projectKey}
          </div>
          {x.sessions.map((s) => (
            <React.Fragment key={s.id}>
              {v.wrapRow(<div style={{ padding: '10px 16px', fontSize: 13 }}>{s.title}</div>, {
                session: s,
                navigate: () => {},
              })}
            </React.Fragment>
          ))}
        </div>
      ))}
    </>
  );
}
mountPage({
  host: () => ({}),
  render: () => (
    <div
      style={{
        width: 260,
        maxWidth: '100%',
        padding: 8,
        background: 'var(--bg-sidebar)',
        color: 'var(--text-primary)',
        height: '100vh',
      }}
    >
      <div style={{ padding: 12 }}>全部任务</div>
      <v.Section
        Original={List}
        projects={[
          project('Product', normal.workingDir, [normal]),
          project('2026-10-27-terra', manual.workingDir, [manual, child]),
        ]}
        dialogues={[]}
        unclassified={[]}
      />
    </div>
  ),
});
