import { describe, expect, it, vi } from 'vitest';
import { runProviderReadRequest } from '../providerReadTools.js';

// Unit: provider-groups.md §7/§9 and agent-user-parity. UI tests do not cover
// this new caller adapter. One existing command proves unchanged data, explicit
// remote scope, no fallback, and owner invalidation before returning data.
describe('provider reads through existing management', () => {
  // Unit / #10794 privacy: subscription login names are embedded in generated
  // providerName values, including the persisted group snapshot. Existing tests
  // use empty members and cannot catch this leak. Minimal input is one account.
  it.each(['local', 'computer'])('hides generated account names for plugins on %s without changing Agent/UI data', async device => {
    const raw = { providerId: 'anthropic',
      members: [{ key: 'local', providerName: 'Claude · current@example.invalid', running: 2 },
        { key: 'team', providerName: 'Team models' }],
      config: { strategy: 'order', members: [{ key: 'local', providerName: 'OpenAI · saved-login' }] } };
    const ports = { local: vi.fn(async () => raw), remote: vi.fn(async () => raw) };
    const request = { action: 'group' as const, providerId: 'anthropic', device };
    const result = await runProviderReadRequest(request, ports, () => undefined, true);
    expect(result).toMatchObject({ providerId: 'anthropic',
      members: [{ key: 'local', providerName: 'Claude', running: 2 }, { key: 'team', providerName: 'Team models' }],
      config: { strategy: 'order', members: [{ key: 'local', providerName: 'OpenAI' }] } });
    expect(raw.members[0].providerName).toBe('Claude · current@example.invalid');
    expect(raw.config.members[0].providerName).toBe('OpenAI · saved-login');
    expect(await runProviderReadRequest(request, ports, () => undefined)).toBe(raw);
  });

  it.each(['usage-history', 'group'] as const)('delegates %s and returns the original view', async action => {
    const raw = { providerId: 'anthropic', coverageStart: '2026-11-15', members: [], unknown: null };
    const local = vi.fn(async () => raw);
    const remote = vi.fn(async () => raw);
    const guard = vi.fn();
    const request = { action, providerId: 'anthropic' };
    expect(await runProviderReadRequest(request, { local, remote }, guard)).toBe(raw);
    expect(local).toHaveBeenCalledExactlyOnceWith(action === 'usage-history'
      ? { action: 'manage-share', command: { action: 'usage-history', providerId: 'anthropic' } }
      : { action: 'manage-group', command: { action: 'get', providerId: 'anthropic' } }, guard);
    expect(remote).not.toHaveBeenCalled();
  });
  it('reports a remote failure without substituting local or empty data', async () => {
    const local = vi.fn();
    const remote = vi.fn(async () => { throw new Error('UNSUPPORTED_CAPABILITY'); });
    await expect(runProviderReadRequest({ action: 'usage-history', providerId: 'anthropic', device: 'computer' },
      { local, remote }, () => undefined)).rejects.toThrow('UNSUPPORTED_CAPABILITY');
    expect(local).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it('withholds a response after the owner or installation changes', async () => {
    let current = true;
    const local = vi.fn(async () => { current = false; return { members: [] }; });
    await expect(runProviderReadRequest({ action: 'group', providerId: 'anthropic' }, { local, remote: vi.fn() }, () => {
      if (!current) throw new Error('REVOKED');
    })).rejects.toThrow('REVOKED');
  });
});
