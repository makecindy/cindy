import {
  PREVIEW_MAX_TITLE_CHARS,
  type PreviewInputEvent,
  type PreviewViewport,
} from '@cindy/device-link';
import { desktopVideoFramerate, desktopVideoProfile } from '../../shared/remoteDesktopQuality';
import type { PreviewTabBinding, PreviewTabEnded } from '../rsb-browser-bridge/previewTabs';
import type {
  DesktopPreviewDeps,
  DesktopPreviewEnd,
  DesktopPreviewSource,
  DesktopPreviewTab,
} from './controller';
import { TabCaptureSource, type CaptureGuest } from './previewTabCapture';
import {
  TabInputInjector,
  type GuestOrigin,
  type InputGuest,
  type TabViewport,
} from './previewTabInput';

/** The preview tab guest as the host sees it: a webview's WebContents. */
export type PreviewGuest = CaptureGuest &
  InputGuest & {
    id: number;
    getTitle(): string;
  };

export interface PreviewHostEnv {
  /** T2 index: the only authority on which tabs are plugin previews. */
  index: {
    list(sessionId?: string): PreviewTabBinding[];
    current(tabId: string, webContentsId: number): PreviewTabBinding | null;
    onEnded(listener: (event: PreviewTabEnded) => void): () => void;
  };
  guest(tabId: string): PreviewGuest | null;
  /** T3: keep these tabs painting while hidden. Absent until the right-sidebar keep-alive lands. */
  setCastingTabs?(tabIds: string[]): void;
  /**
   * Lay these cast tabs out in the phone's picture shape (full set each call; a tab that is
   * missing gets its own layout back). Absent where the renderer cannot do it: the host then
   * does not advertise `previewTab.viewport`.
   */
  setCastingViewports?(viewports: Record<string, PreviewViewport>): void;
  /** Most simultaneous touches injected; advertised in the capability. */
  maxTouchPoints?: number;
  now?(): number;
  /**
   * Where the tab's `<webview>` sits in its host window (CDP touches use the window's
   * coordinate space). Absent where the guest is its own window.
   */
  guestOrigin?(tab: { tabId: string; sessionId: string }): Promise<GuestOrigin | null>;
  /** Pause between layout measurements; tests inject an immediate one. */
  delay?(ms: number): Promise<void>;
}

/** How long a just-uncovered tab gets to lay out before it is measured again. */
const LAYOUT_SETTLE_MS = 120;
const LAYOUT_SETTLE_TRIES = 5;
/** How long a guest that is not ready yet (no size, or throttled) is waited for: ~3 s. */
const LAYOUT_READY_TRIES = 25;
/** Extra measurements granted to a tab that is being laid out in the phone's shape: ~1.2 s. */
const VIEWPORT_APPLY_TRIES = 10;
/** A tab this close to the phone's aspect ratio is laid out in its shape (rounding to whole px). */
const VIEWPORT_ASPECT_TOLERANCE = 0.02;

export const PREVIEW_MAX_TOUCH_POINTS_HOSTED = 5;
/** Tabs offered in one `previewTabs` reply. */
const MAX_LISTED_TABS = 32;

interface Session {
  source: DesktopPreviewSource;
  viewport: PreviewViewport | null;
  capture: TabCaptureSource;
  injector: TabInputInjector;
  listeners: Set<(end: DesktopPreviewEnd) => void>;
  ended: boolean;
}

/**
 * Hosts the preview tab views of the remote-desktop controller: lists the T2 index,
 * measures a tab, captures frames and injects input. Everything is keyed by the source the
 * controller holds for its one lease; a tab or guest that no longer matches the index is an
 * ended source, never something else to fall back to.
 */
export function createPreviewHost(env: PreviewHostEnv): DesktopPreviewDeps {
  const sessions = new Map<DesktopPreviewSource, Session>();
  /** Tabs being opened: already asked to keep painting, not yet a lease. */
  const opening = new Map<string, PreviewViewport | null>();
  const castingTabs = () => [
    ...new Set([...[...sessions.keys()].map((source) => source.tabId), ...opening.keys()]),
  ];
  /** The phone shape each cast tab is laid out in; a tab without one keeps its own layout. */
  const castingViewports = () => {
    const viewports: Record<string, PreviewViewport> = {};
    for (const [tabId, viewport] of opening) if (viewport) viewports[tabId] = viewport;
    for (const session of sessions.values())
      if (session.viewport) viewports[session.source.tabId] = session.viewport;
    return viewports;
  };
  const syncCasting = () => {
    env.setCastingTabs?.(castingTabs());
    env.setCastingViewports?.(castingViewports());
  };
  const pause =
    env.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * A freshly materialized or just-uncovered tab has no real size yet: it answers with an
   * empty viewport, or (throttled while hidden) not at all. Wait for it, boundedly, then
   * measure until two readings in a row agree; a layout that keeps moving gets its last size.
   * Anything but "not ready" (the tab is gone) ends the attempt at once.
   */
  const measureSettled = async (injector: TabInputInjector, shape: PreviewViewport | null = null) => {
    let previous: TabViewport | null = null;
    for (let attempt = 0; attempt < LAYOUT_READY_TRIES && !previous; attempt++) {
      try {
        previous = await injector.measure();
      } catch (error) {
        const notReady =
          error instanceof Error &&
          (error.message === 'PREVIEW_CAPTURE_UNAVAILABLE' ||
            error.message === 'PREVIEW_INPUT_TIMEOUT');
        if (!notReady) throw error;
        await pause(LAYOUT_SETTLE_MS);
      }
    }
    if (!previous) throw new Error('PREVIEW_CAPTURE_UNAVAILABLE');
    for (let attempt = 0; attempt < LAYOUT_SETTLE_TRIES; attempt++) {
      await pause(LAYOUT_SETTLE_MS);
      const next = await injector.measure();
      const settled =
        Math.abs(next.width - previous.width) < 1 && Math.abs(next.height - previous.height) < 1;
      previous = next;
      if (settled) break;
    }
    // The renderer lays the tab out in the phone's shape a moment after being asked; wait for
    // it, boundedly. A renderer that cannot (or a window too small) leaves the tab as it is.
    if (shape) {
      const wanted = shape.width / shape.height;
      const shaped = (size: TabViewport) =>
        Math.abs(size.width / size.height - wanted) / wanted <= VIEWPORT_ASPECT_TOLERANCE;
      for (let attempt = 0; attempt < VIEWPORT_APPLY_TRIES && !shaped(previous); attempt++) {
        await pause(LAYOUT_SETTLE_MS);
        previous = await injector.measure();
      }
    }
    return previous;
  };

  const isCurrent = (source: DesktopPreviewSource) =>
    env.index.current(source.tabId, source.webContentsId)?.generation === source.generation &&
    env.guest(source.tabId)?.id === source.webContentsId;

  const notify = (session: Session, end: DesktopPreviewEnd) => {
    if (session.ended) return;
    session.ended = true;
    for (const listener of [...session.listeners]) {
      try {
        listener(end);
      } catch {
        // One listener must not keep another from learning the source ended.
      }
    }
  };

  env.index.onEnded(({ binding }) => {
    for (const session of [...sessions.values()])
      if (
        session.source.tabId === binding.tabId &&
        session.source.generation === binding.generation
      )
        notify(session, 'ended');
  });

  const sessionOf = (source: DesktopPreviewSource): Session => {
    const session = sessions.get(source);
    if (!session) throw new Error('PREVIEW_SOURCE_ENDED');
    return session;
  };

  return {
    maxTouchPoints: env.maxTouchPoints ?? PREVIEW_MAX_TOUCH_POINTS_HOSTED,

    list(sessionId) {
      const tabs: DesktopPreviewTab[] = [];
      for (const binding of env.index.list(sessionId)) {
        const guest = env.guest(binding.tabId);
        if (!guest || guest.isDestroyed() || guest.id !== binding.webContentsId) continue;
        tabs.push({
          tabId: binding.tabId,
          webContentsId: binding.webContentsId,
          generation: binding.generation,
          sessionId: binding.sessionId,
          ghostId: binding.ghostId,
          pluginName: binding.pluginName,
          title: (guest.getTitle() || binding.pluginName).slice(0, PREVIEW_MAX_TITLE_CHARS),
        });
        if (tabs.length >= MAX_LISTED_TABS) break;
      }
      return tabs;
    },

    async open(tab, viewport) {
      const binding = env.index.current(tab.tabId, tab.webContentsId);
      const guest = env.guest(tab.tabId);
      if (
        !binding ||
        binding.generation !== tab.generation ||
        !guest ||
        guest.isDestroyed() ||
        guest.id !== tab.webContentsId
      )
        return null;
      const injector = new TabInputInjector(
        guest,
        env.guestOrigin
          ? { origin: () => env.guestOrigin!({ tabId: tab.tabId, sessionId: tab.sessionId }) }
          : {},
      );
      // Keep the tab painting first, then measure it: a background tab has no real size.
      const shape = env.setCastingViewports && viewport ? viewport : null;
      opening.set(tab.tabId, shape);
      syncCasting();
      // Looks like a touch device while cast: a page's own `@media (pointer: coarse)` layout
      // applies. Sent before the first measurement, so the size the phone is told is the
      // reflowed one; `dispose` (every end of the lease) takes it back.
      injector.presentAsTouch(env.maxTouchPoints ?? PREVIEW_MAX_TOUCH_POINTS_HOSTED);
      const abandon = () => {
        opening.delete(tab.tabId);
        syncCasting();
        void injector.dispose();
      };
      let measured;
      try {
        measured = await measureSettled(injector, shape);
      } catch (error) {
        abandon();
        throw error;
      }
      // The tab may have been replaced or closed while it was measured.
      const alive = env.index.current(tab.tabId, tab.webContentsId);
      if (!alive || alive.generation !== tab.generation || guest.isDestroyed()) {
        abandon();
        return null;
      }
      const source: DesktopPreviewSource = {
        ...tab,
        width: Math.max(1, Math.round(measured.width)),
        height: Math.max(1, Math.round(measured.height)),
      };
      // Touches arrive relative to the size the phone is told here.
      injector.bindLease({ width: source.width, height: source.height });
      const session: Session = {
        source,
        viewport: shape,
        injector,
        listeners: new Set(),
        ended: false,
        capture: new TabCaptureSource({
          guest: () => env.guest(source.tabId),
          isCurrent: () => isCurrent(source),
          onUnavailable: () => notify(session, 'capture-unavailable'),
          now: env.now,
        }),
      };
      sessions.set(source, session);
      opening.delete(tab.tabId);
      syncCasting();
      return source;
    },

    current: (source) => sessions.has(source) && isCurrent(source),

    watch(source, listener) {
      const session = sessions.get(source);
      if (!session) {
        listener('ended');
        return () => undefined;
      }
      session.listeners.add(listener);
      return () => session.listeners.delete(listener);
    },

    async input(source, events: readonly PreviewInputEvent[]) {
      const session = sessionOf(source);
      if (!isCurrent(source)) throw new Error('PREVIEW_SOURCE_ENDED');
      try {
        await session.injector.inject(events);
      } finally {
        // Whatever the input did to the page is on screen within moments.
        session.capture.nudge();
      }
    },

    async release(source) {
      await sessions.get(source)?.injector.release();
    },

    async frame(source, request) {
      const { capture } = sessionOf(source);
      if (request.purpose === 'relay') return capture.frame({ purpose: 'relay' });
      // The same quality and size budget as a screen frame; only the relay path is held to
      // the small one.
      const profile = desktopVideoProfile(request.settings);
      return capture.frame({
        purpose: 'stream',
        fps: desktopVideoFramerate(request.settings),
        quality: profile.jpegQuality,
        maxBytes: profile.maxFrameBytes,
      });
    },

    setView(source, view) {
      sessions.get(source)?.capture.setView(view);
    },

    end(source) {
      const session = sessions.get(source);
      if (!session) return;
      sessions.delete(source);
      session.ended = true;
      session.listeners.clear();
      session.capture.stop();
      void session.injector.dispose();
      // The tab's own layout comes back with it leaving the cast set.
      syncCasting();
    },

    ...(env.setCastingViewports
      ? {
          async setViewport(source: DesktopPreviewSource, viewport: PreviewViewport) {
            const session = sessionOf(source);
            if (!isCurrent(source)) throw new Error('PREVIEW_SOURCE_ENDED');
            session.viewport = viewport;
            syncCasting();
            // Measured again so the next gesture and frame start from the new layout; a tab
            // that is momentarily not ready keeps the new shape and is measured by the gesture.
            try {
              await measureSettled(session.injector, viewport);
            } catch (error) {
              if (error instanceof Error && error.message === 'PREVIEW_SOURCE_ENDED') throw error;
            }
          },
        }
      : {}),
  };
}
