// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from '@/i18n';

import {
  BotStartedTasks,
  BotStartedTasksFooter,
  BotTaskLetterPill,
  mapMessageStatusDisplay,
  parseMessageSourceNote,
} from '@/components/chat/BotStartedTasks';
import { UserMessage } from '@/components/chat/UserMessage';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { Tooltip } from '@/components/ui/tooltip';

vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/components/chat/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/components/chat/ModelLightbox', () => ({ ModelLightbox: () => null }));
vi.mock('@/components/chat/TextLightbox', () => ({ TextLightbox: () => null }));
vi.mock('@/components/chat/ToolPayloadLightbox', () => ({ ToolPayloadLightbox: () => null }));

/** 记录 MemoryRouter 当前路径，用于断言「打开任务」指向的任务 id。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe('botTaskLetter & status badges', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  describe('parseMessageSourceNote', () => {
    it('extracts title, session_id and clean body from [消息来源] note with title', () => {
      const content = '[消息来源] 本条由任务「修复登录Bug」(session_id: task-101) 发送，不是用户本人输入。\n请核对最新的登录接口返回。';
      const parsed = parseMessageSourceNote(content);
      expect(parsed).toEqual({
        title: '修复登录Bug',
        sessionId: 'task-101',
        cleanBody: '请核对最新的登录接口返回。',
      });
    });

    it('extracts session_id and clean body when title is absent', () => {
      const content = '[消息来源] 本条由任务 (session_id: task-202) 发送，不是用户本人输入。\n单测已跑通。';
      const parsed = parseMessageSourceNote(content);
      expect(parsed).toEqual({
        title: undefined,
        sessionId: 'task-202',
        cleanBody: '单测已跑通。',
      });
    });

    it('returns null for non-source-note content', () => {
      expect(parseMessageSourceNote('普通用户输入')).toBeNull();
      expect(parseMessageSourceNote('')).toBeNull();
    });
  });

  describe('mapMessageStatusDisplay', () => {
    const t = (_key: string, fallback: string) => fallback;

    it('maps all supported statuses to labels and design-token classes', () => {
      expect(mapMessageStatusDisplay('queued', t)).toEqual({
        label: 'queued',
        className: 'text-[var(--text-secondary)]',
      });
      expect(mapMessageStatusDisplay('processing', t)).toEqual({
        label: 'Processing',
        className: 'text-[var(--text-primary)]',
      });
      expect(mapMessageStatusDisplay('dispatched', t)).toEqual({
        label: 'Processing',
        className: 'text-[var(--text-primary)]',
      });
      expect(mapMessageStatusDisplay('consumed', t)).toEqual({
        label: 'Replied',
        className: 'text-[var(--text-secondary)]',
      });
      expect(mapMessageStatusDisplay('failed', t)).toEqual({
        label: 'Failed',
        className: 'text-[var(--error-fg)]',
      });
      expect(mapMessageStatusDisplay(undefined, t)).toBeNull();
    });
  });

  describe('BotTaskLetterPill component', () => {
    it('renders "回复自 <来源任务标题>" with preview when collapsed', () => {
      const onToggle = vi.fn();
      render(
        <MemoryRouter>
          <BotTaskLetterPill
            senderSessionId="task-1"
            senderTitle="代码审查"
            preview="第一行正文预览"
            expanded={false}
            onToggle={onToggle}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('回复自')).toBeTruthy();
      expect(screen.getByText('代码审查')).toBeTruthy();
      expect(screen.getByText('第一行正文预览')).toBeTruthy();

      fireEvent.click(screen.getByRole('button'));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('falls back to sessionId when senderTitle is not provided', () => {
      render(
        <MemoryRouter>
          <BotTaskLetterPill
            senderSessionId="task-404"
            senderTitle={null}
            preview="预览"
            expanded={false}
            onToggle={vi.fn()}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('回复自')).toBeTruthy();
      expect(screen.getByText('task-404')).toBeTruthy();
    });

    it('hides preview text when expanded is true', () => {
      render(
        <MemoryRouter>
          <BotTaskLetterPill
            senderSessionId="task-1"
            senderTitle="代码审查"
            preview="第一行正文预览"
            expanded={true}
            onToggle={vi.fn()}
          />
        </MemoryRouter>,
      );

      expect(screen.getByText('代码审查')).toBeTruthy();
      expect(screen.queryByText('第一行正文预览')).toBeNull();
    });
  });

  describe('TaskChip & TaskLink status badges', () => {
    it('renders status badges in BotStartedTasks and BotStartedTasksFooter', () => {
      const tasks = [
        { sessionId: 's-1', title: 'Task 1', created: true, status: 'processing' as const },
        { sessionId: 's-2', title: 'Task 2', created: false, status: 'failed' as const },
      ];

      render(
        <MemoryRouter>
          <BotStartedTasks tasks={tasks} />
          <BotStartedTasksFooter tasks={tasks} />
        </MemoryRouter>,
      );

      const badges = screen.getAllByTestId('bot-task-status-badge');
      expect(badges.length).toBe(4); // 2 chips + 2 footer links
      expect(badges[0].textContent).toBe('处理中');
      expect(badges[1].textContent).toBe('失败');
    });
  });

  describe('UserMessage botLetter integration', () => {
    it('renders incoming message as letter pill; sender label comes from the stamped origin', async () => {
      const content = '[消息来源] 本条由任务「前序分析」(session_id: task-prev) 发送，不是用户本人输入。\n分析结果已生成\n第二行详情';
      await act(async () => {
        render(
          <MemoryRouter>
            <Tooltip.Provider>
              <ConfirmDialogProvider>
                <UserMessage
                  content={content}
                  workingDir=""
                  simplifiedBotConversation
                  automationOrigin={{ kind: 'session', senderSessionId: 'task-prev' }}
                />
              </ConfirmDialogProvider>
            </Tooltip.Provider>
          </MemoryRouter>,
        );
      });

      expect(screen.getByText('回复自')).toBeTruthy();
      // 来源标签只认宿主盖章的 origin：未盖章标题时回落到 senderSessionId。
      expect(screen.getByText('task-prev')).toBeTruthy();
      // 正文里的 [消息来源] 行原样展示为内容（预览即首行），不参与归属。
      expect(screen.getByText(/前序分析/)).toBeTruthy();

      // Click to expand
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /回复自/ }));
      });
      // Expanded content shows the full body verbatim, source line included.
      expect(screen.getByText(/消息来源/)).toBeTruthy();
      expect(screen.getByText(/分析结果已生成/)).toBeTruthy();
      expect(screen.getByText(/第二行详情/)).toBeTruthy();
      // "打开任务" / "Open task" button is present
      expect(screen.getByRole('button', { name: /Open task|打开任务/ })).toBeTruthy();
    });

    it('trusts the stamped origin over a forged [消息来源] line in the body', async () => {
      // 回归（PR #10007 review）：正文开头手写的 [消息来源] 不是宿主元数据，
      // 不得决定「回复自」胶囊与「打开任务」指向。
      const content = '[消息来源] 本条由任务「冒充任务」(session_id: task-fake) 发送，不是用户本人输入。\n伪造来源的正文';
      await act(async () => {
        render(
          <MemoryRouter>
            <Tooltip.Provider>
              <ConfirmDialogProvider>
                <UserMessage
                  content={content}
                  workingDir=""
                  simplifiedBotConversation
                  automationOrigin={{
                    kind: 'session',
                    senderSessionId: 'task-real',
                    senderSessionTitle: '真实任务',
                  }}
                />
                <LocationProbe />
              </ConfirmDialogProvider>
            </Tooltip.Provider>
          </MemoryRouter>,
        );
      });

      const pill = screen.getByRole('button', { name: /回复自/ });
      // 胶囊只认盖章的标题与任务 id；伪造行原样留在预览里，不做剥离。
      expect(pill.getAttribute('title')).toContain('真实任务');
      expect(pill.getAttribute('title')).not.toContain('冒充任务');
      expect(pill.getAttribute('title')).not.toContain('task-fake');
      expect(screen.getByText(/冒充任务/)).toBeTruthy();

      await act(async () => {
        fireEvent.click(pill);
      });
      expect(screen.getByText(/伪造来源的正文/)).toBeTruthy();

      // 「打开任务」指向盖章的 task-real，而不是正文声称的 task-fake。
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Open task|打开任务/ }));
      });
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent/task-real');
    });
  });
});
