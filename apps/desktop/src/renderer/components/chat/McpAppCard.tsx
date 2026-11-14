import { McpAppPermissionPrompt } from './McpAppPermissionPrompt';
import { isPluginUiElementVisible, subscribePluginUiRegions } from '@/cindy-brain/pluginUiVisibility';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isSharedTaskPeer } from '@cindy/device-link';
import {
  McpAppController,
  MCP_APP_MAX_HEIGHT,
  McpAppHeightGuard,
  mcpAppFailureKey,
  type AppRpc,
  type AppInvoker,
} from '@cindy/maker-shared/mcp-app-controller';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { Button } from '@/components/ui/button';
import { createLogger } from '@/lib/logger';
import { Spinner } from '@/components/ui/spinner';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';

// Local diagnostics only: renderer logs remain excluded from log uploads. Never
// log the original exception; it may contain HTML, tool data or credential URLs.
const appFailureCodes = new Set([
  'MCP_APP_FILES_LOCAL_ONLY', 'MCP_APP_REQUEST_FAILED', 'MCP_APP_SANDBOX_FAILED',
  'MCP_APP_INITIALIZATION_FAILED', 'MCP_APP_INITIALIZE_FAILED', 'MCP_APP_INITIALIZATION_TIMEOUT',
  'MCP_APP_OPEN_TIMEOUT', 'MCP_APP_OPEN_CANCELLED', 'MCP_APP_CARD_UNAVAILABLE',
  'MCP_APP_CARD_TOO_LARGE', 'MCP_APP_DOCUMENT_TOO_LARGE', 'MCP_APP_INVALID_DOCUMENT',
  'MCP_APP_INVALID_RESOURCE', 'MCP_APP_RESOURCE_MISSING', 'MCP_APP_RESOURCE_NOT_FOUND',
  'MCP_APP_RESOURCE_TOO_LARGE', 'MCP_APP_SERVER_CHANGED', 'MCP_APP_VIEW_UNAVAILABLE',
  'MCP_APP_VIEW_LIMIT', 'MCP_APP_SESSION_UNAVAILABLE', 'MCP_APP_OWNER_CHANGED',
  'MCP_APP_OWNER_ONLY', 'MCP_APP_OWNER_UNAVAILABLE', 'MCP_APP_CONNECTION_CLOSED',
  'MCP_APP_CONNECTION_LIMIT', 'MCP_APP_INVALID_POLL', 'MCP_APP_CHANNEL_NOT_ALLOWED',
  'MCP_PLUGIN_UNAVAILABLE', 'MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED',
  'CHANNEL_NOT_ALLOWED', 'CHANNEL_NOT_FOUND', 'UNKNOWN_CHANNEL', 'NOT_FOUND',
]);
const MCP_APP_HEIGHT_CACHE_LIMIT = 100;
const MCP_APP_LOADING_INDICATOR_DELAY_MS = 400;
const MCP_APP_HEIGHT_FALLBACK_DELAY_MS = 500;
const mcpAppHeightCache = new Map<string, number>();
function cachedMcpAppHeight(key: string): number | undefined { return mcpAppHeightCache.get(key); }
function rememberMcpAppHeight(key: string, height: number): void {
  mcpAppHeightCache.delete(key);
  mcpAppHeightCache.set(key, height);
  while (mcpAppHeightCache.size > MCP_APP_HEIGHT_CACHE_LIMIT)
    mcpAppHeightCache.delete(mcpAppHeightCache.keys().next().value!);
}
function logAppFailure(error: unknown, phase: 'open' | 'sandbox' | 'initialize' | 'active', sessionId: string | null, clientId: string): void {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const code = message.match(/\b[A-Z][A-Z_]+\b/g)?.find(value => appFailureCodes.has(value)) ?? 'UNKNOWN';
  const stage = code.endsWith('_TIMEOUT') ? 'timeout' : code === 'MCP_APP_SANDBOX_FAILED' ? 'sandbox' : phase;
  const write = (card: string) => createLogger('mcp-apps').warn('App View failed', { code, stage, card });
  // A stable digest supports correlation without writing task/card identifiers.
  void (async () => {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([sessionId, clientId])));
      write(Array.from(new Uint8Array(digest).slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join(''));
    } catch { write('unavailable'); }
  })();
}

function hostContext(locale: string, element: HTMLElement): Record<string, unknown> {
  const style = getComputedStyle(document.documentElement);
  const variable = (name: string) => style.getPropertyValue(name).trim();
  return {
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: 'desktop',
    userAgent: 'Cindy',
    deviceCapabilities: {
      touch: navigator.maxTouchPoints > 0,
      hover: matchMedia('(hover: hover)').matches,
    },
    containerDimensions: { width: Math.round(element.clientWidth), maxHeight: MCP_APP_MAX_HEIGHT },
    styles: {
      variables: {
        '--color-background-primary': variable('--surface'),
        '--color-background-secondary': variable('--surface-elevated'),
        '--color-background-tertiary': variable('--surface-hover'),
        '--color-text-primary': variable('--text-primary'),
        '--color-text-secondary': variable('--text-secondary'),
        '--color-text-tertiary': variable('--text-tertiary'),
        '--color-border-primary': variable('--border-default'),
        '--color-border-secondary': variable('--border-subtle'),
        '--color-text-danger': variable('--error-fg'),
        '--color-text-warning': variable('--warning-fg'),
        '--font-sans': variable('--font-sans') || style.fontFamily,
        '--font-mono': variable('--font-mono'),
        '--border-radius-md': '8px',
      },
    },
  };
}

interface McpAppCardProps {
  sessionId: string | null;
  clientId: string;
  title: string;
  fallbackText?: string;
  plugin?: unknown;
  source?: { instanceId: string; viewId: string };
  contextSource?: { read(): Record<string, unknown>; subscribe(changed: () => void): () => void };
  onUnavailable?(): void;
}

export function McpAppCard(props: McpAppCardProps) {
  const { t } = useTranslation();
  const deviceId = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => props.sessionId === null ? undefined : getStickySessionDeviceId(props.sessionId),
    () => undefined,
  );
  // Shared-task peers can read history, but must not create an interactive View.
  if (isSharedTaskPeer(deviceId)) {
    const title = props.title ? t('mcpApps.cardTitle', { title: props.title }) : t('mcpApps.appName');
    return (
      <section className="my-3 rounded-xl border border-border p-3" aria-label={title}>
        <div className="text-13 text-[var(--text-secondary)]">{title}</div>
        {props.fallbackText && (
          <p className="mt-3 whitespace-pre-wrap break-words text-14 text-[var(--text-primary)]">
            {props.fallbackText}
          </p>
        )}
        <p className="mt-3 text-13 text-[var(--text-secondary)]">{t('mcpApps.sharedTaskReadOnly')}</p>
      </section>
    );
  }
  return <InteractiveMcpAppCard {...props} deviceId={deviceId} />;
}

/** Untrusted HTML always sits across an origin boundary, without Cindy's preload. */
function InteractiveMcpAppCard({ sessionId, clientId, title, fallbackText, deviceId, plugin, source, contextSource, onUnavailable }: McpAppCardProps & { deviceId?: string }) {
  const { t, i18n } = useTranslation();
  const pluginTrust = plugin && typeof plugin === 'object' && 'trust' in plugin ? String(plugin.trust) : undefined;
  const appTitle = title || t('mcpApps.appName');
  const card = useRef<HTMLDialogElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<McpAppController | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<ReturnType<typeof mcpAppFailureKey> | 'mcpApps.pluginRevoked' | 'mcpApps.pluginCspRejected' | 'mcpApps.filesOnExecutionComputer'>();
  const [loading, setLoading] = useState(true);
  const heightKey = `${deviceId ?? 'local'}:${sessionId ?? 'none'}:${clientId}`;
  const [height, setHeight] = useState(() => cachedMcpAppHeight(heightKey) ?? 320);
  const [mode, setMode] = useState('inline');
  const [border, setBorder] = useState(true);
  const [visible, setVisible] = useState(false);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const contextSourceRef = useRef(contextSource);
  contextSourceRef.current = contextSource;
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable;
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setHeight(cachedMcpAppHeight(heightKey) ?? 320);
  }, [heightKey]);

  useEffect(() => {
    // A failed View collapses; observe the card so its retry stays visible.
    const element = card.current;
    if (!element) return;
    let intersecting = false;
    let windowHidden = isWindowHidden();
    const update = () => setVisible(intersecting && !windowHidden && document.visibilityState !== 'hidden' && isPluginUiElementVisible(element));
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    }, { rootMargin: '80px 0px' });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    const stopWindowHidden = window.electronAPI?.onWindowHiddenChange?.((hidden) => { windowHidden = hidden; update(); });
    const stopRegions = subscribePluginUiRegions(update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      stopWindowHidden?.();
      stopRegions();
    };
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !visible) return;
    setRevealed(false);
    let disposed = false;
    let revealedFrame = false;
    let initialized = false;
    let resultDelivered = Boolean(source || sessionId === null);
    let sizeDelivered = false;
    let latestHeight: number | undefined;
    let handshakeStarted = false;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let staticTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    let heightFallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let phase: 'open' | 'sandbox' | 'initialize' | 'active' = 'open';
    const heightGuard = new McpAppHeightGuard(() => createLogger('mcp-apps').warn('App height feedback loop bounded'));
    heightGuard.resize(element.clientWidth);
    let frame: HTMLIFrameElement | undefined;
    let localViewId: string | undefined;
    const invoke: AppInvoker = (id, input) =>
      window.electronAPI.maker.mcpApps(id, deviceId ? { ...input, deviceId } : input);
    const post = (message: AppRpc) => frame?.contentWindow?.postMessage(message, '*');
    const fail = (error: unknown) => {
      if (!disposed) {
        logAppFailure(error, phase, sessionId, clientId);
        setLoading(false);
        setError(/MCP_APP_FILES_LOCAL_ONLY/.test(String(error)) ? 'mcpApps.filesOnExecutionComputer' : /MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED/.test(String(error)) ? 'mcpApps.pluginCspRejected' : plugin && /MCP_PLUGIN_UNAVAILABLE|MCP_APP_SERVER_CHANGED|MCP_APP_VIEW_UNAVAILABLE/.test(String(error)) ? 'mcpApps.pluginRevoked' : mcpAppFailureKey(error));
        setMode('inline');
        dispose();
        unavailableRef.current?.();
      }
    };
    const controller = new McpAppController(
      invoke,
      sessionId,
      clientId,
      post,
      (message) => {
        if (disposed) return;
        if (message.method === 'ui/notifications/sandbox-handshake-started') handshakeStarted = true;
        if (message.method === 'ui/notifications/sandbox-result-delivered') resultDelivered = true;
        if (message.method === 'ui/notifications/initialized') { phase = 'active'; initialized = true; }
        if (message.method === 'ui/notifications/size-changed') {
          // Only a size observed after both readiness gates is allowed to reveal
          // the page; the automatic pre-result size can still show the old frame.
          if (initialized && resultDelivered) sizeDelivered = true;
          const value = message.params?.height;
          if (typeof value === 'number' && Number.isFinite(value)) {
            const nextHeight = heightGuard.accept(value);
            latestHeight = nextHeight;
            if (initialized && resultDelivered) {
              clearTimeout(heightFallbackTimer);
              heightFallbackTimer = undefined;
              rememberMcpAppHeight(heightKey, nextHeight);
              setHeight(nextHeight);
            } else if (revealedFrame) {
              setHeight(nextHeight);
            }
          }
        }
        if (initialized && resultDelivered && sizeDelivered && !revealedFrame) reveal();
        if (initialized && resultDelivered && !revealedFrame && revealTimer === undefined)
          revealTimer = setTimeout(reveal, 150);
        if (message.method === 'ui/notifications/host-context-changed') {
          const mode = message.params?.displayMode;
          if (mode === 'inline' || mode === 'fullscreen') setMode(mode);
        }
      },
      fail,
      undefined,
      source,
    );
    controllerRef.current = controller;
    setLoading(false);
    loadingTimer = setTimeout(() => { if (!disposed && !revealedFrame) setLoading(true); }, MCP_APP_LOADING_INDICATOR_DELAY_MS);
    setError(undefined);
    setMode('inline');
    const receive = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data as AppRpc;
      if (message?.method === 'ui/notifications/sandbox-proxy-ready') {
        controller.sandboxReady(`cindy-mcp-app://${localViewId}-view/resource`);
      } else controller.receive(message);
    };
    const reveal = () => {
      if (disposed || revealedFrame) return;
      revealedFrame = true;
      clearTimeout(revealTimer); clearTimeout(staticTimer); clearTimeout(maxTimer);
      clearTimeout(loadingTimer);
      if (frame) { frame.style.opacity = '1'; frame.style.pointerEvents = 'auto'; }
      // Static pages may reveal without initialized; apply their latest size
      // immediately. For SDK pages, keep the remembered height until a
      // post-result size arrives, with a bounded fallback for pages that never
      // emit another size notification.
      if (!initialized && latestHeight !== undefined) setHeight(latestHeight);
      if (initialized && !sizeDelivered && latestHeight !== undefined) {
        heightFallbackTimer = setTimeout(() => {
          heightFallbackTimer = undefined;
          if (disposed || sizeDelivered || latestHeight === undefined) return;
          rememberMcpAppHeight(heightKey, latestHeight);
          setHeight(latestHeight);
        }, MCP_APP_HEIGHT_FALLBACK_DELAY_MS);
      }
      setRevealed(true);
      setLoading(false);
    };
    window.addEventListener('message', receive);
    const readContext = () => ({ ...hostContext(localeRef.current, element),
      ...(contextSourceRef.current ? { cindy: contextSourceRef.current.read() } : {}) });
    let lastContext = '';
    let queued = false;
    let sending = false;
    let pendingContext: Record<string, unknown> | undefined;
    const flush = async () => {
      if (sending || disposed || !opened) return;
      sending = true;
      try {
        while (!disposed && pendingContext) {
          const latest = pendingContext;
          pendingContext = undefined;
          await controller.context(latest);
        }
      } catch { /* Optional state cannot break the original content. */ }
      finally { sending = false; }
    };
    const update = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed) return;
        const context = readContext();
        const serialized = JSON.stringify(context);
        if (serialized === lastContext) return;
        lastContext = serialized;
        heightGuard.resize(element.clientWidth);
        pendingContext = context;
        void flush();
      });
    };
    const unsubscribeContext = contextSourceRef.current?.subscribe(update);
    const initialContext = readContext();
    lastContext = JSON.stringify(initialContext);
    let opened = false;
    void controller
      .open(initialContext)
      .then(async (document) => {
        if (!document || disposed) return;
        opened = true;
        void flush();
        phase = 'sandbox';
        localViewId = document.viewId;
        setBorder(document.prefersBorder);
        frame = window.document.createElement('iframe');
        frame.title = appTitle;
        frame.addEventListener('load', () => {
          if (disposed) return;
          if (phase === 'sandbox') phase = 'initialize';
          staticTimer = setTimeout(() => { if (!handshakeStarted) reveal(); }, 150);
        }, { once: true });
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        frame.setAttribute(
          'allow',
          "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'",
        );
        frame.style.cssText = 'width:100%;height:100%;display:block;border:0;opacity:0;pointer-events:none';
        frame.src = `cindy-mcp-app://${localViewId}/sandbox`;
        element.appendChild(frame);
        maxTimer = setTimeout(reveal, 1_500);
      })
      .catch((error) => {
        fail(error);
      });
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    const sizeObserver = new ResizeObserver(update);
    sizeObserver.observe(element);
    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(revealTimer); clearTimeout(staticTimer); clearTimeout(maxTimer); clearTimeout(heightFallbackTimer);
      clearTimeout(loadingTimer);
      controllerRef.current = undefined;
      // Notify before hiding the frame; close() retains the View until the
      // teardown response arrives or the bounded wait expires.
      controller.prepareNativeClose();
      unsubscribeContext?.();
      pendingContext = undefined;
      themeObserver.disconnect();
      sizeObserver.disconnect();
      // Layout cleanup runs before React removes the ancestor message tree.
      // Keep a live frame connected for the bounded teardown, including on failure.
      if (frame) {
        frame.style.cssText =
          'position:fixed;width:1px;height:1px;visibility:hidden;pointer-events:none';
        const body = document.body as HTMLElement & {
          moveBefore?: (node: Node, child: Node | null) => void;
        };
        if (frame.isConnected && body.isConnected && frame.ownerDocument === body.ownerDocument) {
          try {
            body.moveBefore?.(frame, null);
          } catch {
            // A rejected atomic move must not prevent close/listener cleanup.
            // Never reinsert a disconnected frame: that would reload the App.
          }
        }
      }
      void controller
        .close()
        .catch(() => {})
        .finally(() => {
          frame?.remove();
          frame = undefined;
          window.removeEventListener('message', receive);
        });
    }
    return dispose;
  }, [sessionId, clientId, attempt, appTitle, visible, deviceId, source?.instanceId, source?.viewId]);

  useEffect(() => {
    if (root.current)
      void controllerRef.current?.context(hostContext(locale, root.current)).catch(() => {});
  }, [locale]);
  useLayoutEffect(() => {
    if (mode !== 'fullscreen') return;
    const dialog = card.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    // The same native dialog stays mounted inline and fullscreen. Its modal
    // top layer supplies inert background and cross-frame Tab containment
    // without moving or remounting the live, cross-origin App document.
    dialog.close();
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button[data-exit-fullscreen]')?.focus();
    return () => {
      dialog.close();
      dialog.setAttribute('open', '');
      if (root.current) void controllerRef.current?.context(hostContext(localeRef.current, root.current)).catch(() => {});
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [mode]);
  return (
    <dialog
      ref={card}
      open
      className={
        mode === 'fullscreen'
          ? 'fixed inset-4 z-50 m-0 flex h-auto max-h-none w-auto max-w-none flex-col rounded-xl border border-border bg-[var(--surface-elevated)] p-3 text-inherit backdrop:bg-transparent'
          : `static mx-0 my-3 w-full max-w-none overflow-hidden rounded-xl bg-transparent p-0 text-inherit ${border ? 'border border-border' : 'border-0'}`
      }
      role={mode === 'fullscreen' ? 'dialog' : 'region'}
      aria-modal={mode === 'fullscreen' ? true : undefined}
      aria-label={appTitle}
      onCancel={(event) => {
        event.preventDefault();
        void controllerRef.current?.displayMode('inline').catch(() => {});
      }}
    >
      <div className="flex min-h-9 items-center justify-between gap-3 px-3 text-13 text-[var(--text-secondary)]">
        <span className="min-w-0 break-words">{title ? t('mcpApps.cardTitle', { title }) : appTitle}</span>
        {pluginTrust && <span className="shrink-0 text-12 font-medium">{t(`mcpApps.pluginTrust.${['cindy-official', 'reviewed', 'verified-publisher'].includes(pluginTrust) ? pluginTrust : 'unverified'}`)}</span>}
        {loading && visible && !revealed && <Spinner size={16} />}
        {mode === 'fullscreen' && (
          <Button
            data-exit-fullscreen
            variant="secondary"
            size="sm"
            onClick={() => {
              void controllerRef.current?.displayMode('inline').catch(() => {});
            }}
          >
            {t('mcpApps.exitFullscreen')}
          </Button>
        )}
        {error && error !== 'mcpApps.filesOnExecutionComputer' && (
          <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {t('mcpApps.retry')}
          </Button>
        )}
      </div>
      {sessionId !== null && <McpAppPermissionPrompt sessionId={sessionId} clientId={clientId} />}
      {error && (
        <p role="alert" className="px-3 pb-3 text-13 text-[var(--text-secondary)]">
          {t(error)}
        </p>
      )}
      {error && fallbackText && (
        <p className="whitespace-pre-wrap break-words px-3 pb-3 text-14 text-[var(--text-primary)]">
          {fallbackText}
        </p>
      )}
      <div
        ref={root}
        aria-busy={visible && !revealed ? true : undefined}
        style={{
          height: error ? 0 : mode === 'fullscreen' ? undefined : height,
          flex: mode === 'fullscreen' ? 1 : undefined,
        }}
      />
    </dialog>
  );
}
