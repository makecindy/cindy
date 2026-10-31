/**
 * Test value: the renderer mirror of each desktop's own project pins. Project pins used to stay
 * on the computer that pinned them; controllers now read and write the owning desktop.
 * Minimal regressions: a read issued before a host push must not restore the older pins; an older
 * host (missing channel) must be marked unavailable while a timeout keeps the last known pins; a
 * write must echo the host owner stamp. Unit tier; transport is an in-memory invoke fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { remoteProjectPins } from '@/features/device-link/remoteProjectPins';

const stamp = (owner = 'owner', ownerGeneration = 1) => ({ dataOwnerId: owner, ownerGeneration });
const pins = (projectKeys: string[], owner = 'owner') => ({
  available: true,
  projectKeys,
  ownerStamp: stamp(owner),
});
const localStamp = { dataOwnerId: 'owner', ownerGeneration: 1 };
const invoke = vi.fn();

beforeEach(() => {
  remoteProjectPins.clear();
  setDataOwnerGeneration('owner', 1);
  invoke.mockReset();
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
});
afterEach(() => {
  remoteProjectPins.clear();
  setDataOwnerGeneration(null, 0);
  vi.unstubAllGlobals();
});

describe('remote project pin mirror', () => {
  it('mirrors only host-local pins per device and forgets a device that leaves', async () => {
    invoke
      .mockResolvedValueOnce(pins(['local:/a', 'device:peer:/b', 'remote:ssh:/c', 'session-1']))
      .mockResolvedValueOnce(pins(['local:/z']));
    await remoteProjectPins.refresh('host-a', () => true);
    await remoteProjectPins.refresh('host-b', () => true);
    expect(invoke).toHaveBeenCalledWith('host-a', 'sidebar-settings:get-project-pins', [], {
      background: true,
    });
    expect(remoteProjectPins.getSnapshot().get('host-a')?.projectKeys).toEqual(['local:/a']);

    remoteProjectPins.remove('host-a');
    expect(remoteProjectPins.getSnapshot().has('host-a')).toBe(false);
    expect(remoteProjectPins.getSnapshot().get('host-b')?.projectKeys).toEqual(['local:/z']);
    setDataOwnerGeneration('other', 2);
    expect(remoteProjectPins.getSnapshot().size).toBe(0);
  });

  it('lets a host push win over a read that was already in flight', async () => {
    let complete!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = remoteProjectPins.refresh('host-a', () => true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    expect(
      remoteProjectPins.acceptPush(
        { deviceId: 'host-a', payload: pins(['local:/new']) },
        localStamp,
        () => true,
      ),
    ).toBe(true);
    complete(pins(['local:/old']));
    await pending;
    expect(remoteProjectPins.getSnapshot().get('host-a')?.projectKeys).toEqual(['local:/new']);

    // Another account's frame, or one older than the accepted generation, is ignored.
    expect(
      remoteProjectPins.acceptPush(
        { deviceId: 'host-a', payload: pins(['local:/foreign'], 'other') },
        localStamp,
        () => true,
      ),
    ).toBe(false);
    expect(remoteProjectPins.getSnapshot().get('host-a')?.projectKeys).toEqual(['local:/new']);
  });

  it('marks an older host unavailable but keeps the last pins through a timeout', async () => {
    invoke.mockResolvedValueOnce(pins(['local:/a']));
    await remoteProjectPins.refresh('host-a', () => true);
    invoke.mockRejectedValueOnce(new Error('[TIMEOUT] remote invoke timed out'));
    await remoteProjectPins.refresh('host-a', () => true);
    expect(remoteProjectPins.getSnapshot().get('host-a')).toMatchObject({
      available: true,
      projectKeys: ['local:/a'],
    });

    invoke.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] sidebar-settings:get-project-pins'));
    await remoteProjectPins.refresh('host-b', () => true);
    expect(remoteProjectPins.getSnapshot().get('host-b')).toEqual({
      available: false,
      projectKeys: [],
    });
  });

  it('writes host-local keys with the host owner stamp and adopts the returned snapshot', async () => {
    await expect(remoteProjectPins.setPinned('host-a', ['local:/a'], true)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({ ...pins([]), ownerStamp: stamp('owner', 7) });
    await remoteProjectPins.refresh('host-a', () => true);
    invoke.mockResolvedValueOnce({ ...pins(['local:/a']), ownerStamp: stamp('owner', 7) });
    await remoteProjectPins.setPinned('host-a', ['local:/a'], true);
    expect(invoke).toHaveBeenLastCalledWith('host-a', 'sidebar-settings:apply-project-pins', [
      { dataOwnerId: 'owner', ownerGeneration: 7, projectKeys: ['local:/a'], pinned: true },
    ]);
    expect(remoteProjectPins.getSnapshot().get('host-a')?.projectKeys).toEqual(['local:/a']);
  });
});
