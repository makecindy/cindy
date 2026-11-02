// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import i18n from '@/i18n';
import type { AskUserQuestionItem, PendingAskUser } from '@/lib/makerChatStore';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

import type { VoiceQuestionBridge } from '../components/new-chat/voiceQuestionSelection';

const start = vi.fn(() => true);
const stop = vi.fn(async () => true);
const cancel = vi.fn(async () => undefined);
let finalTranscript = '完整回答';
let idleBeforeStop = false;

// Stateful stand-in for the dictation hook: starting flips the card into the
// busy state, which is what disables question navigation.
vi.mock('../components/new-chat/useAskUserDictation', () => ({
  useAskUserDictation: (target: { setText: (text: string) => void }) => {
    const [state, setState] = useState<'idle' | 'listening'>('idle');
    return {
      state,
      captureReady: true,
      isBusy: state === 'listening',
      liveText: null,
      lastError: null,
      start: () => {
        start();
        setState('listening');
        return true;
      },
      stop: async () => {
        if (idleBeforeStop) setState('idle');
        const ok = await stop();
        if (ok) target.setText(finalTranscript);
        setState('idle');
        return ok;
      },
      cancel: async () => { await cancel(); setState('idle'); },
    };
  },
}));

beforeEach(async () => {
  start.mockClear();
  cancel.mockClear();
  stop.mockReset().mockResolvedValue(true);
  finalTranscript = '完整回答';
  idleBeforeStop = false;
  await i18n.changeLanguage('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
  // Unit: real answer field/gesture; previous card tests covered only mic
  // clicks. Holding must share composer semantics without hijacking selection.
  // PR #7438: native selected-text drags can omit subsequent pointer events.
  it('records on hold, stops on release, and leaves ordinary drag selection alone', async () => {
    vi.useFakeTimers();
    const previous = window.electronAPI;
    let micGranted = false;
    window.electronAPI = {
      voiceInput: { getMicrophonePermissionCached: () => ({ ok: micGranted, status: 'not-determined' }) },
    } as unknown as typeof window.electronAPI;
    onTestFinished(() => { window.electronAPI = previous; });
    const { view, onAnswer } = renderAsk([{ question: '回答？' }]);
    const input = view.getByRole('textbox');
    // 2026-10-30: before the microphone is authorized a hold is an ordinary press.
    fireEvent.pointerDown(input, { button: 0, pointerId: 9 });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(start).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 9 });
    micGranted = true;
    fireEvent.change(input, { target: { value: '已有回答' } });
    (input as HTMLTextAreaElement).setSelectionRange(0, 2);
    fireEvent.pointerDown(input, { button: 0, pointerId: 0 });
    expect(fireEvent.dragStart(input)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(start).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe('已有回答');
    fireEvent.pointerDown(input, { button: 0, pointerId: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(start).toHaveBeenCalledOnce();
    expect(fireEvent.dragStart(input)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1 });
    await act(async () => {});
    expect(stop).toHaveBeenCalledOnce();
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.pointerDown(input, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 20, clientY: 0 });
    await act(async () => { await vi.advanceTimersByTimeAsync(650); });
    expect(start).toHaveBeenCalledOnce();
  });

  // #8232, unit: real card listener, with a foreground document and a busy
  // dictation session. Existing Escape coverage had no covered-card case.
  it('preserves answer dictation while a Markdown preview owns Escape', async () => {
    const { view, onAnswer } = renderAsk([{ question: '回答？' }]);
    const input = view.getByRole('textbox');
    fireEvent.change(input, { target: { value: '已有回答' } });
    fireEvent.click(view.getByTestId('ask-user-voice'));
    const preview = document.createElement('section');
    preview.dataset.textLightboxSearchHost = '';
    document.body.append(preview);
    try {
      await act(async () => { fireEvent.keyDown(preview, { key: 'Escape' }); });
      expect(cancel).not.toHaveBeenCalled();
      preview.remove();
      await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
      expect(cancel).toHaveBeenCalledOnce();
      expect(onAnswer).not.toHaveBeenCalled();
      expect((input as HTMLTextAreaElement).value).toBe('已有回答');
    } finally {
      preview.remove();
    }
  });

  it('Escape cancels dictation without skipping the question or discarding the typed answer', async () => {
    const { view, onAnswer } = renderAsk([{ question: '回答？' }]);
    const input = view.getByRole('textbox');
    fireEvent.change(input, { target: { value: '已有回答' } });
    fireEvent.click(view.getByTestId('ask-user-voice'));
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe('已有回答');
  });
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

  it('puts the voice button before the free-text number badge so the badges stay in one column', () => {
    const { view } = renderAsk([
      { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ]);

    const voice = view.getByTestId('ask-user-voice');
    const badge = view.getByTestId('ask-user-custom-badge');
    // Same row, badge last: it ends at the row's right padding like the option badges.
    expect(badge.parentElement).toBe(voice.parentElement);
    expect(badge.parentElement!.lastElementChild).toBe(badge);
    expect(voice.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.getByRole('button', { name: /输入其他回答…/ })).toBeTruthy();

    fireEvent.click(badge);
    expect(view.getByPlaceholderText('请输入回答…')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps the free-text number in the row button for screen readers', () => {
    const { view } = renderAsk([
      { question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ]);
    const row = view.getByRole('button', { name: /输入其他回答…/ });
    expect(row.textContent).toContain('3');
    expect(row.querySelector('.sr-only')?.textContent).toBe('3');
    expect(view.getByTestId('ask-user-custom-badge').getAttribute('aria-hidden')).toBe('true');
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
    expect(within(cluster).getByRole('button', { name: '提交' }).tagName).toBe('BUTTON');
    expect(cluster.className).toContain('items-center');
    expect(cluster.className).toContain('self-end');
  });

  it('keeps a voice button when the question has no options', () => {
    const { view } = renderAsk([{ question: '补充一句' }]);
    const voice = view.getByTestId('ask-user-voice');
    expect(voice).toBeTruthy();
    expect(view.getByPlaceholderText('请输入回答…')).toBeTruthy();
    expect(within(voice.parentElement!).getByRole('button', { name: '提交' }).tagName).toBe('BUTTON');
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
      await act(async () => { trigger?.({ id: 'shortcut-1', phase: 'start' }); });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
    } finally {
      window.electronAPI = previous;
    }
  });

  it('does not stop the recording on the tap that ends the press which started it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
      // Fake performance starts at zero; pass the initial 250ms shortcut guard.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'press-1', phase: 'start' }); });
      expect(start).toHaveBeenCalledOnce();

      // Short press: held past the 250ms dedupe window, still released quickly.
      // The release must not cancel the recording this same press started.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'press-1', phase: 'tap' }); });
      expect(stop).not.toHaveBeenCalled();

      // A new press while listening stops it.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'press-2', phase: 'start' }); });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      window.electronAPI = previous;
    }
  });

  it('starts dictation from a shortcut trigger without a phase (plain modifier combo)', async () => {
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
      // Plain modifier combos arrive without a phase; they must still start.
      await act(async () => { trigger?.({ id: 'combo-1' }); });
      await waitFor(() => expect(start).toHaveBeenCalledOnce());
    } finally {
      window.electronAPI = previous;
    }
  });

  it('stops when a held shortcut press is released', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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
      // Fake performance starts at zero; pass the initial 250ms shortcut guard.
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      await act(async () => { trigger?.({ id: 'hold-1', phase: 'start' }); });
      expect(start).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      // Held press released: `end` must stop, unlike the `tap` of a quick press.
      await act(async () => { trigger?.({ id: 'hold-1', phase: 'end' }); });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      window.electronAPI = previous;
    }
  });

  it('blocks skipping while dictation owns the answer', async () => {
    const { view } = renderAsk([
      { question: '第一题？', options: [{ label: '甲' }, { label: '乙' }] },
      { question: '第二题？', options: [{ label: '丙' }, { label: '丁' }] },
    ]);

    fireEvent.click(view.getByTestId('ask-user-voice'));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());

    // Switching questions mid-dictation would write the rest into another answer.
    expect((view.getByText('跳过').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  // #6785: the old card disabled submit until the user stopped the mic.
  // Unit: real card actions must wait for the final transcript, submit once,
  // and leave failures editable. Existing cases only tested the voice entry.
  it.each(['click', 'enter', 'custom'] as const)('stops and submits the final answer once via %s', async (action) => {
    let finish!: (ok: boolean) => void;
    stop.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { view, onAnswer } = renderAsk([{ question: '补充一句', ...(action === 'custom' ? { options: [{ label: '甲' }] } : {}) }]);
    fireEvent.click(view.getByTestId('ask-user-voice'));
    const submit = view.getByText('提交').closest('button')!;
    expect(submit.disabled).toBe(false);
    if (action !== 'enter') fireEvent.click(submit);
    else fireEvent.keyDown(view.getByPlaceholderText('请输入回答…'), { key: 'Enter' });
    fireEvent.click(submit);
    expect(stop).toHaveBeenCalledOnce();
    expect(view.getByRole('button', { name: '提交' }).getAttribute('aria-busy')).toBe('true');
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('req-voice', { '补充一句': '完整回答' });
  });

  it('keeps navigation locked after done until stop finishes restoring audio', async () => {
    idleBeforeStop = true;
    let finish!: (ok: boolean) => void;
    stop.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { view, onAnswer } = renderAsk([{ question: '选哪些？', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }]);
    fireEvent.click(view.getByTestId('ask-user-voice'));
    fireEvent.click(view.getByText('提交'));
    const submit = view.getByRole('button', { name: '提交' });
    expect(submit.getAttribute('aria-busy')).toBe('true');
    expect((view.getByText('跳过').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByText('乙'));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: '2' });
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('req-voice', { '选哪些？': JSON.stringify(['完整回答']) });
  });

  it('keeps the answer editable instead of submitting after a failed stop', async () => {
    stop.mockResolvedValueOnce(false);
    const { view, onAnswer } = renderAsk([{ question: '补充一句' }]);
    fireEvent.change(view.getByPlaceholderText('请输入回答…'), { target: { value: '保留文字' } });
    fireEvent.click(view.getByTestId('ask-user-voice'));
    await act(async () => fireEvent.click(view.getByText('提交')));
    expect(onAnswer).not.toHaveBeenCalled();
    expect((view.getByPlaceholderText('请输入回答…') as HTMLTextAreaElement).value).toBe('保留文字');
  });

  it('does not submit an empty finalized transcript', async () => {
    finalTranscript = '';
    const { view, onAnswer } = renderAsk([{ question: '补充一句' }]);
    fireEvent.click(view.getByTestId('ask-user-voice'));
    await act(async () => fireEvent.click(view.getByText('提交')));
    expect(stop).toHaveBeenCalledOnce();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(view.getByText('提交').closest('button')!.disabled).toBe(true);
  });

  it('does not submit a late result after leaving the card', async () => {
    let finish!: (ok: boolean) => void;
    stop.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { view, onAnswer } = renderAsk([{ question: '补充一句' }]);
    fireEvent.click(view.getByTestId('ask-user-voice'));
    fireEvent.click(view.getByText('提交'));
    view.unmount();
    await act(async () => finish(true));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('encodes checked options together with the final voice answer', async () => {
    const { view, onAnswer } = renderAsk([{ question: '选哪些？', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }]);
    fireEvent.click(view.getByText('甲'));
    fireEvent.click(view.getByTestId('ask-user-voice'));
    await act(async () => fireEvent.click(view.getByText('提交')));
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith('req-voice', { '选哪些？': JSON.stringify(['甲', '完整回答']) });
  });
});

describe('voice shortcut ownership across cards', () => {
  type ShortcutPayload = { id?: string; phase?: 'start' | 'tap' | 'end' };
  let previousApi: typeof window.electronAPI;
  let listeners: Set<(payload?: ShortcutPayload) => void>;
  let claimed: string[];

  beforeEach(() => {
    previousApi = window.electronAPI;
    listeners = new Set();
    claimed = [];
    window.electronAPI = {
      voiceInput: {
        onGlobalShortcutTrigger: (callback: (payload?: ShortcutPayload) => void) => {
          listeners.add(callback);
          return () => { listeners.delete(callback); };
        },
        claimGlobalShortcutTrigger: (id: string) => { claimed.push(id); },
        getDataSnapshot: () => ({ settings: { shortcut: null } }),
      },
    } as unknown as typeof window.electronAPI;
  });

  afterEach(() => {
    window.electronAPI = previousApi;
  });

  // The preload fans one trigger out to every subscriber in the window.
  const press = (payload: ShortcutPayload) => act(async () => {
    for (const listener of [...listeners]) listener(payload);
  });

  function cardProps(index: number, viewerState: 'expanded' | 'minimized' = 'expanded', preferred = false, hostVisible = true) {
    return {
      voiceShortcutPreferred: preferred,
      hostVisible,
      sessionId: `pane-${index}`,
      pending: { requestId: `req-${index}`, questions: [{ question: `第 ${index} 题？`, options: [{ label: '甲' }, { label: '乙' }] }] },
      onAnswer: vi.fn(),
      viewerState,
      onViewerStateChange: () => {},
      draft: null,
      onDraftChange: () => {},
    };
  }

  function renderPanes(
    states: Array<'expanded' | 'minimized'> = ['expanded', 'expanded'],
    preferredIndex?: number,
    hiddenIndex?: number,
  ) {
    const tree = (current: typeof states) => createElement('div', null,
      createElement('input', { 'data-testid': 'sidebar-search' }),
      createElement('button', { 'data-testid': 'sidebar-tab', type: 'button' }, 'tab'),
      ...current.map((state, index) => createElement('section', { key: index, 'data-testid': `pane-${index}` },
        createElement(AskUserQuestionPrompt, cardProps(index, state, index === preferredIndex, index !== hiddenIndex)))),
    );
    const view = render(tree(states));
    const voiceIn = (index: number) => within(view.getByTestId(`pane-${index}`)).getByTestId('ask-user-voice');
    return { view, voiceIn, rerender: (next: typeof states) => view.rerender(tree(next)) };
  }

  it('gives the press to the most recently shown card when focus is in neither', async () => {
    const { voiceIn } = renderPanes();
    await press({ id: 'p1', phase: 'start' });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(voiceIn(1).getAttribute('aria-pressed')).toBe('true');
    expect(voiceIn(0).getAttribute('aria-pressed')).toBe('false');
    expect(claimed).toEqual(['p1']);
  });

  it('gives an unfocused press to the Orca lead card over a newer worker card', async () => {
    const { voiceIn } = renderPanes(['expanded', 'expanded'], 0);
    await press({ id: 'p1', phase: 'start' });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(voiceIn(0).getAttribute('aria-pressed')).toBe('true');
    expect(voiceIn(1).getAttribute('aria-pressed')).toBe('false');
  });

  it('still gives the press to a focused worker card over the Orca lead card', async () => {
    const { view, voiceIn } = renderPanes(['expanded', 'expanded'], 0);
    within(view.getByTestId('pane-1')).getByRole('button', { name: /输入其他回答…/ }).focus();
    await press({ id: 'p1', phase: 'start' });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(voiceIn(1).getAttribute('aria-pressed')).toBe('true');
    expect(voiceIn(0).getAttribute('aria-pressed')).toBe('false');
  });

  it('follows keyboard focus to an older card', async () => {
    const { view, voiceIn } = renderPanes();
    within(view.getByTestId('pane-0')).getByRole('button', { name: /输入其他回答…/ }).focus();
    await press({ id: 'p1', phase: 'start' });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(voiceIn(0).getAttribute('aria-pressed')).toBe('true');
    expect(voiceIn(1).getAttribute('aria-pressed')).toBe('false');
  });

  it('still acts on a local key press that a sibling composer already prevented', async () => {
    const previous = window.electronAPI;
    window.electronAPI = {
      ...previous,
      voiceInput: { ...previous.voiceInput, getDataSnapshot: () => ({ settings: { shortcut: { code: 'F9', key: 'F9', modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false } } } }) },
    } as unknown as typeof window.electronAPI;
    // Registered before the cards mount, like a composer in an earlier pane:
    // it runs first and prevents the default for every matching press.
    const siblingComposer = (event: Event) => event.preventDefault();
    window.addEventListener('keydown', siblingComposer, true);
    try {
      const { view, voiceIn } = renderPanes();
      const focused = within(view.getByTestId('pane-0')).getByRole('button', { name: /输入其他回答…/ });
      focused.focus();
      await act(async () => {
        focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9', code: 'F9', bubbles: true, cancelable: true }));
      });
      expect(voiceIn(0).getAttribute('aria-pressed')).toBe('true');
    } finally {
      window.removeEventListener('keydown', siblingComposer, true);
      window.electronAPI = previous;
    }
  });

  it('leaves the press unclaimed when another text field has focus', async () => {
    const { view } = renderPanes();
    view.getByTestId('sidebar-search').focus();
    await press({ id: 'p1', phase: 'start' });

    expect(start).not.toHaveBeenCalled();
    // Unclaimed, the main process falls back to the global voice overlay.
    expect(claimed).toEqual([]);
  });

  it('leaves the press unclaimed when a button outside every card has focus', async () => {
    const { view } = renderPanes();
    view.getByTestId('sidebar-tab').focus();
    await press({ id: 'p1', phase: 'start' });

    expect(start).not.toHaveBeenCalled();
    expect(claimed).toEqual([]);
  });

  it('never gives the press to a card whose host view is hidden', async () => {
    // Pane 1 is newest but sits in a collapsed panel; its box still exists.
    const { voiceIn } = renderPanes(['expanded', 'expanded'], undefined, 1);
    await press({ id: 'p1', phase: 'start' });

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(voiceIn(0).getAttribute('aria-pressed')).toBe('true');
    expect(voiceIn(1).getAttribute('aria-pressed')).toBe('false');
  });

  it('lets the card that is recording take the next press, wherever focus is', async () => {
    const { view, voiceIn } = renderPanes();
    fireEvent.click(voiceIn(0));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    view.getByTestId('sidebar-search').focus();

    await press({ id: 'p2', phase: 'start' });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(voiceIn(1).getAttribute('aria-pressed')).toBe('false');
  });

  it('stops a minimized card that is recording, and never starts one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { voiceIn, rerender } = renderPanes(['expanded']);
    // Fake performance starts at zero; pass the initial 250ms shortcut guard.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.click(voiceIn(0));
    expect(start).toHaveBeenCalledOnce();

    rerender(['minimized']);
    await press({ id: 'p1', phase: 'start' });
    expect(stop).toHaveBeenCalledOnce();
    expect(claimed).toEqual(['p1']);

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await press({ id: 'p2', phase: 'start' });
    expect(start).toHaveBeenCalledOnce();
    expect(claimed).toEqual(['p1']);
  });
});

describe('companion voice mode integration', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  function setup(question: Partial<AskUserQuestionItem> = {}) {
    const voiceBridge: VoiceQuestionBridge = { current: null };
    const props = {
      sessionId: 'task',
      pending: {
        requestId: 'question-1',
        questions: [{ question: 'Choose a plan', options: [{ label: '简洁' }, { label: '详细' }, { label: '表格' }], ...question }],
      },
      onAnswer: vi.fn(),
      viewerState: 'expanded' as const,
      onViewerStateChange: vi.fn(),
      draft: null,
      onDraftChange: vi.fn(),
      voiceBridge,
    };
    const view = render(createElement(AskUserQuestionPrompt, props));
    const say = (text: string) => act(() => voiceBridge.current?.receive(text));
    return { view, props, say };
  }

  describe('ordinary question voice choices', () => {
    // The two independently implemented voice entries must not capture together.
    it('yields the microphone to conversation mode and restores standalone dictation when it closes', async () => {
      const f = setup();
      expect(f.view.queryByTestId('ask-user-voice')).toBeNull();
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, voiceBridge: undefined }));
      fireEvent.click(f.view.getByTestId('ask-user-voice'));
      expect(start).toHaveBeenCalledOnce();
      await act(async () => f.view.rerender(createElement(AskUserQuestionPrompt, f.props)));
      expect(stop).toHaveBeenCalledOnce();
      expect(f.view.queryByTestId('ask-user-voice')).toBeNull();
      f.say('第一项');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁' });
    });

    it.each(['第一项', '第一个', '我选简洁。', '简洁', 'first option', 'option 1', '第一個'])(
      'submits a clear single choice through the card: %s', (text) => {
        const f = setup();
        f.say(text);
        expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '简洁' });
        // No receipt yet: keep the original question and draft retryable.
        expect(f.view.getByText('Choose a plan')).toBeTruthy();
        expect(f.props.onDraftChange.mock.lastCall?.[0]?.answers).toEqual({ 'Choose a plan': '简洁' });
      },
    );

    it('numbers only visible options, not the upstream Other placeholder', () => {
      const f = setup({ options: [{ label: 'Other' }, { label: '简洁' }, { label: '详细' }] });
      f.say('第一项');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁' });
    });

    it('previews multi-select, allows cancellation, and confirms canonical visual order', () => {
      const f = setup({ multiSelect: true });
      f.say('第三项和第一项');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.selectedLabels).toEqual(['表格', '简洁']);
      f.say('取消选择');
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.selectedLabels).toEqual([]);
      f.say('确认选择');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      f.say('第三项和第一项');
      f.say('确认选择');
      expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '["简洁","表格"]' });
    });

    it.each(['第一项或第二项', '第一项和第二项', '不要选第一项', '他说第一项', '第九项', '简'])(
      'does not guess or submit ambiguous/unmatched speech: %s', (text) => {
        const f = setup();
        f.say(text);
        f.say('确认选择');
        expect(f.props.onAnswer).not.toHaveBeenCalled();
        expect(f.view.getByText(/No clear option recognized/)).toBeTruthy();
      },
    );

    it('requires disambiguation for duplicate labels', () => {
      const f = setup({ options: [{ label: '方案' }, { label: '方案。' }] });
      f.say('方案');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.view.getByText(/Your choice is unclear/)).toBeTruthy();
    });

    it('previews a free answer and confirms through the existing draft', () => {
      const f = setup({ options: [] });
      f.say('请安排在周六下午');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.customInput).toBe('请安排在周六下午');
      fireEvent.click(f.view.getByRole('button', { name: 'Submit' }));
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '请安排在周六下午' });
    });

    it('shares manual multi-selection and changes the ASR target on edits', () => {
      const f = setup({ multiSelect: true });
      f.say('第一项');
      const beforeEdit = f.props.voiceBridge.current;
      fireEvent.click(f.view.getByText('详细'));
      expect(f.props.voiceBridge.current).not.toBe(beforeEdit);
      f.say('确认选择');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '["简洁","详细"]' });
    });

    it('adds consecutive spoken choices without prematurely submitting', () => {
      const f = setup({ multiSelect: true });
      f.say('第一项');
      f.say('第三项');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      f.say('确认选择');
      expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '["简洁","表格"]' });
    });

    it('scopes targets to wizard steps and request identity, and removes them when voice closes', async () => {
      const f = setup();
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, pending: {
        ...f.props.pending, questions: [...f.props.pending.questions, { question: 'When?', options: [{ label: '明天' }] }],
      } }));
      const first = f.props.voiceBridge.current;
      f.say('第一项');
      expect(f.props.voiceBridge.current).toBeNull();
      await waitFor(() => expect(f.props.voiceBridge.current).not.toBeNull());
      expect(f.props.voiceBridge.current).not.toBe(first);
      act(() => first?.receive('第一项'));
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      f.say('明天');
      expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁', 'When?': '明天' });
      const previous = f.props.voiceBridge.current;
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, pending: { ...f.props.pending, requestId: 'question-2' } }));
      expect(f.props.voiceBridge.current).not.toBe(previous);
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, voiceBridge: undefined }));
      expect(f.props.voiceBridge.current).toBeNull();
    });

    it('restores a minimized card for a voice answer', () => {
      const f = setup();
      f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, viewerState: 'minimized' }));
      f.say('第一项');
      expect(f.props.onViewerStateChange).toHaveBeenCalledWith('expanded');
    });
  });

});
