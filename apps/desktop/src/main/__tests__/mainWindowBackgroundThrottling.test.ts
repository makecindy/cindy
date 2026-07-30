/**
 * mainWindowBackgroundThrottling.test.ts
 * ---------------------------------------------------------------------------
 * 主聊天窗口的后台节流源码契约回归测试。
 *
 * 默认保留 Chromium 后台节流，避免 idle 后台常驻活跃；只有 active turn 或
 * terminal grace 期间临时关闭节流，确保隐藏窗口里的 renderer timer/frame 继续被调度。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  hasAnySessionInTurn,
  isTerminalTurnErrorEvent,
  SessionTurnActivityTracker,
  TURN_IDLE_THROTTLE_RESTORE_GRACE_MS,
} from '../maker-ipc/sessionTurnActivityTracker';
import type { AgentEvent } from '@cindy/maker-core';

const sourcePath = resolve(__dirname, '..', 'bootstrap-electron.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');

/**
 * 剥掉 TS 注释后再做关键字计数：`backgroundThrottling: false` /
 * `installWindowHiddenBroadcast` 这些串在说明性注释里也会出现，不剥会把数目算虚。
 * `[^:]` 前导避免误伤 `https://` 这类。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 路径分隔符归一成 POSIX：Windows 上 path.relative 返回反斜杠。 */
function toPosix(p: string): string {
  return p.split(sep).join('/');
}

describe('主 BrowserWindow 后台节流', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('主 renderer 窗口创建时默认允许后台节流', () => {
    const createWindowMatch = source.match(
      /const mainWindow = new BrowserWindow\(\{[\s\S]*?webPreferences:\s*\{([\s\S]*?)\n\s*\},\n\s*\}\);/,
    );
    expect(createWindowMatch).not.toBeNull();
    const webPreferencesSource = createWindowMatch?.[1];
    if (!webPreferencesSource) {
      throw new Error('mainWindow webPreferences block not found');
    }
    expect(webPreferencesSource).toMatch(/backgroundThrottling:\s*true/);
    expect(webPreferencesSource).not.toMatch(/backgroundThrottling:\s*false/);
  });

  it('active turn 期间通过 webContents 运行态切换后台节流', () => {
    expect(source).toContain('function setMainWindowBackgroundThrottlingForActiveTurn(hasRunningTurn: boolean): void');
    expect(source).toContain('const nextAllowed = !hasRunningTurn;');
    expect(source).toContain('win.webContents.setBackgroundThrottling(mainWindowBackgroundThrottlingAllowed);');
    expect(source).toContain('onAnySessionTurnKeepaliveChange: (isRunning) => {');
    expect(source).toContain('setMainWindowBackgroundThrottlingForActiveTurn(isRunning);');
    expect(source).toContain('notifyUpdateAutoRelaunchBusyStateChanged();');
  });

  it('逻辑 turn 在 terminal broadcast 后立即 idle，但后台节流 keepalive 保留 grace', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const tracker = new SessionTurnActivityTracker();
    tracker.setTurnKeepaliveChangeListener((isRunning) => changes.push(isRunning));

    tracker.setSessionInTurn('session-a', true);
    tracker.scheduleIdleAfterTerminalBroadcast('session-a');

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true]);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS - 1);
    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true]);

    vi.advanceTimersByTime(1);

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true, false]);
  });

  it('多 session 聚合、新 turn 和 close 都会正确处理 idle timer', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const tracker = new SessionTurnActivityTracker();
    tracker.setTurnKeepaliveChangeListener((isRunning) => changes.push(isRunning));

    tracker.setSessionInTurn('session-a', true);
    tracker.setSessionInTurn('session-b', true);
    tracker.scheduleIdleAfterTerminalBroadcast('session-a');
    expect(tracker.isSessionInTurn('session-a')).toBe(false);
    expect(tracker.anySessionInTurn()).toBe(true);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);

    expect(tracker.isSessionInTurn('session-a')).toBe(false);
    expect(tracker.anySessionInTurn()).toBe(true);
    expect(changes).toEqual([false, true]);

    tracker.scheduleIdleAfterTerminalBroadcast('session-b');
    expect(tracker.anySessionInTurn()).toBe(false);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS / 2);
    tracker.setSessionInTurn('session-b', true);
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);

    expect(tracker.anySessionInTurn()).toBe(true);

    tracker.scheduleIdleAfterTerminalBroadcast('session-b');
    tracker.deleteSession('session-b');
    vi.advanceTimersByTime(TURN_IDLE_THROTTLE_RESTORE_GRACE_MS);

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(changes).toEqual([false, true, false]);
  });

  it('tracker 尚未收到 status 时会把 maker active session reservation 视为 busy', () => {
    const tracker = new SessionTurnActivityTracker();

    expect(tracker.anySessionInTurn()).toBe(false);
    expect(hasAnySessionInTurn(tracker, [{ isTurnRunning: () => true }])).toBe(true);
  });

  it('error event 只有 terminal 语义会释放 active turn', () => {
    const terminalError = {
      type: 'error',
      data: { message: 'event loop crashed', isTerminal: true },
    } satisfies AgentEvent;
    const retryableError = {
      type: 'error',
      data: { message: '401 retry-loop', isTerminal: false, willRetry: true },
    } satisfies AgentEvent;
    const legacyError = {
      type: 'error',
      data: { message: 'legacy producer without metadata' },
    } satisfies AgentEvent;

    expect(isTerminalTurnErrorEvent(terminalError)).toBe(true);
    expect(isTerminalTurnErrorEvent(retryableError)).toBe(false);
    expect(isTerminalTurnErrorEvent(legacyError)).toBe(true);
  });
});

/**
 * 关闭节流会让 Renderer 的 document.visibilityState 一直停在 'visible'(Electron 41.2.0
 * 实测:throttling=false 时 minimize()/hide() 后仍为 visible),所以装饰动画闸门不能只靠
 * visibilityState —— 必须有 main 侧广播兜底。两者是同一套机制的两半,一旦广播被删掉,
 * 闸门会在「窗口隐藏 + 节流关闭」这个主场景下静默失效,故在此加源码契约守护。
 */
describe('窗口可见性广播（装饰动画闸门的兜底信号）', () => {
  const broadcastSource = readFileSync(
    resolve(__dirname, '..', 'windowHiddenBroadcast.ts'),
    'utf8',
  ).replace(/\r\n?/g, '\n');

  it('按 BrowserWindow 显隐事件广播，判据同时覆盖 hide 与最小化', () => {
    expect(broadcastSource).toContain(
      'const hidden = !win.isVisible() || win.isMinimized();',
    );
    expect(broadcastSource).toContain('win.webContents.send(WINDOW_HIDDEN_CHANGE_CHANNEL, hidden);');
    for (const event of ['hide', 'show', 'minimize', 'restore']) {
      expect(broadcastSource).toContain(`win.on('${event}', emit);`);
    }
  });

  it('页面加载完成后补发基线，避免 Renderer 惰性订阅错过隐藏态', () => {
    expect(broadcastSource).toContain("win.webContents.on('did-finish-load', emit);");
  });

  /**
   * 关掉 backgroundThrottling 的窗口，若其 renderer 装了装饰动画闸门，就必须同时装广播：
   * 节流关闭 → visibilityState 恒为 visible，又收不到广播 → 两路信号同时失效，闸门形同虚设。
   *
   * 不写死清单，而是扫描整个 main 目录。语音浮窗当初就是这么漏掉的（它和主窗一样加载
   * index.html，闸门在 index.tsx 顶层安装，浮窗视图同样经过）。
   *
   * 豁免必须显式登记并写明理由——目的是逼一次判断，而不是让人默默跳过。
   */
  const BROADCAST_EXEMPT = new Map<string, string>([
    [
      'computer-permission-guide/window.ts',
      // 这两个窗口(guide / backdrop)确实也加载 index.html?view=、也装了闸门，但其视图
      // (ComputerPermissionGuideWindow.tsx)不含任何常驻装饰动画，装广播纯属空转；且该文件
      // 的测试 mock 用单 listener Map，多注册一个 did-finish-load 会覆盖既有回调。
      // 将来这两个视图若引入常驻动画，删掉本豁免即可。
      '权限引导窗与 backdrop 视图无常驻装饰动画',
    ],
  ]);

  it('关闭了 backgroundThrottling 的窗口要么装广播，要么显式登记豁免', () => {
    const mainDir = resolve(__dirname, '..');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };

    // 按「窗口」计数而不是「文件是否提到过」：voice-input/global.ts 里有两个关掉节流的
    // 窗口(浮窗 + 词典 toast)，只看 includes 的话第一个装了就把第二个放过去了。
    // 计数前先剥注释：这些关键字在说明性注释里也会出现，不剥的话数目虚高。
    // 调用点用带实参的形式计数，避免把 import 语句算进去。
    const countMatches = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

    const offenders: string[] = [];
    for (const file of walk(mainDir)) {
      const content = stripComments(readFileSync(file, 'utf8'));
      const unthrottled = countMatches(content, /backgroundThrottling:\s*false/g);
      if (unthrottled === 0) continue;
      // 归一成 POSIX 分隔符再比对：Windows 上 path.relative 返回反斜杠，
      // 而 BROADCAST_EXEMPT 的 key 是 POSIX 写法，不归一会匹配不上豁免、误报 offender。
      const rel = toPosix(relative(mainDir, file));
      if (BROADCAST_EXEMPT.has(rel)) continue;
      const installed = countMatches(content, /installWindowHiddenBroadcast\(\s*\w/g);
      if (installed < unthrottled) {
        offenders.push(`${rel}（关闭节流 ${unthrottled} 处，装了广播 ${installed} 处）`);
      }
    }

    expect(
      offenders,
      '以下文件里关闭 backgroundThrottling 的窗口数多于装了 installWindowHiddenBroadcast 的数量，' +
        '也没在 BROADCAST_EXEMPT 里登记豁免。若这些窗口的视图有常驻装饰动画，闸门会静默失效：\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('主窗、语音浮窗与词典 toast 都装了广播', () => {
    expect(source).toContain('installWindowHiddenBroadcast(mainWindow);');

    // 同一文件里两个窗口各装一份：overlay 与 dictionary toast 的局部变量都叫 window。
    const overlaySource = stripComments(
      readFileSync(resolve(__dirname, '..', 'voice-input', 'global.ts'), 'utf8').replace(/\r\n?/g, '\n'),
    );
    expect([...overlaySource.matchAll(/backgroundThrottling:\s*false/g)]).toHaveLength(2);
    expect([...overlaySource.matchAll(/installWindowHiddenBroadcast\(window\);/g)]).toHaveLength(2);
  });

  it('豁免清单里的文件确实存在且确实关闭了节流（防止豁免过期后静默失效）', () => {
    const mainDir = resolve(__dirname, '..');
    for (const [rel, reason] of BROADCAST_EXEMPT) {
      const content = stripComments(readFileSync(resolve(mainDir, rel), 'utf8'));
      expect(content, `${rel} 已不再关闭 backgroundThrottling，${reason} 这条豁免应删除`).toMatch(
        /backgroundThrottling:\s*false/,
      );
    }
  });
});
