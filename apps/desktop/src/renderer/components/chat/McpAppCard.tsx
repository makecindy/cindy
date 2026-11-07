import { McpAppPermissionPrompt } from './McpAppPermissionPrompt';
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
function logAppFailure(error: unknown, phase: 'open' | 'sandbox' | 'initialize' | 'active', sessionId: string, clientId: string): void {
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
  sessionId: string;
  clientId: string;
  title: string;
  fallbackText?: string;
  plugin?: unknown;
}

export function McpAppCard(props: McpAppCardProps) {
  const { t } = useTranslation();
  const deviceId = useSyncExternalStore(
    remoteProjectsStore.subscribe,
    () => getStickySessionDeviceId(props.sessionId),
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
function InteractiveMcpAppCard({ sessionId, clientId, title, fallbackText, deviceId, plugin }: McpAppCardProps & { deviceId?: string }) {
  const { t, i18n } = useTranslation();
  const pluginTrust = plugin && typeof plugin === 'object' && 'trust' in plugin ? String(plugin.trust) : undefined;
  const appTitle = title || t('mcpApps.appName');
  const card = useRef<HTMLDialogElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<McpAppController | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<ReturnType<typeof mcpAppFailureKey> | 'mcpApps.pluginRevoked' | 'mcpApps.pluginCspRejected' | 'mcpApps.filesOnExecutionComputer'>();
  const [loading, setLoading] = useState(true);
  const [height, setHeight] = useState(320);
  const [mode, setMode] = useState('inline');
  const [border, setBorder] = useState(true);
  const [visible, setVisible] = useState(false);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    // A failed View collapses; observe the card so its retry stays visible.
    const element = card.current;
    if (!element) return;
    let intersecting = false;
    const update = () => setVisible(intersecting && document.visibilityState !== 'hidden');
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      update();
    }, { rootMargin: '80px 0px' });
    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !visible) return;
    let disposed = false;
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
      }
    };
    const controller = new McpAppController(
      invoke,
      sessionId,
      clientId,
      post,
      (message) => {
        if (disposed) return;
        if (message.method === 'ui/notifications/initialized') { phase = 'active'; setLoading(false); }
        if (message.method === 'ui/notifications/size-changed') {
          const value = message.params?.height;
          if (typeof value === 'number' && Number.isFinite(value))
            setHeight(heightGuard.accept(value));
        }
        if (message.method === 'ui/notifications/host-context-changed') {
          const mode = message.params?.displayMode;
          if (mode === 'inline' || mode === 'fullscreen') setMode(mode);
        }
      },
      fail,
    );
    controllerRef.current = controller;
    setLoading(true);
    setError(undefined);
    setMode('inline');
    const receive = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data as AppRpc;
      if (message?.method === 'ui/notifications/sandbox-proxy-ready') {
        controller.sandboxReady(`cindy-mcp-app://${localViewId}-view/resource`);
      } else controller.receive(message);
    };
    window.addEventListener('message', receive);
    void controller
      .open(hostContext(localeRef.current, element))
      .then(async (document) => {
        if (!document || disposed) return;
        phase = 'sandbox';
        localViewId = document.viewId;
        setBorder(document.prefersBorder);
        frame = window.document.createElement('iframe');
        frame.title = appTitle;
        frame.addEventListener('load', () => { if (!disposed && phase === 'sandbox') phase = 'initialize'; }, { once: true });
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        frame.setAttribute(
          'allow',
          "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'",
        );
        frame.style.cssText = 'width:100%;height:100%;display:block;border:0';
        frame.src = `cindy-mcp-app://${localViewId}/sandbox`;
        element.appendChild(frame);
      })
      .catch((error) => {
        fail(error);
      });
    let lastContext = JSON.stringify(hostContext(localeRef.current, element));
    const update = () => {
      const context = hostContext(localeRef.current, element);
      const serialized = JSON.stringify(context);
      if (serialized === lastContext) return;
      lastContext = serialized;
      heightGuard.resize(element.clientWidth);
      void controller.context(context).catch(() => {});
    };
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
      controllerRef.current = undefined;
      // Notify before hiding the frame; close() retains the View until the
      // teardown response arrives or the bounded wait expires.
      controller.prepareNativeClose();
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
  }, [sessionId, clientId, attempt, appTitle, visible, deviceId]);

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
        {loading && visible && <Spinner size={16} />}
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
      <McpAppPermissionPrompt sessionId={sessionId} clientId={clientId} />
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
        style={{
          height: error ? 0 : mode === 'fullscreen' ? undefined : height,
          flex: mode === 'fullscreen' ? 1 : undefined,
        }}
      />
    </dialog>
  );
}
