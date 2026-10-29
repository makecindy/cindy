// @vitest-environment jsdom
// #6650: real group hook + shared dictation lifecycle, with only native capture/IPC
// faked. Existing rich-editor tests cannot exercise two textarea owners or late
// startup after closing a thread. Unit tier: no devices, network or real waits.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInputRendererEvent } from '@cindy/voice-input-core';
import type { VoiceInputShortcut } from '@/voice-input/shortcut';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  expired: vi.fn(),
  settings: { language: 'auto', refinementEnabled: true, fastActivationEnabled: false, muteSystemAudio: false, shortcut: null as VoiceInputShortcut | null, dictionaryEntries: [], refinementInstructions: '' },
  captureEngine: null as { stop: () => Promise<void>; drainBufferedAudio: () => Promise<void> } | null,
  guards: vi.fn(),
  owner: { dataOwnerId: 'test-owner', generation: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/hooks/useCodexSessionExpiredPrompt', () => ({
  useCodexSessionExpiredPrompt: () => mocks.expired, isCodexSessionExpiredError: () => false,
}));
vi.mock('@/hooks/useVoiceInputSettings', () => ({
  useVoiceInputSettings: () => ({ settings: mocks.settings }), adviseAndRecordVoiceInputDictionaryLearning: vi.fn(),
  getVoiceInputSettings: () => mocks.settings,
}));
vi.mock('@/hooks/useVoiceInputHistory', () => ({ recordVoiceInputHistory: () => null, updateVoiceInputHistoryEntry: vi.fn(), getVoiceInputHistoryForRefinement: () => [] }));
vi.mock('@/hooks/useVoiceInputUsageStats', () => ({ recordVoiceInputUsage: vi.fn(), recordVoiceInputRefinementUsage: vi.fn() }));
vi.mock('@/voice-input/workletUrl', () => ({ getVoiceInputWorkletUrl: () => '' }));
vi.mock('@/voice-input/audioContextPool', () => ({ prewarmVoiceInputAudio: async () => {} }));
vi.mock('@/voice-input/WebMicAudioEngine', () => ({
  disposeKeepAliveVoiceInputMicrophone: async () => {}, prewarmVoiceInputBenchmarkFixture: async () => {},
  isMicrophoneDeviceUnavailableError: () => false, isSelectedMicrophoneUnavailableError: () => false,
}));
vi.mock('@/voice-input/startGuards', () => ({ resolveVoiceInputStartGuards: mocks.guards }));
vi.mock('@/voice-input/captureSession', () => ({
  startVoiceInputCaptureSession: async (input: { onSoundDetected: () => void; setEngine: (engine: unknown) => void }) => {
    if (mocks.captureEngine) { input.setEngine(mocks.captureEngine); mocks.captureEngine = null; }
    input.onSoundDetected();
    return { ok: true, drainPendingChunks: () => {} };
  },
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ ...mocks.owner }),
  isDataOwnerGenerationCurrent: (owner: typeof mocks.owner) => owner.generation === mocks.owner.generation,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/new-chat/ComposerAttachments', () => ({ AttachmentRejectionStrip: () => null, ThumbnailStrip: () => null }));

import { useBotGroupVoiceInput } from '../useBotGroupVoiceInput';
import { BotGroupComposer } from '../BotGroupComposer';
import { Tooltip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { BOT_GROUP_MESSAGE_MAX_CHARS } from '../../../../shared/botGroupChat';
import { armDetachedVoiceDraftPersist, clearArmedDetachedVoiceDraft, hasArmedDetachedVoiceDraft } from '@/components/new-chat/composerSendOwnership';
import { VoiceInputOperationQueue } from '../../../../main/voice-input/VoiceInputOperationQueue';

type Trigger = { id: string; phase?: 'start' | 'tap' | 'end' };
const events = new Set<(event: VoiceInputRendererEvent) => void>();
const shortcuts = new Set<(event: Trigger) => void>();
const emit = (event: VoiceInputRendererEvent) => events.forEach(listener => listener(event));
const trigger = (phase?: Trigger['phase']) => shortcuts.forEach(listener => listener({ id: 'gesture', phase }));
const api = {
  onEvent: (listener: (event: VoiceInputRendererEvent) => void) => { events.add(listener); return () => events.delete(listener); },
  onGlobalShortcutTrigger: (listener: (event: Trigger) => void) => { shortcuts.add(listener); return () => shortcuts.delete(listener); },
  claimGlobalShortcutTrigger: vi.fn(),
  prewarm: vi.fn().mockResolvedValue({ ok: true }),
  start: vi.fn(), stop: vi.fn(), cancel: vi.fn(), drainAudioQueue: vi.fn().mockResolvedValue(undefined),
  muteSystemAudio: vi.fn().mockResolvedValue({ ok: true }), restoreSystemAudio: vi.fn().mockResolvedValue({ ok: true }),
};
const segment = { id: 'segment', source: 'mic' as const, status: 'submitted' as const, text: 'spoken', updatedAt: 1 };
function submit(runId = 'run') {
  emit({ type: 'submitted', runId, text: 'spoken', segment });
}
function refine(text = 'Spoken.') {
  emit({ type: 'refined', runId: 'run', text, segment: { ...segment, status: 'refined' },
    range: { id: 'range', segmentIds: ['segment'], startOffset: 0, endOffset: 6, userTouched: false } });
}
function Harness({ id, initial = '', disabled = false }: { id: string; initial?: string; disabled?: boolean }) {
  const [text, setText] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voice = useBotGroupVoiceInput({ draftKey: id, text, onChange: setText, textareaRef, disabled });
  return <div>
    <textarea aria-label={id} ref={textareaRef} value={voice.displayText} readOnly={voice.isBusy} onChange={event => setText(event.target.value)} />
    <output data-testid={`${id}-saved`}>{text}</output>
    <output data-testid={`${id}-state`}>{voice.state}</output>
    <button onClick={() => voice.start()}>start {id}</button>
    <button onClick={() => { void voice.stop(); }}>stop {id}</button>
    <button onClick={() => { void voice.cancel(); }}>cancel {id}</button>
  </div>;
}
const input = (id: string) => screen.getByRole('textbox', { name: id }) as HTMLTextAreaElement;
const start = async (id: string) => { await act(async () => { fireEvent.click(screen.getByText(`start ${id}`)); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.owner.generation = 1;
  mocks.settings.shortcut = null;
  mocks.settings.muteSystemAudio = false;
  mocks.captureEngine = null;
  api.muteSystemAudio.mockReset().mockResolvedValue({ ok: true });
  api.restoreSystemAudio.mockReset().mockResolvedValue({ ok: true });
  mocks.guards.mockResolvedValue({ ok: true, permission: { ok: true }, readiness: { ok: true } });
  api.start.mockResolvedValue({ ok: true, runId: 'run' });
  api.cancel.mockResolvedValue({ ok: true });
  api.stop.mockImplementation(async () => { submit(); refine(); emit({ type: 'state', runId: 'run', state: 'done' }); return { ok: true }; });
  vi.stubGlobal('electronAPI', { platform: 'win32', voiceInput: api });
});
afterEach(() => { cleanup(); clearArmedDetachedVoiceDraft(); events.clear(); shortcuts.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('group textarea dictation ownership (#6650)', () => {
  // Reviewer follow-up: the old hook can resume after its audio drain and after
  // the replacement has started. Whole fake IPC calls are observable here;
  // registered-main tests separately cover actual routing and mute restoration.
  it.each(['stop', 'cancel'])('does not send a late unowned %s after a pending topic is closed', async operation => {
    let finishEngine!: () => void;
    let finishStart!: (value: { ok: true; runId: string }) => void;
    const engineGate = new Promise<void>(resolve => { finishEngine = resolve; });
    const startGate = new Promise<{ ok: true; runId: string }>(resolve => { finishStart = resolve; });
    mocks.captureEngine = { stop: () => engineGate, drainBufferedAudio: () => engineGate };
    api.start.mockReturnValueOnce(startGate);
    const view = render(<><Harness key="group" id="group" /><Harness key="thread" id="thread" /></>);
    await start('thread');
    act(() => { fireEvent.click(screen.getByText(`${operation} thread`)); });
    view.rerender(<Harness key="group" id="group" />);
    await start('group');
    expect(api.start).toHaveBeenCalledTimes(2);
    await act(async () => { finishEngine(); finishStart({ ok: true, runId: 'thread-run' }); });
    expect(api.cancel.mock.calls.every(([payload]) => Boolean(payload?.runId))).toBe(true);
    expect(api.stop).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-state').textContent).toBe('listening');
  });

  it('does not restore a replacement audio lease when an old topic mute resolves late', async () => {
    mocks.settings.muteSystemAudio = true;
    let finishMute!: (value: { ok: true }) => void;
    api.muteSystemAudio.mockReturnValueOnce(new Promise(resolve => { finishMute = resolve; }));
    const view = render(<><Harness key="group" id="group" /><Harness key="thread" id="thread" /></>);
    await start('thread');
    expect(api.muteSystemAudio).toHaveBeenCalledOnce();
    view.rerender(<Harness key="group" id="group" />);
    await start('group');
    expect(api.muteSystemAudio).toHaveBeenCalledTimes(2);
    await act(async () => { finishMute({ ok: true }); });
    expect(api.restoreSystemAudio).not.toHaveBeenCalled();
    expect(screen.getByTestId('group-state').textContent).toBe('listening');
  });

  it('closes a topic during provider startup and starts the main-group run without losing either cleanup or draft ownership', async () => {
    // Real renderer hooks + the main lifecycle queue; providers/IPC are in-memory.
    // Delay both connects to reproduce the reviewer path without network or clocks.
    const queue = new VoiceInputOperationQueue();
    let finishThread!: () => void;
    let finishGroup!: () => void;
    const threadConnect = new Promise<void>(resolve => { finishThread = resolve; });
    const groupConnect = new Promise<void>(resolve => { finishGroup = resolve; });
    const disposed: string[] = [];
    let active: string | null = null;
    const connect = vi.fn(async (runId: string, ready: Promise<void>) => {
      if (active) disposed.push(active);
      active = null;
      await ready;
      active = runId;
      return { ok: true as const, runId };
    });
    api.start
      .mockImplementationOnce(() => queue.run(1, () => connect('thread-run', threadConnect)))
      .mockImplementationOnce(() => queue.run(1, () => connect('run', groupConnect)));
    api.cancel.mockImplementation((payload?: { runId?: string }) => queue.run(1, async () => {
      if (active && (!payload?.runId || payload.runId === active)) {
        disposed.push(active);
        active = null;
      }
      return { ok: true };
    }));
    const view = render(<><Harness key="group" id="group" initial="main draft" /><Harness key="thread" id="thread" /></>);
    await start('thread');
    expect(connect).toHaveBeenCalledTimes(1);
    view.rerender(<Harness key="group" id="group" initial="main draft" />);
    input('group').setSelectionRange('main draft'.length, 'main draft'.length);
    await start('group');
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
    await act(async () => { finishThread(); });
    expect(disposed).toEqual(['thread-run']);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'thread-run' });
    await act(async () => { finishGroup(); });
    expect(active).toBe('run');
    expect(disposed).toEqual(['thread-run']);
    act(() => { submit('thread-run'); });
    expect(screen.getByTestId('group-saved').textContent).toBe('main draft');
    act(() => { submit(); emit({ type: 'state', runId: 'run', state: 'done' }); });
    expect(screen.getByTestId('group-saved').textContent).toBe('main draftspoken');
  });

  // PR #6656: prior tests lacked DOM/native duplicate delivery and error
  // before disposal. Real hook, fake 450ms keys and error -> switch/unmount;
  // unit tier with native IPC faked, no device/cloud or real waits.
  it.each([
    ['win32', false, 'native-first'], ['win32', false, 'local-first'],
    ['darwin', true, 'native-first'], ['darwin', true, 'local-first'],
  ] as const)('stops a long keyboard press once on %s (%s, %s), after focus moves', async (platform, altKey, order) => {
    vi.stubGlobal('electronAPI', { platform, voiceInput: api });
    mocks.settings.shortcut = { code: 'Space', key: ' ',
      modifiers: { meta: false, ctrl: !altKey, shift: !altKey, alt: altKey, fn: false } };
    render(<><Harness id="group" initial="main draft" /><Harness id="thread" /></>);
    input('thread').focus();
    await act(async () => {
      if (order === 'native-first') trigger();
      fireEvent.keyDown(input('thread'), { code: 'Space', key: ' ', ctrlKey: !altKey, shiftKey: !altKey, altKey });
      if (order === 'local-first') trigger();
    });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(450));
    input('group').focus();
    await act(async () => fireEvent.keyUp(input('group'), { code: altKey ? 'AltLeft' : 'ControlLeft' }));
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(input('thread').value).toBe('Spoken.');
    expect(input('group').value).toBe('main draft');
  });

  it('keeps a short accelerator tap recording and stops on the next press without restarting', async () => {
    mocks.settings.shortcut = { code: 'Space', key: ' ', modifiers: { ctrl: true, shift: true, alt: false, meta: false, fn: false } };
    render(<Harness id="group" />); input('group').focus();
    await act(async () => trigger());
    act(() => vi.advanceTimersByTime(449));
    fireEvent.keyUp(input('group'), { code: 'Space' });
    expect(api.stop).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(251));
    await act(async () => {
      fireEvent.keyDown(input('group'), { code: 'Space', ctrlKey: true, shiftKey: true });
      trigger();
    });
    fireEvent.keyUp(input('group'), { code: 'Space' });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(input('group').value).toBe('Spoken.');
  });

  it('finishes a long keyboard press on window blur while native startup is pending', async () => {
    let resolve!: (result: { ok: true; runId: string }) => void;
    api.start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mocks.settings.shortcut = { code: 'Space', key: ' ', modifiers: { ctrl: true, shift: true, alt: false, meta: false, fn: false } };
    render(<Harness id="group" />); input('group').focus();
    await act(async () => trigger());
    act(() => vi.advanceTimersByTime(450));
    await act(async () => fireEvent.blur(window));
    expect(screen.getByTestId('group-state').textContent).toBe('submitting');
    await act(async () => resolve({ ok: true, runId: 'run' }));
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(input('group').value).toBe('Spoken.');
  });

  it.each(['unmount', 'draft-switch'] as const)('disposes the failed run before %s without cancelling another composer', async boundary => {
    const view = render(<><Harness key="group" id="group" initial="draft" /><Harness key="thread" id="thread" /></>);
    await start('group');
    await act(async () => emit({ type: 'error', runId: 'run', message: 'connection lost' }));
    expect(screen.getByTestId('group-state').textContent).toBe('error');
    expect(input('group').readOnly).toBe(false);
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith({ runId: 'run' });
    if (boundary === 'unmount') view.rerender(<Harness key="thread" id="thread" />);
    else view.rerender(<><Harness key="group" id="other-group" initial="draft" /><Harness key="thread" id="thread" /></>);
    api.start.mockResolvedValueOnce({ ok: true, runId: 'thread-run' });
    await start('thread');
    act(() => { submit(); refine(); });
    expect(input('thread').value).toBe('');
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(api.start).toHaveBeenCalledTimes(2);
  });

  // PR #6656 review regressions (unit): real shared hook/composer entry points.
  // Existing tests emit only after start resolves, use no picked mentions and
  // short transcripts. Minimal failures: early auth; preview before a picked
  // namesake/reserved label; submitted/refined text one character over the limit.
  it('prompts for early authentication only in the active composer and rejects stale auth after ownership', async () => {
    api.start.mockImplementationOnce(async () => {
      emit({ type: 'auth-required', runId: 'run', reason: 'expired', provider: 'codex' });
      return { ok: true, runId: 'run' };
    });
    render(<><Harness id="group" /><Harness id="thread" /></>);
    await start('thread');
    expect(mocks.expired).toHaveBeenCalledExactlyOnceWith('expired');
    act(() => emit({ type: 'auth-required', runId: 'stale', reason: 'stale', provider: 'codex' }));
    expect(mocks.expired).toHaveBeenCalledTimes(1);
  });

  // Greptile review #4336362854: an already-open picker could mutate the
  // read-only draft and cancel capture. Exercise both real composer variants;
  // existing mention tests picked recipients only before starting dictation.
  it.each(['group', 'thread'] as const)('closes mention picking throughout %s dictation and restores it afterward', async mode => {
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey={`voice-picker-lock-${mode}`} mode={mode}
      members={[{ botId: 'member', name: 'Member', avatar: '', avatarColor: 'green', status: 'active' }]}
      running={false} sendReply={vi.fn()} /></Tooltip.Provider>);
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => textbox.focus());
    fireEvent.change(textbox, { target: { value: 'say @', selectionStart: 5 } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
    expect(screen.queryByRole('listbox')).toBeNull();
    act(() => emit({ type: 'draft', runId: 'run', text: 'preview', source: 'partial', segment }));
    expect(textbox.value).toBe('say @preview');
    act(() => emit({ type: 'state', runId: 'run', state: 'refining' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(api.cancel).not.toHaveBeenCalled();
    act(() => { submit(); refine(); emit({ type: 'state', runId: 'run', state: 'done' }); });
    expect(textbox.value).toBe('say @Spoken.');
    expect(api.cancel).not.toHaveBeenCalled();
    act(() => textbox.focus());
    fireEvent.change(textbox, { target: { value: 'say @Spoken. @', selectionStart: 14 } });
    fireEvent.click(screen.getByRole('option', { name: 'Member' }));
    expect(textbox.value).toBe('say @Spoken. @Member ');
  });

  it.each(['Ann', 'bots.groupChat.mention.all'])('keeps the picked recipient %s through voice preview, submission and refinement', async name => {
    const sendReply = vi.fn().mockResolvedValue({ ok: true, messageId: 'reply' });
    const members = ['picked', 'other'].map(botId => ({ botId, name, avatar: '', avatarColor: 'green', status: 'active' as const }));
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey={`voice-mentions-${name}`} mode="thread"
      members={members} running={false} sendReply={sendReply} /></Tooltip.Provider>);
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    act(() => textbox.focus());
    fireEvent.change(textbox, { target: { value: 'before @', selectionStart: 8 } });
    fireEvent.click(screen.getAllByRole('option')[1]!);
    expect(textbox.value).toBe(`before @${name} `);
    act(() => { textbox.setSelectionRange(0, 6); fireEvent.select(textbox); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
    act(() => emit({ type: 'draft', runId: 'run', text: 'a longer preview', source: 'partial', segment }));
    expect(textbox.value).toBe(`a longer preview @${name} `);
    // Native result events may arrive in one render batch, before the textarea
    // changes from its preview value to the submitted and then refined text.
    await act(async () => fireEvent.keyDown(textbox, { key: 'Enter' }));
    expect(textbox.value).toBe(`Spoken. @${name} `);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.server.sendReply' })));
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({ mentions: { all: false, botIds: ['picked'] } }));
  });

  it.each(['submitted', 'refined'] as const)('rejects an oversized %s without changing the accepted draft and reports the limit', async stage => {
    const sendReply = vi.fn().mockResolvedValue({ ok: true, messageId: 'reply' });
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey={`voice-limit-${stage}`} mode="thread"
      members={[]} running={false} sendReply={sendReply} /></Tooltip.Provider>);
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    const initial = 'x'.repeat(BOT_GROUP_MESSAGE_MAX_CHARS);
    fireEvent.change(textbox, { target: { value: initial } });
    act(() => { textbox.focus(); textbox.setSelectionRange(0, stage === 'refined' ? 6 : 0); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
    await act(async () => fireEvent.keyDown(textbox, { key: 'Enter' }));
    const accepted = stage === 'submitted' ? initial : `spoken${initial.slice(6)}`;
    expect(textbox.value).toBe(accepted);
    expect(toast.warning).toHaveBeenCalledWith('bots.groupChat.composer.tooLong');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.server.sendReply' })));
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({ text: accepted }));
  });

  // Follow-up review: main-group dictation follows typing's soft limit, while
  // thread rejection warns once per recording, even with multiple submissions.
  it('keeps an oversized main-group transcript for editing and blocks sending, just like typing', async () => {
    const onSendStart = vi.fn();
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey="voice-main-soft-limit"
      members={[{ botId: 'member', name: 'Member', avatar: '', avatarColor: 'green', status: 'active' }]}
      running={false} onSendStart={onSendStart} /></Tooltip.Provider>);
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    const initial = 'x'.repeat(BOT_GROUP_MESSAGE_MAX_CHARS - 6);
    fireEvent.change(textbox, { target: { value: initial } });
    act(() => { textbox.focus(); textbox.setSelectionRange(0, 0); });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
    await act(async () => fireEvent.keyDown(textbox, { key: 'Enter' }));
    expect(textbox.value).toBe(`Spoken.${initial}`);
    expect(textbox.value.length).toBe(BOT_GROUP_MESSAGE_MAX_CHARS + 1);
    expect(screen.getByText('bots.groupChat.composer.tooLong')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'bots.send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: 'Enter' });
    expect(onSendStart).not.toHaveBeenCalled();
  });

  it('warns once for multiple oversized thread submissions and warns again on the next recording', async () => {
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey="voice-limit-notice" mode="thread"
      members={[]} running={false} sendReply={vi.fn()} /></Tooltip.Provider>);
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'x'.repeat(BOT_GROUP_MESSAGE_MAX_CHARS) } });
    for (let recording = 1; recording <= 2; recording++) {
      act(() => { textbox.focus(); textbox.setSelectionRange(0, 0); });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
      act(() => { submit(); submit(); });
      await act(async () => fireEvent.keyDown(textbox, { key: 'Enter' }));
      expect(toast.warning).toHaveBeenCalledTimes(recording);
      expect(textbox.value.length).toBe(BOT_GROUP_MESSAGE_MAX_CHARS);
    }
  });
  it('the real reply composer stops on Enter, retains the transcript, and sends only after manual editing', async () => {
    const sendReply = vi.fn().mockResolvedValue({ ok: true, messageId: 'reply' });
    render(<Tooltip.Provider><BotGroupComposer groupId="group" draftKey="voice-test-thread" mode="thread"
      members={[]} running={false} sendReply={sendReply} /></Tooltip.Provider>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' })));
    const textbox = screen.getByRole('textbox');
    expect((textbox as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => fireEvent.keyDown(textbox, { key: 'Enter' }));
    expect((textbox as HTMLTextAreaElement).value).toBe('Spoken.');
    expect(sendReply).not.toHaveBeenCalled();
    fireEvent.change(textbox, { target: { value: 'Edited reply' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.server.sendReply' })));
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'Edited reply' }));
  });

  it('previews at the selection, refines into the draft and leaves it editable', async () => {
    render(<Harness id="group" initial={'before\nreplace after'} />);
    input('group').focus(); input('group').setSelectionRange(7, 14);
    await start('group');
    act(() => emit({ type: 'draft', runId: 'run', text: 'partial', source: 'partial', segment }));
    expect(input('group').value).toBe('before\npartial after');
    expect(screen.getByTestId('group-saved').textContent).toBe('before\nreplace after');
    await act(async () => { fireEvent.click(screen.getByText('stop group')); });
    expect(input('group').value).toBe('before\nSpoken. after');
    expect(input('group').readOnly).toBe(false);
    fireEvent.change(input('group'), { target: { value: 'edited' } });
    expect(screen.getByTestId('group-saved').textContent).toBe('edited');
  });

  it('routes a press and release to the focused thread, even after focus moves', async () => {
    render(<><Harness id="group" initial="main draft" /><Harness id="thread" /></>);
    input('thread').focus();
    await act(async () => trigger('start'));
    input('group').focus();
    await act(async () => trigger('end'));
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(input('thread').value).toBe('Spoken.');
    expect(input('group').value).toBe('main draft');
    act(() => vi.advanceTimersByTime(20));
    expect(document.activeElement).toBe(input('group'));
  });

  it('keeps listening on first tap release and stops on the next press', async () => {
    render(<Harness id="group" />); input('group').focus();
    await act(async () => trigger('start'));
    act(() => trigger('tap'));
    expect(api.stop).not.toHaveBeenCalled();
    await act(async () => trigger('start'));
    act(() => trigger('tap'));
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(input('group').value).toBe('Spoken.');
  });

  it('closing an idle thread does not cancel main-group dictation', async () => {
    const view = render(<><Harness key="group" id="group" /><Harness key="thread" id="thread" /></>);
    await start('group');
    view.rerender(<><Harness key="group" id="group" /></>);
    expect(api.cancel).not.toHaveBeenCalled();
    act(() => submit());
    expect(input('group').value).toBe('spoken');
  });

  it('cancels an unmounted owner by run ID and ignores its late result in the new group', async () => {
    const view = render(<Harness key="old" id="old" />);
    await start('old');
    view.rerender(<Harness key="new" id="new" initial="new draft" />);
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'run' });
    act(() => { submit(); refine(); });
    expect(input('new').value).toBe('new draft');
  });

  it('cancels a late startup without accepting events from another run', async () => {
    let resolve!: (result: { ok: true; runId: string }) => void;
    api.start.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<Harness key="old" id="old" />);
    await start('old');
    act(() => submit('unrelated'));
    expect(input('old').value).toBe('');
    view.rerender(<Harness key="new" id="new" />);
    await act(async () => { resolve({ ok: true, runId: 'late' }); });
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'late' });
    expect(input('new').value).toBe('');
  });

  it('unmounting a group cancels only its run while ordinary chat preserves a detached draft', async () => {
    const view = render(<Harness id="group" />);
    await start('group');
    armDetachedVoiceDraftPersist('ordinary-chat', '');
    view.unmount();
    expect(api.cancel).toHaveBeenCalledWith({ runId: 'run' });
    expect(api.stop).not.toHaveBeenCalled();
    expect(hasArmedDetachedVoiceDraft('ordinary-chat')).toBe(true);
    expect(events.size).toBe(0);
  });

  it.each(['draft', 'account', 'disabled'] as const)('rejects results after a %s boundary change', async boundary => {
    const view = render(<Harness id="group" initial="original" />);
    await start('group');
    if (boundary === 'account') mocks.owner.generation++;
    if (boundary === 'disabled') view.rerender(<Harness id="group" initial="original" disabled />);
    if (boundary === 'draft') view.rerender(<Harness id="other-draft" initial="original" />);
    await act(async () => { submit(); refine(); });
    expect(screen.getByRole('textbox').getAttribute('aria-label')).toBe(boundary === 'draft' ? 'other-draft' : 'group');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('original');
  });

  it('retains user edits if a refinement arrives late', async () => {
    render(<Harness id="group" />); await start('group');
    act(() => submit());
    fireEvent.change(input('group'), { target: { value: 'manual correction' } });
    await act(async () => refine());
    expect(input('group').value).toBe('manual correction');
  });

  it('shows permission failure and restores editing', async () => {
    mocks.guards.mockResolvedValue({ ok: false, permission: { ok: false, error: 'permission denied' }, readiness: { ok: true } });
    render(<Harness id="group" initial="draft" />); await start('group');
    expect(api.start).not.toHaveBeenCalled();
    expect(input('group').readOnly).toBe(false);
    expect(input('group').value).toBe('draft');
    expect(screen.getByTestId('group-state').textContent).toBe('error');
  });
});
