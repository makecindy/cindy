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
      '[PRECONDITION_FAILED] collaboration is disabled for this project',
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

  it('rejects dialogue sessions regardless of plugin policy', () => {
    const isPluginEnabled = () => {
      throw new Error('must not query project policy for an ineligible session');
    };

    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: null, workspaceKind: 'dialogue', remoteHostId: null },
        isPluginEnabled,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires an enabled local project session');

    // 远端会话同样是项目会话才放行:无 workingDir 的远端 dialogue 照样拒绝。
    expect(() =>
      assertCollabProjectEnabled(
        { workingDir: null, workspaceKind: 'dialogue', remoteHostId: 'host-1' },
        isPluginEnabled,
      ),
    ).toThrow('[PRECONDITION_FAILED] collaboration requires an enabled local project session');
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
    ).toThrow('[PRECONDITION_FAILED] collaboration is disabled for this project');
  });
});
