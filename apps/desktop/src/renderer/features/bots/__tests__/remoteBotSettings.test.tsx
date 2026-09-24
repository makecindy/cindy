// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } from '@cindy/device-link';
import { RemoteBotSettings } from '../RemoteBotSettings';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  model: null as any,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('../BotPortraitPicker', () => ({ BotPortraitPicker: () => null }));
vi.mock('../BotModelChainEditor', () => ({
  BotModelChainEditor: (p: any) => {
    h.model = p;
    return (
      <button
        type="button"
        onClick={() =>
          p.onChange([
            {
              harness: 'codex',
              model: 'gpt-6',
              providerId: 'openai:remote-account',
              effort: 'high',
              fastMode: true,
            },
          ])
        }
      >
        Choose account
      </button>
    );
  },
}));
const bot = {
  id: 'bot',
  deviceId: 'host',
  deviceName: 'Remote Mac',
  name: 'Cindy',
  avatar: '',
  avatarColor: '',
  description: '',
  preview: '',
  activityAt: 0,
  sessionId: 'session',
  online: true,
};
const chain = [{ harness: 'pi', model: 'saved', providerId: 'xd', effort: '', fastMode: false }];
const resource = (
  revision = '1',
  grant = 'grant',
  values = { modelChain: JSON.stringify(chain), followsDefault: false },
) => ({
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' },
  revision,
  display: { title: 'Cindy' },
  links: [],
  actions: [
    {
      id: grant,
      label: 'Models',
      fields: [
        { id: 'modelChain', label: 'Models', kind: 'multiline' },
        { id: 'followsDefault', label: 'Follow default', kind: 'toggle' },
      ],
    },
  ],
  blocks: [
    {
      id: 'models',
      title: 'Models',
      primitive: 'form',
      fallbackMarkdown: '',
      data: { actionId: grant, values },
    },
  ],
});
let close: { current: (() => Promise<boolean>) | null };
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  close = { current: null };
  h.invoke.mockImplementation(async (_device: string, channel: string) =>
    channel === REMOTE_RESOURCE_GET_CHANNEL ? resource() : { effects: [] },
  );
  Object.assign(window, {
    electronAPI: { deviceLink: { invoke: h.invoke, onRemotePush: () => () => {} } },
  });
});
afterEach(cleanup);
async function open() {
  const view = render(<RemoteBotSettings bot={bot} beforeCloseRef={close} onDeleted={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Models' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Models' }));
  await waitFor(() => expect(screen.getByText('Choose account')).toBeTruthy());
  return view;
}
it('saves the complete model route on the selected host using a renewed opaque action', async () => {
  await open();
  expect(h.model.deviceId).toBe('host');
  fireEvent.click(screen.getByText('Choose account'));
  h.invoke.mockImplementation(async (_: string, channel: string) =>
    channel === REMOTE_RESOURCE_GET_CHANNEL ? resource('1', 'fresh-grant') : { effects: [] },
  );
  fireEvent.click(screen.getByText('bots.save'));
  await waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith('host', REMOTE_RESOURCE_INVOKE_CHANNEL, [
      expect.objectContaining({
        actionId: 'fresh-grant',
        resourceRef: resource().ref,
        input: {
          modelChain: JSON.stringify([
            {
              harness: 'codex',
              model: 'gpt-6',
              providerId: 'openai:remote-account',
              effort: 'high',
              fastMode: true,
            },
          ]),
        },
      }),
    ]),
  );
});
it('preserves a dirty model draft and blocks closing when the save fails', async () => {
  await open();
  fireEvent.click(screen.getByText('Choose account'));
  h.invoke.mockImplementation(async (_: string, channel: string) => {
    if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL) throw new Error('offline');
    return resource();
  });
  let result: unknown;
  await act(async () => {
    result = await close.current?.();
  });
  expect(result).toBe(false);
  expect(h.model.value[0].providerId).toBe('openai:remote-account');
  expect(screen.getByRole('alert').textContent).toContain('saveFailed');
});
it('retains the selected account across a disconnect and does not send an offline save', async () => {
  const view = await open();
  fireEvent.click(screen.getByText('Choose account'));
  view.rerender(
    <RemoteBotSettings
      bot={{ ...bot, online: false }}
      beforeCloseRef={close}
      onDeleted={vi.fn()}
    />,
  );
  let result: unknown;
  await act(async () => {
    result = await close.current?.();
  });
  expect(result).toBe(false);
  expect(h.model.value[0].providerId).toBe('openai:remote-account');
  expect(h.model.disabled).toBe(true);
  expect(h.invoke.mock.calls.some((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL)).toBe(
    false,
  );
});
it('does not renew a changed remote revision into authority to overwrite it', async () => {
  await open();
  fireEvent.click(screen.getByText('Choose account'));
  h.invoke.mockResolvedValue(resource('2'));
  fireEvent.click(screen.getByText('bots.save'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('conflict'));
  expect(h.invoke.mock.calls.some((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL)).toBe(
    false,
  );
  expect(h.model.value[0].providerId).toBe('openai:remote-account');
});
it('never falls back to local settings on an old host', async () => {
  h.invoke.mockResolvedValue({ ...resource(), actions: [], blocks: [] });
  render(<RemoteBotSettings bot={bot} beforeCloseRef={close} onDeleted={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('bots.remoteSettings.unsupported')).toBeTruthy());
  expect(screen.queryByText('Choose account')).toBeNull();
});
it('stops a pending save after an account switch', async () => {
  await open();
  fireEvent.click(screen.getByText('Choose account'));
  let resolve!: (value: unknown) => void;
  h.invoke.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  fireEvent.click(screen.getByText('bots.save'));
  setDataOwnerGeneration('another-owner');
  await act(async () => resolve(resource()));
  expect(h.invoke.mock.calls.some((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL)).toBe(
    false,
  );
});
it('does not treat a refresh failure after a save receipt as an unsaved draft', async () => {
  await open();
  fireEvent.click(screen.getByText('Choose account'));
  h.invoke
    .mockResolvedValueOnce(resource())
    .mockResolvedValueOnce({ effects: [] })
    .mockRejectedValueOnce(new Error('read failed'));
  let result: unknown;
  await act(async () => {
    result = await close.current?.();
  });
  expect(result).toBe(true);
  await act(async () => {
    result = await close.current?.();
  });
  expect(result).toBe(true);
  expect(
    h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
  ).toHaveLength(1);
});
