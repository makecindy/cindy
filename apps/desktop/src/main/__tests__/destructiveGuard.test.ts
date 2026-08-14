/**
 * destructiveGuard.test.ts
 * ---------------------------------------------------------------------------
 * 守卫只服务于飞书 bot 等"硬禁删除"场景,误判=用户体验崩溃,漏判=数据丢失。
 * 这里把所有关键正例/负例钉死,后续修规则必须保持全绿。
 */

import { describe, it, expect } from 'vitest';
import { checkDestructiveToolCall } from '../destructiveGuard';

describe('checkDestructiveToolCall — tool name match', () => {
  const positives = [
    'mcp__github__delete_branch',
    'mcp__feishu__docx_delete_blocks',
    'RemoveDirectory',
    'unlinkFile',
    'TrashItems',
    'eraseAll',
    'rmdirRecursive',
  ];
  for (const name of positives) {
    it(`denies tool name "${name}"`, () => {
      expect(checkDestructiveToolCall(name, {}).destructive).toBe(true);
    });
  }

  const negatives = [
    'Bash',
    'Write',
    'Edit',
    'Read',
    'AskUserQuestion',
    'ExitPlanMode',
    'mcp__pencil__batch_design',
    'mcp__feishu__docx_read', // contains no destructive keyword
  ];
  for (const name of negatives) {
    it(`allows tool name "${name}" (no command input)`, () => {
      expect(checkDestructiveToolCall(name, {}).destructive).toBe(false);
    });
  }
});

describe('checkDestructiveToolCall — Bash command match', () => {
  const denyCommands = [
    'rm file.txt',
    'rm -rf node_modules',
    'rmdir empty_dir',
    'unlink /tmp/foo',
    'del C:\\temp\\x.log',
    'erase backup.bak',
    'find . -name "*.tmp" -delete',
    'find /var/log -type f -exec rm {} \\;',
    'git clean -fd',
    'git clean -xdf',
    'cd /tmp && rm -rf cache',
    'echo hi; rm bad.txt',
  ];
  for (const cmd of denyCommands) {
    it(`denies Bash command: ${cmd}`, () => {
      const r = checkDestructiveToolCall('Bash', { command: cmd });
      expect(r.destructive).toBe(true);
      expect(r.reason).toBeTruthy();
    });
  }

  it('matches Pi lowercase bash with the same deletion rules', () => {
    expect(checkDestructiveToolCall('bash', { command: 'rm -rf build' })).toEqual({
      destructive: true,
      reason: 'shell command contains `rm`',
    });
  });

  const allowCommands = [
    'ls -la',
    'cat package.json',
    'echo "harm" && echo "term"', // word-boundary safety: no standalone rm
    'node script.js --term',
    'git status',
    'git log --oneline',
    'echo "delete this manually" > note.txt', // string content shouldn't matter; "delete" not a shell verb here, also Bash doesn't have a delete cmd
    'pnpm install',
    'curl https://example.com',
    'mv old.txt new.txt',
  ];
  for (const cmd of allowCommands) {
    it(`allows Bash command: ${cmd}`, () => {
      expect(checkDestructiveToolCall('Bash', { command: cmd }).destructive).toBe(false);
    });
  }
});

describe('checkDestructiveToolCall — PowerShell command match', () => {
  const denyCommands = [
    'Remove-Item C:\\temp -Recurse -Force',
    'remove-item foo.log',
    'Clear-Content .\\log.txt',
    'Clear-Item Env:FOO',
    'Get-ChildItem | Remove-Item',
  ];
  for (const cmd of denyCommands) {
    it(`denies PowerShell command: ${cmd}`, () => {
      expect(checkDestructiveToolCall('PowerShell', { command: cmd }).destructive).toBe(true);
    });
  }

  const allowCommands = [
    'Get-ChildItem',
    'Get-Content README.md',
    'Set-Location .\\apps',
    'New-Item -ItemType Directory tmp',
  ];
  for (const cmd of allowCommands) {
    it(`allows PowerShell command: ${cmd}`, () => {
      expect(checkDestructiveToolCall('PowerShell', { command: cmd }).destructive).toBe(false);
    });
  }
});

describe('checkDestructiveToolCall — edge cases', () => {
  it('returns false when input is null', () => {
    expect(checkDestructiveToolCall('Bash', null).destructive).toBe(false);
  });

  it('returns false when input.command missing', () => {
    expect(checkDestructiveToolCall('Bash', { foo: 'bar' }).destructive).toBe(false);
  });

  it('does not match `rm` substring inside another word (harm, terminal)', () => {
    expect(checkDestructiveToolCall('Bash', { command: 'echo harm; node terminal.js' }).destructive).toBe(false);
  });

  it('does not match `del` substring inside another word (delete, model)', () => {
    expect(checkDestructiveToolCall('Bash', { command: 'echo "delete this"; node model.js' }).destructive).toBe(false);
  });
});
