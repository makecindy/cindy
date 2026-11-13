import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const helperFault = vi.hoisted(() => ({ scriptPrefix: '' }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) =>
      actual.spawn(
        command,
        helperFault.scriptPrefix
          ? [...args.slice(0, -1), `${helperFault.scriptPrefix}\n${args.at(-1)}`]
          : args,
        options,
      ),
  };
});

import {
  acquireWindowsPackagedInstanceBarrier,
  __testing,
} from '../windowsPackagedInstanceBarrier.js';

describe('windowsPackagedInstanceBarrier', () => {
  it('parses only complete helper statuses', () => {
    expect(__testing.parseBarrierStatus('{"status":"started"}')).toEqual({
      status: 'started',
    });
    expect(__testing.parseBarrierStatus('{"status":"locked"}')).toEqual({
      status: 'locked',
    });
    expect(__testing.parseBarrierStatus('{"status":"acquired"}')).toEqual({
      status: 'acquired',
    });
    expect(__testing.parseBarrierStatus('{"status":"busy"}')).toEqual({ status: 'busy' });
    expect(__testing.parseBarrierStatus('{"status":"occupied","pid":4242}')).toEqual({
      status: 'occupied',
      pid: 4242,
    });
    expect(() => __testing.parseBarrierStatus('{"status":"occupied","pid":0}')).toThrow(
      'invalid status',
    );
  });

  it('uses Electron ProcessSingleton names and a message-only-window probe', () => {
    expect(__testing.processSingletonNames('Cindy')).toEqual({
      mutexName: 'Local\\CindyProcessSingletonStartup',
      windowClass: 'Chrome_MessageWindow',
    });
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain('FindWindowEx');
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain(
      'CINDY_SINGLETON_WINDOW_CLASS',
    );
    expect(__testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT).toContain(
      'CINDY_SINGLETON_WINDOW_TITLE',
    );
    // Native probing must happen while holding the startup mutex, or a packaged
    // process could appear between the scan and local-profile adoption.
    expect(
      __testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT.indexOf('{"status":"locked"}'),
    ).toBeLessThan(
      __testing.WINDOWS_PACKAGED_INSTANCE_BARRIER_SCRIPT.indexOf('$window = $nativeProbe::FindWindowEx('),
    );
  });

  it('waits for the helper exit after forced termination', async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    let finished = false;
    const waiting = __testing
      .waitForExit(child as never, 20)
      .then(() => {
        finished = true;
      });

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce(), {
      // 20ms 的强制终止定时器在有负载的 runner 上可能晚触发；
      // 只放宽观察窗口，不改变「exit 事件前不得 finish」的断言。
      timeout: 200,
      interval: 5,
    });
    expect(finished).toBe(false);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await waiting;
    expect(finished).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'holds the packaged startup mutex until release and allows a later retry',
    async () => {
      // CI's probe timed out after acquiring the mutex. Keep the real PowerShell,
      // mutex and Win32 calls, but make compiler use fail immediately: the probe
      // must not depend on starting a C# compiler under runner contention.
      helperFault.scriptPrefix = 'function Add-Type { throw "compiler unavailable during native probe" }';
      try {
        const programName = `CindyBarrierTest${process.pid}`;
        const userDataDir = path.join(os.tmpdir(), programName);
        const first = await acquireWindowsPackagedInstanceBarrier({
          userDataDir,
          programName,
          timeoutMs: 1_000,
        });
        try {
          expect(first.isHeld()).toBe(true);
          await expect(
            acquireWindowsPackagedInstanceBarrier({
              userDataDir,
              programName,
              timeoutMs: 50,
            }),
          ).rejects.toThrow('startup barrier is busy');
        } finally {
          await first.release();
        }
        expect(first.isHeld()).toBe(false);

        const retry = await acquireWindowsPackagedInstanceBarrier({
          userDataDir,
          programName,
          timeoutMs: 1_000,
        });
        try {
          expect(retry.isHeld()).toBe(true);
        } finally {
          await retry.release();
        }
      } finally {
        helperFault.scriptPrefix = '';
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an occupied Unicode message-only window and only exempts its actual owner',
    async () => {
      // The absent-window smoke cannot detect broken Unicode/handle/PID
      // marshalling. This fixture creates an actual, invisible legacy singleton
      // window; all observations below go through the production acquire API.
      // It compiles only the fixture, once, outside the production helper.
      const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const programName = `CindyBarrierWindow${process.pid}`;
      const userDataDir = path.join(os.tmpdir(), programName, '\u6d4b\u8bd5');
      const fixture = spawn(
        `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
        ['-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CindyBarrierWindowFixture {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct WndClass {
    public uint style;
    public IntPtr windowProc;
    public int classExtra;
    public int windowExtra;
    public IntPtr instance;
    public IntPtr icon;
    public IntPtr cursor;
    public IntPtr background;
    public string menuName;
    public string className;
  }
  private delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  private static readonly WindowProc Callback = DefWindowProc;
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern ushort RegisterClass(ref WndClass windowClass);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateWindowEx(uint exStyle, string className, string title, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static void Run(string title) {
    var windowClass = new WndClass {
      className = "Chrome_MessageWindow",
      windowProc = Marshal.GetFunctionPointerForDelegate(Callback)
    };
    if (RegisterClass(ref windowClass) == 0) throw new Win32Exception();
    var window = CreateWindowEx(0, windowClass.className, title, 0, 0, 0, 0, 0,
      new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (window == IntPtr.Zero) throw new Win32Exception();
    try {
      Console.WriteLine(System.Diagnostics.Process.GetCurrentProcess().Id);
      Console.Out.Flush();
      Console.ReadLine();
    } finally { DestroyWindow(window); }
  }
}
'@
[CindyBarrierWindowFixture]::Run($env:CINDY_BARRIER_FIXTURE_TITLE)
`],
        {
          env: { ...process.env, CINDY_BARRIER_FIXTURE_TITLE: userDataDir },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      let output = '';
      let errors = '';
      // Bound fixture setup so even a hung compiler reaches our child cleanup.
      // This does not change any production barrier or Vitest timeout.
      const setupSignal = AbortSignal.timeout(30_000);
      let stopWaitingForSetup = (): void => {};
      try {
        const ownerPid = await new Promise<number>((resolve, reject) => {
          const onAbort = (): void => reject(new Error('window fixture setup did not complete'));
          setupSignal.addEventListener('abort', onAbort, { once: true });
          stopWaitingForSetup = () => setupSignal.removeEventListener('abort', onAbort);
          fixture.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes('\n')) {
              const pid = Number(output.trim());
              if (Number.isInteger(pid) && pid > 0) resolve(pid);
              else reject(new Error(`invalid fixture PID: ${output}`));
            }
          });
          fixture.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
          fixture.once('error', reject);
          fixture.once('exit', (code) => reject(new Error(`window fixture exited (${code}): ${errors}`)));
        });
        stopWaitingForSetup();
        expect(ownerPid).toBe(fixture.pid);
        const options = { userDataDir, programName, timeoutMs: 1_000 };
        await expect(acquireWindowsPackagedInstanceBarrier(options)).rejects.toThrow(
          `legacy packaged instance ${ownerPid} is using shared userData`,
        );
        const ownWindow = await acquireWindowsPackagedInstanceBarrier({ ...options, selfPid: ownerPid });
        try {
          expect(ownWindow.isHeld()).toBe(true);
        } finally {
          await ownWindow.release();
        }
        await expect(acquireWindowsPackagedInstanceBarrier(options)).rejects.toThrow(
          `legacy packaged instance ${ownerPid} is using shared userData`,
        );
      } finally {
        stopWaitingForSetup();
        if (!fixture.stdin.destroyed) fixture.stdin.end('\n');
        await __testing.waitForExit(fixture);
      }
      expect(fixture.exitCode).toBe(0);
      const afterExit = await acquireWindowsPackagedInstanceBarrier({ userDataDir, programName });
      try {
        expect(afterExit.isHeld()).toBe(true);
      } finally {
        await afterExit.release();
      }
    },
  );
});
