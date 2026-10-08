import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SlidersHorizontal,
  Clipboard,
  Shield,
  ZoomIn,
  ZoomOut,
  X,
  Monitor,
  createLucideIcon,
} from 'lucide-react';
import {
  REMOTE_DESKTOP_VIDEO_QUALITIES,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopVideoQuality,
} from '@cindy/device-link';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import i18n from '@/i18n';
import {
  clipboardFailureKey,
  DesktopViewerController,
  type ViewerSnapshot,
} from './viewerController';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import {
  fittedChoices,
  ratioLabel,
  recommendedFit,
  sameRatio,
  tagRecommendedModes,
  type ResolutionChoice,
  type ResolutionTier,
  type Size,
} from './displayChoices';

// Fullscreen keeps an 8px toolbar strip visible. Electron drag regions swallow
// hover and macOS slides its own menu bar over the top edge, so reveal is
// pointer-driven and only collapses once the pointer moves back into the stage.
const TOOLBAR_REVEAL_EDGE = 8;
const TOOLBAR_HIDE_MARGIN = 16;

const QUALITY_LABELS = {
  auto: 'remoteDesktop.viewer.automatic',
  saver: 'remoteDesktop.viewer.saver',
  hd: 'remoteDesktop.viewer.hd',
} as const satisfies Record<RemoteDesktopVideoQuality, string>;

const ASPECT_LABELS = {
  original: 'remoteDesktop.viewer.aspectOriginal',
  screen: 'remoteDesktop.viewer.aspectScreen',
  window: 'remoteDesktop.viewer.aspectWindow',
  current: 'remoteDesktop.viewer.aspectCurrent',
} as const;

const TIER_LABELS = {
  same: 'remoteDesktop.viewer.resolutionSame',
  larger: 'remoteDesktop.viewer.resolutionLarger',
  more: 'remoteDesktop.viewer.resolutionMore',
  max: 'remoteDesktop.viewer.resolutionMax',
} as const satisfies Record<ResolutionTier, string>;

/** A clean, standalone remote desktop surface. No App, router, agent or task providers. */
export function RemoteDesktopViewerWindow() {
  const { t } = useTranslation();
  const { isMac, isFullscreen } = useMacFullscreen();
  const api = window.electronAPI.remoteDesktopViewer;
  const root = useRef<HTMLDivElement>(null),
    toolbar = useRef<HTMLElement>(null),
    controller = useRef<DesktopViewerController | null>(null);
  const [state, setState] = useState<ViewerSnapshot | null>(null);
  const [settings, setSettings] = useState<'display' | 'clipboard' | 'security' | null>(null),
    [selectOpen, setSelectOpen] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [closeGeneration, setCloseGeneration] = useState<number | null>(null);
  const [toolbarRevealed, setToolbarRevealed] = useState(false);
  const [modes, setModes] = useState<RemoteDesktopDisplayMode[]>([]);
  const [modesStatus, setModesStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const generation = useRef(-1);
  const latestState = useRef<ViewerSnapshot | null>(null);
  const activePanel = useRef(settings);
  // Only the latest clipboard click reports; queued earlier transfers stay silent.
  const clipboardAttempt = useRef(0);
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
    setToolbarRevealed(false);
    if (!isFullscreen) return;
    const move = (event: PointerEvent) => {
      if (event.clientY <= TOOLBAR_REVEAL_EDGE) setToolbarRevealed(true);
      else if (event.clientY > (toolbar.current?.offsetHeight ?? 0) + TOOLBAR_HIDE_MARGIN)
        setToolbarRevealed(false);
    };
    window.addEventListener('pointermove', move, true);
    return () => window.removeEventListener('pointermove', move, true);
  }, [isFullscreen]);
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
    const hidden = api.onHidden?.((value) => controller.current?.setHidden(value));
    const blur = () => {
      controller.current?.releaseInput();
      void api.inputFocus(generation.current, false).catch(() => {});
    };
    const focus = (event: FocusEvent) => {
      void api
        .inputFocus(generation.current, (event.target as HTMLElement)?.id === 'keyboard-input')
        .catch(() => {});
    };
    // Programmatic blur (Ctrl+Alt+Esc, control loss) has no focusin; release shortcuts here too.
    const focusOut = (event: FocusEvent) => {
      if ((event.target as HTMLElement)?.id !== 'keyboard-input') return;
      void api.inputFocus(generation.current, false).catch(() => {});
    };
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', focusOut);
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
      hidden?.();
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', focusOut);
      window.removeEventListener('blur', blur);
      controller.current?.dispose();
      controller.current = null;
    };
  }, [api, requestClose]);
  const loadModes = () => {
    const owner = generation.current;
    setModesStatus('loading');
    void controller.current
      ?.resolutionModes()
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
    if (open && panel === 'display' && (state?.caps?.displayModes || state?.fittedDisplay))
      loadModes();
  };
  const onSelectOpenChange = (open: boolean) => {
    setSelectOpen(open);
    if (open) controller.current?.releaseInput();
  };
  // The choices below read this window and screen; refresh them while the
  // panel is open and the window is resized or moved to a differently scaled screen.
  const [viewport, setViewport] = useState(0);
  useEffect(() => {
    if (settings !== 'display') return;
    const update = () => setViewport((value) => value + 1);
    const scale = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    window.addEventListener('resize', update);
    scale?.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      scale?.removeEventListener('change', update);
    };
  }, [settings, viewport]);
  // Sizes are in this screen's points: one remote pixel per local point looks the same size.
  const screenSize = { width: window.screen.width, height: window.screen.height };
  const windowSize =
    root.current && root.current.clientWidth > 0 && root.current.clientHeight > 0
      ? { width: root.current.clientWidth, height: root.current.clientHeight }
      : null;
  const ownDisplay = state?.caps?.displays.find((display) => display.id === state.displayId);
  const fitted = state?.fittedDisplay ?? null;
  const showWindow = !!windowSize && !sameRatio(windowSize, screenSize);
  const aspectValue = !fitted
    ? 'original'
    : sameRatio(fitted, screenSize)
      ? 'screen'
      : showWindow && sameRatio(fitted, windowSize)
        ? 'window'
        : 'current';
  // A computer already at this screen's ratio needs no temporary display.
  const showScreen = aspectValue === 'screen' || !sameRatio(ownDisplay, screenSize);
  const aspectOption = (
    value: 'original' | 'screen' | 'window' | 'current',
    size: Size | null | undefined,
    recommended = false,
  ) => {
    const label = [t(ASPECT_LABELS[value]), size && ratioLabel(size)].filter(Boolean).join(' · ');
    return {
      value,
      label: recommended ? t('remoteDesktop.viewer.recommended', { label }) : label,
      disabled: value === 'original' && !!fitted && !state?.caps?.viewerDisplayRestore,
    };
  };
  const aspect = {
    value: aspectValue,
    options: [
      aspectOption('original', ownDisplay, !showScreen),
      ...(showScreen ? [aspectOption('screen', screenSize, true)] : []),
      ...(showWindow ? [aspectOption('window', windowSize)] : []),
      ...(aspectValue === 'current' ? [aspectOption('current', fitted)] : []),
    ],
  };
  // The window choice matches this window's size; the others match this screen.
  const areaFor = (value: string) => (value === 'window' && windowSize ? windowSize : screenSize);
  const applyRatio = (value: 'screen' | 'window') => {
    const ratio = areaFor(value);
    const size = recommendedFit(ratio, ratio);
    if (!size) return Promise.resolve();
    return controller.current?.fitDisplay(size.width, size.height, true, undefined, { ratio });
  };
  const ratioArea = areaFor(aspectValue);
  const currentMode = modes.find((mode) => mode.current);
  const resolutionChoices: ResolutionChoice[] =
    fitted && currentMode
      ? fittedChoices(fitted, ratioArea, currentMode, window.devicePixelRatio)
      : tagRecommendedModes(modes, ratioArea, window.devicePixelRatio);
  const workspaceAction = (action: 'workspaceLeft' | 'workspaceRight' | 'omarchyMenu') => {
    const owner = generation.current;
    void controller.current?.workspaceAction(action).catch(() => {
      if (owner === generation.current) setNotice(t('remoteDesktop.viewer.actionFailed'));
    });
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
        ref={toolbar}
        className="remote-viewer-toolbar"
        data-revealed={toolbarRevealed || undefined}
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
                : state?.ready && state.controlling
                  ? t('remoteDesktop.controlling')
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
          {state?.caps?.workspaceNavigation ? (
            <>
              <ViewerTool
                label={t('remoteDesktop.workspaceLeft')}
                disabled={!state.controlling || state.controlPending}
                onClick={() => workspaceAction('workspaceLeft')}
              >
                <WorkspaceLeftIcon size={16} />
              </ViewerTool>
              <ViewerTool
                label={t('remoteDesktop.workspaceRight')}
                disabled={!state.controlling || state.controlPending}
                onClick={() => workspaceAction('workspaceRight')}
              >
                <WorkspaceRightIcon size={16} />
              </ViewerTool>
            </>
          ) : (
            <>
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
                <AllWindowsIcon size={16} />
              </ViewerTool>
              <ViewerTool
                label={t('remoteDesktop.showDesktop')}
                disabled={!state?.controlling || state.controlPending}
                onClick={() =>
                  // Cmd+F3 only works from the physical Mission Control key; a
                  // synthesized F3 keycode never triggers it. F11 is the default.
                  controller.current?.keys(
                    state?.caps?.platform === 'darwin' ? ['F11'] : ['MetaLeft', 'KeyD'],
                  )
                }
              >
                <ShowDesktopIcon size={16} />
              </ViewerTool>
            </>
          )}
          {state?.caps?.omarchyMenu && (
            <ViewerTool
              label={t('remoteDesktop.omarchyMenu')}
              disabled={!state.controlling || state.controlPending}
              onClick={() => workspaceAction('omarchyMenu')}
            >
              <OmarchyMenuIcon size={16} />
            </ViewerTool>
          )}
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
                  {() => (
                    <SegmentedControl
                      fullWidth
                      aria-label={t('remoteDesktop.viewer.fps')}
                      value={String(state.settings.fps) as '30' | '60'}
                      options={[
                        { value: '30', label: '30 fps' },
                        { value: '60', label: '60 fps' },
                      ]}
                      onValueChange={(value) =>
                        controller.current?.settings({ fps: Number(value) as 30 | 60 })
                      }
                    />
                  )}
                </FormField>
                <FormField
                  label={t('remoteDesktop.viewer.quality')}
                  hint={t('remoteDesktop.viewer.qualityHint')}
                  className="remote-viewer-field"
                >
                  {() => (
                    <SegmentedControl
                      fullWidth
                      aria-label={t('remoteDesktop.viewer.quality')}
                      value={state.settings.quality}
                      options={REMOTE_DESKTOP_VIDEO_QUALITIES.map((value) => ({
                        value,
                        label: t(QUALITY_LABELS[value]),
                      }))}
                      onValueChange={(quality) => controller.current?.settings({ quality })}
                    />
                  )}
                </FormField>
              </>
            )}
            {state?.caps?.viewerDisplay && (
              <FormField
                label={t('remoteDesktop.viewer.aspect')}
                hint={t('remoteDesktop.viewer.aspectHint')}
                className="remote-viewer-field remote-viewer-field-wide"
              >
                {(control) => (
                  <Select
                    {...control}
                    className="w-full"
                    label={t('remoteDesktop.viewer.aspect')}
                    disabled={!state.controlling || state.controlPending}
                    value={aspect.value}
                    options={aspect.options}
                    onValueChange={(value) => {
                      if (value === 'current') return;
                      const owner = generation.current;
                      void (
                        value === 'original'
                          ? controller.current?.restoreDisplay()
                          : applyRatio(value === 'window' ? 'window' : 'screen')
                      )
                        ?.then(loadModes)
                        .catch(() => {
                          if (owner === generation.current)
                            setNotice(t('remoteDesktop.viewer.settingsFailed'));
                        });
                    }}
                    onOpenChange={onSelectOpenChange}
                  />
                )}
              </FormField>
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
            {resolutionChoices.length > 0 && (
              <FormField
                label={t('remoteDesktop.viewer.resolution')}
                hint={
                  resolutionChoices.some((mode) => mode.tier)
                    ? t('remoteDesktop.viewer.resolutionTierHint')
                    : undefined
                }
                className="remote-viewer-field remote-viewer-field-wide"
              >
                {(control) => (
                  <Select
                    {...control}
                    className="w-full"
                    label={t('remoteDesktop.viewer.resolution')}
                    disabled={!state?.controlling || state.controlPending}
                    value={resolutionChoices.find((mode) => mode.current)?.id ?? ''}
                    options={resolutionChoices.map((mode) => ({
                      value: mode.id,
                      label: [
                        `${mode.width} × ${mode.height}`,
                        mode.tier && t(TIER_LABELS[mode.tier]),
                        mode.native && t('remoteDesktop.nativeResolution'),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }))}
                    onValueChange={(value) => {
                      const mode = resolutionChoices.find((item) => item.id === value);
                      if (!mode) return;
                      void controller.current
                        ?.resolution(mode)
                        .then(loadModes)
                        .catch(() => setNotice(t('remoteDesktop.viewer.settingsFailed')));
                    }}
                    onOpenChange={onSelectOpenChange}
                  />
                )}
              </FormField>
            )}

            {(state?.caps?.displayModes || state?.fittedDisplay) && (
              <p>{t('remoteDesktop.viewer.resolutionHint')}</p>
            )}
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
            {network && <div className="remote-viewer-panel-section">{network}</div>}
          </ViewerPanel>
          <ViewerPanel
            label={t('remoteDesktop.viewer.clipboardPanel')}
            icon={<Clipboard size={16} />}
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
                        onClick={() => {
                          const attempt = ++clipboardAttempt.current;
                          setNotice(null);
                          void controller.current?.clipboard(action).catch((error) => {
                            // A stopped connection already shows its own state.
                            if (
                              attempt === clipboardAttempt.current &&
                              !(error instanceof Error && error.message === 'DESKTOP_STOPPED')
                            )
                              setNotice(t(clipboardFailureKey(error, action)));
                          });
                        }}
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
            <p>{t('remoteDesktop.viewer.clipboardShortcutHint')}</p>
          </ViewerPanel>
          <ViewerPanel
            label={t('remoteDesktop.viewer.securityPanel')}
            icon={<Shield size={16} />}
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
                      <label className="remote-viewer-toggle-row" htmlFor="viewer-autoUnlock">
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
                        <label className="remote-viewer-toggle-row" htmlFor="viewer-biometric">
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
        {!state?.closing &&
          (!state?.ready ||
            !state.controlling ||
            state.error ||
            state.status === 'reconnecting') && (
            <div className="remote-viewer-connection" role="status">
              <span>
                {state?.error
                  ? t(
                      state.error === 'connectionBusy' && state.caps?.connectionTakeover
                        ? 'remoteDesktop.connectionBusyTakeover'
                        : `remoteDesktop.${state.error}`,
                    )
                  : t(
                      state?.controlPending
                        ? 'remoteDesktop.viewer.controlPending'
                        : state?.status === 'reconnecting'
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
        {/* Announce the privacy screen to assistive tech without covering the remote picture. */}
        <span className="sr-only" role="status">
          {state?.safety.privacyActive ? t('remoteDesktop.privacyActive') : ''}
        </span>
        {(notice || state?.safety.notice) && (
          <div className="remote-viewer-feedback" role="status">
            <span>{notice ?? t(`remoteDesktop.${state?.safety.notice}`)}</span>
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

// Same glyphs as Mobile's remote desktop toolbar
// (apps/mobile/src/remote-desktop/RemoteDesktopIcons.tsx).
const WorkspaceLeftIcon = createLucideIcon('RemoteDesktopWorkspaceLeft', [
  ['rect', { x: '3', y: '3', width: '18', height: '14', rx: '2', key: 'screen' }],
  ['path', { d: 'M12 17v4M8 21h8M15 10H9m3-3-3 3 3 3', key: 'direction' }],
]);

const WorkspaceRightIcon = createLucideIcon('RemoteDesktopWorkspaceRight', [
  ['rect', { x: '3', y: '3', width: '18', height: '14', rx: '2', key: 'screen' }],
  ['path', { d: 'M12 17v4M8 21h8M9 10h6m-3-3 3 3-3 3', key: 'direction' }],
]);

// Official Omarchy mark: https://omarchy.org/brand/omarchy-logo.svg
// Preserve its path and proportions; inherit the toolbar's Light/Dark foreground.
const OmarchyMenuIcon = createLucideIcon('RemoteDesktopOmarchyMenu', [
  [
    'path',
    {
      d: 'm1200 1200h-480v-80h400v-1040h-479.996v160h-400v720h720v-720h-80v-80h159.996v880h-400v160h-640v-1200h1200zm-1120-80h480v-80h-400l.004-400h-80.004zm0-560h80.004v-400h400v-80h-480.004z',
      transform: 'scale(0.02)',
      fill: 'currentColor',
      fillRule: 'evenodd',
      clipRule: 'evenodd',
      stroke: 'none',
      key: 'official-mark',
    },
  ],
]);

const AllWindowsIcon = createLucideIcon('RemoteDesktopAllWindows', [
  ['path', { d: 'M4 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1', key: 'rear' }],
  ['rect', { x: '7', y: '8', width: '15', height: '13', rx: '2', key: 'front' }],
  ['path', { d: 'M7 12h15', key: 'titlebar' }],
]);

const ShowDesktopIcon = createLucideIcon('RemoteDesktopShowDesktop', [
  ['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2', key: 'screen' }],
  ['path', { d: 'M8 13h8', key: 'dock' }],
  ['path', { d: 'M12 17v4M8 21h8', key: 'stand' }],
]);

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
  return (
    <Tip text={label} side="bottom">
      <Button
        variant="secondary"
        tone="quiet"
        className="remote-viewer-tool"
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
  open,
  restoreFocus,
  onOpenChange,
  children,
}: {
  label: string;
  icon: ReactNode;
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
            variant="secondary"
            tone="quiet"
            className="remote-viewer-tool"
            aria-label={label}
            aria-pressed={open}
          >
            {icon}
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
