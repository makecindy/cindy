import { PREVIEW_MAX_TITLE_CHARS, type PreviewInputEvent } from '@cindy/device-link';
import { desktopVideoProfile } from '../../shared/remoteDesktopQuality';
import type { PreviewTabBinding, PreviewTabEnded } from '../rsb-browser-bridge/previewTabs';
import type {
  DesktopPreviewDeps,
  DesktopPreviewEnd,
  DesktopPreviewSource,
  DesktopPreviewTab,
} from './controller';
import { TabCaptureSource, type CaptureGuest } from './previewTabCapture';
import { TabInputInjector, type InputGuest } from './previewTabInput';

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
  /** Most simultaneous touches injected; advertised in the capability. */
  maxTouchPoints?: number;
  now?(): number;
}

export const PREVIEW_MAX_TOUCH_POINTS_HOSTED = 5;
/** Tabs offered in one `previewTabs` reply. */
const MAX_LISTED_TABS = 32;

interface Session {
  source: DesktopPreviewSource;
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
  const castingTabs = () => [...new Set([...sessions.keys()].map((source) => source.tabId))];

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

    async open(tab) {
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
      const injector = new TabInputInjector(guest);
      let viewport;
      try {
        viewport = await injector.measure();
      } catch (error) {
        void injector.dispose();
        throw error;
      }
      // The tab may have been replaced or closed while it was measured.
      const alive = env.index.current(tab.tabId, tab.webContentsId);
      if (!alive || alive.generation !== tab.generation || guest.isDestroyed()) {
        void injector.dispose();
        return null;
      }
      const source: DesktopPreviewSource = {
        ...tab,
        width: Math.max(1, Math.round(viewport.width)),
        height: Math.max(1, Math.round(viewport.height)),
      };
      const session: Session = {
        source,
        injector,
        listeners: new Set(),
        ended: false,
        capture: new TabCaptureSource({
          guest: () => env.guest(source.tabId),
          isCurrent: () => isCurrent(source),
          onUnavailable: () => notify(session, 'capture-unavailable'),
          now: env.now,
          jpegQuality: desktopVideoProfile(undefined).jpegQuality,
        }),
      };
      sessions.set(source, session);
      env.setCastingTabs?.(castingTabs());
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
      await session.injector.inject(events);
    },

    async release(source) {
      await sessions.get(source)?.injector.release();
    },

    async frame(source) {
      return sessionOf(source).capture.frame();
    },

    end(source) {
      const session = sessions.get(source);
      if (!session) return;
      sessions.delete(source);
      session.ended = true;
      session.listeners.clear();
      session.capture.stop();
      void session.injector.dispose();
      env.setCastingTabs?.(castingTabs());
    },
  };
}
