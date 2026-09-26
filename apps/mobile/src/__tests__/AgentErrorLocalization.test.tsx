// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { parseAgentErrorCode } from '@cindy/maker-shared/error-redaction';
import { unclassifiedAgentErrorI18nKey, requiresAgentErrorConfigurationChange } from '@/session/agentErrorI18n';
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

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = (tag: string) => ({ children, onPress, disabled, testID, accessibilityState }: {
    children?: ReactNode; onPress?: () => void; disabled?: boolean; testID?: string; accessibilityState?: { expanded?: boolean };
  }) => createElement(tag, { onClick: onPress, disabled, 'data-testid': testID, 'aria-expanded': accessibilityState?.expanded }, children);
  return { View: view('div'), Text: view('span'), Pressable: view('button'), ActivityIndicator: () => null,
    StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 } };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Pause: () => null, Play: () => null }));
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

describe.each(SUPPORTED_LOCALES)('mobile errors in %s', locale => {
  it.each(['live', 'tail'] as const)('localizes %s, preserves retry and switches locale without another request', async surface => {
    await i18n.changeLanguage(locale);
    for (const key of ['requestFormatError', 'replyFailed', 'showErrorDetails', 'hideErrorDetails', 'retry']) {
      expect(i18n.getResource(locale, 'common', `session.tail.${key}`)).toBeTypeOf('string');
    }
    const retry = vi.fn();
    const state = resolveSessionTailBanner({ messages: [row(raw)], session: null, projection: { error: null, credentialSwitchWait: null }, isSessionStreaming: false, continuationInFlight: false, sessionMetadataSyncedForConnection: true, interruptAcked: false, hiddenErrorClientIds: new Set() });
    expect(state?.kind).toBe('error-tail');
    await act(async () => root.render(surface === 'live'
      ? <InlineQueueSection projection={{ error: raw, errorRetryText: 'original-welcome' } as InputProjection} readOnlyReason={null} errorRecoveryReadOnlyReason={null} onRetryError={retry} onClearError={vi.fn()} onResume={vi.fn()} />
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

  it.each(['REMOTE_LOCAL_ONLY_PROVIDER', 'DEVICE_LINK_MEDIA_TRANSFER_FAILED', 'MCP_APPROVAL_CONFIRMATION_TIMEOUT'])(
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
          ? <InlineQueueSection projection={{ error: message, errorRetryText: 'original user message' } as InputProjection} readOnlyReason={null} errorRecoveryReadOnlyReason={null} onRetryError={retry} onClearError={clear} onResume={vi.fn()} />
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
it.each(['REMOTE_DAEMON_CLOSED', 'REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE', 'DEVICE_LINK_MEDIA_TRANSFER_FAILED', 'MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'REMOTE_FUTURE'])(
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
      errorRecoveryReadOnlyReason={null}
      onRetryError={vi.fn()}
      onClearError={vi.fn()}
      onResume={vi.fn()}
    />));
    expect(host.textContent).toContain(i18n.t(wechatKey));
    expect(host.textContent).not.toContain(i18n.t(genericKey));
  });
});
