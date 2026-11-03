import { mountPage, subscription } from '../../ui-page/harness';
import { PluginSidebarWidgets } from '../../../src/renderer/features/cc-agent/sidebar/PluginSidebarWidgets';
import type { GhostSidebarWidgetGroup } from '../../../src/shared/ghost';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

const now = new Date().toISOString();
const session = (id: string, title: string): Session =>
  ({ id, title, status: 'active', source: 'desktop', agentKind: 'cc', createdAt: now, updatedAt: now }) as Session;
const sessions = [
  session('running-a', '重构登录页布局'),
  session('done-a', '整理本周发布说明'),
  session('done-b', '修复暗色主题下文字看不清'),
  session('awaiting-a', '发布流程：确认版本号'),
  session('error-a', '竞品价格监控'),
];
const group = (key: GhostSidebarWidgetGroup['tone'], label: string, taskIds: string[]): GhostSidebarWidgetGroup =>
  ({ key, label, tone: key, taskIds });
const running = group('running', '运行中', ['running-a']);
const done = group('done', '刚完成', ['done-a', 'done-b']);
const awaiting = group('awaiting', '待确认', ['awaiting-a']);
const VARIANTS: Record<string, GhostSidebarWidgetGroup[]> = {
  default: [running, done, awaiting],
  four: [running, done, awaiting, group('error', '出错', ['error-a'])],
  unknown: [group('done', '刚完成', ['done-a', 'gone']), group('error', '出错', ['gone'])],
  empty: [group('running', '运行中', ['gone'])],
};
const noop = () => {};
const empty = new Set<string>();

mountPage({
  route: '/cc-agent',
  host: (ctx) => ({
    ghosts: {
      sidebarWidgets: async () => ({
        entries: [{ ghostId: '_root__project-board', groups: VARIANTS[(ctx.data as { variant: string }).variant] }],
      }),
      onSidebarWidget: subscription('sidebarWidget'),
    },
  }),
  render: () => (
    <div className="w-[260px] py-2 text-foreground">
      <PluginSidebarWidgets
        sessions={sessions}
        allKnownProjects={[]}
        runningSessionIds={new Set(['running-a'])}
        attachedSessionIds={empty}
        notifications={empty}
        onSessionClick={noop}
        onAction={noop}
        onRename={noop}
        onTogglePin={noop}
        onScheduleAction={noop}
      />
    </div>
  ),
});
