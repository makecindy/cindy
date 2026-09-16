// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Editor } from '@tiptap/react';
import { ChatInput } from '../ChatInput';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined) }));
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: h.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('../ModelSelector', async (original) => ({ ...await original<typeof import('../ModelSelector')>(), ModelSelector: ({ modelId }: { modelId: string }) => <span data-testid="model-selector">{modelId}</span> }));
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
  return { state: h.listening ? 'listening' : 'idle', isListening: h.listening, isBusy: h.listening, draftText: '', start: vi.fn(), stop: h.stop, cancel: vi.fn() };
} }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [], loading: false }) }));
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
const api: any = new Proxy({}, { get: (_obj, key) => {
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return 'darwin';
  if (key === 'then') return undefined;
  if (String(key).startsWith('on')) return () => noOp;
  return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => api[nested] });
} });
const attachments: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
  rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
  pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
  pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
  removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: (files) => [...files],
};
beforeEach(() => { h.listening = false; h.stop.mockClear(); window.electronAPI = api; vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const props = {
  sessionId: 'loading-test', initialWorkingDir: '/workspace', runtimeAgentKind: 'codex' as const,
  vendorKey: 'codex' as const, deviceLinkDeviceId: 'test-host', attachmentState: attachments,
  hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
};

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
  expect(slot.className).toBe(geometry);
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
