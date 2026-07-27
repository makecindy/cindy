import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDocModeSwitchProjects,
  hasSwitchableDocModeProject,
  resolveDocModeFilesSession,
  shouldIgnoreDocModeProjectSwitch,
} from '@/features/cc-agent/workdir-browse/lib/docModeSwitchProjects';
import type { Session } from '@/lib/ccAgent.types';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

const routeSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseRoute.tsx'),
  'utf8',
);

const sidebarBrowseSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'WorkdirBrowseSidebar.tsx'),
  'utf8',
);

const dirtyConfirmSource = readFileSync(
  resolve(
    __dirname,
    '..',
    'features',
    'cc-agent',
    'workdir-browse',
    'hooks',
    'useConfirmSwitchAwayIfDirty.ts',
  ),
  'utf8',
);

const fileContentSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'workdir-browse', 'hooks', 'useFileContent.ts'),
  'utf8',
);

let sessionSeq = 0;
function session(partial: Partial<Session>): Session {
  sessionSeq += 1;
  const updatedAt = partial.updatedAt ?? `2026-06-15T00:00:${String(sessionSeq).padStart(2, '0')}.000Z`;
  return {
    id: partial.id ?? `s-${sessionSeq}`,
    userId: 'u',
    title: partial.title ?? `session ${sessionSeq}`,
    workingDir: partial.workingDir !== undefined ? partial.workingDir : '/repo/app',
    workspaceKind: partial.workspaceKind ?? 'project',
    model: 'm',
    effort: 'medium' as Session['effort'],
    permissionMode: 'default' as Session['permissionMode'],
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: partial.pinnedAt ?? null,
    userSendAt: partial.userSendAt ?? updatedAt,
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    remoteHostId: partial.remoteHostId ?? null,
    extraDirs: partial.extraDirs ?? [],
    createdAt: partial.createdAt ?? updatedAt,
    updatedAt,
    _count: partial._count,
  };
}

describe('workdir browse remote safety', () => {
  it('sends remote project Browse Files to the normal session view', () => {
    expect(sidebarSource).toContain("if (project.scope === 'remote')");
    expect(sidebarSource).toContain('navigate(`/cc-agent/${id}`)');
    expect(sidebarSource).toContain('navigate(`/cc-agent/files/${id}`)');
  });

  it('routes remote sessions through the remote file-service instead of local fs', () => {
    // 旧安全语义是"remote 直接 redirect 走人"(防止拿远端路径读本机 fs);
    // 现在 remote 会话由 main 按 remoteHostId 路由到远端 file-service,新的
    // 安全语义变成:doc 模式的读(useFileContent)与写(FileBodyView 保存)
    // 必须显式携带 remoteHostId,漏传 = 远端路径落到本机 fs 上。
    // 三路归属:device-link 会话 deviceId 优先(嵌套时其 remoteHostId 是被控端的
    // SSH host,由被控端 device-op 二跳,控制端不得把它发给自己的 main)。
    expect(routeSource).toContain('const remoteHostId = deviceId ? null : currentSession?.remoteHostId ?? null');
    expect(routeSource).toContain('useFileContent(browsableWorkdir, selectedPath, remoteHostId, deviceId)');
    expect(routeSource).toContain('remoteHostId={remoteHostId}');
    expect(routeSource).toContain('deviceId={deviceId}');
    // sidebar 侧同理:树 / 文件名索引 / 搜索 / 增删改全部带 remoteHostId,
    // 且"显示所在文件夹"这类本机-only 菜单在 remote 下不可用。
    expect(sidebarBrowseSource).toContain('useFileTree({ workdir, remoteHostId, deviceId,');
    expect(sidebarBrowseSource).toContain('useProjectFileList(workdir, remoteHostId, deviceId, {');
    expect(sidebarBrowseSource).toContain('remoteHostId || deviceId ? undefined : handleRevealInFolder');
  });

  it('uses project identity when listing same-project session tabs', () => {
    expect(routeSource).toContain('projectIdentityKeyForSession');
    expect(routeSource).toContain('projectIdentityKeyForSession(s) === currentProjectKey');
  });

  it('only offers local projects with active sessions in the doc-mode project switcher', () => {
    const projects = buildDocModeSwitchProjects([
      session({ id: 'active-local', workingDir: '/repo/app' }),
      session({ id: 'archived-local', workingDir: '/repo/old', status: 'archived' }),
      session({ id: 'active-remote', workingDir: '/repo/remote', remoteHostId: 'host-1' }),
      session({ id: 'empty-workdir', workingDir: null }),
      session({
        id: 'active-dialogue',
        workingDir: '/repo/dialogue-scratch',
        workspaceKind: 'dialogue',
      }),
    ]);

    expect(projects).toEqual([
      {
        projectKey: 'local:/repo/app',
        displayName: 'app',
        sessionId: 'active-local',
        activeSessionCount: 1,
      },
    ]);
  });

  it('includes pinned active sessions when building doc-mode switch projects', () => {
    const projects = buildDocModeSwitchProjects([
      session({
        id: 'pinned-only',
        workingDir: '/repo/pinned-only',
        pinnedAt: '2026-06-15T00:00:00.000Z',
      }),
      session({
        id: 'mixed-unpinned',
        workingDir: '/repo/mixed',
        updatedAt: '2026-06-15T00:00:01.000Z',
      }),
      session({
        id: 'mixed-pinned-newer',
        workingDir: '/repo/mixed',
        pinnedAt: '2026-06-15T00:00:00.000Z',
        updatedAt: '2026-06-15T00:00:02.000Z',
      }),
    ]);

    expect(projects.find((p) => p.projectKey === 'local:/repo/pinned-only')).toMatchObject({
      sessionId: 'pinned-only',
      activeSessionCount: 1,
    });
    expect(projects.find((p) => p.projectKey === 'local:/repo/mixed')).toMatchObject({
      sessionId: 'mixed-pinned-newer',
      activeSessionCount: 2,
    });
  });

  it('treats the checkmarked current project as a no-op even when another session is first', () => {
    expect(
      shouldIgnoreDocModeProjectSwitch(
        {
          projectKey: 'local:/repo/app',
          displayName: 'app',
          sessionId: 'most-recent-session',
          activeSessionCount: 2,
        },
        'local:/repo/app',
        'currently-browsed-session',
      ),
    ).toBe(true);
  });

  it('shows the doc-mode switcher when the only listed project is not current', () => {
    const projects = [
      {
        projectKey: 'local:/repo/active-target',
        displayName: 'active-target',
        sessionId: 'active-target-session',
        activeSessionCount: 1,
      },
    ];

    expect(
      hasSwitchableDocModeProject(
        projects,
        'local:/repo/archived-current',
        'archived-current-session',
      ),
    ).toBe(true);
    expect(
      hasSwitchableDocModeProject(
        projects,
        'local:/repo/active-target',
        'active-target-session',
      ),
    ).toBe(false);
  });

  it('resolves doc-mode file sessions from the all-session bucket', () => {
    const archivedCurrent = session({
      id: 'archived-current-session',
      workingDir: '/repo/archived-current',
      status: 'archived',
    });
    const activeTarget = session({
      id: 'active-target-session',
      workingDir: '/repo/active-target',
      status: 'active',
    });
    const archivedFilteredSessions = [archivedCurrent];
    const allSessions = [archivedCurrent, activeTarget];

    expect(
      resolveDocModeFilesSession(archivedFilteredSessions, 'active-target-session'),
    ).toBeNull();
    expect(resolveDocModeFilesSession(allSessions, 'active-target-session')).toBe(activeTarget);
  });

  it('uses null instead of path-like sentinels for navigation-away dirty checks', () => {
    expect(sidebarBrowseSource).not.toContain('__switch_project__');
    expect(sidebarBrowseSource).not.toContain('__nav-away__');
    expect(sidebarBrowseSource).toContain('confirmSwitchAway(currentSelectedFile, null)');
    expect(dirtyConfirmSource).toContain('nextRelPath: string | null');
  });

  it('keeps empty workdir from reading local files', () => {
    expect(fileContentSource).toContain('if (!workdir || !relPath)');
  });
});
