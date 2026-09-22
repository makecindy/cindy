import { describe, it, expect, vi } from 'vitest';
import { posix, win32 } from 'node:path';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

import {
  canHighlightSessionDisplayTitle,
  getSessionDisplayTitle,
  isEmptyDraftSession,
  toStoredSessionTitle,
} from '../sessionDisplayTitle';

const UNNAMED = '未命名任务';
const MAKE_RUN = 'f428ca8b-242b-43c6-b2e5-e54bdd915f62';
const MAKE_CREATED_AT = new Date(2026, 8, 20, 14, 7).toISOString();

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: DEFAULT_DRAFT_SESSION_TITLE,
    agentKind: 'cc',
    status: 'active',
    workingDir: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    ...over,
  } as Session;
}

describe('getSessionDisplayTitle', () => {
  it.each([
    win32.join('C:/managed', 'merge-worktrees', MAKE_RUN),
    posix.join('/managed', 'merge-worktrees', MAKE_RUN),
  ])('recovers persisted conflict title keys without rewriting data for %s', (workingDir) => {
    for (const [key, label] of [
      ['cindyMake.merge.taskTitle', '处理源码更新冲突'],
      ['cindyMake.history.mergeTaskTitle', '处理合入冲突'],
      ['cindyMake.history.revertTaskTitle', '处理撤销合入冲突'],
    ]) {
      for (const title of [key, `[f428] ${key}`, `[Cindy-Make] ${key}`]) {
        const s = session({
          source: 'cindy-make-merge',
          title,
          workingDir,
          createdAt: MAKE_CREATED_AT,
        });
        const translate = vi.fn(() => label);
        expect(getSessionDisplayTitle(s, UNNAMED, translate)).toBe(`[f428] 09-20 14:07 ${label}`);
        expect(translate).toHaveBeenCalledWith(key);
        expect(canHighlightSessionDisplayTitle(s)).toBe(false);
        expect(s.title).toBe(title);
      }
    }
  });

  it('uses the current language for old keys and preserves renamed or ordinary titles', () => {
    const key = 'cindyMake.merge.taskTitle';
    const s = session({ source: 'cindy-make-merge', title: key, createdAt: MAKE_CREATED_AT });
    expect(getSessionDisplayTitle(s, UNNAMED, () => '处理源码更新冲突')).toBe(
      '09-20 14:07 处理源码更新冲突',
    );
    expect(getSessionDisplayTitle(s, UNNAMED, () => 'Resolve Source Update Conflicts')).toBe(
      '09-20 14:07 Resolve Source Update Conflicts',
    );
    const translate = vi.fn(() => 'unexpected');
    for (const custom of [
      session({ title: key }),
      session({ source: 'cindy-make', title: key }),
      session({ source: 'cindy-make-merge', title: 'My merge notes' }),
      session({ source: 'cindy-make-merge', title: `Investigate ${key}` }),
    ]) {
      translate.mockClear();
      expect(getSessionDisplayTitle(custom, UNNAMED, translate)).toBe(custom.title);
      expect(canHighlightSessionDisplayTitle(custom, translate)).toBe(true);
      if (custom.source === 'cindy-make-merge') {
        expect(translate).not.toHaveBeenCalledWith(custom.title);
      } else {
        expect(translate).not.toHaveBeenCalled();
      }
    }
  });

  it('keeps an existing title timestamp stable when displayed again or after the task changes', () => {
    const title = '[f428] 09-19 09:00 处理合入冲突';
    const s = session({
      source: 'cindy-make-merge',
      title,
      workingDir: '/managed/merge-worktrees/' + MAKE_RUN,
      createdAt: MAKE_CREATED_AT,
      updatedAt: new Date(2026, 8, 21, 16, 30).toISOString(),
    });
    const translate = (key: string) => key;
    expect(getSessionDisplayTitle(s, UNNAMED, translate)).toBe(title);
    expect(canHighlightSessionDisplayTitle(s, translate)).toBe(true);
  });

  it('does not invent a time for a retained task whose creation date is unavailable', () => {
    const s = session({
      source: 'cindy-make-merge',
      title: 'cindyMake.merge.taskTitle',
      createdAt: '',
    });
    expect(getSessionDisplayTitle(s, UNNAMED, () => '处理源码更新冲突')).toBe('处理源码更新冲突');
  });

  it.each([
    win32.join('C:/managed', 'worktrees', MAKE_RUN),
    posix.join('/managed', 'worktrees', MAKE_RUN),
  ])('uses the worktree name rather than the session id for %s', (workingDir) => {
    const s = session({
      id: 'other-session',
      source: 'cindy-make',
      workingDir,
      title: '[Cindy-Make] 修改背景色',
    });
    expect(getSessionDisplayTitle(s, UNNAMED)).toBe('[f428] 修改背景色');
    expect(s.title).toBe('[Cindy-Make] 修改背景色');
  });

  it.each(['[Cindy Make] 修改背景色', '[f428] 修改背景色', '修改背景色'])(
    'keeps one short tag when displaying %s',
    (title) => {
      const s = session({
        source: 'cindy-make',
        title,
        workingDir: '/managed/worktrees/' + MAKE_RUN,
      });
      expect(getSessionDisplayTitle(s, UNNAMED)).toBe('[f428] 修改背景色');
    },
  );

  it('does not guess a worktree tag when only the session id is known', () => {
    const s = session({
      id: 'abcd-session',
      source: 'cindy-make',
      title: '[Cindy-Make] 修改背景色',
    });
    expect(getSessionDisplayTitle(s, UNNAMED)).toBe('修改背景色');
  });

  it('leaves similar prefixes in ordinary task titles untouched', () => {
    const s = session({
      title: '[Cindy-Make] notes',
      workingDir: '/managed/worktrees/' + MAKE_RUN,
    });
    expect(getSessionDisplayTitle(s, UNNAMED)).toBe('[Cindy-Make] notes');
  });

  it('哨兵标题换成本地化兜底文案', () => {
    expect(getSessionDisplayTitle(session(), UNNAMED)).toBe(UNNAMED);
  });

  it('已起名的会话原样返回', () => {
    expect(getSessionDisplayTitle(session({ title: '帮我排查登录失败' }), UNNAMED)).toBe(
      '帮我排查登录失败',
    );
  });

  it('哨兵 + 已有消息也兜底 —— 判定口径比 isEmptyDraftSession 宽', () => {
    // 自动起名失败(离线 / 模型不可用)时会话有消息但标题仍停在哨兵上,
    // 那种情况同样不能把英文哨兵漏给用户看。
    //
    // 已知代价(明确取舍,见 getSessionDisplayTitle 的文档):用户手动把标题改成
    // 字面量 "New Maker" 时也会显示成兜底文案 —— 要区分得给标题带 provenance,
    // 而 main 的 manuallyRenamed 是进程内存态、不落库、不过 device-link。
    // 这条断言就是那个取舍本身,改它之前先读那段文档(PR #1031 review 第 11 轮)。
    const s = session({ _count: { messages: 3 } } as Partial<Session>);
    expect(isEmptyDraftSession(s)).toBe(false);
    expect(getSessionDisplayTitle(s, UNNAMED)).toBe(UNNAMED);
  });

  it('automation 会话仍然剥掉 [Schedule] 前缀', () => {
    expect(getSessionDisplayTitle(session({ title: '[Schedule] nightly-build' }), UNNAMED)).toBe(
      'nightly-build',
    );
  });
});

describe('isEmptyDraftSession', () => {
  it('哨兵 + 零消息 = 空草稿', () => {
    expect(isEmptyDraftSession(session())).toBe(true);
    expect(isEmptyDraftSession(session({ _count: { messages: 0 } } as Partial<Session>))).toBe(
      true,
    );
  });

  it('有消息或已起名都不算空草稿', () => {
    expect(isEmptyDraftSession(session({ _count: { messages: 1 } } as Partial<Session>))).toBe(
      false,
    );
    expect(isEmptyDraftSession(session({ title: '已起名' }))).toBe(false);
  });
});

describe('toStoredSessionTitle — 显示投影必须还原成存储值', () => {
  it.each(['新名字', '[f428] 新名字', '[Cindy-Make] 新名字'])(
    'preserves one worktree tag after renaming to %s',
    (editedTitle) => {
      const s = session({
        source: 'cindy-make',
        title: '[Cindy-Make] old',
        workingDir: '/managed/worktrees/' + MAKE_RUN,
      });
      const stored = toStoredSessionTitle(s, editedTitle);
      expect(stored).toBe('[f428] 新名字');
      expect(getSessionDisplayTitle({ ...s, title: stored }, UNNAMED)).toBe(stored);
    },
  );

  it('legacy automation 会话补回 [Schedule] 前缀', () => {
    // 预填给用户的是剥掉前缀的 'nightly'。若原样落库,isAutomationGeneratedSession
    // (legacy 数据只靠前缀识别)再也认不出它,会话从 automation 分组消失。
    const s = session({ title: '[Schedule] nightly' });
    expect(getSessionDisplayTitle(s, UNNAMED)).toBe('nightly');
    expect(toStoredSessionTitle(s, '每晚构建')).toBe('[Schedule] 每晚构建');
  });

  it('用户自己把前缀打回来时不重复叠加', () => {
    expect(toStoredSessionTitle(session({ title: '[Schedule] nightly' }), '[Schedule] x')).toBe(
      '[Schedule] x',
    );
  });

  it('普通会话原样返回', () => {
    expect(toStoredSessionTitle(session({ title: '帮我排查登录失败' }), '新名字')).toBe('新名字');
  });

  it('新数据(source=scheduler,无前缀)不被塞前缀', () => {
    // 新数据靠 source 字段识别,标题里不该出现内部前缀。
    const s = session({ title: 'nightly', source: 'scheduler' } as Partial<Session>);
    expect(toStoredSessionTitle(s, '每晚构建')).toBe('每晚构建');
  });

  it('哨兵会话原样返回 —— 兜底文案由调用方的「没改」判据挡住', () => {
    expect(toStoredSessionTitle(session(), '真的改名了')).toBe('真的改名了');
  });
});

describe('canHighlightSessionDisplayTitle', () => {
  it('avoids stale search offsets for legacy Make titles and retains them for new titles', () => {
    const s = session({
      source: 'cindy-make',
      title: '[Cindy-Make] old',
      workingDir: '/managed/worktrees/' + MAKE_RUN,
    });
    expect(canHighlightSessionDisplayTitle(s)).toBe(false);
    expect(canHighlightSessionDisplayTitle({ ...s, title: '[f428] old' })).toBe(true);
  });

  it('显示串等于原始 title 时才允许高亮', () => {
    expect(canHighlightSessionDisplayTitle(session({ title: '帮我排查登录失败' }))).toBe(true);
  });

  it('哨兵标题关掉高亮 —— matchIndices 是按原始 title 算的,会错位', () => {
    expect(canHighlightSessionDisplayTitle(session())).toBe(false);
  });

  it('[Schedule] 前缀被剥离时同样关掉高亮(既有 case)', () => {
    expect(canHighlightSessionDisplayTitle(session({ title: '[Schedule] nightly' }))).toBe(false);
  });
});
