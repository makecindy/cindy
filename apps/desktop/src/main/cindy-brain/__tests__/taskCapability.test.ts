import { describe, expect, it, vi } from 'vitest';
import { ensurePluginTaskApproval, hasPluginTaskApproval, PluginTaskApprovalGate } from '../taskCapability.js';
import { handlePluginTaskRequest } from '../taskSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

const legacy = () =>
  ({
    dir: '/unused-test-plugin',
    enabled: true,
    approval: { state: 'approved', revision: 'old' },
    manifest: {
      schemaVersion: 2,
      kind: 'chip',
      entry: 'main.js',
      id: 'p',
      name: 'Plugin',
      version: '1.0.0',
      agent: { tasks: true },
      slots: ['agent'],
    },
  }) as InstalledGhost;

describe('explicit task capability approval', () => {
  it.each(['denied', 'timeout', 'error'] as const)('suppresses serial automatic prompts after %s until Host retry', async outcome => {
    const gate = new PluginTaskApprovalGate();
    const attempt = vi.fn(async () => { if (outcome === 'error') throw new Error('no UI'); return false; });
    await gate.request('p', 'owner:revision', false, attempt).catch(() => false);
    for (let i = 0; i < 20; i++) expect(await gate.request('p', 'owner:revision', false, attempt)).toBe(false);
    expect(attempt).toHaveBeenCalledOnce();
    const retry = vi.fn(async () => true);
    expect(await gate.request('p', 'owner:revision', true, retry)).toBe(true);
    expect(retry).toHaveBeenCalledOnce();
  });
  it('does not bypass pending confirmation, and isolates owner/revision and plugin identities', async () => {
    const gate = new PluginTaskApprovalGate();
    let finish!: (value: boolean) => void;
    const first = gate.request('p', 'owner:r1', false, () => new Promise(resolve => { finish = resolve; }));
    const other = vi.fn(async () => false);
    expect(await gate.request('p', 'owner:r1', true, other)).toBe(false);
    expect(other).not.toHaveBeenCalled();
    finish(false); await first;
    await gate.request('q', 'owner:r1', false, other);
    await gate.request('p', 'owner:r2', false, other);
    await gate.request('p', 'new-owner:r2', false, other);
    expect(other).toHaveBeenCalledTimes(3);
  });
  it('does not treat a preserved unknown declaration as consent', async () => {
    const ghost = legacy();
    const handler = vi.fn();
    expect(hasPluginTaskApproval(ghost)).toBe(false);
    expect(
      await handlePluginTaskRequest(
        'p',
        { type: 'tasks-request', kind: 'list' },
        {
          getGhost: () => ghost,
          isCurrent: () => true,
          handler,
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(handler).not.toHaveBeenCalled();
    expect(ghost.enabled).toBe(true);
  });
  it.each(['deny', 'account-change', 'approve'] as const)(
    'handles %s without granting on stale or rejected consent',
    async (scenario) => {
      let active = true;
      const ghost = legacy();
      const approve = vi.fn(async (_id, revision, isCurrent) => {
        expect(revision).toBe('old');
        if (!isCurrent()) return false;
        ghost.taskCapabilityApproved = true;
        return true;
      });
      const confirm = vi.fn(async (facts) => {
        expect(facts.added.map((item: { key: string }) => item.key)).toEqual(['agent:tasks']);
        if (scenario === 'account-change') active = false;
        return scenario !== 'deny';
      });
      const deps = { getGhost: () => ghost, isCurrent: () => active, confirm, approve };
      expect(await ensurePluginTaskApproval('p', deps)).toBe(scenario === 'approve');
      expect(approve).toHaveBeenCalledTimes(scenario === 'approve' ? 1 : 0);
      if (scenario === 'approve') {
        await ensurePluginTaskApproval('p', deps);
        expect(confirm).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('does not execute on unavailable UI or a failed receipt write', async () => {
    const handler = vi.fn();
    const ghost = legacy();
    for (const confirm of [
      async () => {
        throw new Error('no UI');
      },
      async () => true,
    ]) {
      const result = await handlePluginTaskRequest(
        'p',
        { type: 'tasks-request', kind: 'list' },
        {
          getGhost: () => ghost,
          isCurrent: () => true,
          handler,
          ensureAuthorized: () =>
            ensurePluginTaskApproval('p', {
              getGhost: () => ghost,
              isCurrent: () => true,
              confirm,
              approve: async () => {
                throw new Error('disk failure');
              },
            }),
        },
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
