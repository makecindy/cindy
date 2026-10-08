/**
 * 影子目录按你这台的真实路径逐级镜像：上级目录里的说明文件放在对应的上级，个人配置
 * (Claude Code 的 ~/.claude、Codex 的 CODEX_HOME)随任务同步到那台；那台给出的影子路径逐级
 * 映射回你这台的真实路径。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectAncestorInstructionFiles,
  collectPersonalConfig,
  collectProjectInstructionFiles,
} from '../controller/projectFiles';
import { shadowAliases, startRemoteAgentSession } from '../controller/startRemote';
import { createRemoteAgentHost, mirrorSegments, type HostedStartInput } from '../host/runHost';
import { hostedStartOptions } from '../host/service';
import { ExecutorWorkspace } from '../executor/workspace';
import { MAX_ANCESTOR_LEVELS } from '../wire';

const RG = path.resolve(__dirname, '../../../../../ripgrep-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-mirror-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('mirrorSegments', () => {
  it('keeps each path level and replaces names the other computer cannot store', () => {
    expect(mirrorSegments('/Users/me/my proj')).toEqual(['Users', 'me', 'my proj']);
    expect(mirrorSegments('C:\\Users\\me\\a<b>|c. ')).toEqual(['C', 'Users', 'me', 'a_b__c']);
    expect(mirrorSegments('/a/../b')).toEqual(['a', '_', 'b']);
    expect(mirrorSegments(`/${'x'.repeat(100)}`)).toEqual(['x'.repeat(64)]);
  });

  it('keeps only as many levels as ancestor instructions can use', () => {
    const deep = `/${Array.from({ length: 40 }, (_, index) => `d${index}`).join('/')}`;
    const segments = mirrorSegments(deep);
    expect(segments).toHaveLength(MAX_ANCESTOR_LEVELS + 1);
    expect(segments.at(-1)).toBe('d39');
  });
});

describe('shadowAliases', () => {
  it('maps the shadow, each mirrored ancestor and personal directories back to this computer', () => {
    expect(shadowAliases(
      { shadowDir: '/runs/fs/Users/me/proj', mirrorRoot: '/runs/fs' },
      '/Users/me/proj',
      [{ relative: '.claude/skills/s1', local: '/Users/me/.claude/skills/s1' }],
    )).toEqual([
      { from: '/runs/fs/Users/me/proj/.claude/skills/s1', to: '/Users/me/.claude/skills/s1' },
      { from: '/runs/fs/Users/me/proj', to: '/Users/me/proj' },
      { from: '/runs/fs/Users/me', to: '/Users/me' },
      { from: '/runs/fs/Users', to: '/Users' },
    ]);
  });

  it('only maps the shadow itself when the other computer did not mirror the path', () => {
    expect(shadowAliases({ shadowDir: '/runs/shadow' }, '/Users/me/proj', [])).toEqual([
      { from: '/runs/shadow', to: '/Users/me/proj' },
    ]);
    expect(shadowAliases({ shadowDir: '' }, '/Users/me/proj', [])).toEqual([]);
  });

  it('accepts a Windows shadow path from the other computer', () => {
    const aliases = shadowAliases(
      { shadowDir: 'C:\\runs\\fs\\Users\\me\\proj', mirrorRoot: 'C:\\runs\\fs' },
      '/Users/me/proj',
      [],
    );
    expect(aliases.map((alias) => alias.to)).toEqual(['/Users/me/proj', '/Users/me', '/Users']);
    expect(aliases.at(-1)?.from).toBe('C:/runs/fs/Users');
  });
});

describe('collectAncestorInstructionFiles', () => {
  it('reads instruction files from parent directories with their level', async () => {
    const project = path.join(root, 'a', 'b', 'proj');
    fs.mkdirSync(project, { recursive: true });
    write(path.join(root, 'a', 'b', 'CLAUDE.md'), 'parent');
    write(path.join(root, 'a', 'AGENTS.md'), 'grandparent');
    write(path.join(root, 'a', 'b', 'notes.md'), 'not an instruction file');
    write(path.join(project, 'CLAUDE.md'), 'project itself is synced separately');
    const files = await collectAncestorInstructionFiles(project);
    const decoded = files.map((file) => ({ up: file.up, name: file.name, text: Buffer.from(file.data, 'base64').toString() }));
    expect(decoded).toContainEqual({ up: 1, name: 'CLAUDE.md', text: 'parent' });
    expect(decoded).toContainEqual({ up: 2, name: 'AGENTS.md', text: 'grandparent' });
    expect(decoded.some((file) => file.text.includes('not an instruction') || file.text.includes('project itself'))).toBe(false);
  });
});

describe('collectProjectInstructionFiles', () => {
  it('rejects directory links so a checkout cannot smuggle files from outside the project', async () => {
    const project = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    write(path.join(project, 'CLAUDE.md'), 'real rules');
    write(path.join(outside, 'SKILL.md'), 'secret leak');
    fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
    // Windows junction 不需要文件 symlink 的管理员权限，目录越界检查仍实跑。
    fs.symlinkSync(outside, path.join(project, '.claude', 'skills', 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = await collectProjectInstructionFiles(project);
    expect(files.map((file) => file.path)).toEqual(['CLAUDE.md']);
    expect(files.map((file) => Buffer.from(file.data, 'base64').toString())).toEqual(['real rules']);
  });

  it('rejects file symlinks when the filesystem supports creating them', async (context) => {
    const project = path.join(root, 'proj');
    const outside = path.join(root, 'outside');
    write(path.join(project, 'CLAUDE.md'), 'real rules');
    write(path.join(outside, 'leak.md'), 'secret leak');
    write(path.join(outside, '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
    // 实际探测文件 symlink 能力；有权限的 Windows 与 macOS/Linux 均保留真实覆盖。
    try {
      fs.symlinkSync(path.join(outside, '.env'), path.join(project, 'CLAUDE.local.md'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip();
        return;
      }
      throw error;
    }
    fs.symlinkSync(path.join(outside, 'leak.md'), path.join(project, '.claude', 'skills', 'leak.md'));
    const files = await collectProjectInstructionFiles(project);
    expect(files.map((file) => file.path)).toEqual(['CLAUDE.md']);
    const decoded = files.map((file) => Buffer.from(file.data, 'base64').toString());
    expect(decoded).toEqual(['real rules']);
  });
});

describe('collectPersonalConfig', () => {
  it("collects Claude Code's personal memory, skills, agents, commands and permission rules", async () => {
    const home = path.join(root, 'home');
    write(path.join(home, '.claude', 'CLAUDE.md'), 'personal memory');
    write(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'personal skill');
    write(path.join(home, '.claude', 'skills', 'shared', 'SKILL.md'), 'personal copy');
    write(path.join(home, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\n');
    write(path.join(home, '.claude', 'commands', 'go.md'), 'go');
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'] },
      hooks: { PreToolUse: [] },
      env: { SECRET: 'x' },
    }));
    const { personal, roots } = await collectPersonalConfig('claude-code', [
      { path: '.claude/skills/shared/SKILL.md', data: Buffer.from('project copy').toString('base64') },
    ], { env: {}, home });
    expect(personal.memory).toBe('personal memory');
    expect(personal.files.map((file) => file.path).sort()).toEqual([
      '.claude/agents/helper.md',
      '.claude/commands/go.md',
      '.claude/skills/mine/SKILL.md',
    ]);
    expect(personal.permissions).toEqual({ allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'], ask: [] });
    expect(JSON.stringify(personal)).not.toContain('SECRET');
    expect(roots).toContainEqual({ relative: '.claude/skills/mine', local: path.join(home, '.claude', 'skills', 'mine') });
  });

  it('honours CLAUDE_CONFIG_DIR and syncs nothing when there is no personal config', async () => {
    const configDir = path.join(root, 'custom-claude');
    write(path.join(configDir, 'CLAUDE.md'), 'from custom dir');
    expect((await collectPersonalConfig('claude-code', [], { env: { CLAUDE_CONFIG_DIR: configDir }, home: path.join(root, 'nobody') }))
      .personal.memory).toBe('from custom dir');
    expect(await collectPersonalConfig('claude-code', [], { env: {}, home: path.join(root, 'nobody') }))
      .toEqual({ personal: { files: [] }, roots: [] });
  });

  it("uses Codex's personal instructions, preferring the override file", async () => {
    const codexHome = path.join(root, 'codex');
    write(path.join(codexHome, 'AGENTS.md'), 'base');
    expect((await collectPersonalConfig('codex', [], { env: { CODEX_HOME: codexHome }, home: root })).personal)
      .toEqual({ files: [], instructions: 'base' });
    write(path.join(codexHome, 'AGENTS.override.md'), 'override');
    expect((await collectPersonalConfig('codex', [], { env: { CODEX_HOME: codexHome }, home: root })).personal.instructions)
      .toBe('override');
  });
});

function idleHandle(input: HostedStartInput): AgentSessionHandle {
  return {
    id: 'sdk-1',
    agentKind: input.kind,
    model: input.options.model,
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    events: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        // 不产生事件。
      },
    }),
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
  };
}

describe('shadow on the other computer', () => {
  it('places ancestor instructions at mirrored levels and personal config without overriding the project', async () => {
    const project = path.join(root, 'work', 'team', 'proj');
    fs.mkdirSync(project, { recursive: true });
    write(path.join(project, 'CLAUDE.md'), 'project rules');
    write(path.join(project, '.claude', 'commands', 'go.md'), 'project go');
    write(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
    write(path.join(root, 'work', 'team', 'AGENTS.md'), 'team rules');
    write(path.join(root, 'work', 'CLAUDE.md'), 'work rules');

    const inputs: HostedStartInput[] = [];
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => {
        inputs.push(input);
        return idleHandle(input);
      },
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: path.join(root, 'host'),
    });
    const handle = await startRemoteAgentSession('claude-code', {
      sessionId: 'task-1',
      workingDir: project,
      extraDirs: [path.join(project, 'src'), path.join(root, 'external')],
      writableDirs: [path.join(root, 'external')],
      model: 'claude-opus',
      userPrompt: `Please inspect ${path.join(project, 'src', 'index.ts')}.`,
      permissionMode: 'default',
    }, {
      invoke: async (args) => JSON.parse(JSON.stringify(await host.handle('controller-1', JSON.parse(JSON.stringify(args[0]))) ?? null)),
      rgPath: RG,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      collectProjectFiles: collectProjectInstructionFiles,
      collectAncestorFiles: collectAncestorInstructionFiles,
      collectPersonal: async () => ({
        personal: {
          memory: 'personal memory',
          files: [
            { path: '.claude/commands/go.md', data: Buffer.from('personal go').toString('base64') },
            { path: '.claude/agents/helper.md', data: Buffer.from('personal helper').toString('base64') },
          ],
          permissions: { allow: ['Bash(npm test:*)'], deny: [], ask: [] },
          instructions: 'personal instructions',
        },
        roots: [],
      }),
      isGitRepo: async () => false,
      newId: randomUUID,
    });

    const [input] = inputs;
    const read = (file: string) => fs.readFileSync(file, 'utf8');
    expect(input.shadowDir.startsWith(`${input.mirrorRoot}${path.sep}`)).toBe(true);
    expect(input.shadowDir).not.toContain(project);
    expect(path.relative(input.mirrorRoot, input.shadowDir).split(path.sep)).toHaveLength(MAX_ANCESTOR_LEVELS + 1);
    expect(read(path.join(input.shadowDir, 'CLAUDE.md'))).toBe('project rules');
    expect(read(path.join(path.dirname(input.shadowDir), 'AGENTS.md'))).toBe('team rules');
    expect(read(path.join(path.dirname(path.dirname(input.shadowDir)), 'CLAUDE.md'))).toBe('work rules');
    // 个人说明放在镜像根之外的任务根目录(对应个人配置，不对应项目的任何上级)。
    expect(read(path.join(path.dirname(input.mirrorRoot), 'CLAUDE.md'))).toBe('personal memory');
    // 项目里已有的同名文件以项目为准；项目没有的个人文件补上。
    expect(read(path.join(input.shadowDir, '.claude', 'commands', 'go.md'))).toBe('project go');
    expect(read(path.join(input.shadowDir, '.claude', 'agents', 'helper.md'))).toBe('personal helper');
    expect(JSON.parse(read(path.join(input.shadowDir, '.claude', 'settings.local.json')))).toEqual({
      permissions: { allow: ['Bash(ls:*)', 'Bash(npm test:*)'] },
    });
    expect(input.personalInstructions).toBe('personal instructions');
    expect(input.extraDirs?.[0]).toBe(path.join(input.shadowDir, 'src'));
    expect(input.extraDirs?.[1]).toBe(path.join(input.mirrorRoot, 'additional', 'dir-1'));
    expect(input.writableDirs?.[0]).toBe(input.extraDirs?.[1]);
    expect(input.workspace.homeDir).toBe(os.homedir());
    expect(input.options.userPrompt).toBe(`Please inspect ${path.join(input.shadowDir, 'src', 'index.ts')}.`);
    const opts = hostedStartOptions(input);
    expect(opts.deviceHosted?.workingDir).toBe(input.shadowDir);
    expect(opts.deviceHosted?.pathPlatform).toBe(process.platform);
    expect(opts.deviceHosted?.homeDir).toBeUndefined();
    expect(opts.extraDirs).toEqual(input.extraDirs);
    expect(opts.writableDirs).toEqual(input.writableDirs);
    const workspace = new ExecutorWorkspace({ workingDir: project });
    workspace.setAliases(shadowAliases({ ...input }, project, [], {
      extraDirs: [path.join(project, 'src'), path.join(root, 'external')], writableDirs: [path.join(root, 'external')],
    }));
    workspace.setVirtualRoot(input.mirrorRoot);
    expect(workspace.resolve(input.extraDirs![1])).toBe(path.join(root, 'external'));
    expect(workspace.toAgentPath(path.join(root, 'external', 'a.ts'))).toBe(path.join(input.extraDirs![1], 'a.ts'));

    await handle.close({ reason: 'navigation' });
    host.dispose();
  });
});
