import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

export const BOT_PROJECT_MEMORY_REVIEW_ID = 'teammate-memory-review';
export const LEGACY_MEMORY_REVIEW_HOOK_COMMAND = 'xdt-node "../.memory-review-check-v1.cjs"';
export const MEMORY_REVIEW_HOOK_COMMAND = 'cindy-node-script "../.memory-review-check-v1.cjs"';

/** The bundled check lives beside the workspace, not in its Git history: its database path is
 * local account data. Memory itself remains ordinary portable project files. No model or new
 * scheduler setting is needed to decide whether there is anything to review: 20 human messages
 * since the last review, or memory / skill files changed since then and a week passed
 * (2026-11-22: teammates of owners who chat less were never reviewed). Its record of the last
 * review sits beside it, outside Git. `bundledCheck` is false when the owner edited the check;
 * it is not part of the hook config. */
export async function ensureMemoryReviewHook(input: {
  workingDir: string;
  botId: string;
  databasePath: string;
  previousCommand?: string;
}): Promise<{ command: string; timeoutMs: number; bundledCheck: boolean }> {
  const filename = '.memory-review-check-v1.cjs';
  const check = String.raw`
(async () => {
const { DatabaseSync } = require('node:sqlite');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input);
if (event.event !== 'schedule-pre-run' || !Number.isFinite(event.firedAt)) {
  throw new Error('Missing schedule pre-run event');
}
const fs = require('node:fs');
const path = require('node:path');
// The record of the last review sits beside this check, outside the project's Git history.
const statePath = path.join(source.workspace, '..', '.memory-review-state-v1.json');
let stored = '';
let state = {};
try {
  stored = fs.readFileSync(statePath, 'utf8');
  state = JSON.parse(stored) || {};
} catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
}
let reviewedAt = Number.isFinite(state.reviewedAt) ? state.reviewedAt : 0;
let since = Number.isFinite(state.since) ? state.since : 0;
let pending = typeof state.pending?.runId === 'string' && Number.isFinite(state.pending.firedAt) ? state.pending : null;
let previousRunning = false;
const minimumHumanMessages = 20;
let humanMessages = 0;
let messagesSince = event.firedAt - 24 * 60 * 60 * 1000;
const db = new DatabaseSync(source.databasePath, { readOnly: true });
try {
  function messageText(content) {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === 'string' ? parsed
        : typeof parsed?.text === 'string' ? parsed.text : '';
    } catch { return content; }
  }
  function humanInput(row) {
    let meta;
    try { meta = JSON.parse(row.agent_meta || '{}'); } catch { return false; }
    if (meta?.sourcePlugin || meta?.autoResume === true) return false;
    const origin = meta?.origin;
    // Host-attested owner group messages retain the hidden dispatch prefix. Count the
    // actual owner text before rejecting synthetic envelopes (including attachments).
    if (typeof meta?.autoReviewUserText === 'string' && meta.autoReviewUserText.trim()) return true;
    if (origin?.groupThread || origin?.groupRequest) return true;
    if (messageText(row.content).startsWith(source.syntheticPrefix)) return false;
    return !origin?.kind || (origin.kind === 'scheduler'
      && typeof origin.scheduleId === 'string' && origin.scheduleId.startsWith('hook:'));
  }
  // A review counts once its run succeeded. A failed, cancelled or never-started run leaves
  // the material for the next one.
  if (pending) {
    const previous = db.prepare('SELECT status, finished_at, session_id FROM schedule_runs WHERE id = ?').get(pending.runId);
    if (previous?.status === 'success') {
      const finishedAt = Number.isFinite(previous.finished_at) ? previous.finished_at : pending.firedAt;
      // Edits made while it ran are its own only if no other task of this teammate was active
      // then (the review shares the project folder). Otherwise they wait for the next review.
      const workspacePrefix = source.workspace + path.sep;
      const concurrent = db.prepare(
        "SELECT 1 FROM messages m WHERE m.created_at > ? AND m.created_at <= ? AND m.session_id IS NOT ? AND (" +
        "m.session_id IN (SELECT session_id FROM bot_session_links WHERE bot_id = ?) OR m.session_id IN (" +
        "SELECT id FROM sessions WHERE working_dir = ? OR project_dir = ? OR substr(working_dir, 1, length(?)) = ?)) LIMIT 1"
      ).get(pending.firedAt, finishedAt, previous.session_id ?? null, source.botId,
        source.workspace, source.workspace, workspacePrefix, workspacePrefix);
      reviewedAt = pending.firedAt;
      since = Math.max(since, concurrent ? pending.firedAt : finishedAt);
      pending = null;
    } else if (previous?.status === 'running') {
      previousRunning = true;
    } else {
      pending = null;
    }
  }
  // Count human messages since the last confirmed review, else since this automation was set up
  // on this computer: skipped and failed nights do not reset the count. A review or setup dated
  // after this fire (clock moved back), or no local record of this automation (a test run),
  // falls back to the last day.
  if (reviewedAt > 0 && reviewedAt < event.firedAt) messagesSince = reviewedAt;
  else {
    const schedule = typeof event.scheduleId === 'string'
      ? db.prepare('SELECT created_at FROM schedules WHERE id = ?').get(event.scheduleId) : undefined;
    if (Number.isFinite(schedule?.created_at) && schedule.created_at < event.firedAt) messagesSince = schedule.created_at;
  }
  // Stop once the bundled minimum is met; synthetic messages never contribute.
  const rows = db.prepare(
    "SELECT m.content, m.agent_meta FROM bot_session_links l JOIN messages m ON m.session_id = l.session_id " +
    "WHERE l.bot_id = ? AND m.role = 'user' AND m.rewind_at IS NULL " +
    "AND m.created_at > ? AND m.created_at <= ?"
  ).iterate(source.botId, messagesSince, event.firedAt);
  for (const row of rows) {
    if (humanInput(row) && ++humanMessages >= minimumHumanMessages) break;
  }
} finally {
  db.close();
}
// A teammate the owner talks to less still saves memories and skills. Those files changing is
// reason enough for a review, at most once a week; a teammate with no new material never runs.
const baseline = Math.max(since, reviewedAt);
const changed = [];
// Bounded walk, memory first, each folder level before the next: a Skill with a large resource
// folder cannot hide a later Skill's SKILL.md from the check.
const budget = 2000;
let visited = 0;
let truncated = false;
// Memory records are Markdown. The supplied guide, the generated index (MEMORY.md is rewritten
// whenever memory storage starts, even unchanged), the search index and receipts are not.
const derived = ['.cindy/memory/README.md', '.cindy/memory/MEMORY.md'];
const skipped = ['node_modules', '__pycache__', 'venv'];
function collect(root, rootName, memory) {
  const queue = [[root, rootName]];
  for (let index = 0; index < queue.length; index++) {
    if (visited >= budget) { truncated = true; return; }
    const [dir, relative] = queue[index];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const entry of entries) {
      if (++visited > budget) { truncated = true; return; }
      // Dependencies and runtime caches are not material (the same folders teammate Skills skip).
      if (entry.name.startsWith('.') || skipped.includes(entry.name) || entry.name.endsWith('.pyc')) continue;
      const full = path.join(dir, entry.name);
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) queue.push([full, name]);
      else if (entry.isFile() && (!memory || (entry.name.endsWith('.md') && !derived.includes(name)))
        && fs.statSync(full).mtimeMs > baseline) changed.push(name);
    }
  }
}
collect(path.join(source.workspace, '.cindy', 'memory'), '.cindy/memory', true);
collect(path.join(source.workspace, '.agents', 'skills'), '.agents/skills', false);
const week = 7 * 24 * 60 * 60 * 1000;
const run = !previousRunning && (humanMessages >= minimumHumanMessages
  || (changed.length > 0 && (!reviewedAt || event.firedAt - reviewedAt >= week)));
if (run) {
  if (typeof event.runId === 'string' && event.runId) pending = { runId: event.runId, firedAt: event.firedAt };
  else reviewedAt = event.firedAt;
}
const next = JSON.stringify({ reviewedAt, since, ...(pending ? { pending } : {}) });
// Self-tests only report the decision; they never move the review's record.
if (event.scheduleId !== 'self-test' && next !== stored) {
  const temp = statePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, next);
  fs.renameSync(temp, statePath);
}
const unchecked = truncated ? '\n(Stopped after ' + budget + ' entries; the rest of the folders were not checked.)' : '';
const conversations = 'Review conversations since ' + new Date(messagesSince).toISOString() + '.';
if (run && changed.length > 0) {
  console.log(conversations + '\nMemory and skill files changed since the last review (check these and the records they relate to):\n'
    + changed.slice(0, 40).join('\n') + (changed.length > 40 ? '\n…and ' + (changed.length - 40) + ' more' : '') + unchecked);
} else if (run) {
  console.log(conversations);
} else {
  console.log(previousRunning
    ? 'The previous memory and skills review is still running; skipped.'
    : changed.length > 0
      ? changed.length + ' memory or skill files changed; the next review waits until a week after the last one.' + unchecked
      : 'Only ' + humanMessages + '/' + minimumHumanMessages + ' human messages since ' + new Date(messagesSince).toISOString() + ' and no memory or skill changes; memory and skills review skipped.' + unchecked);
  process.exitCode = 2;
}
process.stdout.write('', () => process.exit(process.exitCode || 0));
})().catch(error => { console.error(error); process.stderr.write('', () => process.exit(1)); });
`;
  const source = `const source = ${JSON.stringify({ databasePath: input.databasePath, botId: input.botId, workspace: input.workingDir, syntheticPrefix: UI_ACTION_TRIGGER_PREFIX })};\n` + check;
  // Preserve an owner's edits to the supplied check. A missing database or broken check fails
  // closed through the existing preRunHook protocol; it never silently starts the model.
  const file = path.join(input.workingDir, '..', filename);
  try {
    await fs.writeFile(file, source, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await fs.lstat(file)).isFile()) throw new Error('Memory review check must be a regular file');
    const old = await fs.readFile(file, 'utf8');
    // On another computer the supplied script needs that computer's database location. Only
    // refresh our untouched script; never replace a check the owner has edited.
    // Git/editor line-ending conversion does not make a bundled check owner-customized.
    const oldCheck = old.slice(old.indexOf('\n') + 1).replace(/\r\n/g, '\n');
    // Exact prior bundled bodies; owner-edited checks stay untouched.
    const previousBundled = createHash('sha256').update(oldCheck).digest('hex')
      === '32dd10c0fb4c51e5fde92f0e57b80d6a4391c35d7fc134f847ac6496c76ef47c'
      || createHash('sha256').update(oldCheck).digest('hex')
        === '4765ed7d8092d3c2a594e965966db40a88336ddb0b858309b4b19febba64097f'
      || createHash('sha256').update(oldCheck).digest('hex')
        === '8d85213bf0d533c2cf1bf9376a21f5994aa2fe73a1257f9e49096fa1fb8418cb'
      || createHash('sha256').update(oldCheck).digest('hex')
        === '8e97ec8f8733954427efb43d81b9cd58d5940baa2d4f238737727a3903e6dd65'
      || createHash('sha256').update(oldCheck).digest('hex')
        === 'dff1c6e5c4b697265735fb990b878cf6ef97b6810e9e4612ccf35a7da579f9d3'
      // Messages counted over the last day only (before the count since the last review).
      || createHash('sha256').update(oldCheck).digest('hex')
        === 'ed9421bcbc8a12756db140f78f6aa0e15f4eb7941b4d35fbe9e7e6eb6ffa4ece';
    if (oldCheck !== check && !previousBundled && input.previousCommand) {
      return { command: input.previousCommand, timeoutMs: 10_000, bundledCheck: false };
    }
    if (!old.startsWith('const source = {') || (oldCheck !== check && !previousBundled)) {
      return { command: MEMORY_REVIEW_HOOK_COMMAND, timeoutMs: 10_000, bundledCheck: false };
    }
    if (old !== source) {
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, source, { flag: 'wx' });
      await fs.rename(temp, file);
    }
  }
  return { command: MEMORY_REVIEW_HOOK_COMMAND, timeoutMs: 10_000, bundledCheck: true };
}
