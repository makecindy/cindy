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
import { sshNativeCodexProvider, sshModel } from '@/features/cc-agent/__tests__/sshModelFixtures';
import type { AttachedFile } from '@/lib/fileTypes';
import { ChatInput } from '../ChatInput';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn(), selectModel: undefined as undefined | ((id: string) => Promise<void | boolean>), remoteProviders: [] as ProviderView[],
  remoteStatus: 'ready' as 'ready' | 'loading' | 'error',
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
vi.mock('../ModelSelector', async (original) => ({ ...await original<typeof import('../ModelSelector')>(), ModelSelector: ({ modelId, onModelChange }: { modelId: string; onModelChange: typeof h.selectModel }) => {
  h.selectModel = onModelChange;
  return <span data-testid="model-selector">{modelId}</span>;
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
  return { state: h.listening ? 'listening' : 'idle', isListening: h.listening, isBusy: h.listening, draftText: '', start: vi.fn(), stop: h.stop, cancel: vi.fn() };
} }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [], loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({ ...await original<typeof import('@/hooks/useAgentCapabilities')>(), useAgentCapabilities: () => ({ capabilities: null, loading: false }) }));

const noOp = () => {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = new Proxy({}, { get: (_obj, key) => {
  if (key === 'setModel') return h.setModel;
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return 'darwin';
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
  window.electronAPI = api;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); h.remoteProviders = []; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
