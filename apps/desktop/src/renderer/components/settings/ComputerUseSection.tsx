/**
 * ComputerUseSection — Settings →「电脑使用 / Computer Use」面板。
 * ---------------------------------------------------------------------------
 * 电脑使用类能力的统一入口。当前承载「浏览器自动化」(cindy_browser MCP):
 *   - 启用开关 (复用 builtin plugin 系统, id='browser', 项目级 .claude/settings.json)
 *   - 本机浏览器探测状态 (maker.browser.status — 只探测不启动)
 *   - 未探测到时引导去 Chrome 官方下载页
 * 以及「直接操作电脑」能力 (cindy_computer MCP, machine-wide opt-in).
 *
 * 数据流 (规则 7: 先拉数据再渲染, 无 loading 闪屏):
 *   - mount → 并行拉 plugins.getState('browser', workingDir) (取 browser 开关态)
 *     + browser.status()。注意 browser 是 HOSTED_ELSEWHERE, 不在 plugins.list()
 *     里, 必须按 id 直接读单个状态, 否则 find() 永远 undefined。
 *   - 两者都到位后一次性渲染
 * 浏览器开关读写完全复用 builtin plugin IPC, 不新造持久化通道。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  Globe,
  MonitorCog,
  Download,
  LogIn,
  ExternalLink,
  RefreshCw,
  Smartphone,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import accessibilityPermissionIcon from '@/assets/system-settings/accessibility-icon.png';
import screenRecordingPermissionIcon from '@/assets/system-settings/screen-recording-icon.png';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createLogger } from '@/lib/logger';
import { BrowserBackendSubsection } from './BrowserBackendSubsection';
import type { BrowserBackendHealth } from '../../../shared/browserBackend';
import {
  androidDeviceLabel,
  androidStatusFallback,
  describeAndroidDeviceStatus,
  getAndroidConnectionGuideKind,
} from './androidStatusPresentation';
import {
  getComputerPermissionSwitchChecked,
  isComputerPermissionPreflightInconclusive,
  isComputerPermissionReady,
  shouldStartComputerPermissionGuide,
} from './computerPermissionFlow';

const log = createLogger('ComputerUseSection');

const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';
const CUA_GITHUB_URL = 'https://github.com/trycua/cua';
const ANDROID_PLUGIN_ID = 'android';
const BROWSER_PLUGIN_ID = 'browser';
const COMPUTER_PLUGIN_ID = 'computer';
const COMPUTER_PERMISSION_POLL_INTERVAL_MS = 1_500;
const COMPUTER_PERMISSION_POLL_TIMEOUT_MS = 300_000;
const MAC_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACTION_BUTTON_CLASS = cn(
  'flex items-center gap-1.5 shrink-0 h-7 px-3 rounded-full',
  'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]',
  'text-12 font-medium hover:bg-[var(--surface-chip)] transition-colors',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:opacity-50 disabled:pointer-events-none',
);
const ANDROID_AUTO_DEVICE_VALUE = '__auto__';

function browserBackendHealthFallback(
  active: 'external' | 'rsb-webview',
): BrowserBackendHealth {
  return {
    active,
    status: 'error',
    canRecover: active === 'rsb-webview',
    reason: 'status-failed',
  };
}

function androidSourceLabelKey(source: AndroidAdbPathSource | null | undefined): string {
  switch (source) {
    case 'custom':
      return 'settings.computerUse.android.adb.source.custom';
    case 'env':
      return 'settings.computerUse.android.adb.source.env';
    case 'prepared':
      return 'settings.computerUse.android.adb.source.prepared';
    case 'bundled':
      return 'settings.computerUse.android.adb.source.bundled';
    case 'sdk':
      return 'settings.computerUse.android.adb.source.sdk';
    case 'path':
      return 'settings.computerUse.android.adb.source.path';
    default:
      return 'settings.computerUse.android.adb.source.auto';
  }
}

function isComputerAccessibilityPermissionReady(status: ComputerDriverStatus | null): boolean {
  return status?.permissionState?.accessibility === 'granted';
}

function isComputerScreenRecordingPermissionReady(status: ComputerDriverStatus | null): boolean {
  const permissionState = status?.permissionState;
  // capturable 是 daemon 的 ScreenCaptureKit 实测,优先于 TCC 数据库记录(screenRecording):
  // driver 更新后的 stale grant 表现为「记录 granted / 实测 missing」,必须按未授权展示,
  // 让用户从徽章进系统设置重新授权;只有实测缺席(旧版 driver)才回退信记录。
  if (permissionState?.screenRecordingCapturable === 'granted') return true;
  if (permissionState?.screenRecordingCapturable === 'missing') return false;
  return permissionState?.screenRecording === 'granted';
}

function getComputerPermissionLogSummary(status: ComputerDriverStatus | null) {
  const permissionState = status?.permissionState;
  return {
    installed: status?.installed,
    daemonRunning: status?.daemonRunning,
    permissionStatus: permissionState?.status,
    accessibility: permissionState?.accessibility,
    screenRecording: permissionState?.screenRecording,
    screenRecordingCapturable: permissionState?.screenRecordingCapturable,
    source: permissionState?.source,
    reason: permissionState?.reason,
  };
}

interface ComputerUseSectionProps {
  /** Active session working dir — the project whose .claude/settings.json the
   *  browser enable toggle reads/writes. */
  workingDir?: string;
}

function ComputerPermissionRow({
  label,
  iconSrc,
  granted,
  pending,
  actionLabel,
  onAction,
}: {
  label: string;
  iconSrc: string;
  granted: boolean;
  pending: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onAction}
      disabled={pending}
      className={cn(
        'flex min-h-[64px] w-full min-w-0 items-center gap-3 rounded-xl px-3.5 py-3 text-left',
        'border border-solid border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
        'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
        'disabled:cursor-default disabled:hover:bg-[var(--settings-input-bg)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      <img className="size-8 shrink-0 object-contain grayscale opacity-70" src={iconSrc} alt="" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--settings-section-title)]">
        {label}
      </span>
      <span
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12 font-medium',
          pending
            ? 'border border-dashed border-[var(--settings-input-border)] bg-[var(--surface-chip)] text-[var(--settings-section-desc)]'
            : granted
              ? 'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] text-[var(--settings-section-title)]'
              : 'border border-[var(--surface-chip)] bg-[var(--surface-chip)] text-[var(--settings-section-title)]',
        )}
      >
        {pending ? <Spinner size={12} /> : null}
        <span>{actionLabel}</span>
        {granted && !pending ? <Check size={13} strokeWidth={2.3} aria-hidden="true" /> : null}
      </span>
    </button>
  );
}

export function ComputerUseSection({
  workingDir,
}: ComputerUseSectionProps) {
  const { t } = useTranslation();
  // null = not loaded yet (blank, no flash). After load, all resolve.
  const [browserEnabled, setBrowserEnabled] = useState<boolean | null>(null);
  const [androidEnabled, setAndroidEnabled] = useState<boolean | null>(null);
  const [computerEnabled, setComputerEnabled] = useState<boolean | null>(null);
  const [availability, setAvailability] = useState<BrowserAvailability | null>(null);
  const [androidStatus, setAndroidStatus] = useState<AndroidStatusSummary | null>(null);
  const [androidConfig, setAndroidConfig] = useState<AndroidAutomationConfigState | null>(null);
  const [androidAdbPathDraft, setAndroidAdbPathDraft] = useState('');
  const [androidAdbPathEdited, setAndroidAdbPathEdited] = useState(false);
  const [computerStatus, setComputerStatus] = useState<ComputerDriverStatus | null>(null);
  // 安静的 driver 更新入口:只在打开本设置面板时查一次,查不到 / 无更新都不渲染。
  const [driverUpdate, setDriverUpdate] = useState<ComputerDriverUpdateCheck | null>(null);
  const [driverUpdatePending, setDriverUpdatePending] = useState(false);
  // main 侧采样广播的下载进度;null = 未开始/已结束(显示通用「更新中…」)。
  const [driverUpdateProgress, setDriverUpdateProgress] =
    useState<ComputerDriverUpdateProgress | null>(null);
  const [togglePending, setTogglePending] = useState(false);
  const [androidTogglePending, setAndroidTogglePending] = useState(false);
  const [androidStatusPending, setAndroidStatusPending] = useState(false);
  const [androidDevicePending, setAndroidDevicePending] = useState(false);
  const [androidAdbPathPending, setAndroidAdbPathPending] = useState(false);
  const [androidPreparePending, setAndroidPreparePending] = useState(false);
  const [computerTogglePending, setComputerTogglePending] = useState(false);
  const [computerInstallPending, setComputerInstallPending] = useState(false);
  const [computerPermissionPending, setComputerPermissionPending] = useState(false);
  const [computerPermissionRecheckPending, setComputerPermissionRecheckPending] = useState(false);
  const [computerDetailsOpen, setComputerDetailsOpen] = useState(false);
  const computerUseSectionMountedRef = useRef(true);
  const computerTogglePendingRef = useRef(false);
  const computerPermissionPendingRef = useRef(false);
  const computerPermissionPollTimerRef = useRef<number | null>(null);
  // Native grant remains cancellable while the user is moving between Settings panes.
  const computerPermissionGrantInProgressRef = useRef(false);
  const computerEnableIntentRef = useRef(false);
  // 授权流程代际号:引导弹窗「取消」时 +1。grant/preflight 的 await 期间用户可能
  // 已取消,continuation 必须校验代际,否则被取消的流程仍会打开系统设置抢焦点。
  const computerPermissionFlowSeqRef = useRef(0);
  const computerPermissionCompletionInFlightRef = useRef(false);
  const resetComputerPermissionFlow = useCallback(() => {
    computerPermissionGrantInProgressRef.current = false;
  }, []);

  const cancelNativeComputerPermissionGrant = useCallback(() => {
    void window.electronAPI.maker.computer.cancelPermissionGrant().catch((err) => {
      log.debug('computer.cancelPermissionGrant failed (ignored)', err);
    });
  }, []);

  useEffect(() => {
    computerPermissionPendingRef.current = computerPermissionPending;
  }, [computerPermissionPending]);

  // Leaving Settings / Plugin detail invalidates the whole enable attempt,
  // including install and fresh-preflight awaits before the guide is visible.
  useEffect(() => {
    computerUseSectionMountedRef.current = true;
    return () => {
      computerUseSectionMountedRef.current = false;
      computerPermissionFlowSeqRef.current += 1;
      computerEnableIntentRef.current = false;
      computerPermissionCompletionInFlightRef.current = false;
      const hadActivePermissionFlow = (
        computerTogglePendingRef.current
        || computerPermissionPendingRef.current
        || computerPermissionGrantInProgressRef.current
      );
      resetComputerPermissionFlow();
      if (hadActivePermissionFlow) {
        cancelNativeComputerPermissionGrant();
      }
      computerTogglePendingRef.current = false;
    };
  }, [cancelNativeComputerPermissionGrant, resetComputerPermissionFlow]);

  // 引导弹窗的取消:终止当前的一次性授权请求。
  const handleCancelPermissionGuide = useCallback(() => {
    computerPermissionFlowSeqRef.current += 1;
    setComputerPermissionPending(false);
    computerEnableIntentRef.current = false;
    computerPermissionCompletionInFlightRef.current = false;
    resetComputerPermissionFlow();
    // 收割 main 侧在途的 grant 子进程:取消必须让原生授权流程真正停下,
    // 而不是只藏起引导弹窗(否则 15s 复用窗口内下次点击还会接上旧流程)。
    cancelNativeComputerPermissionGrant();
  }, [cancelNativeComputerPermissionGrant, resetComputerPermissionFlow]);

  const openComputerPermissionSettings = useCallback(
    async (url: string, reason: string): Promise<boolean> => {
      log.debug('opening computer permission settings', { reason, url });
      const result = await window.electronAPI.openExternal(url);
      if (!result.success) {
        toast.error(t('settings.computerUse.directControl.toast.openPermissionSettingsFailed'));
        return false;
      }
      return true;
    },
    [t],
  );

  // Native macOS onboarding observes the System Settings checkbox in main.
  // Feed those changes back into this panel so the two permission steps can
  // advance without asking the user to press Recheck.
  useEffect(() => {
    return window.electronAPI.maker.computer.onPermissionGuideStatusChanged((status) => {
      setComputerStatus(status);
      if (!computerPermissionPendingRef.current) return;
      if (!status.installed || !isComputerPermissionReady(status)) {
        return;
      }

      if (computerPermissionCompletionInFlightRef.current) return;
      computerPermissionCompletionInFlightRef.current = true;
      setComputerPermissionPending(false);
      resetComputerPermissionFlow();
      cancelNativeComputerPermissionGrant();
      if (computerEnableIntentRef.current || computerEnabled) {
        void window.electronAPI.maker.plugins.setEnabled(COMPUTER_PLUGIN_ID, true)
          .then((result) => {
            setComputerEnabled(true);
            if (result.codexMcpRefreshed === false) {
              toast.warning(t('settings.computerUse.codexRefreshDeferred'));
              return;
            }
            toast.success(t('settings.computerUse.directControl.toast.enabled'));
          })
          .catch((err) => {
            log.warn('plugins.setEnabled(computer) after native guide failed', err);
            toast.error(t('settings.computerUse.directControl.toast.toggleFailed'));
          })
          .finally(() => {
            computerPermissionCompletionInFlightRef.current = false;
          });
      } else {
        computerPermissionCompletionInFlightRef.current = false;
      }
    });
  }, [
    cancelNativeComputerPermissionGrant,
    computerEnabled,
    resetComputerPermissionFlow,
    t,
  ]);

  const refreshComputerPermissionStatus = useCallback(async (
    reason: string,
    options?: { fresh?: boolean; bypassCache?: boolean; passiveOnly?: boolean },
  ) => {
    // fresh:重启 daemon 后现场实测 —— 「辅助功能被撤销」只有重启 daemon 才读得到。
    // 仅在 driver 替换或已进入授权流程后使用；页面进入/Recheck 走 passiveOnly，
    // 开启开关会重新验证可变的 macOS TCC 状态，不能消费可能已过期的页面快照。
    const status = await window.electronAPI.maker.computer.status({
      forcePermissionProbe: true,
      ...(options?.fresh ? { freshPermissionProbe: true } : {}),
      ...(options?.bypassCache ? { bypassPermissionProbeCache: true } : {}),
      ...(options?.passiveOnly ? { passivePermissionProbeOnly: true } : {}),
    });
    log.debug('computer permission status refreshed', {
      flowReason: reason,
      fresh: options?.fresh === true,
      bypassCache: options?.bypassCache === true,
      passiveOnly: options?.passiveOnly === true,
      ...getComputerPermissionLogSummary(status),
    });
    setComputerStatus(status);
    return status;
  }, []);

  const requestComputerPermissionGrant = useCallback(async (
    reason: string,
    openedPaneUrl?: string,
  ) => {
    computerPermissionGrantInProgressRef.current = true;
    log.debug('computer permission grant requested', { reason });
    try {
      const result = await window.electronAPI.maker.computer.grantPermissions({
        // The native coach presents the drag/enable steps beside System Settings.
        // Permission status itself advances only after explicit user actions.
        showGuide: window.electronAPI.platform === 'darwin',
        ...(openedPaneUrl ? { openedPaneUrl } : {}),
      });
      log.debug('computer permission grant result', {
        flowReason: reason,
        ok: result.ok,
        ...getComputerPermissionLogSummary(result.status),
      });
      setComputerStatus(result.status);
      return result.status;
    } finally {
      computerPermissionGrantInProgressRef.current = false;
    }
  }, []);

  // 独立引导浮窗里的关闭按钮由 main 广播回来。
  useEffect(() => {
    return window.electronAPI.maker.computer.onPermissionGuideCancelled(
      handleCancelPermissionGuide,
    );
  }, [handleCancelPermissionGuide]);
  // 更新检查每次打开面板只跑一次;status 对象在 install/授权流程里会反复刷新,
  // 用 ref 防止重复触发网络请求。
  const driverUpdateCheckedRef = useRef(false);

  // Phase 5: agent automation 实际驱动哪个浏览器 — 'external' 时这张卡片底下
  // 「Chrome 探测 / 下载 Chrome / 打开 Agent 专用浏览器」整套 UI 才有意义;
  // 'rsb-webview' 时全部隐藏(内置 Electron Chromium 永远可用,不需要装 Chrome
  // 也没有"专用 profile 登录"概念)。null = 还没拉到,跟其它 state 一样不渲染
  // 任何 backend-dependent UI(规则 7: 不要 loading 闪屏)。
  const [browserBackendKind, setBrowserBackendKind] = useState<
    'external' | 'rsb-webview' | null
  >(null);
  const [browserBackendPending, setBrowserBackendPending] = useState(false);
  const [browserBackendRecovering, setBrowserBackendRecovering] = useState(false);
  const [browserBackendHealth, setBrowserBackendHealth] = useState<BrowserBackendHealth | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAndroidStatus(null);
    setAndroidStatusPending(true);
    void window.electronAPI.maker.android.getConfig()
      .then((config) => {
        if (!cancelled) {
          setAndroidConfig(config);
        }
      })
      .catch((err) => {
        log.warn('android.getConfig failed', err);
      });
    void window.electronAPI.maker.plugins.getState(ANDROID_PLUGIN_ID)
      .then((state) => {
        if (!cancelled) {
          setAndroidEnabled(state.effectiveEnabled);
          if (state.effectiveEnabled) {
            setAndroidPreparePending(true);
            void window.electronAPI.maker.android.prepareAdb()
              .then(() => {
                if (!cancelled) {
                  return window.electronAPI.maker.android.status()
                    .then((status) => {
                      if (!cancelled) setAndroidStatus(status);
                    });
                }
                return undefined;
              })
              .catch((err) => {
                log.warn('android.prepareAdb failed', err);
              })
              .finally(() => {
                if (!cancelled) setAndroidPreparePending(false);
              });
          }
        }
      })
      .catch((err) => {
        log.warn('plugins.getState(android) failed', err);
        if (!cancelled) {
          setAndroidEnabled(false);
        }
      });
    void window.electronAPI.maker.android.status()
      .then((status) => {
        if (!cancelled) {
          setAndroidStatus(status);
        }
      })
      .catch((err) => {
        log.warn('android.status failed', err);
        if (!cancelled) {
          setAndroidStatus(androidStatusFallback(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAndroidStatusPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (androidAdbPathEdited) return;
    const overridePath = androidConfig?.value.adbPathOverride?.trim();
    setAndroidAdbPathDraft(
      overridePath || androidStatus?.adb_path || androidStatus?.adb_preparation?.path || '',
    );
  }, [
    androidAdbPathEdited,
    androidConfig?.value.adbPathOverride,
    androidStatus?.adb_path,
    androidStatus?.adb_preparation?.path,
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let backendHealthError: unknown;
      const [browserState, computerState, avail, computer, backendState, backendHealth] = await Promise.all([
        // `browser` is hidden from plugins.list() (HOSTED_ELSEWHERE), so read its
        // enable state directly by id — list().find() would always be undefined
        // and the toggle would wrongly reset to enabled on every remount.
        window.electronAPI.maker.plugins.getState(BROWSER_PLUGIN_ID, workingDir).catch((err) => {
          log.warn('plugins.getState(browser) failed', err);
          return null;
        }),
        window.electronAPI.maker.plugins.getState(COMPUTER_PLUGIN_ID).catch((err) => {
          log.warn('plugins.getState(computer) failed', err);
          return null;
        }),
        window.electronAPI.maker.browser.status().catch((err) => {
          log.warn('browser.status failed', err);
          return { detected: false, browserKind: null, executablePath: null } as BrowserAvailability;
        }),
        // Entering Automation is the shared refresh boundary for every card.
        // CuaDriver 0.12.2+ reports its own TCC state without opening the legacy
        // grant flow. Bypass our prior-result cache so reopening this page
        // reflects the latest settings without requiring a manual Recheck.
        window.electronAPI.maker.computer.status({
          forcePermissionProbe: true,
          bypassPermissionProbeCache: true,
          passivePermissionProbeOnly: true,
        }).catch((err) => {
          log.warn('computer.status failed', err);
          return {
            installed: false,
            executablePath: null,
            version: null,
            daemonRunning: false,
            installCommand:
              'cua-driver install instructions: https://cua.ai/docs/cua-driver',
            docsUrl: 'https://cua.ai/docs/cua-driver',
            error: String(err),
          } as ComputerDriverStatus;
        }),
        window.electronAPI.browserBackend?.getState?.().catch((err) => {
          log.warn('browserBackend.getState failed', err);
          return null;
        }) ?? Promise.resolve(null),
        window.electronAPI.browserBackend?.getHealth?.().catch((err) => {
          backendHealthError = err;
          log.warn('browserBackend.getHealth failed', err);
          return null;
        }) ?? Promise.resolve(null),
      ]);
      if (cancelled) return;
      // Browser keeps the builtin default-on behavior. Direct computer control
      // reflects the persisted machine-wide opt-in; readiness is shown separately.
      setBrowserEnabled(browserState ? browserState.effectiveEnabled : true);
      const effectiveComputerEnabled = computerState ? computerState.effectiveEnabled : false;
      setComputerEnabled(effectiveComputerEnabled);
      setAvailability(avail);
      setComputerStatus(computer);
      log.debug('computer initial status loaded', getComputerPermissionLogSummary(computer));
      // Phase 5: backend kind 拉不到时(老版本 preload / IPC 缺失)安全 fallback
      // 到 'external',保持现有 Chrome 探测 / 登录 UI 可见 — 总比因为 IPC 失败
      // 让卡片整张瘫成内置态强。
      const activeBackend = backendState?.active ?? 'external';
      setBrowserBackendKind(activeBackend);
      setBrowserBackendHealth(
        backendHealth?.active === activeBackend
          ? backendHealth
          : backendHealthError
            ? browserBackendHealthFallback(activeBackend)
            : null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [workingDir]);

  // Phase 5: 用户点 segmented chip 切换 backend。乐观更新 + IPC 失败回滚。
  const handleSelectBackend = useCallback(
    async (kind: 'external' | 'rsb-webview') => {
      if (browserBackendPending) return;
      if (browserBackendKind === kind) return;
      const prev = browserBackendKind;
      setBrowserBackendKind(kind);
      setBrowserBackendPending(true);
      try {
        const res = await window.electronAPI.browserBackend.setKind(kind);
        // main 返回 active 是权威 — 万一同一次 swap 失败 router 拒了我们 fallback
        // 到 main 端的真实值。
        setBrowserBackendKind(res.active);
        try {
          setBrowserBackendHealth(await window.electronAPI.browserBackend.getHealth());
        } catch (healthErr) {
          log.warn('browserBackend.getHealth after setKind failed', healthErr);
          setBrowserBackendHealth(browserBackendHealthFallback(res.active));
        }
      } catch (err) {
        log.error('browserBackend.setKind failed', err);
        setBrowserBackendKind(prev);
        toast.error(t('settings.computerUse.browserBackend.toggleFailed'));
      } finally {
        setBrowserBackendPending(false);
      }
    },
    [browserBackendKind, browserBackendPending, t],
  );

  const handleRecoverBrowserBackend = useCallback(async () => {
    if (browserBackendPending || browserBackendRecovering) return;
    setBrowserBackendRecovering(true);
    try {
      const result = await window.electronAPI.browserBackend.recover();
      setBrowserBackendKind(result.health.active);
      setBrowserBackendHealth(result.health);
      if (result.ok) {
        toast.success(t('settings.computerUse.browserBackend.health.recovered'));
      } else if (result.health.status === 'error') {
        toast.error(t('settings.computerUse.browserBackend.health.recoverFailed'));
      }
    } catch (err) {
      log.error('browserBackend.recover failed', err);
      setBrowserBackendHealth(browserBackendHealthFallback('rsb-webview'));
      toast.error(t('settings.computerUse.browserBackend.health.recoverFailed'));
    } finally {
      setBrowserBackendRecovering(false);
    }
  }, [browserBackendPending, browserBackendRecovering, t]);

  // driver 已安装时安静地查一次是否有新版本。失败或无更新都不渲染任何 UI,
  // 不弹 toast、不做启动检查、不后台轮询 —— 更新入口只是设置里的一个可选项。
  // 更新期间订阅 main 广播的下载进度;phase='done' 或组件卸载时清空。
  useEffect(() => {
    if (!driverUpdatePending) {
      setDriverUpdateProgress(null);
      return;
    }
    const unsubscribe = window.electronAPI.maker.computer.onUpdateProgress((progress) => {
      setDriverUpdateProgress(progress.phase === 'done' ? null : progress);
    });
    return unsubscribe;
  }, [driverUpdatePending]);

  // 等待 main 侧更新安装完成并刷新本地展示。更新的 in-flight 托管在 main:
  // 面板关闭它照常跑完;面板重开后本函数 join 同一个安装 Promise。
  // resume 路径传 joinOnly:若 main 侧安装在 IPC 到达前恰好完成,只读状态
  // 刷新,绝不误起一次新安装(用户没点按钮不该有安装发生)。
  const joinDriverUpdate = useCallback(async (joinOnly: boolean) => {
    try {
      const result = await window.electronAPI.maker.computer.updateDriver(
        joinOnly ? { joinOnly: true } : undefined,
      );
      let nextStatus = result.status;
      if (nextStatus.installed && nextStatus.permissionState?.platform === 'macos') {
        // A driver replacement may receive a new TCC identity. Re-probe the
        // installed binary before allowing the capability to look usable.
        nextStatus = await refreshComputerPermissionStatus('driver-update', { fresh: true });
      }
      setComputerStatus(nextStatus);
      if (!isComputerPermissionReady(nextStatus)) {
        setComputerPermissionPending(false);
        setComputerEnabled(false);
        if (computerEnabled) {
          await window.electronAPI.maker.plugins.setEnabled(COMPUTER_PLUGIN_ID, false)
            .catch((error) => log.warn('disabling computer after permission reset failed', error));
        }
        toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
      }
      setDriverUpdate(null);
      if (isComputerPermissionReady(nextStatus)) {
        toast.success(t('settings.computerUse.directControl.update.toast.success'));
      }
    } catch (err) {
      log.warn('computer driver update failed', err);
      toast.error(t('settings.computerUse.directControl.update.toast.failed'));
      // 预检发现缓存目标已失效时 main 已把 updateAvailable 置 false;同步清掉
      // 渲染层残留入口,避免失败 toast 后按钮仍显示并可重复点。
      try {
        const latest = await window.electronAPI.maker.computer.checkUpdate();
        setDriverUpdate(latest.updateAvailable ? latest : null);
      } catch (refreshErr) {
        log.warn('computer.checkUpdate after failed update failed', refreshErr);
      }
    } finally {
      setDriverUpdatePending(false);
    }
  }, [computerEnabled, refreshComputerPermissionStatus, t]);

  useEffect(() => {
    if (!computerStatus?.installed || driverUpdateCheckedRef.current) return;
    driverUpdateCheckedRef.current = true;
    let cancelled = false;
    void window.electronAPI.maker.computer
      .checkUpdate()
      .then((result) => {
        if (cancelled) return;
        // main 有缓存时这里立即返回(第二次打开面板不等网络),后台自动刷新。
        if (result.updateAvailable) setDriverUpdate(result);
        if (result.updating) {
          // 上次面板关闭前发起的更新还在 main 侧跑:恢复「更新中」态并以
          // join-only 语义重挂结果(安装恰好已完成时只读状态,不起新安装)。
          setDriverUpdatePending(true);
          void joinDriverUpdate(true);
        }
      })
      .catch((err) => {
        log.warn('computer.checkUpdate failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [computerStatus?.installed, joinDriverUpdate]);

  const handleUpdateDriver = useCallback(() => {
    if (driverUpdatePending) return;
    setDriverUpdatePending(true);
    void joinDriverUpdate(false);
  }, [driverUpdatePending, joinDriverUpdate]);

  const persistComputerEnabled = useCallback(async (next: boolean) => {
    const result = await window.electronAPI.maker.plugins.setEnabled(COMPUTER_PLUGIN_ID, next);
    setComputerEnabled(next);
    if (result.codexMcpRefreshed === false) {
      toast.warning(t('settings.computerUse.codexRefreshDeferred'));
      return;
    }
    toast.success(
      next
        ? t('settings.computerUse.directControl.toast.enabled')
        : t('settings.computerUse.directControl.toast.disabled'),
    );
  }, [t]);

  // CLI-only CuaDriver installs use the legacy `permissions grant` process and
  // have no native-guide broadcasts. Keep checking that live permission state
  // while the shared pending UI is visible. The completion ref also prevents a
  // native broadcast and this fallback poll from enabling the plugin twice.
  useEffect(() => {
    if (!computerPermissionPending) {
      if (computerPermissionPollTimerRef.current !== null) {
        window.clearTimeout(computerPermissionPollTimerRef.current);
        computerPermissionPollTimerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const deadline = Date.now() + COMPUTER_PERMISSION_POLL_TIMEOUT_MS;
    const poll = async () => {
      try {
        if (!computerPermissionGrantInProgressRef.current) {
          const status = await refreshComputerPermissionStatus('permission-poll', {
            bypassCache: true,
          });
          if (cancelled) return;
          if (isComputerPermissionReady(status)) {
            if (computerPermissionCompletionInFlightRef.current) return;
            computerPermissionCompletionInFlightRef.current = true;
            setComputerPermissionPending(false);
            resetComputerPermissionFlow();
            cancelNativeComputerPermissionGrant();
            try {
              if (computerEnableIntentRef.current || computerEnabled) {
                await persistComputerEnabled(true);
              }
            } finally {
              computerPermissionCompletionInFlightRef.current = false;
            }
            return;
          }
        }
      } catch (err) {
        log.warn('computer permission poll failed', err);
      }

      if (cancelled) return;
      if (Date.now() >= deadline) {
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        cancelNativeComputerPermissionGrant();
        if (!computerEnabled) computerEnableIntentRef.current = false;
        toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
        return;
      }
      computerPermissionPollTimerRef.current = window.setTimeout(
        poll,
        COMPUTER_PERMISSION_POLL_INTERVAL_MS,
      );
    };

    void poll();
    return () => {
      cancelled = true;
      if (computerPermissionPollTimerRef.current !== null) {
        window.clearTimeout(computerPermissionPollTimerRef.current);
        computerPermissionPollTimerRef.current = null;
      }
    };
  }, [
    cancelNativeComputerPermissionGrant,
    computerEnabled,
    computerPermissionPending,
    persistComputerEnabled,
    refreshComputerPermissionStatus,
    resetComputerPermissionFlow,
    t,
  ]);

  const handleToggleBrowser = useCallback(
    async (next: boolean) => {
      if (!workingDir) return;
      setTogglePending(true);
      try {
        await window.electronAPI.maker.plugins.setProjectEnabled(workingDir, BROWSER_PLUGIN_ID, next);
        setBrowserEnabled(next);
        toast.success(
          next
            ? t('settings.computerUse.browser.toast.enabled')
            : t('settings.computerUse.browser.toast.disabled'),
        );
      } catch (err) {
        log.warn('setProjectEnabled(browser) failed', err);
        toast.error(t('settings.computerUse.browser.toast.toggleFailed'));
      } finally {
        setTogglePending(false);
      }
    },
    [t, workingDir],
  );

  const handleRefreshAndroidStatus = useCallback(async (showErrorToast = true) => {
    setAndroidStatusPending(true);
    try {
      const status = await window.electronAPI.maker.android.status();
      setAndroidStatus(status);
    } catch (err) {
      log.warn('android.status refresh failed', err);
      setAndroidStatus(androidStatusFallback(err));
      if (showErrorToast) {
        toast.error(t('settings.computerUse.android.toast.statusFailed'));
      }
    } finally {
      setAndroidStatusPending(false);
    }
  }, [t]);

  const handleSelectAndroidDevice = useCallback(async (value: string) => {
    const serial = value === ANDROID_AUTO_DEVICE_VALUE ? null : value;
    setAndroidDevicePending(true);
    try {
      const config = await window.electronAPI.maker.android.setDefaultDevice(serial);
      setAndroidConfig(config);
      await handleRefreshAndroidStatus(false);
    } catch (err) {
      log.warn('android.setDefaultDevice failed', err);
      toast.error(t('settings.computerUse.android.toast.deviceFailed'));
    } finally {
      setAndroidDevicePending(false);
    }
  }, [handleRefreshAndroidStatus, t]);

  const handleSaveAndroidAdbPath = useCallback(async () => {
    const nextAdbPath = androidAdbPathDraft.trim();
    setAndroidAdbPathPending(true);
    try {
      const config = await window.electronAPI.maker.android.setAdbPath(nextAdbPath);
      setAndroidConfig(config);
      setAndroidAdbPathDraft(config.value.adbPathOverride ?? nextAdbPath);
      setAndroidAdbPathEdited(false);
      if (androidEnabled) {
        setAndroidPreparePending(true);
        await window.electronAPI.maker.android.prepareAdb();
      }
      await handleRefreshAndroidStatus(false);
    } catch (err) {
      log.warn('android.setAdbPath failed', err);
      toast.error(t('settings.computerUse.android.toast.adbPathFailed'));
    } finally {
      setAndroidPreparePending(false);
      setAndroidAdbPathPending(false);
    }
  }, [androidAdbPathDraft, androidEnabled, handleRefreshAndroidStatus, t]);

  const handleUseDefaultAndroidAdbPath = useCallback(async () => {
    setAndroidAdbPathPending(true);
    try {
      const config = await window.electronAPI.maker.android.setAdbPath(null);
      if (androidEnabled) {
        setAndroidPreparePending(true);
        await window.electronAPI.maker.android.prepareAdb();
      }
      await handleRefreshAndroidStatus(false);
      setAndroidConfig(config);
      setAndroidAdbPathEdited(false);
    } catch (err) {
      log.warn('android.useDefaultAdbPath failed', err);
      toast.error(t('settings.computerUse.android.toast.adbPathFailed'));
    } finally {
      setAndroidPreparePending(false);
      setAndroidAdbPathPending(false);
    }
  }, [androidEnabled, handleRefreshAndroidStatus, t]);

  const handleToggleAndroid = useCallback(
    async (next: boolean) => {
      setAndroidTogglePending(true);
      try {
        const result = await window.electronAPI.maker.plugins.setEnabled(ANDROID_PLUGIN_ID, next);
        setAndroidEnabled(next);
        if (next) {
          setAndroidPreparePending(true);
          await window.electronAPI.maker.android.prepareAdb();
          await handleRefreshAndroidStatus(false);
        }
        toast.success(
          next
            ? t('settings.computerUse.android.toast.enabled')
            : t('settings.computerUse.android.toast.disabled'),
        );
        if (result.codexMcpRefreshed === false) {
          toast.warning(t('settings.computerUse.codexRefreshDeferred'));
        }
      } catch (err) {
        log.warn('plugins.setEnabled(android) failed', err);
        toast.error(t('settings.computerUse.android.toast.toggleFailed'));
      } finally {
        setAndroidPreparePending(false);
        setAndroidTogglePending(false);
      }
    },
    [handleRefreshAndroidStatus, t],
  );

  const handleToggleComputer = useCallback(
    async (next: boolean) => {
      const flowSeq = computerPermissionFlowSeqRef.current;
      const isCurrentFlow = () => (
        computerUseSectionMountedRef.current
        && computerPermissionFlowSeqRef.current === flowSeq
      );
      computerTogglePendingRef.current = true;
      setComputerTogglePending(true);
      computerEnableIntentRef.current = next;
      if (next) computerPermissionCompletionInFlightRef.current = false;
      let nextStatus = computerStatus;
      try {
        if (next && !nextStatus?.installed) {
          setComputerInstallPending(true);
          const installResult = await window.electronAPI.maker.computer.installDriver();
          if (!isCurrentFlow()) return;
          nextStatus = installResult.status;
          setComputerStatus(installResult.status);
          if (!installResult.status.installed) {
            throw new Error(installResult.status.error ?? 'cua-driver install did not produce an installed driver');
          }
        }
        if (next && nextStatus?.permissionState?.platform === 'macos') {
          nextStatus = await refreshComputerPermissionStatus('toggle-fresh-preflight', {
            fresh: true,
            bypassCache: true,
          });
          if (!isCurrentFlow()) return;
        }
        if (next && isComputerPermissionPreflightInconclusive(nextStatus)) {
          computerEnableIntentRef.current = false;
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          toast.error(t('settings.computerUse.directControl.toast.permissionFailed'));
          return;
        }
        if (shouldStartComputerPermissionGuide(next, nextStatus)) {
          if (!isCurrentFlow()) return;
          setComputerPermissionPending(true);
          nextStatus = await requestComputerPermissionGrant('toggle');
          // 用户在 grant 等待期间点了引导弹窗的「取消」:整个流程已终止,
          // 不再打开系统设置/弹提示。
          if (computerPermissionFlowSeqRef.current !== flowSeq) return;
          if (!isComputerPermissionReady(nextStatus)) {
            toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
            return;
          }
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
        }
        if (next && isComputerPermissionReady(nextStatus)) {
          // The early status card may have been shown while a fresh check was
          // in flight; close it when that check proves permissions are already
          // complete.
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
        }

        if (!isCurrentFlow()) return;
        await persistComputerEnabled(next);
        if (!next) {
          computerEnableIntentRef.current = false;
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
        }
        if (nextStatus !== computerStatus) {
          setComputerStatus(nextStatus);
        }
      } catch (err) {
        if (!isCurrentFlow()) return;
        log.warn('setProjectEnabled(computer) failed', err);
        computerEnableIntentRef.current = false;
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        cancelNativeComputerPermissionGrant();
        toast.error(
          next && !nextStatus?.installed
            ? t('settings.computerUse.directControl.toast.installFailed')
            : next && !isComputerPermissionReady(nextStatus)
              ? t('settings.computerUse.directControl.toast.permissionFailed')
            : t('settings.computerUse.directControl.toast.toggleFailed'),
        );
      } finally {
        computerTogglePendingRef.current = false;
        if (computerUseSectionMountedRef.current) {
          setComputerInstallPending(false);
          setComputerTogglePending(false);
        }
      }
    },
    [
      computerStatus,
      cancelNativeComputerPermissionGrant,
      persistComputerEnabled,
      refreshComputerPermissionStatus,
      requestComputerPermissionGrant,
      resetComputerPermissionFlow,
      t,
    ],
  );

  const handleDownload = useCallback(() => {
    void window.electronAPI.openExternal(CHROME_DOWNLOAD_URL);
  }, []);

  const handleOpenCuaProject = useCallback(() => {
    void window.electronAPI.openExternal(CUA_GITHUB_URL);
  }, []);

  // Launch the headed automation browser so the user can log into sites once;
  // logins persist in the managed profile across sessions.
  const handleOpenForLogin = useCallback(async () => {
    try {
      await window.electronAPI.maker.browser.openForLogin();
      toast.success(t('settings.computerUse.browser.toast.openedForLogin'));
    } catch (err) {
      log.warn('browser.openForLogin failed', err);
      toast.error(t('settings.computerUse.browser.toast.openForLoginFailed'));
    }
  }, [t]);

  const handleOpenComputerPermission = useCallback(
    async (url: string, granted: boolean) => {
      if (computerPermissionPending) return;
      const flowSeq = computerPermissionFlowSeqRef.current;
      // Open the exact System Settings pane before starting native onboarding.
      // The old order waited for the paused grant flow first, so the user saw
      // no feedback while the guide was preparing and the pane could open late.
      const opened = await openComputerPermissionSettings(
        url,
        granted ? 'badge-granted' : 'badge-missing',
      );
      if (
        !computerUseSectionMountedRef.current
        || computerPermissionFlowSeqRef.current !== flowSeq
      ) {
        return;
      }
      if (!opened) return;
      if (granted) {
        return;
      }

      setComputerPermissionPending(true);
      const initialStatus = computerStatus;
      try {
        // Page entry/Recheck already supplied the source-of-truth snapshot.
        // Pass it straight into the guide so its first frame chooses the
        // current missing step without another probe or a driver restart.
        if (isComputerPermissionReady(initialStatus)) {
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          if (computerEnableIntentRef.current || computerEnabled) {
            await persistComputerEnabled(true);
          }
          return;
        }

        const status = await requestComputerPermissionGrant('badge', url);
        if (computerPermissionFlowSeqRef.current !== flowSeq) return;
        if (isComputerPermissionReady(status)) {
          setComputerPermissionPending(false);
          resetComputerPermissionFlow();
          if (computerEnableIntentRef.current || computerEnabled) {
            await persistComputerEnabled(true);
          }
          return;
        }

        log.debug('computer permission grant still pending after badge action', getComputerPermissionLogSummary(status));
        // The System Settings pane is already open. Keep the guide alive and
        // let its native observer complete the remaining step.
        toast.warning(t('settings.computerUse.directControl.toast.permissionPending'));
      } catch (err) {
        if (
          !computerUseSectionMountedRef.current
          || computerPermissionFlowSeqRef.current !== flowSeq
        ) {
          return;
        }
        log.warn('computer permission grant failed', err);
        setComputerPermissionPending(false);
        resetComputerPermissionFlow();
        cancelNativeComputerPermissionGrant();
        toast.error(t('settings.computerUse.directControl.toast.permissionFailed'));
      }
    },
    [
      computerEnabled,
      computerStatus,
      computerPermissionPending,
      cancelNativeComputerPermissionGrant,
      openComputerPermissionSettings,
      persistComputerEnabled,
      requestComputerPermissionGrant,
      resetComputerPermissionFlow,
      t,
    ],
  );

  // Recheck restarts the daemon so it picks up revoked permissions that a
  // running daemon cannot detect (AX revoke is invisible to the live process;
  // Screen Recording removal may not kill the daemon on all macOS versions).
  // fresh=true is required: passiveOnly kept the old daemon alive and its
  // stale TCC preflight kept reporting "granted" even after the user removed
  // CuaDriver from Screen Recording.
  const handleRecheckComputerStatus = useCallback(async () => {
    setComputerPermissionRecheckPending(true);
    try {
      const status = await refreshComputerPermissionStatus('recheck', {
        fresh: true,
        bypassCache: true,
      });
      if (!status.installed || !isComputerPermissionReady(status)) {
        log.debug('computer permission recheck found missing permissions', getComputerPermissionLogSummary(status));
      }
    } catch (err) {
      log.warn('computer.status refresh failed', err);
      toast.error(t('settings.computerUse.directControl.toast.toggleFailed'));
    } finally {
      setComputerPermissionRecheckPending(false);
    }
  }, [refreshComputerPermissionStatus, t]);

  const automationViewLoading =
    browserEnabled === null
    || computerEnabled === null
    || availability === null
    || computerStatus === null;

  // First render: blank until all reads land (no flash, rule 7).
  if (automationViewLoading) {
    return null;
  }

  const computerAccessibilityGranted = isComputerAccessibilityPermissionReady(computerStatus);
  const computerScreenRecordingGranted = isComputerScreenRecordingPermissionReady(computerStatus);
  const computerAccessibilityPending = computerPermissionPending && !computerAccessibilityGranted;
  const computerScreenRecordingPending =
    computerPermissionPending &&
    computerAccessibilityGranted &&
    !computerScreenRecordingGranted;
  const computerReady =
    computerStatus.installed && isComputerPermissionReady(computerStatus);
  // Persisted opt-in and runtime readiness are separate states. Keeping an
  // unavailable enabled configuration checked lets the user turn it off
  // instead of forcing the only interaction back into onboarding.
  const computerSwitchChecked = getComputerPermissionSwitchChecked(
    computerEnabled,
    computerTogglePending,
    computerEnableIntentRef.current,
  );
  const computerSwitchDisabled =
    computerTogglePending || computerInstallPending || computerPermissionPending;

  const configuredDefaultAndroidDevice =
    androidConfig?.value.defaultDeviceSerial
    ?? androidStatus?.configured_default_device_serial
    ?? null;
  const androidDevices = androidStatus?.devices ?? [];
  const selectedAndroidDevice = configuredDefaultAndroidDevice
    ? androidDevices.find((device) => device.device_serial === configuredDefaultAndroidDevice)
    : undefined;
  const androidDeviceTriggerLabel = configuredDefaultAndroidDevice
    ? androidDeviceLabel(selectedAndroidDevice) || configuredDefaultAndroidDevice
    : t('settings.computerUse.android.device.auto');
  const hasStaleConfiguredAndroidDevice = Boolean(
    configuredDefaultAndroidDevice
    && !androidDevices.some((device) => device.device_serial === configuredDefaultAndroidDevice),
  );
  const androidDeviceStatusText = describeAndroidDeviceStatus(androidStatus, t);
  const androidConnectionGuideKind = getAndroidConnectionGuideKind(androidStatus);
  const androidAdbSource = androidStatus?.adb_path_source ?? androidStatus?.adb_preparation?.source ?? null;
  const androidAdbSourceText = androidPreparePending
    ? t('settings.computerUse.android.adb.preparing')
    : androidStatus?.adb_available && androidStatus.adb_path
      ? t('settings.computerUse.android.adb.ready', {
          source: t(androidSourceLabelKey(androidAdbSource)),
        })
      : androidStatus?.adb_preparation?.error
        ? t('settings.computerUse.android.adb.prepareFailed', {
            message: androidStatus.adb_preparation.error,
          })
        : t('settings.computerUse.android.adb.auto');
  const androidAdbPersistedOverride = androidConfig?.value.adbPathOverride?.trim() ?? '';
  const androidAdbActivePath = androidStatus?.adb_path ?? androidStatus?.adb_preparation?.path ?? '';
  const androidAdbBaselinePath = androidAdbPersistedOverride || androidAdbActivePath;
  const androidAdbPathTrimmed = androidAdbPathDraft.trim();
  const androidAdbPathDirty = androidAdbPathEdited && androidAdbPathTrimmed !== androidAdbBaselinePath.trim();
  const androidAdbPathCanSave = androidAdbPathDirty && androidAdbPathTrimmed.length > 0;
  const androidAdbPathBusy = androidAdbPathPending || androidPreparePending;

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1 min-w-0">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.computerUse.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.description')}
        </p>
      </div>

      <div
        id="automation-browser"
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Globe size={16} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex min-w-0 flex-col gap-[8px]">
              <p className="truncate text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.computerUse.browser.title')}
              </p>
              <p className="truncate text-12 leading-none text-[var(--settings-section-desc)]">
                {t('settings.computerUse.browser.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={browserEnabled}
            disabled={togglePending || !workingDir}
            onCheckedChange={handleToggleBrowser}
            aria-label={t('settings.computerUse.browser.toggleAria')}
          />
        </div>
        {/* Phase 5: backend 切换 segmented control,排在 enable toggle 紧下方 —
            「使用哪个浏览器」是控制 toggle 之后用户首先需要回答的问题,所以放在
            探测 / 登录 cell 之前。state 还没拉到时不渲染。 */}
        {browserBackendKind !== null ? (
          <BrowserBackendSubsection
            active={browserBackendKind}
            pending={browserBackendPending || browserBackendRecovering}
            recovering={browserBackendRecovering}
            health={browserBackendHealth}
            onSelect={(kind) => void handleSelectBackend(kind)}
            onRecover={() => void handleRecoverBrowserBackend()}
          />
        ) : null}
        {/* 只在 backend === 'external' 时展示 Chrome 探测 + 登录入口。内置 webview
            backend 用 Electron 自带 Chromium,这些 UI 对它都没有意义。 */}
        {browserBackendKind === 'external' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
            <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {availability.detected
                ? t('settings.computerUse.browser.detected', {
                    browser: (availability.browserKind ?? 'chromium').replace(/^./, (c) => c.toUpperCase()),
                  })
                : t('settings.computerUse.browser.notDetected')}
            </p>
            {availability.detected ? (
              <button
                type="button"
                onClick={handleOpenForLogin}
                disabled={!browserEnabled}
                className={ACTION_BUTTON_CLASS}
              >
                <LogIn size={12} className="shrink-0" />
                {t('settings.computerUse.browser.openForLogin')}
              </button>
            ) : (
              <button type="button" onClick={handleDownload} className={ACTION_BUTTON_CLASS}>
                <Download size={12} className="shrink-0" />
                {t('settings.computerUse.browser.download')}
              </button>
            )}
          </div>
        ) : null}
      </div>

      {browserBackendKind === 'external' && availability.detected ? (
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.computerUse.browser.openForLoginHint')}
        </p>
      ) : null}
      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {workingDir
          ? t('settings.computerUse.browser.toggleHint')
          : t('settings.computerUse.browser.noProjectHint')}
      </p>

      <div aria-hidden="true" className="h-px bg-[var(--settings-theme-card-border)]" />

      <div
        id="automation-computer"
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <MonitorCog size={16} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex min-w-0 flex-col gap-[8px]">
              <p className="truncate text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.computerUse.directControl.title')}
              </p>
              <p className="truncate text-12 leading-none text-[var(--settings-section-desc)]">
                {t('settings.computerUse.directControl.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={computerSwitchChecked}
            disabled={computerSwitchDisabled}
            onCheckedChange={handleToggleComputer}
            aria-label={t('settings.computerUse.directControl.toggleAria')}
          />
        </div>
        {/* Windows/Linux 没有 macOS TCC 权限,整块隐藏;安装进度改在下方状态行展示。 */}
        {window.electronAPI.platform === 'darwin' ? (
          <div className="border-t border-[var(--settings-theme-card-border)] px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-13 font-medium text-[var(--settings-section-title)]">
                {t('settings.computerUse.directControl.permissions.title')}
              </p>
              {computerInstallPending || computerPermissionPending ? (
                <span className="inline-flex items-center gap-1.5 text-12 text-[var(--settings-section-desc)]">
                  <Spinner size={12} />
                  {computerInstallPending
                    ? t('settings.computerUse.directControl.installing')
                    : t('settings.computerUse.directControl.authorizing')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRecheckComputerStatus()}
                  disabled={computerPermissionRecheckPending}
                  className={cn(ACTION_BUTTON_CLASS, 'h-6 px-2.5')}
                >
                  {computerPermissionRecheckPending ? (
                    <Spinner size={12} />
                  ) : (
                    <RefreshCw size={12} className="shrink-0" />
                  )}
                  {t('settings.computerUse.directControl.permissions.recheck')}
                </button>
              )}
            </div>

            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <ComputerPermissionRow
                label={t('settings.computerUse.directControl.permissions.accessibilityLabel')}
                iconSrc={accessibilityPermissionIcon}
                granted={computerAccessibilityGranted}
                pending={computerAccessibilityPending}
                actionLabel={
                  computerAccessibilityPending
                    ? t('settings.computerUse.directControl.permissionGuide.waiting')
                    : computerAccessibilityGranted
                      ? t('settings.computerUse.directControl.permissions.granted')
                      : t('settings.computerUse.directControl.permissions.grant')
                }
                onAction={() =>
                  void (
                    computerStatus.installed
                      ? handleOpenComputerPermission(
                          MAC_ACCESSIBILITY_SETTINGS_URL,
                          computerAccessibilityGranted,
                        )
                      : handleToggleComputer(true)
                  )
                }
              />
              <ComputerPermissionRow
                label={t('settings.computerUse.directControl.permissions.screenRecordingLabel')}
                iconSrc={screenRecordingPermissionIcon}
                granted={computerScreenRecordingGranted}
                pending={computerScreenRecordingPending}
                actionLabel={
                  computerScreenRecordingPending
                    ? t('settings.computerUse.directControl.permissionGuide.waiting')
                    : computerScreenRecordingGranted
                      ? t('settings.computerUse.directControl.permissions.granted')
                      : t('settings.computerUse.directControl.permissions.grant')
                }
                onAction={() =>
                  void (
                    computerStatus.installed
                      ? handleOpenComputerPermission(
                          MAC_SCREEN_RECORDING_SETTINGS_URL,
                          computerScreenRecordingGranted,
                        )
                      : handleToggleComputer(true)
                  )
                }
              />
            </div>
          </div>
        ) : null}

        <div className="relative border-t border-[var(--settings-theme-card-border)] px-4 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-11 text-[var(--settings-section-desc)]">
                {computerStatus.installed
                  ? t('settings.computerUse.directControl.status.version', {
                      version: computerStatus.version ?? 'cua-driver',
                    })
                  : t('settings.computerUse.directControl.notDetected')}
              </span>
              {window.electronAPI.platform !== 'darwin' && computerInstallPending ? (
                <>
                  <span aria-hidden="true" className="text-11 text-[var(--settings-theme-card-border)]">
                    ·
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-11 text-[var(--settings-section-desc)]">
                    <Spinner size={12} />
                    {t('settings.computerUse.directControl.installing')}
                  </span>
                </>
              ) : null}
              {computerStatus.installed && driverUpdate?.latestVersion ? (
                <>
                  <span aria-hidden="true" className="text-11 text-[var(--settings-theme-card-border)]">
                    ·
                  </span>
                  <span className="text-11 text-[var(--settings-section-desc)]">
                    {driverUpdatePending
                      ? driverUpdateProgress?.phase === 'installing'
                        ? t('settings.computerUse.directControl.update.installing')
                        : t('settings.computerUse.directControl.update.updating')
                      : t('settings.computerUse.directControl.update.available', {
                          version: driverUpdate.latestVersion,
                        })}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleUpdateDriver()}
                    disabled={driverUpdatePending || computerInstallPending}
                    className={cn(ACTION_BUTTON_CLASS, 'h-6 px-2.5')}
                  >
                    <Download size={12} className="shrink-0" />
                    {driverUpdatePending
                      ? t('settings.computerUse.directControl.update.updating')
                      : t('settings.computerUse.directControl.update.action')}
                  </button>
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setComputerDetailsOpen((open) => !open)}
              aria-expanded={computerDetailsOpen}
              className={cn(
                'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5',
                'text-11 font-medium text-[var(--settings-section-desc)]',
                'transition-colors hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              {computerDetailsOpen
                ? t('settings.computerUse.directControl.permissions.hideDetails')
                : t('settings.computerUse.directControl.permissions.moreDetails')}
              <ChevronDown
                size={12}
                className={cn(
                  'transition-transform duration-200',
                  computerDetailsOpen && 'rotate-180',
                )}
              />
            </button>
          </div>
          {driverUpdatePending &&
          driverUpdateProgress?.phase === 'downloading' &&
          driverUpdateProgress.downloadedBytes !== null &&
          driverUpdateProgress.totalBytes ? (
            <div className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--settings-input-bg)]">
              <div
                className="h-full bg-[var(--settings-section-title)] transition-[width] duration-500"
                style={{
                  width: `${Math.min(
                    100,
                    (driverUpdateProgress.downloadedBytes / driverUpdateProgress.totalBytes) * 100,
                  )}%`,
                }}
              />
            </div>
          ) : null}
        </div>

        {computerDetailsOpen ? (
          <div className="flex flex-col gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-3.5">
            <div className="flex flex-col gap-2">
              <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                {t('settings.computerUse.directControl.driverInfo')}
              </p>
              {window.electronAPI.platform === 'darwin' ? (
                <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                  {computerReady
                    ? t('settings.computerUse.directControl.permissions.runtimeConfirmations')
                    : t('settings.computerUse.directControl.permissions.macosHint')}
                </p>
              ) : null}
            </div>
            <div>
              <button
                type="button"
                onClick={handleOpenCuaProject}
                className={ACTION_BUTTON_CLASS}
              >
                <ExternalLink size={12} className="shrink-0" />
                {t('settings.computerUse.directControl.openSourceProject')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div aria-hidden="true" className="h-px bg-[var(--settings-theme-card-border)]" />

      <div
        id="automation-android"
        className={cn(
          'flex flex-col overflow-hidden rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-[14px]">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                'bg-[var(--settings-input-bg)]',
              )}
            >
              <Smartphone size={16} className="text-[var(--settings-section-title)]" />
            </div>
            <div className="flex min-w-0 flex-col gap-[8px]">
              <p className="truncate text-14 font-medium leading-none text-[var(--settings-section-title)]">
                {t('settings.computerUse.android.title')}
              </p>
              <p className="truncate text-12 leading-none text-[var(--settings-section-desc)]">
                {t('settings.computerUse.android.description')}
              </p>
            </div>
          </div>
          <Switch
            checked={androidEnabled ?? false}
            disabled={androidEnabled === null || androidTogglePending}
            onCheckedChange={handleToggleAndroid}
            aria-label={t('settings.computerUse.android.toggleAria')}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-12 font-medium leading-[1.5] text-[var(--settings-section-title)]">
              {t('settings.computerUse.android.device.title')}
            </p>
            <p className="min-w-0 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {androidDeviceStatusText}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={androidDevicePending || !androidStatus}
                  className={cn(ACTION_BUTTON_CLASS, 'max-w-[260px] px-2.5')}
                  aria-label={t('settings.computerUse.android.device.ariaLabel')}
                  title={configuredDefaultAndroidDevice ?? undefined}
                >
                  <Smartphone size={12} className="shrink-0" />
                  <span className="truncate">{androidDeviceTriggerLabel}</span>
                  <ChevronDown size={12} className="shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={cn(
                  'min-w-[260px] max-w-[360px]',
                  'border border-[var(--settings-input-border)]',
                  'bg-[var(--settings-theme-card-bg)] text-[var(--settings-section-title)]',
                )}
              >
                <DropdownMenuItem
                  onClick={() => void handleSelectAndroidDevice(ANDROID_AUTO_DEVICE_VALUE)}
                  className="flex items-start gap-2"
                >
                  <Check
                    size={14}
                    className={cn('mt-0.5 shrink-0', !configuredDefaultAndroidDevice ? 'opacity-100' : 'opacity-0')}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-13 font-medium">
                      {t('settings.computerUse.android.device.auto')}
                    </span>
                    <span className="truncate text-11 text-[var(--settings-section-desc)]">
                      {t('settings.computerUse.android.device.autoHint')}
                    </span>
                  </div>
                </DropdownMenuItem>
                {hasStaleConfiguredAndroidDevice ? (
                  <DropdownMenuItem
                    onClick={() => void handleSelectAndroidDevice(configuredDefaultAndroidDevice ?? '')}
                    className="flex items-start gap-2"
                  >
                    <Check size={14} className="mt-0.5 shrink-0 opacity-100" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-13 font-medium">
                        {configuredDefaultAndroidDevice}
                      </span>
                      <span className="truncate text-11 text-[var(--settings-section-desc)]">
                        {t('settings.computerUse.android.device.unavailable')}
                      </span>
                    </div>
                  </DropdownMenuItem>
                ) : null}
                {androidDevices.length === 0 ? (
                  <div className="px-2 py-2 text-12 text-[var(--settings-section-desc)]">
                    {t('settings.computerUse.android.device.none')}
                  </div>
                ) : (
                  androidDevices.map((device) => {
                    const selected = configuredDefaultAndroidDevice === device.device_serial;
                    const ready = device.state === 'device';
                    return (
                      <DropdownMenuItem
                        key={device.device_serial}
                        disabled={!ready}
                        onClick={() => void handleSelectAndroidDevice(device.device_serial)}
                        className="flex items-start gap-2"
                      >
                        <Check
                          size={14}
                          className={cn('mt-0.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
                        />
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-13 font-medium">
                            {androidDeviceLabel(device)}
                          </span>
                          <span className="truncate text-11 text-[var(--settings-section-desc)]">
                            {ready
                              ? t('settings.computerUse.android.device.ready')
                              : t('settings.computerUse.android.device.state', { state: device.state })}
                          </span>
                        </div>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => void handleRefreshAndroidStatus()}
              disabled={androidStatusPending}
              className={ACTION_BUTTON_CLASS}
            >
              <RefreshCw size={12} className="shrink-0" />
              {t('settings.computerUse.android.refresh')}
            </button>
          </div>
        </div>
        {androidConnectionGuideKind ? (
          <div className="border-t border-[var(--settings-theme-card-border)] px-4 py-3">
            <div className="rounded-xl bg-[var(--settings-input-bg)] px-3 py-3">
              <p className="text-12 font-medium leading-[1.5] text-[var(--settings-section-title)]">
                {t(
                  `settings.computerUse.android.connectionGuide.${androidConnectionGuideKind}.title`,
                )}
              </p>
              {androidConnectionGuideKind === 'connect' ? (
                <>
                  <p className="mt-1.5 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                    {t(
                      'settings.computerUse.android.connectionGuide.connect.adbNote',
                    )}
                  </p>
                  <ol className="mt-2 list-decimal space-y-1 pl-4 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                    {[1, 2, 3, 4].map((step) => (
                      <li key={step}>
                        {t(
                          `settings.computerUse.android.connectionGuide.connect.step${step}`,
                        )}
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="mt-1.5 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                  {t(
                    `settings.computerUse.android.connectionGuide.${androidConnectionGuideKind}.body`,
                  )}
                </p>
              )}
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-12 font-medium leading-[1.5] text-[var(--settings-section-title)]">
              {t('settings.computerUse.android.adb.title')}
            </p>
            <p className="min-w-0 break-all text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {androidAdbSourceText}
            </p>
          </div>
          <div className="flex min-w-[240px] flex-1 flex-wrap items-center justify-end gap-2">
            <input
              value={androidAdbPathDraft}
              onChange={(event) => {
                setAndroidAdbPathDraft(event.target.value);
                setAndroidAdbPathEdited(true);
              }}
              disabled={androidAdbPathBusy}
              placeholder={t('settings.computerUse.android.adb.placeholder')}
              aria-label={t('settings.computerUse.android.adb.pathAria')}
              className={cn(
                'h-8 min-w-[220px] flex-1 rounded-full px-3 text-12 outline-none',
                'border border-[var(--settings-input-border)]',
                'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
                'placeholder:text-[var(--settings-input-placeholder)]',
                'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                'disabled:opacity-50',
              )}
            />
            <button
              type="button"
              onClick={() => void handleSaveAndroidAdbPath()}
              disabled={!androidAdbPathCanSave || androidAdbPathBusy}
              className={ACTION_BUTTON_CLASS}
            >
              {t('settings.computerUse.android.adb.save')}
            </button>
            <button
              type="button"
              onClick={() => void handleUseDefaultAndroidAdbPath()}
              disabled={androidAdbPathBusy}
              className={ACTION_BUTTON_CLASS}
            >
              {t('settings.computerUse.android.adb.useDefault')}
            </button>
          </div>
        </div>
      </div>

      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('settings.computerUse.android.toggleHint')}
      </p>
    </div>
  );
}
