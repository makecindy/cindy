/**
 * Claude Code 用户可调用命令识别(#11637)。
 *
 * 守的是两条不变式:
 *  - 用户手输一个**确实装着**的 /<command> 时,这一轮不补环境说明,命令原样留在最前面;
 *  - 没装过的名字、相似词、路径、别的引擎,一律维持旧行为(照旧补说明)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  extractSlashCommandName,
  isUserInvocableClaudeCommand,
  resetClaudeUserInvocableCommandCache,
  resolveClaudeUserInvocableCommandNames,
} from '../maker-ipc/claudeSlashCommandGuard';
import { registerSessionSubscriptionAccount } from '../subscription-accounts/session';

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
let fixtureRoot = '';
let workDir = '';
let homeDir = '';
let envConfigDir = '';
let unregisterAccount: (() => void) | undefined;

function writeSkill(name: string, frontmatter: string, configDir = path.join(workDir, '.claude')): void {
  const dir = path.join(configDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 测试用命令\n${frontmatter}---\n\n正文\n`,
    'utf8',
  );
}

function writeCommand(name: string): void {
  const dir = path.join(workDir, '.claude', 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n`, 'utf8');
}

beforeEach(() => {
  fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-slash-guard-')));
  workDir = path.join(fixtureRoot, 'project');
  homeDir = path.join(fixtureRoot, 'home');
  envConfigDir = path.join(fixtureRoot, 'env-config');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(envConfigDir, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  process.env.CLAUDE_CONFIG_DIR = envConfigDir;
  resetClaudeUserInvocableCommandCache();
});

afterEach(() => {
  unregisterAccount?.();
  unregisterAccount = undefined;
  resetClaudeUserInvocableCommandCache();
  vi.restoreAllMocks();
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function useSessionAccount(id: string, configDir: string): void {
  unregisterAccount?.();
  unregisterAccount = registerSessionSubscriptionAccount('session-1', {
    id,
    configDir,
    assertCurrent() {},
    readState: async () => ({ authenticated: true }),
  });
}

describe('extractSlashCommandName', () => {
  it('只认消息最开头的 /<name>', () => {
    expect(extractSlashCommandName('/compact')).toBe('compact');
    expect(extractSlashCommandName('/subtask-fork 先修 MR')).toBe('subtask-fork');
    expect(extractSlashCommandName('/subtask-fork\n第二行')).toBe('subtask-fork');
    expect(extractSlashCommandName('/Subtask-Fork')).toBe('subtask-fork');
  });

  it('相似词、路径、带前缀空格都不是命令', () => {
    expect(extractSlashCommandName(' /compact')).toBeNull();
    expect(extractSlashCommandName('看看 /compact')).toBeNull();
    expect(extractSlashCommandName('/Users/peachy/notes.md')).toBeNull();
    expect(extractSlashCommandName('普通消息')).toBeNull();
    expect(extractSlashCommandName('')).toBeNull();
  });
});

describe('resolveClaudeUserInvocableCommandNames', () => {
  it('装着 skill 与 command 都在名单里;没装的不在', async () => {
    writeSkill('subtask-fork', 'disable-model-invocation: true\n');
    writeCommand('review-note');

    const names = await resolveClaudeUserInvocableCommandNames(workDir, '/subtask-fork ping');

    expect(names.has('subtask-fork')).toBe(true);
    expect(names.has('review-note')).toBe(true);
    expect(names.has('zz-not-a-real-command-xyz')).toBe(false);
  });

  it('非命令开头的消息不扫盘,直接给空名单', async () => {
    writeSkill('subtask-fork', '');

    const names = await resolveClaudeUserInvocableCommandNames(workDir, '普通消息');

    expect(names.size).toBe(0);
  });

  // Unit / #11777 review: an explicit CLI config root is a replacement, not another
  // source to union with ~/.claude. Otherwise another profile can authorize a bare command.
  it('CLAUDE_CONFIG_DIR 是独立配置根,不合并默认 ~/.claude', async () => {
    writeSkill('env-command', '', envConfigDir);
    writeSkill('default-command', '', path.join(homeDir, '.claude'));

    const names = await resolveClaudeUserInvocableCommandNames(workDir, '/env-command');

    expect(names.has('env-command')).toBe(true);
    expect(names.has('default-command')).toBe(false);
  });
});

describe('isUserInvocableClaudeCommand', () => {
  // Unit / §8.4: the live session's registered account is the config-dir source of truth.
  // Switching that account must neither union profiles nor reuse the old profile's cache entry.
  it('只认当前会话账号的命令,切换账号不复用旧缓存', async () => {
    const currentConfigDir = path.join(homeDir, '.claude-cindy-current');
    const otherConfigDir = path.join(homeDir, '.claude-cindy-other');
    writeSkill('current-command', '', currentConfigDir);
    writeSkill('other-command', '', otherConfigDir);
    const local = { id: 'session-1', agentKind: 'claude-code', workDir, remoteHostId: null };
    useSessionAccount('current', currentConfigDir);
    expect(await isUserInvocableClaudeCommand('/current-command', local)).toBe(true);

    useSessionAccount('other', otherConfigDir);
    expect(await isUserInvocableClaudeCommand('/current-command', local)).toBe(false);
    expect(await isUserInvocableClaudeCommand('/other-command', local)).toBe(true);
  });

  it('装着的 skill 认,没装的、别的引擎、远端会话都不认', async () => {
    writeSkill('subtask-fork', 'disable-model-invocation: true\n');

    const local = { agentKind: 'claude-code', workDir, remoteHostId: null };
    expect(await isUserInvocableClaudeCommand('/subtask-fork ping', local)).toBe(true);
    expect(await isUserInvocableClaudeCommand('/zz-not-a-real-command-xyz ping', local)).toBe(false);
    expect(await isUserInvocableClaudeCommand('/subtask-fork', { ...local, agentKind: 'codex' }))
      .toBe(false);
    expect(await isUserInvocableClaudeCommand('/subtask-fork', { ...local, remoteHostId: 'ssh-1' }))
      .toBe(false);
    expect(await isUserInvocableClaudeCommand('普通消息', local)).toBe(false);
  });
});
