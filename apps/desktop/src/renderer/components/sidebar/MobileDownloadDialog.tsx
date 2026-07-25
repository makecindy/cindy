import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Monitor, QrCode, Settings2, Smartphone, X } from 'lucide-react';
import * as QRCode from 'qrcode';

import cindyIconUrl from '@/../../resources/icon.png?url';
import { Spinner } from '@/components/ui/spinner';
import { compareDevicesByName } from '@/features/device-link/deviceSort';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface MobileDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remoteAvailable: boolean;
  onOpenRemoteSettings: () => void;
  onOpenDevices: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const qrDataUrlCache = new Map<string, string>();
const qrDataUrlPromises = new Map<string, Promise<string>>();

interface MobileRemoteSnapshot {
  enabled: boolean;
  devices: DeviceLinkDeviceView[] | null;
}

export interface MobileRemotePresentation {
  layout: 'checking' | 'onboarding' | 'linked';
  remoteEnabled: boolean;
  linkedMobileCount: number;
  otherDeviceCount: number;
  selfDeviceId: string | null;
  linkedMobileName: string | null;
  previewDevices: DeviceLinkDeviceView[];
}

function isMobileDevice(device: DeviceLinkDeviceView): boolean {
  return device.platform === 'ios' || device.platform === 'android';
}

/**
 * Layout and permission state are intentionally orthogonal: transient relay
 * connectivity never makes the whole dialog jump between onboarding and
 * device-management layouts.
 */
export function resolveMobileRemotePresentation(
  snapshot: MobileRemoteSnapshot,
): MobileRemotePresentation {
  if (!snapshot.devices) {
    return {
      layout: 'checking',
      remoteEnabled: snapshot.enabled,
      linkedMobileCount: 0,
      otherDeviceCount: 0,
      selfDeviceId: null,
      linkedMobileName: null,
      previewDevices: [],
    };
  }

  const selfDevice = snapshot.devices.find((device) => device.isSelf);
  const otherDevices = snapshot.devices
    .filter((device) => !device.isSelf)
    .sort(compareDevicesByName);
  const linkedMobileDevices = otherDevices.filter(isMobileDevice);
  // 手机优先,同组内继续按名字排;显式写出并列条件,不依赖 sort 的稳定性。
  const previewDevices = [...otherDevices]
    .sort(
      (left, right) =>
        Number(isMobileDevice(right)) - Number(isMobileDevice(left)) ||
        compareDevicesByName(left, right),
    )
    .slice(0, 3);

  return {
    layout: linkedMobileDevices.length > 0 ? 'linked' : 'onboarding',
    remoteEnabled: snapshot.enabled,
    linkedMobileCount: linkedMobileDevices.length,
    otherDeviceCount: otherDevices.length,
    selfDeviceId: selfDevice?.deviceId ?? null,
    linkedMobileName: linkedMobileDevices[0]?.name ?? null,
    previewDevices,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * https 之外只放行本机回环 —— `config/endpoint.dev.json.example` 的
 * `websiteUrl` 是 `http://localhost:3000`,开发机不该看到一个禁用的二维码;
 * 但公网 http 仍然拒绝,免得区域配置被改成明文站点。
 */
function parseWebsiteUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/**
 * 官网 CN 主站是 `cindy.cn`,打包配置里的 `cindy.com.cn` 只是会 302 过去的别名。
 * 二维码是给手机扫的,直接给最终地址少一跳,也避免手机上先闪一下跳转页。
 */
const WEBSITE_HOST_ALIASES: Record<string, string> = {
  'cindy.com.cn': 'cindy.cn',
  'www.cindy.com.cn': 'cindy.cn',
  'www.cindy.cn': 'cindy.cn',
  'www.cindy.app': 'cindy.app',
};

export function resolveMobileDownloadUrl(websiteUrl: string): string | null {
  const website = parseWebsiteUrl(websiteUrl);
  if (!website) return null;

  const downloadUrl = new URL('/download/', website);
  const canonicalHost = WEBSITE_HOST_ALIASES[downloadUrl.hostname];
  if (canonicalHost) downloadUrl.hostname = canonicalHost;
  return downloadUrl.toString();
}

function getQrDataUrl(downloadUrl: string): Promise<string> {
  const cached = qrDataUrlCache.get(downloadUrl);
  if (cached) return Promise.resolve(cached);

  const pending = qrDataUrlPromises.get(downloadUrl);
  if (pending) return pending;

  const promise = QRCode.toDataURL(downloadUrl, {
    margin: 2,
    width: 234,
  })
    .then((dataUrl) => {
      qrDataUrlCache.set(downloadUrl, dataUrl);
      qrDataUrlPromises.delete(downloadUrl);
      return dataUrl;
    })
    .catch((error) => {
      qrDataUrlPromises.delete(downloadUrl);
      throw error;
    });

  qrDataUrlPromises.set(downloadUrl, promise);
  return promise;
}

function platformLabel(platform: string | null): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    default:
      return platform ?? '—';
  }
}

/**
 * Desktop promotion surface for the regional Cindy mobile download page.
 * The QR edge reuses the official app artwork, so its brand colors stay
 * coupled to the asset instead of introducing component-level color values
 * (registered exception: DESIGN.md §15.7 / §14.4). The card itself carries no
 * shadow and no pointer tilt.
 */
export function MobileDownloadDialog({
  open,
  onOpenChange,
  remoteAvailable,
  onOpenRemoteSettings,
  onOpenDevices,
  triggerRef,
}: MobileDownloadDialogProps) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [qrAttempt, setQrAttempt] = useState(0);
  const [remoteSnapshot, setRemoteSnapshot] = useState<MobileRemoteSnapshot | null>(null);
  const [remoteStatusError, setRemoteStatusError] = useState(false);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const remoteActionRef = useRef<HTMLButtonElement>(null);
  const closeActionRef = useRef<HTMLButtonElement>(null);
  const refreshRemoteRef = useRef<(() => void) | null>(null);
  const skipNextOpenRefreshRef = useRef(false);
  const openHandledRef = useRef(false);
  const websiteUrl = window.electronAPI.clientEndpoints.websiteUrl;
  const downloadUrl = useMemo(() => resolveMobileDownloadUrl(websiteUrl), [websiteUrl]);

  // Prepare the QR before the first click so opening the dialog never waits on
  // canvas encoding. The module-level cache keeps this a once-per-endpoint cost.
  // qrAttempt only moves when a reopen retries a previous failure — the sidebar
  // keeps this component mounted, so without it one transient encoding error
  // would strand the card in its error state until the app restarts.
  useEffect(() => {
    let active = true;
    setQrError(false);

    if (!downloadUrl) {
      setQrDataUrl(null);
      setQrError(true);
      return;
    }

    const cached = qrDataUrlCache.get(downloadUrl);
    if (cached) {
      setQrDataUrl(cached);
      return;
    }

    setQrDataUrl(null);
    void getQrDataUrl(downloadUrl)
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrError(true);
      });

    return () => {
      active = false;
    };
  }, [downloadUrl, qrAttempt]);

  // Device state is also warmed while the dialog is closed. This makes its
  // first rendered layout stable instead of showing a large QR and then
  // shrinking it after the IPC calls resolve.
  useEffect(() => {
    if (!remoteAvailable) {
      setRemoteSnapshot(null);
      setRemoteStatusError(false);
      return;
    }

    let active = true;
    let refreshGeneration = 0;
    const refreshRemoteSnapshot = async () => {
      refreshGeneration += 1;
      const generation = refreshGeneration;
      try {
        const state = await window.electronAPI.deviceLink.getState();
        let devices: DeviceLinkDeviceView[] | null = null;
        try {
          devices = (await window.electronAPI.deviceLink.listDevices()).devices;
        } catch {
          // The permission switch remains useful even if the device list is
          // temporarily unavailable. Null prevents a failed list from being
          // presented as a confirmed empty state.
        }
        if (!active || generation !== refreshGeneration) return;
        setRemoteSnapshot((previous) => ({
          enabled: state.remoteControlEnabled,
          // A transient list failure is unknown, not a confirmed empty
          // account. Keep the last known devices so the dialog layout does
          // not jump from linked back to onboarding during relay turbulence.
          devices: devices ?? previous?.devices ?? null,
        }));
        setRemoteStatusError(false);
      } catch {
        if (!active || generation !== refreshGeneration) return;
        // Preserve the last known layout while exposing this failure through
        // the permission card. A later presence/status event will retry.
        setRemoteStatusError(true);
      }
    };

    // 设置页改权限、重命名/删除设备都不会经过下面这三个事件(离线时 presence
    // 更是发不出去),所以每次打开弹窗都要主动重读一次,而不是只靠推送。
    refreshRemoteRef.current = () => {
      void refreshRemoteSnapshot();
    };

    void refreshRemoteSnapshot();
    // 这一轮预热已经覆盖了「挂载时就是打开状态」的情况,下面的重开刷新不要重复打一次。
    skipNextOpenRefreshRef.current = true;
    return () => {
      active = false;
      refreshGeneration += 1;
      refreshRemoteRef.current = null;
    };
  }, [remoteAvailable]);

  // 三个推送只在弹窗打开期间订阅 —— 组件随侧边栏常驻,关着的时候没人看这份快照,
  // 没必要为每次 presence 抖动跑一轮 IPC;重新打开时上面那次全量读取会补上。
  useEffect(() => {
    if (!open || !remoteAvailable) return;

    const refresh = () => refreshRemoteRef.current?.();
    const offPresence = window.electronAPI.deviceLink.onPresenceChanged(refresh);
    const offStatus = window.electronAPI.deviceLink.onStatusChanged(refresh);
    const offConnectionIssue = window.electronAPI.deviceLink.onConnectionIssue(refresh);
    return () => {
      offPresence();
      offStatus();
      offConnectionIssue();
    };
  }, [open, remoteAvailable]);

  useEffect(() => {
    if (!open) {
      skipNextOpenRefreshRef.current = false;
      openHandledRef.current = false;
      return;
    }
    // 每次打开只处理一次:后续 qrError / remoteAvailable 的变化不该再触发重试,
    // 否则一次持续失败会变成打开期间的无限重试。
    if (openHandledRef.current) return;
    openHandledRef.current = true;

    if (qrError && downloadUrl) setQrAttempt((attempt) => attempt + 1);

    if (skipNextOpenRefreshRef.current) {
      skipNextOpenRefreshRef.current = false;
      return;
    }
    refreshRemoteRef.current?.();
  }, [open, remoteAvailable, qrError, downloadUrl]);

  const openDownloadPage = async () => {
    if (!downloadUrl) return;
    try {
      const result = await window.electronAPI.openExternal(downloadUrl);
      if (!result.success) toast.error(t('sidebar.mobileDownload.openFailed'));
    } catch {
      toast.error(t('sidebar.mobileDownload.openFailed'));
    }
  };

  const remotePresentation = remoteSnapshot
    ? resolveMobileRemotePresentation(remoteSnapshot)
    : null;
  const hasLinkedMobile = remotePresentation?.layout === 'linked';
  const remoteStateKey = remoteStatusError
    ? 'unavailable'
    : remoteSnapshot
      ? remoteSnapshot.enabled
        ? 'enabled'
        : 'enable'
      : 'checking';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[10000] bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'max-h-[calc(100vh-32px)] w-[400px] max-w-[calc(100vw-32px)] overflow-y-auto overscroll-contain',
            'select-none rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const initialFocus =
              (downloadUrl ? primaryActionRef.current : null) ??
              (remoteAvailable ? remoteActionRef.current : null) ??
              closeActionRef.current;
            initialFocus?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <Dialog.Close asChild>
            <button
              ref={closeActionRef}
              type="button"
              aria-label={t('sidebar.mobileDownload.close')}
              className={cn(
                'absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full',
                'text-[var(--confirm-desc)] transition-colors',
                'hover:bg-[var(--surface-hover)] hover:text-[var(--confirm-title)]',
                'active:scale-[0.98]',
                'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </Dialog.Close>

          <div className="flex flex-col items-center text-center">
            <img
              src={cindyIconUrl}
              alt=""
              aria-hidden="true"
              className="h-16 w-16 select-none object-contain"
              draggable={false}
            />

            <Dialog.Title className="mt-3 text-lg font-medium text-[var(--confirm-title)]">
              {t('sidebar.mobileDownload.title')}
            </Dialog.Title>
            <Dialog.Description
              className="mt-2 flex items-center justify-center gap-2 text-[var(--confirm-desc)]"
              aria-label={t('sidebar.mobileDownload.subtitle')}
            >
              <Smartphone className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              <span aria-hidden="true" className="text-11 tracking-[0.2em]">
                ---
              </span>
              <Monitor className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              <span className="sr-only">{t('sidebar.mobileDownload.subtitle')}</span>
            </Dialog.Description>

            <div
              className={cn(
                'mt-5 flex w-full items-center justify-center',
                hasLinkedMobile ? 'gap-5 text-left' : 'flex-col text-center',
              )}
            >
              <button
                ref={primaryActionRef}
                type="button"
                disabled={!downloadUrl}
                data-testid="mobile-download-qr-card"
                data-compact={hasLinkedMobile ? 'true' : 'false'}
                aria-label={t('sidebar.mobileDownload.openPage')}
                className={cn(
                  'mobile-download-qr-card relative shrink-0 overflow-hidden rounded-xl',
                  hasLinkedMobile ? 'h-[132px] w-[132px]' : 'h-[228px] w-[228px]',
                  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                )}
                onClick={() => {
                  void openDownloadPage();
                }}
              >
                <span
                  aria-hidden="true"
                  className="mobile-download-qr-edge pointer-events-none absolute inset-[-45%]"
                >
                  <img
                    src={cindyIconUrl}
                    alt=""
                    className="h-full w-full select-none object-cover"
                    draggable={false}
                  />
                </span>
                {/* 2px:1px 时红蓝几乎看不见，3px 起就压成相框边了。 */}
                <span
                  className={cn(
                    'absolute inset-[2px] flex items-center justify-center overflow-hidden',
                    'rounded-[10px] bg-[var(--confirm-bg)]',
                  )}
                  aria-live="polite"
                >
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={t('sidebar.mobileDownload.qrAlt')}
                      className="h-full w-full select-none"
                      draggable={false}
                    />
                  ) : qrError ? (
                    <span className="flex max-w-[160px] flex-col items-center gap-2 text-center text-[var(--error-fg-strong)]">
                      <QrCode className="h-6 w-6" aria-hidden="true" />
                      <span className="text-12 leading-[18px]">
                        {t('sidebar.mobileDownload.error')}
                      </span>
                    </span>
                  ) : (
                    <span className="flex flex-col items-center gap-3 text-[var(--confirm-desc)]">
                      <Spinner size={20} />
                      <span className="text-12">{t('sidebar.mobileDownload.preparing')}</span>
                    </span>
                  )}
                </span>
              </button>

              <div className={cn(hasLinkedMobile ? 'min-w-0 flex-1' : 'mt-4')}>
                {/* 未连设备时只留扫码这一行说明(要求同时说清"登录同一账号"),
                    不再补平台支持副标题。 */}
                <p
                  className={cn(
                    'text-14 font-medium text-[var(--confirm-title)]',
                    !hasLinkedMobile && 'max-w-[260px]',
                  )}
                >
                  {t(
                    hasLinkedMobile
                      ? 'sidebar.mobileDownload.scanAnother'
                      : 'sidebar.mobileDownload.scanToOpen',
                  )}
                </p>
                {hasLinkedMobile ? (
                  <p className="mt-1 text-12 leading-[18px] text-[var(--confirm-desc)]">
                    {t('sidebar.mobileDownload.scanAnotherHint')}
                  </p>
                ) : null}
              </div>
            </div>

            {hasLinkedMobile && remotePresentation ? (
              <button
                type="button"
                onClick={onOpenDevices}
                className={cn(
                  'mt-5 w-full rounded-xl border border-[var(--border-default)] px-3 py-3 text-left',
                  'transition-colors hover:bg-[var(--surface-hover-soft)]',
                  'active:scale-[0.98]',
                  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="text-14 font-medium text-[var(--confirm-title)]">
                    {t('sidebar.mobileDownload.myDevices')}
                  </span>
                  <span className="flex items-center gap-2 text-[var(--confirm-desc)]">
                    <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 font-medium text-[var(--confirm-title)]">
                      {remotePresentation.otherDeviceCount}
                    </span>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </span>

                <span className="mt-2 flex flex-col">
                  {remotePresentation.previewDevices.map((device, index) => {
                    const online = device.online;
                    return (
                      <span
                        key={device.deviceId}
                        className={cn(
                          'flex items-center gap-3 py-2',
                          index > 0 && 'border-t border-[var(--border-default)]',
                        )}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-hover-soft)] text-[var(--confirm-desc)]">
                          {isMobileDevice(device) ? (
                            <Smartphone className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                          ) : (
                            <Monitor className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                          )}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-13 font-medium text-[var(--confirm-title)]">
                            {device.name}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-11 text-[var(--confirm-desc)]">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{
                                backgroundColor: online
                                  ? 'var(--remote-status-ready)'
                                  : 'var(--remote-status-disconnected)',
                              }}
                              aria-hidden="true"
                            />
                            {online
                              ? t('settings.devices.status.online')
                              : t('sidebar.mobileDownload.deviceOffline')}
                            <span aria-hidden="true">·</span>
                            {platformLabel(device.platform)}
                          </span>
                        </span>
                      </span>
                    );
                  })}
                </span>
              </button>
            ) : null}

            {remoteAvailable ? (
              <button
                ref={remoteActionRef}
                type="button"
                onClick={onOpenRemoteSettings}
                className={cn(
                  'mt-3 flex w-full items-center gap-3 rounded-xl border border-[var(--border-default)] px-3 py-3 text-left',
                  'transition-colors hover:bg-[var(--surface-hover-soft)]',
                  'active:scale-[0.98]',
                  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--confirm-title)]">
                  <Settings2 className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-13 font-medium leading-[18px] text-[var(--confirm-title)]">
                    {t('sidebar.mobileDownload.allowControl')}
                  </span>
                  {remotePresentation?.selfDeviceId ? (
                    <span
                      className="mt-0.5 truncate font-mono text-10 leading-[14px] text-[var(--confirm-desc)]"
                      title={remotePresentation.selfDeviceId}
                    >
                      {t('sidebar.mobileDownload.deviceId', {
                        id: remotePresentation.selfDeviceId,
                      })}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-12 text-[var(--confirm-desc)]">
                  {/* 状态读取失败时右侧文案已经是「暂不可用」,再留一颗上一次成功
                      读到的绿点会同时给出两个互相矛盾的信号。 */}
                  {!remoteStatusError && remoteSnapshot?.enabled ? (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-[var(--remote-status-ready)]"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span>{t(`sidebar.mobileDownload.remoteAction.${remoteStateKey}`)}</span>
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </button>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
