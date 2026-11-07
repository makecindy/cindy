import { mountPage } from '../../ui-page/harness';
import { ChatAudioCard } from '../../../src/renderer/components/chat/ChatAudioCard';
import { JumpToBottomChip } from '../../../src/renderer/components/chat/JumpToBottomChip';
import { NewMessageIndicator } from '../../../src/renderer/components/chat/NewMessageIndicator';
import { PrevMessageJumpChip } from '../../../src/renderer/components/chat/PrevMessageJumpChip';
import { PermissionSelector } from '../../../src/renderer/components/new-chat/PermissionSelector';
import { ChromeIconButton } from '../../../src/renderer/components/title-bar/ChromeIconButton';
import { Tip } from '../../../src/renderer/components/ui/tooltip';
import { Settings } from 'lucide-react';

const noop = () => {};

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
        <div className="relative h-10 w-56"><JumpToBottomChip visible onClick={noop} bottomOffset={2} /></div>
        <div className="relative h-10 w-56"><NewMessageIndicator visible count={3} onClick={noop} bottomOffset={2} /></div>
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
      <Row title="标题栏图标">
        <ChromeIconButton aria-label="settings" onClick={noop}><Settings size={16} /></ChromeIconButton>
      </Row>
      <Row title="创建伙伴控件">
        {['', '-hover', '-pressed'].map((state) => (
          <span
            key={state}
            data-create-agent-state={state || 'rest'}
            className="rounded-full px-3 py-1"
            style={{ background: `var(--create-agent-control-bg${state})` }}
          >
            {{ '': '默认', '-hover': '悬停', '-pressed': '按下' }[state]}
          </span>
        ))}
      </Row>
    </div>
  ),
});
