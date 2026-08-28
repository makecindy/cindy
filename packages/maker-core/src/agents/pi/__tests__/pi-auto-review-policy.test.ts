/**
 * pi Auto-review adapter 单测 —— 只测「pi 工具名/入参 → 归一化动作」的映射与档位结果;
 * 判定逻辑本体的覆盖在 shared/auto-review.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { classifyPiToolForAutoReview } from '../auto-review-policy.js';

const WS = '/Users/t/ws';
const roots = [WS];

function verdict(
  toolName: string,
  input: Record<string, unknown>,
  resolvedCredentialPaths?: readonly string[] | null,
) {
  return classifyPiToolForAutoReview({
    toolName,
    input,
    resolvedCredentialPaths,
    workspaceRoots: roots,
  });
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
  it('allows structured writes only in explicitly writable extra roots', () => {
    const readRoots = [WS, '/Users/t/reference', '/Users/t/output'];
    const writableRoots = [WS, '/Users/t/output'];
    expect(classifyPiToolForAutoReview({
      toolName: 'write', input: { path: '/Users/t/output/result.md' },
      workspaceRoots: roots, readRoots, writableRoots,
    })).toBe('auto-approve');
    expect(classifyPiToolForAutoReview({
      toolName: 'write', input: { path: '/Users/t/reference/spec.md' },
      workspaceRoots: roots, readRoots, writableRoots,
    })).toBe('prompt');
  });

  it('routes bash through the shell classifier', () => {
    expect(verdict('bash', { command: 'ls -la' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'git status' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'git status --verb' })).toBe('prompt-each-time');
    expect(verdict('bash', { command: 'git status --no-v' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'git log -L1,1:.env' })).toBe('prompt-each-time');
    expect(verdict('bash', { command: 'git log -L 1,1:.env.local' })).toBe('prompt-each-time');
    expect(verdict('bash', { command: 'git log -L1,1:README.md' })).toBe('auto-approve');
    expect(verdict('bash', { command: 'ag -u API_KEY .' })).toBe('prompt-each-time');
    expect(verdict('bash', { command: 'ag --hidden API_KEY .' })).toBe('prompt-each-time');
    expect(verdict('bash', { command: 'ag API_KEY ordinary.txt' })).toBe('auto-approve');
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
    expect(verdict('read', { path: `${WS}/.env.local` })).toBe('prompt-each-time');
    expect(verdict('read', { path: `${WS}/.environment` })).toBe('auto-approve');
    expect(verdict('grep', { path: '/Users/t/.aws' })).toBe('prompt-each-time');
    // 凭证特征在非 path 字段(grep pattern / find 表达式)同样必问 —— 与 bridge 全字段扫描同口径
    expect(verdict('grep', { pattern: 'token', path: '/Users/t/.gnupg' })).toBe('prompt-each-time');
    expect(verdict('find', { expression: '~/.ssh/id_ed25519' })).toBe('prompt-each-time');
  });

  it('uses bridge-resolved credential paths and fails closed on invalid evidence', () => {
    const innocentLink = `${WS}/innocent.txt`;
    expect(verdict(
      'read',
      { path: innocentLink },
      ['/Users/t/.ssh/id_rsa'],
    )).toBe('prompt-each-time');
    expect(verdict(
      'bash',
      { command: `cat<${innocentLink}` },
      [`${WS}/secrets/.env`],
    )).toBe('prompt-each-time');

    // Normal symlinks produce no credential evidence and keep their existing fast paths.
    expect(verdict('read', { path: innocentLink }, [])).toBe('auto-approve');
    expect(verdict('bash', { command: `cat<${innocentLink}` }, [])).toBe('auto-approve');
    // Non-empty evidence that no longer matches Host policy indicates protocol drift.
    expect(verdict('read', { path: innocentLink }, [`${WS}/ordinary.txt`])).toBe(
      'prompt-each-time',
    );
    expect(verdict('read', { path: innocentLink }, null)).toBe('prompt-each-time');
    expect(verdict('bash', { command: `cat<${innocentLink}` }, null)).toBe('prompt-each-time');
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

  /**
   * 如实钉住只读工具在本 adapter 的**可达面**:bridge 对 read/grep/find/ls 在非凭证路径时
   * 直接放行、不冒泡(`cindy-bridge-source.ts` 的 READONLY_BUILTINS 快路径),所以能走到这里的
   * 只读调用只有命中凭证路径那一类 —— 由凭证分支收成 prompt-each-time。
   *
   * 反过来说:区外目录级递归读在 Pi 当前**不经** host 审阅(与 Claude 存在行为差异),但那不是
   * 本 adapter 能修的 —— 在这一层加 CC 那套 scope 区分只会得到永不执行的死代码。真修要动
   * bridge 的只读快路径,属独立改动。这条用例的作用是防止后人再次在错误的层加"看起来对"的补丁。
   */
  it('keeps plain reads auto-approved regardless of root (bridge never bubbles them)', () => {
    for (const tool of ['read', 'grep', 'find', 'ls']) {
      expect(verdict(tool, { path: '/Users/t' })).toBe('auto-approve');
      expect(verdict(tool, { path: `${WS}/src` })).toBe('auto-approve');
    }
    // 唯一真会到达这里的只读形态:入参命中凭证路径 → 必问、不可记住。
    expect(verdict('grep', { path: '/Users/t/.aws/credentials' })).toBe('prompt-each-time');
  });

  it('fails closed for MCP and unknown tools', () => {
    expect(verdict('mcp__cindy_orca__start_team', { anything: 1 })).toBe('prompt');
    expect(verdict('some_future_tool', {})).toBe('prompt');
  });

  it('auto-approves first-party durable Subagent spawn without opening unknown tools', () => {
    expect(verdict('subagent', {
      agent: 'worker',
      task: 'implement the fix',
    })).toBe('auto-approve');
    expect(verdict('some_future_tool', {})).toBe('prompt');
  });
});
