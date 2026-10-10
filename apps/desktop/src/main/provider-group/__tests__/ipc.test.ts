/**
 * 供应商组设置的 IPC 业务体：入参校验，以及「新加入的电脑必须是这台电脑已经能用的同一个供应商」。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../runtime.js', () => ({ getProviderGroupDirectory: vi.fn(), getProviderGroupRouter: vi.fn() }));
vi.mock('../store.js', () => ({ readProviderGroup: vi.fn(), writeProviderGroup: vi.fn() }));
vi.mock('../bindings.js', () => ({ pruneProviderGroupBindings: vi.fn() }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner-a' }));
vi.mock('../../device-link/index.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import type { ProviderGroupCandidate, ProviderGroupConfig } from '../../../shared/providerGroup';
import { executeProviderGroupCommand, parseProviderGroupCommand, type ProviderGroupCommandDeps } from '../ipc';

const LOCAL = { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
const MINI = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device' as const,
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'stale label',
  limit: 4,
  weight: 1,
  paused: false,
};

function deps(candidates: ProviderGroupCandidate[], existing: ProviderGroupConfig | null = null) {
  let stored = existing;
  let owner = 'owner-a';
  return {
    switchOwner: (next: string) => { owner = next; },
    ownerKey: vi.fn(() => owner),
    pruneBindings: vi.fn(async () => {}),
    router: { view: vi.fn(async (providerId: string) => ({ providerId, config: stored, members: [] })) },
    directory: { listCandidates: vi.fn(async () => candidates), resolveMembers: vi.fn(), invalidate: vi.fn() },
    readGroup: vi.fn(() => stored),
    writeGroup: vi.fn(async (_id: string, config: unknown) => {
      stored = config as ProviderGroupConfig | null;
      return stored;
    }),
    changed: vi.fn(),
  } as unknown as ProviderGroupCommandDeps & {
    writeGroup: ReturnType<typeof vi.fn>;
    changed: ReturnType<typeof vi.fn>;
    pruneBindings: ReturnType<typeof vi.fn>;
    switchOwner(next: string): void;
  };
}

describe('parseProviderGroupCommand', () => {
  it('rejects malformed commands', () => {
    expect(() => parseProviderGroupCommand(null)).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'get', providerId: 'bad id' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'nope', providerId: 'anthropic' })).toThrow();
    expect(() => parseProviderGroupCommand({ action: 'save', providerId: 'anthropic' })).toThrow();
    expect(parseProviderGroupCommand({ action: 'get', providerId: 'anthropic' })).toEqual({ action: 'get', providerId: 'anthropic' });
  });
});

describe('executeProviderGroupCommand save', () => {
  it('accepts computers this computer can already use and takes their names from the directory', async () => {
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }]);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    });
    const written = d.writeGroup.mock.calls[0][1] as ProviderGroupConfig;
    expect(written.members.map((m) => m.key)).toEqual(['local', MINI.key]);
    expect(written.members[1].label).toBe('Mac mini');
    expect(d.changed).toHaveBeenCalledWith('anthropic');
  });

  it('refuses a computer that is not offered as a candidate', async () => {
    const d = deps([]);
    await expect(executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
  });

  it('does not re-check members that were already in the group (they may be offline)', async () => {
    const existing: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    const d = deps([], existing);
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { ...existing, strategy: 'round' },
    });
    expect(d.directory.listCandidates).not.toHaveBeenCalled();
    expect((d.writeGroup.mock.calls[0][1] as ProviderGroupConfig).strategy).toBe('round');
  });

  it('deletes the group when the last member is removed', async () => {
    const d = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL] });
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [] },
    });
    expect(d.writeGroup).toHaveBeenCalledWith('anthropic', null);
    expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', null);
  });

  it('releases tasks bound to computers that were removed from the group', async () => {
    const d = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] });
    await executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL] },
    });
    expect(d.pruneBindings).toHaveBeenCalledWith('anthropic', new Set(['local']));

    const removed = deps([], { strategy: 'least', autoSwitch: true, members: [LOCAL] });
    await executeProviderGroupCommand(removed, { action: 'delete', providerId: 'anthropic' });
    expect(removed.pruneBindings).toHaveBeenCalledWith('anthropic', null);
  });

  it('does not write when the account changed while reading the candidates', async () => {
    const d = deps([{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }]);
    (d.directory.listCandidates as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      d.switchOwner('owner-b');
      return [{ key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' }];
    });
    await expect(executeProviderGroupCommand(d, {
      action: 'save',
      providerId: 'anthropic',
      config: { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] },
    })).rejects.toThrow(/PRECONDITION_FAILED/);
    expect(d.writeGroup).not.toHaveBeenCalled();
    expect(d.pruneBindings).not.toHaveBeenCalled();
  });
});
