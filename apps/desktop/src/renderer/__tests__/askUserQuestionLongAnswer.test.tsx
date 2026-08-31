// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

afterEach(() => {
  cleanup();
});

function renderAskUser(
  pending: PendingAskUser,
  onAnswer: (requestId: string, answers: Record<string, string>) => void,
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

function mockScrollHeight(textarea: HTMLTextAreaElement, height: number): void {
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    value: height,
  });
}

describe('AskUserQuestionPrompt long answers', () => {
  it('grows the custom-answer textarea and caps very long content with internal scrolling', async () => {
    const { getByPlaceholderText, getByText } = renderAskUser(
      {
        requestId: 'req-options',
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      vi.fn(),
    );

    fireEvent.click(getByText('Type something else…'));
    const textarea = getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');

    mockScrollHeight(textarea, 96);
    fireEvent.change(textarea, {
      target: { value: 'A long answer that wraps onto several lines' },
    });
    await waitFor(() => expect(textarea.style.height).toBe('96px'));
    expect(textarea.style.overflowY).toBe('hidden');

    mockScrollHeight(textarea, 260);
    fireEvent.change(textarea, {
      target: { value: 'An even longer answer that should stay inside the prompt card'.repeat(8) },
    });
    await waitFor(() => expect(textarea.style.height).toBe('148px'));
    expect(textarea.style.overflowY).toBe('auto');

    mockScrollHeight(textarea, 44);
    fireEvent.change(textarea, { target: { value: 'Short again' } });
    await waitFor(() => expect(textarea.style.height).toBe('44px'));
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('uses a multiline free-text editor where Shift+Enter adds a line and Enter submits', () => {
    const onAnswer = vi.fn();
    const { getByPlaceholderText } = renderAskUser(
      {
        requestId: 'req-free-text',
        questions: [{ question: 'Explain your decision' }],
      },
      onAnswer,
    );

    const textarea = getByPlaceholderText('Type your answer…') as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');
    fireEvent.change(textarea, { target: { value: 'First point\nSecond point' } });

    expect(fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledWith('req-free-text', {
      'Explain your decision': 'First point\nSecond point',
    });
  });

  it('submits selected options and a multiline custom answer with Enter in multi-select mode', () => {
    const onAnswer = vi.fn();
    const { getByPlaceholderText, getByText } = renderAskUser(
      {
        requestId: 'req-multi',
        questions: [
          {
            question: 'Choose details',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
      onAnswer,
    );

    fireEvent.click(getByText('A'));
    fireEvent.click(getByText('Type something else…'));
    const textarea = getByPlaceholderText('Type your answer…');
    fireEvent.change(textarea, { target: { value: 'Extra\ncontext' } });

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onAnswer).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAnswer).toHaveBeenCalledWith('req-multi', {
      'Choose details': JSON.stringify(['A', 'Extra\ncontext']),
    });
  });
});
