// Manual Electron E2E. Unit tests stub the tab close and navigation. This script
// drives both through the real renderer and verifies the same SQLite-backed
// task can be reopened from the list after its first worker becomes visible.
// Requires agent-browser and a checkout without a running Desktop dev instance.
// --preview leaves the checked app and its loopback fixture alive until Electron exits.
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
const parentTitle = 'Side Chat Orca E2E parent — release checklist, account access recovery, onboarding and device connection acceptance criteria';
const sideRequest = 'E2E follow-up request';
const workerRequest = 'E2E worker request';
const parentReply = 'E2E_FIXTURE_PARENT_REPLY';
const sideReply = 'E2E_FIXTURE_FOLLOWUP_REPLY';
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
      const turn = input.includes(workerRequest) ? 'worker'
        : input.includes(sideRequest) ? 'side-chat' : input.includes(parentRequest) ? 'parent' : 'other';
      requests.push(turn);
      const id = `resp_${requests.length}`;
      const item = {
        id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: turn === 'worker' ? workerReply
          : turn === 'side-chat' ? sideReply : turn === 'parent' ? parentReply : 'E2E_FIXTURE_REPLY', annotations: [] }],
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

async function captureAppearance(ui, evidenceDir, name) {
  for (const mode of ['light', 'dark']) {
    await ui.cli('set', 'media', mode);
    await until(mode + ' appearance', () => ui.evaluate(expected =>
      document.documentElement.style.colorScheme === expected, mode));
    await ui.cli('screenshot', path.join(evidenceDir, name + '-' + mode + '.png'));
  }
}

async function exercise(ui, baseUrl, workdir, evidenceDir) {
  const { cli, evaluate, clickControl } = ui;
  const setup = await evaluate(async ({ baseUrl, workdir, providerId, model, fakeKey, parentRequest, parentTitle }) => {
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
      title: parentTitle, workingDir: workdir, workspaceKind: 'project',
      agentKind: 'codex', model, providerId, permissionMode: 'ask', effort: 'medium',
    });
    location.hash = '#/cc-agent/' + parent.id;
    const result = await api.maker.send(parent.id, parentRequest, {
      agentKind: 'codex', workingDir: workdir, model, permissionMode: 'ask',
    }, { throwOnStartFailure: true });
    return { parentId: parent.id, accepted: result.accepted };
  }, { baseUrl, workdir, providerId, model, fakeKey, parentRequest, parentTitle });
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
  assert.doesNotMatch(await ui.snapshot(), /button "(打开对话|Open conversation)"/);

  const onRoute = id => evaluate(sessionId => location.hash.split('?')[0] === '#/cc-agent/' + sessionId, id);
  const rowSelector = id => `[data-sidebar-session-row][data-session-id="${id}"]`;
  const tabSelector = id => `[data-tab-pill="${id}"]`;
  const openCollaboration = () => clickControl('view collaboration', /button "(查看协同|View collaboration)"/);
  const returnToSideChat = () => clickControl('return to side chat', /button "(回到侧边追问|Back to side chat)"/);
  const reopenSideChat = () => clickControl('reopen the closed side chat', /button "(重新打开侧边追问|Reopen side chat)"/);
  const closeSidebar = () => clickControl('close the sidebar with its existing control', /button "(关闭侧栏|Close Sidebar)"/i);
  const readActiveSideChat = () => evaluate(async (id, childId) => {
    if (location.hash.split('?')[0] !== '#/cc-agent/' + id) return null;
    const tabs = await window.electronAPI.localDb.rightSidebarTabs.list({ sessionId: id });
    const tab = tabs.tabs.find(tab => tab.id === tabs.activeTabId && tab.kind === 'side-chat' && tab.state.sessionId === childId);
    return tab && document.querySelector(`[data-tab-pill="${tab.id}"]`)?.closest('aside:not([data-pane-collapsed])') ? tab.id : null;
  }, parentId, side.id);

  assert.equal(await evaluate(async (id, prompt, workdir, model) => {
    const result = await window.electronAPI.maker.send(id, prompt, {
      agentKind: 'codex', workingDir: workdir, model, permissionMode: 'ask',
    }, { throwOnStartFailure: true });
    return result.accepted;
  }, side.id, sideRequest, workdir, model), true);
  await until('follow-up answer in the parent sidebar', () => evaluate((tabId, reply) =>
    document.querySelector(`[data-tab-pill="${tabId}"]`)?.closest('aside')?.innerText.includes(reply), side.tabId, sideReply));
  const beforeCollaboration = await evaluate(async id => {
    const row = await window.electronAPI.localDb.sessions.get(id);
    return { sdkId: row.sdkSessionId, agentKind: row.agentKind };
  }, side.id);

  const toggleCollaboration = async () => {
    await clickControl('side-chat composer actions', /button "(操作菜单|Composer actions)"/, { last: true });
    await clickControl('toggle collaboration in side chat', /menuitemcheckbox "(协同模式|Collaboration)"/);
  };
  const startCollaboration = async () => {
    await toggleCollaboration();
    await until('dialog uses the loopback model and automatic approval', async () => {
      const snapshot = await ui.snapshot();
      return (snapshot.includes(`当前：${model}`) || snapshot.includes(`Current: ${model}`))
        && /自动审批|Auto/.test(snapshot);
    });
    const taskField = await until('worker initial task input', async () =>
      /textbox "(?:初始任务|Initial task)"[^\n]*\bref=(e\d+)\]/i.exec(await ui.snapshot())?.[1]);
    await cli('fill', `@${taskField}`, workerRequest);
    await clickControl('start collaboration', /button "(开启协同|Start Collaboration|Start collab)"/i);
  };
  await startCollaboration();
  await until('linked task row and view control appear while still on the parent', async () =>
    await readActiveSideChat() === side.tabId
    && await evaluate(selector => Boolean(document.querySelector(selector)), rowSelector(side.id))
    && /button "(查看协同|View collaboration)"/.test(await ui.snapshot()));
  const promoted = await evaluate(async id => {
    const { source, sideChatPromoted, parentSessionId, orcaRole, status, sdkSessionId, agentKind } = await window.electronAPI.localDb.sessions.get(id);
    return { source, sideChatPromoted, parentSessionId, orcaRole, status, sdkId: sdkSessionId, agentKind };
  }, side.id);
  assert.deepEqual(promoted, { source: 'desktop', sideChatPromoted: true, parentSessionId: parentId,
    orcaRole: 'lead', status: 'active', ...beforeCollaboration });
  const sidebarDraft = 'E2E shared draft';
  const sidebarEditor = `aside:has(${tabSelector(side.tabId)}) .tiptap[contenteditable="true"]`;
  await cli('fill', sidebarEditor, sidebarDraft);
  await captureAppearance(ui, evidenceDir, 'side-chat');

  await openCollaboration();
  await until('main view opens the original child ID', () => evaluate(id => location.hash.split('?')[0] === '#/cc-agent/' + id, side.id));
  await until('origin and return are in the row below the header', () => evaluate(title => {
    const row = document.querySelector('[data-testid="linked-side-chat-origin"]');
    const header = document.querySelector('header');
    return row?.querySelector('p')?.title.includes(title) && Boolean(row.querySelector('button'))
      && !row.closest('header') && (!header || !header.textContent.includes('回到侧边追问'));
  }, parentTitle));
  const readCollaboration = () => evaluate(async (leadId, reply) => {
    const api = window.electronAPI;
    if (location.hash.split('?')[0] !== '#/cc-agent/' + leadId) return null;
    const [worker] = await api.localDb.orcaWorkflows.listWorkersByLead(leadId);
    const tabs = await api.localDb.rightSidebarTabs.list({ sessionId: leadId });
    const active = tabs.tabs.find(tab => tab.id === tabs.activeTabId && tab.kind === 'orca-workers');
    if (!worker || !active) return null;
    const chat = document.querySelector(`[data-tab-pill="${active.id}"]`)?.closest('aside:not([data-pane-collapsed])');
    if (!chat?.innerText.includes(reply) || !chat.innerText.includes(worker.label)) return null;
    const task = await api.localDb.sessions.get(worker.sessionId);
    return { id: worker.sessionId, label: worker.label, provider: task.providerId };
  }, side.id, workerReply);
  const worker = await until('real worker, collaboration tab, and displayed fixture reply', readCollaboration, 40_000);
  assert.equal(worker.provider, providerId);
  assert.deepEqual(await evaluate(id => window.electronAPI.localDb.orcaWorkflows.listWorkersByLead(id), parentId), []);
  await until('full page shows the same follow-up answer and draft', () => evaluate((reply, draft) =>
    document.body.innerText.includes(reply) && [...document.querySelectorAll('.tiptap[contenteditable="true"]')]
      .some(editor => !editor.closest('aside') && editor.textContent.includes(draft)), sideReply, sidebarDraft));
  await captureAppearance(ui, evidenceDir, 'collaboration');
  await closeSidebar();
  await until('collaboration sidebar is collapsed', async () => !await readCollaboration());
  const viewport = await evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await cli('set', 'viewport', '840', '760');
  await until('narrow provenance row keeps its button visible and shortens the long source title', () => evaluate(title => {
    const row = document.querySelector('[data-testid="linked-side-chat-origin"]');
    const text = row?.querySelector('p');
    const button = row?.querySelector('button');
    return text?.title.includes(title) && text.scrollWidth > text.clientWidth
      && button?.getBoundingClientRect().right <= innerWidth;
  }, parentTitle));
  await captureAppearance(ui, evidenceDir, 'narrow-origin');
  await cli('set', 'viewport', String(viewport.width), String(viewport.height));
  await returnToSideChat();
  await until('return selects the existing side chat', async () => await readActiveSideChat() === side.tabId);
  await openCollaboration();
  assert.deepEqual(await until('explicit view reopens collapsed collaboration', readCollaboration), worker);

  await returnToSideChat();
  await until('return before closing tab', async () => await readActiveSideChat() === side.tabId);
  await closeSidebar();
  await until('parent sidebar is collapsed', async () => !await readActiveSideChat());
  await cli('click', rowSelector(side.id));
  await until('full page opens from the left while its parent sidebar is collapsed', () => onRoute(side.id));
  await returnToSideChat();
  await until('return opens the collapsed parent sidebar and preserves its tab', async () => await readActiveSideChat() === side.tabId);
  await cli('click', `${tabSelector(side.tabId)} button[data-no-drag]`);
  await until('only the parent tab closes', () => evaluate(async (parentId, side, workerId) => {
    const api = window.electronAPI;
    if (location.hash.split('?')[0] !== '#/cc-agent/' + parentId) return false;
    const tabs = await api.localDb.rightSidebarTabs.list({ sessionId: parentId });
    const [worker] = await api.localDb.orcaWorkflows.listWorkersByLead(side.id);
    return !tabs.tabs.some(tab => tab.id === side.tabId) && !document.querySelector(`[data-tab-pill="${side.tabId}"]`)
      && !document.querySelector('[role="alertdialog"]') && worker?.sessionId === workerId
      && (await api.localDb.sessions.get(side.id)).status === 'active';
  }, parentId, side, worker.id));

  await cli('click', rowSelector(side.id));
  await until('independent task opens from task list', () => onRoute(side.id));
  await until('closed side chat has a reopen action in the origin row', () => evaluate(() => {
    const row = document.querySelector('[data-testid="linked-side-chat-origin"]');
    return /^(重新打开侧边追问|Reopen side chat)$/.test(row?.querySelector('button')?.textContent.trim() ?? '');
  }));
  await captureAppearance(ui, evidenceDir, 'closed-origin');
  await reopenSideChat();
  const reopenedTab = await until('explicit return reopens the same follow-up', readActiveSideChat);
  assert.notEqual(reopenedTab, side.tabId, 'The dismissed tab should be newly opened for the same task');
  assert.equal(await evaluate(async (parent, child) => {
    const { tabs } = await window.electronAPI.localDb.rightSidebarTabs.list({ sessionId: parent });
    return tabs.filter(tab => tab.kind === 'side-chat' && tab.state.sessionId === child).length;
  }, parentId, side.id), 1);
  await until('reopened editor still has the same draft', () => evaluate((tabId, draft) =>
    document.querySelector(`[data-tab-pill="${tabId}"]`)?.closest('aside')
      ?.querySelector('.tiptap[contenteditable="true"]')?.textContent.includes(draft), reopenedTab, sidebarDraft));

  // E2E: use the existing composer action/confirmation. A linked task should
  // retain an ordinary entry after the active team ends, with the same route.
  await toggleCollaboration();
  await clickControl('confirm ending collaboration', /button "(结束协同|Stop collaboration)"/i);
  await until('the same linked task remains listed after collaboration ends', async () =>
    await readActiveSideChat() === reopenedTab && await evaluate(async (id, selector) => {
      const task = await window.electronAPI.localDb.sessions.get(id);
      return task.sideChatPromoted === true && task.orcaRole === null && task.status === 'active'
        && Boolean(document.querySelector(selector));
    }, side.id, rowSelector(side.id)));
  await until('ordinary conversation action and left task list hint', async () => {
    // The unfiltered snapshot includes the visible hint as ordinary text.
    const snapshot = await cli('snapshot');
    return /button "(打开对话|Open conversation)"/.test(snapshot)
      && /也可从左侧任务列表打开|Also available in the task list on the left/.test(snapshot)
      && !/button "(查看协同|View collaboration)"/.test(snapshot);
  });
  await captureAppearance(ui, evidenceDir, 'ended-side-chat');
  await clickControl('open the ordinary conversation', /button "(打开对话|Open conversation)"/);
  await until('ended conversation opens as the same task without a reveal intent', () => evaluate(id =>
    location.hash.split('?')[0] === '#/cc-agent/' + id && !history.state?.usr?.orcaWorkersReveal, side.id));
  await returnToSideChat();
  await until('return from the ordinary conversation preserves the side chat', async () => await readActiveSideChat() === reopenedTab);
  await startCollaboration();
  await openCollaboration();
  const restartedWorker = await until('re-enabled collaboration reveals a new worker for the same task', async () => {
    const current = await readCollaboration();
    return current && current.id !== worker.id ? current : null;
  }, 40_000);
  assert.equal(restartedWorker.provider, providerId);
  await returnToSideChat();
  await until('final preview remains on the re-enabled follow-up', async () => await readActiveSideChat() === reopenedTab);
  return { parentId, sideChatId: side.id, worker, restartedWorker, stayedOnParent: true, sharedDraft: true,
    sidebarRevealedAgain: true, reopenedTab, openedAfterEnding: true, narrowOrigin: true, returnedAfterParentCollapse: true };
}

const evidenceDir = await mkdtemp(path.join(tmpdir(), 'cindy-sidechat-orca-e2e-'));
const preview = process.argv.includes('--preview');
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
  if (preview) {
    await ui.cli('set', 'media', 'light');
    console.log(`PREVIEW_READY pid=${pid} cdpPort=${port} modelPort=${modelPort} parent=${result.parentId} child=${result.sideChatId} tab=${result.reopenedTab}`);
    console.log(`REPORT=${evidenceDir}`);
    await new Promise(resolve => {
      connection.browser.once('disconnected', resolve);
      if (!connection.browser.isConnected()) resolve();
    });
  }
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
    console.log('PASS The linked follow-up stays in the parent and can open, reveal and return to the same task.');
  }
  console.log(`REPORT=${evidenceDir}`);
}
