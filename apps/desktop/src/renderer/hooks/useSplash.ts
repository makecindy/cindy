import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useEnvCheck } from '@/contexts/EnvCheckContext';
import { useAuth } from '@/contexts/AuthContext';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';

// 运行期端点清单(dev/packaged 都在启动阻断后有真值,烘焙兜底已退役)
const websiteUrl = () => window.electronAPI.clientEndpoints.websiteUrl;

/* ── Types ── */

export type SplashPhase =
  | 'init'
  | 'splash_checking_update' // Phase 1: checking manifest for hot-update
  | 'splash_updating' // Phase 1: downloading app update
  | 'splash_update_done' // Phase 1: update ready, restarting
  | 'splash_manifest_failed' // Phase 1: manifest fetch failed
  | 'splash_download_failed' // Phase 1: hotfix 下载失败/校验失败，需要用户重试
  | 'splash_spawn_failed' // Phase 1: updater spawn 失败（EACCES 等）
  | 'splash_checking' // Phase 2: checking CCD binary
  | 'splash_downloading' // Phase 2: downloading CCD binary
  | 'splash_passed' // All checks done
  | 'splash_failed' // CCD check failed
  | 'fading_out'
  | 'splash_done'
  | 'splash_skipped';

interface TipsInfo {
  tipsText: string | null;
  tipsClickable: boolean;
  tipsDestructive: boolean;
}

/* ── Splash phase fixture(dev-only 状态遍历,implementation-plan Step 0 WHAT4)── */

/**
 * `VITE_SPLASH_PHASE_FIXTURE` 的合法值域(附录 A splash 行冻结):
 * 前六值 = Splash 可见态;后三值 = 三失败弹窗(useSplash 真实 phase 名)。
 */
export const SPLASH_PHASE_FIXTURE_VALUES = Object.freeze([
  'checking_update',
  'updating',
  'update_done',
  'checking',
  'downloading',
  'failed',
  'manifest_failed',
  'download_failed',
  'spawn_failed',
] as const);
export type SplashPhaseFixtureValue = (typeof SPLASH_PHASE_FIXTURE_VALUES)[number];

/** fixture 值 → useSplash 真实 SplashPhase 映射(消费侧 PR2b 接线)。 */
export function splashPhaseForFixture(value: SplashPhaseFixtureValue): SplashPhase {
  return value === 'failed' ? 'splash_failed' : (`splash_${value}` as SplashPhase);
}

/**
 * 读取 splash phase fixture(dev-only 状态遍历入口)。
 *
 * guard 写死为 `env.DEV && env.VITE_SPLASH_PHASE_FIXTURE`:VITE_* 值会被生产
 * 构建烘焙进 bundle,**必须 DEV 短路**——PROD 下无论 env 值如何一律返回 null
 * (production-mode 断言见 useSplashFixture.test.ts)。非法值同样返回 null
 * (fixture 只认冻结值域,不做模糊匹配)。
 */
export function readSplashPhaseFixture(
  env: { DEV?: boolean; VITE_SPLASH_PHASE_FIXTURE?: unknown } = import.meta.env,
): SplashPhaseFixtureValue | null {
  if (!env.DEV) return null;
  const raw =
    typeof env.VITE_SPLASH_PHASE_FIXTURE === 'string'
      ? env.VITE_SPLASH_PHASE_FIXTURE.trim()
      : '';
  if (!raw) return null;
  return (SPLASH_PHASE_FIXTURE_VALUES as readonly string[]).includes(raw)
    ? (raw as SplashPhaseFixtureValue)
    : null;
}

// 2026-07-19 用户拍板:1500 → 3000,splash 立绘一闪而过看不清,最短停留延长到 3s
// (淡出仍需"加载完成 && 满足地板时长"双条件,慢加载时不叠加额外等待)。
const MIN_DISPLAY_MS = 3000;
const FADE_FALLBACK_MS = 500;
// splash_update_done 阶段先让 "更新完成，等待自动重启..." 这段提示文案显示 1.5s，
// 再自动触发 relaunch，避免下载条刚到 100% 用户还没看清就直接整个窗口黑掉。
const AUTO_RELAUNCH_DELAY_MS = 1_500;

export function useSplash() {
  const { t } = useTranslation();
  const {
    status: envStatus,
    downloadProgress,
    downloadInfo,
    updateVersion,
    step,
    totalSteps,
    resetSignal,
    checkEnvironment,
  } = useEnvCheck();
  const { isInitializing: authInitializing } = useAuth();
  const { coverHeld } = useAppShellCover();
  const { errorCode: updateErrorCode } = useUpdateStatus();

  const [phase, setPhase] = useState<SplashPhase>('init');
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);

  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minTimeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Effect 1: minimum display timer ──
  useEffect(() => {
    minTimeTimerRef.current = setTimeout(() => setMinTimeElapsed(true), MIN_DISPLAY_MS);
    return () => {
      if (minTimeTimerRef.current !== null) {
        clearTimeout(minTimeTimerRef.current);
        minTimeTimerRef.current = null;
      }
    };
  }, []);

  // ── Effect 2: envStatus drives phase ──
  useEffect(() => {
    switch (envStatus) {
      case 'checking_update':
        setPhase('splash_checking_update');
        break;
      case 'updating':
        setPhase('splash_updating');
        break;
      case 'update_done':
        setPhase('splash_update_done');
        break;
      case 'manifest_failed':
        setPhase('splash_manifest_failed');
        break;
      case 'download_failed':
        setPhase('splash_download_failed');
        break;
      case 'checking':
        setPhase('splash_checking');
        break;
      case 'downloading':
        setPhase('splash_downloading');
        break;
      case 'passed':
        setPhase('splash_passed');
        break;
      case 'failed':
        setPhase('splash_failed');
        break;
    }
  }, [envStatus]);

  // ── Effect 2b: updater spawn failure overrides the relaunch dialog ──
  useEffect(() => {
    if (updateErrorCode === 'updater_spawn_failed' && phase === 'splash_update_done') {
      setPhase('splash_spawn_failed');
    }
  }, [updateErrorCode, phase]);

  // ── Effect 3: fade-out trigger ──
  // coverHeld:已登录但 LocalDbGate 还不能画主界面。splash 必须继续盖住
  // (DESIGN.md §10),否则 3s 地板一过会露出默认白底。
  useEffect(() => {
    if (phase === 'splash_passed' && minTimeElapsed && !authInitializing && !coverHeld) {
      setPhase('fading_out');
    }
  }, [phase, minTimeElapsed, authInitializing, coverHeld]);

  // ── Effect 4: fading_out fallback ──
  useEffect(() => {
    if (phase !== 'fading_out') return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delay = reducedMotion ? 10 : FADE_FALLBACK_MS;

    fallbackTimerRef.current = setTimeout(() => {
      setPhase('splash_done');
    }, delay);

    return () => {
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [phase]);

  // ── Tips derivation ──
  const tips: TipsInfo = useMemo<TipsInfo>(() => {
    switch (phase) {
      case 'splash_checking_update':
        return {
          tipsText: t('splash.tips.checkingUpdate'),
          tipsClickable: false,
          tipsDestructive: false,
        };
      case 'splash_updating':
        return {
          tipsText: t('splash.tips.updating'),
          tipsClickable: false,
          tipsDestructive: false,
        };
      case 'splash_update_done':
        return {
          tipsText: t('splash.tips.updateDone'),
          tipsClickable: false,
          tipsDestructive: false,
        };
      case 'splash_manifest_failed':
        return { tipsText: null, tipsClickable: false, tipsDestructive: false }; // Dialog takes over
      case 'splash_download_failed':
        return { tipsText: null, tipsClickable: false, tipsDestructive: false }; // Dialog takes over
      case 'splash_spawn_failed':
        return { tipsText: null, tipsClickable: false, tipsDestructive: false }; // Dialog takes over
      case 'splash_checking':
        return {
          tipsText: t('splash.tips.checkingEnv'),
          tipsClickable: false,
          tipsDestructive: false,
        };
      case 'splash_downloading': {
        // D 场景（两个 vendor 都需要下载）显示 (x/2) 进度标签；B/C 场景维持单文案。
        const suffix = step && totalSteps ? `(${step}/${totalSteps})` : '';
        return {
          tipsText: `${t('splash.tips.waking')}${suffix}`,
          tipsClickable: false,
          tipsDestructive: false,
        };
      }
      case 'splash_passed':
      case 'fading_out':
        return { tipsText: t('splash.tips.waking'), tipsClickable: false, tipsDestructive: false };
      case 'splash_failed':
        return { tipsText: t('splash.tips.envFailed'), tipsClickable: true, tipsDestructive: true };
      default:
        return { tipsText: null, tipsClickable: false, tipsDestructive: false };
    }
  }, [phase, step, totalSteps, t]);

  // ── Dialogs ──
  // splash_update_done 不再用弹窗;改为先展示 "更新完成，等待自动重启..." tip,
  // AUTO_RELAUNCH_DELAY_MS 后由下面的 Effect 5 自动 relaunch。
  const showManifestFailedDialog = phase === 'splash_manifest_failed';
  const showDownloadFailedDialog = phase === 'splash_download_failed';
  const showSpawnFailedDialog = phase === 'splash_spawn_failed';

  const onRetryManifest = useCallback(() => {
    checkEnvironment();
  }, [checkEnvironment]);

  const onRetryDownload = useCallback(() => {
    checkEnvironment();
  }, [checkEnvironment]);

  // ── Effect 5: splash_update_done 自动 relaunch ──
  // 进入该 phase 表示补丁已下载就绪。短暂展示 "更新完成，等待自动重启..." 文案后
  // 自动触发 relaunch。用 ref 保证同一会话只触发一次;若期间 spawn 失败,Effect 2b
  // 会把 phase 切到 splash_spawn_failed,这里依然只是已经发过一次 IPC,由 spawn 失败
  // dialog 接管。
  // 重启时机同时守两条契约(2026-07-19 review 收口):挂载累计 ≥ MIN_DISPLAY_MS
  // (3s 地板对所有启动路径生效,热更路径不许提前销毁 renderer) 且 更新完成提示
  // 至少展示 AUTO_RELAUNCH_DELAY_MS——取两者剩余量的较大者作为延时。
  const mountedAtRef = useRef(Date.now());
  const autoRelaunchFiredRef = useRef(false);
  useEffect(() => {
    if (phase !== 'splash_update_done') {
      autoRelaunchFiredRef.current = false;
      return;
    }
    if (autoRelaunchFiredRef.current) return;

    const minDisplayRemaining = Math.max(0, MIN_DISPLAY_MS - (Date.now() - mountedAtRef.current));
    const relaunchDelay = Math.max(AUTO_RELAUNCH_DELAY_MS, minDisplayRemaining);
    const timer = setTimeout(() => {
      autoRelaunchFiredRef.current = true;
      const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      void window.electronAPI
        .autoRelaunchToUpdate(theme)
        .then((result) => {
          // Conditions may have changed since update-check-startup replied.
          // Re-enter the normal startup flow instead of leaving the user on a
          // permanent "waiting to restart" splash when main safely defers.
          if (!result.accepted) void checkEnvironment();
        })
        .catch(() => {
          // A successful relaunch normally destroys this renderer before the
          // invoke settles. If the process remains alive, retrying the startup
          // checks is the safest recovery from an IPC/handler failure.
          void checkEnvironment();
        });
    }, relaunchDelay);

    return () => clearTimeout(timer);
  }, [phase, checkEnvironment]);

  const onSpawnFailedDownload = useCallback(() => {
    window.open(websiteUrl(), '_blank');
  }, []);

  // ── Show progress bar during download phases ──
  const isDownloading = phase === 'splash_downloading' || phase === 'splash_updating';

  // ── Event handlers ──
  const onTipsClick = useCallback(() => {
    if (phase === 'splash_failed') {
      checkEnvironment();
    }
  }, [phase, checkEnvironment]);

  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (e.propertyName === 'opacity' && phase === 'fading_out') {
        setPhase('splash_done');
      }
    },
    [phase],
  );

  const skipSplash = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (minTimeTimerRef.current !== null) {
      clearTimeout(minTimeTimerRef.current);
      minTimeTimerRef.current = null;
    }
    setPhase('splash_skipped');
  }, []);

  return {
    phase,
    isDownloading,
    downloadProgress,
    downloadInfo,
    resetSignal,
    tipsText: tips.tipsText,
    tipsClickable: tips.tipsClickable,
    tipsDestructive: tips.tipsDestructive,
    showManifestFailedDialog,
    showDownloadFailedDialog,
    showSpawnFailedDialog,
    updateVersion,
    onRetryManifest,
    onRetryDownload,
    onSpawnFailedDownload,
    onTipsClick,
    onTransitionEnd,
    skipSplash,
  };
}
