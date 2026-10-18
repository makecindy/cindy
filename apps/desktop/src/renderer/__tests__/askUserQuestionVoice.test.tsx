// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

const start = vi.fn(() => true);
const stop = vi.fn(async () => undefined);

// Stateful stand-in for the dictation hook: starting flips the card into the
// busy state, which is what disables question navigation.
vi.mock('../components/new-chat/useAskUserDictation', () => ({
  useAskUserDictation: () => {
    const [state, setState] = useState<'idle' | 'listening'>('idle');
    return {
      state,
      isBusy: state !== 'idle',
      liveText: null,
      lastError: null,
      start: () => {
        start();
        setState('listening');
        return true;
      },
      stop: async () => {
        await stop();
        setState('idle');
      },
    };
  },
}));

beforeEach(async () => {
  start.mockClear();
  stop.mockClear();
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
});

function renderAsk(questions: PendingAskUser['questions']) {
  const onAnswer = vi.fn();
  const view = render(createElement(AskUserQuestionPrompt, {
    sessionId: 'ask-voice',
    pending: { requestId: 'req-voice', questions },
    onAnswer,
    viewerState: 'expanded',
    onViewerStateChange: () => {},
    draft: null,
    onDraftChange: () => {},
  }));
  return { view, onAnswer };
}

describe('AskUserQuestion voice entry', () => {
  it('shows a voice button on the pinned free-text row and starts dictation from it', async () => {
    const { view } = renderAsk([
      { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ]);

    const voice = view.getByTestId('ask-user-voice');
    expect(voice.getAttribute('aria-label')).toContain('语音');
    fireEvent.click(voice);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(view.getByPlaceholderText('请输入回答…')).toBeTruthy();
  });

  it('keeps the voice button in the same bottom-pinned cluster as the send button', () => {
    const { view } = renderAsk([
      { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ]);
    fireEvent.click(view.getByText('输入其他回答…'));

    const voice = view.getByTestId('ask-user-voice');
    const cluster = voice.parentElement!;
    // Sharing one container is what keeps the two on the same center line as the
    // answer grows; self-end pins the pair to the row's bottom edge.
    expect(within(cluster).getByText('提交').tagName).toBe('BUTTON');
    expect(cluster.className).toContain('items-center');
    expect(cluster.className).toContain('self-end');
  });

  it('keeps a voice button when the question has no options', () => {
    const { view } = renderAsk([{ question: '补充一句' }]);
    const voice = view.getByTestId('ask-user-voice');
    expect(voice).toBeTruthy();
    expect(view.getByPlaceholderText('请输入回答…')).toBeTruthy();
    expect(within(voice.parentElement!).getByText('提交').tagName).toBe('BUTTON');
  });

  it('bottom-pins the voice button in multi-select where the row has no send button', () => {
    const { view } = renderAsk([
      { question: '选哪些？', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
    ]);
    fireEvent.click(view.getByText('输入其他回答…'));

    const voice = view.getByTestId('ask-user-voice');
    const cluster = voice.parentElement!;
    expect(within(cluster).queryByText('提交')).toBeNull();
    expect(cluster.className).toContain('self-end');
  });

  it('starts dictation from the global voice shortcut while the card is open', async () => {
    const previous = window.electronAPI;
    let trigger: ((payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void) | undefined;
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: typeof trigger) => {
          trigger = callback;
          return () => { trigger = undefined; };
        },
        claimGlobalShortcutTrigger: () => {},
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
    try {
      renderAsk([
        { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
      ]);
      trigger?.({ id: 'shortcut-1', phase: 'start' });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
    } finally {
      window.electronAPI = previous;
    }
  });

  it('does not stop the recording on the tap that ends the press which started it', async () => {
    const previous = window.electronAPI;
    let trigger: ((payload?: { id?: string; phase?: 'start' | 'tap' | 'end' }) => void) | undefined;
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: typeof trigger) => {
          trigger = callback;
          return () => { trigger = undefined; };
        },
        claimGlobalShortcutTrigger: () => {},
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
    try {
      renderAsk([{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]);
      trigger?.({ id: 'press-1', phase: 'start' });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());

      // Same press released quickly: `tap` must not cancel what `start` began.
      trigger?.({ id: 'press-1', phase: 'tap' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stop).not.toHaveBeenCalled();

      // A separate press while listening stops it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      trigger?.({ id: 'press-2', phase: 'tap' });
      await waitFor(() => expect(stop).toHaveBeenCalledOnce());
    } finally {
      window.electronAPI = previous;
    }
  });

  it('blocks question navigation and submit while dictation owns the answer', async () => {
    const { view } = renderAsk([
      { question: '第一题？', options: [{ label: '甲' }, { label: '乙' }] },
      { question: '第二题？', options: [{ label: '丙' }, { label: '丁' }] },
    ]);

    fireEvent.click(view.getByTestId('ask-user-voice'));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    // Switching questions mid-dictation would write the rest into another answer.
    for (const label of ['跳过', '下一题', '提交']) {
      const button = view.queryByText(label);
      if (button?.closest('button')) {
        expect((button.closest('button') as HTMLButtonElement).disabled).toBe(true);
      }
    }
    expect((view.getByText('跳过').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
