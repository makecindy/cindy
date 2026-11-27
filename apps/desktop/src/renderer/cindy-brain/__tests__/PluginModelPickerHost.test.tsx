// @vitest-environment jsdom
/** Test value: mounts the real Host and shared confirmation dialog. Existing picker tests do not
 * cover the plugin IPC round trip. Minimal inputs: choose/confirm, cancel, rejected source,
 * Host dismissal and a remote view. Protects plugin-security §3 and DESIGN §4; tier: unit.
 * Standalone wall time: 2.18s (2026-10-28). */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { PluginModelPickerHost } from '../PluginModelPickerHost';
import type { PluginModelPickerPresentation } from '../../../shared/pluginModelPicker';
import zh from '../../i18n/locales/zh-CN/common.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => {
      const value = key
        .split('.')
        .reduce<unknown>((v, part) => (v as Record<string, unknown>)?.[part], zh);
      return typeof value === 'string' ? value.replace('{{name}}', options?.name ?? '') : key;
    },
  }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({ useModelPickerAgents: () => ['codex'] }));
vi.mock('@/components/new-chat/ModelRouteSelector', () => ({
  ModelRouteSelectorContent: (
    props: ComponentProps<
      typeof import('@/components/new-chat/ModelSelector').ModelSelectorContent
    >,
  ) => (
    <button
      onClick={() =>
        props.onUnifiedSelect?.({
          agentDevice: selectedLocation ? { deviceId: selectedLocation, name: 'Shared' } : null,
          providerId: 'chosen-provider',
          modelId: 'chosen-model',
          engine: 'codex',
          effort: 'high',
          fast: 'ultrafast',
          favoriteUid: null,
        })
      }
    >
      Choose model
    </button>
  ),
}));
let selectedLocation: string | undefined;
let push: (request: PluginModelPickerPresentation) => void;
let dismiss: (request: { requestId: string }) => void;
const resolve = vi.fn(),
  remote = vi.fn();
const request = {
  requestId: 'request',
  ghostId: 'example',
  ghostName: '示例插件',
  expiresAt: Date.now() + 90_000,
};
let guest: HTMLElement;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  guest = document.createElement('webview');
  Object.assign(guest, {
    getWebContentsId: () => 42,
    getBoundingClientRect: () => new DOMRect(100, 50, 800, 600),
  });
  document.body.appendChild(guest);
  selectedLocation = undefined;
  resolve.mockReset().mockResolvedValue({ handled: true, accepted: true });
  remote.mockReset().mockResolvedValue({ handled: true, accepted: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      ghosts: {
        onModelPickerRequest: (cb: typeof push) => {
          push = cb;
          return () => {};
        },
        onModelPickerDismissed: (cb: typeof dismiss) => {
          dismiss = cb;
          return () => {};
        },
        resolveModelPicker: resolve,
        answerRemoteModelPicker: remote,
      },
    },
  });
});
afterEach(() => { cleanup(); guest.remove(); vi.unstubAllGlobals(); });

it('keeps the full configuration as a draft until the user confirms, then returns it to Host', async () => {
  render(<PluginModelPickerHost />);
  act(() => push(request));
  expect(screen.getByText('为插件「示例插件」选择模型')).toBeTruthy();
  fireEvent.click(screen.getByText('Choose model'));
  expect(resolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: zh.settings.ghosts.modelPicker.useConfiguration }));
  await waitFor(() =>
    expect(resolve).toHaveBeenCalledExactlyOnceWith('request', {
      providerId: 'chosen-provider',
      model: 'chosen-model',
      agentKind: 'codex',
      effort: 'high',
      fastMode: 'ultrafast',
    }),
  );
});

it('returns cancellation without a model and removes the dialog on Host dismissal', async () => {
  render(<PluginModelPickerHost />);
  act(() => push(request));
  fireEvent.click(screen.getByRole('button', { name: zh.commonUi.confirmDialog.cancel }));
  await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith('request', null));
  act(() => dismiss({ requestId: 'request' }));
  await waitFor(() => expect(screen.queryByText('为插件「示例插件」选择模型')).toBeNull());
  // A late remote poll must not reopen a picker the Host has already settled.
  act(() => push(request));
  expect(screen.queryByText('为插件「示例插件」选择模型')).toBeNull();
});

it('keeps the choice editable and reports an unavailable source after Host rejects it', async () => {
  resolve.mockResolvedValue({ handled: true, accepted: false });
  render(<PluginModelPickerHost />);
  act(() => push(request));
  fireEvent.click(screen.getByText('Choose model'));
  fireEvent.click(screen.getByRole('button', { name: zh.settings.ghosts.modelPicker.useConfiguration }));
  await screen.findByText(zh.settings.ghosts.modelPicker.unavailable);
  expect(screen.getByText('Choose model')).toBeTruthy();
});

it('returns remote selections through the original view without calling local plugin IPC', async () => {
  render(<PluginModelPickerHost />);
  act(() => push({ ...request, deviceId: 'other-computer', remoteViewId: 'remote-view' }));
  fireEvent.click(screen.getByText('Choose model'));
  fireEvent.click(screen.getByRole('button', { name: zh.settings.ghosts.modelPicker.useConfiguration }));
  await waitFor(() =>
    expect(remote).toHaveBeenCalledWith(
      'remote-view',
      'request',
      expect.objectContaining({ model: 'chosen-model' }),
    ),
  );
  expect(resolve).not.toHaveBeenCalled();
});

it('keeps the active picker when another execution computer asks for a selection', async () => {
  render(<PluginModelPickerHost />);
  act(() => push(request));
  act(() =>
    push({
      ...request,
      requestId: 'second',
      ghostName: 'Other plugin',
      remoteViewId: 'remote-view',
    }),
  );
  await waitFor(() =>
    expect(remote).toHaveBeenCalledExactlyOnceWith('remote-view', 'second', null),
  );
  expect(screen.getByText('为插件「示例插件」选择模型')).toBeTruthy();
  expect(screen.queryByText('Other plugin')).toBeNull();
});

// Bug: plugin picker dropped the remote source even when the unified picker selected it.
// Existing local-only case cannot distinguish a local provider with the same ID. Tier: unit.
it('returns the selected share location with the confirmed model', async () => {
  selectedLocation = 'share:fixture';
  render(<PluginModelPickerHost />);
  act(() => push({ ...request, allowRemote: true }));
  fireEvent.click(screen.getByText('Choose model'));
  fireEvent.click(screen.getByRole('button', { name: zh.settings.ghosts.modelPicker.useConfiguration }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith('request', expect.objectContaining({
    agentDeviceId: 'share:fixture', providerId: 'chosen-provider', model: 'chosen-model',
  })));
});

// Test value: page-local button requests must reuse the Host popover and return a route
// immediately without a second confirmation. Minimal input: one guest and anchor; an absent
// guest must cancel. Dialog tests do not cover this branch. User request: panel parity; tier: unit.
it('opens the shared selector at the plugin button and returns the full choice without a dialog', async () => {
  selectedLocation = 'share:fixture';
  render(<PluginModelPickerHost />);
  act(() => push({ ...request, allowRemote: true, pageAnchor: {
    guestId: 42, rect: { x: 20, y: 30, width: 160, height: 32 },
  } }));
  expect(screen.queryByRole('button', { name: zh.settings.ghosts.modelPicker.useConfiguration })).toBeNull();
  fireEvent.click(screen.getByText('Choose model'));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith('request', {
    agentDeviceId: 'share:fixture', providerId: 'chosen-provider', model: 'chosen-model',
    agentKind: 'codex', effort: 'high', fastMode: 'ultrafast',
  }));
});

it('retains the popover when the Host rejects the selected route', async () => {
  resolve.mockResolvedValue({ handled: true, accepted: false });
  render(<PluginModelPickerHost />);
  act(() => push({ ...request, pageAnchor: { guestId: 42, rect: { x: 20, y: 30, width: 160, height: 32 } } }));
  fireEvent.click(screen.getByText('Choose model'));
  await screen.findByText(zh.settings.ghosts.modelPicker.unavailable);
  expect(screen.getByText('Choose model')).toBeTruthy();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(resolve).toHaveBeenLastCalledWith('request', null));
});

// Greptile #8964: Escape was swallowed by the selection lock during remote validation.
// Existing rejection coverage only presses Escape after validation completes. Minimal input:
// one unresolved route response followed by Escape; late responses must stay ignored. Tier: unit.
it('cancels during remote validation and ignores the superseded response', async () => {
  let finishValidation!: (value: { handled: boolean; accepted: boolean }) => void;
  resolve.mockImplementationOnce(() => new Promise((done) => { finishValidation = done; }));
  selectedLocation = 'share:fixture';
  render(<PluginModelPickerHost />);
  act(() => push({ ...request, allowRemote: true, pageAnchor: {
    guestId: 42, rect: { x: 20, y: 30, width: 160, height: 32 },
  } }));
  fireEvent.click(screen.getByText('Choose model'));
  expect(resolve).toHaveBeenCalledWith('request', expect.objectContaining({ agentDeviceId: 'share:fixture' }));
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
  expect(resolve).toHaveBeenLastCalledWith('request', null);
  await act(async () => { finishValidation({ handled: false, accepted: false }); });
  expect(screen.queryByText(zh.settings.ghosts.modelPicker.unavailable)).toBeNull();
});

it('cancels when the originating plugin page is gone instead of opening on a different page', async () => {
  render(<PluginModelPickerHost />);
  act(() => push({ ...request, pageAnchor: { guestId: 99, rect: { x: 20, y: 30, width: 160, height: 32 } } }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith('request', null));
  expect(screen.queryByText('Choose model')).toBeNull();
});
