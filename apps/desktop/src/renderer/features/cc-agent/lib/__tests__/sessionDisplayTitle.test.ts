import { describe, it, expect } from 'vitest';

import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';

import type { Session } from '@/lib/ccAgent.types';

import {
  canHighlightSessionDisplayTitle,
  getSessionDisplayTitle,
  isEmptyDraftSession,
  toStoredSessionTitle,
} from '../sessionDisplayTitle';

const UNNAMED = '未命名任务';

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
    expect(isEmptyDraftSession(session({ _count: { messages: 0 } } as Partial<Session>))).toBe(true);
  });

  it('有消息或已起名都不算空草稿', () => {
    expect(isEmptyDraftSession(session({ _count: { messages: 1 } } as Partial<Session>))).toBe(false);
    expect(isEmptyDraftSession(session({ title: '已起名' }))).toBe(false);
  });
});

describe('toStoredSessionTitle — 显示投影必须还原成存储值', () => {
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
