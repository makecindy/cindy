import { describe, expect, it } from 'vitest';

import {
  projectRecentWorkActivities,
  projectWorkActivities,
} from '@/lib/agent-actions/workActivityProjection';
import type { ChatMessage } from '@/lib/makerChatStore';

function tool(id: string, toolName: string, toolInput: Record<string, unknown>): ChatMessage {
  return {
    clientId: id,
    role: 'tool_use',
    content: '',
    toolUseId: `tu-${id}`,
    toolName,
    toolInput,
  };
}

function segment(key: string, toolCalls: ChatMessage[]) {
  return {
    kind: 'tools',
    key,
    toolCalls,
    resultMap: new Map<string, string>(),
    settledIds: new Set<string>(),
  };
}

describe('projectWorkActivities', () => {
  it('splits a complete Codex commandActions list into ordered display rows', () => {
    const command = tool('exec-1', 'exec', {
      command: 'cat src/a.ts && rg TODO src',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
        { type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' },
      ],
    });

    const projection = projectWorkActivities([segment('seg-1', [command])], true);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'exec-1:action:0',
      'exec-1:action:1',
    ]);
    expect(
      projection.activities.map((activity) =>
        activity.kind === 'tool' ? activity.intentOverride?.action : null),
    ).toEqual(['read', 'search']);
    expect(projection.explorationCounts).toEqual({ read: 1, search: 1, list: 0 });
    expect(projection.isPureExploration).toBe(true);
  });

  it('keeps only the latest repeated read using normalized full paths', () => {
    const first = tool('read-1', 'exec', {
      command: 'cat src/a.ts',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
      ],
    });
    const second = tool('read-2', 'exec', {
      command: 'cat ./src/a.ts',
      cwd: '/repo/',
      commandActions: [
        { type: 'read', command: 'cat ./src/a.ts', name: 'a.ts', path: './src/a.ts' },
      ],
    });

    const projection = projectWorkActivities([
      segment('seg-1', [first]),
      { kind: 'thinking', key: 'thinking-1', message: {
        clientId: 'thinking-1',
        role: 'thinking',
        content: 'checking again',
      } satisfies ChatMessage },
      segment('seg-2', [second]),
    ], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'thinking-1',
      'read-2',
    ]);
    expect(projection.toolActivitiesByChildKey.get('seg-1')).toEqual([]);
    expect(projection.explorationCounts.read).toBe(1);
  });

  it('preserves Windows roots and UNC shares while normalizing repeated reads', () => {
    const projection = projectWorkActivities([
      segment('seg-1', [
        tool('drive-1', 'exec', {
          command: 'cat src\\a.ts',
          cwd: 'C:\\Repo\\',
          commandActions: [
            { type: 'read', command: 'cat src\\a.ts', name: 'a.ts', path: 'src\\a.ts' },
          ],
        }),
        tool('drive-2', 'exec', {
          command: 'cat C:\\repo\\src\\a.ts',
          cwd: 'C:\\',
          commandActions: [
            {
              type: 'read',
              command: 'cat C:\\repo\\src\\a.ts',
              name: 'a.ts',
              path: 'C:\\repo\\src\\a.ts',
            },
          ],
        }),
        tool('unc', 'Read', { file_path: '\\\\server\\share\\a.ts' }),
        tool('posix', 'Read', { file_path: '/server/share/a.ts' }),
      ]),
    ], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'drive-2',
      'unc',
      'posix',
    ]);
    expect(projection.explorationCounts.read).toBe(3);
  });

  it('starts a new repeated-read window after a non-exploration action', () => {
    const projection = projectWorkActivities([
      segment('seg-1', [
        tool('read-before', 'Read', { file_path: '/repo/a.ts' }),
        tool('edit', 'Edit', {
          file_path: '/repo/a.ts',
          old_string: 'before',
          new_string: 'after',
        }),
        tool('read-after', 'Read', { file_path: '/repo/a.ts' }),
      ]),
    ], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual([
      'read-before',
      'edit',
      'read-after',
    ]);
    expect(projection.isPureExploration).toBe(false);
  });

  it('does not split or summarize mixed known and unknown commandActions', () => {
    const command = tool('exec-mixed', 'exec', {
      command: 'cat src/a.ts && custom-inspector src',
      cwd: '/repo',
      commandActions: [
        { type: 'read', command: 'cat src/a.ts', name: 'a.ts', path: 'src/a.ts' },
        { type: 'unknown', command: 'custom-inspector src' },
      ],
    });

    const projection = projectWorkActivities([segment('seg-1', [command])], false);

    expect(projection.activities.map((activity) => activity.key)).toEqual(['exec-mixed']);
    expect(projection.activities[0]).toMatchObject({ kind: 'tool', exploration: undefined });
    expect(projection.isPureExploration).toBe(false);
  });

  it('does not label a mixed work group as pure exploration', () => {
    const projection = projectWorkActivities([
      segment('seg-1', [
        tool('read-1', 'Read', { file_path: '/repo/a.ts' }),
        tool('cmd-1', 'exec', { command: 'docker ps' }),
      ]),
    ], false);

    expect(projection.explorationCounts.read).toBe(1);
    expect(projection.isPureExploration).toBe(false);
  });

  it('ignores malformed thinking content in recent and expanded projections', () => {
    const child = {
      kind: 'thinking' as const,
      key: 'thinking-malformed',
      message: {
        clientId: 'thinking-malformed',
        role: 'thinking',
        content: undefined,
      } as unknown as ChatMessage,
    };

    expect(projectRecentWorkActivities([child], true, 5)).toEqual([]);
    expect(projectWorkActivities([child], true).activities).toEqual([]);
  });
});
