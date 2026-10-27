import { describe, expect, it } from 'vitest';
import type { RemoteSession } from '@/session/types';
import { i18n } from '@/i18n';
import {
  buildSessionActionMenu,
  statusToggleAction,
  swipeActionPatch,
} from '@/session/swipeRowRegistry';

describe('statusToggleAction', () => {
  it('archives active tasks and restores archived ones', () => {
    expect(statusToggleAction('active')).toEqual({
      action: 'archive',
      label: i18n.t('session.menu.archive'),
    });
    expect(statusToggleAction('archived')).toEqual({
      action: 'restore',
      label: i18n.t('session.menu.restore'),
    });
  });
});

describe('buildSessionActionMenu', () => {
  it('switches the status item with the session status', () => {
    expect(buildSessionActionMenu(null, 'active').map((item) => item.action))
      .toEqual(['rename', 'pin', 'archive', 'delete']);
    expect(buildSessionActionMenu('2026-01-01T00:00:00.000Z', 'archived').map((item) => item.action))
      .toEqual(['rename', 'unpin', 'restore', 'delete']);
  });
});

describe('swipeActionPatch', () => {
  it('restores archived tasks back to active without touching pin state', () => {
    expect(swipeActionPatch('restore')).toEqual({ status: 'active' });
  });
});

// #7402, unit: actual options model shared by iOS/Android; old-host and dialogue gates were absent.
it.each([undefined, null, '2026-10-27T00:00:00Z'])('gates project-pin options for host metadata %s', projectPinnedAt => {
  const row = { workspaceKind: 'project', workingDir: '/repo', projectPinnedAt } as RemoteSession;
  const menu = buildSessionActionMenu(null, 'active', row);
  expect(menu.some(item => item.action === 'pin-project')).toBe(projectPinnedAt === null);
  expect(menu.some(item => item.action === 'unpin-project')).toBe(typeof projectPinnedAt === 'string');
  expect(buildSessionActionMenu(null, 'active', { ...row, workspaceKind: 'dialogue' })
    .some(item => item.action.includes('project'))).toBe(false);
});
