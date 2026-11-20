import { BrowserWindow, type WebContents } from 'electron';
import {
  LIVE_SCREEN_ID,
  LIVE_SCREEN_PLUGIN_ID,
  type DesktopIceServer,
  type RemoteDesktopRequest,
} from '@cindy/device-link';
import {
  LIVE_SCREEN_EMBED,
  LIVE_SCREEN_EMBED_ID,
  type RemoteViewerState,
  type RemoteViewerTarget,
} from '../../shared/remoteDesktopViewer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { RemoteViewerConnection } from './connection.js';

/** Panels one app window may show at once; a task shows one device at a time. */
const MAX_PER_SENDER = 4;

/**
 * One connection per page and device. A panel that is mounted again (the tab
 * was hidden for a while, the user reconnects) binds the same connection, so
 * giving back the previous lease always finishes before the next one starts;
 * `embedId` names the panel that currently owns it.
 */
type Entry = {
  sender: WebContents;
  scope: string;
  embedId: string | null;
  connection: RemoteViewerConnection;
};

/**
 * Device screens (a plugin's live screen on another computer) shown inside an
 * app window, such as a task's sidebar tab. Each mounted panel gets its own
 * connection with the same authority rules as a viewer window: Main binds the
 * target, checks every request and retires the lease when the page goes away.
 * Only device screens are served here; a whole desktop always has its own window.
 */
export class EmbeddedLiveScreens {
  private entries = new Map<string, Entry>();
  private watched = new WeakSet<WebContents>();
  constructor(
    private readonly deps: {
      owner(): string;
      available(): boolean;
      selfDeviceId(): string | null | undefined;
      request(deviceId: string, request: RemoteDesktopRequest, check: () => void): Promise<unknown>;
      ice(): Promise<DesktopIceServer[]>;
    },
  ) {}
  private owned(sender: WebContents, embedId: unknown): Entry | undefined {
    if (typeof embedId !== 'string') return undefined;
    for (const entry of this.entries.values())
      if (entry.sender === sender && entry.embedId === embedId) return entry;
    return undefined;
  }
  private entry(sender: WebContents, embedId: unknown): Entry {
    const entry = this.owned(sender, embedId);
    if (!entry) throwIpcError('PRECONDITION_FAILED', 'DESKTOP_STOPPED');
    return entry;
  }
  open(sender: WebContents, embedId: unknown, value: unknown): RemoteViewerState {
    if (!this.deps.available()) throwIpcError('PERMISSION_DENIED', 'Remote desktop unavailable');
    const target = value as Partial<RemoteViewerTarget> | null;
    const screen = target?.screen;
    if (
      typeof embedId !== 'string' ||
      !LIVE_SCREEN_EMBED_ID.test(embedId) ||
      !target ||
      typeof target !== 'object' ||
      typeof target.deviceId !== 'string' ||
      !target.deviceId.trim() ||
      target.deviceId.length > 256 ||
      target.deviceId === this.deps.selfDeviceId() ||
      typeof target.name !== 'string' ||
      target.name.length > 256 ||
      target.handoff !== undefined ||
      !screen ||
      typeof screen !== 'object' ||
      typeof screen.plugin !== 'string' ||
      !LIVE_SCREEN_PLUGIN_ID.test(screen.plugin) ||
      typeof screen.id !== 'string' ||
      !LIVE_SCREEN_ID.test(screen.id) ||
      (screen.name !== undefined && (typeof screen.name !== 'string' || screen.name.length > 256))
    )
      throwIpcError('INVALID_PARAMS', 'Invalid device screen target');
    // An id names one mounted panel; whatever it showed before ends.
    const previous = this.owned(sender, embedId);
    if (previous) this.retire(previous, false);
    const scope = `${sender.id}\0${target.deviceId}\0${screen.plugin}\0${screen.id}`;
    let entry = this.entries.get(scope);
    if (!entry) {
      const mine = [...this.entries.values()].filter((item) => item.sender === sender);
      // Connections nobody shows any more make room first.
      for (const idle of mine
        .filter((item) => !item.embedId)
        .slice(0, Math.max(0, mine.length + 1 - MAX_PER_SENDER)))
        this.entries.delete(idle.scope);
      if (
        [...this.entries.values()].filter((item) => item.sender === sender).length >= MAX_PER_SENDER
      )
        throwIpcError('PRECONDITION_FAILED', 'DESKTOP_BUSY');
      const created: Entry = {
        sender,
        scope,
        embedId: null,
        connection: new RemoteViewerConnection({
          owner: this.deps.owner,
          request: this.deps.request,
          // A device screen has no clipboard of this computer to exchange.
          readClipboard: () => '',
          writeClipboard: () => {},
          focused: () => BrowserWindow.fromWebContents(sender)?.isFocused() === true,
          channel: (generation, id, request) => {
            if (sender.isDestroyed() || !created.embedId) return false;
            sender.send(LIVE_SCREEN_EMBED.CHANNEL_REQUEST, {
              embedId: created.embedId,
              generation,
              id,
              request,
            });
            return true;
          },
        }),
      };
      this.entries.set(scope, (entry = created));
    }
    // Binding retires the previous panel's lease and keeps its cleanup ahead of the next start.
    entry.connection.bind({
      deviceId: target.deviceId,
      name: target.name,
      screen: {
        plugin: screen.plugin,
        id: screen.id,
        ...(screen.pluginIdentity === undefined ? {} : {pluginIdentity:screen.pluginIdentity}),
        ...(screen.name ? { name: screen.name } : {}),
      },
    });
    entry.connection.setActive(true);
    if (!entry.connection.active) {
      this.entries.delete(scope);
      throwIpcError('PERMISSION_DENIED', 'Remote desktop unavailable');
    }
    entry.embedId = embedId;
    this.watch(sender);
    return entry.connection.snapshot();
  }
  /** A page that navigates, crashes or closes can no longer hold a lease. */
  private watch(sender: WebContents): void {
    if (this.watched.has(sender)) return;
    this.watched.add(sender);
    const retire = () => this.retireSender(sender);
    sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) retire();
    });
    sender.on('render-process-gone', retire);
    sender.once('destroyed', retire);
  }
  private retireSender(sender: WebContents): void {
    for (const entry of [...this.entries.values()])
      if (entry.sender === sender) {
        this.retire(entry, false);
        this.entries.delete(entry.scope);
      }
  }
  /** Ends what the owning panel shows; the connection stays for its next panel. */
  private retire(entry: Entry, notify: boolean): void {
    const embedId = entry.embedId;
    entry.embedId = null;
    entry.connection.deactivate();
    if (notify && embedId && !entry.sender.isDestroyed())
      entry.sender.send(LIVE_SCREEN_EMBED.ACTIVE, {
        embedId,
        state: entry.connection.snapshot(),
      });
  }
  close(sender: WebContents, embedId: unknown): void {
    const entry = this.owned(sender, embedId);
    if (entry) this.retire(entry, false);
  }
  /** Account change, quit, or this computer locking: every panel stops and is told. */
  endAll(): void {
    for (const entry of [...this.entries.values()]) this.retire(entry, true);
    this.entries.clear();
  }
  async request(
    sender: WebContents,
    embedId: unknown,
    generation: number,
    request: unknown,
    attempt?: string,
  ): Promise<unknown> {
    const result = await this.entry(sender, embedId).connection.request(
      generation,
      request,
      attempt,
    );
    if (!result.ok) throwIpcError('PRECONDITION_FAILED', result.code);
    return result.result;
  }
  async ice(
    sender: WebContents,
    embedId: unknown,
    generation: number,
    attempt: unknown,
  ): Promise<DesktopIceServer[]> {
    const { connection } = this.entry(sender, embedId);
    try {
      connection.beginMedia(generation, attempt);
    } catch {
      throwIpcError('PRECONDITION_FAILED', 'DESKTOP_VIDEO_STOPPED');
    }
    const result = await this.deps.ice();
    try {
      connection.checkMedia(generation, attempt);
    } catch {
      throwIpcError('PRECONDITION_FAILED', 'DESKTOP_VIDEO_STOPPED');
    }
    return result;
  }
  channelReply(
    sender: WebContents,
    embedId: unknown,
    generation: number,
    id: unknown,
    outcome: unknown,
  ): void {
    try {
      this.entry(sender, embedId).connection.channelReply(generation, id, outcome);
    } catch {
      throwIpcError('PRECONDITION_FAILED', 'DESKTOP_STOPPED');
    }
  }
}
