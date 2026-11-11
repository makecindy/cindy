import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, ChevronDown, Ellipsis, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { DesktopViewerController, type ViewerSnapshot } from './viewerController';
import { createLiveScreenEmbedApi } from './liveScreenEmbedApi';
import { createTrackpadContactMapper } from './trackpadContacts';
import { LIVE_SCREEN_ICONS, liveScreenToolbarButtons } from './liveScreenButtons';
import './viewerWindow.css';

/**
 * A panel left in the background keeps its connection this long: a computer
 * serves one remote viewer at a time, so a tab nobody looks at gives it back.
 */
const HIDDEN_DISCONNECT_MS = 30_000;
/** Under the device, as on the plugin's own page; an Android device has all three. */
const NAVIGATION_BUTTONS: readonly string[] = ['back', 'home', 'recents'];
const TURN_BUTTONS: readonly string[] = ['rotate-left', 'rotate-right'];

export interface LiveScreenPanelProps {
  deviceId: string;
  /** The computer's name, for the connection only; the panel shows the device. */
  deviceName: string;
  screen: { plugin: string; id: string; name?: string };
  /** The panel is on screen (its tab is selected and the sidebar is open). */
  visible: boolean;
  /** The task's other devices, offered from the device name; picking one shows it here. */
  devices?: readonly { plugin: string; id: string; name: string }[];
  onSelectDevice?(device: { plugin: string; id: string }): void;
}

/**
 * A device screen of another computer (a plugin's live screen, such as a
 * simulator) shown in place, laid out like the same plugin's own task page on
 * that computer: the device name, zoom, a menu with the device's buttons, and
 * the device itself. The mouse is a finger; a device that takes typing takes
 * it after a click. Nothing else of that computer is shown or controlled.
 */
export function LiveScreenPanel({
  deviceId,
  deviceName,
  screen,
  visible,
  devices,
  onSelectDevice,
}: LiveScreenPanelProps) {
  const { t } = useTranslation();
  const bridge = window.electronAPI.liveScreenEmbed;
  const root = useRef<HTMLDivElement>(null);
  const controller = useRef<DesktopViewerController | null>(null);
  const [state, setState] = useState<ViewerSnapshot | null>(null);
  // Bumped to connect again after Main ended the connection.
  const [attempt, setAttempt] = useState(0);
  const [ended, setEnded] = useState(false);
  const [live, setLive] = useState(visible);
  const latest = useRef({ deviceName, name: screen.name, visible });
  latest.current = { deviceName, name: screen.name, visible };

  useEffect(() => {
    if (visible) {
      setLive(true);
      return;
    }
    const timer = setTimeout(() => setLive(false), HIDDEN_DISCONNECT_MS);
    return () => clearTimeout(timer);
  }, [visible]);
  useEffect(() => {
    controller.current?.setHidden(!visible);
  }, [visible]);
  useEffect(() => {
    if (!live || !bridge || !root.current) return;
    setEnded(false);
    const api = createLiveScreenEmbedApi(
      bridge,
      {
        deviceId,
        name: latest.current.deviceName,
        screen: {
          plugin: screen.plugin,
          id: screen.id,
          ...(latest.current.name ? { name: latest.current.name } : {}),
        },
      },
      () => setEnded(true),
    );
    const instance = new DesktopViewerController(api, root.current, setState);
    controller.current = instance;
    instance.setHidden(!latest.current.visible);
    return () => {
      controller.current = null;
      instance.dispose();
      api.dispose();
      setState(null);
    };
  }, [live, attempt, bridge, deviceId, screen.plugin, screen.id]);

  // The trackpad's two real fingers become two touches on the device, as on the
  // plugin's own page. The capture is asked for only while the cursor is over
  // the picture, and belongs to whichever panel the cursor is over.
  const multiTouch = (state?.screen?.maxTouches ?? 0) >= 2 && !!state?.ready && !ended;
  useEffect(() => {
    const host = root.current;
    if (!multiTouch || !bridge?.trackpadStart || !host) return;
    if (window.electronAPI.platform !== 'darwin') return;
    const mapper = createTrackpadContactMapper();
    let pointer = { x: 0, y: 0 };
    let armed = false;
    let asked = 0;
    let over = false;
    const picture = () => host.querySelector('video')?.getBoundingClientRect();
    const arm = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      const rect = picture();
      over =
        !!rect &&
        pointer.x >= rect.left &&
        pointer.x < rect.right &&
        pointer.y >= rect.top &&
        pointer.y < rect.bottom;
      if (!over || armed || event.buttons || Date.now() - asked < 400) return;
      asked = Date.now();
      void bridge
        .trackpadStart()
        .then((started) => {
          armed = started && over;
          if (started && !over) void bridge.trackpadStop().catch(() => {});
        })
        .catch(() => {});
    };
    const disarm = () => {
      over = false;
      mapper.reset();
      if (!armed) return;
      armed = false;
      controller.current?.contacts({ phase: 'cancel', touches: [] });
      void bridge.trackpadStop().catch(() => {});
    };
    // The window stopped being in front: the capture ended by itself.
    const lost = () => {
      armed = false;
      asked = 0;
      mapper.reset();
    };
    const off = bridge.onTrackpadFrame((frame) => {
      if (!armed) return;
      const rect = picture();
      if (!rect) return;
      const mapped = mapper.map(
        frame,
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        pointer,
      );
      if (mapped) controller.current?.contacts(mapped);
    });
    host.addEventListener('pointermove', arm);
    host.addEventListener('pointerdown', arm);
    host.addEventListener('pointerleave', disarm);
    window.addEventListener('blur', lost);
    return () => {
      off();
      host.removeEventListener('pointermove', arm);
      host.removeEventListener('pointerdown', arm);
      host.removeEventListener('pointerleave', disarm);
      window.removeEventListener('blur', lost);
      disarm();
    };
  }, [multiTouch, bridge]);

  const name = state?.screen?.name ?? screen.name ?? t('remoteDesktop.liveScreenTitle');
  const ready = !!state?.ready && state.controlling && !ended;
  const buttons = state?.screen ? liveScreenToolbarButtons(state.screen.buttons) : [];
  // The device's own corners, as a share of its shorter side, in each axis' percent.
  const size = state?.screenSize;
  const corner = state?.screen?.cornerRadius ?? 0;
  const radius =
    size && corner > 0
      ? `${((corner * Math.min(size.width, size.height)) / size.width) * 100}% / ${
          ((corner * Math.min(size.width, size.height)) / size.height) * 100
        }%`
      : '0';
  const failure = ended ? 'disconnected' : state?.error;
  const waiting =
    !ready && !failure
      ? t(
          state?.status === 'reconnecting'
            ? 'remoteDesktop.liveScreenReconnecting'
            : 'remoteDesktop.liveScreenConnecting',
        )
      : null;
  const retry = () => {
    if (ended || !controller.current) setAttempt((value) => value + 1);
    else controller.current.retry();
  };
  const press = (id: string) => controller.current?.press(id);
  // The picture as shown now, to this computer's clipboard (the device itself is not asked).
  const screenshot = async () => {
    const video = root.current?.querySelector('video');
    if (!video?.videoWidth) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('no picture');
      await window.electronAPI.copyPngToClipboard({ png: await blob.arrayBuffer() });
      toast.success(t('rightSidebar.browser.screenshotCopied'));
    } catch {
      toast.error(t('rightSidebar.browser.screenshotFailed'));
    }
  };
  const others = (devices ?? []).filter(
    (device) => device.plugin !== screen.plugin || device.id !== screen.id,
  );
  const chip = (
    <>
      <span
        aria-hidden
        className={
          ready
            ? 'size-2 shrink-0 rounded-full bg-[var(--status-success)]'
            : 'size-2 shrink-0 rounded-full bg-[var(--text-tertiary)]'
        }
      />
      <span className="truncate">{name}</span>
    </>
  );
  const chipClass =
    'flex min-w-0 items-center gap-2 rounded-full border border-[var(--border-default)] px-3 py-1 text-13 text-[var(--text-primary)]';
  const tool = (
    label: string,
    content: React.ReactNode,
    onClick: () => void,
    options: { pressed?: boolean; disabled?: boolean; className?: string } = {},
  ) => (
    <Tip key={label} text={label} side="bottom">
      <Button
        variant="secondary"
        tone="quiet"
        className={options.className ?? 'remote-viewer-tool'}
        aria-label={label}
        aria-pressed={options.pressed}
        disabled={options.disabled ?? (!state?.ready || ended)}
        onClick={onClick}
      >
        {content}
      </Button>
    </Tip>
  );
  // Laid out like the plugin's own page: navigation and turning sit under the
  // device, everything else the device offers is in the menu.
  const deviceTool = (id: string) => {
    const button = buttons.find((item) => item.id === id);
    if (!button) return null;
    const Icon = LIVE_SCREEN_ICONS[button.icon];
    return tool(button.label, <Icon size={16} />, () => press(button.id), { disabled: !ready });
  };
  const navigation = NAVIGATION_BUTTONS.map(deviceTool).filter(Boolean);
  const turning = TURN_BUTTONS.map(deviceTool).filter(Boolean);
  const menuButtons = buttons.filter(
    (button) => !NAVIGATION_BUTTONS.includes(button.id) && !TURN_BUTTONS.includes(button.id),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-2 py-1.5">
        {others.length > 0 && onSelectDevice ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`${chipClass} hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]`}
                title={name}
              >
                {chip}
                <ChevronDown size={14} className="shrink-0 text-[var(--text-secondary)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" data-rsb-territory="">
              {others.map((device) => (
                <DropdownMenuItem
                  key={`${device.plugin}|${device.id}`}
                  onSelect={() => onSelectDevice(device)}
                >
                  {device.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className={chipClass} title={name}>
            {chip}
          </span>
        )}
        <div className="flex-1" />
        <div className="remote-viewer-zoom-group" role="group" aria-label={t('remoteDesktop.fit')}>
          {tool(t('remoteDesktop.zoomOut'), <Minus size={16} />, () =>
            controller.current?.zoom('out'),
          )}
          {tool(
            t('remoteDesktop.fit'),
            t('remoteDesktop.viewer.fitShort'),
            () => controller.current?.fit(),
            {
              pressed: (state?.scaleMode ?? 'fit') === 'fit',
              className: 'remote-viewer-tool live-screen-fit',
            },
          )}
          {tool(t('remoteDesktop.zoomIn'), <Plus size={16} />, () =>
            controller.current?.zoom('in'),
          )}
        </div>
        {menuButtons.length > 0 && (
          <DropdownMenu>
            <Tip text={t('remoteDesktop.keys')} side="bottom">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  tone="quiet"
                  className="remote-viewer-tool"
                  aria-label={t('remoteDesktop.keys')}
                  disabled={!ready}
                >
                  <Ellipsis size={16} />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="end" data-rsb-territory="">
              {menuButtons.map((button) => {
                const Icon = LIVE_SCREEN_ICONS[button.icon];
                return (
                  <DropdownMenuItem
                    key={button.id}
                    className="gap-2"
                    onSelect={() => press(button.id)}
                  >
                    <Icon size={14} className="shrink-0" />
                    <span className="flex-1">{button.label}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div
        ref={root}
        className="remote-viewer-content live-screen-content"
        style={{ '--live-screen-radius': radius } as React.CSSProperties}
      >
        <div id="stage" tabIndex={0} aria-label={name}>
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
          aria-label={name}
        />
        <div id="mouse-buttons" hidden>
          <button type="button" id="mouse-left" />
          <button type="button" id="mouse-right" />
          <button type="button" id="mouse-wheel">
            <span id="mouse-wheel-grip" />
          </button>
        </div>
        {(waiting || failure) && (
          <div className="remote-viewer-connection" role="status">
            <span>
              {failure
                ? t(
                    failure === 'connectionBusy' && state?.caps?.connectionTakeover
                      ? 'remoteDesktop.connectionBusyTakeover'
                      : `remoteDesktop.${failure}`,
                  )
                : waiting}
            </span>
            {failure && (
              <Button variant="secondary" onClick={retry}>
                {t(
                  failure === 'connectionBusy' && state?.caps?.connectionTakeover
                    ? 'remoteDesktop.takeoverConnection'
                    : 'remoteDesktop.connect',
                )}
              </Button>
            )}
          </div>
        )}
      </div>
      {state?.screen && (
        <div className="flex shrink-0 items-center justify-center gap-2 pb-3">
          <div className="remote-viewer-toolgroup" role="group" aria-label={name}>
            {navigation}
            {tool(
              t('rightSidebar.browser.screenshot'),
              <Camera size={16} />,
              () => void screenshot(),
              { disabled: !state.ready || ended },
            )}
          </div>
          {turning.length > 0 && (
            <div
              className="remote-viewer-toolgroup"
              role="group"
              aria-label={t('remoteDesktop.keys')}
            >
              {turning}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
