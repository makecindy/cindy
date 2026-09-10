import {
  app,
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
import { loadDesktopIceServers } from './iceConfig';
import {
  isDesktopPermission,
  REMOTE_DESKTOP_OFFER_BUDGET,
  parseDesktopIceReply,
  type RemoteDesktopIceRequest,
  type RemoteDesktopIceReply,
  type RemoteDesktopLease,
  type RemoteDesktopVideoSettings,
} from '@cindy/device-link';
import {
  DESKTOP_LOCAL,
  type DesktopHostCommand,
  type DesktopHostReply,
} from '../../shared/remoteDesktop';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer';
import { DesktopCaptureWindow } from './captureWindow';
import { denyAppDesktopCapture } from './capturePermissions';
import { readDeviceLinkSettings, writeDeviceLinkSetting } from '../device-link/settings-store';
import { throwIpcError } from '../utils/ipcValidate';
import { RemoteDesktopController } from './controller';
import { desktopCaptureSource, enumerateDesktopSources } from './captureSource';
import { encodeDesktopFrame, encodeNativeRelayFrame } from './frame';
import { transferDesktopClipboard, transferDesktopClipboardContent } from './clipboard';
import { NativeDesktopCapture } from './nativeCapture';
import { readWindowsDesktopSupport, configureWindowsDesktopSupport } from './windowsHost';
import {
  DesktopInputHost,
  readDesktopDisplayModes,
  setDesktopDisplayMode,
  readDesktopInputPermission,
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
        () => desktopCapturer.getSources({
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
const captureWindow = new DesktopCaptureWindow(() => remoteDesktop.stop());
const nativeCapture = new NativeDesktopCapture();
let displayAwake: number | null = null;
let nativeDisplay: string | null = null;
let windowsAvailable = false;
let captureGrant: { source: DesktopCapturerSource; lease: string; audio: boolean } | null = null;
const supportsSystemAudio =
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
  op: 'offer' | 'ice';
  resolve(result: DesktopHostReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
const input = new DesktopInputHost(() => remoteDesktop.stop());
function stopVideo(): void {
  offerGeneration++;
  videoAttempt = undefined;
  nativeOverlay = false;
  nativeSettings = undefined;
  nativeCapture.stop();
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
    let nativeAvailable = process.platform === 'darwin';
    {
      nativeAvailable ||=
        process.platform === 'win32' && (await readWindowsDesktopSupport()) === 'ready';
      try {
        const available = await sources(false, nativeAvailable ? 2000 : REMOTE_DESKTOP_OFFER_BUDGET.sourcesMs);
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
    if (settings?.audio && !supportsSystemAudio) throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
    captureGrant = source ? { source, lease: lease.lease, audio: settings?.audio === true } : null;
    nativeDisplay = nativeAvailable ? lease.display.id : null;
    nativeOverlay = cursorOverlay === true && process.platform === 'darwin';
    nativeSettings = settings;
    setVideoLease(lease.lease);
    videoAttempt = attemptId;
    const result = await requestHost(
      {
        id: randomUUID(),
        op: 'offer',
        sourceId: source?.id,
        nativeCapture: nativeAvailable,
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
  command: DesktopHostCommand & { op: 'offer' | 'ice' },
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
        if (command.op === 'offer') stopVideo();
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

export const remoteDesktop = new RemoteDesktopController({
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
    return {
      version: 1,
      cursorOverlay: process.platform === 'darwin',
      clipboardContent: process.platform === 'darwin' || process.platform === 'win32',
      clipboardText: process.platform === 'darwin' || process.platform === 'win32',
      videoSettings: true,
      trickleIce: true,
      backgroundViewing: true,
      systemAudio: supportsSystemAudio,
      displayModes: process.platform === 'darwin',
      enabled,
      canControl: process.platform === 'darwin' || process.platform === 'win32',
      platform: process.platform,
      ...(enabled ? { permissions: await permissions.read() } : {}),
      displays: enabled
        ? screen.getAllDisplays().map((d, i) => ({
            id: String(d.id),
            name: d.label || `Display ${i + 1}`,
            width: d.size.width,
            height: d.size.height,
          }))
        : [],
    };
  },
  permissions: async (action) => {
    // Dedicated remote-desktop guide only. No remote OS settings URL or opt-in write.
    if (action === 'guide') permissions.show();
    return permissions.read();
  },
  frame: async (displayId, cursorOverlay) => {
    // offer() cancels the previous read before acquiring the capture owner.
    // Leave its required first frame uncontested; relay polling resumes afterwards.
    if (preparingOffer) return null;
    // Compatibility viewers must also wake/capture without waiting for
    // Chromium's thumbnail enumeration, which may hang on a sleeping display.
    if (process.platform === 'darwin' || windowsAvailable) {
      const frame = await nativeCapture.frame(
        displayId,
        cursorOverlay === true && process.platform === 'darwin',
        nativeSettings,
      );
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
  clipboardContent: (action, content, isCurrent) =>
    transferDesktopClipboardContent(action, content, isCurrent, (events) => input.input(events)),
  displayModes: readDesktopDisplayModes,
  resolution: setDesktopDisplayMode,
  startInput: (displayId) => input.start(displayId),
  input: (events) => input.input(events),
  stopInput: () => input.stop(),
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

export function registerRemoteDesktopIpc(isVoiceInputOwner?: Parameters<typeof denyAppDesktopCapture>[1]): void {
  denyAppDesktopCapture(session.defaultSession, isVoiceInputOwner);
  const timer = setInterval(() => remoteDesktop.tick(), 1000);
  timer.unref();
  app.on('before-quit', () => {
    clearInterval(timer);
    permissions.dismiss();
    remoteDesktop.stop();
  });
  screen.on('display-removed', (_event, display) => {
    if (String(display.id) === remoteDesktop.displayId) remoteDesktop.stop();
  });
  screen.on('display-metrics-changed', (_event, display, metrics) => {
    // Work-area changes (lock screen, Dock/menu bar, display wake) do not
    // change whole-screen input coordinates and must not terminate the lease.
    if (
      String(display.id) === remoteDesktop.displayId &&
      metrics.some(
        (metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation',
      )
    )
      remoteDesktop.stop();
  });
  const sessionChanged = () => {
    nativeCapture.stop(); // do not retain pixels from the previous OS session state
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
  };
  powerMonitor.on('lock-screen', sessionChanged);
  powerMonitor.on('unlock-screen', sessionChanged);
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
    const jpeg = await nativeCapture
      .frame(nativeDisplay, nativeOverlay, nativeSettings)
      .catch(() => null);
    if (generation !== offerGeneration || !remoteDesktop.hasLease(lease)) return null;
    return jpeg;
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
      const grant = captureGrant;
      if (
        !grant ||
        host !== owner ||
        request.frame !== owner.mainFrame ||
        !remoteDesktop.hasLease(grant.lease) ||
        !pending ||
        pending.op !== 'offer' ||
        !request.videoRequested
      ) {
        callback({});
        return;
      }
      captureGrant = null;
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
      else if (request.op === 'ice') {
        const result = parseDesktopIceReply(sdp);
        if (result.attemptId !== videoAttempt) throw new Error('DESKTOP_VIDEO_STOPPED');
        request.resolve(result);
      } else throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
    } catch (error) {
      if (request.op === 'offer') stopVideo();
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
