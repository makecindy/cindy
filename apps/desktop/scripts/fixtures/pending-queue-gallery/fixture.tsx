import { formatQuoteForSend } from '../../../src/renderer/lib/chatQuotes';
import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, subscription } from '../../ui-page/harness';
import { PendingQueueBubble } from '../../../src/renderer/components/chat/PendingQueueBubble';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { ErrorBanner } from '../../../src/renderer/components/chat/ErrorBanner';
import { CredentialSwitchWaitBanner } from '../../../src/renderer/components/chat/CredentialSwitchWaitBanner';
import { Spinner } from '../../../src/renderer/components/ui/spinner';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { CONTINUE_AFTER_ERROR_PROMPT } from '../../../src/shared/interruptedTurn';
import type { QueuedMessage } from '../../../src/renderer/lib/makerChatStore';
import photo from '../../../src/renderer/assets/bot-presets/cindy.png';
const noop = () => {};
if (!crypto.randomUUID) {
  let n = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
function entry(clientId: string, text: string): QueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    chatMessage: { clientId, role: 'user', content: text, isStreaming: false },
    createOpts: {
      agentKind: 'codex',
      workingDir: '/fixture',
      model: 'fixture-chat',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: false,
      displayReasoning: 'summarized',
    },
  } as QueuedMessage;
}
function makeQueue(kind: string) {
  const q = [
    entry('first', '先核对手机版的消息排队逻辑。'),
    entry('second', '把桌面版的交互对齐，保留图片、附件和引用。'),
  ];
  if (kind === 'empty' || kind === 'delivered') return [];
  if (kind === 'single') return q.slice(0, 1);
  if (kind === 'many')
    return Array.from({ length: 6 }, (_, i) =>
      entry(
        `row-${i}`,
        `第 ${i + 1} 条待发消息：${['核对现状', '调整气泡', '补齐菜单', '检查编辑', '验证回流', '整理结果'][i]}。`,
      ),
    );
  if (kind === 'menu') q.push(entry('third', '最后检查深色模式和窄窗口。'));
  if (kind === 'sending') q[0].isPendingEnqueue = true;
  if (kind === 'long') {
    q[0] = entry(
      'first',
      Array.from(
        { length: 18 },
        (_, i) => `第 ${i + 1} 项：排队消息保持完整内容，支持查看和编辑；正式回流后不应重复出现。`,
      ).join('\n'),
    );
  }
  if (['attachments', 'companion', 'attachment-only', 'files-only'].includes(kind)) {
    q[0].chatMessage.images = [{ url: photo, mimeType: 'image/png', originalName: '界面参考.png' }];
    q[0].chatMessage.files = [{ name: '排队交互说明.pdf', path: '/fixture/排队交互说明.pdf' }];
  }
  if (kind === 'attachment-only' || kind === 'files-only') {
    q[0].text = '';
    q[0].chatMessage.content = '';
    if (kind === 'files-only') q[0].chatMessage.images = [];
  }
  if (kind === 'sources') {
    q[0].origin = {
      kind: 'session',
      senderSessionId: 'fixture-other',
      senderSessionTitle: '设计复核',
      displayText: q[0].text,
    } as QueuedMessage['origin'];
    q[1].sourcePlugin = {
      pluginId: 'fixture-plugin',
      name: '评测工坊',
    } as QueuedMessage['sourcePlugin'];
    const timed = entry('third', '检查本次改动的测试结果。');
    timed.origin = {
      kind: 'scheduler',
      scheduleId: 'fixture-schedule',
      scheduleName: '每日检查',
    } as QueuedMessage['origin'];
    q.push(timed);
  }
  if (kind === 'device')
    q[0].sourceDevice = { deviceId: 'fixture-phone', name: 'iPhone', platform: 'mobile' };
  if (kind === 'quote') {
    q[0] = entry(
      'first',
      formatQuoteForSend({ text: '排队消息应与正式消息保持同一气泡。' }) +
        '\n\n请按这条要求检查交互。',
    );
    q[0].chatMessage.quotesEncoded = true;
  }
  if (kind === 'synthetic') {
    q[0] = entry('first', CONTINUE_AFTER_ERROR_PROMPT);
  }
  return q;
}
const files: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [],
  hasAttachments: false,
  addFiles: async () => {},
  addClipboardImage: async () => {},
  rejections: [],
  dismissRejection: noop,
  clearRejections: noop,
  addFolderPath: noop,
  pendingFoldersVersion: 0,
  consumePendingFolders: () => [],
  addFileMention: noop,
  pendingFileMentionsVersion: 0,
  consumePendingFileMentions: () => [],
  removeFile: noop,
  updateFile: noop,
  discardFiles: noop,
  clearFiles: noop,
  restoreFiles: (files) => [...files],
};
function Fixture({ kind }: { kind: string }) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState(() => makeQueue(kind));
  const [editing, setEditing] = useState<string | null>(kind === 'editing' ? 'first' : null);
  const [paused, setPaused] = useState(kind === 'paused');
  const companion = kind === 'companion';
  return (
    <main className="flex h-screen flex-col bg-[hsl(var(--content-area))] text-[var(--text-primary)]">
      <header className="shrink-0 border-b border-[var(--border-default)] px-6 py-3 text-13">
        桌面消息排队 · 场景预览
      </header>
      <div
        className="mx-auto flex min-h-0 w-full max-w-[880px] flex-1 flex-col overflow-y-auto px-6 pt-5 pb-3"
        data-gallery-stream
      >
        <div className="mb-6 text-14 text-[var(--msg-assistant-text)]">
          正在核对两端的消息排队逻辑，接下来检查显示位置和操作菜单。
        </div>
        <div className="flex flex-col gap-3.5">
          {kind === 'delivered' && (
            <UserMessage
              workingDir="/fixture"
              content="先核对手机版的消息排队逻辑。"
              createdAt="2026-11-08T00:00:00Z"
            />
          )}
          {queue.map((entry, index) => (
            <PendingQueueBubble
              key={entry.clientId}
              entry={entry}
              index={index}
              count={queue.length}
              editingClientId={editing}
              steeringClientIds={kind === 'steering' ? ['first'] : []}
              editLocks={kind === 'remote-edit' ? ['first'] : editing ? [editing] : []}
              interactionLocks={kind === 'locked' ? ['other-device'] : []}
              readOnly={kind === 'readonly' || kind === 'stopping'}
              simplifiedBotConversation={companion}
              onEdit={(entry) => setEditing(entry.clientId)}
              onSteer={async (id) => {
                setQueue((q) => q.filter((e) => e.clientId !== id));
                return true;
              }}
              onRemove={(id) => setQueue((q) => q.filter((e) => e.clientId !== id))}
              onMove={(id, target) =>
                setQueue((q) => {
                  const from = q.findIndex((e) => e.clientId === id);
                  const result = q.filter((e) => e.clientId !== id);
                  result.splice(target > from ? target - 1 : target, 0, q[from]);
                  return result;
                })
              }
            />
          ))}
        </div>
        {/* The two inline status rows use the exact task-page composition; the runtime is not mounted. */}
        {paused && (
          <div className="flex items-center justify-between gap-2 py-2 text-12 text-[var(--text-secondary)]">
            <span>{t('newChat.pendingQueue.pausedFooter')}</span>
            <button
              type="button"
              onClick={() => setPaused(false)}
              className="min-h-8 rounded-lg px-2 hover:bg-[var(--surface-hover)]"
            >
              {t('newChat.pendingQueue.resumeAction')}
            </button>
          </div>
        )}
        {kind === 'stopping' && (
          <div
            role="status"
            className="flex min-h-8 items-center gap-2 text-12 text-[var(--text-secondary)]"
          >
            <Spinner size={14} />
            {t('newChat.pendingQueue.stopping')}
          </div>
        )}
        {kind === 'error' && (
          <ErrorBanner
            error="Request failed: connection reset"
            agentKind="cc"
            retryText="original message"
            onRetry={noop}
            onCancel={noop}
          />
        )}
        {kind === 'autoretry' && (
          <ErrorBanner
            error="Service temporarily unavailable (503)"
            agentKind="cc"
            isRecoverable
            onCancel={noop}
          />
        )}
        {kind === 'quota' && (
          <ErrorBanner
            error={'402: {"message":"Insufficient Balance","type":"insufficient_balance_error"}'}
            agentKind="cc"
            providerId="custom"
            errorSourceProviderId="custom"
            onRetry={noop}
            retryText="original message"
          />
        )}
        {kind === 'credential' && (
          <CredentialSwitchWaitBanner blockedBySessionIds={[]} onCancel={noop} />
        )}
      </div>
      <div className="mx-auto w-full max-w-[880px] shrink-0 px-6 pb-5 pt-3">
        <ChatInput
          sessionId="queue-gallery"
          initialWorkingDir="/fixture"
          runtimeAgentKind="codex"
          vendorKey="codex"
          deviceLinkDeviceId={null}
          initialModel="fixture-chat"
          initialProviderId="openai"
          attachmentState={files}
          hideRuntimeControls
          showFolderPicker={false}
          disableAutofocus
          pendingQueue={queue}
          queueEditingClientId={editing}
          onQueueEditCancel={() => setEditing(null)}
          onQueueEditSubmit={async () => {
            setEditing(null);
            return true;
          }}
          isStreaming={
            !['paused', 'stopping', 'error', 'credential', 'empty', 'delivered'].includes(kind)
          }
          onStop={noop}
          onSend={noop}
        />
      </div>
    </main>
  );
}
void mountPage({
  route: '/sessions/queue-gallery',
  host: {
    maker: {
      onDesktopCommandTriggered: subscription('desktop-command'),
      onSessionCredentialSwitchApplied: subscription('credential-applied'),
      onSessionCredentialSwitchFailed: subscription('credential-failed'),
      onPiPackagesChanged: subscription('pi-packages'),
      listAgentSkills: async () => ({ success: true, skills: [] }),
      getSessionAgentSwitchIntent: async () => null,
    },
    voiceInput: {
      getDataSnapshot: () => ({
        settings: { ...getDefaultVoiceInputSettings('darwin'), playInteractionSound: false },
      }),
      onDataChanged: subscription('voice-data'),
      onGlobalShortcutTrigger: subscription('voice-shortcut'),
    },
    deviceLink: {
      onRemotePush: subscription('remote-push'),
      onPresenceChanged: subscription('presence'),
      onStatusChanged: subscription('device-status'),
      onControlTargetChanged: subscription('control-target'),
      getState: async () => ({ status: 'online' }),
      getDevices: async () => [],
      listDevices: async () => [],
    },
    ghosts: { listSync: () => ({ ghosts: [] }) },
  },
  render: (ctx) => <Fixture kind={ctx.case} />,
});
