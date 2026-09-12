import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  Settings2,
  LogOut,
  Monitor,
  Eye,
  MousePointer2,
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

/** A clean, standalone remote desktop surface. No App, router, agent or task providers. */
export function RemoteDesktopViewerWindow() {
  const { t } = useTranslation();
  const { isMac, isFullscreen } = useMacFullscreen();
  const api = window.electronAPI.remoteDesktopViewer;
  const root = useRef<HTMLDivElement>(null),
    controller = useRef<DesktopViewerController | null>(null);
  const [state, setState] = useState<ViewerSnapshot | null>(null);
  const [settings, setSettings] = useState(false),
    [selectOpen, setSelectOpen] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [closeGeneration, setCloseGeneration] = useState<number | null>(null);
  const [modes, setModes] = useState<RemoteDesktopDisplayMode[]>([]);
  const generation = useRef(-1);
  const requestClose = useCallback(() => {
    controller.current?.releaseInput();
    setSettings(false);
    setSelectOpen(false);
    setCloseGeneration(generation.current);
  }, []);
  useEffect(() => {
    if (!root.current) return;
    controller.current = new DesktopViewerController(api, root.current, setState);
    const off = api.onActive((value) => {
      if (value.generation !== generation.current || !value.active) setCloseGeneration(null);
      generation.current = value.generation;
      if (!value.active) {
        setSettings(false);
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
  const toggleSettings = () => {
    controller.current?.releaseInput();
    setSettings((value) => !value);
    if (state?.caps?.displayModes)
      void controller.current
        ?.displayModes()
        .then(setModes)
        .catch(() => setModes([]));
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
      {state.latency !== null && (
        <span className="remote-viewer-latency"> · {Math.round(state.latency)} ms</span>
      )}
    </span>
  );
  return (
    <div className={`remote-viewer-window ${isFullscreen ? 'remote-viewer-fullscreen' : ''}`}>
      <header
        className="remote-viewer-toolbar"
        data-settings-open={settings || undefined}
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
              {state?.ready
                ? t(state.controlling ? 'remoteDesktop.controlling' : 'remoteDesktop.viewOnly')
                : t('remoteDesktop.connecting')}
            </span>
            {network && <span aria-hidden="true">·</span>}
            {network}
          </div>
        </div>
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
        <Button
          variant="secondary"
          className={action}
          disabled={!state?.ready || !state.caps?.canControl || state.controlPending}
          title={t(
            state?.controlling ? 'remoteDesktop.releaseControl' : 'remoteDesktop.takeControl',
          )}
          aria-label={t(
            state?.controlling ? 'remoteDesktop.releaseControl' : 'remoteDesktop.takeControl',
          )}
          onClick={() => void controller.current?.setControl(!state?.controlling)}
        >
          {state?.controlling ? <MousePointer2 size={16} /> : <Eye size={16} />}
        </Button>
        {state?.caps?.systemAudio && (
          <Button
            variant="secondary"
            className={action}
            aria-label={t('remoteDesktop.viewer.sound')}
            aria-pressed={state.settings.audio}
            onClick={() => controller.current?.settings({ audio: !state.settings.audio })}
          >
            {state.settings.audio ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </Button>
        )}
        <Button
          variant="secondary"
          className={action}
          aria-label={t(
            isFullscreen
              ? 'remoteDesktop.viewer.exitFullscreen'
              : 'remoteDesktop.viewer.fullscreen',
          )}
          onClick={() => void api.fullscreen()}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </Button>
        <Button
          variant="secondary"
          className={action}
          aria-label={t('remoteDesktop.viewer.settings')}
          aria-expanded={settings}
          onClick={toggleSettings}
        >
          <Settings2 size={16} />
        </Button>
        <Button
          variant="secondary"
          className={action}
          aria-label={t('remoteDesktop.disconnect')}
          onClick={requestClose}
        >
          <LogOut size={16} />
        </Button>
        {!isMac && <WindowControls onClose={requestClose} />}
        {settings && (
          <aside className="remote-viewer-settings" aria-label={t('remoteDesktop.viewer.settings')}>
            <div className="flex items-center justify-between">
              <strong>{t('remoteDesktop.viewer.settings')}</strong>
              <Button variant="secondary" className={action} onClick={() => setSettings(false)}>
                {t('remoteDesktop.closePermissionGuide')}
              </Button>
            </div>
            <Button
              variant="secondary"
              className={action}
              onClick={() => controller.current?.fit()}
            >
              {t('remoteDesktop.fit')}
            </Button>
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
                      label: `${mode.width} × ${mode.height}`,
                    }))}
                    onValueChange={(value) =>
                      void controller.current
                        ?.resolution(value)
                        .then(() => setModes([]))
                        .catch(() => setNotice(t('remoteDesktop.viewer.settingsFailed')))
                    }
                    onOpenChange={onSelectOpenChange}
                  />
                )}
              </FormField>
            )}
            {!state?.controlling && (
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
            )}
            <Button
              variant="secondary"
              className={action}
              disabled={!state?.controlling || state.controlPending}
              onClick={() =>
                controller.current?.keys(
                  state?.caps?.platform === 'darwin' ? ['MetaLeft', 'F3'] : ['MetaLeft', 'KeyD'],
                )
              }
            >
              {t('remoteDesktop.showDesktop')}
            </Button>
            <Button
              variant="secondary"
              className={action}
              disabled={!state?.controlling || state.controlPending}
              onClick={() =>
                controller.current?.keys(
                  state?.caps?.platform === 'darwin'
                    ? ['ControlLeft', 'ArrowUp']
                    : ['MetaLeft', 'Tab'],
                )
              }
            >
              {t('remoteDesktop.allWindows')}
            </Button>
            <p>{t('remoteDesktop.viewer.inputHint')}</p>
            {state?.caps?.clipboardText && (
              <p>
                {t('remoteDesktop.viewer.clipboardShortcutHint', {
                  modifier: isMac ? '⌘' : 'Ctrl',
                })}
              </p>
            )}
            {state?.caps?.displayModes && <p>{t('remoteDesktop.viewer.resolutionHint')}</p>}
            {notice && <p role="status">{notice}</p>}
          </aside>
        )}
      </header>
      <div ref={root} className="remote-viewer-content">
        <div id="stage" tabIndex={0} aria-label={t('remoteDesktop.title')}>
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
        {(!state?.ready || state?.error || state?.status === 'reconnecting') && (
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
                  setSettings(true);
                }}
              >
                {t('remoteDesktop.openGuideOnComputer')}
              </Button>
            )}
          </div>
        )}
        {isFullscreen && network && <div className="remote-viewer-network-overlay">{network}</div>}
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
        description={t('remoteDesktop.viewer.confirmDisconnectHint')}
        confirmText={t('remoteDesktop.disconnect')}
        onConfirm={() => {
          if (closeGeneration === null || closeGeneration !== generation.current) return;
          void api.close(closeGeneration).catch(() => {
            if (closeGeneration !== generation.current) return;
            setNotice(t('remoteDesktop.viewer.disconnectFailed'));
            setSettings(true);
          });
        }}
      />
    </div>
  );
}
