import { describe, expect, it, vi } from 'vitest';

import { decodeRemoteErrorMessage, remoteErrorMessageForBanner, makerChatStore } from '@/lib/makerChatStore';
import { sharedTaskRecoveryError, sharedTaskRecoveryFor } from '../../shared/sharedTaskRecovery';
import { i18n } from '@/i18n';

describe('decodeRemoteErrorMessage', () => {
  // #10796, unit: the enqueue boundary must keep the transport cause for live
  // localization and diagnostics; reporting failure must not resend the input.
  it.each(['TIMEOUT', 'LINK_BUSY', 'UNRESPONSIVE'])('retains remote %s through an enqueue rejection without replay', async cause => {
    const code = `REMOTE_AGENT_${cause}`;
    const raw = `LAZY_CREATE_FAILED: [${code}] transport diagnostic`;
    const enqueue = vi.fn().mockRejectedValue(new Error(raw));
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = `remote-transport-${cause}`;
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(makerChatStore.getSnapshot(id).error).toBe(raw);
      expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t(`chat.remoteError.${code}`));
      expect(sharedTaskRecoveryFor(raw, 'share:provider')).toBe(cause === 'LINK_BUSY' ? 'rate' : 'timeout');
      expect(enqueue).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
  // Unit: a real lazy-create rejection must retain the account code and reset
  // metadata until the banner translates them in its active locale.
  it('preserves subscription guidance through the actual enqueue rejection', async () => {
    const raw = 'LAZY_CREATE_FAILED: [SUBSCRIPTION_ACCOUNT_LIMITED] waiting for reset\nresetAtMs=1900000000000';
    const enqueue = vi.fn().mockRejectedValue(new Error(raw));
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = 'local-task-subscription-reject';
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(makerChatStore.getSnapshot(id).error).toBe(raw);
      expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t('chat.subscriptionAccountError.limitedUntil', {
        resetAt: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(1900000000000),
      }));
    } finally { vi.unstubAllGlobals(); }
  });

  // Unit: local task storage can run a shared provider through main. Its
  // lazy-create rejection does not use the device-link optimistic outbox.
  it('preserves recovery reason and stage through the actual enqueue rejection', async () => {
    const error = sharedTaskRecoveryError('capability', 'unsupported');
    const enqueue = vi.fn().mockRejectedValue(error);
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = 'local-task-shared-provider-reject';
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(enqueue).toHaveBeenCalledTimes(1);
      const message = makerChatStore.getSnapshot(id).error!;
      expect(message).toBe(error.message);
      expect(sharedTaskRecoveryFor(message, 'share:provider')).toBe('unsupported');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([
    ['MCP_APPROVAL_AUTO_BLOCKED', 'Automatic approval review blocked this tool call. No manual rejection was received.'],
    ['MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'The permission request timed out without a confirmed decision. A timeout does not show whether you clicked a button.'],
    ['MCP_APPROVAL_CONFIRMATION_UNAVAILABLE', 'Permission confirmation could not be completed. No manual rejection was received.'],
  ])('explains %s without blaming the user', (code, text) => {
    expect(decodeRemoteErrorMessage(`[${code}] fallback`)).toBe(text);
  });

  it('maps user-facing device-link chat errors to i18n text', () => {
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally')).toBe(
      'Control for this device is off; the message was not sent.',
    );
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] upload failed')).toBe(
      'Attachment transfer failed; the message was not sent. Please try again.',
    );
  });

  it('maps Electron-wrapped device-link chat errors to i18n text', () => {
    expect(
      decodeRemoteErrorMessage(
        'Error invoking remote method device-link:invoke: Error: [DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally',
      ),
    ).toBe('Control for this device is off; the message was not sent.');
  });

  it('keeps non-chat device-link IPC codes unchanged', () => {
    expect(decodeRemoteErrorMessage('[DEVICE_LINK_ACCESS_REVOKED] access revoked')).toBe(
      '[DEVICE_LINK_ACCESS_REVOKED] access revoked',
    );
  });

  it('summarizes unknown remote codes in the interface language instead of upstream fallback text', () => {
    const summary = i18n.t('ipcError.INTERNAL');
    expect(decodeRemoteErrorMessage('[REMOTE_UNKNOWN] fallback message')).toBe(summary);
    expect(remoteErrorMessageForBanner('[REMOTE_UNKNOWN] fallback message')).toBe(summary);
    expect(summary).not.toContain('fallback message');
  });

  it('keeps an explicit fallback for missing keys that are not error copy', () => {
    expect(i18n.t('not.a.real.key', { defaultValue: 'keep me' })).toBe('keep me');
    expect(i18n.t('models.options.effortLevels.not-a-real-effort', { defaultValue: '' })).toBe('');
  });

  it('keeps known codes available to live and tail banners while other callers still get translated text', () => {
    const raw = '[REMOTE_LOCAL_ONLY_PROVIDER] use a different provider';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
    expect(decodeRemoteErrorMessage(raw)).not.toBe(raw);
  });

  // #8963: first send may reject from the host lazy-create boundary. The
  // wrapper must retain the known provider code so the live banner can show
  // the actionable remote-host guidance instead of "reply failed".
  it('keeps actionable guidance for lazy-create remote provider failures', () => {
    const raw = 'LAZY_CREATE_FAILED: [REMOTE_COMPAT_MODE_UNSUPPORTED] local provider';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
    expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t('chat.remoteError.REMOTE_COMPAT_MODE_UNSUPPORTED'));
  });

  it('explains an SSH Codex source mismatch after lazy creation fails', () => {
    const raw = 'LAZY_CREATE_FAILED: [REMOTE_CODEX_SOURCE_UNSUPPORTED] SSH Codex uses the remote native connection';
    const expected = i18n.t('settings.remote.startSession.unsupportedCodexSource');
    expect(decodeRemoteErrorMessage(raw)).toBe(expected);
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
  });

  // #9855, unit: keep the metadata diagnostic marker through the real store's
  // decoder so ErrorBanner can show recovery before raw details are expanded.
  it('preserves the Pi cloud-file startup diagnostic through lazy-create decoding', () => {
    const raw = 'LAZY_CREATE_FAILED: [PI_STARTUP_CLOUD_CONTEXT_FILE] Download ~/Desktop/AGENTS.md in Finder.\npi rpc timeout after 30000ms: set_thinking_level';
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
  });

  it('maps a missing auto-review confirmation to i18n text, not a user rejection', () => {
    expect(
      decodeRemoteErrorMessage(
        '[AUTO_REVIEW_CONFIRM_UNDELIVERED] Automatic review was unavailable, and the confirmation request was not completed.',
      ),
    ).toBe(
      'Automatic review was unavailable, and the confirmation request was not completed. This is not a user rejection.',
    );
  });
});

describe('remote session limit guidance', () => {
  it.each(['DEVICE_LIMIT', 'TOTAL_LIMIT'])('decodes %s inside lazy-create failures', reason => {
    const message = 'LAZY_CREATE_FAILED: [REMOTE_AGENT_BUSY] [' + reason + '] limit reached';
    expect(decodeRemoteErrorMessage(message)).toBe(i18n.t('chat.remoteError.REMOTE_AGENT_' + reason));
    expect(remoteErrorMessageForBanner(message)).toBe(message);
  });
});

// #10187: exercise the actual queue rejection projection. The old code kept
// reporting a communication/update error and never offered shared-task recovery.
it('preserves rejected shared history and exposes context handoff recovery', async () => {
  const raw = 'LAZY_CREATE_FAILED: [REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer';
  const enqueue = vi.fn().mockRejectedValue(new Error(raw));
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
    autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
  try {
    const id = 'shared-history-10187';
    expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
    expect(makerChatStore.getSnapshot(id).error).toBe(raw);
    expect(sharedTaskRecoveryFor(raw, 'share:provider')).toBe('history');
    expect(sharedTaskRecoveryFor(raw, 'same-account-device')).toBeUndefined();
    expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t('chat.remoteError.REMOTE_AGENT_RESUME_UNAVAILABLE'));
    expect(decodeRemoteErrorMessage(raw)).not.toBe(i18n.t('chat.remoteError.REMOTE_AGENT_INVALID'));
    expect(enqueue).toHaveBeenCalledOnce();
  } finally { vi.unstubAllGlobals(); }
});

// 并存方案 A 的 D（审核方 2026-11-17 定）：Host 因单独运行的桌面版占用数据而拒绝发送时，发送失败横幅说清
// 原因与做法（窗口语言），不再显示 `Error invoking remote method…: [PRECONDITION_FAILED] …` 原文。走真实的
// sendMessage 失败投影；不带这个标记的错误，横幅文本与之前逐字相同。
describe('a send refused while a desktop app uses the Host data', () => {
  it.each([
    ['running', 'HOST_PROFILE_IN_USE_BY_DESKTOP: In use by the desktop app.', 'logic.errors.hostProfileInUseByDesktop'],
    ['at start', 'HOST_PROFILE_IN_USE_BY_DESKTOP_AT_START: Quit that app, then restart the Host.', 'logic.errors.hostProfileInUseByDesktopAtStart'],
  ])('says why and what to do (%s)', async (_label, detail, key) => {
    const raw = `Error invoking remote method 'maker:input:enqueue': Error: [PRECONDITION_FAILED] ${detail}`;
    const enqueue = vi.fn().mockRejectedValue(new Error(raw));
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { maker: { input: { enqueue },
      autoTitle: vi.fn().mockResolvedValue({ applied: true, done: true }) } } });
    try {
      const id = `host-profile-held-${key}`;
      expect(await makerChatStore.sendMessage(id, 'continue', 'test-model', 'medium', 'auto', '/test')).toBe(false);
      expect(makerChatStore.getSnapshot(id).error).toBe(i18n.t(key));
      expect(i18n.t(key)).not.toBe(key);
      expect(decodeRemoteErrorMessage(raw)).toBe(i18n.t(key));
      expect(enqueue).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    "Error invoking remote method 'maker:input:enqueue': Error: [PRECONDITION_FAILED] The Host account is not ready",
    "Error invoking remote method 'maker:input:enqueue': Error: network down",
    "Error invoking remote method 'maker:input:enqueue': Error: [PRECONDITION_FAILED] blocked: HOST_PROFILE_IN_USE_BY_DESKTOP: later",
    '[INTERNAL] HOST_PROFILE_IN_USE_BY_DESKTOP: under another code',
    'LAZY_CREATE_FAILED: [REMOTE_COMPAT_MODE_UNSUPPORTED] local provider',
    'plain failure text',
  ])('passes other errors through as before: %s', raw => {
    expect(remoteErrorMessageForBanner(raw)).toBe(raw);
  });
});
