// Unit: the cloud prompt channel. Owner-gated; saves and resets are revision-checked against
// the Host store and keep the owner generation; failures never echo the stored text.
import { describe, expect, it, vi } from 'vitest';
import {
  createPersonalizationChannel,
  type PersonalizationChannelDeps,
} from '../personalizationChannel';

const OWNER = { dataOwnerId: 'owner-1', ownerGeneration: 5 };
const ready = (userPrompt: string, revision: string) =>
  ({
    status: 'ready',
    ownerStamp: OWNER,
    revision,
    initialized: true,
    isCustomized: userPrompt !== '',
    customizedKeys: userPrompt ? ['userPrompt'] : [],
    defaults: { userPrompt: '' },
    value: { userPrompt },
  }) as unknown as ReturnType<PersonalizationChannelDeps['inspect']>;

function setup(overrides: Partial<PersonalizationChannelDeps> = {}) {
  let current = ready('hello', 'rev-1');
  let isOwner = true;
  const commit = vi.fn<PersonalizationChannelDeps['commit']>(async (mutation) => {
    const next = 'set' in mutation && mutation.set?.userPrompt !== undefined ? mutation.set.userPrompt : '';
    current = ready(String(next), 'rev-2');
  });
  const channel = createPersonalizationChannel({
    isInstanceOwner: () => isOwner,
    owner: () => OWNER,
    inspect: () => current,
    commit,
    ...overrides,
  });
  return {
    channel,
    commit,
    notOwner() {
      isOwner = false;
    },
  };
}

describe('cloud personalization channel', () => {
  it('reads the full prompt with its revision', async () => {
    const { channel } = setup();
    await expect(channel.handle('mac', { op: 'read' })).resolves.toEqual({
      status: 'ready',
      ownerGeneration: 5,
      revision: 'rev-1',
      userPrompt: 'hello',
      customized: true,
    });
  });

  it('saves against the expected revision and returns the new state', async () => {
    const { channel, commit } = setup();
    await expect(
      channel.handle('mac', { op: 'save', ownerGeneration: 5, revision: 'rev-1', userPrompt: 'new' }),
    ).resolves.toMatchObject({ status: 'ready', revision: 'rev-2', userPrompt: 'new' });
    expect(commit).toHaveBeenCalledWith(
      { set: { userPrompt: 'new' } },
      expect.objectContaining({ expectedRevision: 'rev-1', assertCurrent: expect.any(Function) }),
    );
  });

  it('resets to the default by clearing the field', async () => {
    const { channel, commit } = setup();
    await expect(
      channel.handle('mac', { op: 'reset', ownerGeneration: 5, revision: 'rev-1' }),
    ).resolves.toMatchObject({ userPrompt: '', customized: false });
    expect(commit.mock.calls[0][0]).toEqual({ clear: ['userPrompt'] });
  });

  it('maps a stale revision to REVISION_CONFLICT', async () => {
    const { channel } = setup({
      commit: async () => {
        throw Object.assign(new Error('conflict'), { code: 'CONFLICT' });
      },
    });
    await expect(
      channel.handle('mac', { op: 'save', ownerGeneration: 5, revision: 'old', userPrompt: 'x' }),
    ).rejects.toThrow('[REVISION_CONFLICT]');
  });

  it('refuses another owner generation and non-owners', async () => {
    const { channel, commit, notOwner } = setup();
    await expect(
      channel.handle('mac', { op: 'save', ownerGeneration: 4, revision: 'rev-1', userPrompt: 'x' }),
    ).rejects.toThrow('[OWNER_CHANGED]');
    notOwner();
    await expect(channel.handle('mac', { op: 'read' })).rejects.toThrow('[PERMISSION_DENIED]');
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects over-long prompts and unknown operations without writing', async () => {
    const { channel, commit } = setup();
    for (const request of [
      { op: 'save', ownerGeneration: 5, revision: 'rev-1', userPrompt: 'x'.repeat(8001) },
      { op: 'delete' },
      { op: 'read', extra: 1 },
    ])
      await expect(channel.handle('mac', request)).rejects.toThrow('[INVALID_PARAMS]');
    expect(commit).not.toHaveBeenCalled();
  });

  it('hides storage failures behind PRECONDITION_FAILED', async () => {
    const { channel } = setup({
      commit: async () => {
        throw new Error('PREFERENCE_CONFIRMATION_TIMEOUT');
      },
    });
    await expect(
      channel.handle('mac', { op: 'save', ownerGeneration: 5, revision: 'rev-1', userPrompt: 'x' }),
    ).rejects.toThrow(/^\[PRECONDITION_FAILED\] the instructions were not saved$/);
  });
});
