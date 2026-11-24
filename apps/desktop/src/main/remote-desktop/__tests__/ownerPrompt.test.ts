/**
 * 测试价值
 * - 生产入口与可观察结果：watchOwnerPrompt（`--owner-prompt` 助手的长驻协议）；
 *   观察何时算“验证框已挂上”、验证结果怎么回传、撤下时是否真的等进程结束。
 * - 规则依据：docs/product-rules/privacy-screen.md「有人碰电脑」（2026-11-17 用户决定：
 *   遮罩盖着且 Cindy 保持屏幕常亮时，系统 Touch ID 验证框常驻；摸传感器即验证通过并撤罩，
 *   按键/点按仍然直接锁屏）。
 * - 现有覆盖缺口：privacyInput 测试覆盖 `--privacy-input` / `--away-guard`，没有覆盖这条新模式。
 * - 最小失败输入：助手启动即退出（没有 Touch ID）；验证框在收到 stop 前就消失；未知状态词。
 *  这些情况下遮罩必须继续由输入拦截保护，不能被当成“已验证”。
 * - tier：unit，假 stdio/计时器，无原生进程。
 */
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { watchOwnerPrompt } from '../ownerPrompt';

vi.mock('../inputHost', () => ({ resolveDesktopInputBinary: vi.fn() }));
afterEach(() => vi.useRealTimers());

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: { resume() {} },
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
    kill: vi.fn(),
  });
  const answers: string[] = [];
  const runtime = {
    resolveBinary: async () => '/helper',
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
  };
  const line = (text: string) => child.stdout.emit('data', Buffer.from(text));
  const start = (signal?: AbortSignal) =>
    watchOwnerPrompt(
      (answer) => answers.push(answer),
      'remove the privacy screen',
      runtime,
      signal,
    );
  return { child, answers, line, start };
}

it('reports the system answer only after the prompt is up, and never twice', async () => {
  const f = fixture();
  const starting = f.start();
  await Promise.resolve();
  // The prompt is not armed until the helper says it is: answers cannot arrive earlier.
  f.line('verified\n');
  expect(f.answers).toEqual([]);
  await expect(starting).rejects.toThrow('DESKTOP_PRIVACY_UNAVAILABLE');
  f.child.emit('close');
});

it('tells the caller the prompt is gone instead of verified when the helper ends', async () => {
  const f = fixture();
  const starting = f.start();
  await Promise.resolve();
  f.line('ready owner-');
  f.line('prompt\n');
  const prompt = await starting;
  expect(f.answers).toEqual([]);
  f.child.emit('close');
  expect(f.answers).toEqual(['unavailable']);
  await prompt.stop();
  expect(f.child.stdin.write).not.toHaveBeenCalled();
});

it.each(['unavailable', 'locked', 'something-else'])(
  'leaves the cover guarded when the system answers %s',
  async (word) => {
    const f = fixture();
    const starting = f.start();
    await Promise.resolve();
    f.line('ready owner-prompt\n');
    const prompt = await starting;
    f.line(`${word}\n`);
    expect(f.answers).toEqual(['unavailable']);
    const stopping = prompt.stop();
    f.child.emit('close');
    await stopping;
    expect(f.child.kill).not.toHaveBeenCalled();
  },
);

it('names the helper panel for the capture filter and drops the id when it closes', async () => {
  const f = fixture();
  const panels: Array<number | null> = [];
  const starting = watchOwnerPrompt(
    (answer) => f.answers.push(answer),
    'remove the privacy screen',
    {
      resolveBinary: async () => '/helper',
      spawn: () => f.child as unknown as ChildProcessWithoutNullStreams,
    },
    undefined,
    (windowId) => panels.push(windowId),
  );
  await Promise.resolve();
  // The helper prints its panel before the versioned greeting; the id is not an answer.
  f.line('panel 4242\n');
  f.line('ready owner-prompt\n');
  const prompt = await starting;
  expect(panels).toEqual([4242]);
  expect(f.answers).toEqual([]);
  f.child.emit('close');
  expect(f.answers).toEqual(['unavailable']);
  // A window number is reused once its window closes: the id must not outlive the panel.
  expect(panels).toEqual([4242, null]);
  await prompt.stop();
});

it('takes the prompt down through the helper and waits for the process to end', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const starting = f.start();
  await Promise.resolve();
  f.line('ready owner-prompt\n');
  const prompt = await starting;
  let closed = false;
  const stopping = prompt.stop().then(() => {
    closed = true;
  });
  expect(f.child.stdin.write).toHaveBeenCalledWith('stop\n');
  // Killing the process alone leaves the system prompt on screen: only a clean stop counts.
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(closed).toBe(false);
  f.child.emit('close');
  await stopping;
  expect(closed).toBe(true);
  expect(f.answers).toEqual([]);
});

it('cancels a still-starting prompt through the helper, not by killing it', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const cancel = new AbortController();
  const starting = f.start(cancel.signal);
  await Promise.resolve();
  // The cover released the display before the prompt came up. The helper owns the system
  // sheet: only its own `stop` runs `context.invalidate()`, and killing it leaves the
  // prompt on screen for about ten seconds (macos-input.swift, macos-input.swift:1116).
  cancel.abort();
  await expect(starting).rejects.toThrow('DESKTOP_PRIVACY_UNAVAILABLE');
  expect(f.child.stdin.write).toHaveBeenCalledWith('stop\n');
  expect(f.child.kill).not.toHaveBeenCalled();
  // A helper that ignores the stop command is still killed, just no longer as step one.
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.child.kill).toHaveBeenCalledOnce();
  expect(f.answers).toEqual([]);
  f.child.emit('close');
});

it('releases the panel as soon as a helper confirms its own teardown', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const panels: Promise<void>[] = [];
  const starting = watchOwnerPrompt(
    () => {},
    'remove the privacy screen',
    { resolveBinary: async () => '/helper', spawn: () => f.child as unknown as ChildProcessWithoutNullStreams },
    undefined,
    undefined,
    (gone) => panels.push(gone),
  );
  await Promise.resolve();
  f.line('ready owner-prompt\n');
  const prompt = await starting;
  let released = false;
  void panels[0].then(() => { released = true; });
  const stopping = prompt.stop();
  // The helper ran `context.invalidate()` itself: nothing of the request outlives it.
  f.line('stopped\n');
  f.child.emit('close');
  await stopping;
  await vi.advanceTimersByTimeAsync(0);
  expect(released).toBe(true);
});

// Codex P1: 必须被杀掉的助手没有跑 `context.invalidate()`，系统自己还会把验证请求画约十秒
// （macos-input.swift）。这时 close 就等于「可以拍屏幕」会把验证框拍进 Computer Use。
// 就绪要等这段残留过去；只写 stop 就被确认的路径不受影响。
it('keeps the panel blocked for the residual request after a forced kill', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const panels: Promise<void>[] = [];
  const starting = watchOwnerPrompt(
    () => {},
    'remove the privacy screen',
    { resolveBinary: async () => '/helper', spawn: () => f.child as unknown as ChildProcessWithoutNullStreams },
    undefined,
    undefined,
    (gone) => panels.push(gone),
  );
  await Promise.resolve();
  f.line('ready owner-prompt\n');
  const prompt = await starting;
  let released = false;
  void panels[0].then(() => { released = true; });
  const stopping = prompt.stop();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.child.kill).toHaveBeenCalledOnce();
  f.child.emit('close');
  await stopping;
  await vi.advanceTimersByTimeAsync(9_999);
  expect(released).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(released).toBe(true);
});

it('never spawns the helper when the cover is released while the binary is still resolving', async () => {
  // A cold build of the native helper takes seconds; the task can end inside that wait.
  let releaseBinary: (binary: string) => void = () => {};
  const spawn = vi.fn();
  const runtime = {
    resolveBinary: () => new Promise<string>((resolve) => { releaseBinary = resolve; }),
    spawn,
  };
  const cancel = new AbortController();
  const starting = watchOwnerPrompt(
    () => {},
    'remove the privacy screen',
    runtime as unknown as Parameters<typeof watchOwnerPrompt>[2],
    cancel.signal,
  );
  cancel.abort();
  releaseBinary('/helper');
  await expect(starting).rejects.toThrow('DESKTOP_PRIVACY_UNAVAILABLE');
  // Nothing was started, so there is no system sheet to take down afterwards either.
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses a bare ready from a helper that predates this mode', async () => {
  // An older shipped helper ignores the unknown switch and falls through to its generic
  // input loop, which also greets with `ready`. Arming on that word would promise a system
  // sheet that is not on screen.
  const f = fixture();
  const starting = f.start();
  await Promise.resolve();
  f.line('ready\n');
  await expect(starting).rejects.toThrow('DESKTOP_PRIVACY_UNAVAILABLE');
  // The cover stays in charge: no answer is reported and no prompt is considered armed.
  expect(f.answers).toEqual([]);
  // That helper keeps reading stdin in its own mode, so it is taken down, not just ignored.
  expect(f.child.stdin.write).toHaveBeenCalledWith('stop\n');
});
