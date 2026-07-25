import * as Dialog from '@radix-ui/react-dialog';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, QrCode, Smartphone, X } from 'lucide-react';
import * as QRCode from 'qrcode';

import cindyIconUrl from '@/../../resources/icon.png?url';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface MobileDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remoteAvailable: boolean;
  onOpenRemoteSettings: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const qrDataUrlCache = new Map<string, string>();
const qrDataUrlPromises = new Map<string, Promise<string>>();

interface MobileRemoteSnapshot {
  enabled: boolean;
  linkStatus: 'stopped' | 'connecting' | 'online';
  connectionIssue: DeviceLinkConnectionIssuePayload | null;
  devices: DeviceLinkDeviceView[];
}

export interface MobileRemotePresentation {
  state: 'disabled' | 'connecting' | 'error' | 'ready' | 'linked';
  selfDeviceId: string | null;
  linkedMobileName: string | null;
}

export function resolveMobileRemotePresentation(
  snapshot: MobileRemoteSnapshot,
): MobileRemotePresentation {
  const self = snapshot.devices.find((device) => device.isSelf);
  const linkedMobile = snapshot.devices
    .filter((device) => device.platform === 'ios' || device.platform === 'android')
    .sort((left, right) => Number(right.online) - Number(left.online))[0];

  return {
    state: !snapshot.enabled
      ? 'disabled'
      : snapshot.connectionIssue
        ? 'error'
        : snapshot.linkStatus !== 'online'
          ? 'connecting'
          : linkedMobile
            ? 'linked'
            : 'ready',
    selfDeviceId: self?.deviceId ?? null,
    linkedMobileName: linkedMobile?.name ?? null,
  };
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function resolveMobileDownloadUrl(websiteUrl: string): string | null {
  const website = parseHttpsUrl(websiteUrl);
  return website ? new URL('/download/#all-versions', website).toString() : null;
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

/**
 * Desktop promotion surface for the regional Cindy mobile download page.
 * The QR edge reuses the official app artwork, so its brand colors stay
 * coupled to the asset instead of introducing component-level color values.
 */
export function MobileDownloadDialog({
  open,
  onOpenChange,
  remoteAvailable,
  onOpenRemoteSettings,
  triggerRef,
}: MobileDownloadDialogProps) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [remoteSnapshot, setRemoteSnapshot] = useState<MobileRemoteSnapshot | null>(null);
  const [remoteStatusError, setRemoteStatusError] = useState(false);
  const qrCardRef = useRef<HTMLDivElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const remoteActionRef = useRef<HTMLButtonElement>(null);
  const closeActionRef = useRef<HTMLButtonElement>(null);
  const qrPointerFrame = useRef<number | null>(null);
  const pendingQrTransform = useRef<string | null>(null);
  const downloadUrl = useMemo(
    () => resolveMobileDownloadUrl(window.electronAPI.clientEndpoints.websiteUrl),
    [],
  );

  useEffect(
    () => () => {
      if (qrPointerFrame.current !== null) {
        cancelAnimationFrame(qrPointerFrame.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (open) return;

    pendingQrTransform.current = null;
    if (qrPointerFrame.current !== null) {
      cancelAnimationFrame(qrPointerFrame.current);
      qrPointerFrame.current = null;
    }
    if (qrCardRef.current) {
      qrCardRef.current.dataset.pointerActive = 'false';
      qrCardRef.current.style.transform = '';
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

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
  }, [downloadUrl, open]);

  useEffect(() => {
    if (!open || !remoteAvailable) {
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
        let devices: DeviceLinkDeviceView[] = [];
        try {
          devices = (await window.electronAPI.deviceLink.listDevices()).devices;
        } catch {
          // The allow-control switch and relay state remain useful even if the
          // associated-device list is temporarily unavailable.
        }
        if (!active || generation !== refreshGeneration) return;
        setRemoteSnapshot({
          enabled: state.remoteControlEnabled,
          linkStatus: state.linkStatus,
          connectionIssue: state.connectionIssue,
          devices,
        });
        setRemoteStatusError(false);
      } catch {
        if (!active || generation !== refreshGeneration) return;
        setRemoteSnapshot(null);
        setRemoteStatusError(true);
      }
    };

    void refreshRemoteSnapshot();
    const offPresence = window.electronAPI.deviceLink.onPresenceChanged(() => {
      void refreshRemoteSnapshot();
    });
    const offStatus = window.electronAPI.deviceLink.onStatusChanged(() => {
      void refreshRemoteSnapshot();
    });
    const offConnectionIssue = window.electronAPI.deviceLink.onConnectionIssue(() => {
      void refreshRemoteSnapshot();
    });
    return () => {
      active = false;
      refreshGeneration += 1;
      offPresence();
      offStatus();
      offConnectionIssue();
    };
  }, [open, remoteAvailable]);

  const handleQrPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== 'mouse' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    pendingQrTransform.current = `perspective(760px) rotateX(${(50 - y) * 0.08}deg) rotateY(${(x - 50) * 0.08}deg) scale3d(1.018, 1.018, 1.018)`;
    event.currentTarget.dataset.pointerActive = 'true';

    if (qrPointerFrame.current === null) {
      qrPointerFrame.current = requestAnimationFrame(() => {
        qrPointerFrame.current = null;
        if (qrCardRef.current && pendingQrTransform.current) {
          qrCardRef.current.style.transform = pendingQrTransform.current;
        }
      });
    }
  };

  const resetQrPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pendingQrTransform.current = null;
    event.currentTarget.dataset.pointerActive = 'false';
    event.currentTarget.style.transform = '';
  };

  const remotePresentation = remoteSnapshot
    ? resolveMobileRemotePresentation(remoteSnapshot)
    : null;
  const remoteStatusKey = remoteStatusError ? 'error' : (remotePresentation?.state ?? 'loading');
  const remoteStatusColor =
    remoteStatusError || remotePresentation?.state === 'error'
      ? 'var(--remote-status-failed)'
      : remotePresentation?.state === 'linked' || remotePresentation?.state === 'ready'
        ? 'var(--remote-status-ready)'
        : remotePresentation?.state === 'connecting'
          ? 'var(--remote-status-progress)'
          : 'var(--remote-status-disconnected)';

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
            'max-h-[calc(100vh-32px)] w-[400px] max-w-[calc(100vw-32px)] overflow-y-auto',
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
                'absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full',
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
              ref={qrCardRef}
              data-testid="mobile-download-qr-card"
              className="mobile-download-qr-card relative mt-5 h-[236px] w-[236px] overflow-hidden rounded-xl"
              onPointerMove={handleQrPointerMove}
              onPointerLeave={resetQrPointer}
            >
              <div
                aria-hidden="true"
                className="mobile-download-qr-edge pointer-events-none absolute inset-[-45%]"
              >
                <img
                  src={cindyIconUrl}
                  alt=""
                  className="h-full w-full select-none object-cover"
                  draggable={false}
                />
              </div>
              <div
                className={cn(
                  'absolute inset-px flex items-center justify-center overflow-hidden rounded-lg',
                  'bg-[var(--confirm-bg)]',
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
                  <div className="flex max-w-[160px] flex-col items-center gap-2 text-center text-[var(--error-fg-strong)]">
                    <QrCode className="h-6 w-6" aria-hidden="true" />
                    <p className="text-12 leading-[18px]">{t('sidebar.mobileDownload.error')}</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 text-[var(--confirm-desc)]">
                    <Spinner size={20} />
                    <span className="text-12">{t('sidebar.mobileDownload.preparing')}</span>
                  </div>
                )}
              </div>
            </div>

            <p className="mt-5 w-full border-t border-[var(--confirm-btn-secondary-border)] pt-4 text-12 text-[var(--confirm-desc)]">
              {t('sidebar.mobileDownload.platformHint')}
            </p>

            {remoteAvailable ? (
              <div className="mt-4 w-full rounded-xl border border-[var(--confirm-btn-secondary-border)] p-3 text-left">
                <div className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: remoteStatusColor }}
                    aria-hidden="true"
                  />
                  <span className="text-13 font-medium text-[var(--confirm-title)]">
                    {remotePresentation?.state === 'linked'
                      ? t('sidebar.mobileDownload.remoteStatus.linked', {
                          name: remotePresentation.linkedMobileName,
                        })
                      : t(`sidebar.mobileDownload.remoteStatus.${remoteStatusKey}`)}
                  </span>
                </div>
                {remotePresentation?.selfDeviceId ? (
                  <div className="mt-2 flex items-start justify-between gap-3 text-11 text-[var(--confirm-desc)]">
                    <span className="shrink-0">
                      {t('sidebar.mobileDownload.remoteStatus.deviceId')}
                    </span>
                    <code className="select-text break-all text-right font-mono text-[var(--confirm-title)]">
                      {remotePresentation.selfDeviceId}
                    </code>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 flex w-full items-center justify-end gap-2.5">
              {remoteAvailable ? (
                <button
                  ref={remoteActionRef}
                  type="button"
                  onClick={onOpenRemoteSettings}
                  className={cn(
                    'inline-flex items-center justify-center rounded-full border px-6 py-2.5 text-13 font-medium',
                    'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)]',
                    'transition-colors hover:bg-[var(--confirm-btn-secondary-hover)]',
                    'active:scale-[0.98]',
                    'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  )}
                >
                  {t(
                    remotePresentation?.state === 'disabled'
                      ? 'sidebar.mobileDownload.enableRemote'
                      : 'sidebar.mobileDownload.openRemoteSettings',
                  )}
                </button>
              ) : null}
              <button
                ref={primaryActionRef}
                type="button"
                disabled={!downloadUrl}
                onClick={() => {
                  if (downloadUrl) void window.electronAPI.openExternal(downloadUrl);
                }}
                className={cn(
                  'inline-flex items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium',
                  'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)]',
                  'transition-colors hover:bg-[var(--confirm-btn-primary-hover)]',
                  'active:scale-[0.98]',
                  'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
                )}
              >
                {t('sidebar.mobileDownload.openPage')}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
