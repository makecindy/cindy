/**
 * busyReporter 单测 —— 被控端 busy presence 的 dedupe 与重连补正(PR #166 review New-F)。
 * 核心:hello 必须报当前真实 busy 并同步 dedupe 基线,否则 turn 进行中重连会让其它设备整轮看成空闲。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setBusyProbe,
  currentBusy,
  helloBusy,
  pollBusyChange,
  resetBusyDedupe,
  __testing,
} from '../device-link/busyReporter';

beforeEach(() => __testing.reset());

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
