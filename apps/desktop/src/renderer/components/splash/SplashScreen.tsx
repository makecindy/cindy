import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DbSlimmingStartupPhase,
  DbSlimmingStartupProgress,
} from '../../../shared/localDbMaintenance';

import { cn } from '@/lib/utils';
import {
  readSplashPhaseFixture,
  splashPhaseForFixture,
  useSplash,
  type SplashPhase,
} from '@/hooks/useSplash';
import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useEnvCheck } from '@/contexts/EnvCheckContext';
import { useLoginHandoff } from '@/contexts/LoginHandoffContext';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { desktopScale } from '@/components/login/loginScale';
import { useViewportSize } from '@/components/login/LoginStage';
import {
  LoginPanel,
  LoginPrimaryButton,
  LoginTextLink,
  LoginTitleBlock,
} from '@/components/login/LoginControls';
import {
  LOGIN_COLORS,
  LOGIN_GROUP,
  SPLASH_PANEL,
  STAGE,
} from '@/components/login/loginDesignTokens';

/**
 * SplashScreen — wave4 白底统一面板版(implementation-plan Step 3b WHAT1)。
 *
 * 所有权(v4/v6.12):品牌视觉(白底体系背景/立绘/字标/Slogan)已整体迁入
 * `LoginBrandStage`(唯一渲染者,z-[9980],本组件透过透明根透出它);本组件退化为
 * loading/tips/进度层——登录同款白面板(680×440 r36 @570,1229,与登录帧同坐标系
 * 同 desktopScale 缩放)承载全部 Splash 状态。面板高 440 由 SPLASH_PANEL.height 固定,
 * 不跟随登录面板 2026-07-27 的 500(增高只为登录面板内的「跳过登录」入口)。
 *
 * 状态机零删改:useSplash 14-phase 与动作映射未动,本组件只消费。
 * 帧↔状态映射(design.md §8.1 / figma §10.3):
 *   379:581 checking_update / 379:525 updating(downloading 无专属帧复用面板形态,
 *   文案用现网 splash.tips.waking+(x/2)) / 379:607 update_done / 379:633 checking /
 *   379:655 failed(标题「环境初始化失败」+ 主按钮「重试」540×80@70,300,取代旧
 *   白字下划线交互)。
 * 三失败弹窗(manifest/download/spawn)仅统一面板视觉形态,文案与 action 语义沿现网:
 *   manifest_failed/download_failed = 各自重试动作(checkEnvironment);
 *   spawn_failed 的 CTA =「前往下载」打开现网下载页(onSpawnFailedDownload),禁 retry。
 *
 * 不透明白底全盖 + 最短停留 3s 地板(+热更重启守地板)机制不变:前者由
 * LoginBrandStage 背景子层承载(var(--surface) token),后者仍在 useSplash
 * (MIN_DISPLAY_MS,fake-timer 用例保留)。
 *
 * dev-only 状态遍历:VITE_SPLASH_PHASE_FIXTURE(readSplashPhaseFixture,DEV 短路)
 * 只覆盖**显示** phase,生命周期(fade/卸载/data-splash-active)仍跟真实 phase。
 */

/** 面板标题的 splash.tips 现网 key 映射(verbatim,splash-chain.copy 行)。 */
function splashTitleFor(
  phase: SplashPhase,
  t: (key: string) => string,
  step?: 1 | 2 | 3,
  totalSteps?: 2 | 3,
): string | null {
  switch (phase) {
    case 'splash_checking_update':
      return t('splash.tips.checkingUpdate');
    case 'splash_updating':
      return t('splash.tips.updating');
    case 'splash_update_done':
      return t('splash.tips.updateDone');
    case 'splash_checking':
      return t('splash.tips.checkingEnv');
    case 'splash_downloading': {
      // D 场景(两个及以上 vendor 需要下载)显示 (x/y) 进度标签;B/C 场景维持单文案。
      const suffix = step && totalSteps ? `(${step}/${totalSteps})` : '';
      return `${t('splash.tips.waking')}${suffix}`;
    }
    case 'splash_passed':
    case 'fading_out':
      return t('splash.tips.waking');
    case 'splash_failed':
      // wave4 379:655:标题「环境初始化失败」(现网 splash.tips.envFailed 语义拆分,
      // 「重试」交互改主按钮,PR2b 新增 5 语 key)。
      return t('splash.envFailed.title');
    case 'splash_manifest_failed':
      return t('splash.manifestFailed.title');
    case 'splash_download_failed':
      return t('splash.downloadFailed.title');
    case 'splash_spawn_failed':
      return t('splash.spawnFailed.title');
    default:
      return null;
  }
}

function dbCleanupPhaseTranslationKey(phase: DbSlimmingStartupPhase): string {
  switch (phase) {
    case 'preparing':
      return 'splash.databaseCleanup.phase.preparing';
    case 'backing-up':
      return 'splash.databaseCleanup.phase.backingUp';
    case 'copying':
      return 'splash.databaseCleanup.phase.copying';
    case 'cleaning':
      return 'splash.databaseCleanup.phase.cleaning';
    case 'compacting':
      return 'splash.databaseCleanup.phase.compacting';
    case 'verifying':
      return 'splash.databaseCleanup.phase.verifying';
    case 'finalizing':
      return 'splash.databaseCleanup.phase.finalizing';
    case 'cancelling':
      return 'splash.databaseCleanup.phase.cancelling';
  }
}

export function SplashScreen() {
  const { t } = useTranslation();
  const splash = useSplash();
  const { step, totalSteps } = useEnvCheck();
  const { coverHeld } = useAppShellCover();
  const reducedMotion = useReducedMotion();
  const handoff = useLoginHandoff();
  const [shellCoverFading, setShellCoverFading] = useState(false);
  const [dbCleanupProgress, setDbCleanupProgress] = useState<DbSlimmingStartupProgress | null>(
    null,
  );
  const [dbCleanupNow, setDbCleanupNow] = useState(() => Date.now());
  const [dbCleanupCancelPending, setDbCleanupCancelPending] = useState(false);
  const prevCoverHeldRef = useRef(coverHeld);
  const { width, height } = useViewportSize();
  const { scale } = desktopScale(width, height);

  useEffect(() => {
    const maintenance = window.electronAPI?.localDb?.maintenance;
    if (!maintenance?.onStartupProgress || !maintenance.getStartupProgress) return;
    let disposed = false;
    const applyProgress = (progress: DbSlimmingStartupProgress | null) => {
      if (disposed) return;
      setDbCleanupProgress(progress);
      setDbCleanupNow(Date.now());
      if (!progress || progress.phase !== 'cancelling') setDbCleanupCancelPending(false);
    };
    const unsubscribe = maintenance.onStartupProgress(applyProgress);
    void maintenance.getStartupProgress().then(applyProgress, () => {
      // Startup presentation is best-effort; ensureReady remains the source of truth.
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!dbCleanupProgress) return;
    setDbCleanupNow(Date.now());
    const timer = window.setInterval(() => setDbCleanupNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [dbCleanupProgress?.requestId]);

  // dev fixture 只改显示 phase(附录 A splash 行;PROD 恒 null)。
  const fixture = readSplashPhaseFixture();
  const realPhase = splash.phase;
  const holdAfterDone =
    coverHeld && (realPhase === 'splash_done' || realPhase === 'splash_skipped');
  const displayPhase: SplashPhase = fixture
    ? splashPhaseForFixture(fixture)
    : holdAfterDone || shellCoverFading
      ? 'splash_passed'
      : realPhase;

  const {
    isDownloading: realIsDownloading,
    downloadProgress,
    downloadInfo,
    resetSignal,
    showManifestFailedDialog,
    showDownloadFailedDialog,
    showSpawnFailedDialog,
    onRetryManifest,
    onRetryDownload,
    onSpawnFailedDownload,
    onTipsClick,
    onTransitionEnd,
  } = splash;

  // D 场景顺序下载切换 codex 段时主进程发 reset payload,resetSignal 自增。
  // skipTransition 必须和 width=0 同帧生效,否则 transition 已经先把 100→0 跑成动画。
  const prevResetRef = useRef(resetSignal);
  const skipTransition = resetSignal !== prevResetRef.current;
  useEffect(() => {
    prevResetRef.current = resetSignal;
  });

  const splashLifecycleActive =
    realPhase !== 'fading_out' && realPhase !== 'splash_done' && realPhase !== 'splash_skipped';

  useEffect(() => {
    const splashFinished = realPhase === 'splash_done' || realPhase === 'splash_skipped';
    // If reduced-motion is enabled while the shell fade is in progress, the
    // effect cleanup cancels its timer. Clear the in-flight fade explicitly so
    // the Splash can still report completion and unmount.
    if (reducedMotion && !coverHeld && splashFinished) {
      setShellCoverFading(false);
      prevCoverHeldRef.current = coverHeld;
      return;
    }
    if (prevCoverHeldRef.current && !coverHeld && splashFinished) {
      setShellCoverFading(true);
      const timer = window.setTimeout(() => setShellCoverFading(false), 500);
      prevCoverHeldRef.current = coverHeld;
      return () => window.clearTimeout(timer);
    }
    if (holdAfterDone) setShellCoverFading(false);
    prevCoverHeldRef.current = coverHeld;
  }, [coverHeld, holdAfterDone, realPhase, reducedMotion]);

  const shellCoverVisible = holdAfterDone || shellCoverFading;
  // The cover-release effect below sets shellCoverFading in a subsequent
  // render. Include that one-render handoff window in the lock so completion
  // cannot be reported before the fade state is visible to this component.
  const shellCoverFadePending =
    !reducedMotion &&
    prevCoverHeldRef.current &&
    !coverHeld &&
    (realPhase === 'splash_done' || realPhase === 'splash_skipped');
  const splashCanUnmount =
    !fixture &&
    (realPhase === 'splash_done' || realPhase === 'splash_skipped') &&
    !shellCoverVisible &&
    !shellCoverFadePending &&
    !dbCleanupProgress;

  useEffect(() => {
    const root = document.documentElement;
    if (splashLifecycleActive || shellCoverVisible || dbCleanupProgress) {
      root.setAttribute('data-splash-active', '1');
    } else {
      root.removeAttribute('data-splash-active');
    }
    return () => {
      root.removeAttribute('data-splash-active');
    };
  }, [dbCleanupProgress, shellCoverVisible, splashLifecycleActive]);

  // handoff 推进锚之一:Splash 开始退场(fading_out/done/skipped)即上报。
  const splashExitReportedRef = useRef(false);
  useEffect(() => {
    if (splashExitReportedRef.current) return;
    if (
      realPhase === 'fading_out' ||
      realPhase === 'splash_done' ||
      realPhase === 'splash_skipped'
    ) {
      splashExitReportedRef.current = true;
      handoff.reportSplashExited();
    }
  }, [realPhase, handoff]);

  // 布局锁定要覆盖整个 opacity fade；只有 Splash 真正进入 done/skipped 并卸载后，
  // 未登录分支才允许 LoginBrandStage 切到带面板避让的登录布局。
  const splashExitCompletedRef = useRef(false);
  useEffect(() => {
    if (splashExitCompletedRef.current) return;
    if (splashCanUnmount) {
      splashExitCompletedRef.current = true;
      handoff.reportSplashExitCompleted();
    }
  }, [handoff, splashCanUnmount]);

  // dev fixture 激活时冻结停留:真实生命周期跑完也不退场,供状态遍历/视觉走查
  // (readSplashPhaseFixture 在 PROD 恒 null,本分支不可达)。
  if (splashCanUnmount) {
    return null;
  }

  const isMac = window.electronAPI?.platform === 'darwin';

  const title = dbCleanupProgress
    ? t('splash.databaseCleanup.title')
    : splashTitleFor(displayPhase, t, step, totalSteps);
  // 进度条仅更新下载态面板形态(updating/downloading);fixture 模式按显示 phase。
  const isDownloading =
    !dbCleanupProgress &&
    (fixture
      ? displayPhase === 'splash_updating' || displayPhase === 'splash_downloading'
      : realIsDownloading);
  // fixture 冻结走查没有真实下载遥测,给进度行一组演示数据看排版
  // (dev-only:readSplashPhaseFixture 在 PROD 恒 null,本分支不可达)。
  const statsProgress = fixture && !realIsDownloading ? 31 : downloadProgress;
  const statsInfo =
    fixture && !realIsDownloading
      ? { speed: '11.5 MB/s', downloaded: '29.7 MB', total: '97.1 MB' }
      : downloadInfo;
  // 三失败弹窗 → 统一面板形态(fixture 模式按显示 phase 遍历)。
  const dialogKind = fixture
    ? displayPhase === 'splash_manifest_failed'
      ? 'manifest'
      : displayPhase === 'splash_download_failed'
        ? 'download'
        : displayPhase === 'splash_spawn_failed'
          ? 'spawn'
          : null
    : showManifestFailedDialog
      ? 'manifest'
      : showDownloadFailedDialog
        ? 'download'
        : showSpawnFailedDialog
          ? 'spawn'
          : null;
  const isEnvFailed = displayPhase === 'splash_failed';
  const showSpinner = !dbCleanupProgress && dialogKind === null && !isEnvFailed;
  const dbCleanupPercent = dbCleanupProgress
    ? Math.round(Math.min(100, Math.max(0, dbCleanupProgress.progress)))
    : 0;
  const dbCleanupElapsedMs = dbCleanupProgress
    ? Math.max(0, dbCleanupNow - dbCleanupProgress.startedAt)
    : 0;
  const dbCleanupRemainingMs = dbCleanupProgress
    ? Math.max(0, dbCleanupProgress.estimatedTotalMs - dbCleanupElapsedMs)
    : 0;
  const formatDbCleanupDuration = (milliseconds: number): string => {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
    if (seconds < 60) return t('splash.databaseCleanup.duration.seconds', { count: seconds });
    return t('splash.databaseCleanup.duration.minutes', { count: Math.ceil(seconds / 60) });
  };
  const requestDbCleanupCancel = (): void => {
    const maintenance = window.electronAPI?.localDb?.maintenance;
    if (!maintenance?.cancelStartup || !dbCleanupProgress?.cancellable) return;
    setDbCleanupCancelPending(true);
    void maintenance.cancelStartup().then(
      (result) => {
        if (!result.cancelled) setDbCleanupCancelPending(false);
      },
      () => setDbCleanupCancelPending(false),
    );
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] overflow-hidden',
        (realPhase === 'fading_out' || shellCoverFading) && !fixture && !dbCleanupProgress
          ? 'pointer-events-none opacity-0'
          : 'opacity-100',
      )}
      style={
        {
          // 根透明:不透明白底全盖由 LoginBrandStage 背景子层(var(--surface))承载,
          // 品牌五要素从下层透出——本层只叠状态面板与窗口 chrome。
          transition: 'opacity var(--splash-fade-duration) var(--splash-fade-easing)',
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
      onTransitionEnd={onTransitionEnd}
      data-testid="splash-root"
    >
      {/* Toolbar:z-10(关闭/最小化,仅 Windows 原生 chrome) */}
      <div className="relative z-10 flex h-[46px] shrink-0 items-center justify-end px-2">
        {!isMac && !dbCleanupProgress && (
          <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls />
          </div>
        )}
      </div>

      {/* 1819×2098 设计画布(与 LoginBrandStage/LoginStage 同 desktopScale 对齐) */}
      <div
        data-testid="splash-stage"
        className="absolute left-1/2 top-1/2"
        style={{
          width: STAGE.width,
          height: STAGE.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: '50% 50%',
        }}
      >
        {/* 统一白面板:登录同款(680×440 r36 @570,1229,wave4 五帧同位)。
            no-drag 盒高度取 SPLASH_PANEL.height 而非 LOGIN_GROUP.height:登录组高
            (620,含圆钮行)与 Splash 无关,跟着它会把面板底下的空白也划成不可拖拽区。
            盒 = 面板本体,语义即「只有面板内容不参与窗口拖拽」。 */}
        <div
          className="absolute"
          style={
            {
              left: LOGIN_GROUP.x,
              top: LOGIN_GROUP.yDefault,
              width: LOGIN_GROUP.width,
              height: SPLASH_PANEL.height,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        >
          {/* height 显式取 SPLASH_PANEL.height(440):登录面板 2026-07-27 增高到 500 是为
              承载面板内「跳过登录」入口,Splash 五帧无该入口、设计稿未改版,故不跟随 */}
          <LoginPanel testId="splash-panel" height={SPLASH_PANEL.height}>
            {title !== null && (
              <LoginTitleBlock
                title={title}
                // 故障说明(spawnFailed 等)比登录副标题长,3 行下界 y=144,
                // 距 spinner(y=188)/主按钮(y=300)均有余量。
                subtitleMaxLines={3}
                subtitle={
                  dbCleanupProgress
                    ? `${t(dbCleanupPhaseTranslationKey(dbCleanupProgress.phase))} · ${dbCleanupPercent}%`
                    : dialogKind === 'manifest'
                      ? t('splash.manifestFailed.description')
                      : dialogKind === 'download'
                        ? t('splash.downloadFailed.description')
                        : dialogKind === 'spawn'
                          ? t('splash.spawnFailed.description')
                          : undefined
                }
              />
            )}

            {/* spinner 64×64 @面板内(308,188),内弧 #6F6F6F;动画挂 HTML wrapper
                (compositor-only,规则 7),reduced-motion 直落静止 */}
            {showSpinner && (
              <span
                role="status"
                aria-label={title ?? t('splash.tips.waking')}
                data-testid="splash-loading-ring"
                className="absolute inline-flex animate-spin rounded-full motion-reduce:animate-none"
                style={{
                  left: SPLASH_PANEL.spinner.x,
                  top: SPLASH_PANEL.spinner.y,
                  width: SPLASH_PANEL.spinner.size,
                  height: SPLASH_PANEL.spinner.size,
                  // 轨道走 --login-loading-ring-track(与登录页 LoginLoadingRing 同构,
                  // 暗色 rgba(212,212,212,.18) 才可见;内弧仍按 wave4 帧 #6F6F6F)
                  border: '6px solid var(--login-loading-ring-track)',
                  borderTopColor: LOGIN_COLORS.secondaryText,
                }}
              />
            )}

            {/* 更新下载态:进度条 轨 501×16 r12 @(90,346) + 填充 + 明细行 20px */}
            {isDownloading && (
              <>
                <div
                  data-testid="splash-progress-track"
                  className="absolute overflow-hidden"
                  style={{
                    left: SPLASH_PANEL.progress.x,
                    top: SPLASH_PANEL.progress.y,
                    width: SPLASH_PANEL.progress.width,
                    height: SPLASH_PANEL.progress.height,
                    borderRadius: SPLASH_PANEL.progress.radius,
                    background: LOGIN_COLORS.splashProgressTrack,
                  }}
                >
                  <div
                    data-testid="splash-progress-fill"
                    className={cn(
                      'h-full',
                      skipTransition ? '' : 'transition-[width] duration-300',
                    )}
                    style={{
                      width: `${statsProgress}%`,
                      borderRadius: SPLASH_PANEL.progress.radius,
                      background: LOGIN_COLORS.splashProgressFill,
                    }}
                  />
                </div>
                <div
                  data-testid="splash-progress-stats"
                  className="absolute flex items-center justify-center gap-1.5"
                  style={{
                    left: SPLASH_PANEL.stats.x,
                    top: SPLASH_PANEL.stats.y,
                    width: SPLASH_PANEL.stats.width,
                    height: SPLASH_PANEL.stats.height,
                    fontSize: SPLASH_PANEL.stats.fontSize,
                    color: LOGIN_COLORS.secondaryText,
                  }}
                >
                  <span>{statsProgress}%</span>
                  {statsInfo.speed && (
                    <>
                      <span>·</span>
                      <span>{statsInfo.speed}</span>
                    </>
                  )}
                  {statsInfo.downloaded && statsInfo.total && (
                    <>
                      <span>·</span>
                      <span>
                        {statsInfo.downloaded} / {statsInfo.total}
                      </span>
                    </>
                  )}
                </div>
              </>
            )}

            {dbCleanupProgress && (
              <>
                <div
                  role="progressbar"
                  aria-label={t('splash.databaseCleanup.progressLabel')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={dbCleanupPercent}
                  data-testid="database-cleanup-progress-track"
                  className="absolute overflow-hidden"
                  style={{
                    left: SPLASH_PANEL.progress.x,
                    top: SPLASH_PANEL.databaseCleanup.progressY,
                    width: SPLASH_PANEL.progress.width,
                    height: SPLASH_PANEL.progress.height,
                    borderRadius: SPLASH_PANEL.progress.radius,
                    background: LOGIN_COLORS.splashProgressTrack,
                  }}
                >
                  <div
                    data-testid="database-cleanup-progress-fill"
                    className="h-full transition-[width] duration-300 motion-reduce:transition-none"
                    style={{
                      width: `${dbCleanupPercent}%`,
                      borderRadius: SPLASH_PANEL.progress.radius,
                      background: LOGIN_COLORS.splashProgressFill,
                    }}
                  />
                </div>
                <div
                  data-testid="database-cleanup-time"
                  className="absolute flex items-center justify-center"
                  style={{
                    left: SPLASH_PANEL.stats.x,
                    top: SPLASH_PANEL.databaseCleanup.statsY,
                    width: SPLASH_PANEL.stats.width,
                    height: SPLASH_PANEL.stats.height,
                    fontSize: SPLASH_PANEL.stats.fontSize,
                    color: LOGIN_COLORS.secondaryText,
                  }}
                >
                  {dbCleanupProgress.phase === 'finalizing'
                    ? t('splash.databaseCleanup.elapsedFinalizing', {
                        elapsed: formatDbCleanupDuration(dbCleanupElapsedMs),
                      })
                    : t('splash.databaseCleanup.elapsedAndRemaining', {
                        elapsed: formatDbCleanupDuration(dbCleanupElapsedMs),
                        remaining: formatDbCleanupDuration(dbCleanupRemainingMs),
                      })}
                </div>
                <LoginTextLink
                  testId="database-cleanup-cancel"
                  top={SPLASH_PANEL.databaseCleanup.actionY}
                  height={SPLASH_PANEL.databaseCleanup.actionHeight}
                  disabled={!dbCleanupProgress.cancellable || dbCleanupCancelPending}
                  onClick={requestDbCleanupCancel}
                >
                  {dbCleanupProgress.phase === 'cancelling' || dbCleanupCancelPending
                    ? t('splash.databaseCleanup.cancellingAction')
                    : dbCleanupProgress.phase === 'finalizing'
                      ? t('splash.databaseCleanup.finalizingAction')
                      : t('splash.databaseCleanup.cancelAction')}
                </LoginTextLink>
                <div
                  data-testid="database-cleanup-safety-hint"
                  className="absolute flex items-center justify-center text-center"
                  style={{
                    left: SPLASH_PANEL.databaseCleanup.hint.x,
                    top: SPLASH_PANEL.databaseCleanup.hint.y,
                    width: SPLASH_PANEL.databaseCleanup.hint.width,
                    height: SPLASH_PANEL.databaseCleanup.hint.height,
                    fontSize: SPLASH_PANEL.databaseCleanup.hint.fontSize,
                    lineHeight: `${SPLASH_PANEL.databaseCleanup.hint.lineHeight}px`,
                    color: LOGIN_COLORS.secondaryText,
                  }}
                >
                  {dbCleanupProgress.phase === 'finalizing'
                    ? t('splash.databaseCleanup.finalizingHint')
                    : dbCleanupProgress.phase === 'cancelling'
                      ? t('splash.databaseCleanup.cancellingHint')
                      : t('splash.databaseCleanup.cancelHint')}
                </div>
              </>
            )}

            {/* failed(379:655):主按钮「重试」540×80@70,300 → checkEnvironment
                (useSplash onTipsClick 现网动作,零删改) */}
            {isEnvFailed && (
              <LoginPrimaryButton testId="splash-retry-button" onClick={onTipsClick}>
                {t('splash.envFailed.retry')}
              </LoginPrimaryButton>
            )}

            {/* 三失败弹窗统一面板化:CTA 文案/action 语义沿现网(v6.12/v6.14)。
                manifest/download = 重试类动作;spawn =「前往下载」,禁 retry。 */}
            {dialogKind === 'manifest' && (
              <LoginPrimaryButton testId="splash-manifest-failed-cta" onClick={onRetryManifest}>
                {t('splash.manifestFailed.confirm')}
              </LoginPrimaryButton>
            )}
            {dialogKind === 'download' && (
              <LoginPrimaryButton testId="splash-download-failed-cta" onClick={onRetryDownload}>
                {t('splash.downloadFailed.confirm')}
              </LoginPrimaryButton>
            )}
            {dialogKind === 'spawn' && (
              <LoginPrimaryButton testId="splash-spawn-failed-cta" onClick={onSpawnFailedDownload}>
                {t('splash.spawnFailed.confirm')}
              </LoginPrimaryButton>
            )}
          </LoginPanel>
        </div>
      </div>
    </div>
  );
}
