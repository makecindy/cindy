import { describe, expect, it } from 'vitest';

import type { RemoteAgentFileOps } from '../base-agent.js';
import { scanRemoteClaudeSkills, scanRemotePiSkills } from './remote-skill-scanner.js';

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

describe('remote Skill scanners', () => {
  it('discovers Claude global and project resources with project precedence', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.claude/skills/release/SKILL.md': '---\ndescription: Global release\n---',
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
      '$HOME/.claude/skills/@scope/claude-nested/SKILL.md': '---\ndescription: Claude nested\n---',
    });

    const pi = await scanRemotePiSkills({ fileOps });
    expect(pi.skills.map((skill) => skill.name)).toEqual(['nested']);

    const claude = await scanRemoteClaudeSkills({ fileOps });
    expect(claude.skills.map((skill) => skill.name)).toEqual(['claude-nested']);
  });

  it('does not walk a symlinked namespace when the host exposes lstat', async () => {
    const fileOps: RemoteAgentFileOps = {
      ...fakeRemoteFiles({
        '$HOME/.claude/skills/@scope/nested/SKILL.md': '---\ndescription: Nested\n---',
      }),
      async lstat(candidate) {
        return { isSymbolicLink: candidate === '$HOME/.claude/skills/@scope' };
      },
    };

    const result = await scanRemoteClaudeSkills({ fileOps });

    expect(result.skills).toEqual([]);
  });

  it('does not walk namespaces when the host cannot report symlinks', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.claude/skills/@scope/nested/SKILL.md': '---\ndescription: Nested\n---',
    });
    delete fileOps.lstat;

    const result = await scanRemoteClaudeSkills({ fileOps });

    expect(result.skills).toEqual([]);
  });

  it('prefers a direct remote Skill over a same-named nested Skill', async () => {
    const fileOps = fakeRemoteFiles({
      '$HOME/.claude/skills/same-name/SKILL.md': '---\ndescription: Direct\n---',
      '$HOME/.claude/skills/@scope/same-name/SKILL.md': '---\ndescription: Nested\n---',
    });

    const result = await scanRemoteClaudeSkills({ fileOps });

    expect(result.skills).toEqual([
      expect.objectContaining({ name: 'same-name', description: 'Direct' }),
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
});
