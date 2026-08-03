/**
 * pi Auto-review adapter 单测 —— 只测「pi 工具名/入参 → 归一化动作」的映射与档位结果;
 * 判定逻辑本体的覆盖在 shared/auto-review.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { classifyPiToolForAutoReview } from '../auto-review-policy.js';

const WS = '/Users/t/ws';
const roots = [WS];

function verdict(toolName: string, input: Record<string, unknown>) {
  return classifyPiToolForAutoReview({ toolName, input, workspaceRoots: roots });
}

describe('classifyPiToolForAutoReview', () => {
  it('approves file writes inside the workspace, escalates outside or pathless', () => {
    expect(verdict('edit', { path: `${WS}/src/a.ts` })).toBe('auto-approve');
    expect(verdict('write', { path: `${WS}/README.md` })).toBe('auto-approve');
    expect(verdict('write', { path: '/tmp/outside.txt' })).toBe('prompt');
    // 系统目录写不交灰区 reviewer 静默裁决。
    expect(verdict('write', { path: '/etc/hosts' })).toBe('prompt-each-time');
    expect(verdict('edit', {})).toBe('prompt');
  });

  it('allows reads but not writes in extra read-only roots', () => {
    const readRoots = [WS, '/Users/t/reference'];
    expect(classifyPiToolForAutoReview({
      toolName: 'read', input: { path: '/Users/t/reference/spec.md' }, workspaceRoots: roots, readRoots,
    })).toBe('auto-approve');
    expect(classifyPiToolForAutoReview({
      toolName: 'write', input: { path: '/Users/t/reference/spec.md' }, workspaceRoots: roots, readRoots,
    })).toBe('prompt');
  });

  it('routes bash through the shell classifier', () => {
    expect(verdict('bash', { command: 'ls -la' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'git status' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'sudo whoami' })).toBe('prompt-each-time');
    // Destructive but replaceable actions are gray: the current-model reviewer
    // should block or ask with the actual user intent instead of always interrupting.
    expect(verdict('bash', { command: 'rm -rf build' })).toBe('prompt');
    // 区外/整根破坏是确定性红线。
    expect(verdict('bash', { command: 'rm -rf /' })).toBe('prompt-each-time');
    // 入参缺失/非字符串 → 空命令 → 无法判定,升级
    expect(verdict('bash', {})).not.toBe('auto-approve');
  });

  it('approves plain reads but always prompts for credential paths (bridge-drift defense)', () => {
    expect(verdict('read', { path: `${WS}/src/a.ts` })).toBe('auto-approve');
    expect(verdict('read', { path: '/Users/t/.ssh/id_rsa' })).toBe('prompt-each-time');
    expect(verdict('grep', { path: '/Users/t/.aws' })).toBe('prompt-each-time');
    // 凭证特征在非 path 字段(grep pattern / find 表达式)同样必问 —— 与 bridge 全字段扫描同口径
    expect(verdict('grep', { pattern: 'token', path: '/Users/t/.gnupg' })).toBe('prompt-each-time');
    expect(verdict('find', { expression: '~/.ssh/id_ed25519' })).toBe('prompt-each-time');
  });

  it('catches /proc environ variants including task/<tid> (env dump = credentials)', () => {
    expect(verdict('read', { path: '/proc/self/environ' })).toBe('prompt-each-time');
    expect(verdict('read', { path: '/proc/1234/environ' })).toBe('prompt-each-time');
    // task/<tid>/environ 读的是同一份进程环境(含注入的 provider key)—— 曾被 [^/\s]* 漏判
    expect(verdict('read', { path: '/proc/self/task/1/environ' })).toBe('prompt-each-time');
    expect(verdict('grep', { path: '/proc/999/task/1000/environ' })).toBe('prompt-each-time');
  });

  it.each([
    '/Users/t/.azure/accessTokens.json',
    '/Users/t/.git-credentials',
    '/Users/t/.cargo/credentials.toml',
    '/Users/t/.m2/settings.xml',
    '/Users/t/.config/gh/hosts.yml',
    '/Users/t/.config/containers/auth.json',
  ])('keeps Pi readonly access behind approval for canonical credential path %s', (credentialPath) => {
    expect(verdict('read', { path: credentialPath })).toBe('prompt-each-time');
  });

  it('recurses into array / nested-object inputs for credential paths', () => {
    expect(verdict('read', { paths: ['/tmp/ok.txt', '/Users/t/.ssh/id_rsa'] })).toBe('prompt-each-time');
    expect(verdict('grep', { opts: { path: '/Users/t/.aws/credentials' } })).toBe('prompt-each-time');
    expect(verdict('read', { paths: [`${WS}/a.ts`, `${WS}/b.ts`] })).toBe('auto-approve');
  });

  it('fails closed for MCP and unknown tools', () => {
    expect(verdict('mcp__cindy_orca__start_team', { anything: 1 })).toBe('prompt');
    expect(verdict('some_future_tool', {})).toBe('prompt');
  });
});
