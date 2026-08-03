/**
 * busyReporter 单测 —— 被控端 busy presence 的 dedupe 与重连补正(PR #166 review New-F)。
 * 核心:hello 必须报当前真实 busy 并同步 dedupe 基线,否则 turn 进行中重连会让其它设备整轮看成空闲。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: logSpies.warn,
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

import {
  setBusyProbe,
  currentBusy,
  helloBusy,
  pollBusyChange,
  resetBusyDedupe,
  __testing,
} from '../device-link/busyReporter';

beforeEach(() => {
  __testing.reset();
  logSpies.warn.mockClear();
});

describe('busyReporter', () => {
  it('无 probe → currentBusy=false', () => {
    expect(currentBusy()).toBe(false);
  });

  it('pollBusyChange:仅在与基线翻转时返回新值,否则 null(dedupe)', () => {
    let busy = false;
    setBusyProbe(() => busy);
    expect(pollBusyChange()).toBeNull(); // false===false 基线
    busy = true;
    expect(pollBusyChange()).toBe(true); // 翻转 → 上报
    expect(pollBusyChange()).toBeNull(); // 再探仍 true → 不上报
    busy = false;
    expect(pollBusyChange()).toBe(false); // 翻回 → 上报
  });

  it('helloBusy:返回当前 busy 并把它设成 dedupe 基线', () => {
    setBusyProbe(() => true);
    expect(helloBusy()).toBe(true);
    expect(__testing.getLastReported()).toBe(true);
  });

  it('[New-F] turn 进行中重连:hello 报 busy=true,轮询不会误判「未变化」', () => {
    // 模拟:turn 已在跑(busy=true),先经轮询上报过一次 → 基线 true。
    let busy = true;
    setBusyProbe(() => busy);
    expect(pollBusyChange()).toBe(true); // 首次上报 busy
    expect(__testing.getLastReported()).toBe(true);

    // relay 断开重连:hello 握手发出。修复前硬编码 busy=false 会把 server presence 覆盖成空闲,
    // 且基线仍 true → 轮询 dedupe 压掉补正。修复后 helloBusy 报当前真实 busy=true 并同步基线。
    expect(helloBusy()).toBe(true); // hello 报真实 busy → server presence 正确
    expect(__testing.getLastReported()).toBe(true); // 基线与 hello 一致

    // turn 仍在跑,后续轮询无需重复上报(已正确);turn 结束才翻转上报 false。
    expect(pollBusyChange()).toBeNull();
    busy = false;
    expect(pollBusyChange()).toBe(false);
  });

  it('[New-F] 反向:turn 已结束时重连,hello 报 false 并同步基线,后续 busy 能正常上报', () => {
    // 断连前 busy=true 上报过(基线 true);断连期间 turn 结束(busy=false)。
    let busy = true;
    setBusyProbe(() => busy);
    pollBusyChange(); // 基线 → true
    busy = false; // turn 在断连期间结束

    // 重连 hello:报当前 false 并把基线同步成 false(否则基线停在 true,下次真 busy 不会上报)。
    expect(helloBusy()).toBe(false);
    expect(__testing.getLastReported()).toBe(false);

    // 下一个 turn 开始 → busy=true 能正常翻转上报。
    busy = true;
    expect(pollBusyChange()).toBe(true);
  });

  it('resetBusyDedupe:基线清回 false', () => {
    setBusyProbe(() => true);
    helloBusy();
    expect(__testing.getLastReported()).toBe(true);
    resetBusyDedupe();
    expect(__testing.getLastReported()).toBe(false);
  });
});

/**
 * probe 抛错(账号 / owner 边界切换期 maker facade 抛 PRECONDITION_FAILED)。
 * 修复前:异常从 pollBusyChange 逃到 5s setInterval,成为主进程 uncaughtException →
 * beginShutdown → exitCode=1,冷启动崩溃循环(issue #1358)。
 */
describe('busyReporter · probe 不可用(issue #1358)', () => {
  const boundaryError = () =>
    new Error('[PRECONDITION_FAILED] App session is switching; retry after the owner boundary settles.');

  it('pollBusyChange 不外抛,返回 null(不上报)', () => {
    setBusyProbe(() => {
      throw boundaryError();
    });
    expect(() => pollBusyChange()).not.toThrow();
    expect(pollBusyChange()).toBeNull();
  });

  it('probe 抛错时基线保持不动 —— 不退化成「不忙」', () => {
    // turn 正在跑并已上报过 → 基线 true。
    let probe: () => boolean = () => true;
    setBusyProbe(() => probe());
    expect(pollBusyChange()).toBe(true);
    expect(__testing.getLastReported()).toBe(true);

    // 边界切换:probe 开始抛错。若把未知当 false,基线会被推成 false,
    // turn 仍在跑时其它设备整轮把本机看成空闲(同 New-F 那个坑)。
    probe = () => {
      throw boundaryError();
    };
    expect(pollBusyChange()).toBeNull();
    expect(__testing.getLastReported()).toBe(true);
  });

  it('probe 恢复后照常工作:未错过的翻转仍会上报', () => {
    let probe: () => boolean = () => {
      throw boundaryError();
    };
    setBusyProbe(() => probe());
    expect(pollBusyChange()).toBeNull(); // 边界期:跳过,基线仍 false
    expect(__testing.getLastReported()).toBe(false);

    // 边界稳定,期间 turn 已经起来了 → 恢复后第一拍就补报 true。
    probe = () => true;
    expect(pollBusyChange()).toBe(true);
    expect(__testing.getLastReported()).toBe(true);
  });

  it('同一段连续失败只记一条 warn,probe 恢复后重新武装', () => {
    let probe: () => boolean = () => {
      throw boundaryError();
    };
    setBusyProbe(() => probe());
    pollBusyChange();
    pollBusyChange();
    pollBusyChange();
    expect(logSpies.warn).toHaveBeenCalledTimes(1); // 边界期每 5s 一条纯噪音,抑制掉

    probe = () => true;
    expect(pollBusyChange()).toBe(true); // 恢复 → 抑制解除
    probe = () => {
      throw boundaryError();
    };
    pollBusyChange();
    expect(logSpies.warn).toHaveBeenCalledTimes(2); // 新一段失败重新记一条
  });

  it('换 probe 会重置失败日志抑制 —— 新一段的首条 warn 不被上一段吃掉', () => {
    const throwing = () => {
      throw boundaryError();
    };
    setBusyProbe(throwing);
    pollBusyChange();
    expect(logSpies.warn).toHaveBeenCalledTimes(1);

    // 账号切换后重建 maker 会走「解绑 → 重新注入」;若不在这里重置抑制标志,
    // 新 probe 仍不可用时的首条 warn 会被上一段的标志静默吃掉。
    setBusyProbe(null);
    setBusyProbe(throwing);
    pollBusyChange();
    expect(logSpies.warn).toHaveBeenCalledTimes(2);
  });

  it('currentBusy / helloBusy 在 probe 不可用时按 false,且能自我纠正', () => {
    let probe: () => boolean = () => {
      throw boundaryError();
    };
    setBusyProbe(() => probe());
    // hello 帧必须带一个具体值,未知只能按 false 发;基线随之为 false。
    expect(currentBusy()).toBe(false);
    expect(helloBusy()).toBe(false);
    expect(__testing.getLastReported()).toBe(false);

    // 边界稳定后若实际在跑 turn,下一拍轮询就把它补正回 true(不会被 dedupe 压掉)。
    probe = () => true;
    expect(pollBusyChange()).toBe(true);
  });
});
