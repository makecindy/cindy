import { beforeEach, expect, it, vi } from 'vitest';
import * as state from '../quotaCredentialState';
const status = { state: 'ok', source: 'server', endpoint: 'https://gateway.example.test', accountTier: null } as const;
beforeEach(() => state.noteQuotaCredentialStatus(null, { state: 'idle', source: null, endpoint: null, accountTier: null }));
it('invalidates source changes and logout but not repeated successful synchronization', async () => {
  const changed = vi.fn();
  const off = state.onQuotaCredentialSourceChanged(changed);
  state.noteQuotaCredentialStatus('owner', status);
  const generation = state.quotaCredentialGeneration();
  state.noteQuotaCredentialStatus('owner', status);
  expect(state.quotaCredentialGeneration()).toBe(generation);
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'syncing' });
  state.noteQuotaCredentialStatus('owner', status);
  expect(state.quotaCredentialGeneration()).toBe(generation);
  state.noteQuotaCredentialStatus('owner', { ...status, endpoint: 'https://new.example.test' });
  expect(state.quotaCredentialGeneration()).toBe(generation + 1);
  state.noteQuotaCredentialStatus(null, { ...status, state: 'idle' });
  expect(state.quotaCredentialGeneration()).toBe(generation + 2);
  expect(changed).toHaveBeenCalledTimes(3);
  off();
});

it.each([null, 'manual'] as const)('invalidates a removed/replaced source in non-ok state (%s)', async (source) => {
  const changed = vi.fn();
  state.noteQuotaCredentialStatus('owner', status);
  const off = state.onQuotaCredentialSourceChanged(changed);
  const generation = state.quotaCredentialGeneration();
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'failed' });
  expect(changed).not.toHaveBeenCalled();
  state.noteQuotaCredentialStatus('owner', { ...status, state: 'failed', source, endpoint: null });
  expect(state.quotaCredentialGeneration()).toBe(generation + 1);
  expect(changed).toHaveBeenCalledTimes(1);
  off();
});
