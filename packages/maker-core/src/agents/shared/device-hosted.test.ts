import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DeviceHostedSession } from '../base-agent.js';
import {
  DEVICE_HOSTED_DISALLOWED_CLAUDE_TOOLS,
  DEVICE_HOSTED_GUEST_CLAUDE_TOOLS,
  deviceHostedEnvironmentNote,
  deviceHostedGuestAgentDenial,
  deviceHostedGuestClaudeMdExcludes,
  deviceHostedGuestSessionRoot,
  deviceHostedPiEnvValue,
  isInsideDeviceHostedRoot,
  deviceHostedSubagentAllows,
  parseClaudeAgentToolRule,
  type DeviceHostedAgentToolRule,
} from './device-hosted.js';

function hosted(overrides: Partial<DeviceHostedSession> = {}): DeviceHostedSession {
  return {
    tunnelUrl: 'http://127.0.0.1:4000/t/tok/',
    tunnelToken: 'tok',
    workingDir: '/Users/me/project',
    platform: 'darwin',
    shell: 'zsh',
    extraDirs: [],
    writableDirs: [],
    isGitRepo: true,
    mcpServers: [],
    ...overrides,
  };
}

describe('deviceHostedGuestClaudeMdExcludes', () => {
  const sessionRoot = path.resolve('/data/cindy/remote-agent/workspaces/c1/s1');
  const mirrorRoot = path.join(sessionRoot, 'fs');
  const slash = (value: string) => value.split(path.sep).join('/');

  it('is empty for same-account sessions', () => {
    expect(deviceHostedGuestClaudeMdExcludes(hosted({ mirrorRoot }))).toEqual([]);
  });

  it('excludes every CLAUDE.md above the session root, not inside it', () => {
    const excludes = deviceHostedGuestClaudeMdExcludes(hosted({ mirrorRoot, guest: true }));
    const parent = path.dirname(sessionRoot);
    const top = path.parse(sessionRoot).root;
    expect(excludes).toContain(slash(path.join(parent, 'CLAUDE.md')));
    expect(excludes).toContain(path.join(parent, 'CLAUDE.local.md'));
    expect(excludes).toContain(slash(path.join(top, 'CLAUDE.md')));
    expect(excludes).toContain(`${slash(path.join(parent, '.claude', 'rules'))}/**`);
    expect(excludes.some((entry) => entry.startsWith(slash(sessionRoot)) || entry.startsWith(sessionRoot))).toBe(false);
  });
});

describe('deviceHostedPiEnvValue', () => {
  it('omits the mirror root when the shadow is not mirrored', () => {
    expect(JSON.parse(deviceHostedPiEnvValue(hosted()))).not.toHaveProperty('mirrorRoot');
  });

  it('carries the mirror root so the bridge can map shadow ancestors back', () => {
    expect(JSON.parse(deviceHostedPiEnvValue(hosted({ mirrorRoot: '/runs/ws/abc/s1/fs' }))).mirrorRoot)
      .toBe('/runs/ws/abc/s1/fs');
  });

  it('marks shared-user sessions and leaves same-account values unchanged', () => {
    expect(JSON.parse(deviceHostedPiEnvValue(hosted({ guest: true }))).guest).toBe(true);
    expect(deviceHostedPiEnvValue(hosted())).toBe(JSON.stringify({
      url: 'http://127.0.0.1:4000/t/tok/',
      token: 'tok',
      cwd: '/Users/me/project',
      platform: 'darwin',
      shell: 'zsh',
    }));
  });
});

describe('device-hosted guest session root', () => {
  it('is the session directory above the virtual workspace, or the shadow directory on the old protocol', () => {
    const sessionRoot = path.resolve('/data/cindy/remote-agent/workspaces/c1/s1');
    expect(deviceHostedGuestSessionRoot(hosted({ mirrorRoot: path.join(sessionRoot, 'fs') }), '/ignored')).toBe(sessionRoot);
    expect(deviceHostedGuestSessionRoot(hosted(), path.resolve('/shadow/dir'))).toBe(path.resolve('/shadow/dir'));
  });

  it('accepts paths inside the root (including symlinked spellings) and rejects siblings and parents', () => {
    const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'device-hosted-root-')));
    try {
      const root = path.join(base, 'session');
      mkdirSync(path.join(root, 'fs', 'workspace'), { recursive: true });
      expect(isInsideDeviceHostedRoot(root, root)).toBe(true);
      expect(isInsideDeviceHostedRoot(path.join(root, 'fs', 'workspace', 'SKILL.md'), root)).toBe(true);
      expect(isInsideDeviceHostedRoot(base, root)).toBe(false);
      expect(isInsideDeviceHostedRoot(path.join(base, 'session-other', 'x'), root)).toBe(false);
      expect(isInsideDeviceHostedRoot(path.join(base, '..session', 'x'), root)).toBe(false);
      expect(isInsideDeviceHostedRoot(path.join(root.toUpperCase(), 'fs'), root, 'win32')).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('deviceHostedEnvironmentNote', () => {
  it('uses an agent-local workspace while preserving the execution platform and shell', () => {
    const note = deviceHostedEnvironmentNote(hosted({ workingDir: '/Users/agent/ws', platform: 'win32', shell: 'bash', extraDirs: ['/Users/agent/additional'] }), '/Users/agent/ws');
    expect(note).toContain('/Users/agent/ws');
    expect(note).toContain('win32, shell: bash');
    expect(note).not.toContain('computer');
    expect(note).not.toContain('only holds a copy');
  });
  it('has no personal section without personal instructions', () => {
    expect(deviceHostedEnvironmentNote(hosted(), '/shadow')).not.toContain('personal instructions');
    expect(deviceHostedEnvironmentNote(hosted({ personalInstructions: '  \n ' }), '/shadow'))
      .not.toContain('personal instructions');
  });

  it("appends the user's personal instructions from their computer", () => {
    const note = deviceHostedEnvironmentNote(hosted({ personalInstructions: '  Always answer in Chinese.\n' }), '/shadow');
    expect(note).toContain("# The user's personal instructions\nAlways answer in Chinese.");
    expect(note.indexOf('Is a git repository')).toBeLessThan(note.indexOf('personal instructions'));
  });
});

describe('parseClaudeAgentToolRule', () => {
  it('reads name, tools and disallowedTools from frontmatter', () => {
    expect(parseClaudeAgentToolRule([
      '---',
      'name: reviewer',
      'description: Reviews code',
      'tools: Read, Grep, Bash(git diff:*)',
      'disallowedTools: ["Write", \'Edit\']',
      '---',
      'Body',
    ].join('\n'))).toEqual({
      name: 'reviewer',
      rule: { tools: ['Read', 'Grep', 'Bash(git diff:*)'], disallowedTools: ['Write', 'Edit'] },
    });
  });

  it('accepts the kebab-case key and CRLF line endings', () => {
    expect(parseClaudeAgentToolRule('---\r\nname: "docs"\r\ndisallowed-tools: Bash\r\n---\r\n'))
      .toEqual({ name: 'docs', rule: { disallowedTools: ['Bash'] } });
  });

  it('returns no rule when the agent inherits every tool', () => {
    expect(parseClaudeAgentToolRule('---\nname: helper\n---\n')).toEqual({ name: 'helper', rule: {} });
  });

  it('ignores files without frontmatter or a name', () => {
    expect(parseClaudeAgentToolRule('# Just markdown')).toBeNull();
    expect(parseClaudeAgentToolRule('---\ntools: Read\n---\n')).toBeNull();
  });
});

describe('deviceHostedSubagentAllows', () => {
  const none = new Map<string, DeviceHostedAgentToolRule>();

  it('keeps the built-in read-only agents read-only', () => {
    for (const agent of ['Explore', 'Plan']) {
      expect(deviceHostedSubagentAllows(agent, 'Write', none)).toBe(false);
      expect(deviceHostedSubagentAllows(agent, 'Edit', none)).toBe(false);
      expect(deviceHostedSubagentAllows(agent, 'NotebookEdit', none)).toBe(false);
      expect(deviceHostedSubagentAllows(agent, 'Read', none)).toBe(true);
      expect(deviceHostedSubagentAllows(agent, 'Bash', none)).toBe(true);
    }
  });

  it('does not restrict agents without a definition', () => {
    expect(deviceHostedSubagentAllows('general-purpose', 'Write', none)).toBe(true);
    expect(deviceHostedSubagentAllows('unknown', 'Bash', none)).toBe(true);
  });

  it('applies a custom allow list, including parameterised and prefixed entries', () => {
    const rules = new Map<string, DeviceHostedAgentToolRule>([
      ['reader', { tools: ['Read', 'Bash(git log:*)'] }],
      ['prefixed', { tools: ['mcp__cindy_exec__Edit'] }],
      ['star', { tools: ['*'] }],
    ]);
    expect(deviceHostedSubagentAllows('reader', 'Read', rules)).toBe(true);
    expect(deviceHostedSubagentAllows('reader', 'Write', rules)).toBe(false);
    expect(deviceHostedSubagentAllows('prefixed', 'Edit', rules)).toBe(true);
    expect(deviceHostedSubagentAllows('prefixed', 'Read', rules)).toBe(false);
    expect(deviceHostedSubagentAllows('star', 'Write', rules)).toBe(true);
  });

  it('scopes parameterised entries to the command of this call', () => {
    const rules = new Map<string, DeviceHostedAgentToolRule>([
      ['reader', { tools: ['Read', 'Bash(git log:*)'] }],
    ]);
    // 范围内放行；范围外不放行 —— 参数化条目不能当成整个 Bash 的通行证。
    expect(deviceHostedSubagentAllows('reader', 'Bash', rules, { command: 'git log --oneline' })).toBe(true);
    expect(deviceHostedSubagentAllows('reader', 'Bash', rules, { command: 'git log' })).toBe(true);
    expect(deviceHostedSubagentAllows('reader', 'Bash', rules, { command: 'git push origin' })).toBe(false);
    expect(deviceHostedSubagentAllows('reader', 'Bash', rules, { command: 'rm -rf /' })).toBe(false);
    // 拿不到本次命令时不放行(无法证明在范围内)。
    expect(deviceHostedSubagentAllows('reader', 'Bash', rules)).toBe(false);
    expect(deviceHostedSubagentAllows('reader', 'Bash', rules, {})).toBe(false);
    // 参数化条目不覆盖跟随 Bash 的后台壳工具；非参数化条目才覆盖。
    expect(deviceHostedSubagentAllows('reader', 'BashOutput', rules, { command: 'git log' })).toBe(false);
  });

  it('applies parameterised deny entries only to matching commands', () => {
    const rules = new Map<string, DeviceHostedAgentToolRule>([
      ['no-push', { disallowedTools: ['Bash(git push:*)'] }],
    ]);
    expect(deviceHostedSubagentAllows('no-push', 'Bash', rules, { command: 'git push origin main' })).toBe(false);
    expect(deviceHostedSubagentAllows('no-push', 'Bash', rules, { command: 'git diff' })).toBe(true);
    expect(deviceHostedSubagentAllows('no-push', 'BashOutput', rules)).toBe(true);
    // 无法证明不命中时按拦下处理。
    expect(deviceHostedSubagentAllows('no-push', 'Bash', rules)).toBe(false);
  });

  it('lets background shell helpers follow Bash', () => {
    const rules = new Map<string, DeviceHostedAgentToolRule>([
      ['no-shell', { disallowedTools: ['Bash'] }],
      ['shell', { tools: ['Bash'] }],
    ]);
    expect(deviceHostedSubagentAllows('no-shell', 'BashOutput', rules)).toBe(false);
    expect(deviceHostedSubagentAllows('no-shell', 'KillShell', rules)).toBe(false);
    expect(deviceHostedSubagentAllows('shell', 'BashOutput', rules)).toBe(true);
    expect(deviceHostedSubagentAllows('shell', 'Read', rules)).toBe(false);
  });

  it('lets a custom definition override a built-in name', () => {
    const rules = new Map<string, DeviceHostedAgentToolRule>([['Plan', { tools: ['Write'] }]]);
    expect(deviceHostedSubagentAllows('Plan', 'Write', rules)).toBe(true);
  });
});

describe('device-hosted guest Claude tools', () => {
  it('never lists tools that act on this computer, its other sessions or its user account', () => {
    const forbidden = [
      ...DEVICE_HOSTED_DISALLOWED_CLAUDE_TOOLS,
      // 其他会话
      'ListAgents', 'SendMessage',
      // 本机用户的 claude.ai 账号
      'Artifact', 'RemoteTrigger', 'DesignSync', 'ClaudeDesign', 'Projects', 'Workflow', 'PushNotification',
      'ReadNotifications', 'SendFeedback', 'ProposeSkills', 'ProposeGoal',
      // 本机文件、命令与网络
      'Monitor', 'SendUserFile', 'LSP', 'WebFetch', 'OfferChromeSetup',
    ];
    for (const name of forbidden) expect(DEVICE_HOSTED_GUEST_CLAUDE_TOOLS).not.toContain(name);
  });

  it('keeps subagents, questions, plan mode, tasks, skills and web search', () => {
    for (const name of ['Agent', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'ToolSearch', 'Skill', 'WebSearch']) {
      expect(DEVICE_HOSTED_GUEST_CLAUDE_TOOLS).toContain(name);
    }
  });

  it('refuses subagent isolation and leaves other calls alone', () => {
    expect(deviceHostedGuestAgentDenial('Agent', { prompt: 'x', isolation: 'remote' })).toMatch(/isolation/);
    expect(deviceHostedGuestAgentDenial('Task', { prompt: 'x', isolation: 'worktree' })).toMatch(/isolation/);
    expect(deviceHostedGuestAgentDenial('Agent', { prompt: 'x' })).toBeNull();
    expect(deviceHostedGuestAgentDenial('Agent', undefined)).toBeNull();
    expect(deviceHostedGuestAgentDenial('WebSearch', { isolation: 'remote' })).toBeNull();
  });
});
