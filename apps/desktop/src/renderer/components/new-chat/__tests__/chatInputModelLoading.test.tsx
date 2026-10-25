// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState, type ComponentProps, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProviderView } from '@cindy/model-providers';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { sshNativeCodexProvider, sshModel } from '@/features/cc-agent/__tests__/sshModelFixtures';
import { ChatInput } from '../ChatInput';
import * as providerMemory from '@/state/providerModelMemory';
import * as draftMemory from '@/state/newMakerDraft';
import { getEffortChangeCoordinator } from '../effortChangeQueue';
import { clearDraft } from '@/lib/composerDraftStore';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  __testing as promptRecommendations,
  beginPromptRecommendationPrediction,
  clearPromptRecommendationSession,
  resolvePromptRecommendationPrediction,
} from '@/lib/promptRecommendationStore';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn(), selectModel: undefined as undefined | ((id: string) => Promise<void | boolean>), selectEffort: undefined as string | null | undefined, remoteProviders: [] as ProviderView[],
  localProviders: [] as ProviderView[],
  remoteStatus: 'ready' as 'ready' | 'loading' | 'error',
  platform: 'darwin',
  processing: null as 'submitting' | 'refining' | null,
}));
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: h.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }));
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
vi.mock('../ModelSelector', async (original) => ({ ...await original<typeof import('../ModelSelector')>(), ModelSelector: ({ modelId, onModelChange, disabled, effort }: { modelId: string; onModelChange: typeof h.selectModel; disabled?: boolean; effort?: string | null }) => {
  h.selectModel = onModelChange;
  h.selectEffort = effort;
  return <button data-testid="model-selector" disabled={disabled}>{modelId}</button>;
} }));
vi.mock('@/hooks/useSshCodexProviders', () => ({ useSshCodexProviders: () => ({ providers: h.remoteProviders, status: h.remoteStatus, refresh: () => {} }) }));
vi.mock('../ExtraDirsButton', () => ({ ExtraDirsButton: () => null }));
vi.mock('../PermissionSelector', () => ({ PermissionSelector: () => <span data-testid="permission-selector" /> }));
vi.mock('../NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('../FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: vi.fn() }));
vi.mock('../AtMentionPanel', () => ({ AtMentionPanel: () => null }));
vi.mock('../SlashCommandPalette', () => ({ SlashCommandPalette: () => null }));
vi.mock('@/voice-input/VoiceInputPointerHintLayer', () => ({ VoiceInputPointerHintLayer: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/voice-input/VoiceInputStatusNotice', () => ({ VoiceInputStatusNotice: () => null }));
vi.mock('@/voice-input/useVoiceInput', () => ({ useVoiceInput: (editor: Editor | null) => {
  h.editor = editor;
  return { state: h.processing ?? (h.listening ? 'listening' : 'idle'), isListening: h.listening, isBusy: h.listening || h.processing !== null, draftText: '', start: vi.fn(), stop: h.stop, cancel: vi.fn() };
} }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: h.localProviders, loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({ ...await original<typeof import('@/hooks/useAgentCapabilities')>(), useAgentCapabilities: () => ({ capabilities: null, loading: false }) }));

vi.mock('@/state/newMakerDraft', async (original) => {
  const actual = await original<typeof import('@/state/newMakerDraft')>();
  return { ...actual, getDraft: () => {
    const draft = actual.getDraft();
    return { ...draft, lastByVendor: { ...draft.lastByVendor, codex: { ...draft.lastByVendor.codex, model: 'claude-fable-5-1' } } };
  } };
});

const noOp = () => {};
// External host services are inert; the editor, composer state, and send dispatch run unchanged.
const api: typeof window.electronAPI = new Proxy({} as typeof window.electronAPI, { get: (_obj, key) => {
  if (key === 'setModel') return h.setModel;
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return h.platform;
  if (key === 'then') return undefined;
  if (String(key).startsWith('on')) return () => noOp;
  return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => Reflect.get(api, nested) });
} });
const attachments: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
  rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
  pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
  pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
  removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: (files) => [...files],
};
beforeEach(() => { h.platform = 'darwin'; h.listening = false; h.processing = null; h.stop.mockClear(); h.selectEffort = undefined; window.electronAPI = api; vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); clearDraft('queue-shortcut'); clearPromptRecommendationSession('queue-shortcut'); h.remoteProviders = []; h.localProviders = []; h.remoteStatus = 'ready'; h.setModel.mockReset(); h.confirm.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const props = {
  sessionId: 'loading-test', initialWorkingDir: '/workspace', runtimeAgentKind: 'codex' as const,
  vendorKey: 'codex' as const, deviceLinkDeviceId: 'test-host', attachmentState: attachments,
  hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
};

it.each([null, 'test-host'])('preserves no-effort after creation when sending the second message (%s)', async (deviceLinkDeviceId) => {
  h.localProviders = [sshNativeCodexProvider([sshModel('qwen3:14b', { efforts: [], defaultEffort: null })])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId={undefined} deviceLinkDeviceId={null}
    initialModel="qwen3:14b" initialEffort={null} onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>First message</p>'); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][2]).toBe('');

  view.rerender(<ChatInput {...props} sessionId={`no-effort-created-${deviceLinkDeviceId}`} deviceLinkDeviceId={deviceLinkDeviceId}
    initialModel="qwen3:14b" initialEffort={onSend.mock.calls[0][2]} onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Second message</p>'); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  expect(onSend.mock.calls[1][0]).toBe('Second message');
  expect(onSend.mock.calls[1][2]).toBe('');
});

it.each([null, ''])('adopts an explicit no-effort session snapshot without reusing a stale committed tier (%j)', async (initialEffort) => {
  h.localProviders = [sshNativeCodexProvider([sshModel('qwen3:14b', { efforts: [], defaultEffort: null })])];
  const sessionId = `no-effort-existing-${initialEffort === null ? 'null' : 'empty'}`;
  getEffortChangeCoordinator().setCommittedEffort(sessionId, 'high');
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId={sessionId} deviceLinkDeviceId={null}
    initialModel="qwen3:14b" initialEffort={initialEffort} onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue without effort</p>'); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][2]).toBe('');
});

it('keeps the shared guest model visible but locks selection without locking message input', async () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const inputProps = { ...props, hideRuntimeControls: false, initialModel: 'gpt-6-sol', onSend };
  const view = render(<ChatInput {...inputProps} deviceLinkDeviceId={sharedTaskHostPeer('shared', 'host')} />);
  const selector = () => screen.getByTestId('model-selector') as HTMLButtonElement;
  expect(selector().textContent).toBe('gpt-6-sol');
  expect(selector().disabled).toBe(true);
  await act(async () => { expect(await h.selectModel?.('other-model')).toBe(false); });
  expect(h.setModel).not.toHaveBeenCalled();
  expect(h.editor?.isEditable).toBe(true);

  await act(async () => { view.rerender(<ChatInput {...inputProps} deviceLinkDeviceId="host" />); });
  expect(selector().disabled).toBe(false);
});

const queuedMessage = {
  clientId: 'queue-edit-test',
  text: 'Queued message',
  persistedContent: 'Queued message',
  model: 'gpt-6-astra',
  effort: 'medium',
  permissionMode: 'default',
  workingDir: '/workspace',
  chatMessage: { clientId: 'queue-edit-test', role: 'user' as const, content: 'Queued message' },
  createOpts: {
    agentKind: 'codex' as const,
    model: 'gpt-6-astra',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/workspace',
  },
} as NonNullable<ComponentProps<typeof ChatInput>['pendingQueue']>[number];

// PR #6422: helper-only coverage cannot detect a disconnected window capture
// handler or a visible recommendation being bypassed. Exercise the real editor
// keydown and its outgoing queue/send callbacks. Minimal unit inputs: one/two
// queued rows, a typed draft, or an empty document with a ready recommendation.
// Reuse this jsdom harness; no additional module loads or real timer waits.
// Single-file run: 10.10s (7.68s existing ChatInput import collection, 1.57s tests).
const queueShortcutProps = {
  ...props,
  sessionId: 'queue-shortcut', draftKey: 'queue-shortcut', deviceLinkDeviceId: null,
  initialModel: 'gpt-6-astra', initialProviderId: 'openai', initialEffort: 'medium',
  pendingQueue: [queuedMessage],
};
const queueShortcuts = [
  { platform: 'darwin', metaKey: true, ctrlKey: false },
  { platform: 'win32', metaKey: false, ctrlKey: true },
];

it.each(queueShortcuts)('steers the sole queued message from the empty focused composer on $platform', async shortcut => {
  h.platform = shortcut.platform;
  h.localProviders = [sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onQueueSteer = vi.fn().mockResolvedValue(true);
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ChatInput {...queueShortcutProps} onQueueSteer={onQueueSteer} onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor!.view.dom;
  editor.focus();
  expect(document.activeElement).toBe(editor);
  expect(h.editor!.getText()).toBe('');

  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ...shortcut }); });

  expect(onQueueSteer).toHaveBeenCalledExactlyOnceWith(queuedMessage.clientId);
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['two queued messages', 'typed draft'] as const)('preserves composer dispatch with %s', async scenario => {
  h.localProviders = [sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onQueueSteer = vi.fn().mockResolvedValue(true);
  const onSend = vi.fn().mockResolvedValue(true);
  const pendingQueue = scenario === 'typed draft' ? [queuedMessage] : [queuedMessage, { ...queuedMessage, clientId: 'queue-2' }];
  render(<ChatInput {...queueShortcutProps} pendingQueue={pendingQueue} onQueueSteer={onQueueSteer} onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  if (scenario === 'typed draft') {
    await act(async () => { h.editor!.commands.setContent('<p>Send this draft</p>'); });
  }
  const editor = h.editor!.view.dom;
  editor.focus();
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', metaKey: true }); });

  expect(onQueueSteer).not.toHaveBeenCalled();
  if (scenario === 'typed draft') {
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('Send this draft');
  } else {
    expect(onSend).not.toHaveBeenCalled();
  }
});

it.each(queueShortcuts)('sends the visible recommendation ahead of a queued message on $platform', async shortcut => {
  h.platform = shortcut.platform;
  h.localProviders = [sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onQueueSteer = vi.fn().mockResolvedValue(true);
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ChatInput {...queueShortcutProps} onQueueSteer={onQueueSteer} onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  vi.spyOn(makerChatStore, 'getPromptRecommendationCompletionStatus').mockReturnValue({
    turnStoppedByUser: false, hasTerminalError: false, sideTask: false,
    hasBackgroundAgentWork: false, hasAutoDrainingQueue: false,
  });
  await act(async () => {
    promptRecommendations.applyRunningSnapshot(new Map([['queue-shortcut', { isRunning: true }]]));
    promptRecommendations.noteTurnEnded('queue-shortcut', 200);
    promptRecommendations.applyRunningSnapshot(new Map());
    promptRecommendations.settleCompletion('queue-shortcut');
    const seq = beginPromptRecommendationPrediction('queue-shortcut', 200)!;
    resolvePromptRecommendationPrediction('queue-shortcut', 200, seq, 'Continue with the recommendation');
  });
  expect(screen.getByText('Continue with the recommendation')).toBeTruthy();
  expect(h.editor!.getText()).toBe('');
  const editor = h.editor!.view.dom;
  editor.focus();
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ...shortcut }); });

  expect(onQueueSteer).not.toHaveBeenCalled();
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend.mock.calls[0][0]).toBe('Continue with the recommendation');
  expect(promptRecommendations.getSessionSnapshot('queue-shortcut')).toBeUndefined();
});

function QueueEditHarness({
  onCancel,
  onRemove,
  onSubmit = async () => true,
  onStartVoiceConversation,
}: {
  onCancel: () => void;
  onRemove: () => void;
  onSubmit?: NonNullable<ComponentProps<typeof ChatInput>['onQueueEditSubmit']>;
  onStartVoiceConversation?: () => void;
}) {
  const [editingClientId, setEditingClientId] = useState<string | null>(queuedMessage.clientId);

  return (
    <ChatInput
      {...props}
      onSend={() => undefined}
      onStartVoiceConversation={onStartVoiceConversation}
      pendingQueue={[queuedMessage]}
      queueExpanded={false}
      onQueueExpandedChange={vi.fn()}
      onQueueRemove={onRemove}
      queueEditingClientId={editingClientId}
      onQueueEditBegin={vi.fn()}
      onQueueEditSubmit={onSubmit}
      onQueueEditCancel={() => {
        onCancel();
        setEditingClientId(null);
      }}
    />
  );
}

it('lets a new SSH task with no window report reach main on model selection and retry', async () => {
  const remember = vi.spyOn(providerMemory, 'setProviderModelChoice');
  const draft = vi.spyOn(draftMemory, 'patchVendorPrefs');
  const effortPrefs = vi.spyOn(draftMemory, 'setEffortForModel');
  h.remoteProviders = [sshNativeCodexProvider([sshModel('old'), sshModel('remote-new')])];
  h.setModel.mockRejectedValueOnce(new Error('test host rejected selection')).mockResolvedValue({ deferred: false });
  render(<ChatInput {...props} sessionId="ssh-empty" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="old" initialProviderId="openai" initialEffort="low" hideRuntimeControls={false} onSend={vi.fn()} />);
  await waitFor(() => expect(h.selectModel).toBeTypeOf('function'));
  await act(async () => { await h.selectModel!('remote-new'); });
  // Failed optimistic selection restores the previous model through the same IPC.
  expect(h.setModel).toHaveBeenCalledTimes(2);
  expect(h.setModel.mock.calls[0].slice(0, 2)).toEqual(['ssh-empty', 'remote-new']);
  expect(h.setModel.mock.calls[1].slice(0, 2)).toEqual(['ssh-empty', 'old']);
  await act(async () => { await h.selectModel!('remote-new'); });
  expect(h.setModel).toHaveBeenCalledTimes(3);
  expect(h.setModel.mock.calls[2].slice(0, 2)).toEqual(['ssh-empty', 'remote-new']);
  expect(remember).not.toHaveBeenCalled();
  expect(draft).not.toHaveBeenCalled();
  expect(effortPrefs).not.toHaveBeenCalled();
});

it('sends a remote-only Codex model when the controller has no connected providers', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId="ssh-send" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-only" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Hello remote</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('remote-only');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
});

// 回归：投影 effort 为 null（目录误判/不可调档）时选择器回落会话已持久化档位，
// 不能兜底成字面量 'low'；投影有值时仍优先投影值。
it.each([
  ['null projection with the persisted session effort instead of a literal low', null, 'high', 'high'],
  ['the projected effort wins over the initial prop when present', 'medium', 'high', 'medium'],
] as const)('renders %s', async (_name, projectedEffort, initialEffort, expected) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  render(<ChatInput {...props} hideRuntimeControls={false} sessionId="ssh-effort-fallback" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-only" initialProviderId="openai" initialEffort={initialEffort}
    runtimeEffective={{ agentKind: 'codex', model: 'remote-only', providerId: 'openai', effort: projectedEffort, fastMode: false }}
    onSend={vi.fn()} />);
  await waitFor(() => expect(h.selectEffort).toBe(expected));
});

it.each([
  ['button', 'openai'], ['Enter', 'openai'], ['button', null], ['Enter', null],
] as const)('sends a hidden existing SSH model through %s with provider %s', async (entry, providerId) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-new')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId="ssh-hidden" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-old" initialProviderId={providerId} initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue old task</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => {
    if (entry === 'button') fireEvent.click(send);
    else fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('remote-old');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId }));
  expect(h.confirm).not.toHaveBeenCalled();
});

it.each(['loading', 'error'] as const)('keeps SSH catalog %s blocked for an existing hidden model', async (status) => {
  h.remoteStatus = status;
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} sessionId="ssh-hidden" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-old" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue old task</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['draft', 'other-provider'] as const)('does not exempt a hidden SSH model for %s', async (kind) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-new')])];
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} sessionId={kind === 'draft' ? undefined : 'ssh-hidden'}
    deviceLinkDeviceId={null} remoteHostId="builder" initialModel="remote-old"
    initialProviderId={kind === 'draft' ? 'openai' : 'custom'} initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>New route</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['button', 'Enter', 'voice'] as const)(
  'blocks %s while metadata is absent, retains input, and sends Astra when metadata arrives', async (entry) => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = render(<ChatInput {...props} onSend={onSend} />);
    await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
    await act(async () => { h.editor!.commands.setContent('<p>Continue the task</p>'); });
    const editor = view.container.querySelector('[contenteditable]') as HTMLElement;
    const send = () => screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
    if (entry === 'voice') {
      h.listening = true;
      view.rerender(<ChatInput {...props} onSend={onSend} />);
    }
    const trigger = async () => {
      await act(async () => {
        if (entry === 'button') fireEvent.click(send());
        else fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
      });
    };
    expect(screen.getByTestId('permission-selector')).toBeTruthy();
    expect(screen.queryByTestId('model-selector')).toBeNull();
    expect(send().disabled).toBe(true);
    await trigger();
    expect(onSend).not.toHaveBeenCalled();
    expect(h.editor!.getText()).toBe('Continue the task');
    view.rerender(<ChatInput {...props} onSend={onSend}
      initialModel="gpt-6-astra" initialProviderId="openai" initialEffort="medium" />);
    await waitFor(() => expect(send().disabled).toBe(false));
    await trigger();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    if (entry === 'voice') expect(h.stop).toHaveBeenCalled();
    expect(onSend.mock.calls[0][0]).toBe('Continue the task');
    expect(onSend.mock.calls[0][1]).toBe('gpt-6-astra');
    expect(onSend.mock.calls[0][2]).toBe('medium');
    expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
  },
);

it('hides a missing existing model, recovers from the effective runtime, and preserves new-draft defaults', async () => {
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend} />);
  expect(screen.queryByTestId('model-selector')).toBeNull();
  view.rerender(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend}
    runtimeEffective={{ agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: 'medium', fastMode: false }} />);
  expect(screen.getByTestId('model-selector').textContent).toBe('gpt-6-astra');
  view.rerender(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend} />);
  expect(screen.queryByTestId('model-selector')).toBeNull();
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<ChatInput {...props} sessionId={undefined} hideRuntimeControls={false} onSend={onSend} />);
  expect(screen.getByTestId('model-selector').textContent).toBe('claude-fable-5-1');
  await act(async () => {});
  expect(onSend).not.toHaveBeenCalled();
});

it('hides queue removal while editing and exits editing from the composer cancel button', async () => {
  const onCancel = vi.fn();
  const onRemove = vi.fn();
  render(<QueueEditHarness onCancel={onCancel} onRemove={onRemove} />);

  const cancel = await screen.findByRole('button', {
    name: 'newChat.pendingQueue.editCancelAria',
  });
  expect(screen.getByRole('listitem')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'newChat.pendingQueue.removeAria' }),
  ).toBeNull();

  fireEvent.click(cancel);

  await waitFor(() => {
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'newChat.pendingQueue.editCancelAria' }),
    ).toBeNull();
  });
  fireEvent.mouseEnter(screen.getByRole('listitem'));
  expect(screen.getByRole('button', { name: 'newChat.pendingQueue.removeAria' })).toBeTruthy();
  expect(onRemove).not.toHaveBeenCalled();
});

it('blocks queue edit saves while voice capture is active', async () => {
  h.listening = true;
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(<QueueEditHarness onCancel={vi.fn()} onRemove={vi.fn()} onSubmit={onSubmit} />);

  const save = (await screen.findByRole('button', {
    name: 'newChat.pendingQueue.editSaveAria',
  })) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  fireEvent.click(save);
  expect(onSubmit).not.toHaveBeenCalled();
});

// The slot survives missing metadata; only the model control is withheld.
it.each([320, 480, 800])('preserves the model slot across hydration (width=%s)', async (width) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  const narrowToolbar = width < 600;
  const onSend = vi.fn();
  const inputProps = { ...props, hideRuntimeControls: false, narrowToolbar, onSend };
  const view = render(<ChatInput {...inputProps} />);
  const slot = view.container.querySelector('[data-session-model-slot]') as HTMLElement;
  expect(slot).not.toBeNull();
  const geometry = slot.className;
  expect(slot.textContent).toBe('');
  expect(slot.querySelector('button, [tabindex]')).toBeNull();
  expect(screen.queryByTestId('model-selector')).toBeNull();
  view.rerender(<ChatInput {...inputProps} initialModel="gpt-6-astra" />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBe(slot);
  if (narrowToolbar) {
    expect(slot.className).toBe(geometry);
  } else {
    // Loaded wide toolbars must not inherit the loading placeholder's width.
    expect(slot.classList.contains('w-[148px]')).toBe(false);
    expect(slot.classList.contains('h-[30px]')).toBe(true);
    expect(slot.classList.contains('min-w-0')).toBe(true);
  }
  expect(slot.contains(screen.getByTestId('model-selector'))).toBe(true);
  view.rerender(<ChatInput {...inputProps} />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBe(slot);
  expect(slot.className).toBe(geometry);
  expect(slot.textContent).toBe('');
  view.rerender(<ChatInput {...inputProps} hideRuntimeControls />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBeNull();
  expect(screen.getByTestId('permission-selector')).toBeTruthy();
  await act(async () => {});
  expect(onSend).not.toHaveBeenCalled();
});

// Real editor/send regression: companion mode replaces the idle action, not the
// dispatch pipeline. The previous three-button behavior did not exercise these transitions.
function companionProps() {
  h.localProviders = [sshNativeCodexProvider([sshModel('fixture-chat')])];
  return { ...props, deviceLinkDeviceId: null, initialModel: 'fixture-chat', initialProviderId: 'openai' };
}

it('switches one companion action between call and send, retaining focus and dispatching the draft once', async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const onStartVoiceConversation = vi.fn();
  const inputProps = { ...companionProps(), onSend, onStartVoiceConversation };
  const view = render(<ChatInput {...inputProps} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  const call = screen.getByRole('button', { name: 'bots.voiceMode.startConversation' }) as HTMLButtonElement;
  const dictation = screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' });
  expect(dictation.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'newChat.sendButton.send' })).toBeNull();
  expect(call.disabled).toBe(false);
  fireEvent.click(call);
  expect(onStartVoiceConversation).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => { h.editor?.commands.setContent('<p>   </p>'); });
  expect(screen.getByRole('button', { name: 'bots.voiceMode.startConversation' })).toBe(call);
  act(() => { call.focus(); });
  await act(async () => { h.editor?.commands.setContent('<p>Keep this draft</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' });
  expect(send).toBe(call);
  expect(document.activeElement).toBe(send);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  view.rerender(<ChatInput {...inputProps} disabled />);
  expect(screen.getByRole('button', { name: 'newChat.sendButton.send' })).toBe(call);
  expect(call.disabled).toBe(true);

  view.rerender(<ChatInput {...inputProps} voiceConversationDisabled />);
  // Voice availability cannot disable a valid text send.
  expect(call.disabled).toBe(false);
  view.rerender(<ChatInput {...inputProps} voiceConversationActive />);
  // The call now leaves the composer visible. Its production mutation lock
  // must reject text sends (not just dim the controls) while retaining drafts.
  expect(h.editor?.isEditable).toBe(false);
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
  expect(h.editor?.getText()).toBe('Keep this draft');
  view.rerender(<ChatInput {...inputProps} voiceConversationActive={false} />);
  expect(h.editor?.isEditable).toBe(true);
  expect(h.editor?.getText()).toBe('Keep this draft');
  expect(document.activeElement).toBe(call);

  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend.mock.calls[0][0]).toBe('Keep this draft');
  expect(screen.getByRole('button', { name: 'bots.voiceMode.startConversation' })).toBe(call);
  expect(fireEvent.keyDown(call, { key: 'Enter', repeat: true })).toBe(false);
  expect(onStartVoiceConversation).toHaveBeenCalledOnce();
  view.rerender(<ChatInput {...inputProps} voiceConversationDisabled />);
  expect(call.disabled).toBe(true);

  view.rerender(<ChatInput {...props} onSend={onSend} />);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  expect(screen.getByRole('button', { name: 'newChat.sendButton.send' })).toBeTruthy();
  await act(async () => {});
});

it.each(['pointer', 'Space'] as const)('does not activate a changed companion action after a %s press', async (input) => {
  const onStartVoiceConversation = vi.fn();
  const onSend = vi.fn();
  render(<ChatInput {...companionProps()} onSend={onSend} onStartVoiceConversation={onStartVoiceConversation} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  const action = screen.getByRole('button', { name: 'bots.voiceMode.startConversation' });
  const press = () => input === 'pointer'
    ? fireEvent.pointerDown(action)
    : fireEvent.keyDown(action, { key: ' ' });
  press();
  await act(async () => { h.editor?.commands.setContent('<p>Arrived during press</p>'); });
  fireEvent.click(action);
  expect(onSend).not.toHaveBeenCalled();
  press();
  await act(async () => { h.editor?.commands.clearContent(); });
  fireEvent.click(action);
  expect(onStartVoiceConversation).not.toHaveBeenCalled();
  // A fresh activation of the currently displayed action still works.
  fireEvent.click(action);
  expect(onStartVoiceConversation).toHaveBeenCalledOnce();
});

it('keeps attachment-only sends and the running stop/queue actions available for companions', async () => {
  const onStop = vi.fn();
  const inputProps = { ...companionProps(), onSend: vi.fn(), onStop, onStartVoiceConversation: vi.fn() };
  const view = render(<ChatInput {...inputProps} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  const call = screen.getByRole('button', { name: 'bots.voiceMode.startConversation' });
  const attached = { ...attachments, hasAttachments: true, attachments: [{
    id: 'voice-switch-file', name: 'notes.txt', path: '/fixture/notes.txt', ext: '.txt',
    size: 12, category: 'text' as const, mimeType: 'text/plain',
  }] };
  view.rerender(<ChatInput {...inputProps} attachmentState={attached} />);
  expect(screen.getByRole('button', { name: 'newChat.sendButton.send' })).toBe(call);
  view.rerender(<ChatInput {...inputProps} />);
  expect(screen.getByRole('button', { name: 'bots.voiceMode.startConversation' })).toBe(call);
  view.rerender(<ChatInput {...inputProps} isStreaming />);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.stop' }));
  expect(onStop).toHaveBeenCalledOnce();
  await act(async () => { h.editor?.commands.setContent('<p>Next message</p>'); });
  expect(screen.getByRole('button', { name: 'newChat.sendButton.queue' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'newChat.sendButton.stop' })).toHaveLength(1);
});

it.each(['listening', 'submitting', 'refining'] as const)('retains the send target during companion dictation %s', async (state) => {
  const inputProps = { ...companionProps(), onSend: vi.fn(), onStartVoiceConversation: vi.fn() };
  const view = render(<ChatInput {...inputProps} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  h.listening = state === 'listening';
  h.processing = state === 'listening' ? null : state;
  view.rerender(<ChatInput {...inputProps} />);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(state !== 'listening');
});

it('keeps save/cancel when editing a queued companion message', async () => {
  const onStartVoiceConversation = vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(<QueueEditHarness onCancel={vi.fn()} onRemove={vi.fn()}
    onSubmit={onSubmit} onStartVoiceConversation={onStartVoiceConversation} />);
  await act(async () => { h.editor?.commands.setContent('<p>Edited queued message</p>'); });
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  expect(screen.getByRole('button', { name: 'newChat.pendingQueue.editCancelAria' })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.pendingQueue.editSaveAria' })); });
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onStartVoiceConversation).not.toHaveBeenCalled();
});
