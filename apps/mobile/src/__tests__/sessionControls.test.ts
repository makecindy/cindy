import { describe, expect, it } from 'vitest';
import {
  buildContextUsageCreateOpts,
  canUseLocalCodexRateLimitControl,
  shouldFallbackToLegacyCodexUsage,
  summarizeContextUsage,
  summarizeSessionSpend,
} from '@/session/sessionControls';
import type { RemoteSession } from '@/session/types';

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 's1',
    userId: 'u1',
    title: 'Session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('sessionControls', () => {
  it('builds desktop-compatible context usage create options', () => {
    expect(buildContextUsageCreateOpts(session())).toEqual({
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      permissionMode: 'ask',
      fastMode: false,
    });
    expect(buildContextUsageCreateOpts(session({ agentKind: 'codex', fastMode: true }))).toMatchObject({
      agentKind: 'codex',
      fastMode: true,
    });
  });

  it('exposes local Codex quota controls only for local subscription sessions', () => {
    expect(canUseLocalCodexRateLimitControl(session({
      agentKind: 'codex',
      model: 'gpt-5.5',
    }))).toBe(true);
    expect(canUseLocalCodexRateLimitControl(session({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'openai',
    }))).toBe(true);
    expect(canUseLocalCodexRateLimitControl(session({
      agentKind: 'codex',
      model: 'gpt-5.5',
      remoteHostId: 'ssh-host-1',
    }))).toBe(false);
    expect(canUseLocalCodexRateLimitControl(session({
      agentKind: 'codex',
      model: 'gpt-5.5',
      providerId: 'xd',
    }))).toBe(false);
    expect(canUseLocalCodexRateLimitControl(session({
      agentKind: 'codex',
      model: 'codex/gpt-5.5',
    }))).toBe(false);
    expect(canUseLocalCodexRateLimitControl(session({
      agentKind: 'codex',
      model: 'xai/grok-4.3',
      providerId: 'xai',
    }))).toBe(false);
    expect(canUseLocalCodexRateLimitControl(session({ agentKind: 'cc' }))).toBe(false);
  });

  it('does not reuse legacy quota after an account-change precondition', () => {
    expect(shouldFallbackToLegacyCodexUsage({
      code: 'PRECONDITION_FAILED',
      message: 'ACCOUNT_CHANGED: refresh usage',
    })).toBe(false);
    expect(shouldFallbackToLegacyCodexUsage(new Error('new channel unavailable'))).toBe(true);
  });

  it('summarizes common context usage shapes for mobile display', () => {
    expect(summarizeContextUsage({
      contextTokens: 12000,
      maxContextTokens: 200000,
      percent: 0.06,
      costUsd: 0.12345,
    })).toEqual({
      title: 'Context usage',
      detail: '12,000 / 200,000 tokens · 6% · $0.1235',
      rows: [],
    });
    expect(summarizeContextUsage(null)).toEqual({
      title: 'Context usage',
      detail: '暂无上下文数据',
      rows: [],
    });
  });

  it('summarizes desktop structured context usage details for mobile system cards', () => {
    expect(summarizeContextUsage({
      totalTokens: 42000,
      rawMaxTokens: 200000,
      percentage: 21,
      model: 'claude-sonnet-4-6',
      categories: [
        { name: 'System prompt', tokens: 10000, color: '#111' },
        { name: 'MCP tools', tokens: 8000, color: '#222' },
        { name: 'Free space', tokens: 158000, color: '#ddd' },
      ],
      mcpTools: [
        { serverName: 'github', name: 'search_issues', tokens: 3000 },
        { serverName: 'browser', name: 'open', tokens: 1000, isLoaded: false },
      ],
      memoryFiles: [{ path: '/repo/MEMORY.md', type: 'project', tokens: 1200 }],
      agents: [{ agentType: 'reviewer', source: 'project', tokens: 900 }],
      skills: {
        includedSkills: 2,
        totalSkills: 5,
        tokens: 2400,
        skillFrontmatter: [{ name: 'review-pr', source: 'user', tokens: 600 }],
      },
      slashCommands: { includedCommands: 3, totalCommands: 9, tokens: 700 },
      messageBreakdown: {
        userMessageTokens: 500,
        assistantMessageTokens: 600,
        toolCallTokens: 700,
        toolResultTokens: 800,
        attachmentTokens: 0,
        toolCallsByType: [{ name: 'Read', callTokens: 100, resultTokens: 200 }],
        attachmentsByType: [],
      },
      apiUsage: {
        input_tokens: 1000,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
        output_tokens: 400,
      },
    })).toMatchObject({
      title: 'Context usage',
      detail: '42,000 / 200,000 tokens · 21%',
      rows: expect.arrayContaining([
        { label: 'model', value: 'claude-sonnet-4-6' },
        { label: 'System prompt', value: '10,000 tokens · 5.0%' },
        { label: 'MCP tools', value: expect.stringContaining('github/search_issues') },
        { label: 'Memory files', value: expect.stringContaining('MEMORY.md · project') },
        { label: 'Skills', value: expect.stringContaining('2 / 5') },
        { label: 'Slash commands', value: expect.stringContaining('3 / 9') },
        { label: 'Tool types', value: expect.stringContaining('Read') },
        { label: 'API output', value: '400 tokens' },
      ]),
    });
  });

  it('summarizes session spend from desktop session usage fields', () => {
    expect(summarizeSessionSpend(session({
      totalCostUsd: 0.0342,
      totalTokenUsage: 12450,
      contextTokens: 6000,
      contextWindow: 200000,
    }))).toEqual({
      title: 'Session spend',
      detail: '本会话 $0.03 · 12.5k tokens · 上下文 6k / 200k · 3%',
      available: true,
    });

    expect(summarizeSessionSpend(session())).toEqual({
      title: 'Session spend',
      detail: '暂无会话用量',
      available: false,
    });
  });
});
