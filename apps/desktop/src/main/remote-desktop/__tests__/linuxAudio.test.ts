import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { LinuxDesktopAudio } from '../linuxAudio';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const capture = new LinuxDesktopAudio(() => child as unknown as ChildProcessWithoutNullStreams);
  return { child, capture };
}
afterEach(() => vi.useRealTimers());

it('contains synchronous launch failure and can start again without retaining old callbacks', () => {
  const old = fixture().child;
  const next = fixture().child;
  const launch = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockImplementationOnce(() => {
      throw new Error('spawn failed');
    })
    .mockReturnValueOnce(next);
  const capture = new LinuxDesktopAudio(launch);
  try {
    capture.start();
    expect(() => capture.start()).not.toThrow();
    expect(old.kill).toHaveBeenCalledOnce();
    expect(() => capture.read()).toThrow('DESKTOP_AUDIO_UNAVAILABLE');
    capture.start();
    old.emit('error', new Error('late error'));
    old.emit('exit');
    next.stdout.write(Buffer.alloc(8, 42));
    expect([...capture.read()]).toEqual(Array(8).fill(42));
    expect(next.kill).not.toHaveBeenCalled();
  } finally {
    capture.stop();
  }
});

it('retains sample alignment across chunks and bounds history to 100 ms', () => {
  const { child, capture } = fixture();
  try {
    capture.start();
    child.stdout.write(Buffer.from([1, 2, 3]));
    expect(capture.read()).toHaveLength(0);
    child.stdout.write(Buffer.from([4, 5, 6, 7, 8, 9]));
    expect([...capture.read()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    child.stdout.write(Buffer.alloc(80000, 42));
    expect(capture.read()).toHaveLength(38392);
    child.stdout.write(Buffer.alloc(7, 43));
    expect([...capture.read()]).toEqual([42, 43, 43, 43, 43, 43, 43, 43]);
  } finally {
    capture.stop();
  }
});

it('erases buffered sound on stop and ignores late callbacks', () => {
  const { child, capture } = fixture();
  capture.start();
  child.stdout.write(Buffer.alloc(80));
  capture.stop();
  child.stdout.write(Buffer.alloc(80));
  expect(() => capture.read()).toThrow('DESKTOP_AUDIO_UNAVAILABLE');
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('stops a producer when its renderer no longer consumes audio', () => {
  vi.useFakeTimers();
  const { child, capture } = fixture();
  capture.start();
  vi.advanceTimersByTime(4000);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(() => capture.read()).toThrow('DESKTOP_AUDIO_UNAVAILABLE');
});

it('surfaces a native capture failure without exposing native diagnostics', () => {
  const { child, capture } = fixture();
  capture.start();
  child.emit('error', new Error('private native details'));
  expect(() => capture.read()).toThrow('DESKTOP_AUDIO_UNAVAILABLE');
});
it('fails a stalled producer even while the renderer keeps polling', () => {
  vi.useFakeTimers();
  const { child, capture } = fixture();
  capture.start();
  for (let i = 0; i < 6; i++) {
    capture.read();
    vi.advanceTimersByTime(1000);
  }
  expect(child.kill).toHaveBeenCalledOnce();
  expect(() => capture.read()).toThrow('DESKTOP_AUDIO_UNAVAILABLE');
});
