// Write coalescing and lifecycle of optimistic cloud settings. Tier: unit (fake timers).
// Why: every cloud write waits 1–3 s for the instance mailbox; the page must not lock or
// send one write per click, and must not submit a stale patch after leaving the page.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTrialCloudSettingsClient } from '../trialClient';
import { CLOUD_SYNC_DEBOUNCE_MS, createCloudSettingsSync } from '../cloudSettingsSync';
import type { CloudSettingsClient } from '../client';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const client = createTrialCloudSettingsClient();
  await client.connect();
  const original = client.save.bind(client);
  const save = vi.spyOn(client, 'save');
  const onFailure = vi.fn();
  const onChange = vi.fn();
  const sync = createCloudSettingsSync({ client, onChange, onFailure });
  sync.ingest(await client.read(['collaboration']), sync.stamp());
  const limit = () => sync.view().collaboration?.value?.workerSoftLimit;
  return { client, original, save, sync, onChange, onFailure, limit };
}
/** Holds the next write open until `release` is called. */
function hold(
  save: MockInstance<CloudSettingsClient['save']>,
  original: CloudSettingsClient['save'],
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  save.mockImplementationOnce((...args) => gate.then(() => original(...args)));
  return () => release();
}

describe('optimistic cloud settings sync', () => {
  it('turns three quick +1 steps into one write with the final value', async () => {
    const { save, sync, limit } = await setup();
    for (const value of [5, 6, 7])
      sync.change('collaboration', { workerSoftLimit: value }, [], true);
    expect(limit()).toBe(7);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toEqual({ workerSoftLimit: 7 });
    expect(limit()).toBe(7);
  });

  it('merges steps made while a write is in flight into one follow-up on the new revision', async () => {
    const { save, original, sync, limit } = await setup();
    const release = hold(save, original);
    sync.change('collaboration', { workerSoftLimit: 5 }, [], true);
    await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS);
    for (const value of [6, 7]) sync.change('collaboration', { workerSoftLimit: value }, [], true);
    await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // An older read finishing now must not pull the shown value back.
    sync.ingest([{ ...sync.view().collaboration!, value: { workerSoftLimit: 4 } }], 0);
    expect(limit()).toBe(7);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].revision).toBe('2');
    expect(save.mock.calls[1][1]).toEqual({ workerSoftLimit: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(limit()).toBe(7);
    expect(sync.busy()).toBe(false);
  });

  // Leaving sends a waiting change at once instead of dropping it.
  // Each change still goes out exactly once, and its result no longer touches the page.
  it('sends waiting changes once when leaving, and leaves the page alone afterwards', async () => {
    const { client, save, original, sync, onChange, onFailure } = await setup();
    const left = createCloudSettingsSync({ client, onChange: vi.fn(), onFailure });
    left.ingest([sync.view().collaboration!], left.stamp());
    left.change('collaboration', { workerSoftLimit: 8 }, [], true);
    left.change('collaboration', { workerSoftLimit: 9 }, [], true);
    const done = left.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toEqual({ workerSoftLimit: 9 });
    await done;
    await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
    save.mockClear();
    // A write in flight and a change waiting behind it: both go out, the second on the new revision.
    sync.ingest(await client.read(['collaboration']), sync.stamp());
    const release = hold(save, original);
    sync.change('collaboration', { workerSoftLimit: 6 });
    await vi.advanceTimersByTimeAsync(0);
    sync.change('collaboration', { workerSoftLimit: 7 }, [], true);
    const flushed = sync.dispose();
    const calls = onChange.mock.calls.length;
    release();
    await flushed;
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual({ workerSoftLimit: 7 });
    expect(save.mock.calls[1][0].revision).not.toBe(save.mock.calls[0][0].revision);
    const [saved] = await client.read(['collaboration']);
    expect(saved?.value?.workerSoftLimit).toBe(7);
    expect(onChange.mock.calls.length).toBe(calls);
    expect(onFailure).not.toHaveBeenCalled();
    expect(() => sync.change('collaboration', { workerSoftLimit: 7 })).toThrow('NOT_READY');
  });

  it('never resends a flushed write whose outcome is unknown', async () => {
    const { client, save, onFailure } = await setup();
    const read = vi.spyOn(client, 'read');
    const left = createCloudSettingsSync({ client, onChange: vi.fn(), onFailure });
    left.ingest(await client.read(['collaboration']), left.stamp());
    read.mockClear();
    save.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED'));
    left.change('collaboration', { workerSoftLimit: 9 }, [], true);
    await left.dispose();
    await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  // Never "not sure whether it saved": an unknown outcome is read back, never resent, and the
  // page says only what it found or what it will do.
  describe('a write whose outcome is unknown', () => {
    const unknown = () => Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED');
    it('says it was not saved, shows the instance value, and retries the same change once asked', async () => {
      const { client, save, sync, onFailure, limit } = await setup();
      const before = limit();
      save.mockRejectedValueOnce(unknown());
      sync.change('collaboration', { workerSoftLimit: 9 });
      await vi.advanceTimersByTimeAsync(0);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][0]).toMatchObject({ domain: 'collaboration', reason: 'notSaved' });
      expect(limit()).toBe(before);
      expect(save).toHaveBeenCalledTimes(1);
      // The retry reads first, then writes the same value on the revision it read.
      const read = vi.spyOn(client, 'read');
      onFailure.mock.calls[0][0].retry();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledWith(['collaboration']);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1][1]).toEqual({ workerSoftLimit: 9 });
      expect(limit()).toBe(9);
      expect(onFailure).toHaveBeenCalledTimes(1);
    });

    it('keeps the change on screen while it reads again after 2 s and 5 s, then says what it will do', async () => {
      const { client, save, sync, onFailure, limit } = await setup();
      const before = limit();
      const read = vi.spyOn(client, 'read').mockRejectedValue(Error('CLOUD_SETTINGS_UNAVAILABLE'));
      save.mockRejectedValueOnce(unknown());
      sync.change('collaboration', { workerSoftLimit: 9 });
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(read).toHaveBeenCalledTimes(2);
      expect(onFailure).not.toHaveBeenCalled();
      expect(limit()).toBe(9);
      expect(sync.busy()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(3);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][0]).toMatchObject({ reason: 'unreachable' });
      // Back to the last confirmed value; nothing was sent again.
      expect(limit()).toBe(before);
      expect(save).toHaveBeenCalledTimes(1);
      expect(sync.busy()).toBe(false);
    });

    it('says nothing when a later read finds the change saved', async () => {
      const { client, original, save, sync, onFailure, limit } = await setup();
      const read = vi.spyOn(client, 'read').mockRejectedValueOnce(Error('CLOUD_SETTINGS_UNAVAILABLE'));
      save.mockImplementationOnce(async (...args) => {
        await original(...args);
        throw unknown();
      });
      sync.change('collaboration', { workerSoftLimit: 9 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(read).toHaveBeenCalledTimes(2);
      expect(onFailure).not.toHaveBeenCalled();
      expect(limit()).toBe(9);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('stops reading at once when the page is left', async () => {
      const { client, save, sync, onFailure } = await setup();
      const read = vi.spyOn(client, 'read').mockRejectedValue(Error('CLOUD_SETTINGS_UNAVAILABLE'));
      save.mockRejectedValueOnce(unknown());
      sync.change('collaboration', { workerSoftLimit: 9 });
      await vi.advanceTimersByTimeAsync(0);
      let left = false;
      void sync.dispose().then(() => (left = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(left).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      expect(onFailure).not.toHaveBeenCalled();
    });
  });

  // A quick on → off → on merges into a write of the original value, which would leave an explicit
  // override and a "customized" mark. Nothing changed, so nothing is written.
  describe('changes that end where they started', () => {
    async function setupGroups() {
      const client = createTrialCloudSettingsClient();
      await client.connect();
      const original = client.save.bind(client);
      const save = vi.spyOn(client, 'save');
      const sync = createCloudSettingsSync({ client, onChange: vi.fn(), onFailure: vi.fn() });
      const read = async () => sync.ingest(await client.read(['memory', 'collaboration']), sync.stamp());
      await read();
      const memory = () => sync.view().memory!;
      return { client, original, save, sync, read, memory };
    }

    it('writes nothing for on → off → on', async () => {
      const { save, sync, memory } = await setupGroups();
      expect(memory().customizedKeys).toEqual([]);
      sync.change('memory', { maker: false });
      sync.change('memory', { maker: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(save).not.toHaveBeenCalled();
      expect(memory().value?.maker).toBe(true);
      expect(memory().customizedKeys).toEqual([]);
      expect(sync.busy()).toBe(false);
    });

    it('clears the override its own in-flight write made when the value returns to the default', async () => {
      const { client, original, save, sync, memory } = await setupGroups();
      const release = hold(save, original);
      sync.change('memory', { maker: false });
      await vi.advanceTimersByTimeAsync(0);
      sync.change('memory', { maker: true });
      release();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[1][1]).toEqual({});
      expect(save.mock.calls[1][2]).toEqual(['maker']);
      const [stored] = await client.read(['memory']);
      expect(stored?.customizedKeys).toEqual([]);
      expect(memory().customizedKeys).toEqual([]);
      expect(memory().value?.maker).toBe(true);
    });

    it('writes nothing when a saved override is changed and changed back', async () => {
      const { client, original, save, sync, read, memory } = await setupGroups();
      const [state] = await client.read(['memory']);
      await original(state!, { maker: false });
      await read();
      expect(memory().customizedKeys).toEqual(['maker']);
      sync.change('memory', { maker: true });
      sync.change('memory', { maker: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(save).not.toHaveBeenCalled();
      expect(memory().customizedKeys).toEqual(['maker']);
    });

    it('writes a new order of a list whose order matters', async () => {
      const { save, sync } = await setupGroups();
      const [auxiliary] = await createTrialCloudSettingsClient().read(['auxiliaryModel']);
      sync.ingest([{ ...auxiliary!, value: { models: ['a', 'b'] } }], sync.stamp());
      sync.change('auxiliaryModel', { models: ['b', 'a'] });
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][1]).toEqual({ models: ['b', 'a'] });
    });

    it('writes nothing when a stepper is clamped back to the saved value', async () => {
      const { save, sync } = await setupGroups();
      const limit = sync.view().collaboration!.value!.workerHardLimit as number;
      sync.change('collaboration', { workerHardLimit: limit + 1 }, [], true);
      sync.change('collaboration', { workerHardLimit: limit }, [], true);
      await vi.advanceTimersByTimeAsync(CLOUD_SYNC_DEBOUNCE_MS * 2);
      expect(save).not.toHaveBeenCalled();
      expect(sync.view().collaboration!.customizedKeys).toEqual([]);
    });
  });
});
