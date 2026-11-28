import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { localizeAgentError } from '@/session/agentErrorI18n';
import {
  buildMobileChatErrorExplain,
  resolveMobileErrorExplain,
  resolveMobileExternalProviderName,
} from '@/session/chatErrorExplain';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('mobile chatErrorExplain & provider attribution', () => {
  it('resolves external provider names while keeping Cindy AI (xd) generic', () => {
    expect(resolveMobileExternalProviderName({ providerId: 'anthropic' })).toBe('Anthropic');
    expect(resolveMobileExternalProviderName({ providerId: 'openai' })).toBe('OpenAI');
    expect(resolveMobileExternalProviderName({ providerId: 'xd', providerName: 'Cindy AI' })).toBeUndefined();
    expect(resolveMobileExternalProviderName({ providerId: 'custom', providerName: ' OpenRouter ' })).toBe('OpenRouter');
    expect(resolveMobileExternalProviderName({ providerId: 'custom', providerName: 'Cindy AI · 个人版' })).toBeUndefined();
    expect(resolveMobileExternalProviderName({ providerId: 'custom' })).toBeUndefined();
  });

  it('builds localized summaries and explanations across all 7 external/model error categories and failedSamplingAttempt', () => {
    const t = i18n.t.bind(i18n);

    expect(localizeAgentError('provider-safety-refusal', null, 'blocked', undefined, undefined, { providerId: 'anthropic' }))
      .toContain('Anthropic 的安全策略拦截了本次回复');
    expect(resolveMobileErrorExplain({ message: 'blocked', reason: 'provider-safety-refusal', providerId: 'anthropic' }, t))
      .toMatchObject({ title: '为什么回复被拦截', summary: expect.stringContaining('Anthropic') });

    expect(localizeAgentError('upstream-overload', null, '529 overloaded_error', undefined, undefined, { providerId: 'xd' }))
      .toContain('模型供应商暂时繁忙');
    expect(resolveMobileErrorExplain({ message: '529 overloaded_error', reason: 'upstream-overload', providerId: 'xd' }, t))
      .toMatchObject({ title: '为什么提示服务繁忙', summary: expect.stringContaining('模型供应商当前计算资源紧张') });

    expect(localizeAgentError('upstream-stream-interrupted', null, 'Response API in-stream error', undefined, undefined, { providerId: 'openai' }))
      .toContain('OpenAI 返回回复时中途中断');
    expect(resolveMobileErrorExplain({ message: 'Response API in-stream error', providerId: 'openai' }, t))
      .toMatchObject({ title: '为什么输出中途中断', summary: expect.stringContaining('OpenAI') });

    expect(localizeAgentError(null, null, '550 status code (no body)', undefined, undefined, { providerId: 'custom', providerName: 'OpenRouter' }))
      .toContain('OpenRouter 服务返回异常（HTTP 550）');
    expect(resolveMobileErrorExplain({ message: '550 status code (no body)', providerId: 'custom', providerName: 'OpenRouter' }, t))
      .toMatchObject({ title: '为什么返回服务异常', summary: expect.stringContaining('HTTP 550') });

    expect(localizeAgentError('user_model_access_denied', null, '403', undefined, undefined, { providerId: 'anthropic' }))
      .toContain('当前 Anthropic 账号无权访问此模型');
    expect(resolveMobileErrorExplain({ message: '403', reason: 'user_model_access_denied', providerId: 'anthropic' }, t))
      .toMatchObject({ title: '为什么无权访问此模型' });

    expect(localizeAgentError(null, null, 'insufficient_quota', undefined, undefined, { providerId: 'anthropic' }))
      .toContain('Anthropic 账户配额或余额不足');
    expect(resolveMobileErrorExplain({ message: 'insufficient_quota', providerId: 'anthropic' }, t))
      .toMatchObject({ title: '为什么提示配额或余额不足' });
    expect(resolveMobileErrorExplain({ message: 'insufficient_quota', providerId: 'xd' }, t)).toBeNull();

    expect(localizeAgentError('acp-usage-limit', null, 'limit', undefined, undefined, { providerId: 'openai' }))
      .toContain('OpenAI 账号已达到用量上限');
    expect(resolveMobileErrorExplain({ message: 'limit', reason: 'acp-usage-limit', providerId: 'openai' }, t))
      .toMatchObject({ title: '为什么达到用量上限' });

    expect(resolveMobileErrorExplain({ message: 'invalid_encrypted_content', providerId: 'openai' }, t))
      .toMatchObject({ title: '为什么无法读取部分历史内容', summary: expect.stringContaining('OpenAI') });

    expect(buildMobileChatErrorExplain('failedSamplingAttempt', t))
      .toMatchObject({ title: '为什么会显示未完成的回复' });
  });
});
