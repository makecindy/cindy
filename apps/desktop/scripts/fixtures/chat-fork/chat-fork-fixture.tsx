import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { ProviderView } from '@cindy/model-providers';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { AssistantMessage } from '../../../src/renderer/components/chat/AssistantMessage';
import { MessageReadAloudContext } from '../../../src/renderer/components/chat/MessageReadAloudContext';
import { ThreadPanel } from '../../../src/renderer/features/bots/ThreadPanel';

const provider = { id: 'fixture-provider', name: 'Example Provider', source: 'user', auth: { method: 'none' },
  connected: true, agents: ['codex'], routing: { codex: {} },
  models: { codex: [{ id: 'fixture-model', name: 'Example Model', mode: 'chat', contextWindow: 128000,
    efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] } } as unknown as ProviderView;
const owner = getDataOwnerGeneration();
const catalog = { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation, providers: [provider], providerOrder: [provider.id] };
commitProvidersSnapshot(beginProvidersRefresh(), catalog);

function CompanionReply() {
  const [reading, setReading] = useState(false);
  return <MessageReadAloudContext.Provider value={{
    sessionId: 'shared-task', available: true, disabled: false,
    messageId: reading ? 'reply-2' : null, phase: reading ? 'playing' : 'idle',
    canRead: () => true, toggle: () => setReading(value => !value),
  }}>
    <AssistantMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/project" currentSessionId="shared-task" messageClientId="reply-2"
      content="先收好桌面上的文件，再把常用物品放回顺手的位置。整理完成后，记得留出一块空白的工作区域。"
      agentKind="cc" simplifiedBotConversation showActionBar />
  </MessageReadAloudContext.Provider>;
}

void mountPage({
  route: '/cc-agent/shared-task',
  host: {
    safeStorageRead: async () => null,
    deviceLink: {
      listDevices: async () => [], getState: async () => ({ remoteControlEnabled: false, linkStatus: 'stopped' }),
      onPresenceChanged: subscription('presence'), onStatusChanged: subscription('linkStatus'),
      onControlTargetChanged: subscription('controlTargets'), onRemotePush: subscription('remotePush'),
    },
    maker: {
      listProviders: async () => catalog, requestProviderModelsAutoRefresh: async () => undefined,
      listAvailableAgents: async () => ['codex'], onProvidersChanged: subscription('providersChanged'),
      getModelContextLimit: async () => ({ limit: 128000, isCustomized: false }),
      fork: async (request: { action: string; target?: unknown }) => {
        if (request.action === 'capabilities') return { forkRequestVersion: 1, historyHandoff: true };
        if (request.action === 'status') return { state: 'failed' };
        if (request.target) return { state: 'complete', session: { id: 'fixture-child' }, outcome: 'history-handoff' };
        throw new Error('[REMOTE_AGENT_UNAVAILABLE] fixture native history is offline');
      },
      getCapabilities: async () => ({ availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [], fork: { supported: true }, rewind: { supported: false } }),
    },
  },
  render: (ctx) => ctx.case === 'companion-thread'
    ? <div className="flex h-screen" data-ui-page-subject><div className="flex-1" /><ThreadPanel onClose={() => undefined}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4"><CompanionReply />
          <UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/project" content="这些文件整理好了，请继续检查附件与结果是否完整。" sessionId="shared-task" messageClientId="user-2" agentKind="cc" simplifiedBotConversation />
        </div></ThreadPanel></div>
    : ctx.case.startsWith('companion')
    ? <div className="p-4" data-ui-page-subject><CompanionReply /></div>
    : <div className="p-8 space-y-10" data-ui-page-subject>
    <UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/project" content="技术上能想办法实现吗？" sessionId="shared-task" messageClientId="user-2" agentKind="cc" remoteHostId={ctx.case === 'ssh' ? 'ssh-host' : undefined} />
    <AssistantMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/project" content="可以。分叉后会保留历史上下文，继续使用原来那台电脑上的共享模型。" currentSessionId="shared-task" messageClientId="reply-2" agentKind="cc" remoteHostId={ctx.case === 'ssh' ? 'ssh-host' : undefined} showActionBar />
  </div>,
});
