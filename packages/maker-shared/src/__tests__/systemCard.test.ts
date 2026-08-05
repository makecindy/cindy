import { describe, expect, it } from 'vitest';
import {
  buildSystemCardData,
  formatSystemCard,
  mergeLocalSlashCommands,
  parseLocalSystemCommand,
} from '../systemCard.js';

describe('shared system card presentation model', () => {
  it('detects only local system slash commands', () => {
    expect(parseLocalSystemCommand('/help')).toBe('help');
    expect(parseLocalSystemCommand('/context ')).toBe('context');
    expect(parseLocalSystemCommand('/compact')).toBeNull();
    expect(parseLocalSystemCommand('/help now')).toBeNull();
  });

  it('keeps local commands before remote slash commands', () => {
    expect(mergeLocalSlashCommands([
      { kind: 'agent-builtin', name: 'help', description: 'remote help' },
      { kind: 'agent-builtin', name: 'doctor', description: 'remote doctor' },
    ]).map((command) => [command.name, command.description])).toEqual([
      ['help', '显示手机端和远程 agent 命令'],
      ['context', '查看当前会话上下文用量'],
      ['cost', '查看当前会话消耗'],
      ['pwd', '显示当前远程工作目录'],
      ['status', '显示当前会话状态'],
      ['doctor', 'remote doctor'],
    ]);
  });

  it('formats status and context cards from shared data', () => {
    const status = formatSystemCard('status', buildSystemCardData('status', {
      projection: { pendingQueue: [{ clientId: 'q1' }], queuePaused: true },
      session: {
        agentKind: 'cc',
        fastMode: true,
        model: 'claude-sonnet-4-6',
        permissionMode: 'ask',
        status: 'active',
        title: 'Session',
        workingDir: '/repo',
      },
    }));

    expect(status).toMatchObject({
      title: 'Session Status',
      rows: expect.arrayContaining([
        { label: 'agent', value: 'Claude Code' },
        { label: 'fast mode', value: 'on' },
        { label: 'queue', value: '1 条 · 已暂停' },
      ]),
    });

    const context = formatSystemCard('context', buildSystemCardData('context', {
      contextUsage: {
        totalTokens: 12000,
        rawMaxTokens: 200000,
        percentage: 6,
        model: 'claude-sonnet-4-6',
        categories: [{ name: 'Messages', tokens: 6000 }],
      },
      session: null,
    }));
    expect(context.body).toBe('12,000 / 200,000 tokens · 6%');
    expect(context.rows).toEqual([
      { label: 'model', value: 'claude-sonnet-4-6' },
      { label: 'Messages', value: '6,000 tokens · 3.0%' },
    ]);
  });

  it('formats desktop compact and command result cards', () => {
    expect(formatSystemCard('compact', {
      detail: 'Compacted 20 messages',
    })).toEqual({
      title: 'Compact',
      rows: [],
      body: 'Compacted 20 messages',
    });

    expect(formatSystemCard('cmd', {
      command: '/context',
      output: 'Context ok',
    })).toEqual({
      title: 'Command Result',
      rows: [{ label: 'command', value: '/context' }],
      body: 'Context ok',
    });
  });
});
