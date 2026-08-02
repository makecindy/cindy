import { describe, expect, it } from 'vitest';

import { assertCollabProjectEnabled } from '../collabProjectPolicy.js';

describe('assertCollabProjectEnabled', () => {
  const project = {
    workingDir: 'C:\\projects\\cindy',
    workspaceKind: 'project',
    remoteHostId: null,
  } as const;

  it('allows an enabled local project', () => {
    expect(() => assertCollabProjectEnabled(project, () => true)).not.toThrow();
  });

  it('rejects a project with collab disabled', () => {
    expect(() => assertCollabProjectEnabled(project, () => false)).toThrow(
      '[PRECONDITION_FAILED] collaboration is disabled for this session',
    );
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
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this session');
  });

  it('rejects unsupported workspace kinds and missing runtime directories', () => {
    const mustNotQuery = () => {
      throw new Error('must not query policy for an invalid session');
    };
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: '/tmp/session', workspaceKind: 'unknown', remoteHostId: null },
        mustNotQuery,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires a supported lead session');
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: null, workspaceKind: 'dialogue', remoteHostId: null },
        mustNotQuery,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires a session working directory');
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: '   ', workspaceKind: 'project', remoteHostId: null },
        mustNotQuery,
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
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this session');
  });
});
