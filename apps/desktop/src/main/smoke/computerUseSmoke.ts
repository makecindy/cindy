import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createComputerMcpServer } from '@cindy/mcps/computer';
import { cleanupComputerDriverSession, getComputerMcpDeps } from '../mcp-integrations/computer.js';
import { createLogger } from '../logger.js';

const logger = createLogger('computer-use-smoke');
let started = false;
const requested =
  !app.isPackaged && process.env.XDT_ISOLATED === '1' && process.env.CINDY_CUA_SMOKE === '1';

/** Explicit, isolated, real-driver smoke. It operates only on its own disposable window. */
export async function runComputerUseSmokeIfRequested(): Promise<void> {
  if (started || !requested) return;
  started = true;
  const sessionId = `cua-smoke-${randomUUID()}`;
  const checks: string[] = [];
  let currentStep = 'setup';
  let root: string | undefined;
  let window: BrowserWindow | undefined;
  let client: Client | undefined;
  let server: ReturnType<typeof createComputerMcpServer> | undefined;
  const report: Record<string, unknown> = { ok: false, checks, pid: process.pid };
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-cua-smoke-'));
    if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)(
        '/usr/sbin/ioreg',
        ['-l', '-n', 'Root', '-d', '1'],
        { timeout: 5000 },
      );
      if (/"IOConsoleLocked"\s*=\s*Yes/.test(stdout))
        throw new Error('macOS desktop is locked. Unlock it and rerun the isolated smoke.');
    }
    app.setAccessibilitySupportEnabled(true);
    window = new BrowserWindow({
      width: 680,
      height: 440,
      show: false,
      title: 'Cindy Computer Use Smoke',
      webPreferences: {
        partition: sessionId,
        sandbox: true,
        contextIsolation: true,
        webSecurity: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        plugins: false,
        navigateOnDragDrop: false,
        webviewTag: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const script = `document.getElementById('increment').addEventListener('click',()=>{const n=document.getElementById('count');n.textContent=String(Number(n.textContent)+1);const b=document.getElementById('increment');b.textContent='Smoke clicked once';b.disabled=true})`;
    const hash = createHash('sha256').update(script).digest('base64');
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><title>Cindy Computer Use Smoke</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'"></head><body><h1>Computer Use regression fixture</h1><label for="message">Smoke message</label><textarea id="message" aria-label="Smoke message"></textarea><button id="increment">Increment smoke count</button><output id="count">0</output><script>${script}</script></body></html>`)}`,
    );
    window.showInactive();
    server = createComputerMcpServer(getComputerMcpDeps({ isComputerUseEnabled: () => true }), {
      sessionId,
      getSessionContext: () => ({ sessionId, agentKind: 'computer-smoke', workingDir: root! }),
    });
    client = new Client({ name: 'cindy-cua-smoke', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      currentStep = name;
      const result = await client!.callTool(
        { name: 'call_tool', arguments: { name, args } },
        undefined,
        { signal, timeout: 60_000 },
      );
      const first = (result.content as Array<{ text?: string }>)[0];
      const payload = JSON.parse(first?.text ?? '{}') as Record<string, any>;
      // Keep evidence metadata, never retain the system menu / recent-items AX tree.
      report.lastResult = {
        ok: payload.ok,
        errorCode: payload.errorCode,
        outcome: payload.outcome,
        effect: payload.data?.effect,
        status: payload.data?.status,
        message: payload.data?.message,
      };
      if (name === 'verify_state') report.verification = payload.data;
      return payload;
    };
    const catalog = await call('list_windows', { pid: process.pid });
    const target = catalog.data?.windows?.find(
      (item: { title?: string }) => item.title === 'Cindy Computer Use Smoke',
    );
    check(target && Number.isInteger(target.window_id), 'own fixture window discovered');
    const targetArgs = { pid: process.pid, window_id: target.window_id };
    let state = await call('get_window_state', { ...targetArgs, include_screenshot: false });
    for (
      let attempt = 0;
      attempt < 10 &&
      !state.data?.elements?.some(
        (item: { role?: string; label?: string }) =>
          item.role === 'AXTextArea' && item.label === 'Smoke message',
      );
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = await call('get_window_state', { ...targetArgs, include_screenshot: false });
    }
    check(
      state.ok &&
        !state.data?.screenshot &&
        !state.data?.screenshot_path &&
        !state.data?.screenshot_out_file,
      'text observation excludes screenshot',
    );
    const elements = state.data?.elements as Array<{
      element_token?: string;
      role?: string;
      label?: string;
    }>;
    report.observationSummary = {
      keys: Object.keys(state.data ?? {}),
      element_count: state.data?.element_count,
      degraded_reason: state.data?.degraded_reason,
      roles: elements?.slice(0, 12).map((item) => item.role),
      window_id: target.window_id,
    };
    report.fixtureElements = elements?.filter(
      (item) => item.label === 'Smoke message' || item.label === 'Increment smoke count',
    );
    const input = elements?.find(
      (item) => item.role === 'AXTextArea' && item.label === 'Smoke message',
    );
    const button = elements?.find(
      (item) => item.role === 'AXButton' && item.label === 'Increment smoke count',
    );
    check(input?.element_token && button?.element_token, 'opaque element tokens available');
    const value = 'Cindy smoke 中文 123';
    const set = await call('set_value', {
      ...targetArgs,
      element_token: input!.element_token,
      value,
    });
    check(set.ok, 'set_value dispatched successfully');
    check(
      (await window.webContents.executeJavaScript('document.getElementById("message").value')) ===
        value,
      'independent DOM confirms exact input',
    );
    const click = await call('click', {
      ...targetArgs,
      element_token: button!.element_token,
      delivery_mode: 'background',
    });
    check(click.ok, 'background click dispatched successfully');
    check(
      (await window.webContents.executeJavaScript(
        'document.getElementById("count").textContent',
      )) === '1',
      'independent DOM confirms exactly one click',
    );
    const textVerification = await call('verify_state', {
      ...targetArgs,
      expect: [
        {
          element: {
            selector: { role: 'AXTextArea', label_contains: 'Smoke message' },
            value_equals: value,
          },
        },
      ],
      timeout_ms: 2000,
    });
    // The driver deliberately does not trust web AXValue. The DOM oracle above
    // proves the input independently; preserve unknown instead of claiming success.
    check(
      !textVerification.ok && textVerification.outcome?.status === 'unknown',
      'untrusted web value is not reported as verified',
    );
    const verified = await call('verify_state', {
      ...targetArgs,
      expect: [{ window: { exists: true } }],
      timeout_ms: 2000,
    });
    check(
      verified.ok && verified.outcome?.status === 'confirmed',
      'bounded window existence verification satisfied',
    );
    const stale = await call('click', { ...targetArgs, element_token: button!.element_token });
    check(stale.errorCode === 'STALE_SNAPSHOT', 'verification invalidates old element credentials');
    check(
      (await window.webContents.executeJavaScript(
        'document.getElementById("count").textContent',
      )) === '1',
      'stale action never reaches fixture',
    );
    const imagePath = path.join(root, 'window.png');
    const imageState = await call('get_window_state', {
      ...targetArgs,
      include_screenshot: true,
      screenshot_out_file: imagePath,
    });
    check(
      imageState.ok && (await fs.stat(imagePath)).size > 0,
      'explicit screenshot written inside temporary workspace',
    );
    const controller = new AbortController();
    controller.abort();
    await call('click', { ...targetArgs, x: 1, y: 1 }, controller.signal).then(
      () => {
        throw new Error('pre-cancelled action unexpectedly returned');
      },
      () => checks.push('pre-cancelled action rejected'),
    );
    check(
      (await window.webContents.executeJavaScript(
        'document.getElementById("count").textContent',
      )) === '1',
      'cancelled action leaves fixture unchanged',
    );
    report.ok = true;
    delete report.lastResult;
    delete report.observation;
    delete report.fixtureElements;
    delete report.observationSummary;
    delete report.verification;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.step = currentStep;
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await cleanupComputerDriverSession(sessionId).catch(() => undefined);
    if (window && !window.isDestroyed()) window.destroy();
    if (root) await fs.rm(root, { recursive: true, force: true });
    const reportPath = path.join(app.getPath('userData'), 'computer-use-smoke.json');
    await fs
      .writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      .catch((error: unknown) =>
        logger.warn('failed to write smoke report', { error: String(error) }),
      );
    logger.info('Computer Use smoke finished', {
      ok: report.ok,
      checks: checks.length,
      reportPath,
    });
  }
}
