/**
 * badgeSlot.test.ts — 未读角标槽单测(纯 DI,无 Electron)。
 * 覆盖:happy path(落盘 + 广播)、两道资格审(notify 槽 / notify.badge 声明)、
 * 沉睡拒、载荷校验(unread 形状、summary 形状/超长)、净化(控制字符剥除、换行
 * 坍缩、净化后为空不拒点)、限速只挡点亮方向、熄灭幂等免广播。
 */

import { describe, it, expect, vi } from 'vitest';

import { GhostBadgeSlot, type BadgeSlotDeps } from '../badgeSlot';
import {
  GHOST_BADGE_MIN_INTERVAL_MS,
  GHOST_BADGE_SUMMARY_MAX_CHARS,
  type InstalledGhost,
} from '../../../shared/ghost';

function fakeGhost(
  overrides: { enabled?: boolean; notify?: boolean; badge?: boolean } = {},
): InstalledGhost {
  const badge = overrides.badge ?? true;
  return {
    manifest: {
      schemaVersion: 2,
      id: 'inbox',
      name: '收件箱',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      panel: { html: 'panel.html' },
      ...(overrides.notify === false ? {} : { notify: true }),
      ...(badge ? { badge: true } : {}),
    },
    dir: '/fake/brain/inbox',
    enabled: overrides.enabled ?? true,
  } as InstalledGhost;
}

function makeSlot(ghost: InstalledGhost | null, overrides: Partial<BadgeSlotDeps> = {}) {
  const mark = vi.fn(() => true);
  const clear = vi.fn(() => true);
  const broadcast = vi.fn();
  const slot = new GhostBadgeSlot({
    getGhost: () => ghost,
    mark,
    clear,
    broadcast,
    ...overrides,
  });
  return { slot, mark, clear, broadcast };
}

describe('GhostBadgeSlot', () => {
  it('happy path:落盘 + 广播(摘要净化后原样带上,时刻由主机铸)', () => {
    const { slot, mark, broadcast } = makeSlot(fakeGhost(), { now: () => 1_700_000_000_000 });
    const r = slot.handleBadge('inbox', { type: 'badge', unread: true, summary: '3 条新工单' });
    expect(r).toEqual({ ok: true });
    expect(mark).toHaveBeenCalledWith('inbox', '3 条新工单', 1_700_000_000_000);
    expect(broadcast).toHaveBeenCalledWith({
      ghostId: 'inbox',
      unread: true,
      summary: '3 条新工单',
      at: 1_700_000_000_000,
    });
  });

  it('资格只看 badge 声明:没声明就拒(存量只有 notify 的老包不白捡这档能力)', () => {
    const noDecl = makeSlot(fakeGhost({ badge: false }));
    const r = noDecl.slot.handleBadge('inbox', { unread: true });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).toContain('badge');
    expect(noDecl.mark).not.toHaveBeenCalled();
  });

  it('不要求 notify:只声明 panel + badge 的意识照样能点亮(两档权限并列)', () => {
    const { slot, mark } = makeSlot(fakeGhost({ notify: false }), { now: () => 1 });
    expect(slot.handleBadge('inbox', { unread: true, summary: '新内容' })).toEqual({ ok: true });
    expect(mark).toHaveBeenCalledWith('inbox', '新内容', 1);
  });

  it('沉睡 / 不在装:拒,不落盘不广播', () => {
    const asleep = makeSlot(fakeGhost({ enabled: false }));
    expect(asleep.slot.handleBadge('inbox', { unread: true })).toMatchObject({ ok: false });
    expect(asleep.broadcast).not.toHaveBeenCalled();

    const gone = makeSlot(null);
    expect(gone.slot.handleBadge('inbox', { unread: true })).toMatchObject({ ok: false });
    expect(gone.broadcast).not.toHaveBeenCalled();
  });

  it('载荷校验:unread 必须是布尔;summary 必须是字符串且不超限', () => {
    const { slot, mark } = makeSlot(fakeGhost());
    expect(slot.handleBadge('inbox', { unread: 'yes' })).toMatchObject({ ok: false });
    expect(slot.handleBadge('inbox', {})).toMatchObject({ ok: false });
    expect(slot.handleBadge('inbox', { unread: true, summary: 42 })).toMatchObject({ ok: false });
    // 超长直接拒,不静默截断——作者需要知道自己超了。
    expect(
      slot.handleBadge('inbox', {
        unread: true,
        summary: 'x'.repeat(GHOST_BADGE_SUMMARY_MAX_CHARS + 1),
      }),
    ).toMatchObject({ ok: false });
    expect(mark).not.toHaveBeenCalled();
  });

  it('净化:控制字符剥除、换行坍缩成空格;净化后为空按"没给摘要"处理而不是拒点', () => {
    const { slot, mark, broadcast } = makeSlot(fakeGhost(), { now: () => 1 });
    expect(
      slot.handleBadge('inbox', { unread: true, summary: '第一行\n\n第二行\u0007' }),
    ).toEqual({ ok: true });
    expect(mark).toHaveBeenCalledWith('inbox', '第一行 第二行', 1);

    const blank = makeSlot(fakeGhost(), { now: () => 1 });
    expect(blank.slot.handleBadge('inbox', { unread: true, summary: '  \u0000 ' })).toEqual({
      ok: true,
    });
    expect(blank.mark).toHaveBeenCalledWith('inbox', undefined, 1);
    expect(blank.broadcast).toHaveBeenCalledWith({ ghostId: 'inbox', unread: true, at: 1 });
    expect(broadcast).toHaveBeenCalled();
  });

  it('净化后的长度才是判超限的依据(不许拿控制字符注水绕过上限)', () => {
    const { slot } = makeSlot(fakeGhost(), { now: () => 1 });
    const padded = 'x'.repeat(GHOST_BADGE_SUMMARY_MAX_CHARS) + '\u0000'.repeat(50);
    expect(slot.handleBadge('inbox', { unread: true, summary: padded })).toEqual({ ok: true });
  });

  it('限速只挡点亮方向:连点被拒,熄灭永远放行', () => {
    let now = 1_000;
    const { slot, mark, clear } = makeSlot(fakeGhost(), { now: () => now });
    expect(slot.handleBadge('inbox', { unread: true })).toEqual({ ok: true });
    now += GHOST_BADGE_MIN_INTERVAL_MS - 1;
    expect(slot.handleBadge('inbox', { unread: true })).toMatchObject({ ok: false });
    expect(mark).toHaveBeenCalledTimes(1);
    // 关键:熄灭是降级动作,被限速会留下一颗清不掉的死点。
    expect(slot.handleBadge('inbox', { unread: false })).toEqual({ ok: true });
    expect(clear).toHaveBeenCalledTimes(1);
    // 过了窗口再点亮放行。
    now += 1;
    expect(slot.handleBadge('inbox', { unread: true })).toEqual({ ok: true });
    expect(mark).toHaveBeenCalledTimes(2);
  });

  it('熄灭:本来就没亮时幂等成功且不广播(免掉每次开面板刷一轮全窗口推送)', () => {
    const { slot, broadcast } = makeSlot(fakeGhost(), { clear: () => false });
    expect(slot.handleBadge('inbox', { unread: false })).toEqual({ ok: true });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('落盘失败:不广播、不记限速账,如实回失败 —— 免得留下一颗清不掉的点', () => {
    const { slot, broadcast } = makeSlot(fakeGhost(), { mark: () => false, now: () => 1_000 });
    const r = slot.handleBadge('inbox', { unread: true, summary: '新内容' });
    expect(r).toMatchObject({ ok: false });
    // 广播了就会在 renderer 留下账本里根本不存在的点,而熄灭路径查不到记录
    // → 不广播 → 那颗点再也清不掉。
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('落盘失败不占限速额度:作者重试不该被自己上一条挡住', () => {
    let now = 1_000;
    let ok = false;
    const { slot, broadcast } = makeSlot(fakeGhost(), { mark: () => ok, now: () => now });
    expect(slot.handleBadge('inbox', { unread: true })).toMatchObject({ ok: false });
    ok = true;
    now += 1; // 远小于最小间隔
    expect(slot.handleBadge('inbox', { unread: true })).toEqual({ ok: true });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('forget 抹掉限速记账:重装后第一条不被上一世的时刻挡住', () => {
    let now = 1_000;
    const { slot, mark } = makeSlot(fakeGhost(), { now: () => now });
    expect(slot.handleBadge('inbox', { unread: true })).toEqual({ ok: true });
    slot.forget('inbox');
    now += 1; // 远小于最小间隔
    expect(slot.handleBadge('inbox', { unread: true })).toEqual({ ok: true });
    expect(mark).toHaveBeenCalledTimes(2);
  });
});
