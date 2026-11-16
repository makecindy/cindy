// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { exists: (key: string) => key.startsWith('chat.remoteError.REMOTE_AGENT_'), language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ErrorMessageCard } from '@/components/chat/ErrorMessageCard';
import { UPSTREAM_STREAM_INTERRUPTED_REASON } from '@/utils/streamInterruptError';

const STREAM_RAW =
  'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}';

afterEach(cleanup);

describe('ErrorMessageCard', () => {
  // #10187, unit: persisted failures need the same specific recovery as live errors.
  it.each([
    ['LAZY_CREATE_FAILED: [REMOTE_AGENT_INVALID] this conversation cannot be resumed on this computer', 'REMOTE_AGENT_RESUME_UNAVAILABLE'],
    ['[REMOTE_AGENT_INVALID] invalid request', 'REMOTE_AGENT_INVALID'],
    ['[REMOTE_AGENT_INVALID] This conversation cannot be resumed on this computer.', 'REMOTE_AGENT_RESUME_UNAVAILABLE'],
  ])('preserves the cause of a persisted remote failure: %s', (message, code) => {
    render(<ErrorMessageCard message={message} />);
    expect(screen.getByText(`chat.remoteError.${code}`)).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.retry')).toBeNull();
  });

  // Unit: a persisted startup failure must retain the same cause as the live banner.
  it('shows the bound account limit with its reset time in history', () => {
    render(<ErrorMessageCard message={"LAZY_CREATE_FAILED: [SUBSCRIPTION_ACCOUNT_LIMITED] diagnostic\nresetAtMs=1900000000000"} />);
    expect(screen.getByText('chat.subscriptionAccountError.limitedUntil')).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.replyFailed')).toBeNull();
  });

  // Historical execution failures must offer the same diagnosis as live failures.
  it('offers diagnosis only after expanding a persisted execution error', () => {
    const onDiagnose = vi.fn();
    render(<ErrorMessageCard message="provider failed api_key=private-test-value" onDiagnose={onDiagnose} />);
    expect(screen.queryByText('chat.errorBanner.diagnose')).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.queryByText(/private-test-value/)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.diagnose'));
    expect(onDiagnose).toHaveBeenCalledWith(expect.objectContaining({ details: 'provider failed api_key=private-test-value' }));
  });
  it('shows a blocked input explanation directly without treating it as a failed reply', () => {
    const message = 'Please remove the credential before sending: api_key=private-test-value';
    render(createElement(ErrorMessageCard, { kind: 'blocked-input', message }));
    expect(screen.getByText('Please remove the credential before sending: api_key=[REDACTED]')).toBeTruthy();
    expect(screen.queryByText(/private-test-value/)).toBeNull();
    expect(screen.queryByText('chat.errorBanner.replyFailed')).toBeNull();
    expect(screen.queryByText('chat.errorBanner.networkShowRaw')).toBeNull();
  });

  it('uses the same model access guidance for persisted failures as the live banner', () => {
    render(createElement(ErrorMessageCard, {
      message: 'Failed to authenticate. API Error: 403 user not allowed to access model',
      reason: 'user_model_access_denied',
      providerId: 'custom-provider',
    }));
    expect(screen.getByText('chat.errorBanner.modelAccessDenied')).toBeTruthy();
    expect(screen.queryByText(/Failed to authenticate/)).toBeNull();
  });
  it('shows friendly stream-interrupt copy plus a raw-error expander', () => {
    render(
      createElement(ErrorMessageCard, {
        message: STREAM_RAW,
        reason: UPSTREAM_STREAM_INTERRUPTED_REASON,
      }),
    );

    expect(screen.getByText('chat.errorBanner.streamInterruptedNoRetry')).toBeTruthy();
    expect(screen.queryByText(STREAM_RAW)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(STREAM_RAW)).toBeTruthy();
  });

  it('localizes tool-loop terminal errors without exposing the internal category', () => {
    render(
      createElement(ErrorMessageCard, {
        message: '内部熔断详情：missing_required_field',
        reason: 'tool_use_loop_detected',
        toolLoop: { kind: 'contract', count: 3 },
      }),
    );

    expect(screen.getByText('logic.errors.toolUseLoopDetectedWithCount')).toBeTruthy();
    expect(screen.queryByText('内部熔断详情：missing_required_field')).toBeNull();
  });

  it('uses the count wording for consecutive-call loops', () => {
    render(
      createElement(ErrorMessageCard, {
        message: '内部熔断详情：consecutive',
        reason: 'tool_use_loop_detected',
        toolLoop: { kind: 'consecutive', count: 4 },
      }),
    );

    expect(screen.getByText('logic.errors.toolUseLoopDetectedConsecutiveWithCount')).toBeTruthy();
    expect(screen.queryByText('logic.errors.toolUseLoopDetectedWithCount')).toBeNull();
  });

  it('keeps unknown provider errors in details behind a localized summary', () => {
    const raw = 'OpenAI API error (400): invalid_prompt';
    render(createElement(ErrorMessageCard, { message: raw }));
    expect(screen.getByText('chat.errorBanner.replyFailed')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(raw)).toBeTruthy();
  });

  it('localizes LiteLLM envelopes and still offers the original', () => {
    const raw =
      'OpenAI API error (400): {"message":"litellm.BadRequestError: XaiException - too long"}';
    render(createElement(ErrorMessageCard, { message: raw }));
    expect(screen.getByText('chat.errorBanner.replyFailed')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(raw)).toBeTruthy();
  });

  it('shows the inner upstream message instead of the OpenAI JSON envelope', () => {
    const raw = `OpenAI API error (400): ${JSON.stringify({
      message: `litellm.BadRequestError: XaiException - ${JSON.stringify({
        error: {
          message: 'Upstream rejected the request!',
          type: 'invalid_request_error',
        },
      })}`,
      type: null,
      param: null,
      code: '400',
    })}`;
    render(createElement(ErrorMessageCard, { message: raw }));
    expect(screen.getByText('chat.errorBanner.replyFailed')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(raw)).toBeTruthy();
  });
});


describe('output-limit guidance', () => {
  it.each([131064, 1000])('renders reasoning-aware usage and guidance (%s)', (reasoningTokens) => {
    render(createElement(ErrorMessageCard, { message: 'limit', reason: 'output-limit', outputLimit: { outputTokens: 131072, reasoningTokens } }));
    const expected = reasoningTokens === 131064 ? 'logic.errors.outputLimitReasoning' : 'logic.errors.outputLimit';
    expect(screen.getByText(`logic.errors.outputLimitUsage ${expected}`)).toBeTruthy();
  });
});
