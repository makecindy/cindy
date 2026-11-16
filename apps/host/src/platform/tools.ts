import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { createPlatformClientBridge } from './client-bridge.js';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLiziMcpProviders } from '@cindy/mcps';
import { refreshBrowserRuntimeConfigDir } from '@cindy/browser-control-runtime';
import { createBrowserRuntime, type BrowserRuntimePorts } from '../../../desktop/src/main/mcp-integrations/browser.js';
import { createComputerRuntime } from '../../../desktop/src/main/mcp-integrations/computer.js';
import { createBrowserBackendSettingsStore } from '../../../desktop/src/main/browser-backend-settings-store.js';
import { createUserRecipeLoader } from '../../../desktop/src/main/browser-recipes/loader.js';
import { createUserRecipeWriter } from '../../../desktop/src/main/browser-recipes/writer.js';
import { createPluginRegistry } from '../../../desktop/src/main/maker-host/plugins/index.js';
import { gateBuiltinMcpProviders } from '../../../desktop/src/main/mcp-integrations/provider-gate.js';
import type { GhostBrowserExtensionSlot } from '../../../desktop/src/main/cindy-brain/browserExtensionSlot.js';
import { hostOutbound, resolveHostOutboundProxy } from '../outbound.mjs';
import { createHostPowerMonitor } from './power.mjs';

/** One instance per execution owner. Closing a client never reaches close(). */
export function createHostPlatformTools(options: {
  profileDir: string;
  client?: ReturnType<typeof createPlatformClientBridge>;
  assertCurrent(): void;
  secretIo: BrowserRuntimePorts['secretIo'];
  browserExtensions: Pick<GhostBrowserExtensionSlot, 'getPageControl' | 'getPageControlUnavailableReason'>;
  uploadRoots(sessionId: string): Promise<string[]>;
  createEmbeddedBackend?: BrowserRuntimePorts['createEmbeddedBackend'];
  managedLaunch?: BrowserRuntimePorts['managedLaunch'];
  createPowerMonitor?: typeof createHostPowerMonitor;
}) {
  let closed = false;
  const check = () => { if (closed) throw new Error('PLATFORM_RUNTIME_CLOSED'); options.assertCurrent(); };
  // Preserve synchronous ports (credentials/settings), and recheck asynchronous
  // results before returning them to the old account. Only plain service objects
  // are wrapped; this is not a recursive proxy over arbitrary plugin payloads.
  function guardMethods<T extends object>(service: T): T {
    return Object.fromEntries(Object.entries(service).map(([name, value]) => [name,
      typeof value !== 'function' ? value : (...args: unknown[]) => {
        check();
        const result = Reflect.apply(value, service, args);
        if (result instanceof Promise) return result.then(value => { check(); return value; });
        check(); return result;
      },
    ])) as T;
  }
  // The Host owns one profile; the library has an eager process-wide cache.
  process.env.XDT_BROWSER_RUNTIME_DIR = path.join(options.profileDir, 'browser-runtime');
  refreshBrowserRuntimeConfigDir();
  const settings = createBrowserBackendSettingsStore(() => options.profileDir);
  const loader = createUserRecipeLoader(() => { check(); return options.profileDir; });
  const writer = createUserRecipeWriter({ userRecipesDir: loader.userRecipesDir,
    openPath: async () => { throw new Error('UNSUPPORTED_CAPABILITY: Host has no folder window'); } });
  const browser = createBrowserRuntime({ tempDir: () => os.tmpdir(), settings, managedLaunch: options.managedLaunch, recipes: { ...loader, ...writer },
    secretIo: options.secretIo,
    // Never silently substitute a different browser or reconstruct lost tabs.
    createEmbeddedBackend: options.createEmbeddedBackend ?? (options.client ? (() => {
      const executorKey = randomUUID();
      const lifetime = new AbortController();
      return { kind: 'rsb-webview',
        call: async request => options.client!.call({ method: 'browser.call', request }, { sessionId: executorKey, signal: lifetime.signal }) as Promise<any>,
        probeControl: async probe => { await options.client!.call({ method: 'browser.probe', probe }, { sessionId: executorKey, signal: lifetime.signal }); },
        dispose: async () => {
          lifetime.abort(new Error('HOST_BROWSER_BACKEND_DISPOSED'));
          await options.client!.cleanupSession(executorKey, { method: 'browser.dispose' });
        },
      }; }) : (() => ({ kind: 'rsb-webview',
      call: async request => ({ ok: false, action: request.action, errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'The persistent embedded browser is not connected. The selected browser has not been changed.' }),
      probeControl: async () => { throw new Error('HOST_EMBEDDED_BROWSER_UNAVAILABLE'); },
      dispose: async () => {},
    }))),
  });
  browser.setUserBrowserPageControlProvider(() => { check(); return options.browserExtensions.getPageControl(); },
    () => { check(); return options.browserExtensions.getPageControlUnavailableReason(); });
  browser.setBrowserSessionUploadRootResolver(async id => {
    check(); const roots = await options.uploadRoots(id); check(); return roots;
  });
  const events = new EventEmitter();
  let monitor: Awaited<ReturnType<typeof createHostPowerMonitor>> | null = null;
  let preparing: Promise<void> | null = null;
  const power = () => { check(); if (!monitor) throw new Error('PLATFORM_MONITOR_UNAVAILABLE'); return monitor; };
  async function beforeCall() {
    check();
    preparing ??= (async () => {
      const value = await (options.createPowerMonitor ?? createHostPowerMonitor)({ profileDir: options.profileDir });
      try { check(); } catch (error) { await value.close(); throw error; }
      monitor = value;
      value.on('lock-screen', () => events.emit('lock-screen'));
      value.on('unlock-screen', () => events.emit('unlock-screen'));
    })().catch(error => { preparing = null; throw error; });
    await preparing;
    check(); await power().refresh(); check();
  }
  const computer = createComputerRuntime({ getPath: name => name === 'home' ? os.homedir() : os.tmpdir(),
    beforeCall, assertAvailable: () => power().assertAvailable(),
    // Input ownership still lives in Desktop. Never expose a second independent
    // writer while that shared coordinator and signed input helper are absent.
    assertInputAvailable: () => { check(); throw new Error('HOST_INPUT_COORDINATOR_UNAVAILABLE'); },
    powerMonitor: {
      getSystemIdleTime: () => power().getSystemIdleTime(), getSystemIdleState: () => power().getSystemIdleState(),
      on: (event, listener) => events.on(event, listener), removeListener: (event, listener) => events.removeListener(event, listener),
    },
    outboundFetch: hostOutbound.outboundFetch, resolveOutboundProxy: resolveHostOutboundProxy,
    // Input handoff requires the persistent signed native-input component. A
    // missing probe must not classify a password field as ordinary text.
    isSecureTarget: async () => { throw new Error('HOST_SECURE_INPUT_PROBE_UNAVAILABLE'); },
  });
  const registry = createPluginRegistry();
  const rawBrowserDeps = browser.getBrowserMcpDeps();
  const runtime = rawBrowserDeps.getRuntime();
  const browserDeps = guardMethods({ ...rawBrowserDeps,
    recipeSecrets: guardMethods(rawBrowserDeps.recipeSecrets),
    experienceStore: guardMethods(rawBrowserDeps.experienceStore),
    recipeFiles: async (id: string | undefined) => guardMethods(await rawBrowserDeps.recipeFiles(id)),
    getRuntime: () => ({ call: async (request: Parameters<typeof runtime.call>[0]) => {
      check(); const result = await runtime.call(request); check(); return result;
    } }),
  });
  const providers = gateBuiltinMcpProviders(createLiziMcpProviders({ enabled: ['browser', 'computer'],
    browser: browserDeps,
    computer: guardMethods(options.client ? {
      getStatus: async () => options.client!.call({ method: 'computer.status' }) as Promise<any>,
      callTool: async (name: string, args: Record<string, unknown>, context?: any) => {
        if (context?.agentKind !== 'codex' && !registry.isEnabled('computer')) throw Error('COMPUTER_USE_DISABLED');
        const { signal, ...metadata } = context ?? {};
        return options.client!.call({ method: 'computer.call', name, args, context: metadata }, { signal, sessionId: metadata.sessionId });
      },
      isSecureTarget: async (target: any) => options.client!.call({ method: 'computer.secureTarget', target }) as Promise<boolean>,
      describeDesktop: async () => options.client!.call({ method: 'computer.describe' }) as Promise<any>,
      logger: computer.getComputerMcpDeps().logger,
    } : computer.getComputerMcpDeps({ isComputerUseEnabled: context =>
      context?.agentKind === 'codex' || registry.isEnabled('computer') })),
  }), () => registry);
  let closing: Promise<void> | undefined;
  return {
    providers, browser, computer,
    browserSettings: guardMethods(browser.createBrowserSettingsHandlers(check)),
    async closeSession(id: string) {
      browser.clearUserBrowserMarksForSession(id);
      if (options.client) {
        check();
        await options.client.cleanupSession(id, { method: 'computer.closeSession', sessionId: id });
      } else await computer.cleanupComputerDriverSession(id);
    },
    // Platform transport alone is not full-client migration readiness.
    clientHandoffReady: false,
    close() {
      return closing ??= (async () => {
        closed = true;
        await preparing?.catch(() => {});
        const results = await Promise.allSettled([browser.disposeBrowserRuntime(), computer.dispose()]);
        try { await monitor?.close(); } finally { events.removeAllListeners(); }
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Platform runtime cleanup failed');
      })();
    },
  };
}
