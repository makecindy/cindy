import { describe, expect, it, vi } from 'vitest';
import { createSettingsManagement, type ManagementExecution } from '../management.js';
import { registerCloudDomainCall, registerCloudImCall } from '../managementCalls.js';
import { listBotNotificationManagement } from '../managementNotifications.js';
import {
  BOT_NOTIFICATION_GROUP,
  BOT_NOTIFICATION_ITEMS,
} from '../../../shared/cloudBotNotifications.js';

// The call table fills only on a managed cloud instance.
vi.mock('../../instance-runtime/config.js', () => ({ getInstanceConfig: () => ({}) }));

const caller = { key: 'fixture-owner-browser', assertCurrent() {} };
const execution: ManagementExecution = {
  signal: new AbortController().signal,
  assertCurrent() {},
  prompt() {},
  onCancel() {},
};
const all = () => true;
const wecom = (state: Record<string, unknown>) => {
  const calls = {
    saveAndTest: vi.fn<(...args: unknown[]) => { configured: boolean; enabled: boolean }>(() => ({ configured: true, enabled: true })),
    test: vi.fn<(...args: unknown[]) => { ok: boolean }>(() => ({ ok: true })),
    clear: vi.fn(() => ({ configured: false, enabled: false })),
  };
  registerCloudDomainCall('wecomGroupNotification:get-state', () => state);
  registerCloudDomainCall('wecomGroupNotification:save-and-test', calls.saveAndTest);
  registerCloudDomainCall('wecomGroupNotification:test', calls.test);
  registerCloudDomainCall('wecomGroupNotification:clear', calls.clear);
  return calls;
};
const byId = async (
  id: string,
  visible: Parameters<typeof listBotNotificationManagement>[1] = all,
) => (await listBotNotificationManagement(caller, visible)).find((entry) => entry.id === id);

describe('cloud bot notification management', () => {
  // Unit: the webhook is write-only; only configured state and the local masked key leave.
  it('offers save-and-test for an unconfigured WeCom webhook without projecting secrets', async () => {
    const calls = wecom({ configured: false, enabled: false });
    const entry = (await byId(BOT_NOTIFICATION_ITEMS.wecomGroup))!;
    expect(entry).toMatchObject({ group: BOT_NOTIFICATION_GROUP, status: 'disconnected' });
    expect(entry.detail).toBeUndefined();
    expect(entry.actions.map((action) => action.intent)).toEqual(['create']);
    const webhook = entry.actions[0]!.fields!.find((field) => field.name === 'webhookUrl')!;
    expect(webhook).toMatchObject({ kind: 'password', required: true });
    expect(webhook).not.toHaveProperty('value');
    await entry.actions[0]!.run(
      { webhookUrl: 'https://example.invalid/hook', message: 'test text' },
      execution,
    );
    expect(calls.saveAndTest).toHaveBeenCalledWith('https://example.invalid/hook', 'test text');
  });
  it('offers test and remove for a configured WeCom webhook with only the masked key', async () => {
    const calls = wecom({ configured: true, enabled: true, maskedKey: '••••abcd' });
    const entry = (await byId(BOT_NOTIFICATION_ITEMS.wecomGroup))!;
    expect(entry).toMatchObject({ status: 'connected', detail: '••••abcd' });
    expect(entry.actions.map((action) => action.intent)).toEqual(['sync', 'delete']);
    await entry.actions[0]!.run({ message: 'test text' }, execution);
    expect(calls.test).toHaveBeenCalledWith('test text');
    await entry.actions[1]!.run({}, execution);
    expect(calls.clear).toHaveBeenCalledTimes(1);
  });
  // Regression guard: a ticket listed for one webhook must not remove a replaced one.
  it('refuses a stale WeCom action after the webhook changed', async () => {
    const state = { configured: true, enabled: true, maskedKey: '••••abcd' };
    const calls = wecom(state);
    const entry = (await byId(BOT_NOTIFICATION_ITEMS.wecomGroup))!;
    state.maskedKey = '••••wxyz';
    await expect(entry.actions[1]!.run({}, execution)).rejects.toThrow('CHANGED');
    expect(calls.clear).not.toHaveBeenCalled();
  });
  it('reduces the Feishu owner to bound state and edits the lifecycle announcement', async () => {
    const set = vi.fn(() => ({ ok: true }));
    registerCloudImCall('feishuBot:get-state', () => ({
      status: 'connected',
      hasSecret: true,
      appSecret: 'NEVER-PROJECT',
      ownerOpenId: 'ou_NEVER-PROJECT',
      lifecycleAnnouncement: false,
    }));
    registerCloudImCall('feishuBot:set-lifecycle-announcement', set);
    const entry = (await byId(BOT_NOTIFICATION_ITEMS.feishu))!;
    expect(JSON.stringify(entry)).not.toContain('NEVER-PROJECT');
    expect(entry.status).toBe('connected');
    const field = entry.actions[0]!.fields![0]!;
    expect(field).toMatchObject({ name: 'lifecycleAnnouncement', kind: 'select', value: 'off' });
    await entry.actions[0]!.run({ lifecycleAnnouncement: 'on' }, execution);
    expect(set).toHaveBeenCalledWith({ enabled: true });
  });
  it('hides Feishu notifications until credentials are saved, like the local card', async () => {
    registerCloudImCall('feishuBot:get-state', () => ({ status: 'idle', hasSecret: false }));
    registerCloudImCall('feishuBot:set-lifecycle-announcement', () => ({ ok: true }));
    expect(await byId(BOT_NOTIFICATION_ITEMS.feishu)).toBeUndefined();
  });
  it('reports a failed Discord write and respects region visibility', async () => {
    registerCloudImCall('discordBot:get-status', () => ({
      status: 'connected',
      lifecycleAnnouncement: true,
    }));
    registerCloudImCall('discordBot:set-lifecycle-announcement', () => ({
      ok: false,
      lifecycleAnnouncement: true,
    }));
    expect(await byId(BOT_NOTIFICATION_ITEMS.discord, (id) => id !== 'discord')).toBeUndefined();
    const entry = (await byId(BOT_NOTIFICATION_ITEMS.discord))!;
    expect(entry.actions[0]!.fields![0]).toMatchObject({ value: 'on' });
    await expect(
      entry.actions[0]!.run({ lifecycleAnnouncement: 'off' }, execution),
    ).rejects.toThrow('SAVE_FAILED');
  });
  // Through the management executor: values must match the declared fields and options.
  it('rejects undeclared values and unknown options before calling the service', async () => {
    const set = vi.fn(() => ({ ok: true }));
    registerCloudImCall('discordBot:get-status', () => ({ lifecycleAnnouncement: true }));
    registerCloudImCall('discordBot:set-lifecycle-announcement', set);
    const management = createSettingsManagement({
      list: async () => listBotNotificationManagement(caller, (id) => id === 'discord'),
    });
    const page = await management.execute(caller, { operation: 'list', section: 'bots' });
    if (page.kind !== 'page') throw new Error('expected page');
    const actionId = page.items[0]!.actions[0]!.id;
    for (const values of <Record<string, string>[]>[
      { lifecycleAnnouncement: 'maybe' },
      { lifecycleAnnouncement: 'on', other: 'x' },
    ])
      await expect(
        management.execute(caller, {
          operation: 'run',
          actionId,
          operationId: crypto.randomUUID(),
          values,
        }),
      ).rejects.toThrow('INVALID_INPUT');
    expect(set).not.toHaveBeenCalled();
  });
});
