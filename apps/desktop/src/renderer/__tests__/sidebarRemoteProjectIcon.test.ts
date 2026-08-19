import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarDir = resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar');
const projectNodeSource = readFileSync(resolve(sidebarDir, 'sections', 'ProjectNode.tsx'), 'utf8');
const projectsSectionSource = readFileSync(
  resolve(sidebarDir, 'sections', 'ProjectsSection.tsx'),
  'utf8',
);
const sessionItemSource = readFileSync(resolve(sidebarDir, 'SessionItem.tsx'), 'utf8');
const sessionCardSource = readFileSync(resolve(sidebarDir, 'SessionCard.tsx'), 'utf8');
const remoteProjectIconSource = readFileSync(resolve(sidebarDir, 'RemoteProjectIcon.tsx'), 'utf8');
const sessionHeaderSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'SessionContentHeader.tsx'),
  'utf8',
);

describe('sidebar remote project icon', () => {
  it('uses one shared icon component for project headers and remote session rows', () => {
    expect(projectNodeSource).toContain("import { RemoteProjectIcon } from '../RemoteProjectIcon'");
    expect(sessionItemSource).toContain("import { RemoteProjectIcon } from './RemoteProjectIcon'");
    expect(sessionCardSource).toContain("import { RemoteProjectIcon } from './RemoteProjectIcon'");
    expect(sessionHeaderSource).toContain(
      "import { RemoteProjectIcon } from './sidebar/RemoteProjectIcon'",
    );
  });

  it('maps device-link sessions to the device-link project icon and SSH sessions to the SSH project icon', () => {
    expect(remoteProjectIconSource).toContain("kind === 'device-link' ? MonitorSmartphone : Globe");
    expect(sessionItemSource).toMatch(
      /const remoteIconKind = session\.deviceLinkDeviceId\s+\?\s+'device-link'\s+:\s+session\.remoteHostId\s+\?\s+'ssh'\s+:\s+null/,
    );
    expect(sessionCardSource).toMatch(
      /const remoteIconKind = session\.deviceLinkDeviceId\s+\?\s+'device-link'\s+:\s+session\.remoteHostId\s+\?\s+'ssh'\s+:\s+null/,
    );
    expect(sessionHeaderSource).toMatch(
      /const remoteIconKind = session\.deviceLinkDeviceId\s+\?\s+'device-link'\s+:\s+session\.remoteHostId\s+\?\s+'ssh'\s+:\s+null/,
    );
  });

  it('does not use the generic link icon for remote session markers', () => {
    expect(sessionItemSource).not.toContain('Link2');
    expect(sessionCardSource).not.toContain('Link2');
  });

  it('renders a disconnected state through the shared remote icon', () => {
    expect(remoteProjectIconSource).toContain('MonitorOff');
    expect(remoteProjectIconSource).toContain("connectionStatus === 'disconnected'");
    expect(projectNodeSource).toContain('connectionStatus={project.deviceLinkConnectionStatus}');
    expect(sessionItemSource).toContain('connectionStatus={remoteIconConnectionStatus}');
    expect(sessionCardSource).toContain('connectionStatus={remoteIconConnectionStatus}');
    expect(sessionHeaderSource).toContain('connectionStatus={remoteIconConnectionStatus}');
  });

  it('keeps remote session icons next to titles instead of in the right-side time slots', () => {
    expect(sessionItemSource).toMatch(
      /<span[\s\S]*?className="min-w-0 flex flex-1 items-center gap-1\.5"[\s\S]*?<SidebarTitleMarquee[\s\S]*?\{remoteIconKind && \([\s\S]*?<RemoteProjectIcon/,
    );
    // C 期起右侧时间槽由 SessionInfoMeta 承担(任务信息复选),仍在同一让位容器内。
    expect(sessionItemSource).toMatch(
      /<div className="group\/slot relative ml-auto flex h-6 shrink-0 items-center justify-end">[\s\S]*?<WorktreeBadge[\s\S]*?<SessionInfoMeta/,
    );
    expect(sessionCardSource).toContain('function TimeActionsSlot');
    expect(sessionCardSource).not.toMatch(/function TimeActionsSlot[\s\S]*?remoteIconKind/);
  });

  it('lets the title text shrink before the adjacent remote icon instead of pushing the icon to the row edge', () => {
    expect(sessionItemSource).toContain(
      'className="sidebar-title-marquee min-w-0 max-w-full shrink overflow-hidden"',
    );
    expect(sessionItemSource).not.toContain('<span className="min-w-0 flex-1 truncate">');
    expect(sessionCardSource).not.toContain("'min-w-0 flex-1 truncate'");
    // 项目行同规(2026-08-12 用户裁决):项目名 shrink 而非 flex-1,远程图标紧跟
    // 名字而不是被推到行尾。
    expect(projectNodeSource).toContain(
      '<span className="min-w-0 max-w-full shrink truncate">{project.displayName}</span>',
    );
    expect(projectNodeSource).not.toContain(
      '<span className="min-w-0 flex-1 truncate">{project.displayName}</span>',
    );
  });

  // 2026-08-12 用户裁决:设备段头的条数去掉——它数的是顶层条目(项目行 + 散排对话
  // + 对话组)而非任务数,读起来只会误导;「离线」标签接手 ml-auto 保持靠右。
  it('drops the entry count from the device group header', () => {
    expect(projectsSectionSource).not.toContain('{section.entries.length}');
    expect(projectsSectionSource).toContain(
      '<span className="ml-auto shrink-0 text-xs text-[var(--cmd-palette-item-meta)]">',
    );
  });

  // 2026-08-17 用户裁决:绿点容易被误认成未读标记。在线是设备段的常态,不额外画点;
  // 离线仍保留灰点 + 文字,异常状态不能静默。
  it('shows a status dot only for offline device group headers', () => {
    expect(projectsSectionSource).not.toContain('bg-[var(--card-status-done)]');
    expect(projectsSectionSource).toMatch(
      /\{!online && \([\s\S]*?bg-\[var\(--text-tertiary\)\][\s\S]*?\)\}/,
    );
    expect(projectsSectionSource).toContain("t('ccAgent.sidebar.deviceGroup.offline')");
  });

  // 2026-08-12 用户裁决:按设备分组时列表已按设备切段、段头写着设备名,项目行不再
  // 重复标注归属;远程图标保留(表达「远程 + 连接状态」,不重复归属信息)。
  it('drops the per-row machine label while device grouping is active, keeping the remote icon', () => {
    expect(projectNodeSource).toContain('hideRemoteMachineLabel = false');
    expect(projectNodeSource).toContain(
      '{!isEditingName && remoteIdentity && !hideRemoteMachineLabel ? (',
    );
    // 远程图标的渲染条件不受该开关影响。
    expect(projectNodeSource).toMatch(/\{!isEditingName && isDeviceLink \? \(/);
    expect(projectsSectionSource).toContain('hideRemoteMachineLabel={deviceGroupingActive}');
  });
});
