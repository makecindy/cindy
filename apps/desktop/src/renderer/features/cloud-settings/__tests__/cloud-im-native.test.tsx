// @vitest-environment jsdom
// The local Telegram, WeChat directory and prompt editors on the cloud page talk only to the
// instance: every read and write is a DeviceLink call, never this computer's own API.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUD_IM_SETTINGS_CHANNEL,
  CLOUD_WECHAT_WORKING_DIR_SET,
} from '../../../../shared/cloudImSettings';
import { CLOUD_PERSONALIZATION_CHANNEL } from '../../../../shared/cloudPersonalization';
import { createCloudImTarget } from '../cloudImTarget';
import { CloudTelegramSettings, CloudWechatWorkingDirectory, useCloudImTarget } from '../CloudImNative';
import type { ManagementItem } from '../../../../shared/settingsManagement';
import { CloudUserPromptSection } from '../CloudUserPromptSection';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toasts }));

const DEVICE = 'cloud-device-1';
type Handler = (args: unknown[]) => unknown;
let im: Record<string, Handler>;
let prompt: (request: Record<string, unknown>) => unknown;
const invoke = vi.fn(async (device: string, channel: string, args: unknown[]) => {
  expect(device).toBe(DEVICE);
  if (channel === CLOUD_PERSONALIZATION_CHANNEL)
    return prompt(args[0] as Record<string, unknown>);
  expect(channel).toBe(CLOUD_IM_SETTINGS_CHANNEL);
  const request = args[0] as { call: string; args: unknown[] };
  const handler = im[request.call];
  if (!handler) throw Error(`unexpected ${request.call}`);
  return { ownerGeneration: 1, result: await handler(request.args) };
});

beforeEach(() => {
  im = {};
  // Any use of this computer's API other than DeviceLink fails the test.
  Object.assign(window, {
    electronAPI: new Proxy(
      { deviceLink: { invoke } },
      {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          throw Error(`LOCAL_API_${String(key)}`);
        },
      },
    ),
  });
});
afterEach(() => {
  cleanup();
  invoke.mockClear();
  vi.useRealTimers();
});

const target = (pickDirectory = vi.fn(async () => '/home/cindy/wechat')) =>
  createCloudImTarget(DEVICE, {
    authorization: { start: vi.fn(), cancel: vi.fn(async () => false) },
    pickDirectory,
  });

describe('cloud IM native sections', () => {
  // Unit/jsdom: communications authorization must use the target's connect ticket, not
  // the same workspace's authorize/rebind ticket (which would take over its bot).
  it('selects the declared Slack communications ticket instead of the rebind action', async () => {
    im['maker:hook-control:get'] = () => ({ hook: { enabled: true } });
    const actions = ['authorize', 'connect'].map((intent, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`, intent, label: intent, fields: [], expiresAt: Date.now() + 60_000,
    })) as ManagementItem['actions'];
    const item: ManagementItem = { id: 'bot:official:slack:team-a', label: 'Workspace A', status: 'connected', actions };
    const run = vi.fn(async () => {});
    const hook = renderHook(() => useCloudImTarget({
      deviceId: DEVICE, deviceName: 'Cloud', enabled: false, items: [item], run,
      cancelOperation: vi.fn(), operationActive: false,
    }));
    await hook.result.current.target.api.hookControl.setSlackCommunications('team-a', true);
    expect(run).toHaveBeenCalledWith(item, actions[1]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('edits the instance Telegram persona, behaviour and groups', async () => {
    const setPersona = vi.fn((args: unknown[]) => ({ persona: args[0] }));
    const setGroup = vi.fn(() => ({}));
    Object.assign(im, {
      'telegramBot:get-persona': () => ({ botName: 'Cindy', soul: 'kind' }),
      'telegramBot:set-persona': setPersona,
      'telegramBot:get-behavior': () => ({
        emojiReactions: 'minimal',
        replyQuoteGroup: 'first',
        replyQuoteDm: 'off',
      }),
      'telegramBot:set-behavior': (args: unknown[]) => ({
        emojiReactions: 'off',
        replyQuoteGroup: 'first',
        replyQuoteDm: 'off',
        ...(args[0] as object),
      }),
      'telegramBot:list-groups': () => ({
        groups: [{ chatId: '-100', chatName: 'Team', activation: 'mention' }],
      }),
      'telegramBot:set-group-activation': setGroup,
    });
    render(<CloudTelegramSettings target={target()} />);
    const name = await screen.findByDisplayValue('Cindy');
    expect(await screen.findByText('Team')).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.change(name, { target: { value: 'Cindy Cloud' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(setPersona).toHaveBeenCalledWith([{ botName: 'Cindy Cloud', soul: 'kind' }]);
  });

  it('chooses the WeChat directory in the instance browser and saves it there', async () => {
    const set = vi.fn((args: unknown[]) => ({
      version: 1,
      workingDir: args[0],
      workingDirAvailable: true,
    }));
    Object.assign(im, {
      'wechatBot:get-channel-settings': () => ({
        version: 1,
        workingDir: null,
        workingDirAvailable: true,
      }),
      [CLOUD_WECHAT_WORKING_DIR_SET]: set,
    });
    const pick = vi.fn(async () => '/home/cindy/wechat');
    render(<CloudWechatWorkingDirectory target={target(pick)} disabled={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /settings.wechatBot.workingDir.managed/ }));
    await waitFor(() => expect(set).toHaveBeenCalledWith(['/home/cindy/wechat']));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('/home/cindy/wechat')).toBeTruthy();
    expect(toasts.success).toHaveBeenCalledWith('settings.wechatBot.toasts.workingDirSaved');
  });

  it('shows and saves the instance prompt with its revision', async () => {
    let state = { status: 'ready', ownerGeneration: 2, revision: 'r1', userPrompt: 'hello', customized: true };
    prompt = (request) => {
      if (request.op === 'save') {
        expect(request).toEqual({ op: 'save', ownerGeneration: 2, revision: 'r1', userPrompt: 'hello!' });
        state = { ...state, revision: 'r2', userPrompt: 'hello!' };
      }
      return state;
    };
    render(
      <CloudUserPromptSection
        deviceId={DEVICE}
        disabled={false}
        onDirtyChange={() => {}}
        wrap={(content) => content}
      />,
    );
    const box = await screen.findByDisplayValue('hello');
    await waitFor(() => expect(box.matches(':disabled')).toBe(false));
    fireEvent.change(box, { target: { value: 'hello!' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.personalization.save' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('settings.personalization.toast.saved'));
    expect((box as HTMLTextAreaElement).value).toBe('hello!');
  });

  it('keeps only the page title on a runtime without the prompt channel', async () => {
    prompt = () => {
      throw Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] not supported');
    };
    render(
      <CloudUserPromptSection
        deviceId={DEVICE}
        disabled={false}
        onDirtyChange={() => {}}
        wrap={(content) => content}
      />,
    );
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.getByText('settings.personalization.title')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
