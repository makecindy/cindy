import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SlidersHorizontal,
  Clipboard,
  Shield,
  AppWindow,
  LayoutGrid,
  ZoomIn,
  ZoomOut,
  X,
  Monitor,
} from 'lucide-react';
import type { RemoteDesktopDisplayMode } from '@cindy/device-link';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import i18n from '@/i18n';
import { DesktopViewerController, type ViewerSnapshot } from './viewerController';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';

/** A clean, standalone remote desktop surface. No App, router, agent or task providers. */
export function RemoteDesktopViewerWindow() {
  const { t } = useTranslation();
  const { isMac, isFullscreen } = useMacFullscreen();
  const api = window.electronAPI.remoteDesktopViewer;
  const root = useRef<HTMLDivElement>(null),
    controller = useRef<DesktopViewerController | null>(null);
  const [state, setState] = useState<ViewerSnapshot | null>(null);
  const [settings, setSettings] = useState<'display' | 'clipboard' | 'security' | null>(null),
    [selectOpen, setSelectOpen] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [closeGeneration, setCloseGeneration] = useState<number | null>(null);
  const [modes, setModes] = useState<RemoteDesktopDisplayMode[]>([]);
  const [modesStatus, setModesStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const generation = useRef(-1);
  const latestState = useRef<ViewerSnapshot | null>(null);
  const activePanel = useRef(settings);
  activePanel.current = settings;
  const requestClose = useCallback(() => {
    controller.current?.releaseInput();
    setSettings(null);
    setSelectOpen(false);
    if (!latestState.current?.ready) {
      const owner = generation.current;
      void controller.current?.close().catch(() => {
        if (owner !== generation.current) return;
        setNotice(i18n.t('remoteDesktop.viewer.disconnectFailed'));
      });
      return;
    }
    setCloseGeneration(generation.current);
  }, []);
  useEffect(() => {
    if (!root.current) return;
    controller.current = new DesktopViewerController(api, root.current, (snapshot) => {
      latestState.current = snapshot;
      setState(snapshot);
    });
    const off = api.onActive((value) => {
      if (value.generation !== generation.current || !value.active) setCloseGeneration(null);
      generation.current = value.generation;
      if (!value.active) {
        setSettings(null);
        setSelectOpen(false);
        setNotice(null);
        setModes([]);
        (document.activeElement as HTMLElement | null)?.blur();
      }
    });
    const locale = api.onLocale((value) => {
      // useTranslation's i18n wrapper changes with the locale. Keep the
      // connection lifetime independent of that presentation-only update.
      void i18n.changeLanguage(value);
    });
    const closeRequested = api.onCloseRequested((value) => {
      if (value === generation.current) requestClose();
    });
    const blur = () => {
      controller.current?.releaseInput();
      void api.inputFocus(generation.current, false).catch(() => {});
    };
    const focus = (event: FocusEvent) => {
      void api
        .inputFocus(generation.current, (event.target as HTMLElement)?.id === 'keyboard-input')
        .catch(() => {});
    };
    document.addEventListener('focusin', focus);
    window.addEventListener('blur', blur);
    void api
      .state()
      .then((value) => {
        generation.current = Math.max(generation.current, value.generation);
      })
      .catch(() => {});
    // The quiet connecting shell is renderable content; network setup never gates opening the window.
    void api
      .rendererReady()
      .then(() => api.presentationReady())
      .catch(() => {});
    return () => {
      off();
      locale();
      closeRequested();
      document.removeEventListener('focusin', focus);
      window.removeEventListener('blur', blur);
      controller.current?.dispose();
      controller.current = null;
    };
  }, [api, requestClose]);
  const loadModes = () => {
    const owner = generation.current;
    setModesStatus('loading');
    void controller.current
      ?.displayModes()
      .then((value) => {
        if (owner !== generation.current) return;
        setModes(value);
        setModesStatus('idle');
      })
      .catch(() => {
        if (owner === generation.current) setModesStatus('failed');
      });
  };
  const openPanel = (panel: 'display' | 'clipboard' | 'security', open: boolean) => {
    controller.current?.releaseInput();
    setSettings((current) => (open ? panel : current === panel ? null : current));
    if (open && panel === 'display' && state?.caps?.displayModes) loadModes();
  };
  const onSelectOpenChange = (open: boolean) => {
    setSelectOpen(open);
    if (open) controller.current?.releaseInput();
  };
  const action = 'remote-viewer-action';
  const network = state?.ready && (
    <span className="remote-viewer-network">
      {t(
        state.transport === 'screenshots'
          ? 'remoteDesktop.screenshotRelay'
          : state.transport === 'relay'
            ? 'remoteDesktop.videoRelay'
            : state.transport === 'direct'
              ? 'remoteDesktop.directConnection'
              : 'remoteDesktop.live',
      )}
      <span>
        {' '}
        ·{' '}
        {state.receiveRate == null
          ? '— KB/s'
          : state.receiveRate >= 1_000_000
            ? `${(state.receiveRate / 1_000_000).toFixed(1)} MB/s`
            : `${Math.round(state.receiveRate / 1000)} KB/s`}
      </span>
      {state.latency !== null && (
        <span className="remote-viewer-latency"> · {Math.round(state.latency)} ms</span>
      )}
    </span>
  );
  const controlPrompt = !state?.controlling && (
    <div className="flex flex-col gap-2" role="status">
      <p>
        {t(
          !state?.ready
            ? 'remoteDesktop.connecting'
            : state.controlPending
              ? 'remoteDesktop.viewer.controlPending'
              : 'remoteDesktop.viewer.controlRequired',
        )}
      </p>
      <Button
        variant="secondary"
        disabled={!state?.ready || !state.caps?.canControl || state.controlPending}
        loading={state?.controlPending}
        onClick={() => void controller.current?.setControl(true)}
      >
        {t('remoteDesktop.takeControl')}
      </Button>
    </div>
  );
  const preference = (key: 'privacyScreen' | 'hostMute' | 'clipboardSync' | 'lockOnExit') =>
    state && (
      <div className="remote-viewer-preference" key={key}>
        <label htmlFor={`viewer-${key}`}>
          <span>{t(`remoteDesktop.${key}`)}</span>
          <Switch
            id={`viewer-${key}`}
            checked={state.preferences[key]}
            disabled={
              !state.ready ||
              state.closing ||
              (!state.caps?.[key] && !state.preferences[key]) ||
              (key !== 'lockOnExit' && !state.controlling && !state.preferences[key])
            }
            onCheckedChange={(enabled) => void controller.current?.preference({ [key]: enabled })}
          />
        </label>
        <p>
          {t(
            !state.ready
              ? 'remoteDesktop.loadingSettings'
              : !state.caps?.[key]
                ? 'remoteDesktop.settingUnsupported'
                : key === 'privacyScreen' && state.safety.privacyActive
                  ? 'remoteDesktop.privacyActive'
                  : `remoteDesktop.${key}Hint`,
          )}
        </p>
      </div>
    );
  return (
    <div
      className={`remote-viewer-window ${isFullscreen ? 'remote-viewer-fullscreen' : ''}`}
      onPointerDownCapture={(event) => {
        if (settings && root.current?.contains(event.target as Node)) {
          event.preventDefault();
          event.stopPropagation();
          setSettings(null);
        }
      }}
    >
      <header
        className="remote-viewer-toolbar"
        data-settings-open={!!settings || undefined}
        data-select-open={selectOpen || undefined}
        style={{ paddingLeft: isMac && !isFullscreen ? 82 : 12 }}
      >
        <Monitor size={16} />
        <div className="remote-viewer-heading">
          <span className="remote-viewer-title">
            {state?.target?.name ?? t('remoteDesktop.title')}
          </span>
          <div className="remote-viewer-status">
            <span>
              {state?.closing
                ? t(
                    state.preferences.lockOnExit && state.caps?.lockOnExit
                      ? 'remoteDesktop.lockingOnExit'
                      : 'remoteDesktop.disconnecting',
                  )
                : state?.ready
                  ? t(state.controlling ? 'remoteDesktop.controlling' : 'remoteDesktop.viewOnly')
                  : t('remoteDesktop.connecting')}
            </span>
            {state?.ready && (
              <span className="remote-viewer-toolbar-network">
                <span aria-hidden="true"> · </span>
                {t(
                  state.transport === 'screenshots'
                    ? 'remoteDesktop.screenshotRelay'
                    : state.transport === 'relay'
                      ? 'remoteDesktop.videoRelay'
                      : state.transport === 'direct'
                        ? 'remoteDesktop.directConnection'
                        : 'remoteDesktop.live',
                )}
              </span>
            )}
          </div>
        </div>
        <div
          className="remote-viewer-toolgroup"
          role="group"
          aria-label={t('remoteDesktop.viewer.controlGroup')}
        >
          <ViewerTool
            label={t('remoteDesktop.allWindows')}
            disabled={!state?.controlling || state.controlPending}
            onClick={() =>
              controller.current?.keys(
                state?.caps?.platform === 'darwin'
                  ? ['ControlLeft', 'ArrowUp']
                  : ['MetaLeft', 'Tab'],
              )
            }
          >
            <LayoutGrid size={16} />
          </ViewerTool>
          <ViewerTool
            label={t('remoteDesktop.showDesktop')}
            disabled={!state?.controlling || state.controlPending}
            onClick={() =>
              controller.current?.keys(
                state?.caps?.platform === 'darwin' ? ['MetaLeft', 'F3'] : ['MetaLeft', 'KeyD'],
              )
            }
          >
            <AppWindow size={16} />
          </ViewerTool>
        </div>
        <div className="remote-viewer-zoom-group" role="group" aria-label={t('remoteDesktop.fit')}>
          <ViewerTool
            label={t('remoteDesktop.zoomOut')}
            disabled={!state?.ready}
            onClick={() => controller.current?.zoom('out')}
          >
            <ZoomOut size={18} />
          </ViewerTool>
          <ViewerTool
            label={t('remoteDesktop.fit')}
            pressed={(state?.scaleMode ?? 'fit') === 'fit'}
            disabled={!state?.ready}
            onClick={() => controller.current?.fit()}
          >
            <ZoomModeIcon />
          </ViewerTool>
          <ViewerTool
            label={t('remoteDesktop.actualSize')}
            pressed={state?.scaleMode === 'actual'}
            disabled={!state?.ready}
            onClick={() => controller.current?.actualSize()}
          >
            <ZoomModeIcon actual />
          </ViewerTool>
          <span className="remote-viewer-zoom-divider" aria-hidden="true" />
          <ViewerTool
            label={t('remoteDesktop.zoomIn')}
            disabled={!state?.ready}
            onClick={() => controller.current?.zoom('in')}
          >
            <ZoomIn size={18} />
          </ViewerTool>
        </div>
        <div
          className="remote-viewer-panels"
          role="group"
          aria-label={t('remoteDesktop.viewer.settings')}
        >
          <ViewerPanel
            label={t('remoteDesktop.viewer.displayPanel')}
            icon={<SlidersHorizontal size={16} />}
            open={settings === 'display'}
            restoreFocus={() => activePanel.current === null}
            onOpenChange={(open) => openPanel('display', open)}
          >
            {(state?.caps?.displays.length ?? 0) > 1 && (
              <Select
                label={t('remoteDesktop.display')}
                className="remote-viewer-display-select"
                value={state?.displayId ?? ''}
                options={
                  state?.caps?.displays.map((display) => ({
                    value: display.id,
                    label: display.name,
                  })) ?? []
                }
                onValueChange={(value) => controller.current?.selectDisplay(value)}
                onOpenChange={onSelectOpenChange}
              />
            )}
            {state?.caps?.videoSettings && (
              <>
                <FormField label={t('remoteDesktop.viewer.fps')} className="remote-viewer-field">
                  {({ id }) => (
                    <Select
                      id={id}
                      className="w-full"
                      label={t('remoteDesktop.viewer.fps')}
                      value={String(state.settings.fps)}
                      options={[
                        { value: '30', label: '30 fps' },
                        { value: '60', label: '60 fps' },
                      ]}
                      onValueChange={(value) =>
                        controller.current?.settings({ fps: Number(value) as 30 | 60 })
                      }
                      onOpenChange={onSelectOpenChange}
                    />
                  )}
                </FormField>
                <FormField
                  label={t('remoteDesktop.viewer.quality')}
                  className="remote-viewer-field"
                >
                  {({ id }) => (
                    <Select
                      id={id}
                      className="w-full"
                      label={t('remoteDesktop.viewer.quality')}
                      value={String(state.settings.bitrate)}
                      options={[0, 2000000, 8000000, 20000000].map((value, index) => ({
                        value: String(value),
                        label: t(
                          `remoteDesktop.viewer.${['automatic', 'smooth', 'balanced', 'clear'][index]}`,
                        ),
                      }))}
                      onValueChange={(value) =>
                        controller.current?.settings({
                          bitrate: Number(value) as 0 | 2000000 | 8000000 | 20000000,
                        })
                      }
                      onOpenChange={onSelectOpenChange}
                    />
                  )}
                </FormField>
              </>
            )}
            {state?.caps?.viewerDisplay && (
              <div className="flex flex-col gap-2">
                <Button
                  variant="secondary"
                  disabled={!state.controlling || state.controlPending}
                  onClick={() => {
                    if (!root.current) return;
                    void controller.current
                      ?.fitDisplay(root.current.clientWidth, root.current.clientHeight)
                      .then(loadModes)
                      .catch(() => setNotice(t('remoteDesktop.viewer.settingsFailed')));
                  }}
                >
                  {t('remoteDesktop.viewer.fitViewerDisplay')}
                </Button>
                <p>{t('remoteDesktop.viewer.fitViewerDisplayHint')}</p>
              </div>
            )}
            {modesStatus === 'loading' && (
              <p role="status">{t('remoteDesktop.loadingDisplayModes')}</p>
            )}
            {modesStatus === 'failed' && (
              <div role="status">
                <p>{t('remoteDesktop.displayModesFailed')}</p>
                <Button variant="secondary" onClick={loadModes}>
                  {t('remoteDesktop.retry')}
                </Button>
              </div>
            )}
            {modes.length > 0 && (
              <FormField
                label={t('remoteDesktop.viewer.resolution')}
                className="remote-viewer-field"
              >
                {({ id }) => (
                  <Select
                    id={id}
                    className="w-full"
                    label={t('remoteDesktop.viewer.resolution')}
                    disabled={!state?.controlling || state.controlPending}
                    value={modes.find((mode) => mode.current)?.id ?? ''}
                    options={modes.map((mode) => ({
                      value: mode.id,
                      label: `${mode.width} × ${mode.height}${mode.native ? ` · ${t('remoteDesktop.nativeResolution')}` : ''}`,
                    }))}
                    onValueChange={(value) =>
                      void controller.current
                        ?.resolution(value)
                        .then(loadModes)
                        .catch(() => setNotice(t('remoteDesktop.viewer.settingsFailed')))
                    }
                    onOpenChange={onSelectOpenChange}
                  />
                )}
              </FormField>
            )}

            {state?.caps?.displayModes && <p>{t('remoteDesktop.viewer.resolutionHint')}</p>}
            <div className="remote-viewer-panel-section">
              <label className="remote-viewer-toggle-row" htmlFor="viewer-audio">
                <span>{t('remoteDesktop.viewer.sound')}</span>
                <Switch
                  id="viewer-audio"
                  checked={state?.settings.audio === true}
                  disabled={!state?.caps?.systemAudio || !state.ready}
                  onCheckedChange={(audio) => controller.current?.settings({ audio })}
                />
              </label>
              {!state?.caps?.systemAudio && (
                <p>
                  {t(
                    state?.ready
                      ? 'remoteDesktop.settingUnsupported'
                      : 'remoteDesktop.loadingSettings',
                  )}
                </p>
              )}
              {preference('hostMute')}
            </div>
            {controlPrompt}
            {network && <div className="remote-viewer-panel-section">{network}</div>}
          </ViewerPanel>
          <ViewerPanel
            label={t('remoteDesktop.viewer.clipboardPanel')}
            icon={<Clipboard size={16} />}
            active={state?.preferences.clipboardSync}
            open={settings === 'clipboard'}
            restoreFocus={() => activePanel.current === null}
            onOpenChange={(open) => openPanel('clipboard', open)}
          >
            {preference('clipboardSync')}
            {state && (
              <>
                {(state.caps?.clipboardText || state.caps?.clipboardContent) && (
                  <div className="flex gap-2">
                    {(['copy', 'paste'] as const).map((action) => (
                      <Button
                        key={action}
                        variant="secondary"
                        disabled={!state.controlling || state.closing}
                        onClick={() =>
                          void controller.current
                            ?.clipboard(action)
                            .catch(() => setNotice(t('remoteDesktop.viewer.clipboardFailed')))
                        }
                      >
                        {t(`remoteDesktop.${action}`)}
                      </Button>
                    ))}
                  </div>
                )}
                {state.safety.clipboardProgress !== null && (
                  <progress
                    aria-label={t('remoteDesktop.clipboardSync')}
                    max={1}
                    value={state.safety.clipboardProgress}
                  />
                )}
              </>
            )}
            <p>
              {t('remoteDesktop.viewer.clipboardShortcutHint', { modifier: isMac ? '⌘' : 'Ctrl' })}
            </p>
            {controlPrompt}
          </ViewerPanel>
          <ViewerPanel
            label={t('remoteDesktop.viewer.securityPanel')}
            icon={<Shield size={16} />}
            active={state?.safety.privacyActive}
            open={settings === 'security'}
            restoreFocus={() => activePanel.current === null}
            onOpenChange={(open) => openPanel('security', open)}
          >
            {preference('privacyScreen')}
            {preference('lockOnExit')}
            <div className="remote-viewer-panel-section">
              {state && (
                <>
                  {isMac && state.caps?.platform === 'darwin' && (
                    <div className="flex flex-col gap-2">
                      <label
                        className="flex items-center justify-between gap-3"
                        htmlFor="viewer-autoUnlock"
                      >
                        <span>{t('remoteDesktop.autoUnlock')}</span>
                        <Switch
                          id="viewer-autoUnlock"
                          checked={state.credential?.autoUnlock === true}
                          disabled={!state.ready || state.closing || state.credentialBusy}
                          onCheckedChange={(enabled) =>
                            void controller.current?.credential(enabled ? 'enable' : 'disable')
                          }
                        />
                      </label>
                      <p>{t('remoteDesktop.autoUnlockHint')}</p>
                      {state.credential?.autoUnlock && (
                        <label
                          className="flex items-center justify-between gap-3"
                          htmlFor="viewer-biometric"
                        >
                          <span>{t('remoteDesktop.biometricVerification')}</span>
                          <Switch
                            id="viewer-biometric"
                            checked={state.credential.biometricVerification}
                            disabled={
                              state.credentialBusy ||
                              (!state.credential.biometricAvailable &&
                                !state.credential.biometricVerification)
                            }
                            onCheckedChange={(enabled) =>
                              void controller.current?.credential('biometric', enabled)
                            }
                          />
                        </label>
                      )}
                      <p>{t('remoteDesktop.autoUnlockStorageHint')}</p>
                      {state.credentialBusy && (
                        <p role="status">{t('remoteDesktop.loadingSettings')}</p>
                      )}
                      {state.credentialNotice && (
                        <div role="alert">
                          <p>{t(`remoteDesktop.${state.credentialNotice}`)}</p>
                          <Button
                            variant="secondary"
                            onClick={() => controller.current?.retryCredential()}
                          >
                            {t('remoteDesktop.retry')}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            {controlPrompt}
          </ViewerPanel>
        </div>
        {!isMac && <WindowControls onClose={requestClose} />}
      </header>
      <div ref={root} className="remote-viewer-content">
        <div id="stage" tabIndex={0} aria-label={t('remoteDesktop.title')}>
          <div id="bg" aria-hidden="true">
            <canvas id="bg-canvas" />
          </div>
          <img id="image" alt="" />
          <video id="video" autoPlay muted playsInline />
          <div id="cursor">
            <img id="cursor-image" alt="" />
          </div>
        </div>
        <textarea
          id="keyboard-input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={t('remoteDesktop.viewer.inputHint')}
        />
        <div id="mouse-buttons" hidden>
          <Button variant="secondary" id="mouse-left" />
          <Button variant="secondary" id="mouse-right" />
          <Button variant="secondary" id="mouse-wheel">
            <span id="mouse-wheel-grip" />
          </Button>
        </div>
        {!state?.closing && (!state?.ready || state?.error || state?.status === 'reconnecting') && (
          <div className="remote-viewer-connection" role="status">
            <span>
              {state?.error
                ? t(
                    state.error === 'connectionBusy' && state.caps?.connectionTakeover
                      ? 'remoteDesktop.connectionBusyTakeover'
                      : `remoteDesktop.${state.error}`,
                  )
                : t(
                    state?.status === 'reconnecting'
                      ? 'remoteDesktop.reconnecting'
                      : 'remoteDesktop.connecting',
                  )}
            </span>
            {state?.error && (
              <Button
                variant="secondary"
                className={action}
                onClick={() => controller.current?.retry()}
              >
                {t(
                  state.error === 'connectionBusy' && state.caps?.connectionTakeover
                    ? 'remoteDesktop.takeoverConnection'
                    : 'remoteDesktop.connect',
                )}
              </Button>
            )}
            {state?.error === 'permissionHint' && (
              <Button
                variant="secondary"
                className={action}
                onClick={() => {
                  void controller.current
                    ?.permissionGuide()
                    .then(() => setNotice(t('remoteDesktop.permissionGuideOpened')))
                    .catch(() => setNotice(t('remoteDesktop.permissionActionFailed')));
                  setSettings('security');
                }}
              >
                {t('remoteDesktop.openGuideOnComputer')}
              </Button>
            )}
          </div>
        )}
        {isFullscreen && network && <div className="remote-viewer-network-overlay">{network}</div>}
        {(notice || state?.safety.notice || state?.safety.privacyActive) && (
          <div className="remote-viewer-feedback" role="status">
            {state?.safety.privacyActive && <Shield size={14} aria-hidden="true" />}
            <span>
              {notice ??
                (state?.safety.notice
                  ? t(`remoteDesktop.${state.safety.notice}`)
                  : t('remoteDesktop.privacyActive'))}
            </span>
            {state?.safety.notice && (
              <Button
                variant="secondary"
                onClick={() => void controller.current?.refreshSafety(true)}
              >
                {t('remoteDesktop.retry')}
              </Button>
            )}
            {notice && (
              <ViewerTool
                label={t('remoteDesktop.closePermissionGuide')}
                onClick={() => setNotice(null)}
              >
                <X size={14} />
              </ViewerTool>
            )}
          </div>
        )}
        {state?.clipboardError && (
          <div className="remote-viewer-notice" role="status">
            {t('remoteDesktop.viewer.clipboardFailed')}
          </div>
        )}
      </div>
      <ConfirmDialog
        presentation="standard"
        open={closeGeneration !== null}
        onOpenChange={(open) => {
          if (!open) setCloseGeneration(null);
        }}
        title={t('remoteDesktop.viewer.confirmDisconnect')}
        description={
          t('remoteDesktop.viewer.confirmDisconnectHint') +
          (state?.preferences.lockOnExit && state.caps?.lockOnExit
            ? ` ${t('remoteDesktop.lockOnExitHint')}`
            : '')
        }
        confirmText={t('remoteDesktop.disconnect')}
        onConfirm={() => {
          if (closeGeneration === null || closeGeneration !== generation.current) return;
          void controller.current?.close().catch(() => {
            if (closeGeneration !== generation.current) return;
            setNotice(
              t(
                state?.preferences.lockOnExit && state.caps?.lockOnExit
                  ? 'remoteDesktop.lockOnExitFailed'
                  : 'remoteDesktop.viewer.disconnectFailed',
              ),
            );
            setSettings('security');
          });
        }}
      />
    </div>
  );
}

function ZoomModeIcon({ actual = false }: { actual?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      {actual ? (
        <path d="m9 9 2-2v8m-2 0h4" />
      ) : (
        <path
          fill="currentColor"
          stroke="none"
          d="M11 5.5 8.5 8.5h5ZM16.5 11l-3-2.5v5ZM11 16.5l2.5-3h-5ZM5.5 11l3 2.5v-5Z"
        />
      )}
    </svg>
  );
}

function ViewerTool({
  label,
  children,
  onClick,
  disabled,
  pressed,
}: {
  label: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tip text={disabled ? t('remoteDesktop.viewer.controlRequired') : label} side="bottom">
      <Button
        variant="secondary"
        className="remote-viewer-icon"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tip>
  );
}

function ViewerPanel({
  label,
  icon,
  active,
  open,
  restoreFocus,
  onOpenChange,
  children,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  open: boolean;
  restoreFocus(): boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Tip text={label} side="bottom">
          <Button
            variant={open ? 'primary' : 'secondary'}
            className="remote-viewer-panel-trigger"
            aria-label={label}
            aria-pressed={open}
          >
            {icon}
            {active && <span className="remote-viewer-active-dot" aria-hidden="true" />}
          </Button>
        </Tip>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        align="end"
        sideOffset={10}
        collisionPadding={12}
        aria-label={label}
        className="remote-viewer-popover rounded-xl shadow-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocus()) event.preventDefault();
        }}
      >
        <div className="remote-viewer-panel-heading">
          <strong>{label}</strong>
          <ViewerTool
            label={t('remoteDesktop.closePermissionGuide')}
            onClick={() => onOpenChange(false)}
          >
            <X size={16} />
          </ViewerTool>
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}
