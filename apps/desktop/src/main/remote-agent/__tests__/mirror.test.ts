/**
 * 影子目录按你这台的真实路径逐级镜像：上级目录里的说明文件放在对应的上级，个人配置
 * (Claude Code 的 ~/.claude、Codex 的 CODEX_HOME)随任务同步到那台；那台给出的影子路径逐级
 * 映射回你这台的真实路径。
 */
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOCAL_AGENT_CLIENT, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { providerShareGuestPeer } from '@cindy/device-link';
import { createProviderShareUsageStore } from '../../device-link/providerShareUsageStore';

import {
  collectAncestorInstructionFiles,
  collectAncestorMarkers,
  collectInstructionImports,
  collectPersonalConfig,
  collectProjectInstructionFiles,
} from '../controller/projectFiles';
import { shadowAliases, startRemoteAgentSession } from '../controller/startRemote';
import { EXEC_SERVER_NOT_FOUND_CODE } from '../host/execServerShortcut';
import { createRemoteAgentHost, mirrorSegments, type HostedStartInput } from '../host/runHost';
import { createProviderShareMemberPurger, hostedStartOptions } from '../host/service';
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

// Unit tier: real membership ledger, host cleanup adapter and disk index. Controlled
// legacy purge models its documented best-effort failure, which previously let a
// reapproved member revive old native IDs / pending relay tombstones after restart.
describe('reapproved member cleanup admission', () => {
  it('cannot fork an old native session after a reused member ID is admitted again', async () => {
    const ledger = path.join(root, 'usage.json');
    let usage = createProviderShareUsageStore(ledger);
    const controller = providerShareGuestPeer('s', 'm', 'G');
    const identity = { ownerScope: 'owner', ownerDeviceId: 'O', shareId: 's', memberId: 'm' };
    let joinedAt = 'g1';
    const snapshot = () => [{ shareId: 's', members: [{ memberId: 'm', joinedAt }] }];
    const forkHosted = vi.fn(async () => ({ newSdkSessionId: 'native-child', uuidMap: new Map() }));
    const makeHost = () => createRemoteAgentHost({
      isAgentAvailable: () => true, startHosted: async (input) => idleHandle(input), forkHosted,
      isControllerAuthorized: () => usage.memberGenerationReady(identity, joinedAt), controllerTrust: () => 'guest',
      providerAccess: { resolve: async () => 'shared', isAllowed: () => true },
      bindGuestProviderRoute: async () => ({ routeToken: 'route-token', modelIds: ['claude-opus'], release() {} }),
      purgeHostedTranscripts: async () => undefined,
      captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot: path.join(root, 'remote-agent'),
    });
    await usage.reconcileMemberGenerations('owner', 'O', snapshot());
    let current = makeHost();
    const fork = { op: 'fork', sourceSessionId: 'task-1', newSessionId: 'task-2', agentKind: 'claude-code',
      sourceSdkSessionId: 'sdk-1', model: 'claude-opus', upToMessageId: 'message-1' };
    try {
      const runId = randomUUID();
      await current.handle(controller, { op: 'open', runId, agentKind: 'claude-code', payload: { json: {
        sessionId: 'task-1', virtualWorkspace: true, options: { model: 'claude-opus' },
        workspace: { workingDir: '/guest/project', platform: 'darwin', shell: 'zsh' },
        projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [],
      } } });
      await vi.waitFor(() => expect(fs.readFileSync(path.join(root, 'remote-agent', 'guest-sessions.json'), 'utf8')).toContain('sdk-1'));
      await expect(current.handle(controller, fork)).resolves.toMatchObject({ newSdkSessionId: 'native-child' });
      await current.handle(controller, { op: 'close', runId, mode: 'close', reason: 'navigation' });
      current.dispose();
      usage = createProviderShareUsageStore(ledger);
      joinedAt = 'g2';
      await usage.reconcileMemberGenerations('owner', 'O', snapshot());
      current = makeHost();
      await expect(current.handle(controller, fork)).rejects.toThrow();
      const purge = createProviderShareMemberPurger({ userDataDir: root, usage, current,
        ownerScope: () => 'owner', ownerDeviceId: () => 'O', isCurrent: () => true,
        hasAccess: () => usage.memberGenerationReady(identity, joinedAt) });
      await purge(() => true);
      expect(usage.memberGenerationReady(identity, joinedAt)).toBe(true);
      await expect(current.handle(controller, fork)).rejects.toThrow('REMOTE_AGENT_INVALID');
      expect(forkHosted).toHaveBeenCalledTimes(1);
    } finally { current.dispose(); }
  });

  it('waits for legacy relay forgets and preserves directory cleanup receipts after an index deletion failure', async () => {
    const ledger = path.join(root, 'usage.json');
    let usage = createProviderShareUsageStore(ledger);
    const controller = providerShareGuestPeer('s', 'm', 'G');
    const index = path.join(root, 'remote-agent', 'guest-sessions.json');
    const home = path.join(root, 'remote-agent', 'guest-homes', createHash('sha256').update(controller).digest('hex').slice(0, 16));
    const member = { ownerScope: 'owner', ownerDeviceId: 'O', shareId: 's', memberId: 'm' };
    const snapshot = (joinedAt: string) => [{ shareId: 's', members: [{ memberId: 'm', joinedAt }] }];
    await usage.reconcileMemberGenerations('owner', 'O', snapshot('g1'));
    write(index, JSON.stringify({ old: { controller, nativeIds: ['old-native'], hostSessionIds: ['old-task'], relayDevices: ['M'] } }));
    write(path.join(home, 'native-history'), 'private g1 data');
    usage = createProviderShareUsageStore(ledger);
    await usage.reconcileMemberGenerations('owner', 'O', snapshot('g2'));
    const purgeControllers = vi.fn(async (match: (peer: string) => boolean) => {
      expect(match(controller)).toBe(true);
      write(index, JSON.stringify({ old: { controller, nativeIds: [], forgetPending: ['M'] } }));
    });
    const makePurger = () => createProviderShareMemberPurger({ userDataDir: root, usage,
      current: { purgeControllers, activeControllers: () => [] }, ownerScope: () => 'owner', ownerDeviceId: () => 'O',
      isCurrent: () => true, hasAccess: () => usage.memberGenerationReady(member, 'g2') });
    await expect(makePurger()(() => true)).rejects.toThrow('legacy history cleanup is still pending');
    expect(usage.memberGenerationReady(member, 'g2')).toBe(false);
    // A pending relay forget must not be converted back to a live relayDevices entry.
    expect(JSON.parse(fs.readFileSync(index, 'utf8')).old.forgetPending).toEqual(['M']);
    write(path.join(home, 'native-history'), 'failed legacy directory deletion');
    purgeControllers.mockImplementation(async () => { fs.rmSync(index); });
    const originalRm = fsp.rm.bind(fsp);
    const rm = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(home)) throw new Error('guest home busy');
      await originalRm(target, options);
    });
    await expect(makePurger()(() => true)).rejects.toThrow('guest home busy');
    rm.mockRestore();
    usage = createProviderShareUsageStore(ledger);
    expect(usage.listPendingMemberCleanup('owner', 'O')[0]?.cleanupScopes).toContainEqual({ controller });
    expect(usage.memberGenerationReady(member, 'g2')).toBe(false);
    purgeControllers.mockImplementation(async () => undefined);
    await makePurger()(() => true);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(index)).toBe(false);
    expect(usage.memberGenerationReady(member, 'g2')).toBe(true);
    const purger = makePurger();
    purgeControllers.mockImplementation(async (match) => { expect(match(controller)).toBe(false); });
    await purger(() => true); // delayed duplicate must not delete a new g2 task
  });
});

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

  it.each(['/runs', 'C:\\runs'])('reads inherited fork paths from %s in the original project without granting parent access', (runs) => {
    const native = runs.startsWith('C:') ? path.win32 : path.posix;
    const project = path.join(root, 'project');
    write(path.join(project, 'src', 'index.ts'), 'original file');
    const mirrorRoot = native.join(runs, 'child', 'fs');
    const previousMirrorRoots = ['source', 'parent'].map((id) => native.join(runs, id, 'fs'));
    const suffix = native.join('workspace', ...Array.from({ length: MAX_ANCESTOR_LEVELS }, () => 'p'));
    const shadowDir = native.join(mirrorRoot, suffix);
    const workspace = new ExecutorWorkspace({ workingDir: project });
    workspace.setAliases(shadowAliases({ shadowDir, mirrorRoot, virtualWorkspace: true, previousMirrorRoots }, project, []));
    workspace.setVirtualRoot(mirrorRoot);
    for (const previous of previousMirrorRoots) {
      const resolved = workspace.resolve(native.join(previous, suffix, 'src', 'index.ts'));
      expect(workspace.contains(resolved)).toBe(true);
      expect(fs.readFileSync(resolved, 'utf8')).toBe('original file');
      expect(workspace.contains(workspace.resolve(native.join(previous, suffix, '..', 'outside.txt')))).toBe(false);
    }
    expect(workspace.resolve(workspace.toAgentPath(path.join(project, 'src', 'index.ts')))).toBe(path.join(project, 'src', 'index.ts'));
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
    const application = hostedStartOptions({ ...input,
      options: { ...input.options, localApplication: { mcpName: 'hhh', hostToolsOnly: true, storageKey: 'a'.repeat(64) } },
      localApplicationStorage: path.join(root, 'app-runtime'), mcpServers: ['hhh'],
    });
    expect(application[LOCAL_AGENT_CLIENT]).toEqual({ url: `${input.tunnel.url}/mcp/hhh`, token: input.tunnel.token,
      mcpName: 'hhh', hostToolsOnly: true, storageDirectory: path.join(root, 'app-runtime') });
    expect(application.deviceHosted?.tunnelUrl).toBe(input.tunnel.url);
    expect(() => hostedStartOptions({ ...input, options: { ...input.options, localApplication: { mcpName: 'hhh', hostToolsOnly: true, storageKey: 'a'.repeat(64) } } })).toThrow('REMOTE_AGENT_INVALID');
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

  // 2026-10-22 远程供应商调查：Codex 沿虚拟工作区逐级查找，虚拟垫层与任务电脑已报「没有」的标记可以本机回答。
  // 镜像外的隐藏文件可能在任务电脑同一路径真实存在(#6844 review)，没有确认不存在的一律照常转发。
  it('answers lookups the task computer cannot map on this computer and forwards the rest', async () => {
    const project = path.join(root, 'work', 'proj');
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    write(path.join(project, 'hello.txt'), 'hi');
    write(path.join(root, 'work', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    write(path.join(root, '.bashrc'), 'export TASK_SHELL_CONFIG=1\n');
    // Regression: ancestor absence must preserve existing plugin roots, including their files.
    const pluginMarkers = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'];
    for (const marker of pluginMarkers) {
      write(path.join(root, 'work', marker, 'plugin.json'), JSON.stringify({ name: 'qa-plugin' }));
    }
    const inputs: HostedStartInput[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => {
        inputs.push(input);
        // 事件流一直开着，任务(和它的隧道)活到测试结束。
        return {
          ...idleHandle(input),
          async close() { stop(); },
          events: () => ({
            [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => ({
              next: async () => {
                await stopped;
                return { done: true, value: undefined };
              },
            }),
          }),
        };
      },
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: path.join(root, 'host'),
    });
    const forwarded = new Set<number>();
    const handle = await startRemoteAgentSession('claude-code', {
      sessionId: 'task-lookups',
      workingDir: project,
      extraDirs: [external],
      model: 'claude-opus',
      permissionMode: 'default',
    }, {
      invoke: async (args) => {
        const request = JSON.parse(JSON.stringify(args[0])) as { op: string };
        // 本测试只看哪些消息到了任务所在电脑：不让控制端关掉这条连接(Claude Code 的控制端没有 exec-server 中继)。
        if (request.op === 'push') return {};
        const result = JSON.parse(JSON.stringify(await host.handle('controller-1', request) ?? null)) as { runs?: Array<{ data?: string }> } | null;
        for (const run of request.op === 'poll' ? result?.runs ?? [] : []) {
          for (const line of Buffer.from(run.data ?? '', 'base64').toString('utf8').split('\n').filter(Boolean)) {
            const item = JSON.parse(line) as { t?: string; kind?: string; data?: string };
            if (item.t === 'ws' && item.kind === 'message' && item.data) forwarded.add((JSON.parse(item.data) as { id: number }).id);
          }
        }
        return result;
      },
      rgPath: RG,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      collectProjectFiles: async () => [],
      collectAncestorMarkers,
      isGitRepo: async () => false,
      newId: randomUUID,
    });
    const [input] = inputs;
    // 任务所在电脑上的映射(控制端实际使用的那一份)：有对应目录的最上一级是项目的真实根目录。
    const mapped = new ExecutorWorkspace({ workingDir: project, aliases: shadowAliases(
      { ...input, virtualWorkspace: true }, project, [], { extraDirs: [external], writableDirs: [] },
    ) });
    let top = input.shadowDir;
    while (mapped.localPathFromAgent(path.dirname(top)) !== null && path.dirname(top) !== top) top = path.dirname(top);
    const padded = path.dirname(top);
    expect(padded.startsWith(path.join(input.mirrorRoot, 'workspace'))).toBe(true);
    const parent = path.dirname(input.shadowDir);
    const grandparent = path.dirname(parent);
    // Windows 的生产路径映射不区分大小写；原矩阵只有小写，遗漏了会把已存在目录误报 -32004 的输入。
    // 同一 standard fixture 经真实 Host/隧道验证 HOME、TMP、ADDITIONAL，并确认原执行器能解析到现有目录。
    const mappedCaseVariants = process.platform === 'win32' ? [
      path.join(input.mirrorRoot, 'HOME'),
      path.join(input.mirrorRoot, 'TMP'),
      path.join(input.mirrorRoot, 'ADDITIONAL', 'dir-0'),
    ] : [];
    for (const target of mappedCaseVariants) expect(fs.existsSync(mapped.resolve(target))).toBe(true);
    const cases = [
      ...mappedCaseVariants.map((target) => ({ target, local: false })),
      { target: path.join(input.shadowDir, 'hello.txt'), local: false },
      { target: path.join(input.shadowDir, '.git'), local: false },
      { target: path.join(parent, '.git'), local: false },
      { target: path.join(parent, '.git', 'HEAD'), local: false },
      ...pluginMarkers.flatMap(marker => [
        { target: path.join(parent, marker, 'plugin.json'), local: false },
        { target: path.join(root, 'work', marker, 'plugin.json'), local: false },
      ]),
      { target: path.join(top, 'not-a-marker'), local: false },
      { target: path.join(input.mirrorRoot, 'home', '.agents', 'skills'), local: false },
      { target: path.join(path.parse(input.mirrorRoot).root, 'not-a-cindy-dir', 'tool'), local: false },
      // 镜像外的绝对路径会原样交给任务电脑；同一路径下的隐藏文件/已存在标记不能凭点前缀判不存在。
      { target: path.join(root, '.bashrc'), local: false },
      { target: path.join(root, 'work', '.git', 'HEAD'), local: false },
      { target: path.join(root, '.codex-plugin', 'plugin.json'), local: true },
      { target: path.join(grandparent, '.git'), local: true },
      { target: path.join(grandparent, '.cursor-plugin', 'plugin.json'), local: true },
      { target: path.join(padded, '.git'), local: true },
      { target: path.join(padded, '.codex-plugin', 'plugin.json'), local: true },
      { target: path.join(input.mirrorRoot, 'workspace', '.agents', 'skills'), local: true },
      { target: path.join(path.dirname(path.dirname(input.mirrorRoot)), '.claude-plugin', 'plugin.json'), local: false },
    ];
    const ws = new WebSocket(`${input.tunnel.url.replace(/^http/, 'ws')}/ws/exec-server`, { headers: { authorization: `Bearer ${input.tunnel.token}` } });
    const replies = new Map<number, { error?: { code?: number } }>();
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as { id: number; error?: { code?: number } };
      replies.set(message.id, message);
    });
    await once(ws, 'open');
    try {
      cases.forEach(({ target }, index) => ws.send(JSON.stringify({ id: index + 1, method: 'fs/getMetadata', params: { path: pathToFileURL(target).href } })));
      const localIds = cases.flatMap(({ local }, index) => local ? [index + 1] : []);
      const forwardedIds = cases.flatMap(({ local }, index) => local ? [] : [index + 1]);
      await vi.waitFor(() => {
        expect([...replies.keys()].sort((a, b) => a - b)).toEqual(localIds);
        expect([...forwarded].sort((a, b) => a - b)).toEqual(forwardedIds);
      });
      for (const id of localIds) expect(replies.get(id)?.error?.code).toBe(EXEC_SERVER_NOT_FOUND_CODE);
      // 映射不到的绝对路径会原样转发；本机回答的所有目标在任务电脑上都确实不存在。
      for (const { target } of cases.filter(({ local }) => local)) {
        const real = mapped.localPathFromAgent(target) ?? target;
        expect(fs.existsSync(real)).toBe(false);
      }
      expect(fs.existsSync(mapped.localPathFromAgent(path.join(parent, '.git', 'HEAD'))!)).toBe(true);
      expect(fs.readFileSync(path.join(root, '.bashrc'), 'utf8')).toContain('TASK_SHELL_CONFIG');
    } finally {
      ws.close();
      await handle.close({ reason: 'navigation' });
      host.dispose();
    }
  });
});
