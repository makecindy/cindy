/**
 * 侧栏「进行中」段成员 + 置顶提示计分。
 * ---------------------------------------------------------------------------
 * 入口与结果:selectInProgressSessions(CCAgentSidebarUpper 据此把任务移出项目、
 *   放进「进行中」段);recordSessionOpen / pickPinSuggestion / parseSessionOpenHistory
 *   (usePinSuggestion 据此决定提示哪一个任务、写回什么)。
 * 规则依据:进行中 = 优先级前三档,看的过程中钉住档位、离开后才回原项目;段内按创建
 *   时间排,状态切换不跳行。置顶提示 30 分钟内重复打开只算一次、7 天外不计、点过
 *   「不再提示」和已置顶的不提示;本机存的坏数据不能让侧栏报错。
 * 覆盖缺口:两者都是新模块,此前无测试。
 * 最小失败输入:运行中 → 等你处理的任务若改按档位排序会换位;同一任务 30 分钟内
 *   打开 5 次若不去重会被提示。
 * tier:unit(纯函数,无 DOM)。单文件本机实测约 1s。
 */

import { describe, expect, it } from 'vitest';

import { LIVE_TASK_PRIORITY } from '../../shared/liveTaskPriority';
import type { Session } from '@/lib/ccAgent.types';
import { selectInProgressSessions } from '../features/cc-agent/lib/inProgressSessions';
import {
  EMPTY_SESSION_OPEN_HISTORY,
  MIN_PIN_SUGGESTION_SCORE,
  PIN_SUGGESTION_WINDOW_MS,
  REOPEN_DEDUP_MS,
  dismissPinSuggestion,
  parseSessionOpenHistory,
  pickPinSuggestion,
  recordSessionOpen,
  type SessionOpenHistory,
} from '../features/cc-agent/lib/pinSuggestion';

function session(id: string, createdAt: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    workingDir: null,
    workspaceKind: 'dialogue',
    pinnedAt: null,
    status: 'active',
    agentKind: 'cc',
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as Session;
}

const ctx = (over: { running?: string[]; attention?: string[]; waiting?: string[] }) => ({
  runningSessionIds: new Set(over.running ?? []),
  attentionSessionIds: new Set(over.attention ?? []),
  waitingSessionIds: new Set(over.waiting ?? []),
});

describe('selectInProgressSessions', () => {
  const older = session('older', '2026-10-01T00:00:00Z');
  const newer = session('newer', '2026-10-02T00:00:00Z');
  const unread = session('unread', '2026-09-30T00:00:00Z');
  const idle = session('idle', '2026-10-03T00:00:00Z');
  const pinned = session('pinned', '2026-10-04T00:00:00Z', { pinnedAt: '2026-10-04T00:00:00Z' });
  const archived = session('archived', '2026-10-05T00:00:00Z', { status: 'archived' });
  const all = [older, newer, unread, idle, pinned, archived];

  it('收等你处理 / 完成未读 / 运行中,不收其余、已置顶与已归档;按创建时间倒序,不按档位', () => {
    const picked = selectInProgressSessions(
      all,
      ctx({
        running: ['newer', 'pinned'],
        attention: ['older', 'unread', 'archived'],
        waiting: ['older'],
      }),
    );
    expect(picked.map((s) => s.id)).toEqual(['newer', 'older', 'unread']);

    // 状态互换(运行中 ↔ 等你处理)后顺序不变。
    const swapped = selectInProgressSessions(
      all,
      ctx({ running: ['older'], attention: ['newer', 'unread'], waiting: ['newer'] }),
    );
    expect(swapped.map((s) => s.id)).toEqual(['newer', 'older', 'unread']);
  });

  it('正在看的任务清掉未读后仍按打开时的档位留在段里', () => {
    const viewing = {
      ...ctx({}),
      heldPriorityRanks: new Map([['unread', LIVE_TASK_PRIORITY.unread]]),
    };
    expect(selectInProgressSessions(all, viewing).map((s) => s.id)).toEqual(['unread']);
  });
});

describe('置顶提示', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const hour = 60 * 60 * 1000;

  function openAt(history: SessionOpenHistory, id: string, times: number[]): SessionOpenHistory {
    return times.reduce((h, t) => recordSessionOpen(h, id, t), history);
  }

  it('30 分钟内反复打开只算一次,分散的多次打开才达标', () => {
    const burst = openAt(EMPTY_SESSION_OPEN_HISTORY, 'a', [0, 1, 2, 3, 4, 5].map((i) => now - i * 60_000));
    expect(burst.opens.a).toHaveLength(1);
    expect(pickPinSuggestion(burst, [session('a', '2026-10-01T00:00:00Z')], now)).toBeNull();

    const spread = openAt(
      EMPTY_SESSION_OPEN_HISTORY,
      'a',
      [5, 4, 3, 2, 1, 0].map((i) => now - i * (REOPEN_DEDUP_MS + hour)),
    );
    expect(pickPinSuggestion(spread, [session('a', '2026-10-01T00:00:00Z')], now)?.id).toBe('a');
  });

  it('挑得分最高者;已置顶、已归档、点过不再提示的跳过;7 天外的打开不计', () => {
    const times = (n: number, base: number) =>
      Array.from({ length: n }, (_, i) => base - (n - 1 - i) * (REOPEN_DEDUP_MS + hour));
    let history = EMPTY_SESSION_OPEN_HISTORY;
    history = openAt(history, 'low', times(MIN_PIN_SUGGESTION_SCORE + 1, now));
    history = openAt(history, 'high', times(MIN_PIN_SUGGESTION_SCORE + 4, now));
    history = openAt(history, 'pinned', times(10, now));
    history = openAt(history, 'archived', times(10, now));
    const candidates = [
      session('low', '2026-10-01T00:00:00Z'),
      session('high', '2026-10-01T00:00:00Z'),
      session('pinned', '2026-10-01T00:00:00Z', { pinnedAt: '2026-10-30T00:00:00Z' }),
      session('archived', '2026-10-01T00:00:00Z', { status: 'archived' }),
    ];
    expect(pickPinSuggestion(history, candidates, now)?.id).toBe('high');
    expect(pickPinSuggestion(dismissPinSuggestion(history, 'high'), candidates, now)?.id).toBe('low');
    expect(pickPinSuggestion(history, candidates, now + PIN_SUGGESTION_WINDOW_MS)).toBeNull();

    // 7 天后再打开别的任务时,过期记录被裁掉,存储不会只增不减。
    const later = recordSessionOpen(history, 'other', now + PIN_SUGGESTION_WINDOW_MS + 1);
    expect(Object.keys(later.opens)).toEqual(['other']);
  });

  it('本机存储的坏数据回落为空历史,只保留合法字段', () => {
    expect(parseSessionOpenHistory('{not json')).toEqual(EMPTY_SESSION_OPEN_HISTORY);
    expect(parseSessionOpenHistory('[1,2]')).toEqual(EMPTY_SESSION_OPEN_HISTORY);
    expect(
      parseSessionOpenHistory(
        JSON.stringify({ opens: { a: [3, 'x', 1], b: 'bad' }, dismissed: ['c', 4] }),
      ),
    ).toEqual({ opens: { a: [1, 3] }, dismissed: ['c'] });
  });
});
