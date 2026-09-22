import {
  desktopCapturer,
  ipcMain,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences,
  type WebContents,
  type DesktopCapturerSource,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { release as osRelease } from 'node:os';
import { loadDesktopIceServers } from './iceConfig';
import { remoteCredentialHost } from './credentialHost';
import {
  isDesktopPermission,
  REMOTE_DESKTOP_OFFER_BUDGET,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  parseDesktopIceReply,
  type RemoteDesktopIceRequest,
  type RemoteDesktopIceReply,
  type RemoteDesktopLease,
  type RemoteDesktopVideoSettings,
} from '@cindy/device-link';
import {
  DESKTOP_LOCAL,
  DESKTOP_AUDIO_RETRY_MS,
  type DesktopHostCommand,
  type DesktopHostReply,
} from '../../shared/remoteDesktop';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { DesktopCaptureWindow } from './captureWindow';
import { denyAppDesktopCapture } from './capturePermissions';
import { readDeviceLinkSettings, writeDeviceLinkSetting } from '../device-link/settings-store';
import { throwIpcError } from '../utils/ipcValidate';
import { RemoteDesktopController } from './controller';
import { ClipboardCounter } from './clipboardCounter';
import { onQuit } from '../lifecycle';
import {
  createViewerDisplay,
  viewerDisplaySupported,
  waitForDisplayRestore,
} from './viewerDisplay';
import { desktopCaptureSource, enumerateDesktopSources } from './captureSource';
import {
  isWaylandDesktop,
  WAYLAND_DISPLAY_ID,
  selectPortalSource,
  waylandDesktopSize,
} from './waylandCapture';
import { encodeDesktopFrame, encodeNativeRelayFrame } from './frame';
import { transferDesktopClipboard, transferDesktopClipboardContent } from './clipboard';
import { NativeDesktopCapture } from './nativeCapture';
import { HyprlandCapture, supportsHyprlandCapture } from './hyprlandCapture';
import { readLinuxDesktopInputSupport } from './linuxInput';
import { LinuxDesktopAudio, supportsLinuxAudio } from './linuxAudio';
import { isLinuxDesktopUnlocked } from './linuxSessionLock';
import { supportsLinuxClipboard, stopLinuxClipboardWriter } from './linuxClipboardNative';
import {
  supportsLinuxDisplay,
  supportsLinuxLock,
  waitForLinuxDisplay,
  linuxMonitors,
  linuxDisplay,
  linuxMonitor,
} from './linuxDesktop';
import { readLinuxCursorSupport } from './linuxCapture';
import { LinuxDesktopMute, supportsLinuxMute } from './linuxMute';
import { PrivacyScreen } from './privacyScreen';
import { LinuxPrivacyScreen, supportsLinuxPrivacy, prepareLinuxPrivacy } from './linuxPrivacy';
import { LinuxWindowActions, supportsOmarchyMenu } from './linuxWindowActions';
import { systemAudioMuteGuard } from '../voice-input/SystemAudioMuteGuard.js';
import { readWindowsDesktopSupport, configureWindowsDesktopSupport } from './windowsHost';
import {
  DesktopInputHost,
  readDesktopDisplayModes,
  setDesktopDisplayMode,
  readDesktopInputPermission,
  resolveDesktopInputBinary,
  readDesktopLockState,
  lockDesktopScreen,
  requestDesktopInputPermission,
} from './inputHost';
import { getDeepLinkMainWindow } from '../deepLink';
import { RemoteDesktopPermissionsService } from './permissions';
import {
  MAC_ACCESSIBILITY_SETTINGS_URL,
  MAC_SCREEN_RECORDING_SETTINGS_URL,
} from '../computer-permission-guide/request';

const permissions = new RemoteDesktopPermissionsService({
  required: process.platform === 'darwin',
  screen: () => {
    const status = systemPreferences.getMediaAccessStatus('screen');
    return status === 'granted' ? 'granted' : status === 'unknown' ? 'unknown' : 'missing';
  },
  accessibility: readDesktopInputPermission,
  request: async (permission, isCurrent, signal) => {
    if (permission === 'accessibility') await requestDesktopInputPermission(isCurrent, signal);
    else
      await enumerateDesktopSources(
        () =>
          desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
          }),
        REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs,
      );
  },
  openSettings: (permission) =>
    shell.openExternal(
      permission === 'screenRecording'
        ? MAC_SCREEN_RECORDING_SETTINGS_URL
        : MAC_ACCESSIBILITY_SETTINGS_URL,
    ),
  showGuide: () => {
    const window = getDeepLinkMainWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  },
});

let host: WebContents | null = null;
const wayland = () => isWaylandDesktop(process.platform, process.env);
let portalReady: Promise<void> | null = null;
let portalGrant = false;
// Electron cannot cancel getSources. Exclusivity belongs to its capture owner;
// a retired owner's late callback must neither grant nor block a replacement.
let portalSelecting: number | null = null;
async function ensurePortalCapture(lease: string): Promise<void> {
  if (!remoteDesktop.hasLease(lease)) throw new Error('DESKTOP_LEASE_EXPIRED');
  if (videoLease === lease && portalReady) return portalReady;
  stopVideo();
  setVideoLease(lease);
  const ready = captureWindow.start();
  host = captureWindow.contents;
  const owner = host;
  const generation = offerGeneration;
  portalGrant = true;
  portalReady = ready.then(() => {
    if (generation !== offerGeneration || host !== owner || !remoteDesktop.hasLease(lease))
      throw new Error('DESKTOP_LEASE_EXPIRED');
    owner!.send(DESKTOP_LOCAL.COMMAND, {
      id: randomUUID(),
      op: 'prepare',
      lease,
      portalCapture: true,
    } satisfies DesktopHostCommand);
  });
  return portalReady;
}
const captureWindow = new DesktopCaptureWindow(() => remoteDesktop.stop());
const nativeCapture = new NativeDesktopCapture();
const hyprlandCapture = new HyprlandCapture();
const linuxAudio = new LinuxDesktopAudio();
const linuxMute = new LinuxDesktopMute();
const linuxWindows = new LinuxWindowActions();
const nativeWayland = () => wayland() && supportsHyprlandCapture();
const portalWayland = () => wayland() && !nativeWayland();
const privacyScreen = new PrivacyScreen(
  (ids) => nativeCapture.setExcludedWindows(ids),
  () => {
    return remoteDesktop
      .stopPrivacyByUser()
      .catch((error) => console.error('[remote-desktop] privacy exit lock failed', error));
  },
  () => input.pauseForPrivacy(),
);
const linuxPrivacy = new LinuxPrivacyScreen(
  () => remoteDesktop.stopPrivacyByUser(),
  () => input.pauseForPrivacy(),
);
const supportsPrivacyScreen =
  (process.platform === 'darwin' &&
    typeof process.getSystemVersion === 'function' &&
    Number(process.getSystemVersion().split('.')[0]) >= 14) ||
  (process.platform === 'win32' && Number(osRelease().split('.')[2]) >= 19041);
let displayAwake: number | null = null;
let nativeDisplay: string | null = null;
let windowsAvailable = false;
let captureGrant: {
  source: DesktopCapturerSource;
  lease: string;
  audio: boolean;
  remaining: number;
  used: boolean;
} | null = null;
const supportsSystemAudio = () =>
  (nativeWayland() && supportsLinuxAudio()) ||
  process.platform === 'win32' ||
  (process.platform === 'darwin' &&
    typeof process.getSystemVersion === 'function' &&
    (() => {
      const [major, minor] = process.getSystemVersion().split('.').map(Number);
      return major > 14 || (major === 14 && minor >= 2);
    })());
let videoLease: string | null = null;
function setVideoLease(lease: string | null): void {
  videoLease = lease;
}
let offerGeneration = 0;
let nativeOverlay = false;
let nativeSettings: RemoteDesktopVideoSettings | undefined;
let preparingOffer = false;
let videoAttempt: string | undefined;
let pending: {
  id: string;
  op: 'offer' | 'ice' | 'frame';
  resolve(result: DesktopHostReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
// A dead input helper or a refused injection is an input failure, not a session
// failure: release control and keep the lease, capture and media running.
const input = new DesktopInputHost(() => remoteDesktop.releaseControl());
const clipboardCounter = new ClipboardCounter(resolveDesktopInputBinary);
function stopVideo(): void {
  offerGeneration++;
  portalReady = null;
  portalGrant = false;
  portalSelecting = null;
  videoAttempt = undefined;
  nativeOverlay = false;
  nativeSettings = undefined;
  nativeCapture.stop();
  hyprlandCapture.stop();
  linuxAudio.stop();
  nativeDisplay = null;
  captureGrant = null;
  setVideoLease(null);
  host = null;
  preparingOffer = false;
  captureWindow.dispose();
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('DESKTOP_VIDEO_STOPPED'));
    pending = null;
  }
}
async function sources(thumbnail = false, timeoutMs = REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs) {
  if (
    process.platform === 'darwin' &&
    systemPreferences.getMediaAccessStatus('screen') !== 'granted'
  )
    throw new Error('DESKTOP_SCREEN_PERMISSION_REQUIRED');
  return enumerateDesktopSources(
    () =>
      desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: thumbnail ? { width: 1280, height: 1280 } : { width: 0, height: 0 },
        fetchWindowIcons: false,
      }),
    timeoutMs,
  );
}
async function offer(
  lease: RemoteDesktopLease,
  sdp: string,
  settings?: RemoteDesktopVideoSettings,
  cursorOverlay?: boolean,
  attemptId?: string,
): Promise<string> {
  if (pending || preparingOffer) throw new Error('DESKTOP_VIDEO_BUSY');
  if (portalWayland()) {
    if (lease.display.id !== WAYLAND_DISPLAY_ID) throw new Error('DESKTOP_DISPLAY_MISSING');
    await ensurePortalCapture(lease.lease);
    // ICE retries replace the peer, not the user-authorized capture stream.
    if (pending || preparingOffer) throw new Error('DESKTOP_VIDEO_BUSY');
    preparingOffer = true;
    const generation = offerGeneration;
    try {
      // Consent has its own bounded lifetime in PortalCaptureStream. Do not
      // spend an SDP attempt waiting for the local user to choose a surface.
      const frame = await requestHost({ id: randomUUID(), op: 'frame', lease: lease.lease }, 2000);
      if (generation !== offerGeneration || !remoteDesktop.hasLease(lease.lease))
        throw new Error('DESKTOP_LEASE_EXPIRED');
      if (frame === null) throw new Error('DESKTOP_CAPTURE_PENDING');
      const iceServers = await loadDesktopIceServers();
      if (generation !== offerGeneration || !remoteDesktop.hasLease(lease.lease))
        throw new Error('DESKTOP_LEASE_EXPIRED');
      videoAttempt = attemptId;
      const result = await requestHost(
        {
          id: randomUUID(),
          op: 'offer',
          lease: lease.lease,
          portalCapture: true,
          sdp,
          settings,
          attemptId,
          iceServers,
        },
        REMOTE_DESKTOP_OFFER_BUDGET.hostMs,
      );
      if (typeof result !== 'string') throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
      return result;
    } finally {
      if (generation === offerGeneration) preparingOffer = false;
    }
  }
  stopVideo();
  preparingOffer = true;
  const generation = offerGeneration;
  const current = () => generation === offerGeneration && remoteDesktop.hasLease(lease.lease);
  try {
    const ready = captureWindow.start();
    host = captureWindow.contents;
    const currentHost = host;
    const [, iceServers] = await Promise.all([ready, loadDesktopIceServers()]);
    if (!current() || host !== currentHost || !currentHost || currentHost.isDestroyed())
      throw new Error('DESKTOP_LEASE_EXPIRED');
    let source: DesktopCapturerSource | null = null;
    const hyprland = nativeWayland();
    if (hyprland && lease.display.id !== WAYLAND_DISPLAY_ID) await linuxMonitor(lease.display.id);
    let nativeAvailable = process.platform === 'darwin' || hyprland;
    if (!hyprland) {
      nativeAvailable ||=
        process.platform === 'win32' && (await readWindowsDesktopSupport()) === 'ready';
      try {
        const available = await sources(
          false,
          nativeAvailable ? 2000 : REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs,
        );
        source = desktopCaptureSource(available, lease.display.id, screen.getAllDisplays());
      } catch (error) {
        // A locked macOS session can reject Chromium's source enumeration even
        // though the user has granted capture. Only the native adapter may recover.
        if (
          !nativeAvailable ||
          (process.platform === 'darwin' &&
            systemPreferences.getMediaAccessStatus('screen') !== 'granted')
        )
          throw error;
      }
    }
    if (!source && !nativeAvailable) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
    if (
      generation !== offerGeneration ||
      !remoteDesktop.hasLease(lease.lease) ||
      host !== currentHost ||
      currentHost.isDestroyed()
    )
      throw new Error('DESKTOP_LEASE_EXPIRED');
    if (settings?.audio && !supportsSystemAudio()) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
    captureGrant = source
      ? {
          source,
          lease: lease.lease,
          audio: settings?.audio === true,
          remaining: settings?.audio ? 1 + DESKTOP_AUDIO_RETRY_MS.length : 1,
          used: false,
        }
      : null;
    nativeDisplay = nativeAvailable ? lease.display.id : null;
    nativeOverlay =
      cursorOverlay === true &&
      (process.platform === 'darwin' ||
        (process.platform === 'win32' && nativeAvailable) ||
        (hyprland && (await readLinuxCursorSupport())));
    if (!current() || host !== currentHost || currentHost.isDestroyed())
      throw new Error('DESKTOP_LEASE_EXPIRED');
    nativeSettings = settings;
    setVideoLease(lease.lease);
    if (hyprland && settings?.audio) {
      const unlocked = await isLinuxDesktopUnlocked();
      if (!current() || host !== currentHost || currentHost.isDestroyed())
        throw new Error('DESKTOP_LEASE_EXPIRED');
      if (unlocked) linuxAudio.start();
      else linuxAudio.stop();
    }
    videoAttempt = attemptId;
    const result = await requestHost(
      {
        id: randomUUID(),
        op: 'offer',
        sourceId: source?.id,
        nativeCapture: nativeAvailable,
        continuousNativeCapture: hyprland,
        nativeAudio: hyprland && settings?.audio === true,
        cursorOverlay: nativeOverlay,
        lease: lease.lease,
        sdp,
        settings,
        attemptId,
        iceServers,
      },
      REMOTE_DESKTOP_OFFER_BUDGET.hostMs,
    );
    if (typeof result !== 'string') throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
    return result;
  } catch (error) {
    if (generation === offerGeneration) stopVideo();
    throw error;
  } finally {
    if (generation === offerGeneration) preparingOffer = false;
  }
}

/** One bounded command to the existing capture owner; never reset the shared device link. */
function requestHost(
  command: DesktopHostCommand & { op: 'offer' | 'ice' | 'frame' },
  timeoutMs: number,
): Promise<DesktopHostReply> {
  const currentHost = host;
  if (!currentHost || currentHost.isDestroyed())
    return Promise.reject(new Error('DESKTOP_VIDEO_UNAVAILABLE'));
  if (pending) return Promise.reject(new Error('DESKTOP_VIDEO_BUSY'));
  return new Promise((resolve, reject) => {
    const { id } = command;
    const timer = setTimeout(() => {
      if (pending?.id === id) {
        pending = null;
        if (command.op === 'offer') {
          if (portalWayland()) {
            try {
              currentHost.send(DESKTOP_LOCAL.COMMAND, { id: randomUUID(), op: 'stop' });
            } catch {
              stopVideo();
            }
          } else stopVideo();
        }
        reject(new Error('DESKTOP_VIDEO_TIMEOUT'));
      }
    }, timeoutMs);
    pending = { id, op: command.op, resolve, reject, timer };
    try {
      currentHost.send(DESKTOP_LOCAL.COMMAND, command);
    } catch {
      stopVideo();
    }
  });
}

async function ice(request: RemoteDesktopIceRequest): Promise<RemoteDesktopIceReply> {
  if (
    request.lease !== videoLease ||
    request.attemptId !== videoAttempt ||
    !remoteDesktop.hasLease(request.lease)
  )
    throw new Error('DESKTOP_VIDEO_STOPPED');
  const generation = offerGeneration;
  const result = await requestHost({ ...request, id: randomUUID() }, 4000);
  if (
    generation !== offerGeneration ||
    request.lease !== videoLease ||
    request.attemptId !== videoAttempt
  )
    throw new Error('DESKTOP_VIDEO_STOPPED');
  return parseDesktopIceReply(result);
}

export async function requestRemoteDesktop(peer: string, value: unknown): Promise<unknown> {
  const settings = readDeviceLinkSettings();
  if (
    !settings.remoteControlEnabled ||
    !settings.remoteDesktopEnabled ||
    settings.revokedControllers.includes(peer)
  )
    throw new Error('DESKTOP_UNAVAILABLE');
  if (
    (process.platform === 'darwin' || process.platform === 'linux') &&
    value !== null &&
    typeof value === 'object' &&
    'op' in value &&
    value.op === 'credential' &&
    'version' in value &&
    value.version === 1 &&
    'kind' in value
  ) {
    if (value.kind === 'status') return { version: 1, state: await readDesktopLockState() };
    if (value.kind === 'prepare') {
      const credentials = remoteCredentialHost.currentToken?.();
      if (!credentials) throw new Error('CREDENTIAL_INVALID_IDENTITY');
      const descriptor = await remoteCredentialHost.configure(
        credentials.realm,
        credentials.membership,
        credentials.authDevice,
        credentials.token,
      );
      return { version: 1, ready: true, descriptor };
    }
  }
  return (process.platform === 'darwin' || process.platform === 'linux') &&
    value !== null &&
    typeof value === 'object' &&
    'op' in value &&
    value.op === 'credential'
    ? remoteCredentialHost.request(peer, value, (body) => remoteDesktop.request(peer, body))
    : remoteDesktop.request(peer, value);
}

export const remoteDesktop: RemoteDesktopController = new RemoteDesktopController({
  prepare: async (current) => {
    if (nativeWayland() && (await supportsLinuxPrivacy())) {
      // Optional privacy support cannot make ordinary viewing unavailable.
      await prepareLinuxPrivacy(current, true).catch(() => {});
    }
  },
  authorized: (peer) => {
    const settings = readDeviceLinkSettings();
    return (
      settings.remoteControlEnabled &&
      settings.remoteDesktopEnabled &&
      !settings.revokedControllers.includes(peer)
    );
  },
  capabilities: async () => {
    windowsAvailable = (await readWindowsDesktopSupport()) === 'ready';
    const settings = readDeviceLinkSettings();
    const enabled = settings.remoteDesktopEnabled && settings.remoteControlEnabled;
    const viewerDisplay = enabled && (await viewerDisplaySupported());
    const linuxDisplays =
      enabled && nativeWayland() && supportsLinuxDisplay()
        ? (await linuxMonitors()).map(linuxDisplay)
        : null;
    return {
      version: 1,
      windowActions: Boolean(linuxDisplays),
      workspaceNavigation: Boolean(linuxDisplays),
      omarchyMenu: Boolean(linuxDisplays) && supportsOmarchyMenu(),
      cursorOverlay:
        process.platform === 'darwin' ||
        (process.platform === 'win32' && windowsAvailable) ||
        Boolean(enabled && nativeWayland() && (await readLinuxCursorSupport())),
      lockOnExit: process.platform === 'darwin' || supportsLinuxLock(),
      clipboardContent:
        process.platform === 'darwin' ||
        process.platform === 'win32' ||
        (supportsLinuxLock() && supportsLinuxClipboard()),
      clipboardSync:
        process.platform === 'darwin' ||
        process.platform === 'win32' ||
        (supportsLinuxLock() && supportsLinuxClipboard()),
      clipboardInline:
        process.platform === 'darwin' ||
        process.platform === 'win32' ||
        (supportsLinuxLock() && supportsLinuxClipboard()),
      privacyScreen:
        supportsPrivacyScreen || (enabled && nativeWayland() && (await supportsLinuxPrivacy())),
      hostMute:
        process.platform === 'darwin' || process.platform === 'win32' || supportsLinuxMute(),
      clipboardText:
        process.platform === 'darwin' ||
        process.platform === 'win32' ||
        (supportsLinuxLock() && supportsLinuxClipboard()),
      videoSettings: true,
      trickleIce: true,
      backgroundViewing: true,
      systemAudio: supportsSystemAudio(),
      viewerDisplay,
      viewerDisplayRestore: viewerDisplay,
      displayModes: process.platform === 'darwin' || Boolean(linuxDisplays?.length),
      enabled,
      canControl:
        process.platform === 'darwin' ||
        process.platform === 'win32' ||
        (enabled && nativeWayland() && (await readLinuxDesktopInputSupport())),
      platform: process.platform,
      ...(enabled ? { permissions: await permissions.read() } : {}),
      displays:
        linuxDisplays ??
        (enabled && wayland()
          ? // PipeWire exposes the user's selection, not a mapping to Electron's
            // physical display IDs. Never label an arbitrary selected screen as monitor 1.
            [
              {
                id: WAYLAND_DISPLAY_ID,
                name: '',
                ...(nativeWayland()
                  ? waylandDesktopSize(screen.getAllDisplays())
                  : { width: 1280, height: 720 }),
              },
            ]
          : enabled
            ? screen.getAllDisplays().map((d, i) => ({
                id: String(d.id),
                name: d.label || `Display ${i + 1}`,
                width: d.size.width,
                height: d.size.height,
              }))
            : []),
    };
  },
  permissions: async (action) => {
    // Dedicated remote-desktop guide only. No remote OS settings URL or opt-in write.
    if (action === 'guide') permissions.show();
    return permissions.read();
  },
  frame: async (displayId, cursorOverlay, lease) => {
    if (nativeWayland()) {
      if (!lease || !remoteDesktop.hasLease(lease)) throw new Error('DESKTOP_LEASE_EXPIRED');
      if (preparingOffer) return null;
      const frame = await hyprlandCapture.frame(displayId, cursorOverlay);
      if (!remoteDesktop.hasLease(lease)) return null;
      return encodeNativeRelayFrame(frame, (jpeg) => nativeImage.createFromBuffer(jpeg));
    }
    if (portalWayland()) {
      if (displayId !== WAYLAND_DISPLAY_ID || !lease) throw new Error('DESKTOP_DISPLAY_MISSING');
      if (pending || preparingOffer) return null;
      await ensurePortalCapture(lease);
      if (pending || preparingOffer) return null;
      const result = await requestHost({ id: randomUUID(), op: 'frame', lease }, 2000);
      return typeof result === 'string' ? result : null;
    }
    // offer() cancels the previous read before acquiring the capture owner.
    // Leave its required first frame uncontested; relay polling resumes afterwards.
    if (preparingOffer) return null;
    // Compatibility viewers must also wake/capture without waiting for
    // Chromium's thumbnail enumeration, which may hang on a sleeping display.
    if (process.platform === 'darwin' || windowsAvailable) {
      const frame = await nativeCapture.frame(displayId, cursorOverlay === true, nativeSettings);
      return encodeNativeRelayFrame(frame, (jpeg) => nativeImage.createFromBuffer(jpeg));
    }
    const available = await sources(true).catch((error) => {
      if (error instanceof Error && error.message === 'DESKTOP_VIDEO_TIMEOUT') return [];
      throw error;
    });
    const source = desktopCaptureSource(available, displayId, screen.getAllDisplays());
    return source ? encodeDesktopFrame(source.thumbnail) : null;
  },
  clipboard: (action, text, isCurrent) =>
    transferDesktopClipboard(action, text, isCurrent, (events) => input.input(events)),
  clipboardContent: (action, content, isCurrent, options) =>
    transferDesktopClipboardContent(
      action,
      content,
      isCurrent,
      (events) => input.input(events),
      options,
    ),
  // Poll counters even for nonportable items; the content read owns format validation.
  clipboardVersion: () => clipboardCounter.read(),
  stopClipboardVersion: () => clipboardCounter.stop(),
  privacyScreen: async (enabled, current) => {
    if (process.platform === 'linux') return linuxPrivacy.set(enabled, current);
    if (!supportsPrivacyScreen) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
    if (enabled && process.platform === 'darwin' && videoLease && nativeDisplay) {
      nativeOverlay = true;
      await privacyScreen.set(true, current);
      try {
        await nativeCapture.preparePrivacy(nativeDisplay, nativeSettings);
      } catch (error) {
        if (current()) privacyScreen.stop();
        throw error;
      }
      if (!current()) {
        throw new Error('DESKTOP_LEASE_EXPIRED');
      }
      return;
    }
    await privacyScreen.set(enabled, current);
    if (!enabled || process.platform === 'win32') return;
    const deadline = Date.now() + 4500;
    while (current() && !nativeCapture.privacyReady && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (!current()) throw new Error('DESKTOP_LEASE_EXPIRED');
    if (!nativeCapture.privacyReady) {
      privacyScreen.stop();
      throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
    }
  },
  stopPrivacyScreen: () => {
    privacyScreen.stop();
    linuxPrivacy.stop();
  },
  windowAction: (action, id, display, current) => {
    if (!nativeWayland()) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
    return linuxWindows.request(action, id, display, current);
  },
  stopWindowActions: () => linuxWindows.stop(),
  hostMute: async (enabled) => {
    if (process.platform === 'linux') return linuxMute.set(enabled);
    if (enabled) await systemAudioMuteGuard.mute('remote-desktop');
    else await systemAudioMuteGuard.restore('remote-desktop');
  },
  stopHostMute: () =>
    process.platform === 'linux'
      ? linuxMute.set(false)
      : systemAudioMuteGuard.restore('remote-desktop'),
  displayModes: readDesktopDisplayModes,
  displayPresent: async (displayId) => {
    if (nativeWayland()) {
      const monitors = await linuxMonitors();
      return displayId === WAYLAND_DISPLAY_ID
        ? monitors.length === 1
        : monitors.some((m) => linuxDisplay(m).id === displayId);
    }
    return screen.getAllDisplays().some((display) => String(display.id) === displayId);
  },
  resolution: async (displayId, modeId, beforeChange, expected) => {
    await setDesktopDisplayMode(displayId, modeId, beforeChange);
    if (nativeWayland()) await waitForLinuxDisplay(displayId, expected, beforeChange);
    else if (expected)
      await waitForDisplayRestore(displayId, expected, beforeChange, (displays) =>
        // Restoration may retire an unplugged monitor; selection must not
        // publish usable geometry for a monitor that no longer exists.
        displays.some((display) => String(display.id) === displayId),
      );
  },
  restoreResolution: async (displayId, modeId, beforeChange, expected) => {
    await setDesktopDisplayMode(displayId, modeId, beforeChange, true);
    if (nativeWayland()) await waitForLinuxDisplay(displayId, expected, beforeChange);
    else await waitForDisplayRestore(displayId, expected, beforeChange);
  },
  createViewerDisplay,
  startInput: async (displayId) => {
    // A portal-selected window is not the whole compositor coordinate space.
    // Never allow a forged control request to drive that view-only fallback.
    if (
      process.platform === 'linux' &&
      (!nativeWayland() || !(await readLinuxDesktopInputSupport()))
    )
      throw new Error('DESKTOP_INPUT_UNSUPPORTED');
    await input.start(displayId);
  },
  input: (events) => {
    try {
      input.input(events);
    } catch (error) {
      // The input host refused before injecting anything (helper gone, or this
      // lease's display is unavailable). Release control so the host and the
      // viewer agree, and so taking control again genuinely restarts the
      // helper instead of being skipped as "already controlling".
      remoteDesktop.releaseControl();
      throw error;
    }
  },
  stopInput: () => input.stop(),
  releaseInput: () => input.release(),
  ...(process.platform === 'darwin' || supportsLinuxLock()
    ? {
        lockScreen: async (isCurrent: () => boolean, signal: AbortSignal) => {
          await input.release();
          await lockDesktopScreen(isCurrent, signal);
        },
      }
    : {}),
  offer,
  ice,
  stopVideo,
  changed: () => {
    // Applies to the viewer lease, not the global remote-control preference.
    // All supported Electron platforms release this assertion on disconnect.
    if (remoteDesktop.state && displayAwake === null)
      displayAwake = powerSaveBlocker.start('prevent-display-sleep');
    else if (!remoteDesktop.state && displayAwake !== null) {
      powerSaveBlocker.stop(displayAwake);
      displayAwake = null;
    }
  },
});

export function registerRemoteDesktopIpc(
  isVoiceInputOwner?: Parameters<typeof denyAppDesktopCapture>[1],
): void {
  denyAppDesktopCapture(session.defaultSession, isVoiceInputOwner);
  const timer = setInterval(() => remoteDesktop.tick(), 1000);
  timer.unref();
  onQuit('remote-desktop-clipboard', stopLinuxClipboardWriter);
  onQuit('remote-desktop-stop', () => {
    clearInterval(timer);
    permissions.dismiss();
    remoteDesktop.stop();
  });
  onQuit('remote-desktop-restore', () => remoteDesktop.stopAndRestore(), 'async');
  const linuxLayoutChanged = () => {
    if (!nativeWayland() || remoteDesktop.changingDisplay || !remoteDesktop.displayId) return;
    const generation = offerGeneration,
      id = remoteDesktop.displayId;
    // The virtual pointer covers the entire layout: even another output moving
    // invalidates its mapping. Release input immediately while checking geometry.
    remoteDesktop.releaseControl();
    void linuxMonitor(id)
      .then((monitor) => {
        if (generation !== offerGeneration || remoteDesktop.changingDisplay) return;
        const display = linuxDisplay(monitor);
        if (!remoteDesktop.displayGeometryMatches(id, display.width, display.height))
          remoteDesktop.stop();
      })
      .catch(() => {
        if (generation === offerGeneration && !remoteDesktop.changingDisplay) remoteDesktop.stop();
      });
  };
  screen.on('display-removed', (_event, display) => {
    linuxLayoutChanged();
    if (remoteDesktop.changingDisplay) return;
    if (String(display.id) === remoteDesktop.displayId) remoteDesktop.stop();
  });
  screen.on('display-added', () => {
    linuxLayoutChanged();
    // A new screen invalidates mask coverage, not the selected capture geometry.
    // Include masks still being prepared, before the controller reports enabled.
    if (privacyScreen.active && !remoteDesktop.changingDisplay) remoteDesktop.stop();
  });
  screen.on('display-metrics-changed', (_event, display, metrics) => {
    if (
      metrics.some(
        (metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation',
      )
    )
      linuxLayoutChanged();
    if (remoteDesktop.changingDisplay) return;
    // Managed resolution changes can deliver scaleFactor after preparation
    // finishes. Matching logical geometry keeps input coordinates valid;
    // rotation still invalidates the lease, even for an unchanged size.
    if (
      String(display.id) === remoteDesktop.displayId &&
      !(
        metrics.every(
          (metric) => metric === 'bounds' || metric === 'workArea' || metric === 'scaleFactor',
        ) &&
        remoteDesktop.displayGeometryMatches(
          String(display.id),
          display.size.width,
          display.size.height,
        )
      ) &&
      metrics.some(
        (metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation',
      )
    )
      remoteDesktop.stop();
  });
  let sessionTransition = 0;
  const sessionChanged = (unlock = false) => {
    const transition = ++sessionTransition;
    nativeCapture.stop(); // do not retain pixels from the previous OS session state
    hyprlandCapture.stop();
    linuxAudio.stop(); // Clear buffered PCM as well as pixels across lock transitions.
    if (remoteDesktop.state?.controlling) {
      try {
        input.input([{ kind: 'release' }]);
      } catch {
        remoteDesktop.stop();
      }
    }
    if (videoLease && nativeDisplay && host && !host.isDestroyed())
      host.send(DESKTOP_LOCAL.COMMAND, {
        id: randomUUID(),
        op: 'capture-reset',
        lease: videoLease,
      } satisfies DesktopHostCommand);
    const lease = videoLease;
    const generation = offerGeneration;
    const owner = host;
    if (unlock && lease && nativeSettings?.audio && nativeWayland()) {
      void isLinuxDesktopUnlocked()
        .then((unlocked) => {
          if (
            !unlocked ||
            transition !== sessionTransition ||
            generation !== offerGeneration ||
            lease !== videoLease ||
            !remoteDesktop.hasLease(lease) ||
            owner !== host ||
            !owner ||
            owner.isDestroyed()
          )
            return;
          linuxAudio.start();
          owner.send(DESKTOP_LOCAL.COMMAND, {
            id: randomUUID(),
            op: 'capture-reset',
            lease,
            nativeAudio: true,
          } satisfies DesktopHostCommand);
        })
        .catch(() => {});
    }
  };
  powerMonitor.on('lock-screen', () => sessionChanged());
  powerMonitor.on('unlock-screen', () => {
    sessionChanged(true);
    void linuxWindows.unlock().catch(() => {});
  });
  ipcMain.handle(DESKTOP_LOCAL.NATIVE_FRAME, async (event, lease: unknown) => {
    captureWindow.assertSender(event);
    if (
      event.sender !== host ||
      typeof lease !== 'string' ||
      lease !== videoLease ||
      !nativeDisplay ||
      !remoteDesktop.hasLease(lease)
    )
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop capture lease');
    const generation = offerGeneration;
    const jpeg = await (
      nativeWayland()
        ? hyprlandCapture.frame(nativeDisplay, nativeOverlay, nativeSettings)
        : nativeCapture.frame(nativeDisplay, nativeOverlay, nativeSettings)
    ).catch(() => null);
    if (generation !== offerGeneration || !remoteDesktop.hasLease(lease)) return null;
    return jpeg;
  });
  ipcMain.handle(DESKTOP_LOCAL.NATIVE_AUDIO, async (event, lease: unknown) => {
    captureWindow.assertSender(event);
    if (
      event.sender !== host ||
      typeof lease !== 'string' ||
      lease !== videoLease ||
      !remoteDesktop.hasLease(lease) ||
      !nativeSettings?.audio ||
      !nativeWayland()
    )
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop audio lease');
    try {
      const generation = offerGeneration;
      const unlocked = await isLinuxDesktopUnlocked();
      // A late check must not read or stop a replacement capture's audio.
      if (generation !== offerGeneration || lease !== videoLease || !remoteDesktop.hasLease(lease))
        throw new Error('DESKTOP_LEASE_EXPIRED');
      if (!unlocked) {
        linuxAudio.stop();
        throw new Error('DESKTOP_LOCKED');
      }
      return linuxAudio.read();
    } catch {
      throwIpcError('PERMISSION_DENIED', 'Desktop audio unavailable');
    }
  });
  ipcMain.handle(DESKTOP_LOCAL.VIEW_HEARTBEAT, (event, lease: unknown) => {
    captureWindow.assertSender(event);
    if (event.sender !== host || typeof lease !== 'string' || lease !== videoLease)
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop viewer heartbeat');
    remoteDesktop.viewHeartbeat(lease);
  });
  ipcMain.handle(DESKTOP_LOCAL.STATE, async (event, checkWindowsSupport: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (checkWindowsSupport !== undefined && typeof checkWindowsSupport !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'Invalid Windows support status request');
    return {
      enabled: readDeviceLinkSettings().remoteDesktopEnabled,
      active: remoteDesktop.state,
      permissionGuide: permissions.guideOpen,
      ...(checkWindowsSupport === true
        ? { windowsSupport: await readWindowsDesktopSupport() }
        : {}),
    };
  });
  let windowsSetupBusy = false;
  ipcMain.handle(DESKTOP_LOCAL.WINDOWS_SUPPORT, async (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (process.platform !== 'win32' || typeof enabled !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'Invalid Windows desktop support request');
    if (event.sender !== getDeepLinkMainWindow()?.webContents || windowsSetupBusy)
      throwIpcError('PERMISSION_DENIED', 'Windows desktop setup unavailable');
    windowsSetupBusy = true;
    remoteDesktop.stop();
    try {
      await configureWindowsDesktopSupport(enabled);
    } catch {
      throwIpcError('PERMISSION_DENIED', 'Windows desktop support setup failed');
    } finally {
      windowsSetupBusy = false;
    }
    windowsAvailable = enabled;
  });
  ipcMain.handle(DESKTOP_LOCAL.ENABLE, async (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid desktop setting');
    await writeDeviceLinkSetting('remoteDesktopEnabled', enabled);
    if (!enabled) {
      remoteDesktop.stop();
      permissions.dismiss();
    } else {
      await permissions.showIfNeeded(() => readDeviceLinkSettings().remoteDesktopEnabled);
    }
  });
  ipcMain.handle(DESKTOP_LOCAL.PERMISSIONS, (event) => {
    assertTrustedAppRendererEvent(event);
    return permissions.read();
  });
  ipcMain.handle(DESKTOP_LOCAL.OPEN_PERMISSION, (event, permission: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!isDesktopPermission(permission))
      throwIpcError('INVALID_PARAMS', 'Invalid desktop permission');
    return permissions.open(permission);
  });
  ipcMain.handle(DESKTOP_LOCAL.DISMISS_GUIDE, (event) => {
    assertTrustedAppRendererEvent(event);
    permissions.dismiss();
  });
  ipcMain.handle(DESKTOP_LOCAL.STOP, (event) => {
    assertTrustedAppRendererEvent(event);
    remoteDesktop.stopByUser();
  });
  ipcMain.handle(DESKTOP_LOCAL.REGISTER, (event) => {
    captureWindow.registered(event);
    const owner = event.sender;
    owner.session.setDisplayMediaRequestHandler((request, callback) => {
      if (portalWayland()) {
        const lease = videoLease;
        if (
          !portalGrant ||
          portalSelecting === offerGeneration ||
          host !== owner ||
          request.frame !== owner.mainFrame ||
          !request.videoRequested ||
          request.audioRequested ||
          !lease ||
          !remoteDesktop.hasLease(lease)
        ) {
          callback({});
          return;
        }
        portalGrant = false;
        const generation = offerGeneration;
        portalSelecting = generation;
        void desktopCapturer
          .getSources({
            types: ['screen'],
            thumbnailSize: { width: 0, height: 0 },
            fetchWindowIcons: false,
          })
          .then((available) => {
            const source = selectPortalSource(available);
            if (
              source &&
              generation === offerGeneration &&
              host === owner &&
              !owner.isDestroyed() &&
              remoteDesktop.hasLease(lease)
            )
              callback({ video: source });
            else callback({});
          })
          .catch(() => {
            // The callback can itself throw if Chromium disposed the request.
            try {
              callback({});
            } catch {
              /* old capture process is already gone */
            }
          })
          .finally(() => {
            if (portalSelecting === generation) portalSelecting = null;
          });
        return;
      }
      const grant = captureGrant;
      if (
        !grant ||
        host !== owner ||
        request.frame !== owner.mainFrame ||
        !remoteDesktop.hasLease(grant.lease) ||
        videoLease !== grant.lease ||
        ((grant.used || pending?.op !== 'offer') && (!grant.audio || !request.audioRequested)) ||
        !request.videoRequested
      ) {
        callback({});
        return;
      }
      // Reuse only this screen/lease's audio-enabled grant, never a general
      // display picker grant. OS permission is checked on every capture.
      grant.used = true;
      if (--grant.remaining === 0) captureGrant = null;
      callback({
        video: grant.source,
        ...(grant.audio && request.audioRequested ? { audio: 'loopback' as const } : {}),
      });
    });
  });
  ipcMain.handle(DESKTOP_LOCAL.CAPTURE_STOP, (event) => {
    captureWindow.assertSender(event);
    remoteDesktop.stop();
  });
  ipcMain.handle(DESKTOP_LOCAL.REPLY, (event, id: unknown, sdp: unknown) => {
    captureWindow.assertSender(event);
    if (event.sender !== host || !pending || id !== pending.id)
      throwIpcError('PERMISSION_DENIED', 'Invalid desktop host reply');
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    try {
      if (
        sdp &&
        typeof sdp === 'object' &&
        'error' in sdp &&
        [
          'DESKTOP_AUDIO_UNAVAILABLE',
          'DESKTOP_VIDEO_UNAVAILABLE',
          'DESKTOP_VIDEO_TIMEOUT',
          'DESKTOP_VIDEO_STOPPED',
        ].includes(String(sdp.error))
      )
        throw new Error(String(sdp.error));
      if (request.op === 'offer' && typeof sdp === 'string' && sdp.length <= 64_000)
        request.resolve(sdp);
      else if (
        request.op === 'frame' &&
        wayland() &&
        (sdp === null ||
          (typeof sdp === 'string' &&
            sdp.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4 &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(sdp)))
      )
        request.resolve(sdp);
      else if (request.op === 'ice') {
        const result = parseDesktopIceReply(sdp);
        if (result.attemptId !== videoAttempt) throw new Error('DESKTOP_VIDEO_STOPPED');
        request.resolve(result);
      } else throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
    } catch (error) {
      if (request.op === 'offer' && !portalWayland()) stopVideo();
      request.reject(error instanceof Error ? error : new Error('DESKTOP_VIDEO_UNAVAILABLE'));
    }
  });
  ipcMain.handle(
    DESKTOP_LOCAL.INPUT,
    (event, lease: unknown, sequence: unknown, events: unknown) => {
      captureWindow.assertSender(event);
      if (
        event.sender !== host ||
        lease !== videoLease ||
        typeof lease !== 'string' ||
        typeof sequence !== 'number'
      )
        throwIpcError('PERMISSION_DENIED', 'Invalid desktop host input');
      try {
        remoteDesktop.input(lease, sequence, events);
      } catch (error) {
        // PiP can revoke control before an in-flight input arrives. Drop that
        // input without closing the DataChannel that also carries view heartbeats.
        if (error instanceof Error && error.message === 'DESKTOP_VIEW_ONLY') return;
        throwIpcError('PERMISSION_DENIED', 'Desktop input rejected');
      }
    },
  );
}
