// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudBotAuthorization } from '../CloudBotAuthorization';
import { createTrialCloudSettingsClient } from '../trialClient';
import type { CloudBotNotificationPreferences } from '../CloudBotNotificationSettings';
import { BOT_NOTIFICATION_GROUP } from '../../../../shared/cloudBotNotifications';
import { toast } from '@/lib/toast';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  // Only the target name is interpolated, so scoped copy stays checkable.
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  // No local bot or notification IPC may run for a cloud target.
  Object.assign(window, {
    electronAPI: new Proxy(
      {},
      {
        get() {
          throw Error('LOCAL_API_FORBIDDEN');
        },
      },
    ),
  });
});
afterEach(cleanup);

const preferences = (overrides: Partial<CloudBotNotificationPreferences> = {}) => ({
  wecomEnabled: true,
  feishuSessionEnabled: false,
  setWecomEnabled: vi.fn(async () => {}),
  setFeishuSessionEnabled: vi.fn(async () => {}),
  refresh: vi.fn(),
  ...overrides,
});
const runs = (manage: { mock: { calls: unknown[][] } }) =>
  manage.mock.calls
    .map(([command]) => command as { operation: string; values?: Record<string, string> })
    .filter((command) => command.operation === 'run');
const panel = async (channel: string) => {
  fireEvent.click(await screen.findByText(`settings.${channel}Bot.title`));
  return document.getElementById(`cloud-personal-im-${channel}-panel`)!;
};
// The card remounts when the list reloads with fresh tickets; always query the live panel.
const live = (channel: string) =>
  within(document.getElementById(`cloud-personal-im-${channel}-panel`)!);
const connectTrialBot = async (
  client: ReturnType<typeof createTrialCloudSettingsClient>,
  id: string,
  values: Record<string, string>,
) => {
  const page = await client.manage!({ operation: 'list', section: 'bots' });
  if (page.kind !== 'page') throw new Error('expected page');
  await client.manage!({
    operation: 'run',
    actionId: page.items.find((item) => item.id === id)!.actions[0]!.id,
    operationId: crypto.randomUUID(),
    values,
  });
};

// Unit/jsdom: the WeCom card replaces its "not available" note with the native webhook
// section, driven only by target tickets; the webhook is never shown back.
it('saves, tests and removes the WeCom group webhook through target tickets', async () => {
  const client = createTrialCloudSettingsClient();
  const manage = vi.spyOn(client, 'manage');
  const prefs = preferences();
  render(
    <CloudBotAuthorization deviceId="cloud-test-device"
      client={client}
      online
      active
      name="Cloud"
      trial
      notificationPreferences={prefs}
    />,
  );
  const section = await panel('wecom');
  expect(within(section).queryByText('bots.remoteSettings.finishOnHost')).toBeNull();
  const input = within(section).getByLabelText('settings.notifications.wecomGroupLabel');
  expect(input.getAttribute('type')).toBe('password');
  fireEvent.change(input, { target: { value: 'https://example.invalid/hook' } });
  // The accordion animates open; roles become accessible once it settles.
  fireEvent.click(
    await within(section).findByRole('button', {
      name: 'settings.notifications.wecomGroupSaveAndTest',
    }),
  );
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('settings.notifications.wecomGroupSaveSuccess'),
  );
  expect(runs(manage).at(-1)!.values).toEqual({
    webhookUrl: 'https://example.invalid/hook',
    message: 'settings.notifications.wecomGroupTestMessage',
  });
  expect(prefs.refresh).toHaveBeenCalledTimes(1);
  // Configured: the masked key only, no input, and the native test/remove buttons.
  const test = await waitFor(() =>
    live('wecom').getByRole('button', { name: 'settings.notifications.wecomGroupTest' }),
  );
  expect(live('wecom').queryByLabelText('settings.notifications.wecomGroupLabel')).toBeNull();
  expect(document.body.textContent).not.toContain('example.invalid');
  fireEvent.click(test);
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('settings.notifications.wecomGroupTestSuccess'),
  );
  expect(runs(manage).at(-1)!.values).toEqual({
    message: 'settings.notifications.wecomGroupTestMessage',
  });
  fireEvent.click(
    await waitFor(() =>
      live('wecom').getByRole('switch', { name: 'settings.notifications.wecomGroupAria' }),
    ),
  );
  await waitFor(() => expect(prefs.setWecomEnabled).toHaveBeenCalledWith(false));
  fireEvent.click(
    await waitFor(() =>
      live('wecom').getByRole('button', { name: 'settings.notifications.wecomGroupClear' }),
    ),
  );
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('settings.notifications.wecomGroupCleared'),
  );
  expect(
    await waitFor(() => live('wecom').getByLabelText('settings.notifications.wecomGroupLabel')),
  ).toBeTruthy();
  expect(runs(manage)).toHaveLength(3);
});

it('edits Feishu and Discord announcements and gates Feishu task notices on the owner', async () => {
  const client = createTrialCloudSettingsClient();
  // Save credentials first; like the local cards, their notices need them.
  await connectTrialBot(client, 'bot:feishu', {
    appId: 'example-app',
    appSecret: 'example-secret',
    service: 'feishu',
  });
  await connectTrialBot(client, 'bot:discord', {
    token: 'example-token',
    ownerUserId: '123456789012345678',
  });
  const manage = vi.spyOn(client, 'manage');
  const prefs = preferences();
  render(
    <CloudBotAuthorization deviceId="cloud-test-device"
      client={client}
      online
      active
      name="Cloud"
      trial
      notificationPreferences={prefs}
    />,
  );
  const section = await panel('feishu');
  const lifecycle = await within(section).findByRole('switch', {
    name: 'settings.feishuBot.lifecycleAnnouncement.label',
  });
  expect(lifecycle.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(lifecycle);
  await waitFor(() =>
    expect(runs(manage).at(-1)!.values).toEqual({ lifecycleAnnouncement: 'off' }),
  );
  await waitFor(() =>
    expect(
      live('feishu')
        .getByRole('switch', { name: 'settings.feishuBot.lifecycleAnnouncement.label' })
        .getAttribute('aria-checked'),
    ).toBe('false'),
  );
  const session = live('feishu').getByRole('switch', {
    name: 'settings.feishuBot.sessionNotification.label',
  });
  fireEvent.click(session);
  await waitFor(() => expect(prefs.setFeishuSessionEnabled).toHaveBeenCalledWith(true));

  const discord = await panel('discord');
  fireEvent.click(
    await within(discord).findByRole('switch', {
      name: 'settings.discordBot.lifecycleAnnouncement.label',
    }),
  );
  await waitFor(() =>
    expect(runs(manage).at(-1)!.values).toEqual({ lifecycleAnnouncement: 'off' }),
  );
  expect(toast.error).not.toHaveBeenCalled();
});

// An older target lists no notification items: point to the instance's own page, never a dead control.
it('opens the cloud desktop for notifications on a target without notification items', async () => {
  const client = createTrialCloudSettingsClient();
  const original = client.manage!;
  vi.spyOn(client, 'manage').mockImplementation(async (command) => {
    const result = await original(command);
    return result.kind === 'page'
      ? { ...result, items: result.items.filter((item) => item.group !== BOT_NOTIFICATION_GROUP) }
      : result;
  });
  render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" trial />);
  const section = await panel('wecom');
  // The client's 「请在「X」上完成此设置。」
  expect(within(section).getByText('bots.remoteSettings.finishOnHost')).toBeTruthy();
  const openRemoteDesktop = vi.fn(async () => {});
  Object.assign(window, { electronAPI: { openRemoteDesktop } });
  fireEvent.click(
    await waitFor(() =>
      live('wecom').getByRole('button', { name: 'cloudSettings.openInCloudDesktop' }),
    ),
  );
  expect(openRemoteDesktop).toHaveBeenCalledWith({ deviceId: 'cloud-test-device', name: 'Cloud' });
  expect(within(section).queryByLabelText('settings.notifications.wecomGroupLabel')).toBeNull();
  // Notification items never render as cards of their own.
  expect(screen.queryByText('WeCom group notifications')).toBeNull();
});

it('drops the webhook input when the target goes offline', async () => {
  const client = createTrialCloudSettingsClient();
  const props = { client, active: true, name: 'Cloud', trial: true };
  const view = render(<CloudBotAuthorization deviceId="cloud-test-device" {...props} online />);
  const section = await panel('wecom');
  fireEvent.change(within(section).getByLabelText('settings.notifications.wecomGroupLabel'), {
    target: { value: 'https://example.invalid/hook' },
  });
  view.rerender(<CloudBotAuthorization deviceId="cloud-test-device" {...props} online={false} />);
  // The bot's own connect form keeps its existing offline behaviour; the webhook input goes.
  expect(screen.queryByLabelText('settings.notifications.wecomGroupLabel')).toBeNull();
  expect(screen.queryByText('WeCom group notifications')).toBeNull();
  // The typed URL is not kept for when the target returns.
  view.rerender(<CloudBotAuthorization deviceId="cloud-test-device" {...props} online />);
  expect(
    (
      (await waitFor(() =>
        live('wecom').getByLabelText('settings.notifications.wecomGroupLabel'),
      )) as HTMLInputElement
    ).value,
  ).toBe('');
});

// A failed target operation must surface the native failure toast, not a false success.
it('reports a failed WeCom save and keeps the webhook unconfigured', async () => {
  const client = createTrialCloudSettingsClient();
  const original = client.manage!;
  vi.spyOn(client, 'manage').mockImplementation(async (command) =>
    command.operation === 'run'
      ? { kind: 'operation', operationId: command.operationId, phase: 'failed' }
      : original(command),
  );
  const prefs = preferences();
  render(
    <CloudBotAuthorization deviceId="cloud-test-device"
      client={client}
      online
      active
      name="Cloud"
      trial
      notificationPreferences={prefs}
    />,
  );
  const section = await panel('wecom');
  fireEvent.change(within(section).getByLabelText('settings.notifications.wecomGroupLabel'), {
    target: { value: 'https://example.invalid/hook' },
  });
  fireEvent.click(
    await within(section).findByRole('button', {
      name: 'settings.notifications.wecomGroupSaveAndTest',
    }),
  );
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('settings.notifications.wecomGroupSaveFailed'),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(prefs.refresh).not.toHaveBeenCalled();
  // Like the local input, the typed URL survives the failure (and the card's remount
  // on the reloaded list) so it can be corrected and retried.
  const typed = within(section).getByLabelText('settings.notifications.wecomGroupLabel');
  await waitFor(() =>
    expect(live('wecom').getByLabelText('settings.notifications.wecomGroupLabel')).not.toBe(typed),
  );
  expect(
    (live('wecom').getByLabelText('settings.notifications.wecomGroupLabel') as HTMLInputElement)
      .value,
  ).toBe('https://example.invalid/hook');
  // Closing the editor drops it, as leaving the local section does.
  fireEvent.click(screen.getByText('settings.wecomBot.title'));
  fireEvent.click(screen.getByText('settings.wecomBot.title'));
  expect(
    (
      (await waitFor(() =>
        live('wecom').getByLabelText('settings.notifications.wecomGroupLabel'),
      )) as HTMLInputElement
    ).value,
  ).toBe('');
});

// The URL is stored by the target instance, not on this computer.
it('names the target instance in the WeCom webhook hint', async () => {
  render(
    <CloudBotAuthorization deviceId="cloud-test-device"
      client={createTrialCloudSettingsClient()}
      online
      active
      name="Studio"
      trial
    />,
  );
  const section = await panel('wecom');
  expect(within(section).getByText('cloudSettings.wecomGroupHint:Studio')).toBeTruthy();
  expect(within(section).queryByText('settings.notifications.wecomGroupHint')).toBeNull();
});
