// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import { resolveExternalErrorProviderName } from '@/lib/chatErrorExplain';
import { UPSTREAM_OVERLOAD_REASON } from '@/utils/overloadError';
import { UPSTREAM_STREAM_INTERRUPTED_REASON } from '@/utils/streamInterruptError';

const { providersMock } = vi.hoisted(() => ({
  providersMock: vi.fn<() => Array<{ id: string; name: string; auth: { native?: string } }>>(() => []),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: 'env-key' }),
}));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  isCodexSessionExpiredError: () => false,
  useCodexSessionExpiredPrompt: () => vi.fn(),
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersMock(), refetch: vi.fn() }),
}));
vi.mock('@/hooks/useCodexAuth', () => ({
  useCodexAuth: () => ({ state: { kind: 'disconnected' } }),
  isChatGptConnectionConnected: () => false,
}));

import { ErrorBanner } from '../ErrorBanner';
import { ErrorMessageCard } from '../ErrorMessageCard';
import { FailedSamplingNotice } from '../FailedSamplingNotice';

async function createZhI18n() {
  const i18n = createInstance();
  await i18n.init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

afterEach(() => {
  cleanup();
  providersMock.mockReturnValue([]);
});

describe('resolveExternalErrorProviderName', () => {
  it('names official Anthropic/OpenAI and explicit third-party providers while falling back for Cindy AI and unknown IDs', () => {
    const providers = [
      { id: 'claude-work', name: 'Anthropic · dash@company.com', auth: { native: 'claude' } },
      { id: 'codex-work', name: 'OpenAI · dash@company.com', auth: { native: 'codex' } },
      { id: 'openrouter', name: ' OpenRouter ', auth: {} },
      { id: 'xd', name: 'Cindy AI · 个人版', auth: {} },
      { id: 'cindy-mirror', name: 'Cindy AI', auth: {} },
    ];
    expect(resolveExternalErrorProviderName({ providerId: 'anthropic', providers })).toBe('Anthropic');
    expect(resolveExternalErrorProviderName({ providerId: 'openai', providers })).toBe('OpenAI');
    expect(resolveExternalErrorProviderName({ providerId: 'claude-work', providers })).toBe('Anthropic');
    expect(resolveExternalErrorProviderName({ providerId: 'codex-work', providers })).toBe('OpenAI');
    expect(resolveExternalErrorProviderName({ providerId: 'openrouter', providers })).toBe('OpenRouter');
    expect(resolveExternalErrorProviderName({ providerId: 'xd', providers })).toBeUndefined();
    expect(resolveExternalErrorProviderName({ providerId: 'cindy-mirror', providers })).toBeUndefined();
    expect(resolveExternalErrorProviderName({ providerId: 'unknown-id', providers })).toBeUndefined();
  });
});

describe('ErrorBanner & ErrorMessageCard provider attribution + explain popover', () => {
  it('names external provider and opens explain popover for safety refusal, overload, stream interrupt, 5xx, access denied, quota, usage limit, and encrypted content', async () => {
    const i18n = await createZhI18n();
    providersMock.mockReturnValue([
      { id: 'openrouter', name: 'OpenRouter', auth: {} },
    ]);

    const cases: Array<{
      name: string;
      error: string;
      reason?: string;
      agentKind?: 'cc' | 'codex' | 'pi';
      providerId: string;
      expectedHeadline: string;
      expectedTitle: string;
      expectedSummaryPart: string;
    }> = [
      {
        name: 'safety refusal',
        error: 'This request was flagged for possible cybersecurity risk.',
        reason: 'provider-safety-refusal',
        providerId: 'anthropic',
        expectedHeadline: 'Anthropic 的安全策略拦截了本次回复。如需继续，请调整请求内容后再发送',
        expectedTitle: '为什么回复被拦截',
        expectedSummaryPart: 'Anthropic 内置的安全与内容策略',
      },
      {
        name: 'overload',
        error: 'overloaded_error (529)',
        reason: UPSTREAM_OVERLOAD_REASON,
        providerId: 'anthropic',
        expectedHeadline: 'Anthropic 暂时繁忙，当前没有可用容量。可稍后重试，或换一个模型。',
        expectedTitle: '为什么提示服务繁忙',
        expectedSummaryPart: 'Anthropic 当前计算资源紧张',
      },
      {
        name: 'stream interrupted',
        error: 'Response API in-stream error',
        reason: UPSTREAM_STREAM_INTERRUPTED_REASON,
        providerId: 'openrouter',
        expectedHeadline: 'OpenRouter 返回回复时中途中断，请稍后重试。',
        expectedTitle: '为什么输出中途中断',
        expectedSummaryPart: 'OpenRouter 在流式返回结果的过程中意外断开了连接',
      },
      {
        name: 'upstream 5xx',
        error: '550 status code (no body)',
        providerId: 'openrouter',
        expectedHeadline: 'OpenRouter 服务返回异常（HTTP 550），本次回复未完成。',
        expectedTitle: '为什么返回服务异常',
        expectedSummaryPart: 'OpenRouter 服务返回了 HTTP 550 内部错误',
      },
      {
        name: 'model access denied',
        error: '403 user not allowed to access model',
        reason: 'user_model_access_denied',
        providerId: 'anthropic',
        expectedHeadline: '当前 Anthropic 账号无权访问此模型。请切换模型，或确认模型访问权限',
        expectedTitle: '为什么无权访问此模型',
        expectedSummaryPart: 'Anthropic 拒绝了当前账号对该模型的访问请求',
      },
      {
        name: 'external quota exceeded',
        error: 'insufficient_quota',
        providerId: 'openrouter',
        expectedHeadline: 'OpenRouter 账户配额或余额不足，请检查账户状态',
        expectedTitle: '为什么提示配额或余额不足',
        expectedSummaryPart: '你连接的 OpenRouter 账户可用余额或配额已耗尽',
      },
      {
        name: 'usage limit reached',
        error: 'Individual quota reached.',
        reason: 'acp-usage-limit',
        providerId: 'anthropic',
        expectedHeadline: 'Anthropic 账号已达到用量上限。请等待用量上限重置，或切换其他模型后再重试。',
        expectedTitle: '为什么达到用量上限',
        expectedSummaryPart: '当前连接的 Anthropic 账号已触发 Anthropic 设定的周期用量窗口上限',
      },
      {
        name: 'encrypted content',
        error: 'invalid_encrypted_content',
        agentKind: 'codex',
        providerId: 'openai',
        expectedHeadline: 'OpenAI 无法读取部分历史内容。可切回原供应商，或在新任务中继续。',
        expectedTitle: '为什么无法读取部分历史内容',
        expectedSummaryPart: 'OpenAI 可能无法读取旧加密片段',
      },
    ];

    for (const c of cases) {
      cleanup();
      render(
        <I18nextProvider i18n={i18n}>
          <ErrorBanner
            error={c.error}
            errorReason={c.reason}
            agentKind={c.agentKind ?? 'cc'}
            providerId={c.providerId}
            errorSourceProviderId={c.providerId}
            onRetry={vi.fn()}
          />
        </I18nextProvider>,
      );
      expect(screen.getByText(c.expectedHeadline), `${c.name} headline`).toBeTruthy();
      fireEvent.click(screen.getByTestId('notice-explain-trigger'));
      const popover = screen.getByTestId('notice-explain-popover');
      expect(popover.textContent, `${c.name} popover title`).toContain(c.expectedTitle);
      expect(popover.textContent, `${c.name} popover summary`).toContain(c.expectedSummaryPart);
    }
  });

  it('uses generic model-provider copy when routed via xd (Cindy AI) and omits external quota explanation on xd', async () => {
    const i18n = await createZhI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <ErrorBanner
          error="overloaded_error (529)"
          errorReason={UPSTREAM_OVERLOAD_REASON}
          providerId="xd"
          errorSourceProviderId="xd"
          onRetry={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('模型供应商暂时繁忙，当前没有可用容量。可稍后重试，或换一个模型。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('notice-explain-trigger'));
    expect(screen.getByTestId('notice-explain-popover').textContent).toContain('模型供应商当前计算资源紧张');

    cleanup();
    render(
      <I18nextProvider i18n={i18n}>
        <ErrorBanner
          error="insufficient_quota"
          providerId="xd"
          errorSourceProviderId="xd"
          onRetry={vi.fn()}
        />
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('notice-explain-trigger')).toBeNull();
  });

  it('attaches explain popover to persisted ErrorMessageCard and FailedSamplingNotice', async () => {
    const i18n = await createZhI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <ErrorMessageCard
          message="550 status code (no body)"
          providerId="anthropic"
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('Anthropic 服务返回异常（HTTP 550），本次回复未完成。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('notice-explain-trigger'));
    expect(screen.getByTestId('notice-explain-popover').textContent).toContain('HTTP 550');

    cleanup();
    render(
      <I18nextProvider i18n={i18n}>
        <FailedSamplingNotice />
      </I18nextProvider>,
    );
    expect(screen.getByText('此回复未完成，内容仅供参考。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('notice-explain-trigger'));
    expect(screen.getByTestId('notice-explain-popover').textContent).toContain('为什么会显示未完成的回复');
  });
});
