import { app, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { COMPUTER_TOOL_NAMES } from '@cindy/mcps/computer';
import { createHostPlatformRpc } from '@cindy/maker-shared/host-platform-rpc';
import type { HostDelegationConfig } from '../host-delegation.js';
import { getAuthState } from '../authManager.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getComputerMcpDeps, cleanupComputerDriverSession } from '../mcp-integrations/computer.desktop.js';
import { createDesktopEmbeddedBackend } from '../mcp-integrations/browser.desktop.js';
import { pauseDesktopInputForClientUpgrade } from '../remote-desktop/inputOwnership.js';

/** Only Main owns this socket and its bearer. It delegates to the existing signed
 * input and embedded browser implementations, not a second input coordinator. */
export function connectHostPlatformClient(config: HostDelegationConfig) {
  if (!config.instanceId) throw Error('PLATFORM_HOST_IDENTITY_REQUIRED');
  const id = randomUUID();
  let ownerId: string | null = null;
  let ownerScope: string | null = null;
  let closed = false;
  let pause: ReturnType<typeof pauseDesktopInputForClientUpgrade> = null;
  const computer = getComputerMcpDeps();
  const computerSessions = new Set<string>();
  const createBrowser = () => createDesktopEmbeddedBackend(async sessionId => {
    check();
    const roots = await rpc.call({ method: 'browser.uploadRoots', sessionId });
    check();
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string')) throw Error('PLATFORM_UPLOAD_ROOTS_INVALID');
    return roots;
  });
  let browser = createBrowser();
  let socket: WebSocket;
  let rpc: ReturnType<typeof createHostPlatformRpc>;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 250;
  const check = () => {
    if (closed || isAppSessionBoundaryPending() || (ownerId && (getAuthState().user?.id !== ownerId || activeOwnerScopeKey() !== ownerScope)))
      throw Error('PLATFORM_OWNER_CHANGED');
  };
  // Install the webview admission fence before evaluating live state. There is
  // no await between the scan and freezing: a new guest cannot slip past it.
  const guarded = new Set<Electron.WebContents>();
  const beforeAttach = (event: Electron.Event) => { if (pause) event.preventDefault(); };
  const guard = (contents: Electron.WebContents) => {
    guarded.add(contents); contents.on('will-attach-webview', beforeAttach);
    contents.once('destroyed', () => guarded.delete(contents));
  };
  const created = (_event: Electron.Event, contents: Electron.WebContents) => guard(contents);
  app.on('web-contents-created', created);
  webContents.getAllWebContents().forEach(guard);
  const resume = () => { pause?.release(); pause = null; return true; };
  const execute = async (value: unknown, signal: AbortSignal): Promise<unknown> => {
      if (!value || typeof value !== 'object') throw Error('PLATFORM_OPERATION_INVALID');
      const op = value as Record<string, any>;
      if (op.method === 'identity') {
        if (typeof op.ownerId !== 'string' || !op.ownerId || getAuthState().user?.id !== op.ownerId)
          throw Error('PLATFORM_OWNER_CHANGED');
        ownerId = op.ownerId; ownerScope = activeOwnerScopeKey();
        retryMs = 250;
        return { protocol: 1, id, pid: process.pid, frozen: pause !== null };
      }
      if (!ownerId) throw Error('PLATFORM_IDENTITY_REQUIRED');
      check(); signal.throwIfAborted();
      if (op.method === 'resume') return resume();
      if (op.method === 'freeze') {
        if (pause) return true;
        if (!browser.canReleaseClient()) return false;
        // Even an unreported guest can carry an in-progress form or page script.
        if (webContents.getAllWebContents().some(contents => !contents.isDestroyed() && contents.getType() === 'webview')) return false;
        pause = pauseDesktopInputForClientUpgrade();
        return pause !== null;
      }
      if (pause) throw Object.assign(Error('Client upgrade in progress'), { code: 'DESKTOP_CLIENT_UPGRADING' });
      switch (op.method) {
        case 'computer.status': return computer.getStatus();
        case 'computer.describe': return computer.describeDesktop?.();
        case 'computer.secureTarget': return computer.isSecureTarget?.(op.target);
        case 'computer.closeSession': {
          if (typeof op.sessionId !== 'string' || !op.sessionId.trim()) throw Error('PLATFORM_OPERATION_INVALID');
          const sessionId = op.sessionId.trim();
          if (computerSessions.has(sessionId)) {
            await cleanupComputerDriverSession(sessionId);
            computerSessions.delete(sessionId);
          }
          return true;
        }
        case 'computer.call':
          if (typeof op.name !== 'string' || !COMPUTER_TOOL_NAMES.some(name => name === op.name) || !op.args || typeof op.args !== 'object' || Array.isArray(op.args)) throw Error('PLATFORM_OPERATION_INVALID');
          if (typeof op.context?.sessionId === 'string' && op.context.sessionId.trim()) computerSessions.add(op.context.sessionId.trim());
          return computer.callTool(op.name as Parameters<typeof computer.callTool>[0], op.args, { ...op.context, signal });
        case 'browser.call':
          return browser.call(op.request);
        case 'browser.dispose':
          await browser.dispose();
          check(); signal.throwIfAborted();
          browser = createBrowser();
          return true;
        case 'browser.probe':
          await browser.probeControl(op.probe); return true;
        default: throw Error('PLATFORM_OPERATION_INVALID');
      }
    };
  const connect = () => {
    check();
    socket = new WebSocket(`${config.baseUrl.replace(/^http:/, 'ws:')}/control/platform/socket`, {
      headers: { authorization: `Bearer ${config.token}`, 'x-cindy-host-instance': config.instanceId! },
      followRedirects: false, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false,
    });
    const peer = rpc = createHostPlatformRpc(socket, { assertCurrent: check, execute });
    socket.on('error', () => { /* No payload/header logging. close drives recovery. */ });
    socket.once('close', () => {
      // Cancellation is not completion. Wait for every dispatched operation to
      // settle locally before admitting this process on a replacement socket.
      void peer.whenDrained().then(() => {
        if (closed) return;
        try { check(); } catch { return; }
        retryTimer = setTimeout(() => { if (!closed) { try { connect(); } catch { /* owner changed */ } } }, retryMs);
        retryMs = Math.min(retryMs * 2, 5000);
      });
    });
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (closed) return;
    closed = true; clearTimeout(retryTimer); rpc.close(); socket.terminate();
    await rpc.whenDrained();
    // Drain calls before owner teardown; cleanup must finish before another
    // account connects. A browser cleanup failure must not leave input frozen.
    const cleanup = await Promise.allSettled([browser.dispose(),
      ...[...computerSessions].map(sessionId => cleanupComputerDriverSession(sessionId))]);
    computerSessions.clear();
    resume();
    app.removeListener('web-contents-created', created);
    for (const contents of guarded) if (!contents.isDestroyed()) contents.removeListener('will-attach-webview', beforeAttach);
    guarded.clear();
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Platform client cleanup failed');
  })();
  connect();
  app.once('before-quit', () => { void close(); });
  return { close };
}
