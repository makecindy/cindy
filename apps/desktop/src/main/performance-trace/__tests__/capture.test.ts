import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebContents } from 'electron';
import { beginNativeTrace } from '../capture';
import type { TraceCapture } from '../controller';

// Native-adapter unit tier: Electron/inspector responses are controlled while files use a
// unique OS temp directory. Controller tests cannot see raw profiler writes. Review regression:
// switch accounts while native start/stop is pending; no cross-account files may remain.
// Separate file isolates Electron/inspector mocks from the pure controller/upload tests.
// Standalone Vitest: 0.533s on Windows (2026-10-30), execution 23ms.
const native = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  post: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getAppPath: () => '/test-app', getAppMetrics: () => [] },
  BrowserWindow: { fromWebContents: () => null },
  contentTracing: { startRecording: native.start, stopRecording: native.stop },
}));
vi.mock('node:inspector', () => ({
  Session: class {
    connect() {}
    disconnect = native.disconnect;
    post = native.post;
  },
}));

let dir: string;
let valid: boolean;
let captures: TraceCapture[];
const profile = { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 1 };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-trace-'));
  valid = true;
  captures = [];
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  native.start.mockReset().mockResolvedValue(undefined);
  native.stop.mockReset().mockImplementation(async () => {
    const file = path.join(dir, 'native-temporary.json');
    await writeFile(file, '{"traceEvents":[]}');
    return file;
  });
  native.post
    .mockReset()
    .mockImplementation((_method, _params, callback) => callback(null, { profile }));
});
afterEach(async () => {
  for (const capture of captures) await capture.stop({ discard: true });
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
function sender() {
  return {
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    debugger: {
      isAttached: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({ profile })),
    },
  };
}
async function begin(source = sender()) {
  const capture = await beginNativeTrace({
    dir,
    source: source as unknown as WebContents,
    startedAt: Date.now(),
    isCurrent: () => valid,
    onSample: vi.fn(),
    onEvent: vi.fn(),
    onStop: async () => {},
  });
  captures.push(capture);
  return capture;
}

it('keeps complete raw files for a capture whose owner remains current', async () => {
  const capture = await begin();
  const result = await capture.stop();
  expect(result.profiles).toHaveLength(2);
  expect((await readdir(dir)).sort()).toEqual([
    'chromium-trace.json',
    'main.cpuprofile',
    'renderer.cpuprofile',
  ]);
});
it('does not start native tracing for an already-invalidated session', async () => {
  valid = false;
  await expect(begin()).rejects.toThrow('Recording session changed');
  expect(native.start).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual([]);
});
it('discards raw profiles and Chromium output after invalidation during startup', async () => {
  native.start.mockImplementationOnce(async () => {
    valid = false;
  });
  const capture = await begin();
  expect((await capture.stop()).profiles).toEqual([]);
  expect(native.stop).toHaveBeenCalledOnce();
  expect(await readdir(dir)).toEqual([]);
});
it('discards pending stop results when the account changes before they finish', async () => {
  const source = sender();
  const capture = await begin(source);
  source.debugger.sendCommand.mockImplementationOnce(async () => {
    valid = false;
    return { profile };
  });
  expect((await capture.stop()).profiles).toEqual([]);
  expect(await readdir(dir)).toEqual([]);
});
it('honors explicit cancellation even before a new owner generation is committed', async () => {
  const capture = await begin();
  expect((await capture.stop({ discard: true })).profiles).toEqual([]);
  expect(await readdir(dir)).toEqual([]);
});
