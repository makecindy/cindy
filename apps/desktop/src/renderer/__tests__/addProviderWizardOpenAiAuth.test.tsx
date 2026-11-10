// @vitest-environment jsdom

/**
 * OpenAI 向导必须以本次显式授权结果为完成边界。
 *
 * 系统 ~/.codex/auth.json 可能已登录，但当前 Cindy 账号尚未绑定该凭证。仅观察到
 * 已登录快照时不能自动关闭向导；否则从 CLI 检测建议进入
 * OpenAI 会出现弹窗一闪即逝，且 provider 仍保持未连接。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import userEvent from '@testing-library/user-event';
import * as Dialog from '@radix-ui/react-dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import type { SubscriptionAccountCommand } from '../../shared/subscriptionAccounts';

const { createAccount, deleteAccount } = vi.hoisted(() => ({
  createAccount: vi.fn(), deleteAccount: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/lib/customProviders', () => ({ createCustomProvider: createAccount, deleteCustomProvider: deleteAccount }));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'O',
}));

vi.mock('@/components/icons/ProviderLogoMark', () => ({
  hasProviderLogo: () => false,
  ProviderLogoMark: () => null,
}));

import { AddProviderWizard } from '@/components/settings/AddProviderWizard';
import { toast } from '@/lib/toast';

const OPENAI_PROVIDER = {
  id: 'openai',
  name: 'OpenAI',
  source: 'builtin',
  agents: ['codex'],
  auth: { method: 'oauth' },
  routing: {},
  models: { codex: [] },
  connected: false,
} satisfies ProviderView;
const XAI_PROVIDER = { ...OPENAI_PROVIDER, id: 'xai', name: 'xAI' };
const DEVICE_PROVIDER = {
  id: 'device-provider',
  name: 'Device Provider',
  source: 'builtin',
  agents: ['codex'],
  auth: {
    method: 'oauth',
    oauth: {
      flow: 'device-code',
      deviceAuthorizationUrl: 'https://auth.example.test/device',
      tokenUrl: 'https://auth.example.test/token',
      clientId: 'device-client',
      scopes: 'openid',
    },
  },
  routing: {
    codex: {
      upstream: 'https://api.example.test/v1',
      authStrategy: 'oauth-token',
    },
  },
  models: { codex: [] },
  connected: false,
} satisfies ProviderView;
const AUTH_CODE_PROVIDER = {
  id: 'auth-code-provider',
  name: 'Authorization Code Provider',
  source: 'builtin',
  agents: ['codex'],
  auth: {
    method: 'oauth',
    oauth: {
      authorizeUrl: 'https://auth.example.test/authorize',
      tokenUrl: 'https://auth.example.test/token',
      clientId: 'auth-code-client',
      scopes: 'openid',
    },
  },
  routing: {
    codex: {
      upstream: 'https://api.example.test/v1',
      authStrategy: 'oauth-token',
    },
  },
  models: { codex: [] },
  connected: false,
} satisfies ProviderView;

const providerOAuthLogin = vi.fn();
const providerOAuthCancel = vi.fn();
const subscriptionLogin = vi.fn();
const subscriptionCancel = vi.fn();
const poolView = { providerId: 'openai', configured: true, strategy: 'least', accounts: [{ id: 'default', identity: 'existing@example.com', status: 'ready', directory: '/default', running: 0, paused: false, limit: 4, weight: 1 }] };
type ProviderOAuthProgress = {
  providerId: string;
  phase: 'device-code';
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
} | {
  providerId: string;
  ownerId: string;
  phase: 'browser-url';
  url: string | null;
};
let providerOAuthProgressListener: ((progress: ProviderOAuthProgress) => void) | null = null;

beforeEach(() => {
  createAccount.mockReset().mockResolvedValue(undefined);
  deleteAccount.mockReset().mockResolvedValue(undefined);
  providerOAuthLogin.mockReset().mockResolvedValue({ ok: true });
  providerOAuthCancel.mockReset();
  subscriptionLogin.mockReset().mockResolvedValue(poolView);
  subscriptionCancel.mockReset().mockResolvedValue(poolView);
  providerOAuthProgressListener = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscriptionAccounts: {
      command: vi.fn(async (command: SubscriptionAccountCommand) => {
        if (command.action === 'connect') return subscriptionLogin(command);
        if (command.action === 'cancel') return subscriptionCancel(command);
        return poolView;
      }),
    },
    maker: {
      listProviderPresets: vi.fn(async () => ({ presets: [] })),
      localModelList: vi.fn(async () => ({
        status: { runtime: 'ollama', kind: 'absent', appInstalled: false },
        models: [],
        memoryGb: 0,
      })),
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      providerOAuthLogin,
      providerOAuthCancel,
      onProviderOAuthProgress: vi.fn((listener: (progress: ProviderOAuthProgress) => void) => {
        providerOAuthProgressListener = listener;
        return () => {
          if (providerOAuthProgressListener === listener) providerOAuthProgressListener = null;
        };
      }),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AddProviderWizard — OpenAI 授权边界', () => {
  // #9517: a signed-out default used to hide the only usable recovery action.
  it('offers an independent account when Codex delegates authentication to its provider', async () => {
    const command = vi.mocked(window.electronAPI.subscriptionAccounts.command);
    command.mockImplementation(async request => request.action === 'preview'
      ? {
          ...poolView,
          providerId: 'openai',
          strategy: 'least',
          accounts: [{
            ...poolView.accounts[0],
            status: 'signed-out',
            authIssue: 'codex-provider-managed-auth',
          }],
        }
      : subscriptionLogin(request));
    render(<AddProviderWizard providers={[OPENAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByText('subscriptionAccounts.providerManagedAuth')).toBeTruthy();
    expect(screen.queryByText('subscriptionAccounts.signIn.useCodex')).toBeNull();
    fireEvent.click(screen.getByText('subscriptionAccounts.signIn.anotherAccount'));
    await waitFor(() => expect(subscriptionLogin).toHaveBeenCalledWith(expect.objectContaining({ target: 'new' })));
  });

  // Unit regression: cancellation must own the selected default/new CLI operation,
  // not a different provider's login. Late completions must not close a retry.
  it('keeps the inline cancel action named and enabled during authorization', async () => {
    let finish!: (value: unknown) => void;
    subscriptionLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[OPENAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText('subscriptionAccounts.signIn.useAccount'));
    const cancel = await screen.findByRole('button', { name: 'settings.providers.button.cancel' });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    expect(cancel.getAttribute('aria-busy')).toBeNull();
    fireEvent.click(cancel);
    expect(subscriptionCancel).toHaveBeenCalledOnce();
    await act(async () => { finish(poolView); });
    expect(onDone).not.toHaveBeenCalled();
  });
  it.each(['openai', 'anthropic'].flatMap(id => ['default', 'new'].flatMap(target =>
    ['cancel', 'unmount'].map(exit => ({ id, target, exit }))))
  )('discards $id $target completion after $exit', async ({ id, target, exit }) => {
    let finish!: (value: unknown) => void;
    subscriptionLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    const { unmount } = render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id }]}
      entry={{ kind: 'builtin', providerId: id }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText(target === 'default'
      ? 'subscriptionAccounts.signIn.useAccount' : 'subscriptionAccounts.signIn.anotherAccount'));
    await waitFor(() => expect(subscriptionLogin).toHaveBeenCalledOnce());
    const { loginKey } = subscriptionLogin.mock.calls[0][0];
    if (exit === 'unmount') unmount();
    else fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    expect(subscriptionCancel).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', providerId: id, loginKey });
    await act(async () => { finish(poolView); });
    expect(onDone).not.toHaveBeenCalled();
    expect(createAccount).not.toHaveBeenCalled();
  });
  // #9517, unit: render the actual wizard with the serialized IPC failure; the
  // existing error matrix did not distinguish provider configuration from login failure.
  it.each(['anthropic', 'openai'].flatMap(providerId => ['SUBSCRIPTION_ACCOUNT_FAILED', 'SUBSCRIPTION_LOGIN_CANCELLED', 'SUBSCRIPTION_CODEX_PROVIDER_AUTH']
    .map(reason => ({ providerId, reason }))))('reports $providerId $reason without completing', async ({ providerId, reason }) => {
    subscriptionLogin.mockRejectedValue(new Error(`Error invoking remote method: Error: [${reason}] Account operation failed`));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id: providerId }]}
      entry={{ kind: 'builtin', providerId }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText('subscriptionAccounts.signIn.useAccount'));
    await waitFor(() => expect(subscriptionLogin).toHaveBeenCalledOnce());
    await screen.findByText('subscriptionAccounts.signIn.useAccount');
    if (reason === 'SUBSCRIPTION_LOGIN_CANCELLED') expect(toast.error).not.toHaveBeenCalled();
    else expect(toast.error).toHaveBeenCalledExactlyOnceWith(reason === 'SUBSCRIPTION_CODEX_PROVIDER_AUTH'
      ? 'subscriptionAccounts.providerManagedAuth' : 'subscriptionAccounts.failed');
    expect(onDone).not.toHaveBeenCalled();
  });
  it.each(['xai'].flatMap(id =>
    ['cancel', 'unmount'].map(exit => ({ id, exit })),
  ))('removes $id when login succeeds after $exit', async ({ id, exit }) => {
    let finish!: (value: { ok: boolean }) => void;
    providerOAuthLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    const { unmount } = render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id, name: id }]}
      entry={{ kind: 'builtin', providerId: id }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const [accountId, options] = providerOAuthLogin.mock.calls[0];
    if (exit === 'unmount') unmount();
    else fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    expect(providerOAuthCancel).toHaveBeenCalledWith(accountId, { ownerId: options.ownerId, releaseOwner: true });
    await act(async () => { finish({ ok: true }); });
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith(accountId);
    expect(onDone).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'finish'])('reopens the pending independent account only on click and clears on %s', async (end) => {
    let finish!: (value: { ok: boolean }) => void;
    providerOAuthLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const openExternal = vi.fn(async () => ({ success: true }));
    window.electronAPI.openExternal = openExternal;
    render(<AddProviderWizard providers={[XAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'xai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledOnce());
    const [providerId, { ownerId }] = providerOAuthLogin.mock.calls[0];
    const url = 'https://auth.openai.com/oauth/authorize?state=fake';
    act(() => providerOAuthProgressListener?.({ providerId, ownerId, phase: 'browser-url', url }));
    const reopen = screen.getByRole('button', { name: 'settings.providers.genericOAuth.reopenLoginPage' });
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(reopen);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    if (end === 'cancel') fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    await act(async () => finish({ ok: true }));
    act(() => providerOAuthProgressListener?.({ providerId, ownerId, phase: 'browser-url', url }));
    expect(screen.queryByRole('button', { name: 'settings.providers.genericOAuth.reopenLoginPage' })).toBeNull();
  });
  it('keeps the retry pool login when the cancelled login succeeds later', async () => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    subscriptionLogin.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    subscriptionLogin.mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[OPENAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'openai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByText('subscriptionAccounts.signIn.anotherAccount'));
    await waitFor(() => expect(subscriptionLogin).toHaveBeenCalledTimes(1));
    const oldId = subscriptionLogin.mock.calls[0][0].loginKey;
    fireEvent.click(screen.getByText('settings.providers.wizard.back'));
    fireEvent.click(screen.getByText('OpenAI'));
    fireEvent.click(screen.getByText('subscriptionAccounts.signIn.anotherAccount'));
    await waitFor(() => expect(subscriptionLogin).toHaveBeenCalledTimes(2));
    const newId = subscriptionLogin.mock.calls[1][0].loginKey;
    expect(newId).not.toBe(oldId);
    await act(async () => { finishOld(poolView); });
    expect(subscriptionCancel).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', providerId: 'openai', loginKey: oldId });
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(screen.getByText('settings.providers.wizard.cancel')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => { finishNew(poolView); });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('openai'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
  it.each(['xai'])('cancels only the pending independent %s authorization', async id => {
    let finish!: (value: { ok: boolean; reason: string }) => void;
    providerOAuthLogin.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id, name: id, connected: true }]}
      entry={{ kind: 'builtin', providerId: id }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const [accountId, options] = providerOAuthLogin.mock.calls[0];
    fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    expect(providerOAuthCancel).toHaveBeenCalledWith(accountId, { ownerId: options.ownerId, releaseOwner: true });
    await act(async () => { finish({ ok: false, reason: 'login_cancelled' }); });
    expect(deleteAccount).toHaveBeenCalledWith(accountId);
    expect(onDone).not.toHaveBeenCalled();
  });
  it.each([['xai', 'xai']] as const)('adds another %s account even when its builtin provider is connected', async (id, native) => {
    const onDone = vi.fn();
    render(<AddProviderWizard providers={[{ ...OPENAI_PROVIDER, id, name: id, connected: true }]}
      onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByText(id));
    fireEvent.click(await screen.findByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(providerOAuthLogin).toHaveBeenCalledTimes(1));
    const accountId = providerOAuthLogin.mock.calls[0][0];
    expect(accountId).toMatch(new RegExp(`^${id}-`));
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({ id: accountId, auth: { method: 'oauth', native } }), {});
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(accountId));
  });
  it('关闭向导后才完成供应商创建时，不启动登录并清理空供应商', async () => {
    let finishCreate!: () => void;
    createAccount.mockImplementation(() => new Promise<void>((resolve) => { finishCreate = resolve; }));
    const { unmount } = render(<AddProviderWizard providers={[XAI_PROVIDER]}
      entry={{ kind: 'builtin', providerId: 'xai' }} onOpenCustomForm={vi.fn()} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText('settings.providers.openai.addIndependentAccount'));
    await waitFor(() => expect(createAccount).toHaveBeenCalledTimes(1));
    const id = createAccount.mock.calls[0][0].id;
    unmount();
    await act(async () => { finishCreate(); });
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(id));
    expect(providerOAuthLogin).not.toHaveBeenCalled();
  });

  it('目录声明 Device Grant 时，添加流程直接展示供应商设备码', async () => {
    providerOAuthLogin.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = render(
      <AddProviderWizard
        providers={[DEVICE_PROVIDER]}
        entry={{ kind: 'builtin', providerId: DEVICE_PROVIDER.id }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(providerOAuthProgressListener).not.toBeNull());

    fireEvent.click(screen.getByText('settings.providers.wizard.authorizeWithDeviceCode'));
    await waitFor(() =>
      expect(providerOAuthLogin).toHaveBeenCalledWith(
        DEVICE_PROVIDER.id,
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    const ownerId = providerOAuthLogin.mock.calls[0]?.[1]?.ownerId;
    act(() => {
      providerOAuthProgressListener?.({
        providerId: DEVICE_PROVIDER.id,
        phase: 'device-code',
        verificationUrl: 'https://auth.example.test/device',
        userCode: 'TEST-CODE',
        expiresAt: Date.now() + 300_000,
      });
    });

    expect(await screen.findByText('TEST-CODE')).not.toBeNull();
    expect(screen.getByText(/auth\.example\.test/)).not.toBeNull();

    unmount();
    expect(providerOAuthCancel).toHaveBeenCalledOnce();
    expect(providerOAuthCancel).toHaveBeenCalledWith(DEVICE_PROVIDER.id, {
      releaseOwner: true,
      ownerId,
    });
  });

  it('authorization-code 登录期间被父级卸载时取消仍在等待的回环授权', async () => {
    providerOAuthLogin.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = render(
      <AddProviderWizard
        providers={[AUTH_CODE_PROVIDER]}
        entry={{ kind: 'builtin', providerId: AUTH_CODE_PROVIDER.id }}
        onOpenCustomForm={vi.fn()}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('settings.providers.button.authorize'));
    await waitFor(() =>
      expect(providerOAuthLogin).toHaveBeenCalledWith(
        AUTH_CODE_PROVIDER.id,
        expect.objectContaining({ ownerId: expect.any(String) }),
      ),
    );
    const ownerId = providerOAuthLogin.mock.calls[0]?.[1]?.ownerId;
    expect(providerOAuthProgressListener).toBeNull();

    unmount();
    expect(providerOAuthCancel).toHaveBeenCalledOnce();
    expect(providerOAuthCancel).toHaveBeenCalledWith(AUTH_CODE_PROVIDER.id, {
      releaseOwner: true,
      ownerId,
    });
  });
});

describe('AddProviderWizard — 关闭途径(取消 / Esc)', () => {
  it('按 Esc 关闭向导', async () => {
    const onClose = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        onOpenCustomForm={vi.fn()}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('输入法组合期间按 Esc 不关闭向导(取消候选词,不是关闭命令)', async () => {
    const onClose = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        onOpenCustomForm={vi.fn()}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('点击遮罩或弹窗内部不关闭;点击取消关闭', async () => {
    const onClose = vi.fn();
    render(
      <AddProviderWizard
        providers={[OPENAI_PROVIDER]}
        onOpenCustomForm={vi.fn()}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('settings.providers.wizard.title'));
    expect(onClose).not.toHaveBeenCalled();
    const overlay = document.querySelector('.modal-scrim')!;
    fireEvent.mouseDown(screen.getByText('settings.providers.wizard.title'));
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('settings.providers.wizard.cancel'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

it('wizard focuses search, contains Tab, restores its opener and lets a top dialog own Esc', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const [child, setChild] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Add provider</button>
      {open && <AddProviderWizard providers={[]} onOpenCustomForm={vi.fn()} onClose={() => setOpen(false)} onDone={() => setOpen(false)} />}
      <Dialog.Root open={child} onOpenChange={setChild}>
        <Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>Top layer</Dialog.Title><button>Child action</button></Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      <button onClick={() => setChild(true)}>Open child</button>
    </>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Add provider' });
  await user.click(opener);
  const search = screen.getByPlaceholderText('settings.providers.wizard.searchPlaceholder');
  const cancel = screen.getByRole('button', { name: 'settings.providers.wizard.cancel' });
  expect(document.activeElement).toBe(search);
  const custom = screen.getByRole('button', { name: 'settings.providers.wizard.customAction' });
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(custom);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(cancel);
  await user.tab();
  expect(document.activeElement).toBe(custom);
  await user.tab();
  expect(document.activeElement).toBe(search);
  // Open a second Radix layer without moving focus outside the first modal.
  fireEvent.click(screen.getByRole('button', { name: 'Open child', hidden: true }));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.queryByText('Top layer')).toBeNull();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
