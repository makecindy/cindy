import { describe, expect, it } from 'vitest';

import {
  assertCollabProjectEnabled,
  resolveLocalCollabPolicyWorkingDir,
} from '../collabProjectPolicy.js';

describe('resolveLocalCollabPolicyWorkingDir', () => {
  const isManagedDialogueWorkspace = (workingDir: string) =>
    workingDir.startsWith('/app-managed/dialogues/');

  it('drops app-managed dialogue cwd so policy queries use only the user/global level', () => {
    expect(
      resolveLocalCollabPolicyWorkingDir(
        '  /app-managed/dialogues/2026-08-02/session-1  ',
        'dialogue',
        isManagedDialogueWorkspace,
      ),
    ).toBeUndefined();
  });

  it('keeps and normalizes an explicitly bound real directory', () => {
    expect(
      resolveLocalCollabPolicyWorkingDir(
        '  /projects/cindy  ',
        'dialogue',
        isManagedDialogueWorkspace,
      ),
    ).toBe('/projects/cindy');
  });

  it('keeps a project path even when it has the same shape as a managed dialogue cwd', () => {
    expect(
      resolveLocalCollabPolicyWorkingDir(
        '/app-managed/dialogues/2026-08-02/session-1',
        'project',
        isManagedDialogueWorkspace,
      ),
    ).toBe('/app-managed/dialogues/2026-08-02/session-1');
  });
});

describe('assertCollabProjectEnabled', () => {
  const neverManagedDialogue = () => false;
  const project = {
    workingDir: 'C:\\projects\\cindy',
    workspaceKind: 'project',
    remoteHostId: null,
  } as const;

  it('allows an enabled local project', () => {
    expect(() =>
      assertCollabProjectEnabled(project, () => true, neverManagedDialogue),
    ).not.toThrow();
  });

  it('rejects a project with collab disabled', () => {
    expect(() =>
      assertCollabProjectEnabled(project, () => false, neverManagedDialogue),
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this session');
  });

  it('trims the working directory before checking the project policy', () => {
    let checkedPath: string | undefined;
    expect(() =>
      assertCollabProjectEnabled(
        { ...project, workingDir: '  C:\\projects\\cindy  ' },
        (_pluginId, workingDir) => {
          checkedPath = workingDir;
          return true;
        },
        neverManagedDialogue,
      ),
    ).not.toThrow();
    expect(checkedPath).toBe('C:\\projects\\cindy');
  });

  it('allows dialogue sessions using only the user/global policy', () => {
    for (const remoteHostId of [null, 'host-1'] as const) {
      const calls: Array<string | undefined> = [];
      expect(() =>
        assertCollabProjectEnabled(
          {
            workingDir: '/app-managed/dialogues/2026-08-02/session-1',
            workspaceKind: 'dialogue',
            remoteHostId,
          },
          (_pluginId, workingDir) => {
            calls.push(workingDir);
            return true;
          },
          (workingDir) => workingDir.startsWith('/app-managed/dialogues/'),
        ),
      ).not.toThrow();
      expect(calls).toEqual([undefined]);
    }
  });

  it('rejects dialogue sessions when collab is disabled at the user/global level', () => {
    expect(() =>
      assertCollabProjectEnabled(
        {
          workingDir: '/app-managed/dialogues/2026-08-02/session-1',
          workspaceKind: 'dialogue',
          remoteHostId: null,
        },
        () => false,
        (workingDir) => workingDir.startsWith('/app-managed/dialogues/'),
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this session');
  });

  it('applies project policy to a local dialogue that explicitly binds a real directory', () => {
    const explicitWorkingDir = '/projects/private-collab-disabled';
    const calls: Array<string | undefined> = [];
    expect(() =>
      assertCollabProjectEnabled(
        {
          workingDir: explicitWorkingDir,
          workspaceKind: 'dialogue',
          remoteHostId: null,
        },
        (_pluginId, workingDir) => {
          calls.push(workingDir);
          return false;
        },
        neverManagedDialogue,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this session');
    expect(calls).toEqual([explicitWorkingDir]);
  });

  it('does not let a project session skip its override just because the path resembles a managed cwd', () => {
    const calls: Array<string | undefined> = [];
    expect(() =>
      assertCollabProjectEnabled(
        {
          workingDir: '/app-managed/dialogues/2026-08-02/session-1',
          workspaceKind: 'project',
          remoteHostId: null,
        },
        (_pluginId, workingDir) => {
          calls.push(workingDir);
          return true;
        },
        (workingDir) => workingDir.startsWith('/app-managed/dialogues/'),
      ),
    ).not.toThrow();
    expect(calls).toEqual(['/app-managed/dialogues/2026-08-02/session-1']);
  });

  it('rejects unsupported workspace kinds and missing runtime directories', () => {
    const mustNotQuery = () => {
      throw new Error('must not query policy for an invalid session');
    };
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: '/tmp/session', workspaceKind: 'unknown', remoteHostId: null },
        mustNotQuery,
        neverManagedDialogue,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires a supported lead session');
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: null, workspaceKind: 'dialogue', remoteHostId: null },
        mustNotQuery,
        neverManagedDialogue,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires a session working directory');
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: '   ', workspaceKind: 'project', remoteHostId: null },
        mustNotQuery,
        neverManagedDialogue,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires a session working directory');
  });

  it('allows remote project sessions for both agents without querying local fs policy', () => {
    // 远端 workingDir 是远端机器路径, 本机 fs 的项目插件查询无意义 —— remote
    // 跳过项目级查询 (isPluginEnabled 不带 workingDir 调用), 但用户级/全局级
    // 开关仍生效。
    for (const agentKind of ['codex', 'claude-code'] as const) {
      const calls: Array<string | undefined> = [];
      expect(() =>
        assertCollabProjectEnabled(
          { ...project, workingDir: '/remote/repo', remoteHostId: 'host-1', agentKind },
          (_pluginId, workingDir) => {
            calls.push(workingDir);
            return true;
          },
          neverManagedDialogue,
        ),
      ).not.toThrow();
      expect(calls).toEqual([undefined]);
    }
  });

  it('rejects remote sessions when collab is disabled at the user/global level', () => {
    // review 回归:remote 提前 return 曾完全绕过 isPluginEnabled — 用户全局
    // 禁用 Collab 时远端会话仍能建 Orca team, 与本地行为不一致。
    expect(() =>
      assertCollabProjectEnabled(
        { ...project, workingDir: '/remote/repo', remoteHostId: 'host-1', agentKind: 'codex' },
        () => false,
        neverManagedDialogue,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this session');
  });
});
