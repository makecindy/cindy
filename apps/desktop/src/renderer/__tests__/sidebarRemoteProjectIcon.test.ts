import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarDir = resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar');
const projectNodeSource = readFileSync(
  resolve(sidebarDir, 'sections', 'ProjectNode.tsx'),
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
    expect(sessionHeaderSource).toContain("import { RemoteProjectIcon } from './sidebar/RemoteProjectIcon'");
  });

  it('maps device-link sessions to the device-link project icon and SSH sessions to the SSH project icon', () => {
    expect(remoteProjectIconSource).toContain("kind === 'device-link' ? MonitorSmartphone : Globe");
    expect(sessionItemSource).toMatch(
      /const remoteIconKind = session\.deviceLinkDeviceId\s+\?\s+'device-link'\s+:\s+session\.remoteHostId\s+\?\s+'ssh'\s+:\s+null/,
    );
    expect(sessionCardSource).toContain(
      "const remoteIconKind = session.deviceLinkDeviceId ? 'device-link' : session.remoteHostId ? 'ssh' : null",
    );
    expect(sessionHeaderSource).toContain(
      "const remoteIconKind = session.deviceLinkDeviceId ? 'device-link' : session.remoteHostId ? 'ssh' : null",
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
      /<span className="min-w-0 flex flex-1 items-center gap-1\.5">[\s\S]*?<SidebarTitleMarquee[\s\S]*?\{remoteIconKind && \([\s\S]*?<RemoteProjectIcon/,
    );
    expect(sessionItemSource).toMatch(
      /<div className="group\/slot relative ml-auto flex h-6 shrink-0 items-center justify-end min-w-14">[\s\S]*?<WorktreeBadge[\s\S]*?<time/,
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
  });
});
