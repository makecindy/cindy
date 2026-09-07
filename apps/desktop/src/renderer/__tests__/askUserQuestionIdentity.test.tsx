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

afterEach(() => cleanup());

function makeProps() {
  const pending: PendingAskUser = {
    requestId: 'request-1',
    questions: [
      { question: 'First question', options: [{ label: 'First option' }] },
      {
        question: 'Second question',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  };
  return {
    sessionId: 'session-1',
    pending,
    onAnswer: vi.fn(),
    viewerState: 'expanded' as const,
    onViewerStateChange: vi.fn(),
    draft: null,
    onDraftChange: vi.fn(),
  };
}

async function fillBothQuestions(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByText('Type something else…'));
  fireEvent.change(view.getByPlaceholderText('Type your answer…'), {
    target: { value: 'First draft answer' },
  });
  fireEvent.click(view.getByTestId('ask-user-custom-next'));
  await waitFor(() => expect(view.queryByText('Second question')).not.toBeNull());
  await waitFor(() => expect(view.queryByRole('button', { name: /Back/ })).not.toBeNull());
  fireEvent.click(view.getByText('A'));
  fireEvent.click(view.getByText('Type something else…'));
  const input = view.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Unsubmitted detail' } });
  return input;
}

describe('AskUserQuestionPrompt identity', () => {
  it('keeps text, selections and question progress when the same card is synchronized', async () => {
    const props = makeProps();
    const view = render(createElement(AskUserQuestionPrompt, props));
    const input = await fillBothQuestions(view);

    // The store keeps questions stable for an unchanged Host snapshot. Render
    // the real exported component; the test deliberately supplies no React key.
    view.rerender(createElement(AskUserQuestionPrompt, {
      ...props,
      pending: { ...props.pending },
    }));

    expect(view.getByPlaceholderText('Type your answer…')).toBe(input);
    expect(input.value).toBe('Unsubmitted detail');
    expect(view.queryByText('Second question')).not.toBeNull();
    expect(view.queryByText('2/2')).not.toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));
    expect(props.onAnswer).toHaveBeenCalledWith('request-1', {
      'First question': 'First draft answer',
      'Second question': JSON.stringify(['A', 'Unsubmitted detail']),
    });
  });

  it.each([
    { label: 'request', sessionId: 'session-1', requestId: 'request-2' },
    { label: 'session', sessionId: 'session-2', requestId: 'request-1' },
  ])('resets old answers when the $label changes without closing the card', async ({ sessionId, requestId }) => {
    const props = makeProps();
    const view = render(createElement(AskUserQuestionPrompt, props));
    const oldInput = await fillBothQuestions(view);
    props.onDraftChange.mockClear();

    // Even identical question text and array identity must not carry answers
    // into another request/session. A normal close/reopen is not involved.
    view.rerender(createElement(AskUserQuestionPrompt, {
      ...props,
      sessionId,
      pending: { ...props.pending, requestId },
    }));

    expect(oldInput.isConnected).toBe(false);
    expect(view.queryByText('First question')).not.toBeNull();
    expect(view.queryByText('1/2')).not.toBeNull();
    expect(view.queryByPlaceholderText('Type your answer…')).toBeNull();
    expect(props.onDraftChange).toHaveBeenCalledWith({ requestId, currentIndex: 0, answers: {} });

    fireEvent.click(view.getByText('First option'));
    await waitFor(() => expect(view.queryByText('Second question')).not.toBeNull());
    await waitFor(() => expect(view.queryByRole('button', { name: /Back/ })).not.toBeNull());
    expect(view.queryByPlaceholderText('Type your answer…')).toBeNull();
    expect((view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByText('B'));
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));
    expect(props.onAnswer).toHaveBeenCalledWith(requestId, {
      'First question': 'First option',
      'Second question': JSON.stringify(['B']),
    });
  });
});
