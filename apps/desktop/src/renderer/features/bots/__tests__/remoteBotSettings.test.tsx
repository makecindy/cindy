// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
} from '@cindy/device-link';
import { RemoteBotSettings } from '../RemoteBotSettings';
import { parseRemoteMediaUrl } from '../../../../shared/remoteMediaUrl';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  model: null as any,
  portrait: null as any,
  realPortrait: false,
  push: null as any,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
vi.mock('../BotPortraitPicker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../BotPortraitPicker')>();
  return {
    BotPortraitPicker: (p: any) => {
      h.portrait = p;
      if (h.realPortrait) return <actual.BotPortraitPicker {...p} />;
      return (
        <>
          {p.value ? <img data-testid="portrait-preview" src={p.value} alt="" /> : p.fallback}
          <button type="button" onClick={() => p.onChange('data:image/png;base64,cG5n')}>
            Choose portrait
          </button>
        </>
      );
    },
  };
});
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
  h.realPortrait = false;
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
    electronAPI: {
      deviceLink: {
        invoke: h.invoke,
        onRemotePush: (cb: any) => {
          h.push = cb;
          return () => {
            h.push = null;
          };
        },
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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

it.each(['save', 'back'])(
  'recovers the saved revision before further edits after %s and a failed refresh',
  async (trigger) => {
    await open();
    fireEvent.click(screen.getByText('Choose account'));
    const savedChain = h.model.value;
    const nextChain = [{ ...savedChain[0], effort: 'low' }];
    h.invoke
      .mockResolvedValueOnce(resource())
      .mockResolvedValueOnce({ effects: [] })
      .mockRejectedValueOnce(new Error('post-save read failed'));
    fireEvent.click(screen.getByText(trigger === 'save' ? 'bots.save' : 'bots.settingsBack'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('loadFailed'));
    await waitFor(() =>
      expect((screen.getByText('bots.memory.useLatest') as HTMLButtonElement).disabled).toBe(false),
    );
    if (trigger === 'save') {
      expect(h.model.disabled).toBe(true);
      // Even a callback from portaled picker content cannot create an unsavable draft.
      act(() => h.model.onChange(nextChain));
      expect(h.model.value).toEqual(savedChain);
      expect((screen.getByText('bots.save') as HTMLButtonElement).disabled).toBe(true);
    } else {
      expect((screen.getByRole('button', { name: 'Models' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    expect(await close.current?.()).toBe(true);
    h.invoke.mockRejectedValueOnce(new Error('retry still unavailable'));
    fireEvent.click(screen.getByText('bots.memory.useLatest'));
    await waitFor(() =>
      expect((screen.getByText('bots.memory.useLatest') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole('alert').textContent).toContain('loadFailed');
    expect(h.confirm).not.toHaveBeenCalled();

    let host = resource('2', 'revision-2-grant', {
      modelChain: JSON.stringify(savedChain),
      followsDefault: false,
    });
    h.invoke.mockImplementation(async (_: string, channel: string) => {
      if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL) {
        host = resource('3', 'revision-3-grant', {
          modelChain: JSON.stringify(nextChain),
          followsDefault: false,
        });
        return { effects: [] };
      }
      return host;
    });
    fireEvent.click(screen.getByText('bots.memory.useLatest'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    if (trigger === 'back') fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    await waitFor(() => expect(h.model.disabled).toBe(false));
    act(() => h.model.onChange(nextChain));
    fireEvent.click(screen.getByText('bots.save'));
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith('host', REMOTE_RESOURCE_INVOKE_CHANNEL, [
        expect.objectContaining({
          actionId: 'revision-2-grant',
          input: { modelChain: JSON.stringify(nextChain) },
        }),
      ]),
    );
    await waitFor(() =>
      expect((screen.getByText('bots.save') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(
      h.invoke.mock.calls.filter((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL),
    ).toHaveLength(2);
  },
);

function push(id = 'bot', collectionId = 'teammates', deviceId = 'host') {
  h.push({
    deviceId,
    channel: REMOTE_RESOURCE_CHANGED_CHANNEL,
    payload: { collectionId, resourceRefs: [{ collectionId, kind: 'bot', id }] },
  });
}
async function openAvatar(
  decode: () => Promise<void> = () => Promise.resolve(),
  avatarValue = `cindy-media://blobs/${'a'.repeat(64)}.png`,
  avatarKind = 'media',
) {
  const avatar = {
    ...resource(),
    display: {
      title: 'Avatar',
      avatar: {
        kind: avatarKind,
        value: avatarValue,
        fallbackText: 'C',
      },
    },
    actions: [
      {
        id: 'avatar-grant',
        label: 'Avatar',
        fields: [{ id: 'avatarImageBase64', label: 'Avatar', kind: 'text' }],
      },
    ],
    blocks: [
      {
        id: 'avatar',
        title: 'Avatar',
        primitive: 'form',
        fallbackMarkdown: '',
        data: { actionId: 'avatar-grant', values: { avatarImageBase64: '' } },
      },
    ],
  };
  h.invoke.mockImplementation(async (_: string, channel: string) =>
    channel === REMOTE_RESOURCE_GET_CHANNEL ? avatar : { effects: [] },
  );
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode() {
        return decode();
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/jpeg;base64,/9j/2Q==',
  );
  render(<RemoteBotSettings bot={bot} beforeCloseRef={close} onDeleted={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Avatar' }));
  if (h.realPortrait) await screen.findByRole('button', { name: 'bots.profile.changeAvatar' });
  else await screen.findByText('Choose portrait');
  return avatar;
}
it('submits raw JPEG base64 while preserving the portrait preview data URL', async () => {
  await openAvatar();
  fireEvent.click(await screen.findByText('Choose portrait'));
  await waitFor(() => expect(h.portrait.value).toBe('data:image/jpeg;base64,/9j/2Q=='));
  fireEvent.click(screen.getByText('bots.save'));
  await waitFor(() =>
    expect(h.invoke).toHaveBeenCalledWith('host', REMOTE_RESOURCE_INVOKE_CHANNEL, [
      expect.objectContaining({ input: { avatarImageBase64: '/9j/2Q==' } }),
    ]),
  );
});
it('ignores other devices, collections and teammates but refreshes a current child resource', async () => {
  await open();
  h.invoke.mockClear();
  await act(async () => {
    push('another');
    push('bot-extra');
    push('bot', 'plugins');
    push('bot', 'teammates', 'another-host');
  });
  expect(h.invoke).not.toHaveBeenCalled();
  await act(async () => push('bot/skills'));
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it('coalesces push bursts into one active read and one trailing read on a slow host', async () => {
  await open();
  h.invoke.mockClear();
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => push());
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    for (let i = 0; i < 40; i++) push();
  });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await act(async () => finish(resource()));
  expect(h.invoke).toHaveBeenCalledTimes(2);
});
it('cancels a queued trailing read when the settings unmount', async () => {
  const view = await open();
  h.invoke.mockClear();
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => push());
  await act(async () => push());
  view.unmount();
  await act(async () => finish(resource()));
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it('blocks returning and closing immediately while a selected portrait is decoding, then saves it', async () => {
  let finish!: () => void;
  await openAvatar(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let canClose: unknown;
  await act(async () => {
    h.portrait.onChange('data:image/png;base64,cG5n');
    // Call before React commits state so the synchronous guard is exercised too.
    canClose = await close.current?.();
  });
  expect(canClose).toBe(false);
  expect(h.portrait.disabled).toBe(true);
  const back = screen.getByRole('button', { name: 'bots.settingsBack' });
  expect((back as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(back);
  expect(screen.getByText('Choose portrait')).toBeTruthy();
  expect(h.invoke.mock.calls.some((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL)).toBe(
    false,
  );
  await act(async () => finish());
  expect(h.portrait.disabled).toBe(false);
  await act(async () => {
    canClose = await close.current?.();
  });
  expect(canClose).toBe(true);
  expect(h.invoke).toHaveBeenCalledWith('host', REMOTE_RESOURCE_INVOKE_CHANNEL, [
    expect.objectContaining({ input: { avatarImageBase64: '/9j/2Q==' } }),
  ]);
});
it('reports failed portrait conversion and releases the navigation guard without writing an avatar', async () => {
  let fail!: (error: Error) => void;
  await openAvatar(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  fireEvent.click(screen.getByText('Choose portrait'));
  expect(await close.current?.()).toBe(false);
  await act(async () => fail(new Error('decode failed')));
  expect(screen.getByRole('alert').textContent).toContain('saveFailed');
  expect(h.portrait.disabled).toBe(false);
  expect(await close.current?.()).toBe(true);
  expect(h.invoke.mock.calls.some((call) => call[1] === REMOTE_RESOURCE_INVOKE_CHANNEL)).toBe(
    false,
  );
});

it('previews the host avatar on open and after saving an empty avatar form', async () => {
  const avatar = await openAvatar();
  expect(parseRemoteMediaUrl(h.portrait.value)).toEqual({
    origin: { kind: 'device', deviceId: 'host' },
    origUrl: avatar.display.avatar.value,
  });
  fireEvent.click(screen.getByText('Choose portrait'));
  await waitFor(() => expect(h.portrait.value).toBe('data:image/jpeg;base64,/9j/2Q=='));
  const savedUrl = `cindy-media://blobs/${'b'.repeat(64)}.jpeg`;
  h.invoke.mockImplementation(async (_: string, channel: string) => {
    if (channel === REMOTE_RESOURCE_INVOKE_CHANNEL) {
      avatar.display.avatar.value = savedUrl;
      return { effects: [] };
    }
    return avatar;
  });
  fireEvent.click(screen.getByText('bots.save'));
  await waitFor(() =>
    expect(parseRemoteMediaUrl(h.portrait.value)).toEqual({
      origin: { kind: 'device', deviceId: 'host' },
      origUrl: savedUrl,
    }),
  );
  expect(avatar.blocks[0].data.values.avatarImageBase64).toBe('');
});
it.each([
  'file:///private/avatar.png',
  'https://example.com/avatar.png',
  'cindy-media://blobs/invalid.png',
])('does not load an untrusted host avatar URL: %s', async (value) => {
  const avatar = await openAvatar();
  avatar.display.avatar.value = value;
  await act(async () => push());
  expect(h.portrait.value).toBeUndefined();
  expect(h.portrait.fallback).toBeUndefined();
});

it.each([
  { value: 'cindy://avatar/preset/cindy', kind: 'media', image: 'cindy.png' },
  { value: 'cindy://avatar/preset/dash', kind: 'asset', image: 'dash.png' },
  { value: '🤖', kind: 'media', image: null },
  { value: '👩🏽‍💻', kind: 'emoji', image: null },
])(
  'renders a supported host avatar regardless of legacy media labeling: $value/$kind',
  async ({ value, kind, image }) => {
    await openAvatar(undefined, value, kind);
    if (image) expect(document.querySelector('img')?.getAttribute('src')).toContain(image);
    else expect(screen.getByText(value)).toBeTruthy();
    expect(h.portrait.value).toBeUndefined();
    fireEvent.click(screen.getByText('Choose portrait'));
    await waitFor(() =>
      expect(screen.getByTestId('portrait-preview').getAttribute('src')).toBe(
        'data:image/jpeg;base64,/9j/2Q==',
      ),
    );
    fireEvent.click(screen.getByText('bots.save'));
    await waitFor(() => expect(screen.queryByTestId('portrait-preview')).toBeNull());
    if (image) expect(document.querySelector('img')?.getAttribute('src')).toContain(image);
    else expect(screen.getByText(value)).toBeTruthy();
  },
);

it.each(['gallery', 'file'])(
  'guards navigation through real picker %s preparation and conversion',
  async (source) => {
    h.realPortrait = true;
    const decodes: Array<() => void> = [];
    await openAvatar(() => new Promise<void>((resolve) => decodes.push(resolve)));
    let reader: { result: string; onload: () => void };
    vi.stubGlobal(
      'FileReader',
      class {
        result = 'data:image/png;base64,cG5n';
        onload = () => {};
        readAsDataURL() {
          reader = this;
        }
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'bots.profile.changeAvatar' }));
    let canClose: unknown;
    await act(async () => {
      if (source === 'gallery') fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
      else
        fireEvent.change(document.querySelector('input[type="file"]')!, {
          target: { files: [new File(['image'], 'avatar.png', { type: 'image/png' })] },
        });
      canClose = await close.current?.();
    });
    expect(canClose).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'bots.settingsBack' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(h.portrait.disabled).toBe(true);
    await act(async () => {
      if (source === 'gallery') decodes.shift()!();
      else reader!.onload();
    });
    // Picker preprocessing has finished; the subsequent JPEG conversion still owns the guard.
    expect(decodes).toHaveLength(1);
    expect(await close.current?.()).toBe(false);
    expect(h.portrait.disabled).toBe(true);
    await act(async () => decodes.shift()!());
    expect(h.portrait.disabled).toBe(false);
    await act(async () => {
      canClose = await close.current?.();
    });
    expect(canClose).toBe(true);
    expect(h.invoke).toHaveBeenCalledWith('host', REMOTE_RESOURCE_INVOKE_CHANNEL, [
      expect.objectContaining({ input: { avatarImageBase64: '/9j/2Q==' } }),
    ]);
  },
);
