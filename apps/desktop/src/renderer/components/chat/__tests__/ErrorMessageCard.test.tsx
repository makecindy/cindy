// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ErrorMessageCard } from '@/components/chat/ErrorMessageCard';
import { UPSTREAM_STREAM_INTERRUPTED_REASON } from '@/utils/streamInterruptError';

const STREAM_RAW =
  'OpenAI API error (500): {"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}';

afterEach(cleanup);

describe('ErrorMessageCard', () => {
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

  it('keeps genuine OpenAI errors as-is without an expander', () => {
    const raw = 'OpenAI API error (400): invalid_prompt';
    render(createElement(ErrorMessageCard, { message: raw }));
    expect(screen.getByText(raw)).toBeTruthy();
    expect(screen.queryByText('chat.errorBanner.networkShowRaw')).toBeNull();
  });

  it('unwraps LiteLLM envelopes and still offers the original', () => {
    const raw =
      'OpenAI API error (400): {"message":"litellm.BadRequestError: XaiException - too long"}';
    render(createElement(ErrorMessageCard, { message: raw }));
    expect(screen.getByText('XaiException - too long')).toBeTruthy();
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
    expect(screen.getByText('Upstream rejected the request!')).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
    expect(screen.getByText(raw)).toBeTruthy();
  });
});
