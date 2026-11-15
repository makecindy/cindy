/**
 * 测试价值
 * - 生产入口与可观察结果：AwayGuardController.tick / masksEnded / displaysChanged；
 *   观察是否保持屏幕常亮、何时盖遮罩、结束时是否先真锁屏。
 * - 规则依据：主人 2026-11-06 要求「要么没锁，要么锁了解不开」都不能发生；Codex
 *   Locked use 解锁后被立即锁回的回归。
 * - 现有覆盖缺口：新模块，远程桌面 controller 测试不覆盖离开时的遮罩生命周期。
 * - 最小失败输入：主人解锁后仍有任务运行（不应立即重新遮罩）；遮罩建立失败（必须放弃常亮）；
 *   PR #9190 review：遮罩建立中接入显示器、建立中放行 Agent 输入、锁屏失败、远程会话撤罩；
 *   在已锁屏时启动（2026-11-06 实测：没有锁屏事件，测试版在锁屏后面一直常亮）。
 * - tier：unit，内存 fake，无 Electron / 原生进程。
 */
import { describe, expect, it } from 'vitest';
import {
  AWAY_GUARD_PREVIEW_MS,
  AWAY_GUARD_RETRY_MS,
  AwayGuardController,
  consoleSessionLocked,
  type AwayGuardDeps,
} from '../awayGuard';

const AWAY_MS = 5 * 60_000;
/** Two of these pass the retry window; one does not. */
const AWAY_MS_RETRY_PROBE = AWAY_GUARD_RETRY_MS / 2 + 1;

function setup(overrides: Partial<AwayGuardDeps> = {}) {
  const state = {
    now: 0,
    enabled: true,
    locked: false,
    sinceOwner: 0 as number | null,
    awake: false,
    events: [] as string[],
    showFails: false,
    lockFails: false,
  };
  const deps: AwayGuardDeps = {
    enabled: () => state.enabled,
    screenLocked: () => state.locked,
    msSinceOwnerInput: () => state.sinceOwner,
    awayAfterMs: () => AWAY_MS,
    keepDisplayAwake: (awake) => {
      state.awake = awake;
    },
    showMasks: async () => {
      if (state.showFails) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      state.events.push('show');
    },
    lockAndHideMasks: async () => {
      state.events.push('lock');
      if (state.lockFails) throw new Error('DESKTOP_LOCK_FAILED');
      state.locked = true;
    },
    hideMasks: () => {
      state.events.push('hide');
    },
    now: () => state.now,
    log: () => {},
    ...overrides,
  };
  const guard = new AwayGuardController(deps);
  /** Advance time with the owner away and the newest input being the Agent's. */
  const away = async (ms: number) => {
    state.now += ms;
    state.sinceOwner = Number.POSITIVE_INFINITY;
    await guard.tick();
  };
  return { state, guard, away };
}

describe('AwayGuardController', () => {
  it('keeps the display awake while on and covers only after the chosen away time', async () => {
    const { state, guard, away } = setup();
    await guard.tick();
    expect(state.awake).toBe(true);
    await away(AWAY_MS - 1_000);
    expect(state.events).toEqual([]);
    await away(1_000);
    expect(state.events).toEqual(['show']);
    expect(guard.masked).toBe(true);
    expect(state.awake).toBe(true);
  });

  it('locks before removing the masks when the setting is turned off', async () => {
    const { state, guard, away } = setup();
    await away(AWAY_MS);
    state.enabled = false;
    await guard.tick();
    expect(state.events).toEqual(['show', 'lock']);
    expect(state.awake).toBe(false);
    expect(guard.masked).toBe(false);
  });

  it('stays covered and awake while nothing is running', async () => {
    // 2026-11-06: tasks sent from a phone later must not find a locked screen.
    const { state, guard, away } = setup();
    await away(AWAY_MS);
    await away(60 * 60_000);
    expect(state.events).toEqual(['show']);
    expect(state.awake).toBe(true);
    expect(guard.masked).toBe(true);
  });

  it('falls back to the system lock when the masks cannot start', async () => {
    const { state, guard, away } = setup();
    state.showFails = true;
    await away(AWAY_MS);
    expect(guard.masked).toBe(false);
    expect(state.awake).toBe(false);
    // No retry loop: the display stays free to sleep and lock for the retry window.
    await away(AWAY_MS_RETRY_PROBE);
    expect(state.awake).toBe(false);
    state.showFails = false;
    await away(AWAY_MS_RETRY_PROBE);
    expect(state.events).toEqual(['show']);
  });

  it('does not cover again right after the owner unlocks while work continues', async () => {
    const { state, guard, away } = setup();
    await away(AWAY_MS);
    // Someone touched the Mac: the helper locked and the masks went away.
    guard.masksEnded();
    state.locked = true;
    await away(30 * 60_000);
    expect(state.awake).toBe(false);
    // The owner unlocks; the Agent keeps working without any owner input after that.
    state.locked = false;
    await away(2_000);
    expect(state.events).toEqual(['show']);
    expect(state.awake).toBe(true);
    await away(AWAY_MS);
    expect(state.events).toEqual(['show', 'show']);
  });

  it('never covers while the owner is active or their activity cannot be read', async () => {
    const { state, guard } = setup();
    state.now = AWAY_MS * 2;
    state.sinceOwner = 1_000;
    await guard.tick();
    expect(state.events).toEqual([]);
    expect(state.awake).toBe(true);
    state.now += AWAY_MS * 2;
    state.sinceOwner = null;
    await guard.tick();
    expect(state.events).toEqual([]);
    expect(state.awake).toBe(false);
  });

  it('locks for a display added while covered, even while the masks are still going up', async () => {
    let finishShow = () => {};
    const { state, guard, away } = setup();
    await away(AWAY_MS);
    await guard.displaysChanged();
    expect(state.events).toEqual(['show', 'lock']);
    state.locked = false;
    state.events = [];
    const slow = setup({
      showMasks: () =>
        new Promise<void>((resolve) => {
          finishShow = resolve;
        }),
    });
    const ticking = slow.away(AWAY_MS);
    // Masks are still loading and the helper is not consuming input yet.
    expect(slow.guard.masked).toBe(true);
    expect(slow.guard.inputShielded).toBe(false);
    await slow.guard.displaysChanged();
    finishShow();
    await ticking;
    expect(slow.state.events).toEqual(['lock']);
    expect(slow.guard.inputShielded).toBe(false);
  });

  it('keeps covering through a remote desktop session', async () => {
    // A session alone does not prove anyone protects this screen (view-only, plugin screens).
    const { state, guard, away } = setup();
    await away(AWAY_MS);
    await away(60_000);
    expect(state.events).toEqual(['show']);
    expect(guard.inputShielded).toBe(true);
  });

  it('releases the display but reports no unlock when the lock cannot be confirmed', async () => {
    const { state, guard, away } = setup();
    await away(AWAY_MS);
    state.lockFails = true;
    state.enabled = false;
    await guard.tick();
    expect(state.events).toEqual(['show', 'lock']);
    // The service keeps the masks up until macOS locks; the controller frees the display.
    expect(state.awake).toBe(false);
    expect(guard.masked).toBe(false);
  });

  it('previews the cover even with the setting off and no work, then uncovers when it runs out', async () => {
    const { state, guard } = setup();
    state.enabled = false;
    await guard.preview();
    await guard.tick();
    expect(state.events).toEqual(['show']);
    expect(state.awake).toBe(true);
    state.now += AWAY_GUARD_PREVIEW_MS;
    await guard.tick();
    expect(state.events).toEqual(['show', 'hide']);
    expect(state.awake).toBe(false);
  });

  it('reads this user\'s lock state from the console session list', () => {
    const user = (uid: number, extra: string) =>
      `{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserIDKey"=${uid}${extra}}`;
    const ioreg = (...users: string[]) => `"IOConsoleUsers" = (${users.join(',')})`;
    expect(consoleSessionLocked(ioreg(user(501, ',"CGSSessionScreenIsLocked"=Yes')), 501)).toBe(true);
    expect(consoleSessionLocked(ioreg(user(501, '')), 501)).toBe(false);
    // Another user's locked session, or a longer uid, is not this user's.
    expect(consoleSessionLocked(ioreg(user(5010, ',"CGSSessionScreenIsLocked"=Yes'), user(501, '')), 501)).toBe(false);
    // Fast user switching: this session lost the console.
    expect(consoleSessionLocked(ioreg('{"kCGSSessionOnConsoleKey"=No,"kCGSSessionUserIDKey"=501}'), 501)).toBe(true);
    expect(consoleSessionLocked(ioreg(user(502, '')), 501)).toBeNull();
  });
});
