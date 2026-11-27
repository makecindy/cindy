import { useState } from 'react';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { ctx, mountPage } from '../../ui-page/harness';
import { AutomationSessionGroupItem } from '../../../src/renderer/features/cc-agent/sidebar/AutomationSessionGroupItem';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import { Button } from '../../../src/renderer/components/ui/button';
const noop = () => {};
// Relative to now so the 24h recent-run exemption never expires and the scenario stays stable.
const now = Date.now();
const sessions = Array.from(
  { length: 8 },
  (_, i) =>
    ({
      id: `run-${i}`,
      title: i === 0 ? '组头代表的最新未读' : i === 7 ? '已读结果' : `巡检结果 ${i}`,
      status: 'active',
      source: 'scheduler',
      createdAt: new Date(now - i * 60_000).toISOString(),
      updatedAt: new Date(now - i * 60_000).toISOString(),
      agentKind: 'codex',
      pinnedAt: null,
      sdkSessionId: null,
      remoteHostId: null,
      deviceLinkDeviceId: null,
      workspaceKind: 'project',
      workingDir: '/example',
      _count: { messages: 5 },
    }) as Session,
);
function Specimen() {
  const isDemo = ctx.case === 'demo';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = sessions.find((session) => session.id === selectedId);
  const [collapsed, setCollapsed] = useState(true);
  const [unread, setUnread] = useState(new Set(sessions.slice(0, 7).map((s) => s.id)));
  return (
    <div
      className={
        isDemo ? 'flex min-h-screen flex-col bg-content-area text-foreground sm:flex-row' : ''
      }
    >
      <div className="bg-sidebar text-foreground p-3 shrink-0" style={{ width: 300 }}>
        {isDemo && <div className="mb-4 text-sm font-medium">自动任务预览</div>}
        <AutomationSessionGroupItem
          group={{
            id: 'schedule:example',
            title: '每日巡检',
            sessions,
            attentionSessionIds: [...unread],
          }}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          runningSessionIds={new Set()}
          attachedSessionIds={new Set()}
          notifications={unread}
          activeSessionId={selectedId ?? undefined}
          onSessionClick={(id) => {
            setSelectedId(id);
            setUnread((prev) => new Set([...prev].filter((x) => x !== id)));
          }}
          onAction={noop}
          onRename={noop}
          onTogglePin={noop}
          onScheduleAction={noop}
        />
      </div>
      {isDemo && (
        <main className="min-w-0 flex-1 p-6">
          <div className="mb-6 flex flex-wrap items-center gap-3" data-ui-page-control>
            <Button
              variant="outline"
              onClick={() => {
                setUnread(new Set(sessions.slice(0, 7).map((s) => s.id)));
                setSelectedId(null);
                setCollapsed(true);
              }}
            >
              重置演示
            </Button>
            <Button variant="outline" onClick={() => setUnread(new Set())}>
              全部标为已读
            </Button>
          </div>
          <h1 className="mb-3 text-lg font-medium">
            {selected ? selected.title : '点左侧任务，体验新的列表规则'}
          </h1>
          {selected ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">已打开：{selected.id} · 演示内容</p>
              <p className="text-sm">
                这条任务已标为已读。组折叠时，它会从未读子列表收回；展开后仍能在历史中找到。组头代表的最新任务在展开时也有独立子行，折叠时只保留组头。
              </p>
            </>
          ) : (
            <div className="space-y-3 text-sm">
              <p>「每日巡检」这一行代表最新一次运行，下面六条是其他未读任务，不会重复。</p>
              <p>点击标题旁的箭头展开，会列出全部运行，包括组头代表的最新任务和已读历史；再收起，只露出其他未读任务。</p>
              <p>点开任意一条后，它的未读状态会消失。用「重置演示」可以重新体验。</p>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
void mountPage({
  route: '/cc-agent',
  host: { localDb: { sessions: { get: async (id: string) => sessions.find((s) => s.id === id) } } },
  render: () => (
    <WorktreeProvider>
      <Specimen />
    </WorktreeProvider>
  ),
});
