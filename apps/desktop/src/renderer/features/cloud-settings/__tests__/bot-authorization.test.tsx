// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudBotAuthorization } from '../CloudBotAuthorization';
import { createTrialCloudSettingsClient } from '../trialClient';
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
const confirms = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => confirms,
}));
beforeEach(() => {
  confirms.confirm.mockClear().mockResolvedValue(true);
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
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
describe('cloud IM authorization', () => {
  it.each(['Slack', 'Telegram', 'X'])(
    'connects and cancels %s with cloud tickets and no local API',
    async (label) => {
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
      const client = createTrialCloudSettingsClient(),
        manage = vi.spyOn(client, 'manage');
      const props = { client, online: true, active: true, name: 'Cloud', trial: true };
      const view = render(<CloudBotAuthorization deviceId="cloud-test-device" {...props} />);
      const toggle = await screen.findByRole('switch', { name: label });
      fireEvent.click(toggle);
      const complete = await screen.findByRole('button', {
        name: 'cloudSettings.authTrialComplete',
      });
      fireEvent.click(complete);
      await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
      expect(manage.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1);
      expect(manage.mock.calls[0][0]).toMatchObject({ section: 'bots' });
      view.rerender(<CloudBotAuthorization deviceId="cloud-test-device" {...props} online={false} />);
      expect(toggle.matches(':disabled')).toBe(true);
    },
  );
});

// Unit/jsdom: official cards used the instance name as description and plain colored
// text as status; they must show the local channel copy and the local status badge.
it('shows official channels with the local description and status badge', async () => {
  const client = createTrialCloudSettingsClient();
  render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" trial />);
  for (const [label, description] of [
    ['Slack', 'settings.remoteControl.hook.slackDescription'],
    ['Telegram', 'settings.remoteControl.hook.telegram.description'],
    ['X', 'settings.remoteControl.hook.x.description'],
  ]) {
    const card = (await screen.findByRole('switch', { name: label })).closest('section')!;
    expect(within(card).getByText(description)).toBeTruthy();
    expect(within(card).queryByText('Cloud')).toBeNull();
    expect(within(card).getByRole('status').textContent).toBe('cloudSettings.authDisconnected');
  }
});

// Regression: the native panel must not hide disconnected credential-based bots.
// Beyond fieldless OAuth, a connect ticket with required fields
// must remain visible and submit once through the scoped bridge (unit/jsdom).
it.each([
  ['wecom', { botId: 'test-bot', secret: 'synthetic-secret' }, 'connect'],
  ['feishu', { appId: 'test-app', appSecret: 'synthetic-secret' }, 'bind'],
  ['dingtalk', { appKey: 'test-app', appSecret: 'synthetic-secret' }, 'connect'],
  ['discord', { token: 'synthetic-token', ownerUserId: '123456789012345678' }, 'connect'],
  [
    'telegram',
    { token: '12345:synthetic_token_not_a_real_credential', ownerUserId: '12345' },
    'connect',
  ],
] as const)(
  'uses the native %s form and only the selected cloud ticket',
  async (channel, values, actionLabel) => {
    const client = createTrialCloudSettingsClient();
    const original = client.manage!;
    let submitted: { values?: unknown } | undefined;
    const manage = vi.spyOn(client, 'manage').mockImplementation(async (command) => {
      if (command.operation === 'run') submitted = structuredClone(command);
      return original(command);
    });
    const view = render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" trial />);
    for (const id of ['wechat', 'wecom', 'feishu', 'dingtalk', 'discord', 'telegram']) {
      expect(await screen.findByText(`settings.${id}Bot.title`)).toBeTruthy();
      expect(screen.getByText(`settings.${id}Bot.description`)).toBeTruthy();
    }
    fireEvent.click(screen.getByText(`settings.${channel}Bot.title`));
    const panel = document.getElementById(`cloud-personal-im-${channel}-panel`)!;
    for (const [key, value] of Object.entries(values)) {
      const input = within(panel).getByLabelText(`settings.${channel}Bot.${key}Label`);
      if (['token', 'secret', 'appSecret'].includes(key))
        expect(input.getAttribute('type')).toBe('password');
      fireEvent.change(input, { target: { value } });
    }
    const connect = await within(panel).findByRole('button', {
      name: `settings.${channel}Bot.${actionLabel}`,
    });
    expect(connect.matches(':disabled')).toBe(false);
    fireEvent.click(connect);
    await waitFor(() =>
      expect(manage.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1),
    );
    expect(submitted?.values).toEqual(
      channel === 'feishu' ? { ...values, service: 'feishu' } : values,
    );
    await screen.findByText('cloudSettings.imConnectionDetailsUnavailable');
    expect(screen.queryByLabelText(`settings.${channel}Bot.tokenLabel`)).toBeNull();
    view.rerender(
      <CloudBotAuthorization deviceId="cloud-test-device" client={client} online={false} active name="Cloud" trial />,
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
  },
);

// Unit/jsdom: WeChat must share the local confirmation/waiting/bound UI, not a generic switch.
// No cloud-only switch may skip the native flow, and no local controller may run.
it('uses native WeChat authorization and a single unbind confirmation', async () => {
  const client = createTrialCloudSettingsClient();
  const manage = vi.spyOn(client, 'manage');
  render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" trial />);
  fireEvent.click(await screen.findByText('settings.wechatBot.title'));
  expect(screen.queryByRole('switch', { name: 'settings.wechatBot.title' })).toBeNull();
  const authorize = await screen.findByRole('button', {
    name: 'settings.wechatBot.actions.connect',
  });
  confirms.confirm.mockResolvedValueOnce(false);
  fireEvent.click(authorize);
  await waitFor(() => expect(confirms.confirm).toHaveBeenCalledTimes(1));
  expect(manage.mock.calls.some(([c]) => c.operation === 'run')).toBe(false);
  fireEvent.click(authorize);
  await screen.findByText('settings.wechatBot.waiting.heading');
  fireEvent.click(await screen.findByRole('button', { name: 'cloudSettings.authTrialComplete' }));
  const unbind = await screen.findByRole('button', { name: 'settings.wechatBot.actions.unbind' });
  expect(confirms.confirm).toHaveBeenCalledTimes(2);
  fireEvent.click(unbind);
  await waitFor(() =>
    expect(manage.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(2),
  );
  expect(confirms.confirm).toHaveBeenCalledTimes(3);
});

// An uncertain remote result must stay recoverable without re-running the action: it is read
// back on its own (useSettleUnknown; there is no 「检查授权状态」 button).
it('reads an unknown credential operation back without a second submission', async () => {
  const client = createTrialCloudSettingsClient();
  const original = client.manage!;
  const manage = vi.spyOn(client, 'manage').mockImplementation(async (command) => {
    if (command.operation === 'run') throw Error('CONNECTION_LOST');
    return original(command);
  });
  render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" trial />);
  fireEvent.click(await screen.findByText('settings.wechatBot.title'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'settings.wechatBot.actions.connect' }),
  );
  // The first read-back runs 2 s after the lost answer (SETTLE_DELAYS_MS.authorization).
  await waitFor(
    () => expect(manage.mock.calls.some(([c]) => c.operation === 'status')).toBe(true),
    { timeout: 4_000 },
  );
  expect(manage.mock.calls.filter(([c]) => c.operation === 'run')).toHaveLength(1);
}, 10_000);

// Unit/jsdom: capabilities and identity details can be absent on an older Host.
// The shared card must remain honest and must not offer successful-looking no-op actions.
it('keeps a read-only remote connection visible without enabling unsupported actions', async () => {
  // An older Host: no IM channel (only that keeps the ticket cards; a failing channel
  // shows its failure instead), so its IM probe is refused.
  Object.assign(window, {
    electronAPI: new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'deviceLink')
            return {
              invoke: async () => {
                throw Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] not allowed');
              },
            };
          throw Error('LOCAL_API_FORBIDDEN');
        },
      },
    ),
  });
  const client = createTrialCloudSettingsClient();
  const manage = vi
    .spyOn(client, 'manage')
    .mockResolvedValue({
      kind: 'page',
      section: 'bots',
      offset: 0,
      items: [
        {
          id: 'bot:feishu',
          label: 'Feishu',
          group: 'management.personalBots',
          status: 'connected',
          actions: [],
        },
      ],
    });
  render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" />);
  fireEvent.click(await screen.findByText('settings.feishuBot.title'));
  const clear = await screen.findByRole('button', { name: 'settings.feishuBot.connected.clear' });
  expect(clear.matches(':disabled')).toBe(true);
  const reconnect = screen.getByRole('button', { name: 'settings.feishuBot.connected.reconnect' });
  expect(reconnect.matches(':disabled')).toBe(true);
  expect(screen.getByText('cloudSettings.imConnectionDetailsUnavailable')).toBeTruthy();
  fireEvent.click(clear);
  expect(manage.mock.calls.some(([c]) => c.operation === 'run')).toBe(false);
});

// Credentials must not survive leaving the native card (previous generic forms unmounted).
it('clears a credential draft when the channel card is collapsed', async () => {
  const client = createTrialCloudSettingsClient();
  render(<CloudBotAuthorization deviceId="cloud-test-device" client={client} online active name="Cloud" trial />);
  const card = await screen.findByText('settings.discordBot.title');
  fireEvent.click(card);
  const input = await screen.findByLabelText('settings.discordBot.tokenLabel');
  fireEvent.change(input, { target: { value: 'synthetic-draft' } });
  fireEvent.click(card);
  fireEvent.click(card);
  await waitFor(() =>
    expect(
      (screen.getByLabelText('settings.discordBot.tokenLabel') as HTMLInputElement).value,
    ).toBe(''),
  );
});

// The new controller must never save model or group settings to this computer or
// to an official hook. Mock only the heavy picker, keep the native view/controller.
// The props the controller passes to the target pickers that these tests inspect.
type PickerProps = { deviceId: string; onUnifiedSelect: (selection: Record<string, unknown>) => unknown };
const pickers = vi.hoisted(() => ({ model: null as PickerProps | null, permission: null as PickerProps | null }));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: PickerProps) => {
    pickers.model = props;
    return <span>Target model picker</span>;
  },
}));
vi.mock('@/components/new-chat/PermissionSelector', () => ({
  PermissionSelector: (props: PickerProps) => {
    pickers.permission = props;
    return <span>Target permission picker</span>;
  },
}));
import { CloudImSettings } from '../CloudImSettings';
it('saves an admitted target route, rejects a local-only route and resets only that channel', async () => {
  const client = createTrialCloudSettingsClient();
  const [state] = await client.read(['imFeishu']);
  const save = vi.fn(async (s, set, clear) => (await client.save(s, set, clear)).state);
  const props = { itemId: 'bot:feishu', deviceId: 'cloud-target', name: 'Cloud', disabled: false, save };
  const view = render(<CloudImSettings {...props} states={{ imFeishu: state }} />);
  expect(pickers.model!.deviceId).toBe('cloud-target');
  expect(pickers.permission!.deviceId).toBe('cloud-target');
  expect(
    pickers.model!.onUnifiedSelect({
      engine: 'cc',
      modelId: 'local-only',
      providerId: 'local',
      effort: 'high',
    }),
  ).toBe(false);
  expect(save).not.toHaveBeenCalled();
  await pickers.model!.onUnifiedSelect({
    engine: 'cc',
    modelId: 'fixture-model',
    providerId: 'fixture-provider',
    effort: 'low',
  });
  const [saved] = await client.read(['imFeishu']);
  expect(saved.value?.claudeCode).toEqual({
    modelId: 'fixture-model',
    providerId: 'fixture-provider',
    effort: 'low',
  });
  expect(save.mock.calls[0][1]).toEqual({
    agentKind: 'claude-code',
    claudeCode: saved.value?.claudeCode,
  });
  view.rerender(<CloudImSettings {...props} states={{ imFeishu: saved }} />);
  fireEvent.click(screen.getByRole('button', { name: 'settings.imBot.defaults.useAutomatic' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const [automatic] = await client.read(['imFeishu']);
  expect(automatic.value?.claudeCode).toEqual({ modelId: '', providerId: null, effort: 'high' });
  view.rerender(<CloudImSettings {...props} states={{ imFeishu: automatic }} />);
  fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
  expect(save.mock.calls[2][2]).toEqual(Object.keys(state.defaults!));
  expect((await client.read(['imFeishu']))[0].customizedKeys).toEqual([]);
});
it('keeps missing saved Telegram groups and never applies personal groups to official hooks', async () => {
  const client = createTrialCloudSettingsClient();
  const [state] = await client.read(['telegramGroups']);
  state.value = { always: ['-999'] };
  state.isCustomized = true;
  state.customizedKeys = ['always'];
  const save = vi.fn<(s: unknown, set: Record<string, unknown>) => Promise<typeof state>>(async () => state);
  const props = {
    deviceId: 'cloud-target',
    name: 'Cloud',
    states: { telegramGroups: state },
    section: 'telegram' as const,
    disabled: false,
    save,
  };
  const view = render(<CloudImSettings {...props} itemId="bot:official:telegram" />);
  expect(screen.queryByText('Cloud group')).toBeNull();
  view.rerender(<CloudImSettings {...props} itemId="bot:telegram" />);
  const group = screen.getByRole('radiogroup', {
    name: 'Cloud group · settings.telegramBot.groups.title',
  });
  fireEvent.click(
    within(group).getByRole('radio', { name: 'settings.telegramBot.groups.mode.always' }),
  );
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][1]).toEqual({ always: ['-999', '-100123'] });
  view.rerender(<CloudImSettings {...props} disabled itemId="bot:telegram" />);
  expect(
    within(group)
      .getByRole('radio', { name: 'settings.telegramBot.groups.mode.mention' })
      .matches(':disabled'),
  ).toBe(true);
});

// Unit/jsdom: real shared section must survive per-domain read errors and retry.
// Covers failed reads, not only ready snapshots; no local controller or credentials may be consulted.
it.each([
  ['wechat', 'imWechat'],
  ['wecom', 'imWecom'],
  ['feishu', 'imFeishu'],
  ['dingtalk', 'imDingtalk'],
  ['discord', 'imDiscord'],
  ['telegram', 'imTelegram'],
] as const)(
  'retains %s new-conversation settings through loading, failure and retry',
  async (channel, domain) => {
    const client = createTrialCloudSettingsClient();
    const [ready] = await client.read([domain]);
    const retry = vi.fn(),
      save = vi.fn();
    const props = {
      itemId: `bot:${channel}`,
      deviceId: 'cloud-target',
      name: 'Cloud',
      disabled: true,
      loading: true,
      retry,
      retryDisabled: true,
      save,
    };
    const view = render(<CloudImSettings {...props} states={{}} />);
    const section = screen.getByRole('region', { name: 'settings.imBot.defaults.title' });
    expect(within(section).getByRole('status').textContent).toContain(
      'settings.imBot.defaults.loading',
    );
    view.rerender(
      <CloudImSettings
        {...props}
        loading={false}
        retryDisabled={false}
        states={{
          [domain]: {
            domain,
            status: 'unreadable',
            revision: null,
            readErrorCode: 'SETTINGS_REQUEST_FAILED',
          },
        }}
      />,
    );
    // One line and 「重试」, as the client's settings read failure (CloudRequestError).
    expect(within(section).getByText('cloudSettings.imReadFailed')).toBeTruthy();
    expect(within(section).queryByText('Target model picker')).toBeNull();
    fireEvent.click(
      within(section).getByRole('button', { name: 'commonUi.retry' }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    view.rerender(<CloudImSettings {...props} states={{}} />);
    expect(within(section).getByRole('status')).toBeTruthy();
    view.rerender(
      <CloudImSettings {...props} loading={false} disabled={false} states={{ [domain]: ready }} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Target model picker')).toBeTruthy();
    expect(pickers.model!.deviceId).toBe('cloud-target');
    expect(save).not.toHaveBeenCalled();
  },
);
