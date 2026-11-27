import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { GhostChangeChecksSlot, type ChangeCheckPush } from '../changeChecksSlot.js';

// Production request/result entrypoints: autonomous probes must never leak content or turn
// unavailable/revoked sources into an idle result (plugin security §3–5). Existing hook tests
// do not cross provider identities. Unit tier: in-memory plugins and fake deadlines, no accounts.
function fixture(conversationChanges?: (from: number, to: number) => Promise<boolean>) {
  let owner = 'owner-a';
  const ghosts = ['caller', 'mailbox', 'other'].map(
    (id) =>
      ({
        manifest: {
          id,
          name: id,
          agent: { checks: true, ...(id === 'mailbox' ? { checkSources: ['mail'] } : {}) },
        },
        enabled: true,
        checksCapabilityApproved: true,
        approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' },
      }) as unknown as InstalledGhost,
  );
  const sent: { id: string; message: ChangeCheckPush }[] = [];
  const slot = new GhostChangeChecksSlot({
    owner: () => owner,
    list: () => ghosts,
    conversationChanges,
    wake: async () => {},
    send: (id, message) => {
      sent.push({ id, message });
      return true;
    },
  });
  const check = {
    providerId: 'mailbox',
    source: 'mail',
    from: '2026-11-08T00:00:00Z',
    to: '2026-11-09T00:00:00Z',
  };
  return {
    ghosts,
    sent,
    slot,
    check,
    switchOwner: () => {
      owner = 'owner-b';
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('content-free change checks', () => {
  it.each(['empty', 'revoked', 'timeout'] as const)(
    'bounds existing-tool checks and revalidates their caller: %s',
    async mode => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-09T01:00:00Z'));
      const f = fixture();
      const source = {
        enabled: true,
        namespace: null,
        approval: { state: 'approved', revision: '11111111-1111-4111-8111-111111111111' },
        manifest: { id: 'google-gmail', name: 'Gmail', tools: [{ name: 'gmail_accounts' }, { name: 'gmail_run' }] },
      } as InstalledGhost;
      f.ghosts.push(source);
      let release: (() => void) | undefined;
      const read = vi.fn(async (_id: string, tool: string) => {
        if (mode === 'timeout') await new Promise<void>(resolve => { release = resolve; });
        if (mode === 'revoked') f.ghosts[0].checksCapabilityApproved = undefined;
        return { ok: true, result: tool === 'gmail_accounts'
          ? { accounts: [{ id: 'fixture', status: 'connected' }] }
          : { messages: [], nextPageToken: '' } };
      });
      const slot = new GhostChangeChecksSlot({ owner: () => 'owner-a', list: () => f.ghosts,
        wake: async () => {}, send: () => false, readTool: read });
      const pending = slot.request('caller', { action: 'probe', checks: [{ ...f.check, providerId: 'google-gmail' }] });
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toMatchObject(mode === 'revoked'
        ? { ok: false, errorCode: 'PERMISSION_DENIED' }
        : { ok: true, results: [{ state: mode === 'empty' ? 'unchanged' : 'unknown' }] });
      release?.();
      await vi.runAllTimersAsync();
      expect(read).toHaveBeenCalledTimes(mode === 'empty' ? 3 : 1);
      slot.dispose();
    },
  );
  it.each(['empty', 'changed', 'owner', 'error'] as const)(
    'checks local history without exposing rows: %s',
    async (mode) => {
      const f = fixture(async () => {
        if (mode === 'owner') f.switchOwner();
        if (mode === 'error') throw new Error('database unavailable');
        return mode === 'changed';
      });
      const response = await f.slot.request('caller', {
        action: 'probe',
        checks: [{ ...f.check, providerId: '@cindy/local-history', source: 'cindy' }],
      });
      expect(response).toMatchObject(
        mode === 'owner'
          ? { ok: false, errorCode: 'PERMISSION_DENIED' }
          : {
              ok: true,
              results: [
                {
                  state:
                    mode === 'empty' ? 'unchanged' : mode === 'changed' ? 'changed' : 'unknown',
                },
              ],
            },
      );
      expect(f.sent).toHaveLength(0);
    },
  );
  it('requires independent approval and returns only declared, approved providers', async () => {
    const f = fixture();
    f.ghosts[0].checksCapabilityApproved = undefined;
    expect(await f.slot.request('caller', { action: 'list' })).toEqual({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    f.ghosts[0].checksCapabilityApproved = true;
    expect(await f.slot.request('caller', { action: 'list' })).toEqual({
      ok: true,
      providers: [{ providerId: 'mailbox', name: 'mailbox', sources: ['mail'] }],
    });
    f.ghosts[1].enabled = false;
    expect(await f.slot.request('caller', { action: 'probe', checks: [f.check] })).toMatchObject({
      ok: true,
      results: [{ state: 'unknown' }],
    });
    expect(f.sent).toHaveLength(0);
  });

  it('deduplicates checks, rejects forged responses and strips all provider content', async () => {
    const f = fixture();
    const result = f.slot.request('caller', { action: 'probe', checks: [f.check, f.check] });
    await Promise.resolve();
    expect(f.sent).toHaveLength(1);
    expect(await f.slot.request('caller', { action: 'probe', checks: [f.check] })).toEqual({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    const requestId = f.sent[0].message.requestId;
    f.slot.result('other', { requestId, state: 'unchanged' });
    f.slot.result('mailbox', {
      requestId,
      state: 'changed',
      body: 'private message',
      token: 'not-a-real-token',
    });
    const response = await result;
    expect(response).toMatchObject({
      ok: true,
      results: [{ state: 'changed' }, { state: 'changed' }],
    });
    expect(JSON.stringify(response)).not.toMatch(/private message|not-a-real-token/);
  });

  it.each(['timeout', 'revoked', 'updated', 'owner'] as const)(
    'does not certify idle after %s',
    async (reason) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-09T01:00:00Z'));
      const f = fixture();
      const result = f.slot.request('caller', { action: 'probe', checks: [f.check] });
      await Promise.resolve();
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(20_000);
      else {
        if (reason === 'revoked') f.ghosts[1].checksCapabilityApproved = undefined;
        if (reason === 'updated')
          f.ghosts[1].approval = {
            state: 'approved',
            revision: '22222222-2222-4222-8222-222222222222',
          } as InstalledGhost['approval'];
        if (reason === 'owner') f.switchOwner();
        f.slot.result('mailbox', { requestId: f.sent[0].message.requestId, state: 'unchanged' });
      }
      expect(await result).toMatchObject(
        reason === 'owner'
          ? { ok: false, errorCode: 'PERMISSION_DENIED' }
          : { ok: true, results: [{ state: 'unknown' }] },
      );
    },
  );

  it('rejects malformed ranges before waking plugins', async () => {
    const f = fixture();
    expect(
      await f.slot.request('caller', {
        action: 'probe',
        checks: [{ ...f.check, from: 'not-a-date' }],
      }),
    ).toEqual({ ok: false, errorCode: 'INVALID_REQUEST' });
    expect(f.sent).toHaveLength(0);
  });
});
