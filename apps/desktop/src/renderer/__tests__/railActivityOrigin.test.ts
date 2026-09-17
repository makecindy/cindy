import { afterEach, expect, it } from 'vitest';

import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { aggregateRailActivity } from '@/features/cc-agent/sidebar/railActivity';
import { railPanelStore, type RailLampSession } from '@/features/cc-agent/sidebar/railPanelStore';

afterEach(() => {
  clearRemoteSessionActivity();
  railPanelStore.setLampScope(null);
});

const aggregate = (rows: readonly RailLampSession[]) =>
  aggregateRailActivity(rows, new Set(), new Set(), new Map(), new Set());

it('keeps both same-ID device rows through panel publication and aggregation', () => {
  const a = { id: 'same', deviceLinkDeviceId: 'a' };
  const b = { id: 'same', deviceLinkDeviceId: 'b' };
  applyRemoteSessionActivity('a', { sessionId: 'same', phase: 'running' });
  railPanelStore.setLampScope({ projectSessions: [a, b], dialogueSessions: [b] });
  const scope = railPanelStore.getSnapshot().lampScope!;
  expect(aggregate(scope.projectSessions).running).toBe(true);
  expect(aggregate(scope.dialogueSessions).running).toBe(false);
  expect(aggregate([b, a]).running).toBe(true);
  applyRemoteSessionActivity('b', { sessionId: 'same', phase: 'completed', attention: false });
  expect(aggregate(scope.projectSessions).running).toBe(true);
  applyRemoteSessionActivity('a', { sessionId: 'same', phase: 'completed', attention: false });
  expect(aggregate(scope.projectSessions).running).toBe(false);
});

it('publishes a source-only scope change but keeps equal snapshots stable', () => {
  const scope = {
    projectSessions: [{ id: 'same', deviceLinkDeviceId: 'a' }],
    dialogueSessions: [],
  };
  railPanelStore.setLampScope(scope);
  const first = railPanelStore.getSnapshot();
  railPanelStore.setLampScope({ ...scope, projectSessions: [{ ...scope.projectSessions[0] }] });
  expect(railPanelStore.getSnapshot()).toBe(first);
  railPanelStore.setLampScope({
    ...scope,
    projectSessions: [{ id: 'same', deviceLinkDeviceId: 'b' }],
  });
  expect(railPanelStore.getSnapshot()).not.toBe(first);
  applyRemoteSessionActivity('a', { sessionId: 'same', phase: 'running' });
  expect(aggregate(railPanelStore.getSnapshot().lampScope!.projectSessions).running).toBe(false);
  expect(aggregate([{ id: 'same' }]).running).toBe(false);
});
