/**
 * notifySlot.test.ts — 系统提示槽单测(纯 DI,无 Electron)。
 * 覆盖:happy path(广播带主机填的身份三件套)、能力资格审(未声明 notify
 * 即拒)、沉睡拒、载荷校验(text 形状/空/超长、tone 白名单)、净化
 * (控制字符剥除、\r\n 归一)、每意识限速(注入时钟直测)。
 */

import { describe, it, expect, vi } from 'vitest';

import { GhostNotifySlot, type NotifySlotDeps } from '../notifySlot';
import { GHOST_NOTIFY_MIN_INTERVAL_MS } from '../../../shared/ghost';
import type { InstalledGhost } from '../../../shared/ghost';

function fakeGhost(
  overrides: { enabled?: boolean; notify?: boolean; iconDataUrl?: string } = {},
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'weather',
      name: '天气',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      ...(overrides.notify === false ? {} : { notify: true }),
    },
    dir: '/fake/brain/weather',
    enabled: overrides.enabled ?? true,
    ...(overrides.iconDataUrl ? { iconDataUrl: overrides.iconDataUrl } : {}),
  } as InstalledGhost;
}

function makeSlot(
  ghost: InstalledGhost | null,
  overrides: Partial<NotifySlotDeps> = {},
): { slot: GhostNotifySlot; broadcast: ReturnType<typeof vi.fn> } {
  const broadcast = vi.fn();
  const slot = new GhostNotifySlot({
    getGhost: () => ghost,
    broadcast,
    ...overrides,
  });
  return { slot, broadcast };
}

describe('GhostNotifySlot', () => {
  it('happy path:广播身份三件套(主机填,不信意识自报)+ 正文 + 语气', () => {
    const { slot, broadcast } = makeSlot(fakeGhost({ iconDataUrl: 'data:image/png;base64,xx' }));
    const r = slot.handleNotify('weather', { type: 'notify', text: '明天有雨', tone: 'warning' });
    expect(r).toEqual({ ok: true });
    expect(broadcast).toHaveBeenCalledWith({
      ghostId: 'weather',
      name: '天气',
      iconDataUrl: 'data:image/png;base64,xx',
      text: '明天有雨',
      tone: 'warning',
    });
  });

  it('tone 缺省为 info;未声明图标时载荷不带 iconDataUrl 键', () => {
    const { slot, broadcast } = makeSlot(fakeGhost());
    expect(slot.handleNotify('weather', { type: 'notify', text: 'hi' })).toEqual({ ok: true });
    expect(broadcast).toHaveBeenCalledWith({ ghostId: 'weather', name: '天气', text: 'hi', tone: 'info' });
  });

  it('未声明 notify 能力即拒', () => {
    const { slot, broadcast } = makeSlot(fakeGhost({ notify: false }));
    const r = slot.handleNotify('weather', { type: 'notify', text: 'hi' });
    expect(r.ok).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('沉睡 / 未装入即拒', () => {
    const asleep = makeSlot(fakeGhost({ enabled: false }));
    expect(asleep.slot.handleNotify('weather', { type: 'notify', text: 'hi' }).ok).toBe(false);
    const missing = makeSlot(null);
    expect(missing.slot.handleNotify('weather', { type: 'notify', text: 'hi' }).ok).toBe(false);
  });

  it('载荷校验:text 非字符串 / 空白 / 超长、tone 白名单外都是结构化拒绝', () => {
    const { slot, broadcast } = makeSlot(fakeGhost());
    expect(slot.handleNotify('weather', { type: 'notify' }).ok).toBe(false);
    expect(slot.handleNotify('weather', { type: 'notify', text: 42 }).ok).toBe(false);
    expect(slot.handleNotify('weather', { type: 'notify', text: '   ' }).ok).toBe(false);
    expect(slot.handleNotify('weather', { type: 'notify', text: 'x'.repeat(201) }).ok).toBe(false);
    expect(slot.handleNotify('weather', { type: 'notify', text: 'hi', tone: 'fancy' }).ok).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('净化:控制字符剥除、\\r\\n 归一成 \\n(保留换行)', () => {
    const { slot, broadcast } = makeSlot(fakeGhost());
    const dirty = 'a\u0000b\r\nc\u001bd';
    expect(slot.handleNotify('weather', { type: 'notify', text: dirty })).toEqual({ ok: true });
    expect(broadcast.mock.calls[0][0].text).toBe('ab\ncd');
  });

  it('限速:同一意识最小间隔内第二条拒收,过间隔后放行;不同意识互不影响', () => {
    let now = 1_000_000;
    const g = fakeGhost();
    const broadcast = vi.fn();
    const slot = new GhostNotifySlot({
      // 两个意识同库直测:按 id 返回不同 ghost
      getGhost: (id) =>
        id === 'weather'
          ? g
          : ({ ...g, manifest: { ...g.manifest, id: 'other', name: '其它' } } as InstalledGhost),
      broadcast,
      now: () => now,
    });
    expect(slot.handleNotify('weather', { type: 'notify', text: '1' }).ok).toBe(true);
    now += GHOST_NOTIFY_MIN_INTERVAL_MS - 1;
    expect(slot.handleNotify('weather', { type: 'notify', text: '2' }).ok).toBe(false);
    // 别的意识不受这家的限速影响
    expect(slot.handleNotify('other', { type: 'notify', text: '3' }).ok).toBe(true);
    now += 1;
    expect(slot.handleNotify('weather', { type: 'notify', text: '4' }).ok).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(3);
  });
});
