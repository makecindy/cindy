/**
 * Per-task timing of Codex App runs of the browser fixture tasks, read from Codex's own local
 * session logs. Opt-in, never part of unit tests. Method and limits:
 * docs/benchmarks/browser-tasks-2026-11-11.
 *
 *   node scripts/benchmarks/browser-task-codex-timing.mjs <run-id> [--sessions <dir>] [--days 2] [--out <file.json>]
 *
 * <run-id> is the id printed by `scripts/eval-browser-tasks.mjs --serve`; every prompt carries it as
 * `?run=<id>`, which is how the sessions of one round are found. Reported per task, in seconds:
 *   total      task_started -> task_complete in the session log (Codex's own clock)
 *   calls      tool calls that returned
 *   approval   time spent in automatic approval reviews: the sum of every review turn
 *              (task_started -> task_complete in a guardian_review session) that began inside the task
 *              and belongs to that task's own session (the review session's parent_thread_id), so
 *              another Codex conversation running at the same time is not counted
 *   tool       time with at least one tool call outstanding (between a call and its result; calls that
 *              overlap are counted once, as a union of intervals), minus approval
 *   model      total minus that time
 *   net        total minus approval
 * The log format is Codex's internal one and may change; this was written against Codex App 26.1103.
 * The logs hold account identifiers and the full conversation, so publish only the numbers.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  sessions: { type: 'string', default: path.join(os.homedir(), '.codex', 'sessions') },
  days: { type: 'string', default: '2' }, out: { type: 'string' },
} });
const runId = positionals[0];
if (!runId) {
  console.error('Usage: browser-task-codex-timing.mjs <run-id> [--sessions <dir>] [--days 2] [--out <file.json>]');
  process.exit(2);
}

const newest = Date.now() - Number(values.days) * 86_400_000;
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^rollout-.*\.jsonl$/.test(entry.name) && statSync(full).mtimeMs >= newest) files.push(full);
  }
})(values.sessions);

const seconds = (iso) => Date.parse(iso) / 1000;
const round = (value) => Math.round(value * 10) / 10;
const reviews = [], rounds = [];  // reviews: [parent session id, start, end]
for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const guardian = raw.includes('"turn_trigger":"guardian_review"');
  if (!guardian && !(raw.includes('"turn_trigger":"composer"') && raw.includes(`run=${runId}`))) continue;
  const events = raw.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const meta = events.find((event) => event.type === 'session_meta')?.payload ?? {};
  if (guardian) {
    // One review session can review several actions: one turn per review.
    let started = null;
    for (const event of events) {
      if (event.payload?.type === 'task_started') started = seconds(event.timestamp);
      if (event.payload?.type === 'task_complete' && started !== null) { reviews.push([meta.parent_thread_id, started, seconds(event.timestamp)]); started = null; }
    }
  } else rounds.push({ id: meta.id, events });
}

const result = {};
for (const { id: sessionId, events } of rounds) {
  const begun = events.find((event) => event.payload?.type === 'task_started');
  const done = events.filter((event) => event.payload?.type === 'task_complete').at(-1);
  const prompt = events.find((event) => event.type === 'response_item' && event.payload?.role === 'user'
    && JSON.stringify(event.payload).includes(`run=${runId}`));
  if (!begun || !done || !prompt) continue;
  const task = JSON.stringify(prompt.payload).match(new RegExp(`/([a-z]+)\\?run=${runId}`))?.[1];
  if (!task) continue;
  const start = seconds(begun.timestamp), end = seconds(done.timestamp);
  const pending = new Map(), spans = [];  // spans: [call start, result] per returned tool call
  for (const event of events) {
    if (event.type !== 'response_item') continue;
    const { type, call_id: id } = event.payload ?? {};
    if (type === 'function_call' && id) pending.set(id, seconds(event.timestamp));
    if (type === 'function_call_output' && pending.has(id)) spans.push([pending.get(id), seconds(event.timestamp)]);
  }
  const mine = reviews.filter(([parent, from]) => parent === sessionId && from >= start && from <= end);
  const approval = mine.reduce((sum, [, from, to]) => sum + to - from, 0);
  // Parallel tool calls overlap: count the wall-clock union, not the sum of each call's duration.
  let gap = 0, reach = -Infinity;
  for (const [from, to] of spans.toSorted((a, b) => a[0] - b[0])) {
    if (to > reach) { gap += to - Math.max(from, reach); reach = to; }
  }
  result[task] = { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), total: round(end - start), calls: spans.length,
    approvals: mine.length, approval: round(approval), tool: round(gap - approval), model: round(end - start - gap),
    net: round(end - start - approval), answer: String(done.payload.last_agent_message ?? '').replace(/\s+/g, ' ').slice(0, 120) };
}

const tasks = Object.keys(result);
if (!tasks.length) { console.error(`No finished Codex session mentions run=${runId} under ${values.sessions}`); process.exit(1); }
console.table(Object.fromEntries(tasks.map((task) => [task, result[task]])), ['total', 'calls', 'approvals', 'approval', 'tool', 'model', 'net', 'answer']);
const mean = (key) => round(tasks.reduce((sum, task) => sum + result[task][key], 0) / tasks.length);
console.log(`mean of ${tasks.length}: total ${mean('total')}  approval ${mean('approval')}  net ${mean('net')}  tool ${mean('tool')}  model ${mean('model')}  calls ${mean('calls')}`);
if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
