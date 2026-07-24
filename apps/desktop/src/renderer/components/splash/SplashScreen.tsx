import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import {
  readSplashPhaseFixture,
  splashPhaseForFixture,
  useSplash,
  type SplashPhase,
} from '@/hooks/useSplash';
import { useEnvCheck } from '@/contexts/EnvCheckContext';
import { useLoginHandoff } from '@/contexts/LoginHandoffContext';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { desktopScale } from '@/components/login/loginScale';
import { useViewportSize } from '@/components/login/LoginStage';
import { LoginPanel, LoginPrimaryButton, LoginTitleBlock } from '@/components/login/LoginControls';
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
 * 同 desktopScale 缩放)承载全部 Splash 状态。
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
  step?: 1 | 2,
  totalSteps?: 2,
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
      // D 场景(两个 vendor 都需要下载)显示 (x/2) 进度标签;B/C 场景维持单文案。
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

export function SplashScreen() {
  const { t } = useTranslation();
  const splash = useSplash();
  const { step, totalSteps } = useEnvCheck();
  const handoff = useLoginHandoff();
  const { width, height } = useViewportSize();
  const { scale } = desktopScale(width, height);

  // dev fixture 只改显示 phase(附录 A splash 行;PROD 恒 null)。
  const fixture = readSplashPhaseFixture();
  const displayPhase: SplashPhase = fixture ? splashPhaseForFixture(fixture) : splash.phase;
  const realPhase = splash.phase;

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

  useEffect(() => {
    const root = document.documentElement;
    if (
      realPhase !== 'fading_out' &&
      realPhase !== 'splash_done' &&
      realPhase !== 'splash_skipped'
    ) {
      root.setAttribute('data-splash-active', '1');
    } else {
      root.removeAttribute('data-splash-active');
    }
    return () => {
      root.removeAttribute('data-splash-active');
    };
  }, [realPhase]);

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

  // dev fixture 激活时冻结停留:真实生命周期跑完也不退场,供状态遍历/视觉走查
  // (readSplashPhaseFixture 在 PROD 恒 null,本分支不可达)。
  if (!fixture && (realPhase === 'splash_done' || realPhase === 'splash_skipped')) return null;

  const isMac = window.electronAPI?.platform === 'darwin';

  const title = splashTitleFor(displayPhase, t, step, totalSteps);
  // 进度条仅更新下载态面板形态(updating/downloading);fixture 模式按显示 phase。
  const isDownloading = fixture
    ? displayPhase === 'splash_updating' || displayPhase === 'splash_downloading'
    : realIsDownloading;
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
  const showSpinner = dialogKind === null && !isEnvFailed;

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] overflow-hidden',
        realPhase === 'fading_out' && !fixture ? 'opacity-0' : 'opacity-100',
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
        {!isMac && (
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
        {/* 统一白面板:登录同款(680×440 r36 @570,1229,wave4 五帧同位) */}
        <div
          className="absolute"
          style={
            {
              left: LOGIN_GROUP.x,
              top: LOGIN_GROUP.yDefault,
              width: LOGIN_GROUP.width,
              height: LOGIN_GROUP.height,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties
          }
        >
          <LoginPanel testId="splash-panel">
            {title !== null && (
              <LoginTitleBlock
                title={title}
                subtitle={
                  dialogKind === 'manifest'
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
