/**
 * 开屏卡住诊断的 main 入口:这一行写进 `renderer-guard`,会随「日志与反馈」离开用户机器
 * (docs/dev-rules/log-upload-and-redaction.md §1.2)。锁住两件事:
 *   - 只认主窗口顶层 frame,且只写白名单字段——renderer 夹带的任何文本都不能落进日志;
 *   - 进程内封顶,renderer 异常重载不会刷屏。
 */
import { describe, expect, it, vi } from 'vitest';

import type { StartupGateStallSnapshot } from '../../shared/startupGateStall';
import { createStartupGateStallReporter } from '../startupGateStallReport';

const snapshot: StartupGateStallSnapshot = {
  elapsedMs: 48_300,
  waitingMs: 20_400,
  documentVisible: true,
  authInitializing: false,
  authMode: 'cloud',
  authenticated: true,
  canEnterApp: true,
  envStatus: 'passed',
  localDbGate: 'ready',
  coverHeld: false,
  handoffPhase: 'boot',
  handoffBranch: 'none',
  brandStageMounted: true,
  brandAssetsReady: true,
  splashExited: false,
  splashExitCompleted: false,
  loginPanelMounted: false,
};

function setup(fromMainWindow = true) {
  const warn = vi.fn();
  const report = createStartupGateStallReporter({
    isMainWindowTopFrame: () => fromMainWindow,
    warn,
  });
  return { warn, report };
}

describe('startup gate stall report', () => {
  it('writes one whitelisted line for the main window', () => {
    const { warn, report } = setup();

    report({}, snapshot);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toBe(
      'startup gate held for 20s (renderer up 48s): elapsedMs=48300 waitingMs=20400 ' +
        'documentVisible=true ' +
        'authInitializing=false authMode=cloud authenticated=true canEnterApp=true ' +
        'envStatus=passed localDbGate=ready coverHeld=false handoffPhase=boot handoffBranch=none ' +
        'brandStageMounted=true brandAssetsReady=true splashExited=false ' +
        'splashExitCompleted=false loginPanelMounted=false',
    );
  });

  it.each([
    ['an extra field carrying text', { ...snapshot, note: 'C:\\Users\\alice\\secret.txt' }],
    ['a free-text enum value', { ...snapshot, envStatus: 'typed by user' }],
    ['a missing field', { ...snapshot, loginPanelMounted: undefined }],
    ['a non-integer duration', { ...snapshot, elapsedMs: 1.5 }],
  ])('drops a payload with %s', (_label, payload) => {
    const { warn, report } = setup();

    report({}, payload);

    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores senders other than the main window top frame', () => {
    const { warn, report } = setup(false);

    report({}, snapshot);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stops after three reports per process', () => {
    const { warn, report } = setup();

    for (let i = 0; i < 5; i += 1) report({}, snapshot);

    expect(warn).toHaveBeenCalledTimes(3);
  });
});
