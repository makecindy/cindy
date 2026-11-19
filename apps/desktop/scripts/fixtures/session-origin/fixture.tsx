import './host';
import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { SessionEntryList } from '../../../src/renderer/features/cc-agent/sidebar/SessionEntryList';
import { SessionContentHeaderRegistration } from '../../../src/renderer/features/cc-agent/SessionContentHeader';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

// #11610: tasks another task opened with send_to_session carry sessions.origin_session.
// SessionItem rows, the header and translations are production code; the session list hook is stubbed.
setDataOwnerGeneration('fixture', 1);
const noop = () => {};
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 19, 9, 0) - minutes * 60_000).toISOString();
const task = (id: string, title: string, minutes: number, extra: Partial<Session> = {}) => ({
  id, title, status: 'active', source: 'desktop', createdAt: at(minutes), updatedAt: at(minutes),
  lastActivityAt: at(minutes), agentKind: 'codex', pinnedAt: null, sdkSessionId: null, remoteHostId: null,
  deviceLinkDeviceId: null, workspaceKind: 'project', workingDir: '/Projects/Cindy', _count: { messages: 6 },
  ...extra,
} as Session);

const sessions = [
  task('child-1', '整理访谈录音转写', 3, { originSession: { sessionId: 'lead', title: '准备 Q4 用户调研报告' } }),
  task('child-2', '汇总竞品定价表', 8, { originSession: { sessionId: 'lead', title: '准备 Q4 用户调研报告' } }),
  task('lead', '准备 Q4 用户调研报告', 12),
  task('own', '修复侧栏滚动抖动', 40),
];

mountPage({
  route: '/cc-agent/child-1',
  host: {
    localDb: { sessions: { get: async (id: string) => sessions.find((s) => s.id === id) } },
    onSessionsPatched: subscription('sessionsPatched'),
  },
  render: () => (
    <WorktreeProvider>
      <AppFrame
        sidebar={
          <div className="p-2" data-ui-page-subject>
            <SessionEntryList sessions={sessions} sessionVariant="text" activeSessionId="child-1"
              runningSessionIds={new Set()} attachedSessionIds={new Set()} notifications={new Set()}
              scheduleSessionIndex={new Map()} onSessionClick={noop} onAction={noop} onRename={noop}
              onTogglePin={noop} onScheduleAction={noop} />
          </div>
        }
      >
        <SessionContentHeaderRegistration session={sessions[0]} />
        <div className="min-h-0 flex-1" />
      </AppFrame>
    </WorktreeProvider>
  ),
});
