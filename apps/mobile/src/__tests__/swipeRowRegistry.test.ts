import { describe, expect, it } from 'vitest';
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
