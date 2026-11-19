import { useState } from 'react';
import { AppFrame, ctx, forbid, mountPage, subscription } from '../../ui-page/harness';
import { MessageStream } from '../../../src/renderer/components/chat/MessageStream';
import { MarkdownRenderer } from '../../../src/renderer/components/chat/MarkdownRenderer';
import { ChatInput } from '../../../src/renderer/components/new-chat/ChatInput';
import { PluginUiProvider } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import * as proportionalWidth from '../../../src/renderer/hooks/useProportionalWidth';
import { useAttachments } from '../../../src/renderer/hooks/useAttachments';
import { SplitGroup } from '../../../src/renderer/features/cc-agent/SplitGroup';
import { splitGroupStore } from '../../../src/renderer/features/cc-agent/splitGroupStore';
import { LayoutRoot } from '../../../src/renderer/layout/LayoutRoot';
import { usePanelWidth } from '../../../src/renderer/layout/paneWidths';
import { BuiltinPanelBridgeProvider } from '../../../src/renderer/panels/BuiltinPanelBridge';
import { createDefaultLayout, type Layout } from '../../../src/shared/layoutTree';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

const paragraph = '大屏可以承载更完整的工作结果，连续文字仍应保持容易阅读的行宽。打开侧栏或拖动分栏时，内容应跟随聊天面板的实际空间收缩，消息、过程与输入框保持同一中心轴。';
const table = '| 项目 | 适用场景 | 目标 | 当前进展 | 负责人 | 下一步 | 验收方式 |\n|---|---|---|---|---|---|---|\n' +
  Array.from({ length: 4 }, (_, i) => `| 方案 ${i + 1} | 大屏多任务工作区 | 让宽表格利用更多空间 | 等待布局验证 | 设计与开发 | 核对内容与控件边界 | 浅色和深色真实组件截图 |`).join('\n');
const shortTable = '| 项目 | 状态 |\n|---|---|\n| 验证 | 完成 |';
const code = '```ts\n' + Array.from({ length: 4 }, (_, i) => `const section${i} = { title: "Responsive workspace", availableWidth: 1920, columns: ["summary", "progress", "owner", "next step", "validation"] };`).join('\n') + '\n```';
const content = `### 宽屏工作区\n\n${paragraph.repeat(3)}\n\n${table}\n\n${code}\n\n${paragraph}`;
const textContent = `${paragraph.repeat(3)}\n\n${paragraph.repeat(3)}\n\nA larger workspace should make ordinary reading and structured results easier to use together. The available chat pane determines the content width, so opening a reference panel or expanding the sidebar preserves the same layout relationships.\n\n${paragraph.repeat(2)}`;
const messages: ChatMessage[] = [
  { clientId: 'request', role: 'user', content: '请整理这份工作计划，并保留完整表格和代码。' },
  { clientId: 'note', role: 'assistant', content: '先核对当前内容和可用空间。', assistantPhase: 'commentary' },
  { clientId: 'tool', role: 'tool_use', content: '', toolName: 'Read', toolUseId: 'tool', toolInput: { file_path: '/workspace/plan.md' } },
  { clientId: 'result', role: 'tool_result', content: '已读取工作计划。', toolUseId: 'tool' },
  { clientId: 'answer', role: 'assistant', content, assistantPhase: 'final_answer', turnCompleted: true },
];

let layout = createDefaultLayout();
if (layout.content.type === 'split') layout.content.children.forEach(child => { child.fraction = 0.5; });
if (ctx.data.splitWidth) splitGroupStore.addSession('width-b', 'width-a', 'right');

export function Task({ sessionIdProp, compactToolbar }: { sessionIdProp?: string; compactToolbar?: boolean } = {}) {
  // Namespace lookup keeps --compare runnable against the original hook,
  // which has no wide-pane export/option; its unchanged914px behavior is replayed.
  const wideCap = Reflect.get(proportionalWidth, 'CHAT_MESSAGE_MAX_WIDTH')
    ?? Reflect.get(proportionalWidth, 'TASK_MESSAGE_MAX_WIDTH') ?? 914;
  const width = proportionalWidth.useProportionalWidth(914, { expandTo: ctx.data.legacy ? undefined : wideCap });
  const attachmentState = useAttachments(`fixture-task-width-${sessionIdProp ?? 'main'}`);
  return <main className={`flex-1 h-full ${ctx.data.splitWidth ? 'min-w-0' : 'min-w-[400px]'}`} data-task-pane>
    <div ref={width.containerRef} className={`relative h-full w-full${width.isCompact ? ' chat-rail-compact' : ''}`} data-task-width data-wide-cap={wideCap}>
      <MessageStream workingDir="" historyLoaded simplifiedBotConversation={Boolean(ctx.data.companion)} messages={messages.map(message => message.clientId === 'answer'
        ? { ...message, content: ctx.data.textOnly ? textContent : ctx.data.shortTable ? `${content}\n\n${shortTable}` : content,
          ...(ctx.data.streaming ? { isStreaming: true, turnCompleted: false } : {}) }
        : message)} contentWidth={width.messageWidth}
        getContentWidth={width.getMessageWidth} bottomPadding={220} />
      <div className="absolute bottom-0 flex flex-col items-center pb-5 bg-content-area"
        style={{ left: width.inputPad, right: width.inputPad }}>
        <div className="mx-auto" style={{ width: width.inputWidth }} data-width-composer>
          <ChatInput initialWorkingDir="/workspace" runtimeAgentKind="codex" vendorKey="codex"
            attachmentState={attachmentState}
            deviceLinkDeviceId={null} initialModel="fixture-chat" initialProviderId="openai"
            hideRuntimeControls compactToolbar={compactToolbar} showFolderPicker={false} disableAutofocus onSend={forbid('send')} />
        </div>
      </div>
    </div>
  </main>;
}

// The real layout engine owns the divider and pane widths. Only the unrelated
// right-panel contents and sidebar navigation use synthetic read-only data.
function ReferencePanel() {
  const width = usePanelWidth('right-tabs');
  return <aside style={{ width: width ?? '50%' }} className="h-full min-w-0 shrink-0 overflow-hidden border-l border-border bg-content-area" data-width-reference>
    <div className="h-14 border-b border-border px-5 flex items-center text-14">plan.md</div>
    <div className="p-5"><MarkdownRenderer content={'### 工作计划\n\n这里保留参考资料。聊天区与资料区由现有分割线分配空间。'} /></div>
  </aside>;
}
function Fixture() {
  const [sidebar, setSidebar] = useState(!ctx.data.collapsed);
  const [panel, setPanel] = useState(Boolean(ctx.data.panel));
  return <PluginUiProvider>
    <div data-ui-page-control className="fixed left-0 top-0 z-50">
      <button data-testid="toggle-sidebar" onClick={() => setSidebar(value => !value)}>Toggle sidebar</button>
      <button data-testid="toggle-panel" onClick={() => setPanel(value => !value)}>Toggle panel</button>
    </div>
    <AppFrame sidebar={sidebar ? <div className="p-5 text-14">Cindy<br /><br />宽屏工作区</div> : undefined}>
      <BuiltinPanelBridgeProvider value={{ sessionList: null, chatMain: ctx.data.splitWidth ? <SplitGroup activeSessionId="width-a"><Task /></SplitGroup> : <Task />, rightTabs: <ReferencePanel /> }}>
        <LayoutRoot suppressNonChatPanels={!panel} rightTabsCollapsed={!panel} sidebarExpansionReady={false} />
      </BuiltinPanelBridgeProvider>
    </AppFrame>
  </PluginUiProvider>;
}

void mountPage({ route: '/fixture', host: {
  layout: { getStateSync: () => ({ layout }), onChanged: subscription('layout'),
    set: async (next: Layout) => { layout = next; } },
  agentIsland: { onSessionActivity: subscription('activity') },
  maker: { polishWorkingStatus: async () => null, listAgentSkills: async () => ({ success: true, skills: [] }),
    getGoalStatus: async () => null, getSessionAgentSwitchIntent: async () => null,
    onDesktopCommandTriggered: subscription('command'), onSessionCredentialSwitchApplied: subscription('credential'),
    onSessionCredentialSwitchFailed: subscription('credential-failed'), onPiPackagesChanged: subscription('pi'),
    onPluginUiState: subscription('plugin-ui'), mcpApps: async () => ({ updates: [] }) },
  ghosts: { listSync: () => ({ ghosts: [] }), onChanged: subscription('ghosts') },
  deviceLink: { onRemotePush: subscription('remote') },
  voiceInput: { getDataSnapshot: () => ({ settings: { ...getDefaultVoiceInputSettings('darwin'), playInteractionSound: false } }),
    onDataChanged: subscription('voice'), getMicrophonePermissionCached: () => ({ ok: true, status: 'granted' }),
    onGlobalShortcutTrigger: subscription('voice-shortcut') },
}, render: () => <Fixture /> });
