// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SUPPORTED_LOCALES } from '../../../../shared/locale';
import es from '@/i18n/locales/es/common.json';
import fr from '@/i18n/locales/fr/common.json';
import de from '@/i18n/locales/de/common.json';
import ptPT from '@/i18n/locales/pt-PT/common.json';
import ptBR from '@/i18n/locales/pt-BR/common.json';
import lzh from '@/i18n/locales/zh-Hant-x-lzh/common.json';
import lzhHans from '@/i18n/locales/zh-Hans-x-lzh/common.json';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';

vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({ useCodexRuntimeRoute: () => ({ authInjection: 'env-key' }) }));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({ isCodexSessionExpiredError: () => false, useCodexSessionExpiredPrompt: () => vi.fn() }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [], refetch: vi.fn() }) }));
vi.mock('@/hooks/useCodexAuth', () => ({ useCodexAuth: () => ({ state: { kind: 'disconnected' } }), isChatGptConnectionConnected: () => false }));
import { ErrorBanner } from '../ErrorBanner';
import { ErrorMessageCard } from '../ErrorMessageCard';
import { ErrorTailErrorBanner } from '../InterruptedTurnBanner';
import { remoteErrorMessageForBanner } from '@/lib/makerChatStore';
import { buildErrorDiagnosisPrompt, prefillErrorDiagnosisDraft } from '@/lib/errorDiagnosisPrompt';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { getDraft as getNewMakerDraft, patchDraft } from '@/state/newMakerDraft';

const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, fr, de, 'pt-PT': ptPT, 'pt-BR': ptBR, 'zh-Hant-x-lzh': lzh, 'zh-Hans-x-lzh': lzhHans };
const raw = JSON.stringify({ error: {
  message: 'X-OpenAI-Internal-Codex-Responses-Lite requires `parallel_tool_calls` to be false.',
  type: 'invalid_request_error', code: 'unsupported_value', param: 'parallel_tool_calls',
} });
afterEach(cleanup);

it.each(['thread not found', 'app-server force-retired: auth changed'])(
  'retains the specific execution failure in details: %s',
  async (error) => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
    const onDiagnose = vi.fn();
    const onRetry = vi.fn();
    render(<I18nextProvider i18n={i18n}>
      <ErrorBanner agentKind="codex" error={error} onRetry={onRetry} onDiagnose={onDiagnose} />
    </I18nextProvider>);
    fireEvent.click(screen.getByText(en.chat.errorBanner.networkShowRaw));
    expect(screen.getByText(error)).toBeTruthy();
    fireEvent.click(screen.getByText(en.chat.errorBanner.diagnose));
    expect(onDiagnose).toHaveBeenCalledWith(expect.objectContaining({ details: error }));
    expect(onRetry).not.toHaveBeenCalled();
  },
);

// 诊断入口只在展开详情后出现；预填给新任务的提示带出错任务链接，且与详情同样脱敏。
it('offers diagnosis after expanding details with a redacted prompt for the failed session', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const onDiagnose = vi.fn();
  const error = 'Unexpected provider failure; api_key=private-test-value';
  render(<I18nextProvider i18n={i18n}><ErrorBanner error={error} onRetry={vi.fn()} onDiagnose={onDiagnose} /></I18nextProvider>);
  expect(screen.queryByText(en.chat.errorBanner.diagnose)).toBeNull();
  fireEvent.click(screen.getByText(en.chat.errorBanner.networkShowRaw));
  fireEvent.click(screen.getByText(en.chat.errorBanner.diagnose));
  const prompt = buildErrorDiagnosisPrompt(i18n.t, 'cindy://session/s1', { ...onDiagnose.mock.calls[0][0], reason: 'unexpected api_key=private-reason-value' });
  expect(prompt).toContain('cindy://session/s1');
  expect(prompt).toContain(en.chat.errorBanner.replyFailed);
  expect(prompt).toContain('Unexpected provider failure');
  expect(prompt).not.toContain('private-test-value');
  expect(prompt).toContain('reason: unexpected');
  expect(prompt).not.toContain('private-reason-value');
});

// 新建任务页已有未发送内容时，诊断预填只追加，不能丢掉用户的文字与附件。
it('appends the diagnosis prompt to an unsent new-task draft instead of replacing it', () => {
  const attachment = { id: 'a1', name: 'note.txt', path: '/tmp/note.txt' } as never;
  patchDraft({ workingDir: '/tmp/my-project', extraDirs: ['/tmp/extra'] });
  saveDraft(NEW_MAKER_DRAFT_KEY, { text: plainTextToTiptapDoc('我写到一半的内容'), attachments: [attachment], pendingGhostId: 'plugin-1' });
  prefillErrorDiagnosisDraft('请帮我诊断这个错误');
  const draft = getDraft(NEW_MAKER_DRAFT_KEY)!;
  const text = JSON.stringify(draft.text);
  expect(text.indexOf('我写到一半的内容')).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('请帮我诊断这个错误')).toBeGreaterThan(text.indexOf('我写到一半的内容'));
  expect(draft.attachments).toHaveLength(1);
  expect(draft.pendingGhostId).toBe('plugin-1');
  expect(getNewMakerDraft().workingDir).toBe('/tmp/my-project');
  expect(getNewMakerDraft().extraDirs).toEqual(['/tmp/extra']);
  clearDraft(NEW_MAKER_DRAFT_KEY);
  // 用户清空输入框后 Tiptap 仍留一个空段落：按空草稿处理，复位工作区目标，残留的目录授权不带进诊断任务。
  patchDraft({ workingDir: '/tmp/my-project', extraDirs: ['/tmp/extra'] });
  saveDraft(NEW_MAKER_DRAFT_KEY, { text: { type: 'doc', content: [{ type: 'paragraph' }] }, attachments: [] });
  prefillErrorDiagnosisDraft('请帮我诊断这个错误');
  expect(getNewMakerDraft().extraDirs).toEqual([]);
  expect(getNewMakerDraft().workingDir).toBeNull();
  clearDraft(NEW_MAKER_DRAFT_KEY);
});

describe.each(SUPPORTED_LOCALES)('error presentation in %s', locale => {
  it('builds a localized diagnosis without a task link for early execution failures', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, resources: { [locale]: { translation: locales[locale] } }, interpolation: { escapeValue: false } });
    const prompt = buildErrorDiagnosisPrompt(i18n.t, null, {
      message: 'Execution failed', details: 'runId: early-run; api_key=private-value',
    });
    expect(prompt).toContain('runId: early-run');
    expect(prompt).not.toMatch(/private-value|cindy:\/\/|\{\{|diagnosePromptWithoutSession/);
  });

  it('keeps the localized blocked-input fallback visible instead of a reply-failure summary', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(locales).map(([lng, common]) => [lng, { translation: common }])) });
    render(<I18nextProvider i18n={i18n}><ErrorMessageCard kind="blocked-input" message={i18n.t('chat.ghostHook.blockedFallback')} /></I18nextProvider>);
    expect(screen.getByText(locales[locale].chat.ghostHook.blockedFallback)).toBeTruthy();
    expect(screen.queryByText(locales[locale].chat.errorBanner.replyFailed)).toBeNull();
    expect(screen.queryByText(locales[locale].chat.errorBanner.networkShowRaw)).toBeNull();
  });

  it.each(['REMOTE_LOCAL_ONLY_PROVIDER', 'DEVICE_LINK_MEDIA_TRANSFER_FAILED', 'DEVICE_LINK_MEDIA_ACCESS_DENIED', 'DEVICE_LINK_BUSY', 'MCP_APPROVAL_CONFIRMATION_TIMEOUT', 'SSH_HARNESS_SWITCH_UNSUPPORTED', 'MODEL_SELECTION_UNAVAILABLE', 'HARNESS_SWITCH_NOT_READY'])('preserves curated %s guidance and follows language changes', async code => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(locales).map(([lng, common]) => [lng, { translation: common }])) });
    const message = `Error invoking remote method device-link:invoke: Error: [${code}] upstream fallback api_key=private-test-value`;
    render(<I18nextProvider i18n={i18n}><ErrorMessageCard message={message} /></I18nextProvider>);
    const expected = locales[locale].chat.remoteError[code as keyof typeof en.chat.remoteError];
    expect(typeof expected).toBe('string');
    expect(screen.getByText(code === 'DEVICE_LINK_MEDIA_ACCESS_DENIED'
      ? i18n.t('chat.errorBanner.attachmentAccessDeniedRecovery') : expected)).toBeTruthy();
    expect(screen.queryByText(i18n.t('chat.errorBanner.replyFailed'))).toBeNull();
    expect(screen.queryByText(/upstream fallback/)).toBeNull();
    fireEvent.click(screen.getByText(i18n.t('chat.errorBanner.networkShowRaw')));
    expect(screen.getByText(/upstream fallback/).textContent).toContain('[REDACTED]');
    expect(screen.queryByText(/private-test-value/)).toBeNull();
    const next = locale === 'en' ? 'ja' : 'en';
    await act(async () => { await i18n.changeLanguage(next); });
    expect(screen.getByText(i18n.t(code === 'DEVICE_LINK_MEDIA_ACCESS_DENIED'
      ? 'chat.errorBanner.attachmentAccessDeniedRecovery' : `chat.remoteError.${code}`))).toBeTruthy();
    expect(screen.queryByText(locales[locale].chat.remoteError[code as keyof typeof en.chat.remoteError])).toBeNull();
  });

  // #6530 real-device gap: recovery must be visible before expanding details on every desktop surface.
  it.each(['live', 'tail', 'history'] as const)('shows attachment recovery outside details on %s', async surface => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(locales).map(([lng, common]) => [lng, { translation: common }])) });
    const error = '[DEVICE_LINK_MEDIA_ACCESS_DENIED] Cannot read the source attachment.';
    render(<I18nextProvider i18n={i18n}>{surface === 'live'
      ? <ErrorBanner error={error} onRetry={vi.fn()} />
      : surface === 'tail'
        ? <ErrorTailErrorBanner errorText={error} onContinue={vi.fn()} onDismiss={vi.fn()} />
        : <ErrorMessageCard message={error} />}</I18nextProvider>);
    expect(screen.getByText(i18n.t('chat.errorBanner.attachmentAccessDeniedTitle'))).toBeTruthy();
    expect(screen.getByText(i18n.t('chat.errorBanner.attachmentAccessDeniedRecovery'))).toBeTruthy();
    expect(screen.getByText(i18n.t('chat.errorBanner.networkShowRaw')).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(i18n.t('chat.errorBanner.replyFailed'))).toBeNull();
    expect(screen.queryByText(error)).toBeNull();
  });

  it.each(['live', 'tail'] as const)('keeps known remote recovery guidance in the %s banner across language changes', async surface => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(locales).map(([lng, common]) => [lng, { translation: common }])) });
    const code = 'REMOTE_LOCAL_ONLY_PROVIDER';
    const rawRemoteError = `[${code}] upstream HTTP 502 api_key=private-test-value`;
    const bannerError = remoteErrorMessageForBanner(rawRemoteError);
    expect(bannerError).toContain(`[${code}]`);
    render(<I18nextProvider i18n={i18n}>{surface === 'live'
      ? <ErrorBanner error={bannerError} onRetry={vi.fn()} />
      : <ErrorTailErrorBanner errorText={bannerError} onContinue={vi.fn()} onDismiss={vi.fn()} />}</I18nextProvider>);
    expect(screen.getByText(locales[locale].chat.remoteError[code])).toBeTruthy();
    expect(screen.queryByText(locales[locale].chat.errorBanner.replyFailed)).toBeNull();
    expect(screen.queryByText(rawRemoteError)).toBeNull();
    fireEvent.click(screen.getByText(locales[locale].chat.errorBanner.networkShowRaw));
    expect(screen.getByText(/upstream HTTP 502/).textContent).toContain('[REDACTED]');
    expect(screen.queryByText(/private-test-value/)).toBeNull();
    const next = locale === 'en' ? 'ja' : 'en';
    await act(async () => { await i18n.changeLanguage(next); });
    expect(screen.getByText(locales[next].chat.remoteError[code])).toBeTruthy();
    expect(screen.queryByText(locales[locale].chat.remoteError[code])).toBeNull();
  });

  it('does not mistake an unknown remote-code fallback for localized guidance', async () => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: { [locale]: { translation: locales[locale] } } });
    render(<I18nextProvider i18n={i18n}><ErrorMessageCard message="[REMOTE_UNKNOWN] Arbitrary English diagnostics" /></I18nextProvider>);
    expect(screen.getByText(locales[locale].chat.errorBanner.replyFailed)).toBeTruthy();
    expect(screen.queryByText(/Arbitrary English/)).toBeNull();
  });

  it.each(['live', 'tail', 'history'] as const)('localizes %s and keeps diagnostics collapsed, with existing recovery', async surface => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(locales).map(([lng, common]) => [lng, { translation: common }])) });
    const retry = vi.fn();
    render(<I18nextProvider i18n={i18n}>{surface === 'live'
      ? <ErrorBanner error={raw} retryText="original-welcome" onRetry={retry} />
      : surface === 'tail'
        ? <ErrorTailErrorBanner errorText={raw} onContinue={retry} onDismiss={vi.fn()} />
        : <ErrorMessageCard message={raw} />}</I18nextProvider>);
    const copy = locales[locale].chat.errorBanner;
    expect(screen.getByText(copy.requestFormatError)).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(copy.networkShowRaw));
    expect(screen.getByText(raw)).toBeTruthy();
    fireEvent.click(screen.getByText(copy.networkHideRaw));
    expect(screen.queryByText(raw)).toBeNull();
    if (surface !== 'history') {
      fireEvent.click(screen.getByTitle(copy.retryTitle));
      expect(retry).toHaveBeenCalledTimes(1);
      if (surface === 'live') expect(retry).toHaveBeenCalledWith('original-welcome');
    }
    const next = locale === 'en' ? 'ja' : 'en';
    await act(async () => { await i18n.changeLanguage(next); });
    expect(screen.getByText(locales[next].chat.errorBanner.requestFormatError)).toBeTruthy();
    expect(screen.getByText(locales[next].chat.errorBanner.networkShowRaw)).toBeTruthy();
  });

  it.each(['live', 'history'] as const)('hides unknown English errors and redacts details in %s', async surface => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: { [locale]: { translation: locales[locale] } } });
    const error = 'Unexpected provider failure; api_key=private-test-value';
    render(<I18nextProvider i18n={i18n}>{surface === 'live'
      ? <ErrorBanner error={error} onRetry={vi.fn()} />
      : <ErrorMessageCard message={error} />}</I18nextProvider>);
    expect(screen.getByText(locales[locale].chat.errorBanner.replyFailed)).toBeTruthy();
    expect(screen.queryByText(/Unexpected provider/)).toBeNull();
    fireEvent.click(screen.getByText(locales[locale].chat.errorBanner.networkShowRaw));
    expect(screen.getByText(/Unexpected provider failure/).textContent).toContain('[REDACTED]');
    expect(screen.queryByText(/private-test-value/)).toBeNull();
  });

  it.each(['live', 'tail', 'history'] as const)('asks a WeChat task to confirm directly in %s', async surface => {
    const i18n = createInstance();
    await i18n.init({ lng: locale, fallbackLng: 'en', resources: Object.fromEntries(Object.entries(locales).map(([lng, common]) => [lng, { translation: common }])) });
    const rawRemoteError = '[AUTO_REVIEW_UNAVAILABLE] upstream fallback api_key=private-test-value';
    const bannerError = remoteErrorMessageForBanner(rawRemoteError);
    const generic = locales[locale].chat.remoteError.AUTO_REVIEW_UNAVAILABLE;
    const wechat = locales[locale].chat.remoteError.AUTO_REVIEW_UNAVAILABLE_WECHAT;
    const renderSurface = (sessionSource?: string) => {
      cleanup();
      render(<I18nextProvider i18n={i18n}>{surface === 'live'
        ? <ErrorBanner error={bannerError} sessionSource={sessionSource} onRetry={vi.fn()} />
        : surface === 'tail'
          ? <ErrorTailErrorBanner errorText={bannerError} sessionSource={sessionSource} onContinue={vi.fn()} onDismiss={vi.fn()} />
          : <ErrorMessageCard message={rawRemoteError} sessionSource={sessionSource} />}</I18nextProvider>);
    };
    renderSurface('desktop');
    expect(screen.getByText(generic)).toBeTruthy();
    expect(screen.queryByText(wechat)).toBeNull();
    renderSurface('wechat');
    expect(screen.getByText(wechat)).toBeTruthy();
    expect(screen.queryByText(generic)).toBeNull();
    expect(screen.queryByText(/Switch this task/)).toBeNull();
  });
});
