/**
 * Test value (engineering-conventions §3.2)
 * Basis: P1-1 renderer store synchronization for main-process async worktree provisioning.
 * Coverage gap: existing renderer tests only covered NewMakerDraftRoute source ordering and
 * did not exercise syncHostProvisioning / replaceHostProvisioningList merging with renderer-owned drafts.
 * Minimal failing input: a renderer-owned creating entry alongside host-managed provisioning/failed snapshots.
 * Tier: unit (pure in-memory store, no DOM or IPC).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { worktreeCreationStore } from '../worktreeCreationStore';

afterEach(() => {
  worktreeCreationStore.reset();
});

describe('worktreeCreationStore host provisioning sync', () => {
  it('syncs provisioning and failed snapshots while preserving renderer-owned draft entries', () => {
    const listener = vi.fn();
    const unsub = worktreeCreationStore.subscribe(listener);
    try {
      // Renderer-owned draft entry (no hostManaged/canRetry flags).
      worktreeCreationStore.set('draft-1', {
        status: 'creating',
        name: 'local-draft',
        startedAt: 1000,
      });

      worktreeCreationStore.syncHostProvisioning('task-1', {
        sessionId: 'task-1',
        status: 'provisioning',
        stage: 'queued',
        startedAt: 2000,
        name: 'calm-oak',
      });
      expect(worktreeCreationStore.get('task-1')).toEqual({
        status: 'creating',
        name: 'calm-oak',
        startedAt: 2000,
        stage: 'queued',
        hostManaged: true,
      });

      // Clearing a non-host entry via syncHostProvisioning(null) must not wipe renderer drafts.
      worktreeCreationStore.syncHostProvisioning('draft-1', null);
      expect(worktreeCreationStore.get('draft-1')).toMatchObject({
        status: 'creating',
        name: 'local-draft',
      });

      // Transition host entry to failed (retryable, interrupted on restart).
      worktreeCreationStore.syncHostProvisioning('task-1', {
        sessionId: 'task-1',
        status: 'failed',
        startedAt: 2000,
        name: 'calm-oak',
        error: 'App restarted during worktree creation',
        interruptedOnRestart: true,
      });
      expect(worktreeCreationStore.get('task-1')).toEqual({
        status: 'failed',
        name: 'calm-oak',
        error: 'App restarted during worktree creation',
        canRetry: true,
        interruptedOnRestart: true,
      });

      // replaceHostProvisioningList drops stale host entries, adds new ones, and keeps renderer drafts.
      worktreeCreationStore.replaceHostProvisioningList([
        {
          sessionId: 'task-2',
          status: 'provisioning',
          stage: 'creating',
          startedAt: 4000,
        },
      ]);
      expect(worktreeCreationStore.get('task-1')).toBeUndefined();
      expect(worktreeCreationStore.get('task-2')).toEqual({
        status: 'creating',
        name: '',
        startedAt: 4000,
        stage: 'creating',
        hostManaged: true,
      });
      expect(worktreeCreationStore.get('draft-1')).toMatchObject({
        status: 'creating',
        name: 'local-draft',
      });

      // Clearing host entry removes it cleanly.
      worktreeCreationStore.syncHostProvisioning('task-2', null);
      expect(worktreeCreationStore.get('task-2')).toBeUndefined();
      expect(listener).toHaveBeenCalled();
    } finally {
      unsub();
    }
  });
});
