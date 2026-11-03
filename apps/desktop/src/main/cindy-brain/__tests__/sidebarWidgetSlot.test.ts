import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GHOST_SIDEBAR_WIDGET_MIN_INTERVAL_MS,
  type GhostSidebarWidgetEntry,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import { GhostSidebarWidgetSlot } from '../sidebarWidgetSlot.js';

const group = (over: Record<string, unknown> = {}) => ({
  key: 'running',
  label: '运行中',
  tone: 'running',
  taskIds: ['task-1'],
  ...over,
});

function ghost(manifest: Record<string, unknown>, enabled = true): InstalledGhost {
  return { enabled, manifest } as unknown as InstalledGhost;
}

describe('GhostSidebarWidgetSlot', () => {
  const declared = { sidebarWidget: true, agent: { observe: true } };
  let current: InstalledGhost | null;
  let approved: boolean;
  let now: number;
  let broadcast: ReturnType<typeof vi.fn<(entries: GhostSidebarWidgetEntry[]) => void>>;
  let slot: GhostSidebarWidgetSlot;

  beforeEach(() => {
    current = ghost(declared);
    approved = true;
    now = 1_000;
    broadcast = vi.fn();
    slot = new GhostSidebarWidgetSlot({
      getGhost: () => current,
      isObserveApproved: () => approved,
      broadcast,
      now: () => now,
    });
  });

  it('accepts declared groups and broadcasts them under the sandbox-bound id', () => {
    const payload = { ghostId: 'someone-else', groups: [group()] };
    expect(slot.handle('board', payload)).toEqual({ ok: true });
    expect(broadcast).toHaveBeenLastCalledWith([{ ghostId: 'board', groups: [group()] }]);
  });

  it.each([
    ['missing plugin', () => { current = null; }],
    ['disabled plugin', () => { current = ghost(declared, false); }],
    ['undeclared capability', () => { current = ghost({ agent: { observe: true } }); }],
    ['undeclared observe', () => { current = ghost({ sidebarWidget: true }); }],
    ['unapproved observe', () => { approved = false; }],
  ])('rejects %s', (_name, arrange) => {
    arrange();
    expect(slot.handle('board', { groups: [group()] }).ok).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each([
    ['non-array groups', { groups: 'x' }],
    ['too many groups', { groups: Array.from({ length: 7 }, (_, i) => group({ key: `k${i}` })) }],
    ['invalid key', { groups: [group({ key: 'Bad Key' })] }],
    ['duplicate key', { groups: [group(), group()] }],
    ['blank label', { groups: [group({ label: ' \n' })] }],
    ['long label', { groups: [group({ label: 'x'.repeat(17) })] }],
    ['unknown tone', { groups: [group({ tone: 'purple' })] }],
    ['too many tasks', { groups: [group({ taskIds: Array.from({ length: 51 }, (_, i) => `t${i}`) })] }],
    ['non-string task id', { groups: [group({ taskIds: [1] })] }],
    ['duplicate task id', { groups: [group({ taskIds: ['task-1', 'task-1'] })] }],
    ['null payload', null],
  ])('rejects %s', (_name, payload) => {
    expect(slot.handle('board', payload).ok).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('strips control characters and collapses whitespace in labels', () => {
    slot.handle('board', { groups: [group({ label: ' 运行\u0007中\n ' })] });
    expect(slot.snapshot()[0]?.groups[0]?.label).toBe('运行中');
  });

  it('limits changed content only: identical pushes and clearing always succeed', () => {
    slot.handle('board', { groups: [group()] });
    expect(slot.handle('board', { groups: [group()] })).toEqual({ ok: true });
    expect(slot.handle('board', { groups: [group({ label: '进行中' })] }).ok).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);

    now += GHOST_SIDEBAR_WIDGET_MIN_INTERVAL_MS;
    expect(slot.handle('board', { groups: [group({ label: '进行中' })] })).toEqual({ ok: true });
    expect(slot.handle('board', { groups: [] })).toEqual({ ok: true });
    expect(broadcast).toHaveBeenLastCalledWith([]);
  });

  it('clearing keeps the rate limit, so alternating with a push cannot bypass it; forget resets it', () => {
    slot.handle('board', { groups: [group()] });
    expect(slot.handle('board', { groups: [] })).toEqual({ ok: true });
    expect(slot.handle('board', { groups: [group()] }).ok).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(2);

    slot.forget('board');
    expect(slot.handle('board', { groups: [group()] })).toEqual({ ok: true });
  });

  it('forgets one plugin without touching others, and reset clears every plugin', () => {
    slot.handle('board', { groups: [group()] });
    slot.handle('other', { groups: [group()] });
    slot.forget('board');
    expect(slot.snapshot().map((entry) => entry.ghostId)).toEqual(['other']);

    broadcast.mockClear();
    slot.forget('board');
    expect(broadcast).not.toHaveBeenCalled();

    slot.reset();
    expect(slot.snapshot()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith([]);
  });
});
