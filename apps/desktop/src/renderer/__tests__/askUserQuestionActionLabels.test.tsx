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
    expect(
      (view.getByRole('button', { name: 'Update & Next' }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(view.getByRole('button', { name: 'Update & Next' }));
    await waitFor(() => expect(view.queryByText('Second question')).not.toBeNull());
    await waitFor(() => expect(view.queryByRole('button', { name: /Back/ })).not.toBeNull());

    fireEvent.click(view.getByRole('button', { name: /Back/ }));
    await waitFor(() => expect(view.queryByText('First question')).not.toBeNull());
    await waitFor(() => expect(view.queryByRole('button', { name: 'Next' })).not.toBeNull());

    expect((view.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (view.getByRole('button', { name: 'Update & Next' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('uses Update & Submit for a custom answer on the final question', () => {
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
    fireEvent.click(view.getByRole('button', { name: 'Update & Submit' }));

    expect(onAnswer).toHaveBeenCalledWith('req-submit', {
      'Final question': 'Updated answer',
    });
  });

  it('provides localized prompt copy in every supported locale', () => {
    const expected = {
      en: ['Update & Next', 'Update & Submit'],
      'zh-CN': ['更新并继续', '更新并提交'],
      'zh-TW': ['更新並繼續', '更新並提交'],
      ja: ['更新して次へ', '更新して送信'],
      ko: ['수정 후 다음', '수정 후 제출'],
    } as const;

    for (const [locale, labels] of Object.entries(expected)) {
      expect(i18n.t('chat.askUserQuestion.updateAndNext', { lng: locale })).toBe(labels[0]);
      expect(i18n.t('chat.askUserQuestion.updateAndSubmit', { lng: locale })).toBe(labels[1]);
      expect(i18n.t('chat.askUserQuestion.customAnswer', { lng: locale })).not.toBe(
        'chat.askUserQuestion.customAnswer',
      );
      expect(i18n.t('chat.askUserQuestion.answerPlaceholder', { lng: locale })).not.toBe(
        'chat.askUserQuestion.answerPlaceholder',
      );
    }
  });
});
