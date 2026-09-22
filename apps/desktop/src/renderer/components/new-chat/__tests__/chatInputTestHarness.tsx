// Shared ChatInput integration harness: real editor and draft state, inert host services.
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Editor } from '@tiptap/react';
import type { ChatInput } from '../ChatInput';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined) }));
export { h };
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
const api = new Proxy({} as typeof window.electronAPI, { get: (_obj, key) => {
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return 'darwin';
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
beforeEach(() => { h.editor = null; h.listening = false; h.stop.mockClear(); window.electronAPI = api; vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

export const props = {
  sessionId: 'loading-test', initialWorkingDir: '/workspace', runtimeAgentKind: 'codex' as const,
  vendorKey: 'codex' as const, deviceLinkDeviceId: 'test-host', attachmentState: attachments,
  hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
};
