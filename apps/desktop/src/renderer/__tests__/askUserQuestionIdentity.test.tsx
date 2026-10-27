// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { AskUserQuestionItem, PendingAskUser } from '@/lib/makerChatStore';
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
  it.each([
    { label: 'single-select custom answer', options: [{ label: 'A' }], multiSelect: false },
    { label: 'multi-select custom answer', options: [{ label: 'A' }], multiSelect: true },
    { label: 'direct answer', options: [], multiSelect: false },
    { label: 'direct multi-select answer', options: [], multiSelect: true },
  ])('retains the final $label until acknowledged, including across remounts', ({ options, multiSelect }) => {
    const props = {
      ...makeProps(),
      pending: { requestId: 'request-1', questions: [{ question: 'Final?', options, multiSelect }] },
      draft: { requestId: 'request-1', currentIndex: 0, answers: {}, started: true,
        customInput: 'Keep this answer', showCustomInput: true, selectedLabels: [] },
    };
    const view = render(createElement(AskUserQuestionPrompt, props));
    fireEvent.click(view.getAllByRole('button', { name: 'Submit' })[0]);
    // A failed/unconfirmed submission keeps the card mounted. No acknowledgement
    // means the visible field and the persisted draft must both remain retryable.
    expect((view.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement).value).toBe('Keep this answer');
    const draft = props.onDraftChange.mock.lastCall?.[0];
    expect(draft).toMatchObject({ customInput: 'Keep this answer', showCustomInput: true });
    view.unmount();
    const restored = render(createElement(AskUserQuestionPrompt, { ...props, draft }));
    fireEvent.click(restored.getAllByRole('button', { name: 'Submit' })[0]);
    expect(props.onAnswer).toHaveBeenCalledTimes(2);
    expect(props.onAnswer).toHaveBeenLastCalledWith('request-1', {
      'Final?': multiSelect ? JSON.stringify(['Keep this answer']) : 'Keep this answer',
    });
  });

  it('starts protection on IME composition, but not focus or opening the text field', () => {
    const props = makeProps();
    const view = render(createElement(AskUserQuestionPrompt, props));
    fireEvent.click(view.getByText('Type something else…'));
    const input = view.getByPlaceholderText('Type your answer…');
    fireEvent.focus(input);
    expect(props.onDraftChange.mock.lastCall?.[0]?.started).not.toBe(true);
    fireEvent.compositionStart(input);
    expect(props.onDraftChange.mock.lastCall?.[0]?.started).toBe(true);
    fireEvent.change(input, { target: { value: '正在输入' } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(props.onDraftChange.mock.lastCall?.[0]).toMatchObject({ started: true, customInput: '' });
  });

  it('restores an unfinished field after leaving and returning to the task', () => {
    const props = makeProps();
    const view = render(createElement(AskUserQuestionPrompt, props));
    fireEvent.click(view.getByText('Type something else…'));
    fireEvent.change(view.getByPlaceholderText('Type your answer…'), { target: { value: 'Not finished' } });
    const draft = props.onDraftChange.mock.lastCall?.[0];
    view.unmount();
    const restored = render(createElement(AskUserQuestionPrompt, { ...props, draft }));
    expect((restored.getByPlaceholderText('Type your answer…') as HTMLTextAreaElement).value).toBe('Not finished');
  });

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
    { label: 'question text', update: { question: 'Updated second question' } },
    { label: 'options', update: { options: [{ label: 'C' }] } },
    { label: 'selection mode', update: { multiSelect: false } },
    { label: 'header', update: { header: 'Updated header' } },
    { label: 'option description', update: { options: [{ label: 'A', description: 'Updated meaning' }, { label: 'B' }] } },
    { label: 'question count', update: null },
  ])('resets answers when $label changes within the same request', async ({ update }) => {
    const props = makeProps();
    const view = render(createElement(AskUserQuestionPrompt, props));
    const oldInput = await fillBothQuestions(view);
    props.onDraftChange.mockClear();
    const questions: AskUserQuestionItem[] = update
      ? [props.pending.questions[0], { ...props.pending.questions[1], ...update }]
      : [props.pending.questions[0]];

    // The store clears the draft for changed content, even with the same requestId.
    view.rerender(createElement(AskUserQuestionPrompt, {
      ...props,
      pending: { ...props.pending, questions },
    }));

    expect(oldInput.isConnected).toBe(false);
    expect(view.queryByText('First question')).not.toBeNull();
    expect(view.queryByPlaceholderText('Type your answer…')).toBeNull();
    expect(props.onDraftChange).toHaveBeenLastCalledWith({
      requestId: 'request-1', currentIndex: 0, answers: {},
      started: false, customInput: '', selectedLabels: [], showCustomInput: false,
    });

    fireEvent.click(view.getByText('First option'));
    const expectedAnswers: Record<string, string> = { 'First question': 'First option' };
    if (questions.length > 1) {
      const second = questions[1];
      await waitFor(() => expect(view.queryByText(second.question)).not.toBeNull());
      await waitFor(() => expect(view.queryByRole('button', { name: /Back/ })).not.toBeNull());
      const label = second.options![0].label;
      fireEvent.click(view.getByText(label));
      if (second.multiSelect) fireEvent.click(view.getByRole('button', { name: 'Submit' }));
      expectedAnswers[second.question] = second.multiSelect ? JSON.stringify([label]) : label;
    }
    expect(props.onAnswer).toHaveBeenCalledWith('request-1', expectedAnswers);
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
    expect(props.onDraftChange).toHaveBeenCalledWith({ requestId, currentIndex: 0, answers: {},
      started: false, customInput: '', selectedLabels: [], showCustomInput: false });

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
