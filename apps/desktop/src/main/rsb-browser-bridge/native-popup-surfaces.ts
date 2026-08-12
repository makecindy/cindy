import { randomUUID } from 'node:crypto';

import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';

import {
  RSB_NATIVE_POPUP_CLAIM_CHANNEL,
  RSB_NATIVE_POPUP_CLOSE_CHANNEL,
  RSB_NATIVE_POPUP_COMMAND_CHANNEL,
  RSB_NATIVE_POPUP_EVENT_CHANNEL,
  RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL,
  type RsbNativePopupBounds,
  type RsbNativePopupClaimResult,
  type RsbNativePopupCommand,
  type RsbNativePopupEvent,
  type RsbNativePopupSnapshot,
} from '../../shared/rsbNativePopup.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireEnum, requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import type { TabRegistry } from './registry.js';

const log = createLogger('rsb-native-popup-surfaces');

interface SurfaceRecord {
  surfaceId: string;
  view: WebContentsView;
  webContents: WebContents;
  ownerWindow: BrowserWindow;
  ownerWebContents: WebContents | null;
  sessionId: string | null;
  tabId: string | null;
  favicon: string | null;
  crash: { reason: string } | null;
  requestedBounds: RsbNativePopupBounds;
  requestedVisible: boolean;
  openerPinRelease: (() => void) | null;
  popupPinRelease: (() => void) | null;
  claimTimer: ReturnType<typeof setTimeout> | null;
  detachOwnerObservers: (() => void) | null;
}

export const RSB_NATIVE_POPUP_CLAIM_TIMEOUT_MS = 30_000;

const surfaces = new Map<string, SurfaceRecord>();
const managedWebContentsIds = new Set<number>();
let registry: TabRegistry | null = null;
let ipcRegistered = false;

function safeCall<T>(fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function snapshot(record: SurfaceRecord): RsbNativePopupSnapshot {
  const wc = record.webContents;
  return {
    url: safeCall('about:blank', () => wc.getURL() || 'about:blank'),
    title: safeCall('', () => wc.getTitle()),
    favicon: record.favicon,
    isLoading: safeCall(false, () => wc.isLoading()),
    canGoBack: safeCall(false, () => wc.canGoBack()),
    canGoForward: safeCall(false, () => wc.canGoForward()),
    isAudible: safeCall(false, () => wc.isCurrentlyAudible()),
    crash: record.crash,
  };
}

function sendEvent(record: SurfaceRecord, event: RsbNativePopupEvent): void {
  const owner = record.ownerWebContents;
  if (!owner || owner.isDestroyed()) return;
  try {
    owner.send(RSB_NATIVE_POPUP_EVENT_CHANNEL, event);
  } catch (err) {
    log.warn('failed to send native popup event', { surfaceId: record.surfaceId, err });
  }
}

function publishState(record: SurfaceRecord): void {
  if (record.webContents.isDestroyed()) return;
  sendEvent(record, { surfaceId: record.surfaceId, type: 'state', snapshot: snapshot(record) });
}

function resolveViewBounds(record: SurfaceRecord): RsbNativePopupBounds {
  const zoomFactor = safeCall(1, () => record.ownerWebContents?.getZoomFactor() ?? 1);
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const contentBounds = safeCall(
    { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
    () => record.ownerWindow.getContentBounds(),
  );
  const maxWidth = Math.max(1, contentBounds.width);
  const maxHeight = Math.max(1, contentBounds.height);
  const requested = record.requestedBounds;
  const left = Math.min(maxWidth - 1, Math.max(0, Math.floor(requested.x * scale)));
  const top = Math.min(maxHeight - 1, Math.max(0, Math.floor(requested.y * scale)));
  const right = Math.min(
    maxWidth,
    Math.max(left + 1, Math.ceil((requested.x + requested.width) * scale)),
  );
  const bottom = Math.min(
    maxHeight,
    Math.max(top + 1, Math.ceil((requested.y + requested.height) * scale)),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function applyVisibility(record: SurfaceRecord): void {
  const visible = record.requestedVisible && record.crash === null;
  try {
    // Renderer bounds are CSS pixels; WebContentsView expects BrowserWindow
    // content-view DIPs. Electron page zoom changes that ratio.
    record.view.setBounds(resolveViewBounds(record));
    record.view.setVisible(visible);
  } catch (err) {
    log.warn('failed to update native popup view', { surfaceId: record.surfaceId, err });
  }
}

function detachView(record: SurfaceRecord): void {
  try {
    if (!record.ownerWindow.isDestroyed()) {
      record.ownerWindow.contentView.removeChildView(record.view);
    }
  } catch {
    // The owner may be in native teardown; the manager still owns the view/WC.
  }
}

function cleanupSurface(record: SurfaceRecord, notifyClosed: boolean): void {
  if (surfaces.get(record.surfaceId) !== record) return;
  if (notifyClosed) {
    sendEvent(record, { surfaceId: record.surfaceId, type: 'closed' });
  }
  surfaces.delete(record.surfaceId);
  managedWebContentsIds.delete(record.webContents.id);
  if (record.claimTimer) clearTimeout(record.claimTimer);
  record.claimTimer = null;
  record.detachOwnerObservers?.();
  record.detachOwnerObservers = null;
  detachView(record);
  record.openerPinRelease?.();
  record.popupPinRelease?.();
  record.openerPinRelease = null;
  record.popupPinRelease = null;
  if (record.tabId) registry?.release(record.tabId, record.webContents.id);
}

function installSurfaceObservers(record: SurfaceRecord): void {
  const wc = record.webContents;
  const publish = () => publishState(record);
  wc.on('did-start-loading', () => {
    record.crash = null;
    applyVisibility(record);
    publish();
  });
  wc.on('did-stop-loading', publish);
  wc.on('did-navigate', publish);
  wc.on('did-navigate-in-page', publish);
  wc.on('page-title-updated', publish);
  wc.on('page-favicon-updated', (_event, favicons) => {
    record.favicon = favicons.find((candidate) => candidate.trim().length > 0) ?? null;
    publish();
  });
  wc.on('audio-state-changed', publish);
  wc.on('unresponsive', () => {
    record.crash = { reason: 'unresponsive' };
    applyVisibility(record);
    publish();
  });
  wc.on('responsive', () => {
    if (record.crash?.reason !== 'unresponsive') return;
    record.crash = null;
    applyVisibility(record);
    publish();
  });
  wc.on('render-process-gone', (_event, details) => {
    record.crash = { reason: details.reason };
    applyVisibility(record);
    publish();
  });
  wc.once('destroyed', () => cleanupSurface(record, true));
}

/** Adopt Chromium's exact popup WebContents; never create a replacement context. */
export function createRsbNativePopupSurface(
  hostContents: WebContents,
  popupContents: WebContents,
): string | null {
  if (popupContents.isDestroyed()) return null;
  const ownerWindow = BrowserWindow.fromWebContents(hostContents);
  if (!ownerWindow || ownerWindow.isDestroyed()) return null;

  const surfaceId = randomUUID();
  const view = new WebContentsView({ webContents: popupContents });
  const record: SurfaceRecord = {
    surfaceId,
    view,
    webContents: popupContents,
    ownerWindow,
    // The surface id is sent only to this renderer. Recording the owner at
    // creation also lets it dispose an unclaimed surface when tab creation or
    // opener attribution fails.
    ownerWebContents: hostContents,
    sessionId: null,
    tabId: null,
    favicon: null,
    crash: null,
    requestedBounds: { x: 0, y: 0, width: 1, height: 1 },
    requestedVisible: false,
    openerPinRelease: null,
    popupPinRelease: null,
    claimTimer: null,
    detachOwnerObservers: null,
  };
  surfaces.set(surfaceId, record);
  managedWebContentsIds.add(popupContents.id);
  ownerWindow.contentView.addChildView(view);
  view.setBounds(record.requestedBounds);
  view.setVisible(false);
  installSurfaceObservers(record);
  const handleOwnerDestroyed = () => {
    if (surfaces.get(surfaceId) !== record) return;
    cleanupSurface(record, false);
    if (!popupContents.isDestroyed()) popupContents.close();
  };
  const handleOwnerNavigation = (
    _event: Electron.Event,
    _url: string,
    isSameDocument: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || isSameDocument || surfaces.get(surfaceId) !== record) return;
    // A full renderer reload keeps the same host WebContents, but loses the
    // runtime tab↔surface map. Close before the old renderer disappears so a
    // stale view cannot cover the new page or block sidebar reparent forever.
    cleanupSurface(record, true);
    if (!popupContents.isDestroyed()) popupContents.close();
  };
  hostContents.once('destroyed', handleOwnerDestroyed);
  hostContents.on('did-start-navigation', handleOwnerNavigation);
  record.detachOwnerObservers = () => {
    hostContents.removeListener('destroyed', handleOwnerDestroyed);
    hostContents.removeListener('did-start-navigation', handleOwnerNavigation);
  };
  record.claimTimer = setTimeout(() => {
    if (surfaces.get(surfaceId) !== record || record.tabId) return;
    log.warn('disposing unclaimed native popup surface', { surfaceId });
    cleanupSurface(record, false);
    if (!popupContents.isDestroyed()) popupContents.close();
  }, RSB_NATIVE_POPUP_CLAIM_TIMEOUT_MS);
  record.claimTimer.unref?.();
  return surfaceId;
}

/** Pin the ordinary `<webview>` opener while its child still depends on WindowProxy. */
export function attributeRsbNativePopupSurface(surfaceId: string, opener: { tabId: string }): void {
  const record = surfaces.get(surfaceId);
  if (!record || record.openerPinRelease || !registry) return;
  record.openerPinRelease = registry.acquirePinLease(opener.tabId);
}

function findSurfaceOwner(event: IpcMainInvokeEvent, surfaceId: string): SurfaceRecord | null {
  const record = surfaces.get(surfaceId);
  if (!record) return null;
  if (!record.ownerWebContents || record.ownerWebContents.id !== event.sender.id) {
    throwIpcError('PERMISSION_DENIED', 'native popup surface belongs to another window');
  }
  return record;
}

function assertSurfaceOwner(event: IpcMainInvokeEvent, surfaceId: string): SurfaceRecord {
  const record = findSurfaceOwner(event, surfaceId);
  if (!record) throwIpcError('NOT_FOUND', `native popup surface ${surfaceId} not found`);
  return record;
}

function attachToOwner(record: SurfaceRecord, event: IpcMainInvokeEvent): void {
  const nextWindow = BrowserWindow.fromWebContents(event.sender);
  if (!nextWindow || nextWindow.isDestroyed() || nextWindow !== record.ownerWindow) {
    throwIpcError('PERMISSION_DENIED', 'native popup owner window is unavailable');
  }
}

function claimSurface(
  event: IpcMainInvokeEvent,
  surfaceId: string,
  sessionId: string,
  tabId: string,
): RsbNativePopupClaimResult {
  const record = surfaces.get(surfaceId);
  if (!record || record.webContents.isDestroyed()) return { alive: false };
  if (record.ownerWebContents && record.ownerWebContents.id !== event.sender.id) {
    throwIpcError('PERMISSION_DENIED', 'native popup surface belongs to another window');
  }
  if (record.tabId && (record.tabId !== tabId || record.sessionId !== sessionId)) {
    throwIpcError('PERMISSION_DENIED', 'native popup surface is already claimed by another tab');
  }
  attachToOwner(record, event);
  if (record.claimTimer) clearTimeout(record.claimTimer);
  record.claimTimer = null;
  record.sessionId = sessionId;
  record.tabId = tabId;
  registry?.report({ sessionId, tabId, webContentsId: record.webContents.id });
  if (!record.popupPinRelease && registry) {
    record.popupPinRelease = registry.acquirePinLease(tabId);
  }
  return { alive: true, snapshot: snapshot(record) };
}

function isSafeNavigationUrl(raw: string): boolean {
  if (raw.length > 16_384) return false;
  try {
    return ['http:', 'https:', 'file:', 'about:'].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}

function runCommand(record: SurfaceRecord, command: RsbNativePopupCommand): void {
  const wc = record.webContents;
  if (wc.isDestroyed()) throwIpcError('NOT_FOUND', 'native popup WebContents is destroyed');
  if (command.command === 'navigate') {
    if (!isSafeNavigationUrl(command.url)) {
      throwIpcError('INVALID_PARAMS', 'unsupported native popup navigation URL');
    }
    void wc.loadURL(command.url).catch((err) => {
      log.warn('native popup navigation failed', { surfaceId: record.surfaceId, err });
    });
  } else if (command.command === 'reload') {
    record.crash = null;
    applyVisibility(record);
    wc.reload();
  } else if (command.command === 'go-back') {
    if (wc.canGoBack()) wc.goBack();
  } else if (command.command === 'go-forward') {
    if (wc.canGoForward()) wc.goForward();
  } else {
    wc.stop();
  }
}

function parseSurfaceId(payload: Record<string, unknown>): string {
  const surfaceId = requireString(payload.surfaceId, 'surfaceId');
  if (surfaceId.length > 128) throwIpcError('INVALID_PARAMS', 'surfaceId is too long');
  return surfaceId;
}

function parseBounds(value: unknown): RsbNativePopupBounds {
  const raw = requireObject(value, 'bounds');
  const result = {} as RsbNativePopupBounds;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const item = raw[key];
    if (typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item)) {
      throwIpcError('INVALID_PARAMS', `bounds.${key} must be a finite integer`);
    }
    result[key] = item;
  }
  if (result.x < 0 || result.y < 0 || result.width < 1 || result.height < 1) {
    throwIpcError('INVALID_PARAMS', 'bounds must be positive and inside the host viewport');
  }
  if (result.width > 16_384 || result.height > 16_384) {
    throwIpcError('INVALID_PARAMS', 'bounds exceed the maximum native popup size');
  }
  return result;
}

export function registerRsbNativePopupSurfaceIpc(tabRegistry: TabRegistry): void {
  registry = tabRegistry;
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(RSB_NATIVE_POPUP_CLAIM_CHANNEL, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const raw = requireObject(input, 'native popup claim');
    return claimSurface(
      event,
      parseSurfaceId(raw),
      requireString(raw.sessionId, 'sessionId'),
      requireString(raw.tabId, 'tabId'),
    );
  });

  ipcMain.handle(RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const raw = requireObject(input, 'native popup bounds');
    const surfaceId = parseSurfaceId(raw);
    if (typeof raw.visible !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'visible must be boolean');
    }
    const bounds = parseBounds(raw.bounds);
    // window.close() can destroy the native surface while the renderer still
    // has a queued ResizeObserver update. Treat that late cleanup update as a
    // successful no-op; malformed input and foreign live surfaces still fail.
    const record = findSurfaceOwner(event, surfaceId);
    if (!record) return { ok: true };
    record.requestedBounds = bounds;
    record.requestedVisible = raw.visible;
    applyVisibility(record);
    return { ok: true };
  });

  ipcMain.handle(RSB_NATIVE_POPUP_COMMAND_CHANNEL, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const raw = requireObject(input, 'native popup command');
    const record = assertSurfaceOwner(event, parseSurfaceId(raw));
    const command = requireEnum(
      raw.command,
      ['navigate', 'reload', 'go-back', 'go-forward', 'stop'] as const,
      'command',
    );
    const parsed: RsbNativePopupCommand =
      command === 'navigate' ? { command, url: requireString(raw.url, 'url') } : { command };
    runCommand(record, parsed);
    return { ok: true };
  });

  ipcMain.handle(RSB_NATIVE_POPUP_CLOSE_CHANNEL, (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const raw = requireObject(input, 'native popup close');
    const record = findSurfaceOwner(event, parseSurfaceId(raw));
    // Guest window.close and renderer tab cleanup race by design. Closing an
    // already-destroyed surface is idempotent and must not emit a false error.
    if (!record) return { ok: true };
    cleanupSurface(record, false);
    if (!record.webContents.isDestroyed()) record.webContents.close();
    return { ok: true };
  });
}

export function getRsbNativePopupOwnerWebContents(webContentsId: number): WebContents | null {
  for (const record of surfaces.values()) {
    if (record.webContents.id !== webContentsId) continue;
    const owner = record.ownerWebContents;
    return owner && !owner.isDestroyed() ? owner : null;
  }
  return null;
}

export function isRsbNativePopupWebContentsId(webContentsId: number): boolean {
  return managedWebContentsIds.has(webContentsId);
}

export function hasActiveRsbNativePopupSurfaces(): boolean {
  return surfaces.size > 0;
}

/** Test-only reset. */
export function _resetRsbNativePopupSurfacesForTests(): void {
  for (const record of [...surfaces.values()]) {
    cleanupSurface(record, false);
    if (!record.webContents.isDestroyed()) record.webContents.close();
  }
  registry = null;
  ipcRegistered = false;
}
