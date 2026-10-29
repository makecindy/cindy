// @vitest-environment jsdom
/**
 * ChatInput × 标注烧录中止:已有任务的发送会请求 annotationBurnFailure: 'abort';
 * 发送被中止(onSend 返回 false,makerChatStore 烧录失败时即如此)后,点击时的正文、
 * 附件与矢量笔迹原样回到输入框,用户可直接重试。脚手架与 chatInputModelLoading
 * 相同:外部宿主服务全部惰性,编辑器、输入框状态与发送派发真实运行。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProviderView } from '@cindy/model-providers';
import { sshNativeCodexProvider, sshModel, sshProvider } from '@/features/cc-agent/__tests__/sshModelFixtures';
import type { AttachedFile } from '@/lib/fileTypes';
import { ChatInput } from '../ChatInput';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import type { AtMentionPanel } from '../AtMentionPanel';
import type { scanAtResources } from '@/lib/atResourceService';
import type { ExtraDirsButton } from '../ExtraDirsButton';
import type { PermissionSelector } from '../PermissionSelector';
import type { ModelSelector } from '../ModelSelector';
import type { UseVoiceInputResult } from '@/voice-input/useVoiceInput';
import { useAttachments } from '@/hooks/useAttachments';
import { dispatchInputDeviceAction } from '@/lib/inputDeviceActions';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  __testing as promptRecommendations,
  beginPromptRecommendationPrediction,
  clearPromptRecommendationSession,
  resolvePromptRecommendationPrediction,
} from '@/lib/promptRecommendationStore';
import type { InputDeviceRendererAction } from '../../../../shared/inputDevices';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn(), selectModel: undefined as ComponentProps<typeof ModelSelector>['onModelChange'] | undefined, remoteProviders: [] as ProviderView[],
  remoteStatus: 'ready' as 'ready' | 'loading' | 'error',
  scan: vi.fn<typeof scanAtResources>(),
  atPanel: null as ComponentProps<typeof AtMentionPanel> | null,
  documentChanged: vi.fn(),
  voiceState: null as UseVoiceInputResult['state'] | null,
  draftText: '',
  draftSource: null as UseVoiceInputResult['draftSource'],
  draftRange: null as UseVoiceInputResult['draftRange'],
  cancel: vi.fn().mockResolvedValue(undefined),
  prepare: vi.fn(),
  realModelSelector: false,
  listAgentSkills: vi.fn(),
  localProviders: [] as ProviderView[],
  uploadChatFolder: vi.fn(),
}));

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: h.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', async (original) => ({ ...await original<typeof import('@/components/ui/confirm-dialog-provider')>(), useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: ({
    items,
    renderItem,
    role,
    ariaLabel,
    className,
  }: {
    items: readonly unknown[];
    renderItem: (item: unknown, index: number) => ReactNode;
    role?: string;
    ariaLabel?: string;
    className?: string;
  }) => (
    <div role={role} aria-label={ariaLabel} className={className}>
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}));
vi.mock('../ModelSelector', async (original) => {
  const real = await original<typeof import('../ModelSelector')>();
  return { ...real, ModelSelector: (props: ComponentProps<typeof ModelSelector>) => {
    h.selectModel = props.onModelChange;
    return h.realModelSelector ? <real.ModelSelector {...props} /> : <span data-testid="model-selector">{props.modelId}</span>;
  } };
});
vi.mock('@/hooks/useSshCodexProviders', () => ({ useSshCodexProviders: () => ({ providers: h.remoteProviders, status: h.remoteStatus, refresh: () => {} }) }));
vi.mock('../ExtraDirsButton', () => ({ ExtraDirsButton: ({ open, onOpenChange, panel, disabled }: ComponentProps<typeof ExtraDirsButton>) => <><button aria-label="test-suggestions" disabled={disabled} onClick={() => onOpenChange?.(!open)} />{open && panel}</> }));
vi.mock('../PermissionSelector', () => ({ PermissionSelector: ({ disabled }: ComponentProps<typeof PermissionSelector>) => <button data-testid="permission-selector" disabled={disabled} /> }));
vi.mock('../NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('../FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: vi.fn() }));
vi.mock('../AtMentionPanel', () => ({ AtMentionPanel: (props: ComponentProps<typeof AtMentionPanel>) => { h.atPanel = props; return null; } }));
vi.mock('@/lib/atResourceService', async (original) => ({ ...await original<typeof import('@/lib/atResourceService')>(), scanAtResources: h.scan }));
vi.mock('../SlashCommandPalette', () => ({ SlashCommandPalette: ({ query }: { query: string }) => <div data-testid="test-slash-palette" data-query={query} /> }));
vi.mock('@/voice-input/VoiceInputPointerHintLayer', () => ({ VoiceInputPointerHintLayer: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/voice-input/VoiceInputStatusNotice', () => ({ VoiceInputStatusNotice: () => null }));
vi.mock('@/voice-input/useVoiceInput', () => ({ useVoiceInput: (editor: Editor | null) => {
  // Attach before ChatInput's first hydration effect so an empty-document
  // replacement on initial mount cannot hide from the regression assertion.
  if (editor && editor !== h.editor) editor.on('transaction', ({ transaction }) => { if (transaction.docChanged) h.documentChanged(); });
  h.editor = editor;
  const state = h.voiceState ?? (h.listening ? 'listening' : 'idle');
  return { state, prepare: h.prepare, getState: () => h.voiceState ?? (h.listening ? 'listening' : 'idle'), isListening: state === 'listening', isBusy: state === 'listening' || state === 'submitting' || state === 'refining', draftText: h.draftText, draftSource: h.draftSource, draftRange: h.draftRange, start: () => { h.listening = true; return true; }, stop: h.stop, cancel: h.cancel };
} }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: h.localProviders, providerOrder: [], loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({ ...await original<typeof import('@/hooks/useAgentCapabilities')>(), useAgentCapabilities: () => ({ capabilities: null, loading: false }) }));

const noOp = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = new Proxy({}, { get: (_obj, key) => {
  if (key === 'setModel') return h.setModel;
  if (key === 'uploadChatFolder') return h.uploadChatFolder;
  if (key === 'getFilePath') return () => '/controller/docs';
  if (key === 'listAgentSkills') return h.listAgentSkills;
  if (key === 'listAgentCommands' || key === 'listDesktopCommands') return async () => ({ success: true, commands: [] });
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return 'darwin';
  if (key === 'modelAccess') return undefined;
  if (key === 'then') return undefined;
  if (String(key).startsWith('on')) return () => noOp;
  return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => api[nested] });
} });

const strokes = [{ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }];
const annotatedImage: AttachedFile = {
  id: 'tray-annotated',
  name: 'shot.png',
  path: '/Users/sam/shot.png',
  ext: '.png',
  size: 10,
  category: 'image',
  mimeType: 'image/png',
  url: 'cindy-media://blobs/tray.png',
  annotationStrokes: strokes,
};

beforeEach(() => {
  h.uploadChatFolder.mockReset();
  h.listAgentSkills.mockReset().mockResolvedValue({ success: true, skills: [] });
  h.localProviders = [];
  h.editor = null;
  h.documentChanged.mockClear();
  h.listening = false;
  h.voiceState = null;
  h.draftText = '';
  h.draftSource = null;
  h.draftRange = null;
  h.stop.mockClear();
  h.prepare.mockClear();
  h.realModelSelector = false;
  h.cancel.mockReset().mockResolvedValue(undefined);
  h.atPanel = null;
  h.scan.mockReset().mockResolvedValue({ success: true, items: [], truncated: false });
  window.electronAPI = api;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); clearDraft('composer-regression'); h.remoteProviders = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderComposer(extra: Partial<ComponentProps<typeof ChatInput>> = {}) {
  const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
    rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
    pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
    pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
    removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: files => [...files],
  };
  const props = { draftKey: 'composer-regression', deviceLinkDeviceId: null,
    attachmentState,
    hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
    onSend: vi.fn().mockResolvedValue(true), ...extra };
  const view = render(<ChatInput {...props} />);
  return { ...view, props };
}

function supplyRangeGeometry() {
  // jsdom has no layout. Keep real ranges/selections while ProseMirror focuses.
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    const rect = new DOMRect();
    range.getClientRects = () => Object.assign([rect], { item: (index: number) => index === 0 ? rect : null });
    range.getBoundingClientRect = () => rect;
    return range;
  });
}

// Replaces the source-only guards with real editor transactions at the two
// external-draft boundaries. Empty paragraph JSON is the minimal #720 input;
// a document replacement would remap the live voice insertion anchor.
it('does not replace the empty editor after an external empty-draft notification', async () => {
  renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  const changed = vi.fn();
  h.editor!.on('transaction', ({ transaction }) => { if (transaction.docChanged) changed(); });
  await act(async () => saveDraft('composer-regression', {
    text: { type: 'doc', content: [{ type: 'paragraph' }] }, attachments: [],
  }));
  expect(changed).not.toHaveBeenCalled();
  expect(h.editor!.state.selection.from).toBe(1);
});

// Companion chat 「回复」 bug: the quote appeared above the composer but focus stayed on the
// message's button. Each new quote (also a second one on the same message) is a new request.
it('focuses the editor for each new focus request, not on mount or a repeated value', async () => {
  supplyRangeGeometry();
  const quote = { clientId: 'm1' };
  const view = renderComposer({ focusRequest: quote });
  await waitFor(() => expect(h.editor).not.toBeNull());
  expect(h.editor!.isFocused).toBe(false);
  const outside = document.body.appendChild(document.createElement('button'));
  view.rerender(<ChatInput {...view.props} focusRequest={quote} />);
  expect(h.editor!.isFocused).toBe(false);
  view.rerender(<ChatInput {...view.props} focusRequest={null} />);
  expect(h.editor!.isFocused).toBe(false);
  view.rerender(<ChatInput {...view.props} focusRequest={{ clientId: 'm1' }} />);
  await waitFor(() => expect(h.editor!.isFocused).toBe(true));
  outside.focus();
  expect(h.editor!.isFocused).toBe(false);
  view.rerender(<ChatInput {...view.props} focusRequest={{ clientId: 'm1' }} />);
  await waitFor(() => expect(h.editor!.isFocused).toBe(true));
  outside.remove();
});

it('does not rehydrate an empty stored document when voice busy state changes', async () => {
  saveDraft('composer-regression', { text: { type: 'doc', content: [{ type: 'paragraph' }] }, attachments: [] });
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  expect(h.documentChanged).not.toHaveBeenCalled();
  const changed = vi.fn();
  h.editor!.on('transaction', ({ transaction }) => { if (transaction.docChanged) changed(); });
  h.listening = true;
  view.rerender(<ChatInput {...view.props} />);
  h.listening = false;
  view.rerender(<ChatInput {...view.props} />);
  expect(changed).not.toHaveBeenCalled();
  expect(h.editor!.state.selection.from).toBe(1);
});

// Replaces voiceInputEditorEditability's source guard (PR #6196, section 3.2).
// The voice hook is an external boundary; the editor and ChatInput lock effects
// are real. Existing hydration tests never observe editability, attachment
// controls, permission availability or Escape ownership; #1663 also requires
// the real stop button to stay usable under the recording's own lock. Minimal unit inputs:
// one idle -> listening -> submitting -> refining -> idle run and Escape on
// two top-level surfaces followed by the same editor. Reuse this jsdom harness.
it('locks editor and attachments for the whole voice run, but keeps permissions available', async () => {
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  for (const state of ['idle', 'listening', 'submitting', 'refining', 'idle'] as const) {
    h.voiceState = state;
    view.rerender(<ChatInput {...view.props} />);
    const busy = state !== 'idle';
    expect(h.editor!.isEditable, state).toBe(!busy);
    expect((screen.getByRole('button', { name: 'test-suggestions' }) as HTMLButtonElement).disabled, state).toBe(busy);
    expect((screen.getByTestId('permission-selector') as HTMLButtonElement).disabled, state).toBe(false);
    if (state === 'listening') {
      // #1663: the recording's own lock must still leave its stop control usable.
      const stop = screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.stop' }) as HTMLButtonElement;
      expect(stop.disabled).toBe(false);
      await act(async () => { fireEvent.click(stop); });
      expect(h.stop).toHaveBeenCalledExactlyOnceWith({ waitForRefinement: true, onReadyForEndCue: expect.any(Function) });
    }
  }
});

// User request 2026-10-24: empty composer hints must follow hover/hold/click,
// and native selection must not take over a recording. Existing voice tests
// only cover editability; minimal inputs below drive real DOM handlers (unit/jsdom).
// 2026-10-26 Bluetooth regression: preparation must also wait for the hold
// threshold; even a microphone opened without recording changes headset audio.
it('shows voice guidance only in an empty composer and distinguishes holding from clicking', async () => {
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  const area = view.container.querySelector('[data-recommendation-active]')
    ?? h.editor!.view.dom.parentElement!.parentElement!;
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(area);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(screen.queryByTestId('composer-voice-hint')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('composer-voice-hint').textContent).toBe('newChat.chatInput.voiceInput.holdComposer');
    fireEvent.pointerLeave(area);
    expect(screen.queryByTestId('composer-voice-hint')).toBeNull();
    fireEvent.pointerEnter(area);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.pointerLeave(area);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.queryByTestId('composer-voice-hint')).toBeNull();
    // jsdom has no hit-testing; returning null leaves ProseMirror's ordinary
    // mousedown path inert while the real composer handler still receives it.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    fireEvent.mouseDown(h.editor!.view.dom, { button: 0, detail: 1, clientX: 10, clientY: 10 });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.listening).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(599); });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.listening).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(h.prepare).toHaveBeenCalledOnce();
    view.rerender(<ChatInput {...view.props} />);
    expect(screen.getByTestId('composer-voice-hint').textContent).toBe('newChat.chatInput.voiceInput.speakRelease');
    for (const type of ['selectstart', 'dragstart', 'mousemove']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      h.editor!.view.dom.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
    }
    await act(async () => { fireEvent.mouseUp(window, { button: 0 }); });
    expect(h.stop).toHaveBeenCalledOnce();
    const selection = new Event('selectstart', { bubbles: true, cancelable: true });
    h.editor!.view.dom.dispatchEvent(selection);
    expect(selection.defaultPrevented).toBe(true);
    const releaseClick = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    h.editor!.view.dom.dispatchEvent(releaseClick);
    expect(releaseClick.defaultPrevented).toBe(true);
    fireEvent.pointerDown(document.body, { button: 0 });
    const nextSelection = new Event('selectstart', { bubbles: true, cancelable: true });
    h.editor!.view.dom.dispatchEvent(nextSelection);
    expect(nextSelection.defaultPrevented).toBe(false);
  } finally {
    Reflect.deleteProperty(document, 'elementFromPoint');
    vi.useRealTimers();
  }

  h.listening = false;
  view.rerender(<ChatInput {...view.props} />);
  fireEvent.click(screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' }));
  view.rerender(<ChatInput {...view.props} />);
  expect(screen.getByTestId('composer-voice-hint').textContent).toBe('newChat.chatInput.voiceInput.speakPressAgain');
  h.draftText = 'hello';
  view.rerender(<ChatInput {...view.props} />);
  expect(screen.queryByTestId('composer-voice-hint')).toBeNull();
  h.draftText = '';
  h.listening = false;
  await act(async () => { h.editor!.commands.setContent('<p>Existing text</p>'); });
  view.rerender(<ChatInput {...view.props} />);
  fireEvent.pointerEnter(area);
  expect(screen.queryByTestId('composer-voice-hint')).toBeNull();
});

// 2026-10-26 regression (unit/jsdom): existing guidance must survive the 500ms
// voice hover delay. The empty-composer test above has no recommendation/preview.
it.each(['recommendation', 'preview'] as const)('keeps %s visible while hovering the empty composer', async kind => {
  const sessionId = 'voice-hint-priority';
  const prompt = 'Continue with this plan';
  const view = renderComposer({ sessionId, previewPrompt: kind === 'preview' ? prompt : undefined });
  await waitFor(() => expect(h.editor).not.toBeNull());
  vi.spyOn(makerChatStore, 'getPromptRecommendationCompletionStatus').mockReturnValue({
    turnStoppedByUser: false, hasTerminalError: false, sideTask: false,
    hasBackgroundAgentWork: false, hasAutoDrainingQueue: false,
  });
  if (kind === 'recommendation') {
    await act(async () => {
      promptRecommendations.applyRunningSnapshot(new Map([[sessionId, { isRunning: true }]]));
      promptRecommendations.noteTurnEnded(sessionId, 200);
      promptRecommendations.applyRunningSnapshot(new Map());
      promptRecommendations.settleCompletion(sessionId);
      const seq = beginPromptRecommendationPrediction(sessionId, 200)!;
      resolvePromptRecommendationPrediction(sessionId, 200, seq, prompt);
    });
  }
  expect(screen.getByText(prompt)).toBeTruthy();
  vi.useFakeTimers();
  try {
    fireEvent.pointerEnter(h.editor!.view.dom.parentElement!.parentElement!);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.queryByTestId('composer-voice-hint')).toBeNull();
    expect(screen.getByText(prompt)).toBeTruthy();
    if (kind === 'recommendation') {
      supplyRangeGeometry();
      await act(async () => { fireEvent.keyDown(h.editor!.view.dom, { key: 'Tab' }); });
      expect(h.editor!.getText()).toBe(prompt);
    }
  } finally {
    vi.useRealTimers();
    clearPromptRecommendationSession(sessionId);
  }
});

// #374 / voiceInputButtonAnchor: the real toolbar must keep the voice control
// immediately beside the main action while listening, submitting, refining,
// and returning to idle. A source-text guard could miss a misplaced rendered
// control or a state branch that reintroduces the button jump.
it('keeps the voice button anchored beside the main action through its lifecycle', async () => {
  const view = renderComposer({ isAgentBusy: true });
  await waitFor(() => expect(h.editor).not.toBeNull());

  for (const state of ['listening', 'submitting', 'refining', 'idle'] as const) {
    h.voiceState = state;
    await act(async () => { view.rerender(<ChatInput {...view.props} isAgentBusy />); });
    const root = document.querySelector<HTMLElement>('[data-chat-input-root]')!;
    expect(root).not.toBeNull();
    const voice = root.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(voice).not.toBeNull();
    const actions = [...root.querySelectorAll('button')]
      .filter((button) => {
        const label = button.getAttribute('aria-label') ?? '';
        return button === voice || label.startsWith('newChat.sendButton.');
      });
    const voiceIndex = actions.indexOf(voice);
    expect(voiceIndex, state).toBeGreaterThanOrEqual(0);
    expect(actions.slice(voiceIndex + 1), state).toHaveLength(1);
    expect(actions[voiceIndex + 1]?.getAttribute('aria-label'), state)
      .toMatch(/^newChat\.sendButton\.(queue|send|stop)$/);
    if (state !== 'idle') {
      expect(actions[voiceIndex - 1]?.getAttribute('aria-label'), state)
        .toBe('newChat.sendButton.stop');
    }
  }
});

// 9bc20cf894 / composerMorphScope: choosing a model used to drop focus to body.
// Generic MorphPopover tests supply their own target and miss ChatInput's wiring.
// Minimal unit input: one real selector choice, then focus returns to the live editor.
it('returns focus to the editor after choosing a model from the real selector', async () => {
  h.realModelSelector = true;
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-old'), sshModel('remote-new')])];
  const onModelDidChange = vi.fn();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addListener: noOp, removeListener: noOp, addEventListener: noOp, removeEventListener: noOp }));
  renderComposer({ hideRuntimeControls: false, sessionId: 'model-focus', remoteHostId: 'builder',
    runtimeAgentKind: 'codex', vendorKey: 'codex', initialModel: 'remote-old',
    initialProviderId: 'openai', initialEffort: 'low', onModelDidChange });
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'newChat.modelSelector.trigger.ariaWithEffort' }));
  const nextModel = await screen.findByRole('option', { name: /remote-new/ });
  await act(async () => {
    fireEvent.pointerDown(nextModel);
    nextModel.focus();
    fireEvent.click(nextModel);
  });
  await waitFor(() => expect(screen.queryByRole('listbox', { name: 'newChat.modelSelector.modelListAria' })).toBeNull());
  await waitFor(() => expect(onModelDidChange).toHaveBeenCalledExactlyOnceWith('remote-new'));
  await waitFor(() => expect(document.activeElement).toBe(h.editor!.view.dom));
});

it('defers Escape on top-level surfaces and cancels voice once from the editor', async () => {
  h.listening = true;
  renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  const surfaces = render(<>
    <div role="alertdialog"><button>Dialog action</button></div>
    <div data-morph-side="bottom"><button>Permission action</button></div>
  </>);
  for (const name of ['Dialog action', 'Permission action']) {
    expect(fireEvent.keyDown(screen.getByRole('button', { name }), { key: 'Escape', code: 'Escape' })).toBe(true);
    expect(h.cancel).not.toHaveBeenCalled();
  }
  surfaces.unmount();
  let allowed = true;
  await act(async () => {
    allowed = fireEvent.keyDown(h.editor!.view.dom, { key: 'Escape', code: 'Escape' });
  });
  expect(allowed).toBe(false);
  expect(h.cancel).toHaveBeenCalledExactlyOnceWith();
});

// A prompt preview hides the old draft. Its first key must only dismiss the
// preview; dispatch tests without a preview cannot catch this accidental send.
it('dismisses a preview on Enter without sending or changing the hidden draft', async () => {
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>unsent draft</p>'); });
  view.rerender(<ChatInput {...view.props} previewPrompt="preview suggestion" />);
  expect(screen.getByText('preview suggestion')).toBeTruthy();
  fireEvent.keyDown(h.editor!.view.dom, { key: 'Enter', code: 'Enter' });
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe('unsent draft');
  expect(screen.queryByText('preview suggestion')).toBeNull();
});

// Hardware enters through its own subscription, independently of keydown.
// A second action proves the real subscriber is active after preview dismissal.
it.each([
  { type: 'command', commandId: 'composer.submit' },
  { type: 'skill', skillId: 'example', name: 'example' },
  { type: 'composer-text', text: 'hardware text' },
] satisfies InputDeviceRendererAction[])('dismisses a preview before applying hardware $type actions', async action => {
  supplyRangeGeometry();
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const view = renderComposer({ sessionId: 'hardware-preview', remoteHostId: 'builder',
    runtimeAgentKind: 'codex', vendorKey: 'codex', initialModel: 'remote-only',
    initialProviderId: 'openai', initialEffort: 'low' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>unsent draft</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<ChatInput {...view.props} previewPrompt="preview suggestion" />);
  expect(screen.getByText('preview suggestion')).toBeTruthy();
  await act(async () => { dispatchInputDeviceAction(action); });
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe('unsent draft');
  expect(screen.queryByText('preview suggestion')).toBeNull();
  await act(async () => { dispatchInputDeviceAction(action); });
  if (action.type === 'command') {
    await waitFor(() => expect(view.props.onSend).toHaveBeenCalledTimes(1));
  } else {
    expect(h.editor!.getText()).toContain(action.type === 'skill' ? '$example' : 'hardware text');
    expect(view.props.onSend).not.toHaveBeenCalled();
  }
});

// Observe ChatInput's real voice effect, decoration and scroller together.
// The selection stays elsewhere; only a changed saved range must move the
// ghost caret and scroll it into view, without scrolling to the document end.
it('scrolls to the saved voice draft range and reacts to range-only changes', async () => {
  supplyRangeGeometry();
  const view = renderComposer();
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor!;
  await act(async () => {
    editor.commands.setContent('<p>first</p><p>middle</p><p>last</p>');
    editor.commands.setTextSelection(18);
  });
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const scroller = editor.view.dom;
  const paragraphs = scroller.querySelectorAll('p');
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 100 },
  });
  scroller.scrollTop = 200;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return new DOMRect(0, 0, 200, 100);
    if (this.matches('[data-voice-caret], [data-voice-draft-inline]')) {
      const bottom = this.closest('p') === paragraphs[1] ? 160 : 140;
      return new DOMRect(0, bottom - 10 - (scroller.scrollTop - 200), 10, 10);
    }
    return originalRect.call(this);
  });
  h.voiceState = 'listening';
  h.draftText = 'spoken words';
  h.draftSource = 'partial';
  h.draftRange = { from: 10, to: 10 };
  view.rerender(<ChatInput {...view.props} />);
  await waitFor(() => expect(scroller.scrollTop).toBe(264));
  expect(scroller.querySelector('[data-voice-caret]')?.closest('p')).toBe(paragraphs[1]);
  expect(editor.state.selection.from).toBe(18);

  scroller.scrollTop = 200;
  h.draftRange = { from: 3, to: 3 };
  view.rerender(<ChatInput {...view.props} />);
  await waitFor(() => expect(scroller.scrollTop).toBe(244));
  expect(scroller.querySelector('[data-voice-caret]')?.closest('p')).toBe(paragraphs[0]);
  await act(async () => { editor.commands.setTextSelection(18); });
  expect(scroller.querySelector('[data-voice-caret]')?.closest('p')).toBe(paragraphs[0]);
});

// The removed source guard did not prove the editor consumed the key. Mount the
// real composer with send enabled: an unmatched slash must close its palette
// without submitting or changing the draft. Reuse this editor/host harness.
it.each(['Enter', 'Tab'])('consumes %s for an empty slash result without sending or editing', async key => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const view = renderComposer({ sessionId: 'slash-empty', remoteHostId: 'builder',
    runtimeAgentKind: 'codex', vendorKey: 'codex', initialModel: 'remote-only',
    initialProviderId: 'openai', initialEffort: 'low' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  const text = '/zzzz-no-such-command';
  await act(async () => {
    h.editor!.commands.setContent('<p>' + text + '</p>');
    h.editor!.commands.setTextSelection(text.length + 1);
  });
  await waitFor(() => expect(screen.getByTestId('test-slash-palette').getAttribute('data-query')).toBe(text.slice(1)));
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(false);
  let allowed = true;
  await act(async () => { allowed = fireEvent.keyDown(h.editor!.view.dom, { key, code: key }); });
  expect(allowed).toBe(false);
  expect(view.props.onSend).not.toHaveBeenCalled();
  expect(h.editor!.getText()).toBe(text);
  expect(screen.queryByTestId('test-slash-palette')).toBeNull();
});

// PR #6196 / pendingFolderMention: the hook-only drag test proves enqueueing,
// but not that an already-mounted editor wakes and consumes the queue. Reuse
// this unit harness with the real hook; choosing another folder must append
// once without reinserting the first. Paths are serialized mention targets.
it('inserts queued folders into the mounted editor when the real attachment hook changes', async () => {
  supplyRangeGeometry();
  function AttachmentComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/workspace/docs')}>Choose docs</button>
      <button onClick={() => attachmentState.addFolderPath('/workspace/src')}>Choose src</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId={null}
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        disableAutofocus onSend={vi.fn().mockResolvedValue(true)} />
    </>;
  }
  const view = render(<AttachmentComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Choose docs' }));
  await waitFor(() => expect(screen.getByText('docs/')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Choose src' }));
  await waitFor(() => expect(screen.getByText('src/')).toBeTruthy());
  const chips = view.container.querySelectorAll('[data-mention-chip][data-kind="dir"]');
  expect(Array.from(chips, chip => chip.getAttribute('data-path'))).toEqual([
    '/workspace/docs', '/workspace/src',
  ]);
});

// Remote-folder regression: the real editor and send pipeline must never
// send the source folder as a path reference. The ordinary file payload must
// carry the prepared archive, and failed preparation must preserve the draft.
it.each([
  { success: true, pasteOnly: false },
  { success: false, pasteOnly: false },
  { success: true, pasteOnly: true },
])('waits for a remote folder copy before sending ($success, pasteOnly=$pasteOnly)', async ({ success, pasteOnly }) => {
  supplyRangeGeometry();
  let finish!: (result: { ok: true; path: string; size: number } | { ok: false; code: string }) => void;
  h.uploadChatFolder.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onSend = vi.fn().mockResolvedValue(true);
  function RemoteComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/controller/docs', new File([], 'docs'))}>Drop folder</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId="target"
        sessionId="remote-folder-session" initialModel="gpt-6-sol"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        disableAutofocus onSend={onSend} />
    </>;
  }
  const view = render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  if (pasteOnly) {
    fireEvent.paste(h.editor!.view.dom, { clipboardData: {
      items: [{ kind: 'file', getAsFile: () => new File([], 'docs'),
        webkitGetAsEntry: () => ({ isDirectory: true }) }],
      getData: () => '',
    } });
  } else {
    await act(async () => h.editor!.commands.setContent('<p>Read this folder</p>'));
    fireEvent.click(screen.getByRole('button', { name: 'Drop folder' }));
  }
  await waitFor(() => expect(h.uploadChatFolder).toHaveBeenCalledOnce());
  expect(view.container.querySelector('[data-kind="dir"]')).toBeNull();
  expect(h.editor!.isEditable).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' }));
  await waitFor(() => expect(h.editor!.isEditable).toBe(false));
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => finish(success
    ? { ok: true, path: '/cache/docs.bin', size: 100 }
    : { ok: false, code: 'TRANSFER_FAILED' }));
  if (success) {
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const sent = JSON.stringify(onSend.mock.calls[0]);
    expect(sent).toContain('/cache/docs.bin');
    expect(sent).not.toContain('/controller/docs');
  } else {
    expect(onSend).not.toHaveBeenCalled();
    expect(h.editor!.getText()).toContain('Read this folder');
    expect(screen.getByText('chat.remoteFile.folderFailed')).toBeTruthy();
    h.uploadChatFolder.mockResolvedValue({ ok: true, path: '/cache/docs.bin', size: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Drop folder' }));
    await waitFor(() => expect(screen.queryByText('chat.remoteFile.folderFailed')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  }
});

it.each(['cancel', 'switch', 'queue-switch'] as const)('does not submit a late folder after %s', async action => {
  supplyRangeGeometry();
  let finish!: (result: { ok: true; path: string; size: number }) => void;
  h.uploadChatFolder.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const onSubmit = vi.fn();
  function RemoteComposer({ device = 'target', queueId = 'queue-a' }: { device?: string; queueId?: string }) {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/controller/docs', new File([], 'docs'))}>Drop folder</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId={device}
        sessionId="remote-folder-session" initialModel="gpt-6-sol"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        queueEditingClientId={action === 'queue-switch' ? queueId : null}
        onQueueEditSubmit={onSubmit}
        disableAutofocus onSend={onSubmit} />
    </>;
  }
  const view = render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Drop folder' }));
  await waitFor(() => expect(h.uploadChatFolder).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', {
    name: action === 'queue-switch' ? 'newChat.pendingQueue.editSaveAria' : 'newChat.sendButton.send',
  }));
  await waitFor(() => expect(h.editor!.isEditable).toBe(false));
  if (action === 'cancel') {
    fireEvent.click(screen.getByRole('button', { name: 'chat.remoteFile.cancelFolderPreparation' }));
  } else if (action === 'queue-switch') {
    view.rerender(<RemoteComposer queueId="queue-b" />);
  } else {
    view.rerender(<RemoteComposer device="another-computer" />);
  }
  await act(async () => finish({ ok: true, path: '/cache/docs.bin', size: 100 }));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(view.container.querySelector('[title="docs"]')).toBeNull();
  expect(view.container.querySelector('[data-kind="dir"]')).toBeNull();
});

it('keeps a folder dragged from the remote task browser as a reference without uploading', async () => {
  supplyRangeGeometry();
  function RemoteComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('docs', 'task')}>Reference folder</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId="target"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        disableAutofocus onSend={vi.fn()} />
    </>;
  }
  const view = render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Reference folder' }));
  await waitFor(() => expect(view.container.querySelector('[data-kind="dir"]')?.getAttribute('data-path')).toBe('docs'));
  expect(h.uploadChatFolder).not.toHaveBeenCalled();
});

// PR #6551: the outer drop zone remains usable while Send waits. A second folder
// must join the same message, and its failure must preserve the original draft.
// Unit regression for #6551: the previous Send-only coverage missed queue edits.
// Submit while A is packing, then drop B: both entry points must use the completed
// attachment snapshot (including an otherwise empty edit) or preserve the draft.
it.each([
  { queueEdit: false, success: true, text: 'Read both folders' },
  { queueEdit: false, success: false, text: 'Read both folders' },
  { queueEdit: true, success: true, text: 'Read both folders' },
  { queueEdit: true, success: true, text: '' },
  { queueEdit: true, success: false, text: 'Read both folders' },
])('waits for folders added during submission ($queueEdit, $success, $text)', async ({ queueEdit, success, text }) => {
  supplyRangeGeometry();
  const completions: Array<(value: unknown) => void> = [];
  h.uploadChatFolder.mockImplementation(() => new Promise(resolve => completions.push(resolve)));
  const onSend = vi.fn().mockResolvedValue(true);
  function RemoteComposer() {
    const attachmentState = useAttachments(undefined, 'composer-regression');
    return <>
      <button onClick={() => attachmentState.addFolderPath('/controller/a', new File([], 'a'))}>Drop A</button>
      <button onClick={() => attachmentState.addFolderPath('/controller/b', new File([], 'b'))}>Drop B</button>
      <ChatInput draftKey="composer-regression" deviceLinkDeviceId="target"
        sessionId="remote-folder-session" initialModel="gpt-6-sol"
        attachmentState={attachmentState} hideRuntimeControls showFolderPicker={false}
        queueEditingClientId={queueEdit ? 'queued-message' : null}
        onQueueEditSubmit={queueEdit ? onSend : undefined}
        disableAutofocus onSend={onSend} />
    </>;
  }
  render(<RemoteComposer />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => h.editor!.commands.setContent(`<p>${text}</p>`));
  fireEvent.click(screen.getByRole('button', { name: 'Drop A' }));
  await waitFor(() => expect(completions).toHaveLength(1));
  const submit = screen.getByRole('button', {
    name: queueEdit ? 'newChat.pendingQueue.editSaveAria' : 'newChat.sendButton.send',
  });
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(h.editor!.isEditable).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Drop B' }));
  await waitFor(() => expect(completions).toHaveLength(2));
  await act(async () => completions[0]({ ok: true, path: '/cache/a.bin', size: 100 }));
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => completions[1](success
    ? { ok: true, path: '/cache/b.bin', size: 100 }
    : { ok: false, code: 'TRANSFER_FAILED' }));
  if (success) {
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    const sent = JSON.stringify(onSend.mock.calls[0]);
    expect(sent).toContain('/cache/a.bin');
    expect(sent).toContain('/cache/b.bin');
    expect(sent).not.toContain('/controller/');
  } else {
    expect(onSend).not.toHaveBeenCalled();
    expect(h.editor!.getText()).toContain(text);
  }
});

it('does not let a pending local resource scan repopulate an SSH composer', async () => {
  let finish!: (value: Awaited<ReturnType<typeof scanAtResources>>) => void;
  h.scan.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = renderComposer({ initialWorkingDir: '/workspace' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'test-suggestions' }));
  await waitFor(() => expect(h.scan).toHaveBeenCalled());
  h.atPanel = null;
  view.rerender(<ChatInput {...view.props} remoteHostId="ssh-host" />);
  // Synthetic + remains mounted for SSH, unlike the typed-@ panel. Require
  // fresh ready props so a stale captured value cannot make this test pass.
  const currentPanelState = () => h.atPanel?.state;
  await waitFor(() => expect(currentPanelState()).toEqual({ kind: 'ready', items: [], truncated: false }));
  await act(async () => finish({ success: true, items: [{ type: 'file', relPath: 'stale.txt', name: 'stale.txt' }], truncated: false }));
  expect(currentPanelState()).toEqual({ kind: 'ready', items: [], truncated: false });
});

it('keeps a remote draft with no directory local-scan-free, but searches nonempty queries remotely', async () => {
  renderComposer({ deviceLinkDeviceId: 'remote-device' });
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>@</p>'); h.editor!.commands.setTextSelection(2); });
  await waitFor(() => expect(h.atPanel).not.toBeNull());
  expect(h.scan).not.toHaveBeenCalled();
  await act(async () => { h.editor!.commands.insertContent('needle'); });
  await waitFor(() => expect(h.scan).toHaveBeenCalled());
  expect(h.scan).toHaveBeenLastCalledWith('', expect.any(String), 2000, 'needle', 'remote-device', expect.objectContaining({ includeLocalContext: false, includeTaskHistory: true }));
});

it('restores text, attachments and strokes after an aborted annotated send', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const restoreFiles = vi.fn((files: readonly AttachedFile[]) => [...files]);
  const clearFiles = vi.fn();
  const attachmentState: ComponentProps<typeof ChatInput>['attachmentState'] = {
    attachments: [annotatedImage], hasAttachments: true, addFiles: vi.fn(), addClipboardImage: vi.fn(),
    rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
    pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
    pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
    removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles, restoreFiles,
  };
  // makerChatStore 在烧录失败时返回 false(见 pendingQueueDefer 的中止用例)。
  const onSend = vi.fn().mockResolvedValue(false);
  const view = render(
    <ChatInput sessionId="ssh-annotated" initialWorkingDir="/workspace" runtimeAgentKind="codex"
      vendorKey="codex" deviceLinkDeviceId={null} remoteHostId="builder" attachmentState={attachmentState}
      hideRuntimeControls showFolderPicker={false} disableAutofocus
      initialModel="remote-only" initialProviderId="openai" initialEffort="low" onSend={onSend} />,
  );
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Look at the circled button</p>'); });

  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

  const [, , , , sentFiles, , sendOpts] = onSend.mock.calls[0];
  expect(sendOpts).toEqual(expect.objectContaining({ annotationBurnFailure: 'abort' }));
  expect(sentFiles).toEqual([expect.objectContaining({ id: 'tray-annotated', annotationStrokes: strokes })]);

  // 恢复链路与其它发送失败共用(restoreRemoteOptimisticDraft),正文原样回来、不重复。
  await waitFor(() => expect(h.editor!.getText().trim()).toBe('Look at the circled button'));
  expect(clearFiles).toHaveBeenCalled();
  const restored = restoreFiles.mock.calls.at(-1)?.[0] ?? [];
  expect(restored).toEqual([expect.objectContaining({ id: 'tray-annotated', annotationStrokes: strokes })]);
});

// PR #6433 / unit: retry a recovered creator draft through the real existing-task
// composer. A same-name project skill must never receive it; rejection must retain
// identity for another retry. Prior annotation tests only recovered plain text.
it('rechecks the built-in creator on every restored-task retry', async () => {
  const intent = { name: 'cindy-plugin-creator', commandName: 'cindy-plugin-creator' };
  const text = '/cindy-plugin-creator Make a plugin';
  h.localProviders = [sshProvider('creator-provider', [sshModel('creator-model')], 'claude-code')];
  const userSkill = { kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator' };
  h.listAgentSkills.mockResolvedValue({ success: true, skills: [userSkill] });
  saveDraft('composer-regression', { text: plainTextToTiptapDoc(text), attachments: [], builtInSkillIntent: intent });
  const onSend = vi.fn().mockResolvedValue(false);
  renderComposer({ sessionId: 'creator-session', runtimeAgentKind: 'claude-code', vendorKey: 'cc',
    initialWorkingDir: '/fixture/worktree', initialModel: 'creator-model', initialProviderId: 'creator-provider', onSend });
  await waitFor(() => expect(h.editor?.getText().trim()).toBe(text));
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  expect(onSend).not.toHaveBeenCalled();
  expect(h.listAgentSkills.mock.calls).toContainEqual(['claude-code', { workingDir: '/fixture/worktree', forceReload: true }]);
  expect(getDraft('composer-regression')?.builtInSkillIntent).toEqual(intent);
  h.listAgentSkills.mockResolvedValue({ success: true, skills: [userSkill,
    { ...userSkill, name: 'cindy:cindy-plugin-creator', builtIn: true },
  ] });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0]).toBe('/cindy:cindy-plugin-creator Make a plugin');
  expect(onSend.mock.calls[0][6].builtInSkillIntent).toEqual({ ...intent, commandName: 'cindy:cindy-plugin-creator' });
  expect(h.listAgentSkills).toHaveBeenCalledWith('claude-code', { workingDir: '/fixture/worktree', forceReload: true });
  await waitFor(() => expect(h.editor?.getText().trim()).toBe(text));
  expect(getDraft('composer-regression')?.builtInSkillIntent).toEqual(intent);
  h.listAgentSkills.mockResolvedValue({ success: true, skills: [userSkill] });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(getDraft('composer-regression')?.builtInSkillIntent).toEqual(intent);
});
