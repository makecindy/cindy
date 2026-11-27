// Links the user clicks elsewhere can be delivered by macOS to the managed
// browser (same app, other profile). The handoff must reopen exactly those in
// the user's browser before any request leaves, and never take a tab the agent
// or the user opened inside the managed browser.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { ExternalLinkHandoff } from '../external-link-handoff.js';

interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

const APP = '/Applications/Google Chrome.app';
const servers: Server[] = [];
const sockets: WebSocket[] = [];
const handoffs: ExternalLinkHandoff[] = [];

afterEach(async () => {
  for (const handoff of handoffs.splice(0)) handoff.dispose();
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** Reports `existingTargets` the way Chrome does: before the discover reply. */
const USER_DATA_DIR = '/Users/me/Library/Application Support/Cindy/browser/Cindy/user-data';

async function createFakeBrowser(
  existingTargets: Array<Record<string, unknown>> = [],
  userDataDir = USER_DATA_DIR,
) {
  const commands: CdpCommand[] = [];
  let browserSocket: WebSocket | undefined;
  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.on('connection', (socket) => {
    sockets.push(socket);
    browserSocket = socket;
    socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString()) as CdpCommand;
      commands.push(command);
      if (command.method === 'SystemInfo.getInfo') {
        socket.send(JSON.stringify({
          id: command.id,
          result: {
            commandLine: `${APP}/Contents/MacOS/Google Chrome --remote-debugging-port=${port()} --user-data-dir=${userDataDir}`,
          },
        }));
        return;
      }
      if (command.method === 'Target.setDiscoverTargets') {
        for (const targetInfo of existingTargets) {
          socket.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
        }
      }
      socket.send(JSON.stringify({ id: command.id, result: {} }));
    });
  });
  const port = () => (server.address() as AddressInfo).port;
  const server = createServer((req, res) => {
    const address = server.address() as AddressInfo;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/test` }));
  });
  server.on('upgrade', (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit('connection', ws, request));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  return {
    cdpHttpUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    commands,
    send(event: Record<string, unknown>) {
      browserSocket?.send(JSON.stringify(event));
    },
  };
}

async function connectedHandoff(options: {
  agentOpening?: boolean;
  openFails?: boolean;
  existingTargets?: Array<Record<string, unknown>>;
  browserUserDataDir?: string;
} = {}) {
  const browser = await createFakeBrowser(options.existingTargets, options.browserUserDataDir);
  const openInUserBrowser = vi.fn(async () => {
    if (options.openFails) throw new Error('open failed');
  });
  const handoff = new ExternalLinkHandoff({
    cdpHttpUrl: () => browser.cdpHttpUrl,
    managedUserDataDir: () => USER_DATA_DIR,
    isAgentOpeningTab: () => options.agentOpening === true,
    logger: { warn: vi.fn() },
    openInUserBrowser,
    appExists: () => true,
  });
  handoffs.push(handoff);
  handoff.ensure();
  if (options.browserUserDataDir === undefined) {
    await vi.waitFor(() => expect(browser.commands.map((c) => c.method)).toContain('Fetch.enable'));
  }
  return { browser, openInUserBrowser, handoff };
}

/** Sends a new tab and its first document request; returns how it was resolved. */
async function openTab(
  browser: Awaited<ReturnType<typeof createFakeBrowser>>,
  targetInfo: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
) {
  if (targetInfo) browser.send({ method: 'Target.targetCreated', params: { targetInfo } });
  browser.send({
    method: 'Fetch.requestPaused',
    params: {
      requestId: 'request-1',
      frameId: 'tab-1',
      resourceType: 'Document',
      request: { url: 'https://login.example/magic?token=1', headers },
    },
  });
  await vi.waitFor(() => expect(
    browser.commands.some((c) => c.method === 'Fetch.continueRequest' || c.method === 'Fetch.failRequest'),
  ).toBe(true));
  // Let a handoff's closing command land too.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return browser.commands
    .filter((c) => c.method === 'Fetch.continueRequest' || c.method === 'Fetch.failRequest' || c.method === 'Target.closeTarget')
    .map((c) => c.method);
}

const externalTab = { targetId: 'tab-1', type: 'page', url: 'https://login.example/magic?token=1' };

describe('ExternalLinkHandoff', () => {
  it('reopens an externally delivered link in the user browser before its request leaves', async () => {
    const { browser, openInUserBrowser } = await connectedHandoff();

    const resolved = await openTab(browser, externalTab);

    expect(openInUserBrowser).toHaveBeenCalledWith(APP, 'https://login.example/magic?token=1');
    // The request is failed, not continued: a one-time link must stay unused.
    expect(resolved).toEqual(['Fetch.failRequest', 'Target.closeTarget']);
  });

  it.each([
    ['an agent open is creating a tab', { agentOpening: true }, externalTab, {}],
    ['the tab came from a ⌘-click in the managed window', {}, externalTab, { Referer: 'https://app.example/' }],
    ['a page opened it as a popup', {}, { ...externalTab, openerId: 'tab-0' }, {}],
    ['the tab existed before the handoff attached', { existingTargets: [externalTab] }, undefined, {}],
  ])('lets the request through when %s', async (_case, options, targetInfo, headers) => {
    const { browser, openInUserBrowser } = await connectedHandoff(options);

    const resolved = await openTab(browser, targetInfo, headers);

    expect(openInUserBrowser).not.toHaveBeenCalled();
    expect(resolved).toEqual(['Fetch.continueRequest']);
  });

  it('keeps the link in the managed browser when the user browser cannot be opened', async () => {
    const { browser } = await connectedHandoff({ openFails: true });

    expect(await openTab(browser, externalTab)).toEqual(['Fetch.continueRequest']);
  });

  it('does not install interception on a browser that is not the managed one', async () => {
    // Another Cindy or the user's Chrome may hold the configured CDP port.
    const { browser } = await connectedHandoff({ browserUserDataDir: '/Users/me/Library/Application Support/Cindy/browser/Cindy-other/user-data' });

    await vi.waitFor(() => expect(browser.commands.map((c) => c.method)).toContain('SystemInfo.getInfo'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(browser.commands.map((c) => c.method)).not.toContain('Fetch.enable');
  });

  it('attaches again after dispose, as when the backend is switched away and back', async () => {
    const { browser, openInUserBrowser, handoff } = await connectedHandoff();
    handoff.dispose();
    const attachedBefore = browser.commands.filter((c) => c.method === 'Fetch.enable').length;

    handoff.ensure();
    await vi.waitFor(() => expect(
      browser.commands.filter((c) => c.method === 'Fetch.enable').length,
    ).toBe(attachedBefore + 1));

    expect(await openTab(browser, externalTab)).toEqual(['Fetch.failRequest', 'Target.closeTarget']);
    expect(openInUserBrowser).toHaveBeenCalledTimes(1);
  });
});
