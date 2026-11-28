/**
 * 测试价值
 * - 生产入口与可观察结果：probeBiometry（`--biometry` 的读取口，`readAwayGuardState` 在设置页
 *   加载与重新聚焦时等它）；观察「旧助手不认这个开关时」是否立刻降级，以及是否留下子进程。
 * - 规则依据：PR 的常亮验证框握手按模式版本化（`ready owner-prompt`）同一条理由——源码运行时
 *   升级后会复用随包发布的旧助手，旧助手落到自己的事件流模式、打印 `ready` 后一直等 stdin。
 * - 现有覆盖缺口：`inputHost.readDesktopBiometry` 只被各处 mock，没有用例覆盖真实读取。
 * - 最小失败输入：旧助手对 `--biometry` 打印 `ready` 并保持 stdin 打开（旧行为：等满 5 秒超时）。
 * - tier：unit，假 stdio，无原生进程。
 */
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { probeBiometry } from '../biometryProbe';

afterEach(() => vi.useRealTimers());

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: { resume() {} },
    kill: vi.fn(),
  });
  const runtime = { spawn: () => child as unknown as ChildProcessWithoutNullStreams };
  return { child, runtime, binary: '/helper' };
}

it('reads the word the helper prints for this Mac', async () => {
  const f = fixture();
  const probing = probeBiometry(f.binary, f.runtime);
  f.child.stdout.emit('data', Buffer.from('touchid\n'));
  await expect(probing).resolves.toBe('touchid');
  expect(f.child.kill).toHaveBeenCalledOnce();
});

it('gives up at once when an older helper greets instead of answering', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const probing = probeBiometry(f.binary, f.runtime);
  // A helper from before `--biometry` fell through to its event-stream reader: `ready`, then
  // it waits on stdin. Five seconds of that on every settings load is what this avoids.
  f.child.stdout.emit('data', Buffer.from('ready\n'));
  await expect(probing).resolves.toBeUndefined();
  expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('reports an empty answer when the helper never says anything', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const probing = probeBiometry(f.binary, f.runtime);
  await vi.advanceTimersByTimeAsync(5000);
  await expect(probing).resolves.toBeUndefined();
  expect(f.child.kill).toHaveBeenCalledOnce();
});
