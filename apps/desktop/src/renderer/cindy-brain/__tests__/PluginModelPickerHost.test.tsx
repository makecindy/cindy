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
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelectorContent: (
    props: ComponentProps<
      typeof import('@/components/new-chat/ModelSelector').ModelSelectorContent
    >,
  ) => (
    <button
      onClick={() =>
        props.onUnifiedSelect?.({
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
beforeEach(() => {
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
afterEach(cleanup);

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
