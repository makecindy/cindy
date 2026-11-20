import './host';
import { AppFrame, ctx, mountPage, subscription } from '../../ui-page/harness';
import { SessionEntryList } from '../../../src/renderer/features/cc-agent/sidebar/SessionEntryList';
import { SessionCard } from '../../../src/renderer/features/cc-agent/sidebar/SessionCard';
import { SessionContentHeaderRegistration } from '../../../src/renderer/features/cc-agent/SessionContentHeader';
import { WorktreeProvider } from '../../../src/renderer/contexts/WorktreeContext';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';

// #11610: tasks another task opened with send_to_session carry sessions.origin_session.
// Sidebar rows (text / list / pinned card), the header and translations are production code;
// the session list hook is stubbed. Example data only.
setDataOwnerGeneration('fixture', 1);
const noop = () => {};
const style: 'text' | 'list' | 'card' = ctx.case === 'list' || ctx.case === 'card' ? ctx.case : 'text';
const en = ctx.locale.startsWith('en');
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 19, 9, 0) - minutes * 60_000).toISOString();
const task = (id: string, title: string, minutes: number, preview: string, extra: Partial<Session> = {}) => ({
  id, title, status: 'active', source: 'desktop', createdAt: at(minutes), updatedAt: at(minutes),
  lastActivityAt: at(minutes), agentKind: 'codex', sdkSessionId: null, remoteHostId: null,
  deviceLinkDeviceId: null, workspaceKind: 'project', workingDir: '/Projects/Cindy', _count: { messages: 6 },
  pinnedAt: style === 'card' ? at(0) : null, preview, summary: style === 'card' ? preview : null,
  ...extra,
} as Session);

const lead = en ? 'Q4 user research report' : '准备 Q4 用户调研报告';
const longLead = en ? 'Prepare the complete user research and competitor analysis for next quarter'
  : '为下季度产品规划准备完整的用户调研与竞品分析报告';
const sessions = [
  task('child-1', en ? 'Transcribe interviews' : '整理访谈录音转写', 3, en ? '12 clips done' : '已整理 12 段',
    { originSession: { sessionId: 'lead', title: lead } }),
  task('child-2', en ? 'Competitor pricing' : '汇总竞品定价表', 8, en ? 'Reading responses…' : '正在读取回复…',
    { originSession: { sessionId: 'lead', title: lead } }),
  task('child-long', en ? 'Transcribe every interview recording from three channels into one sheet'
    : '把三个渠道的用户访谈录音逐条转写并按主题整理成一张表格', 10,
    en ? 'Grouped 40 quotes into 6 themes' : '已把 40 条原话归成 6 个主题',
    { originSession: { sessionId: 'lead-long', title: longLead } }),
  task('lead', lead, 12, en ? 'Two subtasks running' : '两项子任务进行中'),
  task('own', en ? 'Fix sidebar scroll jitter' : '修复侧栏滚动抖动', 40, en ? 'Fix committed' : '已提交修复'),
];
const rowProps = { activeSessionId: 'child-1', runningSessionIds: new Set(['child-2']),
  attachedSessionIds: new Set<string>(), notifications: new Set<string>() };

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
          <div className="p-2" data-ui-page-subject data-row-style={style}>
            {style === 'card' ? (
              <div className="flex flex-col gap-2">
                {sessions.map((s) => <SessionCard key={s.id} session={s} variant="card"
                  isActive={s.id === rowProps.activeSessionId} isRunning={rowProps.runningSessionIds.has(s.id)}
                  onClick={noop} onAction={noop} onRename={noop} onTogglePin={noop} />)}
              </div>
            ) : (
              <SessionEntryList sessions={sessions} sessionVariant={style} {...rowProps}
                scheduleSessionIndex={new Map()} onSessionClick={noop} onAction={noop} onRename={noop}
                onTogglePin={noop} onScheduleAction={noop} />
            )}
          </div>
        }
      >
        <SessionContentHeaderRegistration session={sessions[0]} />
        <div className="min-h-0 flex-1" />
      </AppFrame>
    </WorktreeProvider>
  ),
});
