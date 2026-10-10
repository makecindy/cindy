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
  collectInstructionImports,
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

/** 目录链接：Windows 用 junction(不需要管理员权限)。 */
function linkDir(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** 文件链接：没有权限创建时返回 false(没开开发者模式的 Windows)。 */
function linkFile(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

function decode(files: Array<{ path: string; data: string }>): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, Buffer.from(file.data, 'base64').toString()]));
}

describe('collectProjectInstructionFiles', () => {
  it('follows directory links the way the Agent does on this computer', async () => {
    const project = path.join(root, 'proj');
    const shared = path.join(root, 'shared-skills', 'deploy');
    write(path.join(project, 'CLAUDE.md'), 'real rules');
    write(path.join(shared, 'SKILL.md'), 'deploy skill');
    write(path.join(shared, 'scripts', 'run.sh'), 'echo deploy');
    linkDir(shared, path.join(project, '.claude', 'skills', 'deploy'));
    expect(decode(await collectProjectInstructionFiles(project))).toEqual({
      'CLAUDE.md': 'real rules',
      '.claude/skills/deploy/SKILL.md': 'deploy skill',
      '.claude/skills/deploy/scripts/run.sh': 'echo deploy',
    });
  });

  it('follows file links when the filesystem supports creating them', async (context) => {
    const project = path.join(root, 'proj');
    write(path.join(project, 'AGENTS.md'), 'shared rules');
    if (!linkFile(path.join(project, 'AGENTS.md'), path.join(project, 'CLAUDE.md'))) {
      context.skip();
      return;
    }
    expect(decode(await collectProjectInstructionFiles(project))).toEqual({
      'CLAUDE.md': 'shared rules',
      'AGENTS.md': 'shared rules',
    });
  });

  it('stops at a link back to its own parent and keeps a folder that two links share', async () => {
    const project = path.join(root, 'proj');
    const skills = path.join(project, '.claude', 'skills');
    write(path.join(skills, 'a', 'SKILL.md'), 'a');
    linkDir(skills, path.join(skills, 'loop'));
    write(path.join(root, 'common', 'SKILL.md'), 'common');
    linkDir(path.join(root, 'common'), path.join(skills, 'one'));
    linkDir(path.join(root, 'common'), path.join(skills, 'two'));
    expect(decode(await collectProjectInstructionFiles(project))).toEqual({
      '.claude/skills/a/SKILL.md': 'a',
      '.claude/skills/one/SKILL.md': 'common',
      '.claude/skills/two/SKILL.md': 'common',
    });
  });

  it('leaves credential files for later on a shared provider, judging links by their real target', async () => {
    const project = path.join(root, 'proj');
    write(path.join(project, 'CLAUDE.md'), 'rules');
    write(path.join(project, '.claude', 'skills', 'deploy', 'SKILL.md'), 'deploy');
    write(path.join(project, '.claude', 'skills', 'deploy', '.env'), 'TOKEN=1');
    write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    write(path.join(root, 'outside', '.aws', 'credentials'), 'aws secret');
    linkDir(path.join(root, 'outside', '.aws'), path.join(project, '.claude', 'skills', 'cloud'));
    const own = decode(await collectProjectInstructionFiles(project));
    expect(own['.claude/skills/deploy/.env']).toBe('TOKEN=1');
    expect(own['.claude/skills/cloud/credentials']).toBe('aws secret');
    const shared = decode(await collectProjectInstructionFiles(project, { skipCredentials: true }));
    expect(Object.keys(shared).sort()).toEqual(['.claude/settings.json', '.claude/skills/deploy/SKILL.md', 'CLAUDE.md']);
  });
});

describe('what gets synced', () => {
  it('includes project rules, .claude/CLAUDE.md and Codex project skills', async () => {
    const project = path.join(root, 'proj');
    write(path.join(project, '.claude', 'CLAUDE.md'), 'project memory');
    write(path.join(project, '.claude', 'rules', 'style.md'), 'style rule');
    write(path.join(project, '.claude', 'rules', 'frontend', 'react.md'), 'react rule');
    write(path.join(project, '.codex', 'skills', 'ship', 'SKILL.md'), 'ship');
    write(path.join(project, '.codex', 'config.toml'), 'model = "x"');
    expect(decode(await collectProjectInstructionFiles(project))).toEqual({
      '.claude/CLAUDE.md': 'project memory',
      '.claude/rules/style.md': 'style rule',
      '.claude/rules/frontend/react.md': 'react rule',
      '.codex/skills/ship/SKILL.md': 'ship',
    });
  });

  it('gives every Skill entry file a place before any supporting file', async () => {
    const project = path.join(root, 'proj');
    const big = path.join(project, '.claude', 'skills', 'big');
    write(path.join(big, 'SKILL.md'), 'big');
    for (let index = 0; index < 600; index += 1) write(path.join(big, 'references', `r${index}.txt`), 'x');
    write(path.join(project, '.claude', 'skills', 'zz-small', 'SKILL.md'), 'small');
    write(path.join(project, '.claude', 'agents', 'helper.md'), 'helper');
    const files = decode(await collectProjectInstructionFiles(project));
    expect(Object.keys(files)).toHaveLength(512);
    expect(files['.claude/skills/big/SKILL.md']).toBe('big');
    expect(files['.claude/skills/zz-small/SKILL.md']).toBe('small');
    expect(files['.claude/agents/helper.md']).toBe('helper');
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

  it('follows personal Skills that are links, and a skills folder that is itself a link', async () => {
    const home = path.join(root, 'home');
    const dotfiles = path.join(root, 'dotfiles');
    write(path.join(dotfiles, 'skills', 'git', 'SKILL.md'), 'git skill');
    write(path.join(dotfiles, 'skills', 'git', 'reference.md'), 'git reference');
    linkDir(path.join(dotfiles, 'skills', 'git'), path.join(home, '.claude', 'skills', 'git'));
    const linked = await collectPersonalConfig('claude-code', [], { env: {}, home });
    expect(decode(linked.personal.files)).toEqual({
      '.claude/skills/git/SKILL.md': 'git skill',
      '.claude/skills/git/reference.md': 'git reference',
    });
    expect(linked.roots).toEqual([{ relative: '.claude/skills/git', local: path.join(home, '.claude', 'skills', 'git') }]);

    const stowed = path.join(root, 'stowed');
    write(path.join(stowed, '.claude', 'CLAUDE.md'), 'personal memory');
    linkDir(path.join(dotfiles, 'skills'), path.join(stowed, '.claude', 'skills'));
    const whole = await collectPersonalConfig('claude-code', [], { env: {}, home: stowed });
    expect(whole.personal.memory).toBe('personal memory');
    expect(Object.keys(decode(whole.personal.files)).sort()).toEqual(['.claude/skills/git/SKILL.md', '.claude/skills/git/reference.md']);
  });

  it("collects personal rules for Claude Code", async () => {
    const home = path.join(root, 'home');
    write(path.join(home, '.claude', 'rules', 'tone.md'), 'be brief');
    const { personal, roots } = await collectPersonalConfig('claude-code', [
      { path: '.claude/rules/shared.md', data: '' },
    ], { env: {}, home });
    expect(decode(personal.files)).toEqual({ '.claude/rules/tone.md': 'be brief' });
    expect(roots).toEqual([{ relative: '.claude/rules/tone.md', local: path.join(home, '.claude', 'rules', 'tone.md') }]);
  });

  it('collects personal Skills for Codex and Pi where they look for Skills, leaving managed ones', async () => {
    const home = path.join(root, 'home');
    write(path.join(home, '.agents', 'skills', 'review', 'SKILL.md'), 'review');
    write(path.join(home, '.agents', 'skills', 'cindy-built-in', 'SKILL.md'), 'managed');
    write(path.join(home, '.codex', 'skills', 'deploy', 'SKILL.md'), 'deploy');
    write(path.join(home, '.codex', 'skills', '.system', 'skill-creator', 'SKILL.md'), 'system');
    write(path.join(home, '.codex', 'skills', 'xdt-agents', 'SKILL.md'), 'managed link');
    const codex = await collectPersonalConfig('codex', [], { env: {}, home });
    expect(decode(codex.personal.files)).toEqual({
      '.agents/skills/review/SKILL.md': 'review',
      '.codex/skills/deploy/SKILL.md': 'deploy',
    });
    expect(codex.roots).toEqual([
      { relative: '.agents/skills/review', local: path.join(home, '.agents', 'skills', 'review') },
      { relative: '.codex/skills/deploy', local: path.join(home, '.codex', 'skills', 'deploy') },
    ]);
    const pi = await collectPersonalConfig('pi', [
      { path: '.agents/skills/review/SKILL.md', data: '' },
    ], { env: {}, home });
    expect(pi.personal.files).toEqual([]);
  });

  it('leaves credential files in personal Skills for later on a shared provider', async () => {
    const home = path.join(root, 'home');
    write(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), 'deploy');
    write(path.join(home, '.claude', 'skills', 'deploy', '.env'), 'TOKEN=1');
    const { personal } = await collectPersonalConfig('claude-code', [], { env: {}, home, skipCredentials: true });
    expect(decode(personal.files)).toEqual({ '.claude/skills/deploy/SKILL.md': 'deploy' });
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

describe('collectInstructionImports', () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const text = (data: string) => Buffer.from(data, 'base64').toString();

  it('brings imported files along and rewrites imports that would not resolve on the other computer', async () => {
    const home = path.join(root, 'home');
    const project = path.join(home, 'code', 'proj');
    write(path.join(project, 'docs', 'rules.md'), 'rules @more.md');
    write(path.join(project, 'docs', 'more.md'), 'more');
    write(path.join(project, 'docs', 'agents-extra.md'), 'extra');
    write(path.join(project, 'ignored.md'), 'ignored');
    write(path.join(project, 'AGENTS.md'), 'agents @docs/agents-extra.md');
    write(path.join(home, '.claude', 'style.md'), 'style');
    write(path.join(home, '.claude', 'RTK.md'), 'rtk');
    write(path.join(home, '.claude', 'tools.md'), 'tools');
    const claude = { path: 'CLAUDE.md', data: b64('See @docs/rules.md and @~/.claude/style.md.\n\`\`\`\n@ignored.md\n\`\`\`\nAlso @AGENTS.md, ask @someone') };
    const agents = { path: 'AGENTS.md', data: b64('agents @docs/agents-extra.md') };
    const rule = { path: '.claude/rules/team.md', data: b64('team rule @../style.md') };
    const personal = { memory: 'memory @RTK.md and @~/.claude/tools.md', files: [rule] };
    const files = await collectInstructionImports(
      { workingDir: project, projectFiles: [claude, agents], ancestorFiles: [], personal },
      { env: {}, home },
    );
    expect(Object.fromEntries(files.map((file) => [`${file.base}:${file.path}`, text(file.data)]))).toEqual({
      'workspace:docs/rules.md': 'rules @more.md',
      'workspace:docs/more.md': 'more',
      'workspace:../../.claude/style.md': 'style',
      'workspace:docs/agents-extra.md': 'extra',
      'session:RTK.md': 'rtk',
      'session:tools.md': 'tools',
    });
    expect(text(claude.data)).toBe('See @docs/rules.md and @../../.claude/style.md.\n\`\`\`\n@ignored.md\n\`\`\`\nAlso @AGENTS.md, ask @someone');
    expect(text(agents.data)).toBe('agents @docs/agents-extra.md');
    expect(text(rule.data)).toBe('team rule @../../../../.claude/style.md');
    expect(personal.memory).toBe('memory @RTK.md and @tools.md');
  });

  it('follows imports five levels deep, like Claude Code', async () => {
    const project = path.join(root, 'proj');
    for (let level = 1; level <= 7; level += 1) write(path.join(project, `l${level}.md`), `@l${level + 1}.md`);
    const files = await collectInstructionImports(
      { workingDir: project, projectFiles: [{ path: 'CLAUDE.md', data: b64('@l1.md') }], ancestorFiles: [], personal: { files: [] } },
      { env: {}, home: path.join(root, 'home') },
    );
    expect(files.map((file) => file.path)).toEqual(['l1.md', 'l2.md', 'l3.md', 'l4.md', 'l5.md']);
  });

  it('leaves imported credential files for later on a shared provider', async () => {
    const project = path.join(root, 'proj');
    write(path.join(project, '.env'), 'TOKEN=1');
    write(path.join(project, 'notes.md'), 'notes');
    const input = { workingDir: project, projectFiles: [{ path: 'CLAUDE.md', data: b64('@.env @notes.md') }], ancestorFiles: [], personal: { files: [] } };
    expect((await collectInstructionImports(input, { env: {}, home: root, skipCredentials: true })).map((file) => file.path))
      .toEqual(['notes.md']);
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
