// Unit: the cloud IM settings channel. Owner-gated, closed call list, Slack is never turned on
// here, saved credentials stay on the instance and the reply names the owner generation.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CLOUD_IM_SETTINGS_CALLS, CLOUD_IM_SETTINGS_READS } from '../../../shared/cloudImSettings';
import { connectTestMaintenanceGate, disconnectTestMaintenanceGate } from './maintenanceGateFixture';
import { hasCloudManagementCall, registerCloudDomainCall } from '../../host-settings/managementCalls';
import { createImSettingsChannel, type ImSettingsChannelDeps } from '../imSettingsChannel';

// The call table fills only on a managed cloud instance.
vi.mock('../config.js', () => ({ getInstanceConfig: () => ({}) }));

const OWNER = { dataOwnerId: 'owner-1', ownerGeneration: 3 };

function setup(result: unknown = { ok: true }, overrides: Partial<ImSettingsChannelDeps> = {}) {
  let isOwner = true;
  let owner: typeof OWNER | null = OWNER;
  const call = vi.fn<ImSettingsChannelDeps['call']>(async () => result);
  const channel = createImSettingsChannel({
    isInstanceOwner: () => isOwner,
    owner: () => owner,
    call,
    ...overrides,
  });
  return {
    channel,
    call,
    setOwner(next: boolean) {
      isOwner = next;
    },
    switchAccount() {
      owner = { dataOwnerId: 'owner-2', ownerGeneration: 4 };
    },
  };
}

describe('cloud IM settings channel', () => {
  // Unit: an IM change counts as maintenance work; once maintenance has begun it is refused with a
  // retryable code before reaching Main, while reads still answer.
  it('refuses IM changes once maintenance has begun and still reads', async () => {
    const gate = connectTestMaintenanceGate();
    onTestFinished(disconnectTestMaintenanceGate);
    const { channel, call } = setup();
    gate.preparing = true;
    await expect(channel.handle('mac', { call: 'telegramBot:set-behavior', args: [{}] })).rejects.toThrow('[CLOUD_MAINTENANCE_RETRY]');
    expect(call).not.toHaveBeenCalled();
    await expect(channel.handle('mac', { call: 'telegramBot:get-behavior', args: [] })).resolves.toMatchObject({ ownerGeneration: expect.any(Number) });
  });
  it('lists only real calls as reads', () => {
    for (const read of CLOUD_IM_SETTINGS_READS) expect(CLOUD_IM_SETTINGS_CALLS).toContain(read);
  });
  it('runs one listed call with its arguments and returns the owner generation', async () => {
    const { channel, call } = setup({ persona: { botName: 'Cindy', soul: '' } });
    await expect(
      channel.handle('mac', { call: 'telegramBot:set-persona', args: [{ botName: 'Cindy' }] }),
    ).resolves.toEqual({ ownerGeneration: 3, result: { persona: { botName: 'Cindy', soul: '' } } });
    expect(call).toHaveBeenCalledWith(
      'telegramBot:set-persona',
      [{ botName: 'Cindy' }],
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
  });

  it('refuses callers other than the instance owner before reading the request', async () => {
    const { channel, call, setOwner } = setup();
    setOwner(false);
    await expect(
      channel.handle('mac', { call: 'maker:hook-control:get', args: [] }),
    ).rejects.toThrow('[PERMISSION_DENIED]');
    expect(call).not.toHaveBeenCalled();
  });

  // Unit: the Feishu card declares select_device, and the cloud channel must accept its
  // native handler. The reply must follow the actual acknowledged selection.
  it('waits for the native working-computer selection and preserves its owner stamp', async () => {
    let finish!: (value: unknown) => void;
    const { channel } = setup(undefined, {
      call: vi.fn(() => new Promise(resolve => { finish = resolve; })),
    });
    let settled = false;
    const reply = channel.handle('mac', { call: 'maker:hook-control:provider-bind-select', args: [{ provider: 'feishu' }] });
    void reply.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ hook: { feishu: { binding: { state: 'confirmed' } } } });
    await expect(reply).resolves.toEqual({ ownerGeneration: 3, result: { hook: { feishu: { binding: { state: 'confirmed' } } } } });
  });

  it('rejects calls outside the closed list and malformed requests', async () => {
    const { channel, call } = setup();
    for (const request of [
      { call: 'maker:hook-control:add-binding', args: [] },
      { call: 'maker:provider:custom:delete', args: [] },
      { call: 'maker:hook-control:get', args: [1, 2, 3, 4, 5] },
      { call: 'maker:hook-control:get', args: [], extra: true },
      null,
    ])
      await expect(channel.handle('mac', request)).rejects.toThrow('[INVALID_PARAMS]');
    expect(call).not.toHaveBeenCalled();
  });

  it('only turns Slack off; turning it on stays on the authorization ticket', async () => {
    const { channel, call } = setup();
    await expect(
      channel.handle('mac', { call: 'maker:hook-control:set-enabled', args: [{ enabled: true }] }),
    ).rejects.toThrow('[UNSUPPORTED]');
    await expect(
      channel.handle('mac', { call: 'maker:hook-control:set-enabled', args: [] }),
    ).rejects.toThrow('[UNSUPPORTED]');
    expect(call).not.toHaveBeenCalled();
    await channel.handle('mac', { call: 'maker:hook-control:set-enabled', args: [{ enabled: false }] });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('removes saved credentials from status replies', async () => {
    const { channel } = setup({
      status: 'connected',
      appId: 'cli_a',
      appSecret: 'plain-secret',
      hasSecret: true,
      token: 'bot-token',
      ownerOpenId: 'ou_1',
    });
    await expect(channel.handle('mac', { call: 'feishuBot:get-state', args: [] })).resolves.toEqual({
      ownerGeneration: 3,
      result: {
        status: 'connected',
        appId: 'cli_a',
        appSecret: null,
        hasSecret: true,
        token: null,
        ownerOpenId: 'ou_1',
      },
    });
  });

  it('keeps native coded errors and hides others', async () => {
    const coded = setup(undefined, {
      call: async () => {
        throw Object.assign(new Error('[HOOK_NOT_CONNECTED] telegram is not connected'), {
          code: 'HOOK_NOT_CONNECTED',
        });
      },
    });
    await expect(
      coded.channel.handle('mac', { call: 'telegramBot:list-groups', args: [] }),
    ).rejects.toThrow('[HOOK_NOT_CONNECTED] telegram is not connected');
    const plain = setup(undefined, {
      call: async () => {
        throw new Error('/home/cindy/.config leaked');
      },
    });
    await expect(
      plain.channel.handle('mac', { call: 'telegramBot:list-groups', args: [] }),
    ).rejects.toThrow('[INTERNAL] IM settings request failed');
  });

  it('drops the reply when the account changes during the call', async () => {
    let switchAccount = () => {};
    const { channel, switchAccount: change } = setup(undefined, {
      call: async () => {
        switchAccount();
        return { ok: true };
      },
    });
    switchAccount = change;
    await expect(
      channel.handle('mac', { call: 'maker:hook-control:get', args: [] }),
    ).rejects.toThrow('[OWNER_CHANGED]');
  });

  it('refuses a reply larger than the transfer limit', async () => {
    const { channel } = setup({ blob: 'x'.repeat(600 * 1024) });
    await expect(
      channel.handle('mac', { call: 'maker:hook-control:get', args: [] }),
    ).rejects.toThrow('[TOO_LARGE]');
  });

  it('lists only calls the cloud management adapter compiles in', () => {
    // Unlisted names are ignored by the adapter, so a missing name would never become callable.
    for (const name of CLOUD_IM_SETTINGS_CALLS) {
      registerCloudDomainCall(name, () => null);
      expect(hasCloudManagementCall(name)).toBe(true);
    }
    registerCloudDomainCall('maker:hook-control:add-binding', () => null);
    expect(hasCloudManagementCall('maker:hook-control:add-binding')).toBe(false);
  });
});
