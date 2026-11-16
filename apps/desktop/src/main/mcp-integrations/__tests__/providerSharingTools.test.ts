import { describe, expect, it, vi } from 'vitest';
import { runProviderSharingRequest } from '../providerSharingTools.js';
import type { ProviderShareManagementCommand } from '../../../shared/providerManagement.js';

// Unit: provider-sharing.md §7/§9, owner-only member management. Existing UI
// tests do not exercise the shared Agent/plugin projection or remote routing.
// Minimal input is one owned member; no network, files or real accounts.
const owned = { ready: true, shares: [{ shareId: 'share', providerId: 'anthropic', members: [
  { memberId: 'member', displayName: 'Example', status: 'active', note: 'private', devices: ['private-device'] },
] }] };
const setup = () => {
  let current = true;
  const guard = () => { if (!current) throw new Error('REVOKED'); };
  const command = vi.fn(async (input: ProviderShareManagementCommand, assertCurrent: () => void) => {
    assertCurrent();
    if (input.action === 'owned') return owned;
    if (input.action === 'get-model-access' || input.action === 'set-model-access')
      return { models: ['a'], providerModels: null, availableModels: [{ id: 'a', name: 'A' }], memberBudget: { private: true } };
    return { ok: true };
  });
  const remote = vi.fn(async (_device: string, input: ProviderShareManagementCommand, assertCurrent: () => void) => command(input, assertCurrent));
  return { command, remote, guard, revoke: () => { current = false; } };
};

describe('provider share shared tools', () => {
  it('returns only member identity/status and the selected computer scope', async () => {
    const s = setup();
    expect(await runProviderSharingRequest({ action: 'members' }, s, s.guard)).toEqual({
      scope: 'local', deviceId: 'local', members: [{ shareId: 'share', providerId: 'anthropic', memberId: 'member', name: 'Example', status: 'active' }],
    });
  });
  it('refuses a member outside the requested provider before mutation', async () => {
    const s = setup();
    await expect(runProviderSharingRequest({ action: 'status', providerId: 'openai', memberId: 'member', status: 'pause' }, s, s.guard))
      .rejects.toThrow('NOT_FOUND');
    expect(s.command).toHaveBeenCalledTimes(1);
  });
  it('uses the existing pause command and explains asynchronous shutdown', async () => {
    const s = setup();
    expect(await runProviderSharingRequest({ action: 'status', providerId: 'anthropic', memberId: 'member', status: 'pause' }, s, s.guard))
      .toMatchObject({ status: 'paused', shutdown: 'requested' });
    expect(s.command).toHaveBeenLastCalledWith({ action: 'set-member', memberId: 'member', status: 'pause' }, s.guard);
  });
  it('projects model access without editing member budgets', async () => {
    const s = setup();
    expect(await runProviderSharingRequest({ action: 'set-models', providerId: 'anthropic', memberId: 'member', models: ['a'] }, s, s.guard))
      .toEqual({ scope: 'local', deviceId: 'local', models: ['a'], providerModels: null, availableModels: [{ id: 'a', name: 'A' }] });
    expect(s.command).toHaveBeenLastCalledWith({ action: 'set-model-access', providerId: 'anthropic', memberId: 'member', models: ['a'] }, s.guard);
  });
  it('uses only the explicitly selected remote computer and never falls back', async () => {
    const s = setup();
    expect(await runProviderSharingRequest({ action: 'members', device: 'computer' }, s, s.guard)).toMatchObject({ scope: 'remote', deviceId: 'computer' });
    s.command.mockClear();
    s.remote.mockRejectedValueOnce(new Error('UNSUPPORTED_CAPABILITY'));
    await expect(runProviderSharingRequest({ action: 'members', device: 'old-computer' }, s, s.guard)).rejects.toThrow('UNSUPPORTED_CAPABILITY');
    expect(s.command).not.toHaveBeenCalled();
  });
  it('rejects a late owner/installation change before a write or data return', async () => {
    const s = setup();
    s.command.mockImplementationOnce(async () => { s.revoke(); return owned; });
    await expect(runProviderSharingRequest({ action: 'status', providerId: 'anthropic', memberId: 'member', status: 'pause' }, s, s.guard)).rejects.toThrow('REVOKED');
    expect(s.command).toHaveBeenCalledTimes(1);
  });
});
