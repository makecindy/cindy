// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

function renderAskUser(
  pending: PendingAskUser,
  onAnswer: (requestId: string, answers: Record<string, string>) => void = vi.fn(),
) {
  return render(
    createElement(AskUserQuestionPrompt, {
      pending,
      onAnswer,
      viewerState: 'expanded',
      onViewerStateChange: () => {},
      draft: null,
      onDraftChange: () => {},
    }),
  );
}

describe('AskUserQuestionPrompt action labels', () => {
  it('distinguishes updating an answer from keeping it when revisiting a middle question', async () => {
    const view = renderAskUser({
      requestId: 'req-revisit',
      questions: [
        { question: 'First question', options: [{ label: 'A' }] },
        { question: 'Second question', options: [{ label: 'B' }] },
      ],
    });

    fireEvent.click(view.getByText('Type something else…'));
    fireEvent.change(view.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Custom answer' },
    });
    expect((view.getByTestId('ask-user-custom-next') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(view.getByTestId('ask-user-custom-next'));
    await waitFor(() => expect(view.queryByText('Second question')).not.toBeNull());
    await waitFor(() => expect(view.queryByRole('button', { name: /Back/ })).not.toBeNull());

    fireEvent.click(view.getByRole('button', { name: /Back/ }));
    await waitFor(() => expect(view.queryByText('First question')).not.toBeNull());
    await waitFor(() => expect(view.queryByTestId('ask-user-custom-next')).not.toBeNull());

    expect((view.getByTestId('ask-user-custom-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses Submit for a custom answer on the final question without a footer duplicate', () => {
    const onAnswer = vi.fn();
    const view = renderAskUser(
      {
        requestId: 'req-submit',
        questions: [{ question: 'Final question', options: [{ label: 'A' }] }],
      },
      onAnswer,
    );

    fireEvent.click(view.getByText('Type something else…'));
    fireEvent.change(view.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Updated answer' },
    });
    expect(view.getAllByRole('button', { name: 'Submit' })).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));

    expect(onAnswer).toHaveBeenCalledWith('req-submit', {
      'Final question': 'Updated answer',
    });
  });

  it('does not show an inert footer Submit for an unanswered final single-select question', () => {
    const view = renderAskUser({
      requestId: 'req-final-unanswered',
      questions: [{ question: 'Final question', options: [{ label: 'A' }] }],
    });

    expect(view.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('keeps the footer Submit for a final multi-select question', () => {
    const onAnswer = vi.fn();
    const view = renderAskUser(
      {
        requestId: 'req-final-multi-select',
        questions: [
          {
            question: 'Final multi-select question',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
      onAnswer,
    );

    const submit = view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(view.getByText('A'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(onAnswer).toHaveBeenCalledWith('req-final-multi-select', {
      'Final multi-select question': '["A"]',
    });
  });

  it('provides localized prompt copy in every supported locale', () => {
    const expected = {
      en: ['Next', 'Submit'],
      'zh-CN': ['下一题', '提交'],
      'zh-TW': ['下一題', '提交'],
      ja: ['次へ', '送信'],
      ko: ['다음', '제출'],
    } as const;

    for (const [locale, labels] of Object.entries(expected)) {
      expect(i18n.t('chat.askUserQuestion.next', { lng: locale })).toBe(labels[0]);
      expect(i18n.t('chat.askUserQuestion.submit', { lng: locale })).toBe(labels[1]);
      expect(i18n.t('chat.askUserQuestion.customAnswer', { lng: locale })).not.toBe(
        'chat.askUserQuestion.customAnswer',
      );
      expect(i18n.t('chat.askUserQuestion.answerPlaceholder', { lng: locale })).not.toBe(
        'chat.askUserQuestion.answerPlaceholder',
      );
    }
  });
});
