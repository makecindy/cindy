import { describe, expect, it } from 'vitest';

import type { RemoteAgentFileOps } from '../base-agent.js';
import {
  scanRemoteClaudePluginSkills,
  scanRemoteClaudeSkills,
  scanRemotePiSkills,
} from './remote-skill-scanner.js';

function fakeRemoteFiles(files: Record<string, string>): RemoteAgentFileOps {
  const fileNames = new Set(Object.keys(files));
  return {
    async stat(candidate) {
      if (fileNames.has(candidate)) return { isFile: true };
      const prefix = candidate.endsWith('/') ? candidate : `${candidate}/`;
      return [...fileNames].some((file) => file.startsWith(prefix)) ? { isFile: false } : null;
    },
    async listDir(directory) {
      const prefix = directory.endsWith('/') ? directory : `${directory}/`;
      return [...new Set(
        [...fileNames]
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split('/')[0])
          .filter(Boolean),
      )];
    },
    async lstat(candidate) {
      if (fileNames.has(candidate)) return { isSymbolicLink: false };
      const prefix = candidate.endsWith('/') ? candidate : `${candidate}/`;
      return [...fileNames].some((file) => file.startsWith(prefix))
        ? { isSymbolicLink: false }
        : null;
    },
    async readFile(file, maxBytes) {
      const value = files[file];
      if (value === undefined) throw new Error('missing');
      return value.slice(0, maxBytes);
    },
    async sha256File(file) {
      const value = files[file];
      if (value === undefined) throw new Error('missing');
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(value, 'utf8').digest('hex');
    },
  };
}

/**
 * 测试价值（engineering-conventions §3.2）
 *
 * 保护的行为：SSH 会话的 Skill 清单必须与远端运行时实际加载的一致。
 * `scanRemoteClaudeSkills` 要同时给出 commands 与 skills 两类来源、project 覆盖
 * global；`scanRemotePiSkills` 只能在 Git 边界内向上回溯。插件三条用例额外保护
 * 「远端只暴露 user scope 插件」「manifest 声明的 skills 路径补充而非替换
 * `skills/`」「声明的 root 本身就是一个 Skill 目录时仍被发现」——任一条走错，
 * `/` 菜单都会与远端运行时对不上，或者给出远端无法解析的命令。
 *
 * 最小失败输入：`installed_plugins.json` 里放一条 `scope: 'project'` 记录；
 * manifest 声明 `skills: './extra'` 且只铺 `skills/`；manifest 把 root 指到
 * 一个直接含 `SKILL.md` 的目录。旧实现分别会误报、漏报、返回空列表。
 *
 * tier：unit —— 进程内 fake `RemoteAgentFileOps`，无网络、无真实远端主机。
 * 单跑耗时：~8ms（9 个用例），远低于 10s 上限。
 */
describe('remote Skill scanners', () => {
  it('discovers Claude global and project resources with project precedence', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/skills/release/SKILL.md': '---\ndescription: Global release\n---',
      '/srv/repo/.claude/skills/release/SKILL.md': '---\ndescription: Project release\n---',
      '/srv/repo/.claude/commands/check.md': 'Check the project.',
    });

    const result = await scanRemoteClaudeSkills({ fileOps, workingDir: '/srv/repo' });

    expect(result.skills).toEqual([
      expect.objectContaining({ name: 'check', scope: 'project', source: 'user' }),
      expect.objectContaining({
        name: 'release',
        scope: 'project',
        description: 'Project release',
      }),
    ]);
  });

  it('discovers one namespace level and stops before the third level', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.agents/skills/@scope/nested/SKILL.md': '---\ndescription: Nested\n---',
      '$HOME/.agents/skills/@scope/group/too-deep/SKILL.md': '---\ndescription: Too deep\n---',
      '$HOME/.xdt-server/v1/claude-home/skills/@scope/claude-nested/SKILL.md': '---\ndescription: Claude nested\n---',
    });

    const pi = await scanRemotePiSkills({ fileOps });
    expect(pi.skills.map((skill) => skill.name)).toEqual(['nested']);

    const claude = await scanRemoteClaudeSkills({ fileOps });
    expect(claude.skills.map((skill) => skill.name)).toEqual(['claude-nested']);
  });

  it('does not walk a symlinked namespace when the host exposes lstat', async () => {
    const fileOps: RemoteAgentFileOps = {
      ...fakeRemoteFiles({
        '$HOME/.xdt-server/v1/claude-home/skills/@scope/nested/SKILL.md': '---\ndescription: Nested\n---',
      }),
      async lstat(candidate) {
        return { isSymbolicLink: candidate === '$HOME/.xdt-server/v1/claude-home/skills/@scope' };
      },
    };

    const result = await scanRemoteClaudeSkills({ fileOps });

    expect(result.skills).toEqual([]);
  });

  it('does not walk namespaces when the host cannot report symlinks', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/skills/@scope/nested/SKILL.md': '---\ndescription: Nested\n---',
    });
    delete fileOps.lstat;

    const result = await scanRemoteClaudeSkills({ fileOps });

    expect(result.skills).toEqual([]);
  });

  it('prefers a direct remote Skill over a same-named nested Skill', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/skills/same-name/SKILL.md': '---\ndescription: Direct\n---',
      '$HOME/.xdt-server/v1/claude-home/skills/@scope/same-name/SKILL.md': '---\ndescription: Nested\n---',
      '$HOME/.agents/skills/late-name/SKILL.md': '---\ndescription: Direct\n---',
      '$HOME/.agents/skills/@scope/late-name/SKILL.md': '---\ndescription: Nested\n---',
    });

    // Claude merges by name; Pi dedupes by path, so it must not return two
    // same-named Skills regardless of which one the directory order finds first.
    const claude = await scanRemoteClaudeSkills({ fileOps });
    expect(claude.skills.filter((skill) => skill.name === 'same-name')).toEqual([
      expect.objectContaining({ name: 'same-name', description: 'Direct' }),
    ]);

    const pi = await scanRemotePiSkills({ fileOps });
    expect(pi.skills.filter((skill) => skill.name === 'late-name')).toEqual([
      expect.objectContaining({ name: 'late-name', description: 'Direct' }),
    ]);
  });

  it('discovers Pi global, project, and ancestor Skills only through the Git boundary', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.agents/skills/global/SKILL.md': '---\ndescription: Global\n---',
      '/srv/repo/packages/app/.pi/skills/local/SKILL.md': 'Local project skill',
      '/srv/repo/.agents/skills/repo/SKILL.md': 'Repo skill',
      '/srv/repo/.git/HEAD': 'ref: refs/heads/main',
      '/srv/.agents/skills/outside/SKILL.md': 'Must not be visible',
    });

    const result = await scanRemotePiSkills({
      fileOps,
      workingDir: '/srv/repo/packages/app',
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(['global', 'local', 'repo']);
    expect(result.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'global', scope: 'user', runtimeCommandName: 'skill:global' }),
      expect.objectContaining({ name: 'repo', scope: 'repo', runtimeCommandName: 'skill:repo' }),
    ]));
  });

  it('discovers enabled user-scoped Claude plugin Skills on the remote host', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/plugins/installed_plugins.json': JSON.stringify({
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: '$HOME/.xdt-server/v1/claude-home/plugins/cache/alpha/1.0.0' }],
          'beta@market': [{ scope: 'project', installPath: '$HOME/work/repo/.claude/plugins/beta' }],
        },
      }),
      '$HOME/.xdt-server/v1/claude-home/plugins/cache/alpha/1.0.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'alpha' }),
      '$HOME/.xdt-server/v1/claude-home/plugins/cache/alpha/1.0.0/skills/browser/SKILL.md': '---\ndescription: Browser skill\n---',
      '$HOME/work/repo/.claude/plugins/beta/.claude-plugin/plugin.json': JSON.stringify({ name: 'beta' }),
      '$HOME/work/repo/.claude/plugins/beta/skills/hidden/SKILL.md': '---\ndescription: Project plugin\n---',
    });

    const skills = await scanRemoteClaudePluginSkills(fileOps);

    // 远端会话同样只应看到 user scope 的插件；project scope 的 beta 属于
    // 那个项目自己的运行时，不该出现在全局 `/` 菜单。
    expect(skills).toEqual([
      expect.objectContaining({
        name: 'alpha:browser',
        scope: 'global',
        source: 'skill',
        description: 'Browser skill',
      }),
    ]);
  });

  it('keeps the conventional skills/ root when a remote manifest declares extra paths', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/plugins/installed_plugins.json': JSON.stringify({
        plugins: { 'delta@market': [{ scope: 'user', installPath: '$HOME/plugins/delta' }] },
      }),
      '$HOME/plugins/delta/.claude-plugin/plugin.json': JSON.stringify({
        name: 'delta',
        skills: './extra',
      }),
      '$HOME/plugins/delta/skills/conventional/SKILL.md': 'Conventional skill',
      '$HOME/plugins/delta/extra/declared/SKILL.md': 'Declared skill',
    });

    const skills = await scanRemoteClaudePluginSkills(fileOps);

    expect(skills.map((skill) => skill.name)).toEqual(['delta:conventional', 'delta:declared']);
  });

  it('recognizes a remote manifest root that is itself a Skill', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/plugins/installed_plugins.json': JSON.stringify({
        plugins: { 'solo@market': [{ scope: 'user', installPath: '$HOME/plugins/solo' }] },
      }),
      '$HOME/plugins/solo/.claude-plugin/plugin.json': JSON.stringify({
        name: 'solo',
        skills: './custom/browser',
      }),
      '$HOME/plugins/solo/custom/browser/SKILL.md': '---\ndescription: Single skill\n---',
    });

    const skills = await scanRemoteClaudePluginSkills(fileOps);

    expect(skills).toEqual([
      expect.objectContaining({ name: 'solo:browser', description: 'Single skill' }),
    ]);
  });

  it('keeps a remote direct Skill whose folder name looks like a build output', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/plugins/installed_plugins.json': JSON.stringify({
        plugins: { 'buildy@market': [{ scope: 'user', installPath: '$HOME/plugins/buildy' }] },
      }),
      '$HOME/plugins/buildy/.claude-plugin/plugin.json': JSON.stringify({ name: 'buildy' }),
      '$HOME/plugins/buildy/skills/build/SKILL.md': 'Build skill',
    });

    const skills = await scanRemoteClaudePluginSkills(fileOps);

    expect(skills.map((skill) => skill.name)).toEqual(['buildy:build']);
  });

  it('ignores a remote manifest Skill root that escapes the plugin directory', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.xdt-server/v1/claude-home/plugins/installed_plugins.json': JSON.stringify({
        plugins: {
          'evil@market': [{ scope: 'user', installPath: '$HOME/plugins/evil' }],
          'other@market': [{ scope: 'user', installPath: '$HOME/plugins/other' }],
        },
      }),
      '$HOME/plugins/evil/.claude-plugin/plugin.json': JSON.stringify({
        name: 'evil',
        skills: '../other/skills',
      }),
      '$HOME/plugins/other/skills/stolen/SKILL.md': 'Stolen skill',
    });

    const skills = await scanRemoteClaudePluginSkills(fileOps);

    // `../other/skills` 解析后落在 evil 安装目录之外，不能被当成本插件的 Skill；
    // 它仍然由自己的插件以 other:stolen 暴露。
    expect(skills.map((skill) => skill.name)).toContain('other:stolen');
    expect(skills.map((skill) => skill.name)).not.toContain('evil:stolen');
  });

  it('probes a multi-Skill plugin without dropping or reordering entries', async () => {
    const files: Record<string, string> = {
      '$HOME/.xdt-server/v1/claude-home/plugins/installed_plugins.json': JSON.stringify({
        plugins: { 'bulk@market': [{ scope: 'user', installPath: '$HOME/plugins/bulk' }] },
      }),
      '$HOME/plugins/bulk/.claude-plugin/plugin.json': JSON.stringify({ name: 'bulk' }),
    };
    const names = Array.from({ length: 20 }, (_, index) => `s${String(index).padStart(2, '0')}`);
    for (const name of names) {
      files[`$HOME/plugins/bulk/skills/${name}/SKILL.md`] = `---\ndescription: ${name}\n---`;
    }

    // 并发批量探测不能丢条目或打乱顺序：菜单顺序必须稳定。
    const skills = await scanRemoteClaudePluginSkills(fakeRemoteFiles(files));

    expect(skills.map((skill) => skill.name)).toEqual(names.map((name) => `bulk:${name}`));
  });
});
