// Manual Electron E2E. Unit tests stub the tab close and navigation. This script
// drives both through the real renderer and verifies the same SQLite-backed
// task can be reopened from the list after its first worker becomes visible.
// Requires agent-browser and a checkout without a running Desktop dev instance.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { scanProcessTable } from '../../../scripts/desktop-whoami.mjs';
import { defaultIsolatedUserDataDir } from '../../../scripts/restart-desktop-remote.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const region = 'cn';
const model = 'sidechat-orca-e2e-model';
const providerId = 'sidechat-orca-e2e-fixture';
const fakeKey = 'sidechat-orca-fixture-not-a-credential';
const parentRequest = 'E2E parent request';
const workerRequest = 'E2E worker request';
const parentReply = 'E2E_FIXTURE_PARENT_REPLY';
const workerReply = 'E2E_FIXTURE_WORKER_REPLY';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

function modelFixture(requests) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && pathname === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      if (request.method !== 'POST' || pathname !== '/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${fakeKey}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      if (payload.model !== model) {
        response.writeHead(400).end();
        return;
      }
      const input = JSON.stringify(payload.input);
      const turn = input.includes(workerRequest) ? 'worker' : input.includes(parentRequest) ? 'parent' : 'other';
      requests.push(turn);
      const id = `resp_${requests.length}`;
      const item = {
        id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: turn === 'worker' ? workerReply : turn === 'parent' ? parentReply : 'E2E_FIXTURE_REPLY', annotations: [] }],
      };
      const events = [
        { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    } catch {
      response.writeHead(400).end();
    }
  });
}

async function until(description, read, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function controls(session) {
  const cli = async (...args) => (await run('agent-browser', ['--session', session, ...args], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  })).stdout.trim();
  const evaluate = async (fn, ...args) => JSON.parse(await cli('eval', `(${fn.toString()})(...${JSON.stringify(args)})`));
  const snapshot = () => cli('snapshot', '-i');
  const clickControl = async (description, label, { last = false } = {}) => {
    const ref = await until(description, async () => {
      const matches = (await snapshot()).split('\n').filter(line => label.test(line))
        .map(line => /\bref=(e\d+)\]/.exec(line)?.[1]).filter(Boolean);
      return last ? matches.at(-1) : matches[0];
    });
    await cli('click', `@${ref}`);
  };
  return { cli, evaluate, snapshot, clickControl };
}

async function launchDesktop(port, sandbox, evidenceDir) {
  const env = { ...process.env, XDT_CDP_PORT: String(port) };
  // Let the trusted launcher derive the isolated profile from the fresh name.
  delete env.XDT_USER_DATA_DIR;
  delete env.XDT_USER_DATA_DIR_EPOCH;
  delete env.XDT_ISOLATED_NAME;
  delete env.XDT_DEVICE_ID_OVERRIDE;
  delete env.CINDY_HOST_API;
  delete env.XDT_LOGIN_SCENARIO;
  const args = ['restart:desktop:remote', '--', `--region=${region}`, `--isolated=${sandbox}`, '--isolated-auth', '--mock', '--passive', '--refuse-running'];
  let receipt;
  try {
    receipt = await run('pnpm', args, { cwd: root, env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    await writeFile(path.join(evidenceDir, 'launch.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    if (/refuses occupied checkout/.test(error.stderr ?? '')) {
      throw new Error('Close the running Desktop dev instance in this checkout before running this test.', { cause: error });
    }
    throw error;
  }
  await writeFile(path.join(evidenceDir, 'launch.log'), `${receipt.stdout}\n${receipt.stderr}`);
  assert.match(receipt.stdout, /^DESKTOP_DEV_VERDICT=ready$/m);
  assert.match(receipt.stdout, /^mode=isolated$/m);
  assert.equal(/^sandbox=(.*)$/m.exec(receipt.stdout)?.[1], sandbox);
  const pid = Number(/^pid=(\d+)$/m.exec(receipt.stdout)?.[1]);
  assert.ok(pid > 0, 'Desktop launcher did not report its PID');
  return pid;
}

async function profileInfo(profile) {
  try {
    return await lstat(profile);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeSandbox(profile) {
  const info = await profileInfo(profile);
  if (!info) return;
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Refusing to remove a redirected sandbox');
  await until('the test Desktop to release its profile', () => {
    const { processes, error } = scanProcessTable();
    if (error) throw new Error(`Cannot verify that the sandbox is unused: ${error.message}`);
    return !processes.some(process => process.command.includes(profile));
  }, 15_000);
  await rm(profile, { recursive: true, force: true });
}

async function verifyCdp(pid, port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const browsers = processInfo.filter(process => process.type === 'browser');
    assert.equal(browsers.length, 1);
    assert.equal(browsers[0].id, pid, 'CDP connected to a different Electron instance');
    return { browser, cdp };
  } catch (error) {
    await cdp.detach();
    await browser.close();
    throw error;
  }
}

async function exercise(ui, baseUrl, workdir, evidenceDir) {
  const { cli, evaluate, clickControl } = ui;
  const setup = await evaluate(async ({ baseUrl, workdir, providerId, model, fakeKey, parentRequest }) => {
    const api = window.electronAPI;
    const provider = await api.maker.createCustomProvider({
      id: providerId, name: 'Side Chat Orca E2E Fixture', auth: { method: 'apiKey' },
      runtimes: { codex: { baseUrl, wireProtocol: 'openai-responses', models: [{ id: model, name: model }] } },
    }, { codex: fakeKey });
    if (!provider.ok) throw new Error('Could not configure the loopback-only fixture provider');
    localStorage.setItem('workerCreationPrefs', JSON.stringify({
      lastAgent: 'codex', workerPermissionMode: 'auto',
      codex: { model, providerId, effort: 'medium', fast: false },
    }));
    const parent = await api.localDb.sessions.create({
      title: 'Side Chat Orca E2E parent', workingDir: workdir, workspaceKind: 'project',
      agentKind: 'codex', model, providerId, permissionMode: 'ask', effort: 'medium',
    });
    location.hash = '#/cc-agent/' + parent.id;
    const result = await api.maker.send(parent.id, parentRequest, {
      agentKind: 'codex', workingDir: workdir, model, permissionMode: 'ask',
    }, { throwOnStartFailure: true });
    return { parentId: parent.id, accepted: result.accepted };
  }, { baseUrl, workdir, providerId, model, fakeKey, parentRequest });
  assert.equal(setup.accepted, true, 'The real Codex adapter did not accept the fixture input');
  const { parentId } = setup;
  await until('completed parent response from the loopback fixture', () => evaluate(async (id, reply) => {
    const api = window.electronAPI;
    const row = await api.localDb.sessions.get(id);
    const messages = await api.localDb.messages.list(id, { limit: 12 });
    return Boolean(row.lastTurnEndedAt && row.lastTurnEndedAt >= row.activeTurnStartedAt
      && messages.some(message => message.role === 'assistant' && String(message.content).includes(reply)));
  }, parentId, parentReply));

  await clickControl('expand sidebar', /button "(展开|Expand)" \[expanded=false/);
  await clickControl('create side chat', /button "(新建侧边追问|New side chat)"/);
  const side = await until('the attached side-chat tab and persisted child', () => evaluate(async id => {
    const api = window.electronAPI;
    const tabs = await api.localDb.rightSidebarTabs.list({ sessionId: id });
    const tab = tabs.tabs.find(tab => tab.id === tabs.activeTabId && tab.kind === 'side-chat');
    if (!tab || !document.querySelector(`[data-tab-pill="${tab.id}"]`)) return null;
    const child = await api.localDb.sessions.get(tab.state.sessionId);
    return { tabId: tab.id, id: child.id, parent: child.parentSessionId, source: child.source, sdkId: child.sdkSessionId };
  }, parentId));
  assert.equal(side.parent, parentId);
  assert.equal(side.source, 'side-chat');
  assert.ok(side.sdkId, 'The native fork was not created');
  assert.equal(await evaluate(() => location.hash), `#/cc-agent/${parentId}`);

  await clickControl('side-chat composer actions', /button "(操作菜单|Composer actions)"/, { last: true });
  await clickControl('turn on collaboration in side chat', /menuitemcheckbox "(协同模式|Collaboration)"/);
  await until('promotion notice is visible before starting collaboration', () => evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return /创建第一个 Worker 后，这条追问会移出侧栏|Once the first worker is created, this follow-up moves from the sidebar/.test(dialog?.innerText ?? '');
  }));
  await until('dialog uses the loopback model and automatic approval', async () => {
    const snapshot = await ui.snapshot();
    return snapshot.includes(`当前：${model}`) || snapshot.includes(`Current: ${model}`)
      ? /自动审批|Auto/.test(snapshot) : false;
  });
  const taskField = await until('worker initial task input', async () =>
    /textbox "(?:初始任务|Initial task)"[^\n]*\bref=(e\d+)\]/i.exec(await ui.snapshot())?.[1]);
  await cli('fill', `@${taskField}`, workerRequest);
  await clickControl('start collaboration', /button "(开启协同|Start Collaboration|Start collab)"/i);
  await until('main view opens the original child ID', () => evaluate(id => location.hash.split('?')[0] === '#/cc-agent/' + id, side.id));
  const worker = await until('real worker, collaboration tab, and displayed fixture reply', () => evaluate(async (leadId, reply) => {
    const api = window.electronAPI;
    const [worker] = await api.localDb.orcaWorkflows.listWorkersByLead(leadId);
    const tabs = await api.localDb.rightSidebarTabs.list({ sessionId: leadId });
    const active = tabs.tabs.find(tab => tab.id === tabs.activeTabId && tab.kind === 'orca-workers');
    if (!worker || !active) return null;
    const chat = document.querySelector(`[data-tab-pill="${active.id}"]`)?.closest('aside');
    if (!chat?.innerText.includes(reply) || !chat.innerText.includes(worker.label)) return null;
    const task = await api.localDb.sessions.get(worker.sessionId);
    return { id: worker.sessionId, label: worker.label, provider: task.providerId };
  }, side.id, workerReply), 40_000);
  assert.equal(worker.provider, providerId);
  await cli('screenshot', path.join(evidenceDir, 'collaboration.png'));

  const rowSelector = id => `[data-sidebar-session-row][data-session-id="${id}"]`;
  await cli('click', rowSelector(parentId));
  await until('parent route with stale side-chat tab removed', () => evaluate(async (parentId, side) => {
    const api = window.electronAPI;
    if (location.hash.split('?')[0] !== '#/cc-agent/' + parentId) return false;
    const tabs = await api.localDb.rightSidebarTabs.list({ sessionId: parentId });
    const sideChats = await api.maker.listSideChats(parentId);
    return !tabs.tabs.some(tab => tab.id === side.tabId) && !sideChats.some(child => child.id === side.id)
      && !document.querySelector(`[data-tab-pill="${side.tabId}"]`);
  }, parentId, side));

  await cli('click', rowSelector(side.id));
  await until('independent task opens from task list', () => evaluate(id => location.hash.split('?')[0] === '#/cc-agent/' + id, side.id));
  const promoted = await evaluate(async id => {
    const { source, sideChatPromoted, parentSessionId, orcaRole, status } = await window.electronAPI.localDb.sessions.get(id);
    return { source, sideChatPromoted, parentSessionId, orcaRole, status };
  }, side.id);
  assert.deepEqual(promoted, { source: 'desktop', sideChatPromoted: true, parentSessionId: parentId, orcaRole: 'lead', status: 'active' });
  return { parentId, sideChatId: side.id, worker, oldTabRemoved: true, reopenedFromTaskList: true };
}

const evidenceDir = await mkdtemp(path.join(tmpdir(), 'cindy-sidechat-orca-e2e-'));
const sandbox = `sidechat-orca-e2e-${path.basename(evidenceDir).slice(-6).toLowerCase()}`;
const profile = defaultIsolatedUserDataDir(sandbox, region);
const workdir = path.join(evidenceDir, 'project');
const requests = [];
const server = modelFixture(requests);
let connection;
const ui = controls(sandbox);
let startedAgentBrowser = false;
let ownsSandbox = false;
try {
  // The launcher's refusal guard leaves any running development instance alone.
  await run('agent-browser', ['--version'], { timeout: 5000 });
  await mkdir(profile, { mode: 0o700 });
  ownsSandbox = true;
  // Use the production disconnect marker in this fresh profile so startup
  // cannot adopt a CLI or Keychain subscription on the test machine.
  await writeFile(path.join(profile, 'native-provider-auth.json'), JSON.stringify({
    revoked: { anthropic: 'side-chat-orca-e2e', openai: 'side-chat-orca-e2e', xai: 'side-chat-orca-e2e' },
  }), { flag: 'wx', mode: 0o600 });
  await mkdir(workdir);
  const modelPort = await listen(server);
  const reservePort = createServer();
  const port = await listen(reservePort);
  await close(reservePort);
  const pid = await launchDesktop(port, sandbox, evidenceDir);
  connection = await verifyCdp(pid, port);
  startedAgentBrowser = true;
  await ui.cli('connect', String(port));
  const window = await until('main Electron window', async () => {
    const tabs = JSON.parse(await ui.cli('--json', 'tab')).data.tabs;
    return tabs.find(tab => tab.type === 'page' && /^http:\/\/localhost:\d+\/(?:#\/cc-agent(?:\/|$)|$)/.test(tab.url));
  });
  await ui.cli('tab', window.tabId);
  await until('main renderer', async () => (await ui.snapshot()).includes('textbox'), 45_000);
  const result = await exercise(ui, `http://127.0.0.1:${modelPort}/v1`, workdir, evidenceDir);
  assert.ok(requests.includes('parent') && requests.includes('worker'), 'Both tasks must use the loopback-only fixture');
  const recordedModels = await until('recorded local model usage', async () => {
    const models = await ui.evaluate(async () => {
      const { modelDaily } = await window.electronAPI.maker.usage.getHistory({ device: 'local', forceRefresh: true });
      return [...new Set(modelDaily.map(row => row.model))];
    });
    return models.length ? models : null;
  });
  assert.deepEqual(recordedModels, [model], 'The sandbox recorded usage outside the fixture model');
  await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({ ...result, requests, recordedModels, desktopPid: pid }, null, 2));
} catch (error) {
  console.error(error);
  if (startedAgentBrowser) {
    await writeFile(path.join(evidenceDir, 'failure.snapshot.txt'), await ui.snapshot().catch(() => 'No main renderer snapshot available.'));
    await ui.cli('screenshot', path.join(evidenceDir, 'failure.png')).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (connection) {
    const closeDesktop = async () => {
      await connection.cdp.send('Browser.close').catch(() => {});
      await connection.browser.close().catch(() => {});
    };
    await Promise.race([closeDesktop(), delay(5000)]);
  }
  if (startedAgentBrowser) await ui.cli('close').catch(() => {});
  if (server.listening) await close(server);
  try {
    if (ownsSandbox) await removeSandbox(profile);
    await rm(workdir, { recursive: true, force: true });
  } catch (error) {
    console.error(`Could not clean the test sandbox: ${error.message}`);
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    console.log('PASS Side chat opened the same task with its worker and can be reopened from the task list.');
  }
  console.log(`REPORT=${evidenceDir}`);
}
