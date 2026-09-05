import { describe, expect, it } from 'vitest';

import { buildMobileMessageRenderItems, type MobileMessageRenderItem } from '@/session/messageRenderModel';
import { summarizeToolRowPresentation } from '@/session/messagePresentation';
import {
  projectMobileWorkActivities,
  projectRecentMobileWorkActivities,
  sameMobileWorkToolActivity,
  type MobileProjectedToolActivity,
} from '@/session/workActivityProjection';
import type { RemoteMessage } from '@/session/types';

function message(
  patch: Partial<RemoteMessage> & Pick<RemoteMessage, 'id' | 'role' | 'content'>,
): RemoteMessage {
  return {
    clientId: patch.id,
    sessionId: 's1',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function toolUse(id: string, toolName: string, input: unknown, seconds: number): RemoteMessage {
  return message({
    id,
    role: 'tool_use',
    toolUseId: id,
    content: { toolUseId: id, toolName, input },
    createdAt: `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`,
  });
}

function activeWorkGroup(messages: RemoteMessage[]) {
  const items = buildMobileMessageRenderItems(messages, { isSessionStreaming: true });
  const group = items.find(
    (item): item is Extract<MobileMessageRenderItem, { type: 'work_group' }> =>
      item.type === 'work_group' && item.isStreaming === true,
  );
  expect(group).toBeDefined();
  return group!;
}

describe('mobile work activity projection', () => {
  it('keeps unchanged rows equivalent across large work-group projections and refreshes real changes', () => {
    const commandActions = Array.from({ length: 200 }, (_, index) => ({
      type: 'read', command: `cat src/file-${index}.ts`,
      name: `file-${index}.ts`, path: `src/file-${index}.ts`,
    }));
    const group = activeWorkGroup([
      message({ id: 'user', role: 'user', content: 'inspect' }),
      toolUse('exec', 'exec', {
        command: commandActions.map((action) => action.command).join(' && '),
        commandActions, cwd: '/repo',
      }, 2),
    ]);
    const tools = () => projectMobileWorkActivities(group.children, true).activities
      .filter((activity): activity is MobileProjectedToolActivity => activity.kind === 'tool');
    const before = tools();
    const after = tools();
    expect(before).toHaveLength(200);
    expect(after.every((row, index) => row !== before[index])).toBe(true);
    expect(after.every((row, index) => sameMobileWorkToolActivity(before[index], row))).toBe(true);

    const row = before[0];
    for (const changed of [
      { ...row, key: 'another-key' },
      { ...row, status: row.status === 'done' ? 'running' as const : 'done' as const },
      { ...row, toolResult: 'new result' },
      { ...row, message: { ...row.message, normalized: { ...row.message.normalized, secondaryBody: 'changed' } } },
      { ...row, intentOverride: { ...row.intentOverride!, target: 'new target' } },
      { ...row, intentOverride: { ...row.intentOverride!, path: '/new/path' } },
      { ...row, intentOverride: { ...row.intentOverride!, action: 'search' as const } },
      { ...row, intentOverride: undefined },
    ]) {
      expect(sameMobileWorkToolActivity(row, changed)).toBe(false);
    }
  });

  it('expands structured Codex commands and keeps only the latest five live actions', () => {
    const commandActions = Array.from({ length: 6 }, (_, index) => ({
      type: 'read',
      command: `cat src/file-${index}.ts`,
      name: `file-${index}.ts`,
      path: `src/file-${index}.ts`,
    }));
    const group = activeWorkGroup([
      message({ id: 'user', role: 'user', content: 'inspect', createdAt: '2026-01-01T00:00:01.000Z' }),
      toolUse('exec-1', 'exec', {
        command: commandActions.map((action) => action.command).join(' && '),
        commandActions,
        cwd: '/repo',
      }, 2),
    ]);

    const full = projectMobileWorkActivities(group.children, true);
    expect(full.activities.map((activity) => activity.key)).toEqual(
      commandActions.map((_, index) => `exec-1:action:${index}`),
    );
    expect(full.explorationCounts).toEqual({ read: 6, search: 0, list: 0 });
    expect(full.isPureExploration).toBe(true);
    const firstActivity = full.activities[0];
    expect(firstActivity?.kind).toBe('tool');
    if (firstActivity?.kind === 'tool') {
      const row = summarizeToolRowPresentation(firstActivity.message.normalized, {
        intentOverride: firstActivity.intentOverride,
        statusOverride: firstActivity.status,
      });
      expect(row.label).toContain('读取');
      expect(row.label).toContain('file-0.ts');
    }

    const recent = projectRecentMobileWorkActivities(group.children, true, 5);
    expect(recent.map((activity) => activity.key)).toEqual([
      'exec-1:action:1',
      'exec-1:action:2',
      'exec-1:action:3',
      'exec-1:action:4',
      'exec-1:action:5',
    ]);
  });

  it('de-duplicates repeated reads without dropping intervening reasoning', () => {
    const group = activeWorkGroup([
      message({ id: 'user', role: 'user', content: 'inspect', createdAt: '2026-01-01T00:00:01.000Z' }),
      toolUse('read-1', 'Read', { file_path: '/repo/src/a.ts' }, 2),
      message({
        id: 'thinking-1',
        role: 'thinking',
        content: { kind: 'thinking', text: '**Checking again**', isRedacted: false },
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
      toolUse('read-2', 'Read', { file_path: '/repo/src/a.ts' }, 4),
    ]);

    const projection = projectMobileWorkActivities(group.children, true);
    expect(projection.activities.map((activity) => activity.key)).toEqual(['thinking-1', 'read-2']);
    expect(projection.activities[0]).toMatchObject({
      kind: 'thinking',
      content: '**Checking again**',
    });
  });
});
