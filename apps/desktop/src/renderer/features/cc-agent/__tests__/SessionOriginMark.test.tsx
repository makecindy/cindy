// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerLoadedBotProfilesReader } from '@/features/bots/botSessionOwners';
import type { BotProfile } from '@/features/bots/botStore';
import type { Session } from '@/lib/ccAgent.types';

import { SessionOriginChip, SessionOriginLead, SessionOriginMeta, SessionOriginRowMark } from '../SessionOriginMark';

/**
 * 测试价值
 * - 生产入口与可观察结果：侧栏行标记 SessionOriginRowMark 与标题区入口 SessionOriginChip（真实组件、真实
 *   来源路由 useSourceSessionOpener / botConversationRouteForSession），只读任务行上的 originSession。
 * - 规则依据：#11610 维护方验收链与 message-source.md「由另一个任务新建的任务」——从伙伴话题开 A，A 开 B、C，
 *   给用户手建的 D 发消息：从左栏重开不翻历史就能看出 A、B、C 的来源；返回时 A 落到原话题而非伙伴首页，
 *   B、C 落到 A，D 没有派生标记。
 * - 现有覆盖缺口：sessionOrigin.test.ts 只测来源推导，单页验证只看样式，没有覆盖返回落点。
 * - 最小失败输入：话题来源被打开成 /cc-agent/<话题> 或伙伴首页；D 出现标记。
 * - tier：unit（jsdom，进程内）。
 */

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: { name?: string }) => (values?.name ? `${key}:${values.name}` : key) }),
}));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => children }));
// Only the cross-computer branch uses the deep-link opener; same-device sources navigate directly.
vi.mock('@/components/chat/SessionLinkChip', () => ({ useSessionLinkTarget: () => ({ openTarget: vi.fn() }) }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  useRemoteSessionTitle: () => null,
  remoteProjectsStore: { pinSessionOrigin: vi.fn(), getSessionDeviceId: () => undefined },
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: () => undefined }));

const topic = { id: 'topic-q4', role: 'thread', threadRoot: { rootSessionId: 'cindy-chat', rootClientId: 'root-msg' } };
const profiles = [{
  id: 'cindy', name: 'Cindy',
  sessions: [{ id: 'cindy-chat', role: 'canonical' }, topic, { id: 'topic-other', role: 'thread',
    threadRoot: { rootSessionId: 'cindy-chat', rootClientId: 'other-msg' } }],
}] as unknown as BotProfile[];

const task = (id: string, originSession?: Session['originSession']) => ({ id, title: id, originSession } as Session);
// The chain: a teammate topic opened A; A opened B and C; D was opened by the user and only received a message.
const A = task('task-a', { sessionId: topic.id, title: 'Q4 复盘' });
const B = task('task-b', { sessionId: 'task-a', title: 'task-a' });
const C = task('task-c', { sessionId: 'task-a', title: 'task-a' });
const D = task('task-d');

beforeEach(() => { navigate.mockReset(); registerLoadedBotProfilesReader(() => profiles); });
afterEach(() => registerLoadedBotProfilesReader(null));

describe('tasks started by another task (#11610 acceptance chain)', () => {
  // Each row style (single-line mark, list second line, pinned card bottom row) keeps the full
  // 「由「X」发起」 as its accessible name and hover text; only the visible name is shortened.
  const presentations = [SessionOriginRowMark, SessionOriginLead, SessionOriginMeta] as const;

  it('marks A, B and C from their own row without reading history, and leaves D unmarked', () => {
    for (const [session, origin] of [[A, 'Q4 复盘'], [B, 'task-a'], [C, 'task-a']] as const) {
      for (const Presentation of presentations) {
        const { unmount } = render(<Presentation session={session} activeForeground={false} />);
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`ccAgent.sessionOrigin.startedByNamed:${origin}`);
        unmount();
      }
    }
    const { container } = render(<>{presentations.map((Presentation) =>
      <Presentation key={Presentation.name} session={D} activeForeground={false} />)}<SessionOriginChip session={D} /></>);
    expect(container.innerHTML).toBe('');
  });

  it('shows a short source name in the list and card rows while the label stays complete', () => {
    const long = task('task-long', { sessionId: 'task-a', title: '为下季度产品规划准备完整的用户调研与竞品分析报告' });
    for (const Presentation of [SessionOriginLead, SessionOriginMeta]) {
      const { unmount } = render(<Presentation session={long} activeForeground={false} />);
      const node = screen.getByRole('img');
      expect(node.textContent).toContain('为下季度产品规…');
      expect(node.getAttribute('aria-label')).toContain('竞品分析报告');
      unmount();
    }
  });

  it('returns A to its exact teammate topic, and B and C to A', () => {
    const open = (session: Session) => {
      const { unmount } = render(<MemoryRouter><SessionOriginChip session={session} /></MemoryRouter>);
      fireEvent.click(screen.getByRole('button'));
      unmount();
      return navigate.mock.calls.at(-1)?.[0];
    };
    expect(open(A)).toBe('/bots/cindy/session/cindy-chat?thread=topic-q4');
    expect(open(B)).toBe('/cc-agent/task-a');
    expect(open(C)).toBe('/cc-agent/task-a');
    // The teammate's main chat opens as that chat, not as a bare lane page.
    expect(open(task('task-e', { sessionId: 'cindy-chat' }))).toBe('/bots/cindy/session/cindy-chat');
  });
});
