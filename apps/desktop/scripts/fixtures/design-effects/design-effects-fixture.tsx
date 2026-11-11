import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { mountPage } from '../../ui-page/harness';
import { AgentActionRow } from '../../../src/renderer/components/chat/AgentActionRow';
import { ChatAudioCard } from '../../../src/renderer/components/chat/ChatAudioCard';
import { JumpToBottomChip } from '../../../src/renderer/components/chat/JumpToBottomChip';
import { NewMessageIndicator } from '../../../src/renderer/components/chat/NewMessageIndicator';
import { PrevMessageJumpChip } from '../../../src/renderer/components/chat/PrevMessageJumpChip';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { PermissionSelector } from '../../../src/renderer/components/new-chat/PermissionSelector';
import { SidebarIconButton } from '../../../src/renderer/components/sidebar/SidebarIconButton';
import { ChromeIconButton } from '../../../src/renderer/components/title-bar/ChromeIconButton';
import { Tip } from '../../../src/renderer/components/ui/tooltip';
import { Settings } from 'lucide-react';

const noop = () => {};

const CREATE_AGENT_STATES = [
  { state: 'rest', token: '--create-agent-control-bg', label: '默认' },
  { state: 'hover', token: '--create-agent-control-bg-hover', label: '悬停' },
  { state: 'pressed', token: '--create-agent-control-bg-pressed', label: '按下' },
];

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[108px_1fr] items-center gap-3">
      <span className="text-12 text-[var(--text-secondary)]">{title}</span>
      <div className="flex min-h-10 flex-wrap items-center gap-4">{children}</div>
    </div>
  );
}

mountPage({
  route: '/',
  host: () => ({
    maker: {
      getCapabilities: async () => ({
        hasFastMode: false,
        availableModels: [],
        effortLevels: [],
        permissionModes: [
          { id: 'ask', displayName: 'ask' },
          { id: 'acceptEdits', displayName: 'acceptEdits' },
          { id: 'auto', displayName: 'auto' },
        ],
      }),
    },
  }),
  render: () => (
    <div data-design-effects className="flex flex-col gap-4 p-5 text-13 text-[var(--text-primary)]">
      <Row title="浮动胶囊">
        <div data-chip className="relative h-10 w-56"><JumpToBottomChip visible onClick={noop} bottomOffset={2} /></div>
        <div data-chip className="relative h-10 w-56"><NewMessageIndicator visible count={3} onClick={noop} bottomOffset={2} /></div>
        <PrevMessageJumpChip preview="上一条提问的内容" onClick={noop} />
      </Row>
      <Row title="工具提示">
        <Tip text="提示文字" side="right">
          <span data-tip-target className="rounded-full border border-[var(--border-default)] px-3 py-1">悬停这里</span>
        </Tip>
      </Row>
      <Row title="权限面板">
        <div data-permission-field className="w-56">
          <PermissionSelector permissionMode="ask" onPermissionModeChange={noop} triggerVariant="field" />
        </div>
      </Row>
      <Row title="面板下层内容">
        <div className="w-80"><ChatAudioCard track={{ kind: 'music', audioUrl: '', title: '没有封面的音频' }} /></div>
      </Row>
      <Row title="侧栏图标按钮">
        <span data-sidebar-icon><SidebarIconButton icon={Settings} label="settings" onClick={noop} /></span>
      </Row>
      <Row title="工具输入">
        <div data-tool-input className="w-96">
          <AgentActionRow pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} message={{ toolName: 'Grep', toolInput: { pattern: 'shadow-menu', path: 'src' } } as never} />
        </div>
      </Row>
      <Row title="协作消息">
        <div data-orca-message className="w-96">
          <UserMessage pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES} workingDir="/fixture" content={JSON.stringify({ orcaSource: 'lead', content: 'Lead 发给 Worker 的消息正文' })} />
        </div>
      </Row>
      <Row title="标题栏图标">
        <ChromeIconButton aria-label="settings" onClick={noop}><Settings size={16} /></ChromeIconButton>
      </Row>
      <Row title="创建伙伴控件">
        {CREATE_AGENT_STATES.map(({ state, token, label }) => (
          <span key={state} className="rounded-full px-3 py-1" style={{ background: `var(${token})` }}>
            {label}
          </span>
        ))}
      </Row>
    </div>
  ),
});
