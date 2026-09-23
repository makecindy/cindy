// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { RemoteBot } from '../remoteBotRoster';
import { parseRemoteBotSettings } from '../remoteBotSettingsResource';

const h = vi.hoisted(() => ({
  t: (key: string) => key,
  invoke: vi.fn(),
  confirm: vi.fn(),
  model: vi.fn(),
}));
vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({ t: h.t, i18n: { language: 'en' } }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('../BotPortraitPicker', () => ({ BotPortraitPicker: () => null }));
vi.mock('../BotModelChainEditor', () => ({
  BotModelChainEditor: (props: unknown) => {
    h.model(props);
    return <div>host-models</div>;
  },
}));
import { RemoteBotSettings } from '../RemoteBotSettings';

const ref = { collectionId: 'teammates', kind: 'bot', id: 'writer' };
const bot = {
  id: 'writer',
  deviceId: 'office',
  deviceName: 'Office',
  name: 'Writer',
  online: true,
} as RemoteBot;
const fixture = () => ({
  ref,
  revision: 'v1',
  display: { title: 'Writer' },
  blocks: [
    {
      id: 'profile',
      primitive: 'form',
      title: 'Profile',
      fallbackMarkdown: 'Profile',
      data: { actionId: 'grant-1', values: { name: 'Writer', identity: 'Original personality' } },
    },
    {
      id: 'models',
      primitive: 'form',
      title: 'Models',
      fallbackMarkdown: 'Models',
      data: {
        actionId: 'grant-2',
        values: {
          followsDefault: false,
          modelChain: JSON.stringify([
            {
              harness: 'pi',
              model: 'host-model',
              providerId: 'host-provider',
              effort: '',
              fastMode: false,
            },
          ]),
        },
      },
    },
  ],
  actions: [
    {
      id: 'grant-1',
      label: 'Profile',
      fields: [
        { id: 'name', kind: 'text', label: 'Name', required: true },
        { id: 'identity', kind: 'multiline', label: 'Personality' },
      ],
    },
    {
      id: 'grant-2',
      label: 'Models',
      fields: [
        { id: 'followsDefault', kind: 'toggle', label: 'Follow default' },
        { id: 'modelChain', kind: 'multiline', label: 'Model chain' },
      ],
    },
  ],
});
let host = fixture();
beforeEach(() => {
  setDataOwnerGeneration('owner');
  host = fixture();
  h.confirm.mockReset().mockResolvedValue(true);
  h.model.mockClear();
  h.invoke.mockReset().mockImplementation(async (_device, channel, args) => {
    if (channel === REMOTE_RESOURCE_GET_CHANNEL) return structuredClone(host);
    if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL) {
      Object.assign(host.blocks[0].data.values, args[0].input);
      host.revision = 'v2';
      return { effects: [] };
    }
    throw new Error('Unexpected channel');
  });
  window.electronAPI = {
    deviceLink: { invoke: h.invoke, onRemotePush: () => () => undefined },
  } as unknown as Window['electronAPI'];
});
afterEach(cleanup);
function setup() {
  const beforeCloseRef = { current: null as (() => Promise<boolean>) | null };
  const onBack = vi.fn();
  const view = render(
    <RemoteBotSettings bot={bot} beforeCloseRef={beforeCloseRef} onBack={onBack} />,
  );
  return { ...view, beforeCloseRef, onBack };
}
async function edit() {
  fireEvent.click(await screen.findByRole('button', { name: 'Profile' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New name' } });
}

it('reads from the selected host and submits only changed fields with its opaque grant', async () => {
  setup();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
  await screen.findByText('bots.autosave.saved');
  expect(h.invoke).toHaveBeenCalledWith('office', REMOTE_RESOURCE_INVOKE_CHANNEL, [
    expect.objectContaining({
      collectionId: 'teammates',
      resourceRef: ref,
      actionId: 'grant-1',
      input: { name: 'New name' },
    }),
  ]);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New name');
  expect(h.invoke.mock.calls.every((call) => call[0] === 'office')).toBe(true);
});

it('blocks close and duplicate saves while a write is pending', async () => {
  let finish!: () => void;
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((device, channel, args) =>
    channel === REMOTE_RESOURCE_INVOKE_CHANNEL
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : original(device, channel, args),
  );
  const view = setup();
  await edit();
  const save = screen.getByRole('button', { name: 'bots.save' });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(await view.beforeCloseRef.current!()).toBe(false);
  expect(
    h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
  ).toHaveLength(1);
  await act(async () => finish());
});

it('retains a failed draft and requires a deliberate reload instead of replaying writes', async () => {
  const original = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((device, channel, args) =>
    channel === REMOTE_RESOURCE_INVOKE_CHANNEL
      ? Promise.reject(new Error('timeout'))
      : original(device, channel, args),
  );
  setup();
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
  await screen.findByText('bots.remote.settings.refreshRequired');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New name');
  fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
  expect(
    h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
  ).toHaveLength(1);
  host.blocks[0].data.values.name = 'Changed on host';
  h.confirm.mockResolvedValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'bots.remote.settings.reload' }));
  await waitFor(() => expect(h.confirm).toHaveBeenCalled());
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New name');
});

it('keeps unsaved values through disconnect/reconnect and refuses stale saves', async () => {
  const view = setup();
  await edit();
  view.rerender(
    <RemoteBotSettings
      bot={{ ...bot, online: false }}
      beforeCloseRef={view.beforeCloseRef}
      onBack={view.onBack}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
  view.rerender(
    <RemoteBotSettings bot={bot} beforeCloseRef={view.beforeCloseRef} onBack={view.onBack} />,
  );
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New name');
  expect(
    h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
  ).toHaveLength(0);
});

it('rejects a save when the owner changes while a drawer remains mounted', async () => {
  setup();
  await edit();
  setDataOwnerGeneration('other-owner');
  fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
  expect(
    h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
  ).toHaveLength(0);
});

it('uses the host model directory and supports old hosts without editable resources', async () => {
  const view = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Models' }));
  expect(h.model).toHaveBeenLastCalledWith(
    expect.objectContaining({
      deviceId: 'office',
      value: [expect.objectContaining({ model: 'host-model', providerId: 'host-provider' })],
    }),
  );
  view.unmount();
  host.blocks = [];
  host.actions = [];
  setup();
  await screen.findByText('bots.remote.settings.unavailable');
});

it('does not turn malformed or unknown fields into editable partial forms', () => {
  const raw = fixture();
  delete (raw.blocks[0].data.values as Record<string, unknown>).identity;
  expect(parseRemoteBotSettings(raw, ref).panels[0].action).toBeUndefined();
  expect(() => parseRemoteBotSettings(raw, { ...ref, id: 'other-bot' })).toThrow();
  const unknown = fixture();
  unknown.actions[0].fields[0].kind = 'future-control';
  expect(parseRemoteBotSettings(unknown, ref).panels[0].action).toBeUndefined();
});

it.each([false, true])(
  'reconciles an ambiguous write without replay (host saved: %s)',
  async (savedOnHost) => {
    const original = h.invoke.getMockImplementation()!;
    h.invoke.mockImplementation(async (device, channel, args) => {
      if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL) {
        if (savedOnHost) await original(device, channel, args);
        throw new Error('ACK lost');
      }
      return original(device, channel, args);
    });
    setup();
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'bots.save' }));
    await screen.findByText('bots.remote.settings.refreshRequired');
    fireEvent.click(screen.getByRole('button', { name: 'bots.remote.settings.reload' }));
    await waitFor(() =>
      expect(screen.queryByText('bots.remote.settings.refreshRequired')).toBeNull(),
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New name');
    expect(h.confirm).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'bots.save' }) as HTMLButtonElement).disabled).toBe(
      savedOnHost,
    );
    expect(
      h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
    ).toHaveLength(1);
  },
);

it('ignores a late settings read after changing accounts', async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  setup();
  setDataOwnerGeneration('another-owner');
  await act(async () => finish(fixture()));
  expect(screen.queryByRole('button', { name: 'Profile' })).toBeNull();
});
