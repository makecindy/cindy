import manifest from '../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/host-ui/ghost.json';
import { ghostHostUiApprovalTokens, type InstalledGhost } from '../../../src/shared/ghost';
import { pluginUiInterestKey, type PluginUiInterest, type PluginUiStateChange } from '../../../src/shared/pluginUi';
import { PluginUiBody, PluginUiMenu, PluginUiProvider, PluginUiSlot, usePluginUiMessageCandidates } from '../../../src/renderer/cindy-brain/PluginUiContributions';
import { Button } from '../../../src/renderer/components/ui/button';
import { MessageActionBar } from '../../../src/renderer/components/chat/MessageActionBar';
import { AppFrame, mountPage } from '../../ui-page/harness';

const ghost: InstalledGhost = { manifest: manifest as unknown as InstalledGhost['manifest'], enabled: true,
  dir: '/fixture', approval: { state: 'approved', revision: 'fixture' }, uiCapabilityApproved: true };
ghost.approvedHostUi = ghostHostUiApprovalTokens(ghost.manifest);
let receive: ((update: { epoch: string; updates: PluginUiStateChange[] }) => void) | undefined;
let epoch = '', interests: PluginUiInterest[] = [];
const task = 'fixture-task';
function MessageActions() {
  const pluginUi = usePluginUiMessageCandidates(task);
  return <MessageActionBar pluginUi={pluginUi} sessionId={task} clientId="message" copyText="原始消息" align="left" hovered
    onAddToChat={() => {}} onDelete={async () => {}} />;
}
void mountPage({
  host: {
    ghosts: { listSync: () => ({ ghosts: [ghost] }), onChanged: () => () => {} },
    maker: {
      mcpApps: async (_session: string | null, input: { op: string; epoch: string; entries: PluginUiInterest[] }) => {
        if (input.op === 'native-interest') { epoch = input.epoch; interests = input.entries; return { updates: [] }; }
        return {};
      },
      onPluginUiState: (callback: NonNullable<typeof receive>) => { receive = callback; return () => { receive = undefined; }; },
    },
  },
  render: () => <AppFrame><PluginUiProvider>
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-16 font-medium">任务工作台</h1>
        <PluginUiSlot position="session.header" sessionId={task} /><PluginUiMenu sessionId={task} /></div>
      <div className="rounded-xl border border-[var(--border)] p-4">
        <PluginUiBody position="message.body" sessionId={task} role="assistant" context={() => ({ message: { content: '原始消息' } })}>
          <p className="text-14 text-[var(--text-primary)]">原始消息内容始终保留，选择插件页面后才切换展示。</p>
        </PluginUiBody>
        <div className="mt-3"><MessageActions /></div>
        <div className="mt-3"><PluginUiSlot position="turn.footer" sessionId={task} clientId="message" /></div>
      </div>
      <div className="rounded-xl border border-[var(--border)] p-4">
        <PluginUiBody position="tool.body" sessionId={task} tool="refresh"><p className="text-14">原始工具结果</p></PluginUiBody>
      </div>
      <div className="flex flex-wrap items-center gap-2"><PluginUiSlot position="composer.toolbar" sessionId={task} /></div>
      <div className="flex flex-wrap items-center justify-between gap-2"><PluginUiSlot position="statusbar" sessionId={task} />
        <Button variant="secondary" size="sm" onClick={() => receive?.({ epoch,
          updates: interests.filter(interest => interest.id === 'progress').map(interest => ({ key: pluginUiInterestKey(interest), revision: 1, state: { title: '最近同步已完成' } })) })}>
          同步示例状态
        </Button>
      </div>
    </div>
  </PluginUiProvider></AppFrame>,
});
