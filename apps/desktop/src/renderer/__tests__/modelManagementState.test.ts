import { describe, expect, it } from 'vitest';
import { modelManagementState } from '../components/settings/modelManagementState';

const chat = {
  ids: ['chat'],
  capability: false,
  savedSelected: true,
  disabled: false,
  paymentRequired: false,
};
const image = { ...chat, ids: ['gpt-image-2'], capability: true };

describe('model management state across execution channels', () => {
  it.each([false, true])('chat connection %s does not grant image access', (connected) => {
    const provider = { connected, availableMediaModelIds: [] };
    expect(modelManagementState(provider, chat).selected).toBe(connected);
    expect(modelManagementState(provider, image)).toMatchObject({
      ready: false,
      selected: false,
      canSelect: false,
    });
  });
  it('independent image credentials allow images while ChatGPT is disconnected', () => {
    const provider = { connected: false, availableMediaModelIds: ['gpt-image-2'] };
    expect(modelManagementState(provider, chat)).toMatchObject({
      ready: false,
      selected: false,
      hidden: false,
    });
    expect(modelManagementState(provider, image)).toMatchObject({
      ready: true,
      selected: false,
      hidden: false,
    });
  });
  it('does not invent readiness for an older host or another media model', () => {
    expect(modelManagementState({ connected: true }, image).ready).toBe(false);
    expect(
      modelManagementState({ connected: true, availableMediaModelIds: ['different-image'] }, image)
        .ready,
    ).toBe(false);
  });
  it.each(['suspended', 'disabled', 'paymentRequired'] as const)(
    '%s excludes both channels',
    (condition) => {
      for (const model of [chat, image]) {
        const provider = {
          connected: true,
          availableMediaModelIds: ['gpt-image-2'],
          suspended: condition === 'suspended',
        };
        expect(modelManagementState(provider, { ...model, [condition]: true })).toMatchObject({
          ready: false,
          selected: false,
          hidden: false,
          canSelect: false,
        });
      }
    },
  );
  it('counts, switches and groups agree through disconnection and reconnection without changing saved choices', () => {
    const saved = [chat, { ...chat, ids: ['other'], savedSelected: false }];
    for (const connected of [true, false, true]) {
      const states = saved.map((model) => modelManagementState({ connected }, model));
      expect(states.filter((state) => state.selected)).toHaveLength(connected ? 1 : 0);
      expect(states.filter((state) => state.hidden)).toHaveLength(connected ? 1 : 0);
    }
    expect(saved.map((model) => model.savedSelected)).toEqual([true, false]);
  });
});
