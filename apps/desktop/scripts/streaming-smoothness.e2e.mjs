// Black-box streaming smoothness benchmark (manual e2e tier).
//
// Launches a fresh isolated `--mock` Desktop from this checkout, points a
// Codex task at a loopback-only Responses fixture and streams scripted Markdown
// through the real path: Codex runtime -> main IPC -> renderer store ->
// MarkdownRenderer. The renderer is sampled every animation frame (visible
// answer length, scroll position), plus long tasks, Event Timing input latency
// and CDP renderer CPU counters. No real model, account or network upstream.
//
//   node apps/desktop/scripts/streaming-smoothness.e2e.mjs --label after [--runs 2] [--assert]
//   node apps/desktop/scripts/streaming-smoothness.e2e.mjs --compare <before.json> <after.json>
//
// Run the same script on both revisions, one at a time, with no other build or
// test running. `--assert` fails when a scenario misses the smoothness budget
// documented in DESIGN.md §14.4 (stream pacing) — this is the black-box guard
// against reintroducing fixed render throttles or unpaced bursts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const region = 'global';
const model = 'stream-smoothness-e2e-model';
const providerId = 'stream-smoothness-e2e-fixture';
const fakeKey = 'stream-smoothness-fixture-not-a-credential';

// ── Scripted answers ─────────────────────────────────────────────────────────
function mediumDoc() {
  return [
    '## 排查结论',
    '',
    '登录页在窄窗口下错位，根因是 **侧栏宽度** 在 `resize` 时没有重新计算，导致主内容区被挤出视口。下面按影响面、修复方式和验证步骤说明。',
    '',
    'The layout engine measures the sidebar once during mount and caches the width. When the window shrinks below the breakpoint the cached value stays, so the content column overflows by exactly the stale delta.',
    '',
    '- 影响范围：所有宽度小于 720px 的窗口，包括分屏和小屏笔记本。',
    '- 触发条件：先以宽窗口打开，再拖窄；直接以窄窗口启动不会复现。',
    '- 用户感知：输入框右侧被裁掉，发送按钮不可见。',
    '',
    '```ts',
    'function useSidebarWidth(ref: RefObject<HTMLElement>) {',
    '  const [width, setWidth] = useState(0);',
    '  useLayoutEffect(() => {',
    '    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));',
    '    if (ref.current) observer.observe(ref.current);',
    '    return () => observer.disconnect();',
    '  }, [ref]);',
    '  return width;',
    '}',
    '```',
    '',
    '| 步骤 | 预期 | 结果 |',
    '| --- | --- | --- |',
    '| 宽窗口打开后拖窄 | 内容区跟随收窄 | 通过 |',
    '| 窄窗口启动 | 布局正常 | 通过 |',
    '| 切换深色模式 | 无闪烁 | 通过 |',
    '',
    '修复后我又检查了分屏模式和系统缩放 125% 的情况，两者都表现正常。如果你还在别的窗口尺寸下看到错位，把截图和窗口宽度发给我，我再继续定位。',
    '',
    'One more note: the same cached-width pattern exists in the settings sidebar, so I updated it in the same change to keep both surfaces consistent.',
  ].join('\n');
}

function longDoc() {
  const sections = [];
  const topics = ['背景', '数据来源', '分析方法', '小结', '风险', '实施计划', '小结', '附录'];
  topics.forEach((topic, index) => {
    sections.push(`## ${topic}`);
    sections.push('');
    for (let p = 0; p < 3; p++) {
      sections.push(`第 ${index + 1} 部分第 ${p + 1} 段：这一段说明${topic}相关的上下文，包括历史决策、当前约束以及为什么选择这个方案。We keep the paragraph long enough to wrap several lines in a typical chat column so layout and line breaking participate in every update, exactly like a real report.`);
      sections.push('');
    }
    sections.push(`- 要点一：${topic}的第一个结论，附带一个 \`inline_code()\` 引用。`);
    sections.push(`- 要点二：${topic}的第二个结论，引用 **加粗术语** 与 *强调*。`);
    sections.push('- 要点三：需要后续确认的问题。');
    sections.push('');
    if (index % 2 === 0) {
      sections.push('```python');
      for (let l = 0; l < 8; l++) sections.push(`def step_${index}_${l}(value):\n    return value * ${l + 1}  # ${topic}`);
      sections.push('```');
      sections.push('');
    } else {
      sections.push('| 指标 | 本期 | 上期 | 变化 |');
      sections.push('| --- | --- | --- | --- |');
      for (let r = 0; r < 4; r++) sections.push(`| ${topic}-${r} | ${100 + r * 7} | ${96 + r * 5} | +${r + 4}% |`);
      sections.push('');
    }
  });
  return sections.join('\n');
}

// Output-rate tiers cover slow reasoning models through very fast inference
// (1000+ tokens/s ≈ 4000 chars/s). Delays are fixture-side; the Codex runtime
// and the 32ms renderer batcher sit in between, exactly as in production.
const SCENARIOS = {
  slow: { doc: () => mediumDoc().slice(0, 900), chunk: 3, everyMs: 50, note: '~60 chars/s (slow reasoning model)' },
  steady: { doc: mediumDoc, chunk: 4, everyMs: 25, note: 'small tokens at ~160 chars/s' },
  bursty: { doc: mediumDoc, chunk: 320, everyMs: 450, note: '320-char bursts every 450ms (proxy-like)' },
  long: { doc: longDoc, chunk: 12, everyMs: 20, note: '~11k chars, 8 headings, code and tables at ~600 chars/s' },
  typing: { doc: mediumDoc, chunk: 4, everyMs: 25, typing: true, note: 'steady stream while typing in the composer' },
  fast: { doc: longDoc, chunk: 30, everyMs: 20, note: '~1500 chars/s on the long report' },
  turbo: { doc: longDoc, chunk: 80, everyMs: 20, note: '~4000 chars/s (1000+ tokens/s models) on the long report' },
};

// ── Loopback Responses fixture ───────────────────────────────────────────────
function sse(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function modelFixture(state) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && pathname.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      if (request.method !== 'POST' || !pathname.endsWith('/responses')) {
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
      const input = JSON.stringify(payload.input);
      const name = /SCENARIO:([a-z]+)/.exec(input)?.[1];
      const scenario = name && SCENARIOS[name];
      const isPrimary = scenario && state.active?.name === name && !state.active.served;
      const text = isPrimary ? scenario.doc() : 'OK';
      if (isPrimary) state.active.served = true;
      const id = `resp_${++state.count}`;
      const itemId = `msg_${state.count}`;
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      sse(response, { type: 'response.created', response: { id, status: 'in_progress', output: [] } });
      sse(response, { type: 'response.output_item.added', output_index: 0,
        item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      sse(response, { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] } });
      const codePoints = Array.from(text);
      const step = isPrimary ? scenario.chunk : codePoints.length;
      const sent = [];
      for (let at = 0; at < codePoints.length; at += step) {
        const delta = codePoints.slice(at, at + step).join('');
        sse(response, { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta });
        sent.push([Date.now(), Math.min(codePoints.length, at + step)]);
        if (isPrimary && state.active.firstDeltaAt == null) state.active.firstDeltaAt = Date.now();
        if (isPrimary && at + step < codePoints.length) await delay(scenario.everyMs);
      }
      const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] };
      sse(response, { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text });
      sse(response, { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0,
        part: { type: 'output_text', text, annotations: [] } });
      sse(response, { type: 'response.output_item.done', output_index: 0, item });
      sse(response, { type: 'response.completed', response: { id, status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: codePoints.length, total_tokens: codePoints.length + 10 } } });
      response.end();
      if (isPrimary) Object.assign(state.active, { sent, endedAt: Date.now(), totalChars: codePoints.length });
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
}

// ── Launch / cleanup (same contract as side-chat-orca-e2e.mjs) ───────────────
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function until(description, read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function launchDesktop(port, sandbox, evidenceDir) {
  const env = { ...process.env, XDT_CDP_PORT: String(port) };
  for (const key of ['XDT_USER_DATA_DIR', 'XDT_USER_DATA_DIR_EPOCH', 'XDT_ISOLATED_NAME',
    'XDT_DEVICE_ID_OVERRIDE', 'CINDY_HOST_API', 'XDT_LOGIN_SCENARIO']) delete env[key];
  const args = ['restart:desktop:remote', '--', `--region=${region}`, `--isolated=${sandbox}`,
    '--isolated-auth', '--mock', '--passive', '--refuse-running'];
  let receipt;
  try {
    receipt = await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args,
      { cwd: root, env, timeout: 300_000, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' });
  } catch (error) {
    await writeFile(path.join(evidenceDir, 'launch.log'), `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    if (/refuses occupied checkout/.test(error.stderr ?? '')) {
      throw new Error('Close the running Desktop dev instance in this checkout before running this benchmark.', { cause: error });
    }
    throw error;
  }
  await writeFile(path.join(evidenceDir, 'launch.log'), `${receipt.stdout}\n${receipt.stderr}`);
  assert.match(receipt.stdout, /^DESKTOP_DEV_VERDICT=ready$/m);
  assert.match(receipt.stdout, /^mode=isolated$/m);
  const pid = Number(/^pid=(\d+)$/m.exec(receipt.stdout)?.[1]);
  assert.ok(pid > 0, 'Desktop launcher did not report its PID');
  return pid;
}

async function removeSandbox(profile) {
  let info;
  try { info = await lstat(profile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Refusing to remove a redirected sandbox');
  await until('the benchmark Desktop to release its profile', () => {
    const { processes, error } = scanProcessTable();
    if (error) throw new Error(`Cannot verify that the sandbox is unused: ${error.message}`);
    return !processes.some(process => process.command.includes(profile));
  }, 20_000);
  await rm(profile, { recursive: true, force: true });
}

// ── Renderer instrumentation ─────────────────────────────────────────────────
function installProbe() {
  const state = { frames: [], long: [], events: [], running: true };
  window.__streamSmoothness = state;
  const longObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.long.push([performance.timeOrigin + entry.startTime, entry.duration]);
  });
  longObserver.observe({ type: 'longtask' });
  const eventObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (/^key|^input|^beforeinput/.test(entry.name)) state.events.push([entry.name, entry.duration]);
    }
  });
  eventObserver.observe({ type: 'event', durationThreshold: 16 });
  const findScroller = (element) => {
    for (let node = element?.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  };
  let scroller = null;
  let lastScrollerLookup = -Infinity;
  // Read after the frame has been rendered (posted task after rAF): layout is
  // clean then, so the probe never forces a synchronous layout of its own.
  const channel = new MessageChannel();
  let pendingTime = 0;
  channel.port1.onmessage = () => {
    const answers = document.querySelectorAll('.msg-markdown');
    const answer = answers[answers.length - 1];
    if (answer && (!scroller || !scroller.isConnected) && pendingTime - lastScrollerLookup > 500) {
      lastScrollerLookup = pendingTime;
      scroller = findScroller(answer);
    }
    state.frames.push([performance.timeOrigin + pendingTime, answer ? answer.textContent.length : 0, scroller ? scroller.scrollTop : 0]);
  };
  const tick = (time) => {
    pendingTime = time;
    channel.port2.postMessage(0);
    if (state.running) requestAnimationFrame(tick);
    else { longObserver.disconnect(); eventObserver.disconnect(); channel.port1.close(); }
  };
  requestAnimationFrame(tick);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

export function summarize(raw) {
  const { frames, long, events, server, cpu, wallMs } = raw;
  const first = frames.findIndex(([, length]) => length > 0);
  const finalLength = frames.at(-1)?.[1] ?? 0;
  const done = frames.findIndex(([, length]) => length >= finalLength);
  const window = first >= 0 && done >= first ? frames.slice(first, done + 1) : [];
  const start = window[0]?.[0] ?? 0;
  const end = window.at(-1)?.[0] ?? 0;
  const durationS = Math.max(0.001, (end - start) / 1000);
  const changes = [];
  const intervals = [];
  for (let i = 1; i < window.length; i++) {
    intervals.push(window[i][0] - window[i - 1][0]);
    const added = window[i][1] - window[i - 1][1];
    if (added > 0) changes.push([window[i][0], added]);
  }
  const gaps = [];
  for (let i = 1; i < changes.length; i++) gaps.push(changes[i][0] - changes[i - 1][0]);
  const buckets = [];
  for (let t = start; t < end; t += 100) {
    buckets.push(changes.filter(([at]) => at >= t && at < t + 100).reduce((sum, [, n]) => sum + n, 0));
  }
  const mean = buckets.reduce((a, b) => a + b, 0) / Math.max(1, buckets.length);
  const std = Math.sqrt(buckets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, buckets.length));
  const scrollJumps = [];
  for (let i = 1; i < window.length; i++) scrollJumps.push(Math.abs(window[i][2] - window[i - 1][2]));
  const inStream = ([at]) => at >= start && at <= end + 500;
  const longInStream = long.filter(inStream);
  return {
    visibleUpdatesPerSec: round(changes.length / durationS),
    medianUpdateGapMs: round(percentile(gaps, 50)),
    p95UpdateGapMs: round(percentile(gaps, 95)),
    maxUpdateGapMs: round(Math.max(0, ...gaps)),
    maxCharsPerUpdate: Math.max(0, ...changes.map(([, n]) => n)),
    p95CharsPerUpdate: percentile(changes.map(([, n]) => n), 95),
    per100msCv: round(mean ? std / mean : 0, 2),
    lastUpdateChars: changes.at(-1)?.[1] ?? 0,
    endLatencyMs: server?.endedAt ? round(end - server.endedAt) : null,
    firstPaintLatencyMs: server?.firstDeltaAt ? round(start - server.firstDeltaAt) : null,
    p95FrameMs: round(percentile(intervals, 95)),
    framesOver50ms: intervals.filter(ms => ms > 50).length,
    maxScrollJumpPx: round(Math.max(0, ...scrollJumps)),
    longTasks: longInStream.length,
    longTaskTotalMs: round(longInStream.reduce((sum, [, ms]) => sum + ms, 0)),
    maxLongTaskMs: round(Math.max(0, ...longInStream.map(([, ms]) => ms))),
    // Event Timing only reports events >=16ms (8ms granularity); keypress/keydown
    // durations include the time until the next paint, so this tracks typing lag.
    slowInputEvents: events.filter(([, ms]) => ms >= 50).length,
    p90InputMs: round(percentile(events.map(([, ms]) => ms), 90)),
    maxInputMs: round(Math.max(0, ...events.map(([, ms]) => ms))),
    rendererCpuPct: wallMs ? round((cpu.TaskDuration * 1000 / wallMs) * 100) : null,
    rendererScriptPct: wallMs ? round((cpu.ScriptDuration * 1000 / wallMs) * 100) : null,
    streamSeconds: round(durationS, 2),
  };
}

// Budgets (DESIGN.md §14.4 stream pacing). Each line names the regression it
// catches; keep them in sync with the documented contract, never loosen them
// to make a slower implementation pass.
const BUDGETS = {
  // Fixed 100–400ms render throttles yield ≤10 visible updates/s (2026-11-25 baseline: 3–10/s).
  visibleUpdatesPerSec: [
    { min: 18, scenarios: ['steady', 'bursty', 'long', 'fast', 'turbo'] },
    // Word-boundary reveal at ~60 chars/s is ~12 words/s at most.
    { min: 12, scenarios: ['slow'] },
    // typing-first: at least 50ms between publishes while the composer is typing (baseline 3.9/s).
    { min: 10, scenarios: ['typing'] },
  ],
  // Unpaced bursts, or dumping the backlog when the stream ends, land in one frame (baseline 309 / 629).
  maxCharsPerUpdate: [
    { max: 160, scenarios: ['bursty'] },
    { max: 400, scenarios: ['turbo'] },
  ],
  // The reveal must not stall between batches (baseline p95 117–467ms).
  p95UpdateGapMs: [
    { max: 120, scenarios: ['steady', 'bursty', 'long', 'fast', 'turbo'] },
    { max: 150, scenarios: ['slow'] },
  ],
  // Performance must not regress (baseline: total 106–268ms, longest 54–98ms per scenario).
  longTaskTotalMs: [{ max: 400, scenarios: ['slow', 'steady', 'bursty', 'long', 'typing', 'fast', 'turbo'] }],
  maxLongTaskMs: [{ max: 150, scenarios: ['slow', 'steady', 'bursty', 'long', 'typing', 'fast', 'turbo'] }],
  // Typing latency while streaming (baseline p90 64ms; Event Timing has 8ms granularity).
  p90InputMs: [{ max: 72, scenarios: ['typing'] }],
};

function checkBudgets(name, summary) {
  const failures = [];
  for (const [metric, budgets] of Object.entries(BUDGETS)) for (const budget of budgets) {
    if (!budget.scenarios.includes(name)) continue;
    const value = summary[metric];
    if (budget.min != null && value < budget.min) failures.push(`${name}.${metric}=${value} < ${budget.min}`);
    if (budget.max != null && value > budget.max) failures.push(`${name}.${metric}=${value} > ${budget.max}`);
  }
  return failures;
}

function median(rows, key) {
  const values = rows.map(row => row[key]).filter(value => typeof value === 'number').sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return round(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
}

function aggregate(results) {
  const byScenario = {};
  for (const row of results) (byScenario[row.scenario] ??= []).push(row.summary);
  return Object.fromEntries(Object.entries(byScenario).map(([name, rows]) =>
    [name, Object.fromEntries(Object.keys(rows[0]).map(key => [key, median(rows, key)]))]));
}

async function compare(beforeFile, afterFile) {
  const before = JSON.parse(await readFile(beforeFile, 'utf8')).aggregate;
  const after = JSON.parse(await readFile(afterFile, 'utf8')).aggregate;
  for (const name of Object.keys(after)) {
    console.log(`\n## ${name}`);
    console.log('| metric | before | after |');
    console.log('| --- | --- | --- |');
    for (const key of Object.keys(after[name])) console.log(`| ${key} | ${before[name]?.[key] ?? '-'} | ${after[name][key]} |`);
  }
}

let profileDir = null;

async function exercise(page, cdp, baseUrl, workdir, state, name, runIndex) {
  const scenario = SCENARIOS[name];
  const sessionId = await page.evaluate(async ({ workdir, model, providerId, title }) => {
    const created = await window.electronAPI.localDb.sessions.create({
      title, workingDir: workdir, workspaceKind: 'project',
      agentKind: 'codex', model, providerId, permissionMode: 'ask', effort: 'medium',
    });
    location.hash = '#/cc-agent/' + created.id;
    return created.id;
  }, { workdir, model, providerId, title: `Stream smoothness ${name} #${runIndex + 1}` });
  await page.locator('.tiptap[contenteditable=true]').first().waitFor({ timeout: 30_000 });
  await page.bringToFront();
  await delay(1500);
  state.active = { name, served: false };
  await page.evaluate(installProbe);
  const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const startedAt = Date.now();
  if (profileDir) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const accepted = await page.evaluate(async ({ id, prompt, workdir, model }) => {
    const result = await window.electronAPI.maker.send(id, prompt, {
      agentKind: 'codex', workingDir: workdir, model, permissionMode: 'ask',
    }, { throwOnStartFailure: true });
    return result.accepted;
  }, { id: sessionId, prompt: `SCENARIO:${name} — reply with the scripted answer.`, workdir, model });
  assert.equal(accepted, true, 'The real Codex adapter did not accept the fixture input');
  await until(`${name} stream to start`, () => state.active.firstDeltaAt, 60_000);
  let typed = 0;
  if (scenario.typing) {
    const composer = page.locator('.tiptap[contenteditable=true]').first();
    await composer.click();
    while (!state.active.endedAt) {
      await page.keyboard.type('streaming ', { delay: 55 });
      typed += 10;
    }
  }
  await until(`${name} stream to finish at the fixture`, () => state.active.endedAt, 120_000);
  // Settle: the answer stops growing for 1.5s and the turn has ended.
  let lastLength = -1; let stableSince = Date.now();
  await until(`${name} answer to settle`, async () => {
    const length = await page.evaluate(() => window.__streamSmoothness.frames.at(-1)?.[1] ?? 0);
    if (length !== lastLength) { lastLength = length; stableSince = Date.now(); }
    return Date.now() - stableSince > 1500 && length > 0;
  }, 60_000);
  const wallMs = Date.now() - startedAt;
  if (profileDir) {
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(path.join(profileDir, `${name}-${runIndex + 1}.cpuprofile`), JSON.stringify(profile));
  }
  const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const probe = await page.evaluate(() => {
    const probeState = window.__streamSmoothness;
    probeState.running = false;
    return { frames: probeState.frames, long: probeState.long, events: probeState.events };
  });
  if (typed) {
    const composer = page.locator('.tiptap[contenteditable=true]').first();
    await composer.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
  }
  const cpu = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']
    .map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)]));
  const raw = { ...probe, server: { firstDeltaAt: state.active.firstDeltaAt, endedAt: state.active.endedAt,
    totalChars: state.active.totalChars }, cpu, wallMs };
  return { scenario: name, run: runIndex, sessionId, note: scenario.note, raw, summary: summarize(raw) };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--compare') return compare(argv[1], argv[2]);
  if (argv[0] === '--check') {
    const { aggregate: saved } = JSON.parse(await readFile(argv[1], 'utf8'));
    const failures = Object.entries(saved).flatMap(([name, summary]) => checkBudgets(name, summary));
    console.log(failures.length ? `FAIL\n${failures.join('\n')}` : 'PASS streaming smoothness budgets');
    if (failures.length) process.exitCode = 1;
    return;
  }
  const label = argv[argv.indexOf('--label') + 1];
  assert.ok(argv.includes('--label') && /^[a-z0-9-]+$/i.test(label ?? ''), 'Pass --label <name>');
  const runs = argv.includes('--runs') ? Number(argv[argv.indexOf('--runs') + 1]) : 3;
  const only = argv.includes('--scenario') ? argv[argv.indexOf('--scenario') + 1].split(',') : Object.keys(SCENARIOS);
  const evidenceDir = await mkdtemp(path.join(tmpdir(), `cindy-stream-smoothness-${label}-`));
  if (argv.includes('--profile')) profileDir = evidenceDir;
  const sandbox = `stream-smooth-${path.basename(evidenceDir).slice(-6).toLowerCase()}`;
  const profile = defaultIsolatedUserDataDir(sandbox, region);
  const workdir = path.join(evidenceDir, 'project');
  const state = { count: 0, active: null };
  const server = modelFixture(state);
  let browser; let ownsSandbox = false;
  const results = [];
  try {
    await mkdir(profile, { recursive: true, mode: 0o700 });
    ownsSandbox = true;
    // Production disconnect marker: the fresh profile must not adopt CLI or
    // keychain subscriptions on this machine; only the loopback fixture answers.
    await writeFile(path.join(profile, 'native-provider-auth.json'), JSON.stringify({
      revoked: { anthropic: 'stream-smoothness-e2e', openai: 'stream-smoothness-e2e', xai: 'stream-smoothness-e2e' },
    }), { flag: 'wx', mode: 0o600 });
    await mkdir(workdir);
    const modelPort = await listen(server);
    const reserve = createServer();
    const port = await listen(reserve);
    await closeServer(reserve);
    const pid = await launchDesktop(port, sandbox, evidenceDir);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000 });
    const browserCdp = await browser.newBrowserCDPSession();
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    assert.equal(processInfo.filter(p => p.type === 'browser')[0]?.id, pid, 'CDP connected to a different Electron instance');
    const page = await until('main renderer', async () => browser.contexts().flatMap(c => c.pages())
      .find(p => /^http:\/\/localhost:\d+\/(?:#\/|$)/.test(p.url())), 60_000);
    await page.locator('.tiptap[contenteditable=true]').first().waitFor({ timeout: 60_000 });
    const provider = await page.evaluate(async ({ baseUrl, providerId, model, fakeKey }) =>
      window.electronAPI.maker.createCustomProvider({
        id: providerId, name: 'Stream Smoothness Fixture', auth: { method: 'apiKey' },
        runtimes: { codex: { baseUrl, wireProtocol: 'openai-responses', models: [{ id: model, name: model }] } },
      }, { codex: fakeKey }), { baseUrl: `http://127.0.0.1:${modelPort}/v1`, providerId, model, fakeKey });
    assert.ok(provider.ok, 'Could not configure the loopback-only fixture provider');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    // Warm-up turn: first Codex start and lazy chunks must not skew run #1.
    // Vite may re-optimize dependencies on first use and reload the page once.
    for (let attempt = 0; ; attempt++) {
      try {
        await exercise(page, cdp, null, workdir, state, 'steady', -1);
        break;
      } catch (error) {
        if (attempt > 0 || !/context was destroyed|navigation/i.test(error.message)) throw new Error(`warm-up failed: ${error.message}`);
        await page.waitForLoadState('domcontentloaded');
        await page.locator('.tiptap[contenteditable=true]').first().waitFor({ timeout: 60_000 });
      }
    }
    for (let r = 0; r < runs; r++) {
      for (const name of only) {
        const result = await exercise(page, cdp, null, workdir, state, name, r);
        results.push(result);
        console.log(`RUN ${name}#${r + 1} ${JSON.stringify(result.summary)}`);
      }
    }
    const report = { label, platform: process.platform, node: process.version, createdAt: new Date().toISOString(),
      scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.note])),
      aggregate: aggregate(results), results };
    await writeFile(path.join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.aggregate, null, 2));
    if (argv.includes('--assert')) {
      const failures = Object.entries(report.aggregate).flatMap(([name, summary]) => checkBudgets(name, summary));
      if (failures.length) throw new Error(`Streaming smoothness budget failed:\n${failures.join('\n')}`);
      console.log('PASS streaming smoothness budgets');
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      const cdp = await browser.newBrowserCDPSession().catch(() => null);
      await Promise.race([cdp?.send('Browser.close').catch(() => {}), delay(5000)]);
      await browser.close().catch(() => {});
    }
    if (server.listening) await closeServer(server);
    try {
      if (ownsSandbox) await removeSandbox(profile);
    } catch (error) {
      console.error(`Could not clean the benchmark sandbox: ${error.message}`);
      process.exitCode = 1;
    }
    console.log(`REPORT=${evidenceDir}`);
  }
}

await main();
