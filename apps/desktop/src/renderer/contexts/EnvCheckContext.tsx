import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { isGhostPanelWindow } from '@/lib/ghostPanelWindow';

/**
 * 由主窗派生的附属窗口(会话多开副窗 / 右侧栏子窗口 / 插件面板子窗口):
 * 主窗启动时已完成 env check + 热更检查,附属窗口一律跳过
 * (初始 'passed' + 不跑 auto-check)。
 */
function isDerivedWindow(): boolean {
  return isSecondaryWindow() || isSidebarWindow() || isGhostPanelWindow();
}

/* ── Types ── */

/**
 * Startup phases (parallel since #26):
 * Phase 1 (background): update check — checking_update → updating → update_done
 * Phase 2 (foreground): binary check — checking → downloading → passed/failed
 *
 * 进度显示模型(2026-07 重构):两条下载在 main 侧共用单槽(maxConcurrent=1)
 * FIFO 调度器,物理上串行——同一时刻只有一段在真实下载。splash 进度条跟随
 * "当前真正在下载的那一段":热更段(app-update-progress → 'updating')与
 * 二进制段(binary-download-progress → 'downloading')按事件到达顺序交替
 * 接管,段切换时 bump resetSignal 让进度条无动画归零。二进制段活跃期间
 * (Phase 2 IPC 在途且已收到二进制进度)丢弃热更事件、Phase 2 返回后丢弃
 * 二进制尾包,用于抵御 webContents.send 与 invoke reply 跨通道乱序。
 */
export type EnvCheckStatus =
  | 'idle'
  | 'checking_update'      // Phase 1: pulling manifest, checking for app hot-update
  | 'updating'             // Phase 1: downloading app update
  | 'update_done'          // Phase 1: update downloaded, about to relaunch
  | 'manifest_failed'      // Phase 1: manifest fetch failed, need retry
  | 'download_failed'      // Phase 1: hotfix 下载失败/校验失败，需要用户重试
  | 'checking'             // Phase 2: checking CCD binary
  | 'downloading'          // Phase 2: downloading CCD binary
  | 'passed'               // All done
  | 'failed';              // Env check failed

export interface DownloadInfo {
  progress: number;
  speed?: string;
  downloaded?: string;
  total?: string;
}

export interface EnvCheckContextValue {
  status: EnvCheckStatus;
  result: EnvCheckResult | null;
  downloadProgress: number;
  downloadInfo: DownloadInfo;
  updateVersion?: string;
  /** D 场景顺序下载阶段：1 / 2 / 3；B/C 场景未定义。 */
  step?: 1 | 2 | 3;
  /** D 场景 = 本次需要下载的二进制段数(2 或 3);B/C 场景未定义。 */
  totalSteps?: 2 | 3;
  /**
   * 自增 token——进度条需要无动画归零时 +1,供 SplashScreen 关闭 transition。
   * 触发时机:主进程发 reset payload(D 场景 claude→codex 切段),以及
   * 热更段⇄二进制段互相切换(进度从上一段的高位跳回新段起点)。
   */
  resetSignal: number;
  checkEnvironment: () => Promise<void>;
}

/* ── Context ── */

const EnvCheckContext = createContext<EnvCheckContextValue | null>(null);

/* ── Helpers ── */

function formatBytes(b: number): string {
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ── Provider ── */

export function EnvCheckProvider({ children }: { children: ReactNode }) {
  // 「在新窗口打开」的副窗口:由主窗右键开出,主窗启动时已完成 env check + 热更检查,
  // 副窗不再重跑——初始即 'passed' 放行主 UI,避免首帧空白/splash 闪现;下面的
  // auto-check effect 也会对副窗 early-return,彻底不触发热更检查(prod 下若后台已下好
  // 补丁,重跑会命中 action:'relaunch' 把整个 app 重启)。
  const [status, setStatus] = useState<EnvCheckStatus>(
    isDerivedWindow() ? 'passed' : 'idle',
  );
  const [result, setResult] = useState<EnvCheckResult | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadInfo, setDownloadInfo] = useState<DownloadInfo>({ progress: 0 });
  const [updateVersion, setUpdateVersion] = useState<string | undefined>();
  const [step, setStep] = useState<1 | 2 | 3 | undefined>(undefined);
  const [totalSteps, setTotalSteps] = useState<2 | 3 | undefined>(undefined);
  const [resetSignal, setResetSignal] = useState(0);

  // Phase 2 IPC 在途标记:二进制进度事件只在这个窗口内合法(prepare 的所有广播
  // 都发生在 check-environment 返回之前),窗口外到达的一律是乱序尾包,丢弃。
  const phase2InFlightRef = useRef(false);
  // 当前驱动进度条的下载段:'update' = 热更 zip,'binary' = agent 二进制。
  // 底层单槽串行,两段不会真并发;该 ref 用于 (a) 段切换时 bump resetSignal
  // 无动画归零,(b) 二进制段活跃期间丢弃热更事件(挡跨通道乱序交错)。
  const lastProgressSourceRef = useRef<'update' | 'binary' | null>(null);
  // Retry 防护：递增 callId，Phase 1 返回后校验是否仍为当前调用，避免旧 promise 干扰新流程
  const callIdRef = useRef(0);
  // Mirror status to ref so the grace-period tick (delayed setTimeout) can see
  // the latest value synchronously — closing over `status` from useCallback
  // would always read the stale value at checkEnvironment() call time.
  const statusRef = useRef<EnvCheckStatus>('idle');
  useEffect(() => { statusRef.current = status; }, [status]);

  // Listen to CCD download progress from main process
  useEffect(() => {
    const unsubCCD = window.electronAPI.onBinaryDownloadProgress((payload) => {
      if (!payload) return;
      // Phase 2 已返回后到达的二进制尾包(webContents.send 与 invoke reply 走
      // 不同通道,不保证 FIFO)一律丢弃——此后 splash 由热更段 / 终态接管,
      // 尾包会把 status 错误地拉回 'downloading'。失败场景不受影响:失败时
      // check-environment 的 reply 本身就是 allPassed=false,checkEnvironment
      // 会兜底 setStatus('failed')。
      if (!phase2InFlightRef.current) return;
      // Terminal failure: escape splash immediately so the user sees retry,
      // instead of waiting for the (synchronous) checkEnvironment IPC to return.
      if (payload.failed === true) {
        setStatus('failed');
        return;
      }
      // step / totalSteps 跟 payload 走（缺省即清掉，保证 B/C 场景不残留 D 场景的标签）
      setStep(payload.step);
      setTotalSteps(payload.totalSteps);
      // reset payload：先 bump 信号让 SplashScreen 关闭 transition，再 set 进度=0。
      // payload.reset === true 时主进程已经把 progress 显式设成 0，按下面常规分支处理即可。
      if (payload.reset === true) {
        setResetSignal((n) => n + 1);
      }
      if (typeof payload.progress === 'number') {
        // 热更段 → 二进制段切换:进度条要从热更段的高位跳回二进制段起点,
        // 必须无动画归零(reset payload 已 bump 过的不重复)。
        if (lastProgressSourceRef.current === 'update' && payload.reset !== true) {
          setResetSignal((n) => n + 1);
        }
        lastProgressSourceRef.current = 'binary';
        setDownloadProgress(payload.progress);
        setDownloadInfo({
          progress: payload.progress,
          speed: payload.speed,
          downloaded: payload.downloaded,
          total: payload.total,
        });
        setStatus('downloading');
      }
    });

    // Listen to app update download progress — only during startup (splash phase).
    // Once env check passes, background update progress must NOT reset status,
    // otherwise EnvCheckGuard unmounts the entire main UI mid-session.
    const unsubUpdate = window.electronAPI.onAppUpdateProgress?.((payload) => {
      setStatus((prev) => {
        // Ignore progress events after env check has passed — background poll only.
        if (prev === 'passed') return prev;
        if (!payload) return prev;
        // Phase-1 终态保护：update_done / download_failed / manifest_failed / failed
        // 一旦确定就不再被后到的 app-update-progress 事件（progress 或 failed）刷掉。
        // Electron `webContents.send` 和 `ipcMain.handle` 的 invoke reply 走不同内部
        // 通道，到渲染端不保证 FIFO——若 invoke reply 先到、progress 事件后到，
        // progress=100 的尾包会把 update_done 覆盖回 'updating'，splash 卡在 100%
        // 不再切到重启对话框；同理 failed 事件也不应翻动已经定好的终态。
        // 'failed'（二进制检查失败）也必须在列：热更包可能仍在后台下载，其进度
        // 事件不能把重试提示刷回 'updating'（否则热更下完后 splash 永久卡死——
        // checkEnvironment 在 Phase 2 失败时已 return，没有人再消费 updatePromise）。
        if (
          prev === 'update_done' ||
          prev === 'download_failed' ||
          prev === 'manifest_failed' ||
          prev === 'failed'
        ) {
          return prev;
        }
        // 二进制段活跃期间(Phase 2 在途且二进制已在推进度)丢弃热更事件。
        // 底层单槽串行,真实交错不存在;这里只挡热更段收尾时被延迟送达的尾包
        // (典型:热更 100% 事件在二进制段开始后才到,会把进度条从二进制段
        // 起点拉回 100 造成闪烁)。
        if (phase2InFlightRef.current && lastProgressSourceRef.current === 'binary') {
          return prev;
        }
        // Terminal failure during startup: drop into download_failed so the splash
        // dialog appears. Background polls (prev === 'passed') are filtered above.
        if (payload.failed === true) {
          return 'download_failed';
        }
        if (typeof payload.progress === 'number') {
          // 二进制段 → 热更段切换(此时 Phase 2 已结束):无动画归零。
          if (lastProgressSourceRef.current === 'binary') {
            setResetSignal((n) => n + 1);
          }
          lastProgressSourceRef.current = 'update';
          setDownloadProgress(payload.progress);
          setDownloadInfo({
            progress: payload.progress,
            speed: payload.speed,
            downloaded: formatBytes(payload.received),
            total: formatBytes(payload.total),
          });
          return 'updating';
        }
        return prev;
      });
    });

    return () => {
      unsubCCD();
      unsubUpdate?.();
    };
  }, []);

  const checkEnvironment = useCallback(async () => {
    const thisCallId = ++callIdRef.current;
    setDownloadProgress(0);
    setDownloadInfo({ progress: 0 });
    lastProgressSourceRef.current = null;

    // ── Phase 1 (background): update check — fire-and-forget promise ──
    const updatePromise = (async () => {
      try {
        return await window.electronAPI.checkAppUpdate();
      } catch {
        return null;
      }
    })();

    // ── Phase 2 (foreground): binary check ──
    // 注意:Phase 2 在途期间热更事件【不再】被整体抑制——两条下载底层单槽
    // 串行,先开下的那段(通常是热更 zip)直接驱动进度条;二进制段一旦开始
    // 推进度,事件处理器按 lastProgressSourceRef 切段(见上方两个 listener)。
    phase2InFlightRef.current = true;
    setStatus('checking');

    let phase2Passed = false;
    try {
      const res = await window.electronAPI.checkEnvironment();
      setResult(res);
      phase2Passed = res.allPassed;
    } catch {
      // 清 flag 必须做 callId 守卫:用户可能在本调用 Phase 2 在途时点了重试,
      // 新调用已把 flag 置 true;旧调用返回时无脑清 false 会让新调用的二进制
      // 进度事件被当成乱序尾包丢弃(splash 卡在 checking)。
      if (thisCallId === callIdRef.current) phase2InFlightRef.current = false;
      setStatus('failed');
      return;
    }

    if (thisCallId === callIdRef.current) phase2InFlightRef.current = false;

    if (!phase2Passed) {
      setStatus('failed');
      return;
    }

    // Retry 防护：若用户在 Phase 2 期间点了重试，此调用已过期，丢弃后续结果
    if (thisCallId !== callIdRef.current) return;

    // ── Phase 2 passed, maker:* IPC registered — resolve Phase 1 ──
    // Grace 设计:Phase 1 一般 ~8ms 拿到 manifest 结论(内网 CDN);若 3s 内还没回,
    // 多半是 manifest 慢或本身没更新,放行进主界面避免阻塞启动(#26 原意)。
    // 但若 grace 到点时 Phase 1 已经在下补丁(status === 'updating'),不能硬切到
    // passed 把正在下载的补丁踢出 splash——必须等下完,否则会出现"补丁下完后直接进
    // 主界面、不触发 relaunch 提示"的回归。
    const UPDATE_GRACE_MS = 3_000;
    type UpdateResult = Awaited<typeof updatePromise>;
    const updateResult = await new Promise<UpdateResult>((resolve) => {
      let settled = false;
      const safeResolve = (v: UpdateResult) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      void updatePromise.then(safeResolve);

      const tick = () => {
        if (settled) return;
        // 正在下补丁/已下完待重启 → 继续等 updatePromise,不超时。
        // 'download_failed'(failed 事件先于 reply 到达)也要等:此时
        // update-check-startup 已经/即将返回,以 null 结算会让下面的兜底
        // setStatus('passed') 把重试弹窗冲掉。
        if (
          statusRef.current === 'updating' ||
          statusRef.current === 'update_done' ||
          statusRef.current === 'download_failed'
        ) {
          setTimeout(tick, 500);
          return;
        }
        safeResolve(null);
      };
      setTimeout(tick, UPDATE_GRACE_MS);
    });

    // 再次校验：grace period 期间可能发生了 retry
    if (thisCallId !== callIdRef.current) return;

    if (updateResult?.hasUpdate && updateResult?.action === 'relaunch') {
      setStatus('update_done');
      setUpdateVersion(updateResult.version);
      return;
    }

    // 热更下载失败:manifest 已确认存在新版本、只是文件没拉下来(或校验失败)。
    // 留在 splash 弹重试对话框,与 main 侧 update-check-startup 的意图对齐
    // (避免带着旧二进制静默进 app)。此前这里无条件 setStatus('passed'),会把
    // failed 事件先行设置的 'download_failed' 冲掉——弹窗闪一下就消失(race)。
    // 不会锁死离线用户:彻底断网时重试会命中 manifest_failed,走下面的放行分支。
    if (updateResult?.hasUpdate && updateResult?.error === 'download_failed') {
      setStatus('download_failed');
      return;
    }

    // No update / manifest failed / grace timeout expired → enter app.
    // manifest_failed 刻意不弹窗拦截:完全离线的用户必须能正常进 app
    // (后台 30min 轮询会在网络恢复后接管)。
    setStatus('passed');
  }, []);

  // Auto-check on mount
  // Dev mode: skip update check (Phase 1), but still run env check (Phase 2)
  // to ensure claudeCodePath is set for the SDK.
  useEffect(() => {
    // 副窗口 / 右侧栏子窗口直接放行(见上方 status 初始化注释),不跑任何启动检查。
    if (isDerivedWindow()) return;
    const isDev = import.meta.env.DEV;
    if (isDev) {
      (async () => {
        setStatus('checking');
        try {
          const res = await window.electronAPI.checkEnvironment();
          setResult(res);
          // claude/codex 缺失在 dev 维持既有放行(注释见上:dev 跑检查只为让
          // 路径就绪);但 bundled ripgrep 缺失不能放行 —— #1956 的启动期
          // fail-fast 在 dev 同样要成立,否则 dev 缺 rg 会被这里的无条件
          // passed 吞掉,直到首次 codex spawn / 文件搜索才炸。
          setStatus(res.ripgrep?.status === 'failed' ? 'failed' : 'passed');
        } catch {
          setStatus('passed');
        }
      })();
      return;
    }
    checkEnvironment();
  }, [checkEnvironment]);

  const value = useMemo(
    () => ({ status, result, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment }),
    [status, result, downloadProgress, downloadInfo, updateVersion, step, totalSteps, resetSignal, checkEnvironment],
  );

  return <EnvCheckContext.Provider value={value}>{children}</EnvCheckContext.Provider>;
}

/* ── Guard ── */

export function EnvCheckGuard({ children }: { children: ReactNode }) {
  const { status } = useEnvCheck();
  if (status !== 'passed') return null;
  return <>{children}</>;
}

/* ── Hook ── */

export function useEnvCheck(): EnvCheckContextValue {
  const context = useContext(EnvCheckContext);
  if (!context) {
    throw new Error('useEnvCheck must be used within EnvCheckProvider');
  }
  return context;
}
