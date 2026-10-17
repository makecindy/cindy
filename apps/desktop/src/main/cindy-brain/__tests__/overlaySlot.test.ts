/** overlaySlot.test — overlay-request 消息族守门的假 deps 单测。 */

import { describe, expect, it, vi } from 'vitest';

import {
  createGhostOverlaySlot,
  type GhostOverlaySlotDeps,
} from '../overlaySlot';

const GHOST_ID = 'overlay-ghost';

/** 与真实 Electron 同形的最小显示器集合:两条屏,横竖混排、scaleFactor 不同。 */
function makeDisplays() {
  return [
    {
      id: 0,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1,
    },
    {
      id: 1,
      bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
      workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
      scaleFactor: 1.5,
    },
  ];
}

function makeSlot(overrides: Partial<GhostOverlaySlotDeps> = {}) {
  const deps: GhostOverlaySlotDeps = {
    isGhostOverlayDeclared: () => true,
    isUserEnabled: () => true,
    isMounted: () => false,
    prewarm: vi.fn(),
    show: vi.fn(async () => {}),
    hide: vi.fn(),
    move: vi.fn(),
    setInteractive: vi.fn(),
    unmount: vi.fn(),
    getAllDisplays: () => makeDisplays(),
    subscribeCursor: vi.fn(),
    unsubscribeCursor: vi.fn(),
    ...overrides,
  };
  return { slot: createGhostOverlaySlot(deps), deps };
}

describe('overlaySlot · mount 资格审', () => {
  it('mount rejects when overlay not declared', async () => {
    const { slot, deps } = makeSlot({ isGhostOverlayDeclared: () => false });
    await expect(slot.handle(GHOST_ID, 'mount', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'OVERLAY_NOT_DECLARED',
    });
    expect(deps.prewarm).not.toHaveBeenCalled();
    expect(deps.show).not.toHaveBeenCalled();
  });

  it('mount rejects when user disabled', async () => {
    const { slot, deps } = makeSlot({ isUserEnabled: () => false });
    await expect(slot.handle(GHOST_ID, 'mount', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'OVERLAY_USER_DISABLED',
    });
    expect(deps.prewarm).not.toHaveBeenCalled();
    expect(deps.show).not.toHaveBeenCalled();
  });

  it('mount prewarms then shows when declared and enabled', async () => {
    const { slot, deps } = makeSlot();
    await expect(slot.handle(GHOST_ID, 'mount', {})).resolves.toEqual({ ok: true });
    expect(deps.prewarm).toHaveBeenCalledWith(GHOST_ID);
    expect(deps.show).toHaveBeenCalledWith(GHOST_ID);
  });

  it('re-enabling does not auto-show until plugin mounts again', async () => {
    let enabled = false;
    const { slot, deps } = makeSlot({ isUserEnabled: () => enabled });

    await expect(slot.handle(GHOST_ID, 'mount', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'OVERLAY_USER_DISABLED',
    });
    expect(deps.prewarm).not.toHaveBeenCalled();
    expect(deps.show).not.toHaveBeenCalled();

    // 用户重新开启:只改变资格,不触发任何预热/展示。
    enabled = true;
    expect(deps.prewarm).not.toHaveBeenCalled();
    expect(deps.show).not.toHaveBeenCalled();

    // 插件自己再次 mount 才真正预热 + 展示。
    await expect(slot.handle(GHOST_ID, 'mount', {})).resolves.toEqual({ ok: true });
    expect(deps.prewarm).toHaveBeenCalledTimes(1);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });
});

describe('overlaySlot · 未 mount 时 fail closed', () => {
  it('set-interactive before mount fails closed', async () => {
    const { slot, deps } = makeSlot();
    await expect(
      slot.handle(GHOST_ID, 'set-interactive', { interactive: true }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'OVERLAY_NOT_MOUNTED' });
    expect(deps.setInteractive).not.toHaveBeenCalled();
  });

  it('move before mount fails closed', async () => {
    const { slot, deps } = makeSlot();
    await expect(slot.handle(GHOST_ID, 'move', { x: 0, y: 0 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'OVERLAY_NOT_MOUNTED',
    });
    expect(deps.move).not.toHaveBeenCalled();
  });
});

describe('overlaySlot · move 坐标校验与钳制', () => {
  it('move clamps out-of-bounds coordinates', async () => {
    const { slot, deps } = makeSlot({ isMounted: () => true });
    // 联合边界:x ∈ [0, 4480],y ∈ [0, 1440]。
    await expect(slot.handle(GHOST_ID, 'move', { x: -100, y: 2000 })).resolves.toEqual({
      ok: true,
    });
    expect(deps.move).toHaveBeenCalledWith(GHOST_ID, 0, 1440);

    await expect(slot.handle(GHOST_ID, 'move', { x: 5000, y: -50 })).resolves.toEqual({
      ok: true,
    });
    expect(deps.move).toHaveBeenCalledWith(GHOST_ID, 4480, 0);
  });

  it('move rejects non-finite coordinates with INVALID_PARAMS', async () => {
    const { slot, deps } = makeSlot({ isMounted: () => true });
    for (const bad of [NaN, Infinity, -Infinity, 1.5, '10', null, undefined]) {
      await expect(
        slot.handle(GHOST_ID, 'move', { x: bad, y: 0 }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    }
    expect(deps.move).not.toHaveBeenCalled();
  });

  it('move clamps against union bounds with negative display origins', async () => {
    const displays = [
      {
        id: 0,
        bounds: { x: 2560, y: -1114, width: 1440, height: 2560 },
        workArea: { x: 2560, y: -1114, width: 1440, height: 2512 },
        scaleFactor: 1,
      },
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 0, width: 2560, height: 1392 },
        scaleFactor: 1,
      },
    ];
    const { slot, deps } = makeSlot({ isMounted: () => true, getAllDisplays: () => displays });
    // 联合边界:x ∈ [0, 4000],y ∈ [-1114, 1446](本机实况:竖屏原点 y 为负)。
    await expect(slot.handle(GHOST_ID, 'move', { x: -50, y: -2000 })).resolves.toEqual({
      ok: true,
    });
    expect(deps.move).toHaveBeenCalledWith(GHOST_ID, 0, -1114);

    await expect(slot.handle(GHOST_ID, 'move', { x: 5000, y: 2000 })).resolves.toEqual({
      ok: true,
    });
    expect(deps.move).toHaveBeenCalledWith(GHOST_ID, 4000, 1446);
  });
});

describe('overlaySlot · displays 查询', () => {
  it('displays rejects when overlay not declared (fail closed)', async () => {
    const getAllDisplays = vi.fn(() => makeDisplays());
    const { slot } = makeSlot({
      isGhostOverlayDeclared: () => false,
      getAllDisplays,
    });
    await expect(slot.handle(GHOST_ID, 'displays', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'OVERLAY_NOT_DECLARED',
    });
    expect(getAllDisplays).not.toHaveBeenCalled();
  });

  it('displays returns all displays with workArea and scaleFactor', async () => {
    const { slot } = makeSlot();
    await expect(slot.handle(GHOST_ID, 'displays', {})).resolves.toEqual({
      ok: true,
      displays: makeDisplays(),
    });
  });
});

describe('overlaySlot · 其余 kind 转发与校验', () => {
  it('set-interactive validates boolean and forwards when mounted', async () => {
    const { slot, deps } = makeSlot({ isMounted: () => true });
    await expect(
      slot.handle(GHOST_ID, 'set-interactive', { interactive: true }),
    ).resolves.toEqual({ ok: true });
    expect(deps.setInteractive).toHaveBeenCalledWith(GHOST_ID, true);

    await expect(
      slot.handle(GHOST_ID, 'set-interactive', { interactive: 'yes' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });

  it('cursor-subscribe/unsubscribe forward to injected deps when mounted', async () => {
    const { slot, deps } = makeSlot({ isMounted: () => true });
    await expect(slot.handle(GHOST_ID, 'cursor-subscribe', {})).resolves.toEqual({ ok: true });
    expect(deps.subscribeCursor).toHaveBeenCalledWith(GHOST_ID);
    await expect(slot.handle(GHOST_ID, 'cursor-unsubscribe', {})).resolves.toEqual({ ok: true });
    expect(deps.unsubscribeCursor).toHaveBeenCalledWith(GHOST_ID);
  });

  it('unknown kind returns INVALID_PARAMS', async () => {
    const { slot } = makeSlot({ isMounted: () => true });
    await expect(slot.handle(GHOST_ID, 'explode', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });
  });

  it('mount wraps unexpected rejection as INTERNAL', async () => {
    const { slot } = makeSlot({
      show: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await expect(slot.handle(GHOST_ID, 'mount', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
      message: 'overlay 请求处理失败',
    });
  });
});

describe('overlaySlot · 校验顺序(错误码语义精确)', () => {
  it('未 mount 时未知 kind 仍返回 INVALID_PARAMS', async () => {
    const { slot } = makeSlot();
    await expect(slot.handle(GHOST_ID, 'explode', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });
  });

  it('未 mount 时非法参数仍返回 INVALID_PARAMS(而非 OVERLAY_NOT_MOUNTED)', async () => {
    const { slot, deps } = makeSlot();
    await expect(slot.handle(GHOST_ID, 'move', { x: 1.5, y: 0 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_PARAMS',
    });
    await expect(
      slot.handle(GHOST_ID, 'set-interactive', { interactive: 'yes' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(deps.move).not.toHaveBeenCalled();
    expect(deps.setInteractive).not.toHaveBeenCalled();
  });
});
