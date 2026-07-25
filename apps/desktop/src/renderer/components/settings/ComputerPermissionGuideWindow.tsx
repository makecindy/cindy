/**
 * Independent Computer Use permission coach attached to macOS System Settings.
 *
 * The visible card mirrors the web prototype, while its draggable app row
 * starts a native Electron file drag for the actual app bundle that macOS must
 * authorize. The larger transparent window lets the cursor guide animation
 * travel beyond the card without being clipped.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, MousePointer2, X } from 'lucide-react';

import computerIcon from '../../../../../../appicon/computer.png';
import { createLogger } from '@/lib/logger';

const log = createLogger('ComputerPermissionGuideWindow');
// Main restores the mouse-transparent guide after 12s. Prepare the follow-up
// UI just before that restore when Chromium never emits dragend for startDrag.
export const PERMISSION_APP_DRAG_UI_FALLBACK_MS = 11_750;
export const PERMISSION_APP_DRAGGED_STORAGE_KEY = 'xdmaker.computer-permission-app-dragged';

export type ComputerPermissionGuideStep = 'accessibility' | 'screen-recording' | 'complete';
export type ComputerPermissionGuideInteraction = 'drag' | 'dragging' | 'turn-on';

/** 把真实 macOS 权限快照映射成用户可理解的两步引导。 */
export function resolveComputerPermissionGuideStep(
  permissionState: ComputerDriverPermissionState | null | undefined,
): ComputerPermissionGuideStep {
  if (permissionState?.accessibility !== 'granted') return 'accessibility';
  if (
    permissionState.screenRecording !== 'granted'
    || permissionState.screenRecordingCapturable !== 'granted'
  ) {
    return 'screen-recording';
  }
  return 'complete';
}

/** Keeps the instructional demo, native drag, and follow-up action unambiguous. */
export function resolveComputerPermissionGuideInteraction(
  dragging: boolean,
  awaitingUser: boolean,
): ComputerPermissionGuideInteraction {
  if (dragging) return 'dragging';
  if (awaitingUser) return 'turn-on';
  return 'drag';
}

/** Restore the drag hint from this window lifecycle or an explicit query parameter. */
export function resolveComputerPermissionGuideInitialAwaitingUser(
  search: string,
  storedValue?: string | null,
): boolean {
  return new URLSearchParams(search).get('dragged') === '1' || storedValue === '1';
}

function readPermissionAppDraggedState(): boolean {
  try {
    return resolveComputerPermissionGuideInitialAwaitingUser(
      window.location.search,
      window.sessionStorage.getItem(PERMISSION_APP_DRAGGED_STORAGE_KEY),
    );
  } catch {
    return resolveComputerPermissionGuideInitialAwaitingUser(window.location.search);
  }
}

function dragIconDataUrl(image: HTMLImageElement | null): string | null {
  if (!image?.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** Mouse-through focus layer; System Settings remains the real drop target. */
export function ComputerPermissionBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="h-screen w-screen bg-transparent"
    />
  );
}

/** Floating cursor + Drag pill from the approved web interaction. */
function DragCoach() {
  const { t } = useTranslation();
  return (
    <span
      aria-hidden="true"
      className="computer-permission-drag-guide pointer-events-none absolute -top-3 right-8 z-10 inline-flex items-center gap-2 text-[var(--text-primary)]"
    >
      <span className="inline-flex size-10 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <MousePointer2 size={19} strokeWidth={1.8} aria-hidden="true" />
      </span>
      <span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-1.5 text-13 font-medium leading-none">
        {t('settings.computerUse.directControl.permissionGuide.dragHint')}
      </span>
    </span>
  );
}

/** Real System Settings coach, with a native-draggable Computer Use app row. */
export function ComputerPermissionGuideWindow() {
  const { t } = useTranslation();
  const [permissionState, setPermissionState] = useState<ComputerDriverPermissionState | null>(null);
  const [driverIconDataUrl, setDriverIconDataUrl] = useState<string | null>(null);
  const [awaitingUser, setAwaitingUser] = useState(readPermissionAppDraggedState);
  const [dragging, setDragging] = useState(false);
  const iconRef = useRef<HTMLImageElement>(null);
  const dragUiFallbackTimerRef = useRef<number | null>(null);
  const dragAttemptRef = useRef(0);
  const previousStepRef = useRef<ComputerPermissionGuideStep>(resolveComputerPermissionGuideStep(null));
  const step = resolveComputerPermissionGuideStep(permissionState);
  const interaction = resolveComputerPermissionGuideInteraction(dragging, awaitingUser);

  useEffect(() => {
    let cancelled = false;
    const driverIcon = window.electronAPI.maker.computer.driverIcon;
    if (typeof driverIcon === 'function') {
      void driverIcon().then(({ iconDataUrl }) => {
        if (!cancelled) setDriverIconDataUrl(iconDataUrl);
      }).catch((error) => {
        log.debug('permission guide driver icon lookup failed', error);
      });
    }
    void window.electronAPI.maker.computer.permissionGuideStatus().then((status) => {
      if (!cancelled) setPermissionState(status.permissionState ?? null);
    }).catch((error) => {
      log.debug('permission guide initial status snapshot failed', error);
    });
    const onStatusChanged = window.electronAPI.maker.computer.onPermissionGuideStatusChanged;
    const dispose = typeof onStatusChanged === 'function'
      ? onStatusChanged((status) => {
          if (!cancelled) setPermissionState(status.permissionState ?? null);
        })
      : () => undefined;
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (dragUiFallbackTimerRef.current !== null) {
      window.clearTimeout(dragUiFallbackTimerRef.current);
      dragUiFallbackTimerRef.current = null;
    }
    if (previousStepRef.current !== step) {
      dragAttemptRef.current += 1;
      setAwaitingUser(false);
      setDragging(false);
      try {
        window.sessionStorage.removeItem(PERMISSION_APP_DRAGGED_STORAGE_KEY);
      } catch {
        // Restricted profiles do not expose sessionStorage; the main state wins.
      }
      previousStepRef.current = step;
    }
  }, [step]);

  useEffect(() => {
    if (step !== 'complete') return;
    const timer = window.setTimeout(() => window.close(), 1200);
    return () => window.clearTimeout(timer);
  }, [step]);

  useEffect(() => () => {
    dragAttemptRef.current += 1;
    if (dragUiFallbackTimerRef.current !== null) {
      window.clearTimeout(dragUiFallbackTimerRef.current);
    }
    void window.electronAPI.maker.computer.finishPermissionAppDrag(false);
  }, []);

  const cancel = async () => {
    try {
      await window.electronAPI.maker.computer.cancelPermissionGrant();
    } catch (error) {
      log.debug('permission guide cancel failed', error);
      window.close();
    }
  };

  const isAccessibility = step === 'accessibility';
  const label = isAccessibility
    ? t('settings.computerUse.directControl.permissions.accessibilityLabel')
    : t('settings.computerUse.directControl.permissions.screenRecordingLabel');

  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    const iconDataUrl = dragIconDataUrl(iconRef.current);
    if (!iconDataUrl) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.dataTransfer.effectAllowed = 'copy';
    if (dragUiFallbackTimerRef.current !== null) {
      window.clearTimeout(dragUiFallbackTimerRef.current);
    }
    dragAttemptRef.current += 1;
    setAwaitingUser(false);
    setDragging(true);
    window.electronAPI.maker.computer.startPermissionAppDrag(iconDataUrl);
    dragUiFallbackTimerRef.current = window.setTimeout(() => {
      dragUiFallbackTimerRef.current = null;
      setDragging(false);
      setAwaitingUser(false);
    }, PERMISSION_APP_DRAG_UI_FALLBACK_MS);
  };

  const handleDragEnd = async (event: React.DragEvent<HTMLButtonElement>) => {
    if (dragUiFallbackTimerRef.current !== null) {
      window.clearTimeout(dragUiFallbackTimerRef.current);
      dragUiFallbackTimerRef.current = null;
    }
    const didCopy = event.dataTransfer.dropEffect === 'copy';
    const attempt = dragAttemptRef.current;
    setDragging(false);
    let accepted = false;
    try {
      accepted = await window.electronAPI.maker.computer.finishPermissionAppDrag(didCopy);
    } catch (error) {
      log.debug('permission guide drag confirmation failed', error);
    }
    if (dragAttemptRef.current !== attempt) return;
    setAwaitingUser(accepted);
    try {
      if (accepted) {
        window.sessionStorage.setItem(PERMISSION_APP_DRAGGED_STORAGE_KEY, '1');
      } else {
        window.sessionStorage.removeItem(PERMISSION_APP_DRAGGED_STORAGE_KEY);
      }
    } catch {
      // The main-process drag result remains authoritative in restricted profiles.
    }
  };

  return (
    <main className="relative h-screen w-screen select-none overflow-hidden bg-transparent">
      <section className="pointer-events-none absolute inset-0 text-[var(--text-primary)]">
        <div
          className={`pointer-events-auto absolute bottom-3 right-4 flex min-h-[132px] w-[calc(100%_-_28px)] max-w-[432px] flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 transition-[opacity,transform] duration-200 ease-out ${
            dragging ? '!pointer-events-none scale-[0.96] opacity-0' : 'opacity-100'
          }`}
        >
          {step !== 'complete' && interaction === 'drag' && <DragCoach />}

          <header className="flex min-h-7 items-center justify-between text-[var(--text-tertiary)]">
            <span className="font-mono text-11">
              {step === 'complete'
                ? t('settings.computerUse.directControl.permissionGuide.completeEyebrow')
                : t('settings.computerUse.directControl.permissionGuide.step')}
            </span>
            <button
              type="button"
              onClick={() => void cancel()}
              aria-label={t('commonUi.confirmDialog.cancel')}
              className="inline-flex size-7 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
            >
              <X size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </header>

          {step === 'complete' ? (
            <div key="complete" className="animate-confirm-content-in flex flex-1 flex-col justify-center">
              <span className="inline-flex size-10 items-center justify-center rounded-full bg-[var(--surface-chip)]">
                <Check size={19} strokeWidth={2.2} aria-hidden="true" />
              </span>
              <h1 className="mt-2 text-20 font-medium leading-tight">
                {t('settings.computerUse.directControl.permissionGuide.readyTitle')}
              </h1>
              <p className="mt-1 text-12 leading-[1.45] text-[var(--text-secondary)]">
                {t('settings.computerUse.directControl.permissionGuide.readyDescription')}
              </p>
            </div>
          ) : (
            <div key={step} className="animate-confirm-content-in flex flex-1 flex-col">
              <h1 className="mt-1 text-20 font-medium leading-tight">
                {t(
                  interaction === 'turn-on'
                    ? 'settings.computerUse.directControl.permissionGuide.turnOnAppTitle'
                    : 'settings.computerUse.directControl.permissionGuide.dragTitle',
                  { permission: label },
                )}
              </h1>
              <button
                type="button"
                draggable
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                className="mt-3 flex min-h-[64px] w-full cursor-grab items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-chip)] px-3 text-left transition-[transform,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:bg-[var(--surface-hover)] active:cursor-grabbing active:scale-[0.99]"
              >
                <span className="inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-elevated)]">
                  <img
                    ref={iconRef}
                    className="size-full object-contain"
                    src={driverIconDataUrl ?? computerIcon}
                    alt=""
                    draggable={false}
                  />
                </span>
                <span className="min-w-0 flex-1 text-15 font-medium">
                  {t('settings.computerUse.directControl.permissionGuide.appName')}
                </span>
                {awaitingUser && (
                  <span className="inline-flex shrink-0 items-center gap-2 text-11 text-[var(--text-secondary)]">
                    <ArrowRight size={14} strokeWidth={1.8} aria-hidden="true" />
                    {t('settings.computerUse.directControl.permissionGuide.waiting')}
                  </span>
                )}
              </button>
            </div>
          )}
        </div>

        {dragging && (
          <div
            aria-live="polite"
            className="computer-permission-drag-active pointer-events-none absolute bottom-3 right-4 inline-flex h-[52px] w-64 items-center gap-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-[var(--text-primary)]"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)]">
              <MousePointer2 size={16} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-12 font-medium">
                {t('settings.computerUse.directControl.permissionGuide.draggingTitle')}
              </span>
              <span className="block truncate text-11 text-[var(--text-secondary)]">
                {t('settings.computerUse.directControl.permissionGuide.draggingHint', {
                  permission: label,
                })}
              </span>
            </span>
          </div>
        )}
      </section>
    </main>
  );
}
