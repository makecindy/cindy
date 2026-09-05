/**
 * sidebarSessionTime — SessionItem right-side activity time.
 *
 * Project sessions and standalone dialogues both render through SessionItem, so
 * the timestamp belongs here rather than in ProjectsSection / DialogueSection.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatSidebarFutureTime,
  formatSidebarTime,
} from '@/features/cc-agent/lib/formatSidebarTime';

const sessionItemSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionItem.tsx'),
  'utf8',
);

const sessionInfoMetaSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', 'SessionInfoMeta.tsx'),
  'utf8',
);

function t(key: string, options?: Record<string, unknown>): string {
  const dict: Record<string, string> = {
    'ccAgent.time.relative.now': '刚刚',
    'ccAgent.time.relative.minute': '{{count}} 分钟',
    'ccAgent.time.relative.hour': '{{count}} 小时',
    'ccAgent.time.relative.day': '{{count}} 天',
    'ccAgent.time.relative.week': '{{count}} 周',
    'ccAgent.time.relative.month': '{{count}} 月',
    'ccAgent.time.relative.year': '{{count}} 年',
    'ccAgent.time.future.second': '还有 {{count}} 秒',
    'ccAgent.time.future.minute': '还有 {{count}} 分钟',
    'ccAgent.time.future.hour': '还有 {{count}} 小时',
    'ccAgent.time.future.day': '还有 {{count}} 天',
    'ccAgent.time.future.week': '还有 {{count}} 周',
    'ccAgent.time.future.month': '还有 {{count}} 月',
    'ccAgent.time.future.year': '还有 {{count}} 年',
  };
  return (dict[key] ?? key).replace('{{count}}', String(options?.count ?? ''));
}

describe('formatSidebarTime', () => {
  const now = new Date('2026-05-20T12:00:00.000Z');

  it('formats compact relative activity time', () => {
    expect(formatSidebarTime('2026-05-20T11:59:30.000Z', t, now)).toBe('刚刚');
    expect(formatSidebarTime('2026-05-20T11:15:00.000Z', t, now)).toBe('45 分钟');
    expect(formatSidebarTime('2026-05-19T14:00:00.000Z', t, now)).toBe('22 小时');
    expect(formatSidebarTime('2026-05-18T12:00:00.000Z', t, now)).toBe('2 天');
    expect(formatSidebarTime('2026-05-13T12:00:00.000Z', t, now)).toBe('1 周');
  });
});

describe('formatSidebarFutureTime', () => {
  const now = new Date('2026-05-20T12:00:00.000Z');

  it('formats compact time until the next automation run', () => {
    expect(formatSidebarFutureTime(Date.parse('2026-05-20T12:00:30.000Z'), t, now)).toBe(
      '还有 30 秒',
    );
    expect(formatSidebarFutureTime(Date.parse('2026-05-20T12:45:00.000Z'), t, now)).toBe(
      '还有 45 分钟',
    );
    expect(formatSidebarFutureTime(Date.parse('2026-05-21T10:00:00.000Z'), t, now)).toBe(
      '还有 22 小时',
    );
    expect(formatSidebarFutureTime(Date.parse('2026-05-22T12:00:00.000Z'), t, now)).toBe(
      '还有 2 天',
    );
    expect(formatSidebarFutureTime(Date.parse('2026-05-27T12:00:00.000Z'), t, now)).toBe(
      '还有 1 周',
    );
  });

  it('does not render overdue automation countdowns', () => {
    expect(formatSidebarFutureTime(Date.parse('2026-05-20T11:59:59.000Z'), t, now)).toBe('');
    expect(formatSidebarFutureTime(Date.parse('2026-05-20T12:00:00.000Z'), t, now)).toBe('');
  });
});

describe('SessionItem activity time', () => {
  it('always renders the right-side activity info from the sidebar sort clock', () => {
    expect(sessionItemSource).not.toContain('SHOW_SIDEBAR_TIMESTAMPS');
    // activityIso uses max(userSendAt, updatedAt) to backfill pre-migration rows
    expect(sessionItemSource).toContain('const activityIso =');
    expect(sessionItemSource).toContain('session.updatedAt');
    // C 期起时间渲染并入 SessionInfoMeta(任务信息复选,同一 activityIso 时间轴);
    // 时间文本与 text-sidebar-action-icon 色由该组件承担。
    // 2026-08-12 起多传 hasPrRef(让 PR 参与「按勾选顺序」排列),调用被 prettier
    // 折成多行——断言收窄到函数与前四个入参。
    expect(sessionItemSource).toMatch(
      /useProjectedSessionInfoPieces\(\s*session,\s*taskInfoFields,\s*activityIso,\s*t,/,
    );
    expect(sessionItemSource).toContain('<SessionInfoMeta');
    expect(sessionItemSource).toContain('pieces={infoPieces}');
    expect(sessionInfoMetaSource).toContain('formatSidebarTime(activityIso, t)');
    expect(sessionInfoMetaSource).toContain('text-sidebar-action-icon');
    expect(sessionItemSource).toContain('transition-opacity');
  });

  it('keeps the archive shortcut in the same right-side slot instead of crowding the time', () => {
    expect(sessionItemSource).toContain(
      'relative ml-auto flex h-6 shrink-0 items-center justify-end',
    );
    // 文字模式信息槽按内容收缩:「任务信息 = 无」或短时间都不能再预留 56px 空位挤标题。
    expect(sessionItemSource).not.toMatch(
      /group\/slot relative ml-auto flex h-6 shrink-0 items-center justify-end min-w-14/,
    );
    expect(sessionItemSource).toContain('worktree={infoWorktree ?? undefined}');
    expect(sessionItemSource).toContain('canQuickArchive && archivePending &&');
    expect(sessionItemSource).toContain(
      "!archivePending && 'group-hover:opacity-0 group-focus-within/slot:opacity-0'",
    );
    expect(sessionItemSource).toContain('group/slot relative ml-auto');
    expect(sessionItemSource).toContain(
      'grid h-6 grid-cols-[max-content] items-center justify-items-end',
    );
    expect(sessionItemSource).toContain('absolute right-0 top-0 flex h-6 items-center gap-0.5');
    expect(sessionItemSource).toContain(
      'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
    );
    expect(sessionItemSource).toContain("'hidden group-hover:flex group-focus-within/slot:flex'");
  });
});
