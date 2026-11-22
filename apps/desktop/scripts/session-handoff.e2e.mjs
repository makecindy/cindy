// E2E, 11/19 discovery regression. The original Chinese query returned runtime
// settings. Unit tests stop at the host callback. Exercise the real Desktop,
// Claude subprocess, MCP discovery, task delivery and persisted recipient history
// with a scripted Anthropic upstream and two ordinary tasks in a test profile.
// macOS, run from the repo root.
//   sandbox="handoff-e2e-$(date +%s)"
//   profile="$(node -p "require('path').join(require('os').homedir(),'Library/Application Support','CindyGlobal-dev2-'+process.argv[1])" "$sandbox")"
//   runDir="$(mktemp -d /tmp/cindy-handoff.XXXXXXXX)"
//   cdpPort="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
//   mkdir -p "$runDir/cli-home" "$runDir/electron/Electron.app/Contents/MacOS"
//   printf '#!/bin/sh\nexec "%s" --use-mock-keychain "$@"\n' "$(node -p 'require("electron")')" > "$runDir/electron/Electron.app/Contents/MacOS/Electron"
//   chmod +x "$runDir/electron/Electron.app/Contents/MacOS/Electron"
//   env -u CODEX_HOME -u OPENAI_API_KEY -u CODEX_API_KEY -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME="$runDir/cli-home" USERPROFILE="$runDir/cli-home" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 XDT_USER_DATA_DIR="$profile" XDT_USER_DATA_DIR_EPOCH=1 XDT_ISOLATED_NAME="$sandbox" XDT_CDP_PORT="$cdpPort" XDT_DISABLE_MODELS_FETCH=1 ELECTRON_OVERRIDE_DIST_PATH="$runDir/electron" node scripts/restart-desktop-remote.mjs --region=global --isolated --passive --refuse-running --reuse-terminal --wait-ready
// Keep the launch terminal open. After DESKTOP_DEV_VERDICT=ready, open a second
// terminal in this checkout and set profile, runDir and cdpPort to the same values:
//   CINDY_HANDOFF_E2E_PROFILE="$profile" CINDY_HANDOFF_E2E_CLI_HOME="$runDir/cli-home" CINDY_HANDOFF_E2E_CDP_PORT="$cdpPort" node apps/desktop/scripts/session-handoff.e2e.mjs
// Quit that test Desktop before removing the runDir created above. Its local
// tasks and delivery history remain available in the dedicated profile.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const profile = await fs.realpath(process.env.CINDY_HANDOFF_E2E_PROFILE ?? '');
const temp = await fs.realpath(os.tmpdir());
const cliHome = process.env.CINDY_HANDOFF_E2E_CLI_HOME;
assert.ok(cliHome && path.isAbsolute(cliHome), 'Set CINDY_HANDOFF_E2E_CLI_HOME to the launch home');
const realCliHome = await fs.realpath(cliHome);
assert.ok(realCliHome.startsWith(temp + path.sep) || realCliHome.startsWith('/private/tmp/'));
assert.ok(!/\s/.test(cliHome), 'The dedicated CLI home must have no spaces');
for (const relative of ['.claude', '.claude/projects', '.claude.json']) {
  try {
    assert.ok(!(await fs.lstat(path.join(realCliHome, relative))).isSymbolicLink(), `Test CLI home contains a symlink at ${relative}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const port = Number(process.env.CINDY_HANDOFF_E2E_CDP_PORT);
assert.ok(Number.isSafeInteger(port) && port > 1024 && port <= 65535);
assert.match(path.basename(profile), /^CindyGlobal-dev2-handoff-e2e(?:-[A-Za-z0-9_-]+)?$/);
assert.equal(path.dirname(profile), path.join(os.homedir(), 'Library', 'Application Support'));
assert.equal(process.platform, 'darwin', 'This fixture currently checks macOS Desktop process identity');

const listener = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 5000 });
const pids = listener.stdout.match(/^p\d+$/gm) ?? [];
assert.equal(pids.length, 1, 'CDP must identify one test Desktop process');
const pid = Number(pids[0].slice(1));
const record = JSON.parse(await fs.readFile(path.join(profile, '.dev-instances', `${pid}.json`), 'utf8'));
assert.equal(record.pid, pid);
// With an independent CLI home the app may classify the explicit path as a
// custom profile. Only the dedicated named path above is accepted in either case.
assert.equal(record.isolationIntent, true);
assert.ok(['isolated-sandbox', 'custom'].includes(record.profileKind));
assert.equal(record.passive, true);
assert.equal(record.state, 'ready');
assert.equal(await fs.realpath(record.rootDir), await fs.realpath(fileURLToPath(new URL('../../..', import.meta.url))));
assert.equal(await fs.realpath(record.userDataDir), profile);
const identity = await run('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
  timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
});
const processInfo = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(identity.stdout.trim());
assert.ok(processInfo && record.processIdentity, 'Desktop process identity is unavailable');
assert.equal(Date.parse(`${processInfo[1]} UTC`), record.processIdentity.startedAtMs);
assert.equal(processInfo[2], record.processIdentity.executablePath);
// Never log the process environment. Verify the launcher isolated the HOME
// inherited by Claude before letting the renderer submit any task.
const { stdout: desktopEnvironment } = await run('ps', ['eww', '-p', String(pid), '-o', 'command='], { timeout: 5000 })
  .catch(() => { throw new Error('Could not verify the isolated Desktop environment'); });
assert.ok(desktopEnvironment.includes(` HOME=${cliHome} `), 'Desktop did not inherit the isolated CLI home');
assert.ok(!/\sCLAUDE_CONFIG_DIR=/.test(desktopEnvironment), 'Unexpected Claude config override');
assert.ok(desktopEnvironment.includes(' --use-mock-keychain '), 'Use the mock Electron keychain');

const runId = randomUUID();
const browser = (...args) => run('agent-browser', ['--session', `handoff-${runId}`, '--cdp', String(port), ...args], {
  timeout: 35_000, maxBuffer: 2 * 1024 * 1024,
});
const renderer = async (fn, argument) => {
  const script = `(${fn})(${JSON.stringify(argument) ?? ''})`;
  const { stdout } = await browser('--json', 'eval', '-b', Buffer.from(script).toString('base64'));
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, JSON.stringify(result.error));
  return result.data.result;
};

const id = runId.slice(0, 12);
const fixtureModel = 'claude-sonnet-4-6';
const from = randomUUID();
const to = randomUUID();
const originalTitle = `Handoff sender ${id}`;
const renamedTitle = `Handoff renamed ${id}`;
const marker = `handoff-${runId} | 中文\nsecond line`;
const discoveryPrompt = `发消息给另一个任务会话 [discovery ${id}]`;
const renameLookupPrompt = `把这个会话改名 [rename lookup ${id}]`;
const renamePrompt = `把这个会话改名 [rename ${id}]`;
const dispatchPrompt = `发消息给另一个任务会话 [dispatch ${id}]`;
const referencePrompt = `让它看一下 [reference ${id}]`;
const received = [];
const prefix = 'mcp__cindy_helper__';
let phase;
let fixtureError;
let requestNumber = 0;
let dispatchBinding;
let renameTool;
let renameCount = 0;
const fixtureAssertionFailures = new Map();

const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_e2e_${requestNumber}`, name, input });
const answer = text => ({ type: 'text', text });
const messageText = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.filter(block => block.type === 'text').map(block => block.text).join('') : '';
const lastUser = body => body.messages?.findLast(message => message.role === 'user');
const expectFixtureHint = (value, pattern, label) => {
  try {
    assert.match(value, pattern);
  } catch (error) {
    if (!fixtureAssertionFailures.has(label)) fixtureAssertionFailures.set(label, `${label}: ${error.message}`);
  }
};

function readToolResult(body, previous) {
  const block = body.messages?.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .find(item => item.type === 'tool_result' && item.tool_use_id === previous.id);
  assert.ok(block, `Claude did not return a tool_result for ${previous.name}: ${JSON.stringify(previous)}`);
  assert.ok(!block.is_error, `Claude did not receive a successful result for ${previous.name}: ${JSON.stringify(block)}`);
  return block;
}

function latestUserPrompt(body) {
  return body.messages?.findLast(message => {
    if (message.role !== 'user') return false;
    if (typeof message.content === 'string') return true;
    return Array.isArray(message.content)
      && message.content.some(item => item.type === 'text' && typeof item.text === 'string')
      && !message.content.some(item => item.type === 'tool_result');
  });
}

function latestToolUseAfterPrompt(body) {
  const promptIndex = body.messages?.findLastIndex(message => message === latestUserPrompt(body)) ?? -1;
  if (promptIndex < 0) return undefined;
  for (let index = (body.messages?.length ?? 0) - 1; index > promptIndex; index -= 1) {
    const message = body.messages[index];
    const tool = Array.isArray(message?.content)
      ? message.content.findLast(item => item.type === 'tool_use')
      : undefined;
    if (message?.role === 'assistant' && tool) return tool;
  }
  return undefined;
}

function describeTool(body, name) {
  return body.tools?.find(tool => tool.name === name && typeof tool.description === 'string');
}

function nextFixtureBlock(body) {
  const message = messageText(lastUser(body)?.content);
  const prompt = messageText(latestUserPrompt(body)?.content);
  if (message.includes(marker)) {
    // Claude Code can make a second provider request while finalizing one
    // deferred turn. Count the persisted handoff payload once while checking
    // the same prompt and reply guidance on every request.
    if (!received.some(content => content.includes(`\n\n${marker}`))) received.push(message);
    console.log('receiver model input', JSON.stringify(message));
    expectFixtureHint(message, /需要回复时再用 cindy_helper 的 call_tool[\s\S]*name="send_to_session"[\s\S]*只有用户要求你回复，或确实需要回复时才这样做[\s\S]*不要主动只为说“收到”或“好的”回复/, 'message source reply guidance');
    return answer(`receiver-finished-${id}`);
  }
  if (message.includes(`receiver-seed-${id}`)) return answer(`receiver-ready-${id}`);
  assert.ok(phase, 'Unexpected Claude request outside the E2E turn');
  if (phase === 'reference') {
    assert.ok(prompt.includes(referencePrompt), `Unexpected source prompt in reference: ${prompt}`);
    assert.match(message, /\[Referenced conversation\]/);
    expectFixtureHint(message, new RegExp(`Action: this is the conversation the user referenced\\.[\\s\\S]*Do not send merely because it is referenced[\\s\\S]*cindy_helper's call_tool[\\s\\S]*name="send_to_session"[\\s\\S]*target_session_id="${to}"`), 'reference send guidance');
    return answer(`reference-finished-${id}`);
  }
  const list = prefix + 'list_tools';
  const call = prefix + 'call_tool';
  const tool = latestToolUseAfterPrompt(body);
  const initial = !tool;
  if (initial) {
    const expectedPrompt = { discover: discoveryPrompt, renameLookup: renameLookupPrompt, rename: renamePrompt, dispatch: dispatchPrompt }[phase];
    assert.ok(prompt.includes(expectedPrompt), `Unexpected source prompt in ${phase}`);
    const listTool = describeTool(body, list);
    // Claude Code may defer MCP tool disclosure until after the first request.
    // The fixture drives the same production tool calls from the transcript, so
    // absence of the direct listing is evidence of delayed loading, not a failure.
    if (listTool) assert.match(listTool.description, /send_to_session/, 'MCP list_tools does not advertise send_to_session');
    assert.ok(!body.tools?.some(tool => tool.name === prefix + 'send_to_session'));
    console.log('Claude tool discovery', JSON.stringify({ phase, entry: list, nativeSearch: false }));
  }
  // Claude Code 2.1.x executes the first MCP lookup internally when the
  // provider advertises no tools. The following request is the real model
  // request with the helper server loaded, but that internal lookup is not
  // echoed as a tool_result. Only return the loader call here. Every call
  // below is exposed to the model and must come back with a real tool_result.
  if (initial && !(body.tools?.length)) {
    return toolUse(list, phase === 'discover' ? { name: 'send_to_session' } : { query: '把这个会话改名' });
  }
  if (initial && body.tools?.length) {
    if (phase === 'discover' || phase === 'renameLookup') return toolUse(list, { query: phase === 'discover' ? '发消息给另一个任务会话' : '把这个会话改名' });
    if (phase === 'rename') return toolUse(call, { name: renameTool.name, args: { title: renamedTitle } });
    assert.equal(phase, 'dispatch');
    assert.ok(dispatchBinding, 'send_to_session binding was not discovered');
    return toolUse(prefix + dispatchBinding.tool, {
      ...dispatchBinding.args, args: { target_session_id: to, message: marker },
    });
  }
  assert.ok(tool, `Expected a real MCP tool result while handling ${phase}`);
  const result = JSON.parse(messageText(readToolResult(body, tool).content).split('\n<system-reminder>', 1)[0]);
  if (phase === 'discover') {
    if (tool.input.name) {
      assert.equal(result.tool?.name, 'send_to_session');
      assert.equal(result.tool.inputSchema.properties.target_session_id.type, 'string');
      return toolUse(list, { query: '发消息给另一个任务会话' });
    }
    if (tool.input.query) {
      assert.equal(result.items?.[0]?.key, 'native.send_to_session', 'Original Chinese query failed to discover send_to_session');
      console.log('Chinese discovery', JSON.stringify({ query: tool.input.query, key: result.items[0].key }));
      return toolUse(prefix + result.items[0].next.tool, result.items[0].next.args);
    }
    dispatchBinding = result.control?.operations?.[0]?.call;
    assert.equal(dispatchBinding?.tool, 'call_tool');
    assert.equal(dispatchBinding.args.name, 'send_to_session');
    return answer(`discovery-finished-${id}`);
  }
  if (phase === 'renameLookup') {
    if (tool.input.query) {
      assert.equal(result.ok, true);
      assert.ok(Array.isArray(result.items));
      assert.ok(!result.items.some(item => item.key === 'native.send_to_session'));
      return toolUse(list, { category: 'control' });
    }
    assert.ok(!result.tools?.some(tool => tool.name === 'send_to_session'));
    renameTool = result.tools?.find(tool => tool.name === 'set_current_session_title');
    assert.ok(renameTool);
    return answer(`rename-lookup-finished-${id}`);
  }
  if (phase === 'rename') {
    assert.deepEqual({ sessionId: result.session_id, title: result.title }, { sessionId: from, title: renamedTitle });
    renameCount += 1;
    console.log('rename receipt', JSON.stringify(result));
    return answer(`rename-finished-${id}`);
  }
  assert.equal(phase, 'dispatch');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target_session_id, to);
  assert.ok(['already-active', 'resumed', 'queued'].includes(result.wake_kind), JSON.stringify(result));
  console.log('dispatch receipt', JSON.stringify(result));
  return answer(`dispatch-finished-${id}`);
}

function sendMessage(res, body, block) {
  const isTool = block.type === 'tool_use';
  const stop = isTool ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: 1, output_tokens: 1 };
  const message = { id: `msg_e2e_${requestNumber}`, type: 'message', role: 'assistant',
    model: body.model, content: [], stop_reason: null, stop_sequence: null, usage };
  const events = [
    ['message_start', { message }],
    ['content_block_start', { index: 0, content_block: isTool ? { ...block, input: {} } : { ...block, text: '' } }],
    ['content_block_delta', { index: 0, delta: isTool
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', {}],
  ];
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end(events.map(([type, props]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...props })}\n\n`).join(''));
}

const upstream = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const part of req) raw += part;
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}');
      return;
    }
    if (!url.pathname.endsWith('/messages')) {
      res.writeHead(404).end();
      return;
    }
    assert.ok(req.headers['x-api-key'] === 'fixture-handoff-key', 'Only synthetic fixture authentication is allowed');
    const body = JSON.parse(raw);
    assert.equal(body.model, fixtureModel);
    requestNumber += 1;
    const receiver = messageText(lastUser(body)?.content).includes(marker) || messageText(lastUser(body)?.content).includes(`receiver-seed-${id}`);
    const block = nextFixtureBlock(body);
    sendMessage(res, body, block);
  } catch (error) {
    fixtureError ??= error;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }));
  }
});

const listSessions = () => renderer(() => window.electronAPI.localDb.sessions.list(1_000, 'all', { fresh: true }));
const messages = sessionId => renderer(session => window.electronAPI.localDb.messages.list(session, { limit: 100 }), sessionId);
const recordedText = row => typeof row.content === 'string' ? row.content : messageText(row.content);
async function transcriptFiles() {
  try {
    return await fs.readdir(path.join(realCliHome, '.claude', 'projects'), { recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
const waitFor = async (label, read) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    const result = await read();
    if (result) return result;
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const providerName = `Handoff e2e ${id}`;
try {
  const main = await waitFor('isolated main Desktop renderer', async () => {
    const { stdout } = await browser('--json', 'tab');
    return JSON.parse(stdout).data.tabs.find(target => target.type === 'page' && /^http:\/\/localhost:\d+\/#\//.test(target.url));
  });
  await browser('tab', main.tabId);
  const auth = await renderer(() => window.electronAPI.authInitialize());
  assert.ok(auth.mode === 'signed-out' || (auth.mode === 'local' && !auth.isAuthenticated));
  if (auth.mode === 'signed-out') {
    const local = await renderer(() => window.electronAPI.authEnterLocal());
    assert.equal(local.dataOwnerId, 'local-v1');
  }
  assert.equal((await renderer(() => window.electronAPI.authInitialize())).dataOwnerId, 'local-v1');
  const database = await renderer(() => window.electronAPI.localDb.ensureReady('local-v1'));
  assert.equal(database.ready, true, JSON.stringify(database.error));
  const baseline = (await listSessions()).map(item => item.id);
  const fixtureWorkDir = await fs.mkdtemp(path.join(realCliHome, 'work-'));
  const provider = await renderer(async ({ id, origin, name, model }) => {
    const config = { id: `handoff-e2e-${id}`, name, auth: { method: 'apiKey' }, runtimes: {
      'claude-code': { baseUrl: origin, wireProtocol: 'anthropic-messages',
        models: [{ id: model, name: model, contextWindow: 200_000, maxOutput: 1024 }] },
    } };
    await window.electronAPI.maker.createCustomProvider(config, { 'claude-code': 'fixture-handoff-key' });
    return (await window.electronAPI.maker.listProviders()).providers.find(entry => entry.name === name);
  }, { id, origin, name: providerName, model: fixtureModel });
  assert.ok(provider?.id, 'Synthetic provider was not created');
  const create = (sessionId, title) => renderer(({ sessionId, title, workDir, model, providerId }) =>
    window.electronAPI.localDb.sessions.create({
      id: sessionId, title, workingDir: workDir, workspaceKind: 'dialogue',
      agentKind: 'cc', model, providerId, permissionMode: 'bypassPermissions',
    }), { sessionId, title, workDir: fixtureWorkDir, model: fixtureModel, providerId: provider.id });
  assert.equal((await create(from, originalTitle)).id, from);
  assert.equal((await create(to, `Handoff receiver ${id}`)).id, to);
  const send = async (sessionId, text) => {
    const receipt = await renderer(({ sessionId, text, model, workDir }) => window.electronAPI.maker.send(
      sessionId, text, { agentKind: 'claude-code', workingDir: workDir, model,
        permissionMode: 'bypassPermissions', makerMemoryEnabled: false }, { throwOnStartFailure: true },
    ), { sessionId, text, model: fixtureModel, workDir: fixtureWorkDir });
    assert.equal(receipt.accepted, true, JSON.stringify(receipt));
  };
  const enqueueReference = async () => {
    const href = `cindy://session/${to}`;
    const text = `${referencePrompt} ${href}`;
    const clientId = `reference-${id}`;
    const reference = { kind: 'session', start: text.indexOf(href), end: text.length, href, sessionId: to, title: `Handoff receiver ${id}` };
    const item = {
      clientId, text, persistedContent: text, model: fixtureModel, effort: 'medium',
      permissionMode: 'bypassPermissions', workingDir: fixtureWorkDir,
      chatMessage: { clientId, role: 'user', content: text, agentReferences: [reference] },
      agentReferences: [reference],
      createOpts: { agentKind: 'claude-code', workingDir: fixtureWorkDir, model: fixtureModel,
        effort: 'medium', permissionMode: 'bypassPermissions' },
    };
    const projection = await renderer(({ sessionId, item }) => window.electronAPI.maker.input.enqueue(sessionId, item), { sessionId: from, item });
    assert.ok(projection, 'Reference input was not enqueued');
  };
  const waitForAnswer = (sessionId, text) => waitFor(text, async () =>
    (await messages(sessionId)).some(row => row.role === 'assistant' && recordedText(row).includes(text)));
  const checkTaskIds = async () => assert.deepEqual(
    (await listSessions()).map(item => item.id).sort(), [...baseline, from, to].sort(), 'Lookup, rename or send created an extra task',
  );
  const receiverUserRows = async () => (await messages(to)).filter(row => row.role === 'user').map(recordedText);
  const titles = async () => new Map((await listSessions()).map(row => [row.id, row.title]));
  const beforeTranscripts = new Set(await transcriptFiles());
  await send(to, `receiver-seed-${id}`);
  await waitForAnswer(to, `receiver-ready-${id}`);
  await waitFor('new Claude transcript in the test home', async () =>
    (await transcriptFiles()).some(file => file.endsWith('.jsonl') && !beforeTranscripts.has(file)));
  const recipientBefore = await receiverUserRows();
  const titlesBefore = await titles();

  phase = 'discover';
  await send(from, discoveryPrompt);
  await waitForAnswer(from, `discovery-finished-${id}`);
  await checkTaskIds();
  assert.deepEqual(await receiverUserRows(), recipientBefore);
  assert.deepEqual(await titles(), titlesBefore);
  assert.equal(received.length, 0);
  console.log('PASS discovery had no delivery, title change or extra task');

  phase = 'renameLookup';
  await send(from, renameLookupPrompt);
  await waitForAnswer(from, `rename-lookup-finished-${id}`);
  await checkTaskIds();
  assert.deepEqual(await titles(), titlesBefore);
  assert.deepEqual(await receiverUserRows(), recipientBefore);
  assert.equal(received.length, 0);

  phase = 'rename';
  await send(from, renamePrompt);
  await waitForAnswer(from, `rename-finished-${id}`);
  await checkTaskIds();
  await waitFor('renamed source task persisted', async () => (await titles()).get(from) === renamedTitle);
  titlesBefore.set(from, renamedTitle);
  assert.deepEqual(await titles(), titlesBefore);
  assert.equal(renameCount, 1);
  assert.deepEqual(await receiverUserRows(), recipientBefore);
  assert.equal(received.length, 0);
  console.log('PASS rename changed exactly the source task and made no delivery');

  phase = 'reference';
  await enqueueReference();
  await waitForAnswer(from, `reference-finished-${id}`);
  await checkTaskIds();
  assert.deepEqual(await receiverUserRows(), recipientBefore);
  assert.equal(received.length, 0);
  console.log('PASS referenced conversation included the optional send path without delivery');

  phase = 'dispatch';
  await send(from, dispatchPrompt);
  await waitForAnswer(from, `dispatch-finished-${id}`);
  await waitForAnswer(to, `receiver-finished-${id}`);
  await checkTaskIds();
  const after = await receiverUserRows();
  assert.equal(after.filter(content => content === marker).length, 1, 'Recipient must persist one exact message');
  assert.equal(after.length, recipientBefore.length + 1);
  assert.equal(received.length, 1, 'Recipient runtime must receive one delivery');
  assert.ok(received[0].includes(marker) && received[0].includes(from), 'Recipient runtime lost the sender identity or exact payload');
  assert.equal(fixtureAssertionFailures.size, 0, [...fixtureAssertionFailures.values()].join('\n'));
  console.log('PASS', JSON.stringify({ from, to, title: renamedTitle, marker, deliveries: 1, renameCount, addedTasks: 2 }));
} finally {
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  // The profile is disposable. Preserve its test records for inspection.
}
