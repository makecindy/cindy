import {
  formatStartupGateStallSnapshot,
  parseStartupGateStallSnapshot,
} from '../shared/startupGateStall';

/**
 * 主窗口 renderer 每次加载最多上报一次;重载(boot guard 重试、用户 Ctrl+R)会再来。
 * 进程内封顶,防止 renderer 异常时刷屏。
 */
const MAX_REPORTS_PER_PROCESS = 3;

export interface StartupGateStallReporterDeps {
  /** 只认主窗口顶层 frame:只有主窗口挂开屏,其它窗口与 webview 的上报一律丢弃。 */
  isMainWindowTopFrame: (event: unknown) => boolean;
  /** 写到上传白名单内的 `renderer-guard`(见 log-upload/sourceAllowlist.ts)。 */
  warn: (message: string) => void;
}

export function createStartupGateStallReporter(
  deps: StartupGateStallReporterDeps,
): (event: unknown, payload: unknown) => void {
  let reports = 0;
  return (event, payload) => {
    if (reports >= MAX_REPORTS_PER_PROCESS) return;
    if (!deps.isMainWindowTopFrame(event)) return;
    const snapshot = parseStartupGateStallSnapshot(payload);
    if (!snapshot) return;
    reports += 1;
    deps.warn(
      `startup gate held for ${Math.round(snapshot.waitingMs / 1000)}s ` +
        `(renderer up ${Math.round(snapshot.elapsedMs / 1000)}s): ` +
        formatStartupGateStallSnapshot(snapshot),
    );
  };
}
