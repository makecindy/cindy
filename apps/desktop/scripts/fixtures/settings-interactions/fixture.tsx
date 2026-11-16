import { mountPage, subscription } from '../../ui-page/harness';
import { PluginSetupPrompt } from '../../../src/renderer/components/new-chat/PluginSetupPrompt';
import { SettingsLinkChip } from '../../../src/renderer/components/chat/SettingsLinkChip';
import type { PendingPluginSetup } from '../../../src/renderer/lib/makerChatStore';

void mountPage({
  route: '/cc-agent/fixture',
  host: {
    deviceLink: {
      getState: async () => ({ linkStatus: 'online' }),
      listDevices: async () => ({ devices: [{ deviceId: 'studio', name: 'Mac Studio', platform: 'darwin', online: true, remoteControlEnabled: true, controlEnabled: true, isSelf: false }] }),
      onPresenceChanged: subscription('presence'), onStatusChanged: subscription('status'),
      onControlTargetChanged: subscription('control'), onDeviceDirectoryInvalidated: subscription('directory'),
    },
    maker: { pluginOauthDeviceCode: async () => ({ phase: 'browser', expiresAt: Date.now() + 300000 }) },
  },
  render: ({ case: scenario }) => {
    const manual = scenario === 'secret';
    const fallback = scenario === 'remote-settings';
    const done = scenario === 'connected';
    const failed = scenario === 'retry';
    const waiting = scenario === 'waiting';
    const pending: PendingPluginSetup = {
      requestId: 'preview-only', revision: 1,
      ghost: { id: 'preview-service', name: manual ? '示例服务' : 'Slack（示例）' },
      remoteOauth: !manual && !fallback,
      terminal: done,
      intro: manual ? '填写此服务的 API Key，保存到执行任务的电脑。' : '连接账号后，才能继续处理你的请求。',
      steps: [{
        id: 'account', groupId: 'account', groupMode: 'any_of',
        title: manual ? '添加 API Key' : fallback ? '在 Mac Studio 上配置连接' : '连接 Slack 账号',
        description: manual ? '密钥只交给宿主保存，不会写入聊天记录。' : fallback ? '此配置步骤需要在目标电脑的界面中完成。' : '请在授权页面选择工作区并确认访问权限。',
        phase: done ? 'satisfied' : failed ? 'failed' : waiting ? 'waiting_external' : 'pending',
        ...(failed ? { errorMessage: '本次授权未完成，请重试。' } : {}),
        action: manual ? { id: 'inline:api-key', kind: 'inline_form', form: { fields: [{ id: 'value', type: 'secret', label: 'API Key', placeholder: '输入 API Key', required: true, maxLength: 200 }] } }
          : fallback ? { id: 'settings:account', kind: 'open_plugin_settings' }
          : { id: 'oauth_connect:account', kind: 'oauth_connect' },
      }],
    };
    return <div className="p-4 text-14 text-[var(--text-primary)]" data-ui-page-subject>
      {scenario === 'settings' ? <div className="space-y-4">
        <p>可以在外观设置中调整字体大小。</p>
        <SettingsLinkChip target={{ tab: 'appearance', deviceId: 'studio', query: '字体' }} />
        <p>需要启用电脑操作时，可直接打开工具设置。</p>
        <SettingsLinkChip target={{ tab: 'builtin-tools', deviceId: 'studio' }} />
      </div> : <PluginSetupPrompt pending={pending} compact={false} remote={!manual} remoteDeviceId={!manual ? 'studio' : undefined}
        viewerState="expanded" onViewerStateChange={() => {}} onCommand={() => {}} commandInFlight={null} />}
    </div>;
  },
});
