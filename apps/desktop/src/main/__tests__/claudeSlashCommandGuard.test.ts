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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractSlashCommandName,
  isUserInvocableClaudeCommand,
  resetClaudeUserInvocableCommandCache,
  resolveClaudeUserInvocableCommandNames,
} from '../maker-ipc/claudeSlashCommandGuard';

let workDir = '';

function writeSkill(name: string, frontmatter: string): void {
  const dir = path.join(workDir, '.claude', 'skills', name);
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
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-slash-guard-')));
  resetClaudeUserInvocableCommandCache();
});

afterEach(() => {
  resetClaudeUserInvocableCommandCache();
  fs.rmSync(workDir, { recursive: true, force: true });
});

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
});

describe('isUserInvocableClaudeCommand', () => {
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
