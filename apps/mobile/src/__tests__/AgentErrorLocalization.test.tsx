// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { parseAgentErrorCode } from '@cindy/maker-shared/error-redaction';
import { remoteActionErrorI18nKey, unclassifiedAgentErrorI18nKey, requiresAgentErrorConfigurationChange } from '@/session/agentErrorI18n';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { SUPPORTED_LOCALES } from '@/i18n/locale';
import { InlineQueueSection } from '@/session/InlineQueueSection';
import { SessionTailBanner } from '@/session/SessionTailBanner';
import { AgentErrorDetails } from '@/session/AgentErrorDetails';
import { resolveSessionTailBanner } from '@/session/sessionTailBannerModel';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import type { InputProjection, RemoteMessage } from '@/session/types';
import { buildErrorDiagnosisPrompt } from '@/session/errorDiagnosisPrompt';

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, onPress, disabled, testID, accessibilityState }: {
    children?: ReactNode; onPress?: () => void; disabled?: boolean; testID?: string; accessibilityState?: { expanded?: boolean };
  }) => createElement(tag, { onClick: onPress, disabled, 'data-testid': testID, 'aria-expanded': accessibilityState?.expanded }, children);
  return { View: view('div'), Text: view('span'), Pressable: view('button'), ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Pause: () => null, Play: () => null, CircleAlert: () => null, Split: () => null, X: () => null, ChevronRight: () => null, ChevronDown: () => null, Stethoscope: () => null }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) => make(tokens.lightColors) };
});
const raw = JSON.stringify({ error: { message: 'X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false.', type: 'invalid_request_error', param: 'parallel_tool_calls', code: 'unsupported_value' } });
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const row = (text: string): RemoteMessage => ({ id: 'error', clientId: 'error', sessionId: 's', role: 'error', content: JSON.stringify({ message: text }), toolUseId: null, agentMeta: null, createdAt: '2026-09-23T04:13:00Z' });
const clickText = (text: string) => {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button).toBeTruthy(); button!.click();
};

// 诊断入口只在展开详情后出现；预填给新任务的提示带出错任务链接，且与详情同样脱敏。
it('offers diagnosis after expanding details with a redacted prompt for the failed session', async () => {
  await i18n.changeLanguage('en');
  const onDiagnose = vi.fn();
  const error = 'Unexpected provider failure; api_key=private-test-value';
  await act(async () => root.render(<SessionTailBanner
    state={{ kind: 'error-tail', text: 'Reply failed', rawError: error, reason: 'tool_use_loop_detected', clientId: 'e', continueKind: 'error', retryable: true }}
    onContinue={vi.fn()} onDismiss={vi.fn()} onDiagnose={onDiagnose} />));
  expect(host.querySelector('[data-testid="agentError.diagnose"]')).toBeNull();
  await act(async () => clickText(i18n.t('session.tail.showErrorDetails')));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agentError.diagnose"]')!.click());
  const prompt = buildErrorDiagnosisPrompt(i18n.t, 'cindy://session/s1', { ...onDiagnose.mock.calls[0][0], reason: 'unexpected api_key=private-reason-value' });
  expect(prompt).toContain('cindy://session/s1');
  expect(prompt).toContain('Reply failed');
  expect(prompt).toContain('reason: unexpected');
  expect(prompt).not.toContain('private-test-value');
  expect(prompt).not.toContain('private-reason-value');
});

describe.each(SUPPORTED_LOCALES)('mobile errors in %s', locale => {
  it.each(['live', 'tail'] as const)('offers explicit %s recovery without automatically retrying', async surface => {
    await i18n.changeLanguage(locale);
    const recover = vi.fn();
    const retry = vi.fn();
    const dismiss = vi.fn();
    const error = 'stream disconnected before completion: stream closed before response.completed';
    const renderBanner = (busy: boolean) => surface === 'live'
      ? <InlineQueueSection projection={{ error, errorRetryText: 'original' } as InputProjection} busy={busy}
          onRecoverHistory={recover} onRetryError={retry} onClearError={dismiss} onResume={vi.fn()} />
      : <SessionTailBanner state={{ kind: 'error-tail', text: error, rawError: error, clientId: 'e', continueKind: 'error', retryable: true }}
          busy={busy} onRecoverHistory={recover} onContinue={retry} onDismiss={dismiss} />;
    await act(async () => root.render(renderBanner(false)));
    expect(host.textContent).toContain(i18n.t('session.tail.readableHistoryRecoveryDescription'));
    expect(recover).not.toHaveBeenCalled();
    await act(async () => clickText(i18n.t('session.tail.readableHistoryRecovery')));
    expect(recover).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    await act(async () => root.render(renderBanner(true)));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="session.readableHistoryRecovery"]')!;
    const closeId = surface === 'live' ? 'queue.inline.clearErrorButton' : 'session.tailBanner.dismiss';
    const close = host.querySelector<HTMLButtonElement>(`[data-testid="${closeId}"]`)!;
    expect(close.disabled).toBe(true);
    await act(async () => close.click());
    expect(dismiss).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(recover).toHaveBeenCalledOnce();
    await act(async () => root.render(renderBanner(false)));
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="${closeId}"]`)!.click());
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each(['live', 'tail'] as const)('localizes %s, preserves retry and switches locale without another request', async surface => {
    await i18n.changeLanguage(locale);
    for (const key of ['requestFormatError', 'replyFailed', 'showErrorDetails', 'hideErrorDetails', 'retry']) {
      expect(i18n.getResource(locale, 'common', `session.tail.${key}`)).toBeTypeOf('string');
    }
    const retry = vi.fn();
    const state = resolveSessionTailBanner({ messages: [row(raw)], session: null, projection: { error: null, credentialSwitchWait: null }, isSessionStreaming: false, continuationInFlight: false, sessionMetadataSyncedForConnection: true, interruptAcked: false, hiddenErrorClientIds: new Set() });
    expect(state?.kind).toBe('error-tail');
    await act(async () => root.render(surface === 'live'
      ? <InlineQueueSection projection={{ error: raw, errorRetryText: 'original-welcome' } as InputProjection} readOnlyReason={null} onRetryError={retry} onClearError={vi.fn()} onResume={vi.fn()} />
      : <SessionTailBanner state={state!} onContinue={retry} onDismiss={vi.fn()} />));
    expect(host.textContent).toContain(i18n.t('session.tail.requestFormatError'));
    expect(host.textContent).not.toContain('Responses-Lite');
    expect(retry).not.toHaveBeenCalled();
    await act(async () => clickText(i18n.t('session.tail.showErrorDetails')));
    expect(host.textContent).toContain(raw);
    await act(async () => clickText(i18n.t('session.tail.hideErrorDetails')));
    const next = locale === 'en' ? 'ja' : 'en';
    await act(async () => { await i18n.changeLanguage(next); });
    expect(host.textContent).toContain(i18n.t('session.tail.requestFormatError'));
    expect(host.textContent).toContain(i18n.t('session.tail.showErrorDetails'));
    const retryButton = host.querySelector<HTMLButtonElement>(`[data-testid="${surface === 'live' ? 'queue.inline.retryButton' : 'session.tailBanner.continue'}"]`)!;
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('localizes historical errors and only discloses redacted unknown diagnostics', async () => {
    await i18n.changeLanguage(locale);
    const [lite, unknown] = normalizeRemoteMessages([row(raw), { ...row('Provider exploded; api_key=private-test-value'), id: 'unknown', clientId: 'unknown' }]);
    expect(lite.body).toBe(i18n.t('session.tail.requestFormatError'));
    expect(unknown.body).toBe(i18n.t('session.tail.replyFailed'));
    await act(async () => root.render(<AgentErrorDetails message={unknown.rawError!} />));
    expect(host.textContent).not.toContain('Provider exploded');
    await act(async () => clickText(i18n.t('session.tail.showErrorDetails')));
    expect(host.textContent).toContain('Provider exploded');
    expect(host.textContent).toContain('[REDACTED]');
    expect(host.textContent).not.toContain('private-test-value');
  });
});


describe.each(SUPPORTED_LOCALES)('known mobile remote errors in %s', locale => {
  it.each(['DEVICE_LIMIT', 'TOTAL_LIMIT'])('recognizes wrapped %s errors from the remote computer', async reason => {
    await i18n.changeLanguage(locale);
    const message = `LAZY_CREATE_FAILED: [REMOTE_AGENT_BUSY] [${reason}] upstream diagnostic`;
    const key = `session.remoteError.REMOTE_AGENT_${reason}`;
    expect(unclassifiedAgentErrorI18nKey(message)).toBe(key);
    const [normalized] = normalizeRemoteMessages([row(message)]);
    expect(normalized.body).toBe(i18n.t(key));
    expect(normalized.body).not.toContain('upstream diagnostic');
    expect(unclassifiedAgentErrorI18nKey('[REMOTE_AGENT_BUSY] too many tasks')).toBe('session.remoteError.REMOTE_AGENT_BUSY');
  });

  it('explains a remote conversation that could not be resumed instead of a generic reply failure', async () => {
    await i18n.changeLanguage(locale);
    const message = '[REMOTE_AGENT_RESUME_LOST] The earlier conversation on the other computer could not be resumed, so the agent continues without it.';
    const key = 'session.remoteError.REMOTE_AGENT_RESUME_LOST';
    expect(unclassifiedAgentErrorI18nKey(message)).toBe(key);
    expect(i18n.t(key)).not.toBe(i18n.t('session.tail.replyFailed'));
    const [normalized] = normalizeRemoteMessages([row(message)]);
    expect(normalized.body).toBe(i18n.t(key));
  });

  // The fork action showed the raw "[IPC_ERROR] [REMOTE_AGENT_FORK_FAILED] …" string; it must use
  // the localized remote copy, while unknown codes keep the caller's own fallback.
  it('localizes a remote fork failure in one-shot action errors', async () => {
    await i18n.changeLanguage(locale);
    expect(remoteActionErrorI18nKey('[IPC_ERROR] [REMOTE_AGENT_FORK_FAILED] the conversation could not be forked'))
      .toBe('session.remoteError.REMOTE_AGENT_FORK_FAILED');
    expect(remoteActionErrorI18nKey('[REMOTE_FUTURE] private diagnostic')).toBeNull();
    expect(remoteActionErrorI18nKey('[NOT_FOUND] message missing')).toBeNull();
  });

  it('has every desktop bracket-code translation without relying on fallback languages', async () => {
    await i18n.changeLanguage(locale);
    const desktop = JSON.parse(readFileSync(`../desktop/src/renderer/i18n/locales/${locale}/common.json`, 'utf8'));
    for (const [code, translation] of Object.entries(desktop.chat.remoteError)) {
      if (!parseAgentErrorCode(`[${code}] diagnostic`)) continue;
      const key = `session.remoteError.${code}`;
      const translated = i18n.getResource(locale, 'common', key);
      expect(translated).toBeTypeOf('string');
      expect(translated.length).toBeGreaterThan(0);
      expect(translated.match(/{{[^}]+}}/g) ?? []).toEqual((translation as string).match(/{{[^}]+}}/g) ?? []);
      expect(unclassifiedAgentErrorI18nKey(`[${code}] diagnostic`)).toBe(key);
    }
    expect(unclassifiedAgentErrorI18nKey('[REMOTE_FUTURE] private diagnostic')).toBe('session.tail.replyFailed');
    expect(unclassifiedAgentErrorI18nKey('[CUSTOM_ERROR] private diagnostic')).toBe('session.tail.replyFailed');
  });

  it.each(['REMOTE_LOCAL_ONLY_PROVIDER', 'DEVICE_LINK_MEDIA_TRANSFER_FAILED', 'DEVICE_LINK_MEDIA_ACCESS_DENIED', 'MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'SSH_HARNESS_SWITCH_UNSUPPORTED', 'MODEL_SELECTION_UNAVAILABLE', 'HARNESS_SWITCH_NOT_READY'])(
    'preserves %s guidance across history, live and tail, including language changes', async code => {
      await i18n.changeLanguage(locale);
      const message = `Error invoking remote method 'maker:send': Error: [${code}] upstream diagnostic; api_key=private-test-value`;
      const key = `session.remoteError.${code}`;
      const [historical] = normalizeRemoteMessages([row(message)]);
      expect(historical.body).toBe(i18n.t(key));
      expect(historical.errorSummaryKey).toBe(key);
      expect(historical.rawError).toBe(message);
      const state = resolveSessionTailBanner({ messages: [row(message)], session: null, projection: { error: null, credentialSwitchWait: null }, isSessionStreaming: false, continuationInFlight: false, sessionMetadataSyncedForConnection: true, interruptAcked: false, hiddenErrorClientIds: new Set() });
      expect(state?.kind).toBe('error-tail');
      const retryable = code !== 'REMOTE_LOCAL_ONLY_PROVIDER';
      expect(state?.kind === 'error-tail' && state.retryable).toBe(retryable);
      for (const surface of ['live', 'tail'] as const) {
        await i18n.changeLanguage(locale);
        const retry = vi.fn();
        const clear = vi.fn();
        await act(async () => root.render(surface === 'live'
          ? <InlineQueueSection projection={{ error: message, errorRetryText: 'original user message' } as InputProjection} readOnlyReason={null} onRetryError={retry} onClearError={clear} onResume={vi.fn()} />
          : <SessionTailBanner state={state!} onContinue={retry} onDismiss={clear} />));
        expect(host.textContent).toContain(i18n.t(key));
        expect(host.textContent).not.toContain('upstream diagnostic');
        expect(host.textContent).not.toContain(i18n.t('session.tail.replyFailed'));
        await act(async () => clickText(i18n.t('session.tail.showErrorDetails')));
        expect(host.textContent).toContain('upstream diagnostic');
        expect(host.textContent).not.toContain('private-test-value');
        await act(async () => clickText(i18n.t('session.tail.hideErrorDetails')));
        await act(async () => { await i18n.changeLanguage(locale === 'en' ? 'ja' : 'en'); });
        expect(host.textContent).toContain(i18n.t(key));
        expect(host.textContent).toContain(i18n.t('session.tail.showErrorDetails'));
        const retryButton = host.querySelector<HTMLButtonElement>(`[data-testid="${surface === 'live' ? 'queue.inline.retryButton' : 'session.tailBanner.continue'}"]`);
        if (retryable) {
          expect(retryButton).toBeTruthy();
          await act(async () => retryButton!.click());
          expect(retry).toHaveBeenCalledOnce();
        } else {
          expect(retryButton).toBeNull();
          expect(retry).not.toHaveBeenCalled();
        }
        const clearButton = host.querySelector<HTMLButtonElement>(`[data-testid="${surface === 'live' ? 'queue.inline.clearErrorButton' : 'session.tailBanner.dismiss'}"]`);
        expect(clearButton).toBeTruthy();
        await act(async () => clearButton!.click());
        expect(clear).toHaveBeenCalledOnce();
      }
    },
  );
});

it.each(['REMOTE_LOCAL_ONLY_PROVIDER', 'REMOTE_COMPAT_MODE_UNSUPPORTED', 'REMOTE_LOCAL_ATTACHMENT_UNSUPPORTED', 'DEVICE_LINK_CONTROL_DISABLED'])(
  'does not suggest resending unchanged content for %s', code => {
    expect(requiresAgentErrorConfigurationChange(`[${code}] diagnostic`)).toBe(true);
  },
);
it.each(['REMOTE_DAEMON_CLOSED', 'REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE', 'DEVICE_LINK_MEDIA_TRANSFER_FAILED', 'DEVICE_LINK_MEDIA_ACCESS_DENIED', 'MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'REMOTE_FUTURE'])(
  'preserves retry for recoverable or unclassified %s', code => {
    expect(requiresAgentErrorConfigurationChange(`[${code}] diagnostic`)).toBe(false);
  },
);


describe.each(SUPPORTED_LOCALES)('WeChat auto-review guidance in %s', locale => {
  const message = '[AUTO_REVIEW_UNAVAILABLE] upstream diagnostic; api_key=private-test-value';

  it('asks for direct confirmation on live, tail, and history', async () => {
    await i18n.changeLanguage(locale);
    const wechatKey = 'session.remoteError.AUTO_REVIEW_UNAVAILABLE_WECHAT';
    const genericKey = 'session.remoteError.AUTO_REVIEW_UNAVAILABLE';
    expect(unclassifiedAgentErrorI18nKey(message, 'wechat')).toBe(wechatKey);
    expect(unclassifiedAgentErrorI18nKey(message, 'desktop')).toBe(genericKey);
    const [historical] = normalizeRemoteMessages([row(message)], { sessionSource: 'wechat' });
    expect(historical.body).toBe(i18n.t(wechatKey));
    expect(historical.body).not.toContain('Switch this task');
    expect(historical.errorSummaryKey).toBe(wechatKey);
    const state = resolveSessionTailBanner({
      messages: [row(message)],
      session: { source: 'wechat', activeTurnStartedAt: null, lastTurnEndedAt: null, clearedAt: null },
      projection: { error: null, credentialSwitchWait: null },
      isSessionStreaming: false,
      continuationInFlight: false,
      sessionMetadataSyncedForConnection: true,
      interruptAcked: false,
      hiddenErrorClientIds: new Set(),
    });
    expect(state?.kind).toBe('error-tail');
    if (state?.kind !== 'error-tail') return;
    expect(state.text).toBe(i18n.t(wechatKey));
    await act(async () => root.render(<InlineQueueSection
      projection={{ error: message, errorRetryText: 'original user message' } as InputProjection}
      sessionSource="wechat"
      readOnlyReason={null}
     
      onRetryError={vi.fn()}
      onClearError={vi.fn()}
      onResume={vi.fn()}
    />));
    expect(host.textContent).toContain(i18n.t(wechatKey));
    expect(host.textContent).not.toContain(i18n.t(genericKey));
  });
});
