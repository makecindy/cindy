/*
 * Cindy-owned durable PI Subagent runner.
 *
 * The generated CommonJS file runs outside the parent PI process. It owns every
 * child process handle, writes bounded durable status/transcript artifacts, and
 * accepts stop/steer control requests through an atomic file protocol. The host
 * never signals a PID read from disk: only this runner terminates processes it
 * actually spawned, which avoids stale-PID reuse and path-traversal process kills.
 */

export const CINDY_SUBAGENT_RUNNER_FILENAME = 'cindy-subagent-runner.cjs';

export const CINDY_SUBAGENT_RUNNER_SOURCE = String.raw`'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATUS_VERSION = 1;
const CONTROL_VERSION = 1;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const CONTROL_POLL_MS = 200;
const STATUS_FLUSH_MS = 50;
const HEARTBEAT_MS = 2000;
const CHILD_EXIT_GRACE_MS = 2000;
const MAX_PROCESSED_CONTROL_IDS = 256;
const MAX_CONTROL_RECEIPTS = 512;
const CONTROL_RECEIPT_TTL_MS = 5 * 60 * 1000;
const SESSION_TOKEN_ENV = 'CINDY_PI_SESSION_TOKEN';

function fail(message) {
  try { process.stderr.write('[cindy-subagent-runner] ' + message + '\n'); } catch (_) {}
  process.exitCode = 1;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid + '-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function deriveRouteProxySessionToken(task) {
  if (task.proxySessionAuth !== true) return '';
  const parentToken = process.env[SESSION_TOKEN_ENV];
  const sourceProviderId = task.sourceProviderId;
  if (
    typeof parentToken !== 'string'
    || !/^[A-Za-z0-9_-]{32,256}$/.test(parentToken)
    || typeof sourceProviderId !== 'string'
    || !/^[A-Za-z0-9._-]{1,128}$/.test(sourceProviderId)
  ) {
    throw new Error('provider-scoped proxy authentication is unavailable');
  }
  return createHmac('sha256', parentToken)
    .update('cindy.pi.subagent-route\0' + sourceProviderId)
    .digest('base64url');
}

function textOf(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  const out = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out.push(block.text);
  }
  return out.join('');
}

function usageOf(message) {
  const usage = message && message.usage && typeof message.usage === 'object' ? message.usage : {};
  const number = function (value) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0; };
  return {
    input: number(usage.input) || number(usage.inputTokens),
    output: number(usage.output) || number(usage.outputTokens),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    cost: number(usage.cost && usage.cost.total),
  };
}

function addUsage(target, next) {
  target.input += next.input;
  target.output += next.output;
  target.cacheRead += next.cacheRead;
  target.cacheWrite += next.cacheWrite;
  target.cost += next.cost;
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return { value: value.slice(0, end), truncated: true };
}

function terminateOwnedTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      if (typeof child.pid === 'number') {
        const args = ['/PID', String(child.pid), '/T'];
        if (signal === 'SIGKILL') args.push('/F');
        spawnSync('taskkill', args, {
          windowsHide: true,
          stdio: 'ignore',
        });
      }
      return;
    }
    if (typeof child.pid === 'number') process.kill(-child.pid, signal);
  } catch (_) {
    try { child.kill(signal); } catch (_) {}
  }
}

function safeAppendTranscript(state, record) {
  if (state.transcriptTruncated) return;
  const line = JSON.stringify(record) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  if (state.transcriptBytes + bytes > MAX_TRANSCRIPT_BYTES) {
    const marker = JSON.stringify({ type: 'cindy.subagent.transcript_truncated', at: Date.now() }) + '\n';
    try { fs.appendFileSync(state.transcriptPath, marker, { encoding: 'utf8', mode: 0o600 }); } catch (_) {}
    state.transcriptTruncated = true;
    return;
  }
  try {
    fs.appendFileSync(state.transcriptPath, line, { encoding: 'utf8', mode: 0o600 });
    state.transcriptBytes += bytes;
  } catch (_) {}
}

function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('config path required');
  const config = readJson(configPath);
  if (!config || config.version !== 1 || typeof config.runId !== 'string' || !Array.isArray(config.tasks)) {
    throw new Error('invalid runner config');
  }
  if (typeof config.runDir !== 'string' || path.resolve(config.runDir) !== path.dirname(path.resolve(configPath))) {
    throw new Error('runner config escaped its run directory');
  }
  if (
    typeof config.binary !== 'string'
    || typeof config.bridgeExtension !== 'string'
    || typeof config.childConfigHome !== 'string'
  ) {
    throw new Error('runner launch paths unavailable');
  }
  const containedPrefix = path.resolve(config.runDir) + path.sep;
  if (!path.resolve(config.childConfigHome).startsWith(containedPrefix)) {
    throw new Error('child config home escaped the run directory');
  }

  fs.mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(config.runDir, 0o700); } catch (_) {}
  const statusPath = path.join(config.runDir, 'status.json');
  const transcriptPath = path.join(config.runDir, 'transcript.jsonl');
  const resultPath = path.join(config.runDir, 'result.json');
  const controlPath = path.join(config.runDir, 'control.json');
  const controlDir = path.join(config.runDir, 'controls');
  const controlReceiptDir = path.join(config.runDir, 'control-receipts');
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(controlReceiptDir, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const runnerInstanceId = randomUUID();
  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
    ? Math.floor(config.timeoutMs)
    : 30 * 60 * 1000;
  const concurrency = Math.max(1, Math.min(8, Number.isFinite(config.concurrency) ? Math.floor(config.concurrency) : 4));
  const resultBudgetBytes = Math.max(4096, Math.floor(MAX_RESULT_BYTES / Math.max(1, config.tasks.length)));
  const tasks = config.tasks.map(function (task, index) {
    return {
      index: index,
      childId: String(task.childId),
      stepId: typeof task.stepId === 'string' ? task.stepId : 'step-' + String(index + 1),
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
      agent: String(task.agent),
      title: typeof task.title === 'string' ? task.title : String(task.agent),
      task: String(task.task),
      originalTask: String(task.task),
      tools: String(task.tools),
      profilePrompt: String(task.profilePrompt),
      provider: String(task.provider),
      model: typeof task.model === 'string' ? task.model : undefined,
      displayModel: typeof task.displayModel === 'string' ? task.displayModel : undefined,
      sourceProviderId: typeof task.sourceProviderId === 'string' ? task.sourceProviderId : undefined,
      proxySessionAuth: task.proxySessionAuth === true,
      thinking: typeof task.thinking === 'string' ? task.thinking : undefined,
      sessionId: String(task.sessionId),
      sessionDir: String(task.sessionDir),
      cwd: typeof task.cwd === 'string' ? task.cwd : config.cwd,
      status: 'queued',
      scheduled: false,
      toolUses: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      output: '',
      outputTruncated: false,
      error: undefined,
      pendingApproval: undefined,
      pendingControls: [],
      stopRequested: false,
      startedAt: undefined,
      endedAt: undefined,
      child: undefined,
      stdin: undefined,
      inputClosed: false,
      hardKillTimer: undefined,
    };
  });

  const state = {
    transcriptPath: transcriptPath,
    transcriptBytes: 0,
    transcriptTruncated: false,
    state: 'queued',
    stopRequested: false,
    timedOut: false,
    lastControlSeq: 0,
    lastLegacyControlRequestId: '',
    processedControlIds: new Map(),
    receiptWritesSincePrune: 0,
    statusTimer: undefined,
    heartbeatTimer: undefined,
    controlTimer: undefined,
    timeoutTimer: undefined,
    parentWatchdogTimer: undefined,
    terminal: false,
  };

  function statusPayload() {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let toolUses = 0;
    for (const task of tasks) {
      addUsage(usage, task.usage);
      toolUses += task.toolUses;
    }
    return {
      version: STATUS_VERSION,
      runId: config.runId,
      taskId: config.taskId,
      parentSessionId: config.parentSessionId,
      runtimeOwnerId: config.runtimeOwnerId,
      interactiveOwner: config.interactiveOwner,
      runnerInstanceId: runnerInstanceId,
      runnerPid: process.pid,
      state: state.state,
      title: config.title,
      description: config.description,
      mode: config.mode,
      context: config.context,
      startedAt: startedAt,
      updatedAt: Date.now(),
      endedAt: state.terminal ? Date.now() : undefined,
      stopRequested: state.stopRequested || undefined,
      timedOut: state.timedOut || undefined,
      toolUses: toolUses,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      usage: usage,
      transcriptPath: transcriptPath,
      resultPath: state.terminal ? resultPath : undefined,
      tasks: tasks.map(function (task) {
        return {
          childId: task.childId,
          stepId: task.stepId,
          sessionId: task.sessionId,
          agent: task.agent,
          title: task.title,
          task: task.originalTask || task.task,
          status: task.status,
          model: task.displayModel || task.model,
          thinking: task.thinking,
          toolUses: task.toolUses,
          usage: task.usage,
          // message_end is already a complete generation result even if Pi
          // keeps the RPC process alive for follow-up. Publish it immediately
          // so the host can hide late Steer before writing a doomed control.
          output: task.output || (
            task.status === 'running' || task.status === 'queued' ? undefined : ''
          ),
          outputTruncated: task.outputTruncated || undefined,
          error: task.error,
          pendingApproval: task.pendingApproval,
          startedAt: task.startedAt,
          endedAt: task.endedAt,
        };
      }),
    };
  }

  function flushStatusNow() {
    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = undefined;
    }
    atomicWriteJson(statusPath, statusPayload());
  }

  function scheduleStatus() {
    if (state.statusTimer || state.terminal) return;
    state.statusTimer = setTimeout(flushStatusNow, STATUS_FLUSH_MS);
    if (state.statusTimer && typeof state.statusTimer.unref === 'function') state.statusTimer.unref();
  }

  function send(childTask, command) {
    if (!childTask.stdin || childTask.inputClosed || childTask.status !== 'running') return false;
    try {
      childTask.stdin.write(JSON.stringify(command) + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  function requestStop(childTask) {
    if (!childTask.child || childTask.status !== 'running') return;
    send(childTask, { id: 'stop-' + randomUUID(), type: 'abort' });
    if (childTask.hardKillTimer) return;
    childTask.hardKillTimer = setTimeout(function () {
      terminateOwnedTree(childTask.child, 'SIGTERM');
      childTask.hardKillTimer = setTimeout(function () {
        terminateOwnedTree(childTask.child, 'SIGKILL');
      }, CHILD_EXIT_GRACE_MS);
      if (childTask.hardKillTimer && typeof childTask.hardKillTimer.unref === 'function') childTask.hardKillTimer.unref();
    }, 500);
    if (childTask.hardKillTimer && typeof childTask.hardKillTimer.unref === 'function') childTask.hardKillTimer.unref();
  }

  function applyControl(control) {
    if (!control || control.version !== CONTROL_VERSION) return { accepted: false, reason: 'invalid-control' };
    const requestId = typeof control.requestId === 'string' ? control.requestId : '';
    if (requestId) {
      if (state.processedControlIds.has(requestId)) return state.processedControlIds.get(requestId);
    } else {
      if (!Number.isFinite(control.seq) || control.seq <= state.lastControlSeq) {
        return { accepted: false, reason: 'stale-control' };
      }
      state.lastControlSeq = control.seq;
    }
    const complete = function (outcome) {
      if (requestId) {
        state.processedControlIds.set(requestId, outcome);
        while (state.processedControlIds.size > MAX_PROCESSED_CONTROL_IDS) {
          const oldest = state.processedControlIds.keys().next().value;
          if (typeof oldest !== 'string') break;
          state.processedControlIds.delete(oldest);
        }
      }
      return outcome;
    };
    safeAppendTranscript(state, { type: 'cindy.subagent.control', at: Date.now(), control: control });
    const target = typeof control.childId === 'string' ? control.childId : undefined;
    const selected = target ? tasks.filter(function (task) { return task.childId === target; }) : tasks;
    if (control.action === 'stop') {
      const accepted = selected.some(function (task) {
        return task.status === 'queued' || task.status === 'running';
      });
      if (!accepted) return complete({ accepted: false, reason: 'target-terminal' });
      if (target) {
        for (const task of selected) task.stopRequested = true;
      } else {
        state.stopRequested = true;
      }
      for (const task of selected) requestStop(task);
      scheduleStatus();
      return complete({ accepted: true });
    }
    if (
      control.action === 'approval'
      && typeof control.approvalId === 'string'
      && (typeof control.confirmed === 'boolean' || typeof control.value === 'string')
    ) {
      let accepted = false;
      for (const task of selected) {
        if (state.stopRequested || task.stopRequested) continue;
        if (!task.pendingApproval || task.pendingApproval.id !== control.approvalId) continue;
        const delivered = send(task, {
          type: 'extension_ui_response',
          id: control.approvalId,
          ...(typeof control.value === 'string'
            ? { value: control.value }
            : { confirmed: control.confirmed }),
        });
        if (delivered) {
          accepted = true;
          task.pendingApproval = undefined;
        }
      }
      scheduleStatus();
      return complete({ accepted: accepted, reason: accepted ? undefined : 'approval-unavailable' });
    }
    if ((control.action === 'steer' || control.action === 'follow_up') && typeof control.message === 'string' && control.message.trim()) {
      let accepted = false;
      for (const task of selected) {
        if (state.stopRequested || task.stopRequested) continue;
        // A message_end is the immutable result of that completed generation.
        // Sending steer after it exists makes Pi emit a short acknowledgement
        // that can replace the real result. Continue via follow_up instead.
        if (control.action === 'steer' && typeof task.output === 'string' && task.output.trim()) {
          continue;
        }
        const command = {
          id: control.action + '-' + randomUUID(),
          type: control.action === 'steer' ? 'steer' : 'follow_up',
          message: control.message,
        };
        if (send(task, command)) accepted = true;
        else if (task.status === 'queued') {
          task.pendingControls.push(command);
          accepted = true;
        }
      }
      scheduleStatus();
      return complete({ accepted: accepted, reason: accepted ? undefined : 'target-terminal' });
    }
    return complete({ accepted: false, reason: 'unsupported-control' });
  }

  function pruneControlReceipts(force) {
    state.receiptWritesSincePrune += force ? 0 : 1;
    if (!force && state.receiptWritesSincePrune < 64) return;
    state.receiptWritesSincePrune = 0;
    let receipts = [];
    try {
      receipts = fs.readdirSync(controlReceiptDir).filter(function (file) {
        return /^[0-9a-f-]{36}\.json$/i.test(file);
      }).flatMap(function (file) {
        const filePath = path.join(controlReceiptDir, file);
        try { return [{ filePath: filePath, modifiedAt: fs.statSync(filePath).mtimeMs }]; }
        catch (_) { return []; }
      }).sort(function (left, right) { return right.modifiedAt - left.modifiedAt; });
    } catch (_) { return; }
    const cutoff = Date.now() - CONTROL_RECEIPT_TTL_MS;
    for (let index = 0; index < receipts.length; index += 1) {
      if (index < MAX_CONTROL_RECEIPTS && receipts[index].modifiedAt >= cutoff) continue;
      try { fs.unlinkSync(receipts[index].filePath); } catch (_) {}
    }
  }

  function pollControl() {
    try {
      const legacyControl = readJson(controlPath);
      const legacyRequestId = legacyControl && typeof legacyControl.requestId === 'string'
        ? legacyControl.requestId
        : '';
      if (!legacyRequestId || legacyRequestId !== state.lastLegacyControlRequestId) {
        applyControl(legacyControl);
        state.lastLegacyControlRequestId = legacyRequestId;
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        safeAppendTranscript(state, { type: 'cindy.subagent.control_error', at: Date.now(), message: String(error) });
      }
    }
    let files = [];
    try {
      files = fs.readdirSync(controlDir).filter(function (file) {
        return /^[0-9a-f-]{36}\.json$/i.test(file);
      }).flatMap(function (file) {
        const filePath = path.join(controlDir, file);
        try {
          const control = readJson(filePath);
          let modifiedAt = 0;
          try { modifiedAt = fs.statSync(filePath).mtimeMs; } catch (_) {}
          return [{ file: file, filePath: filePath, control: control, modifiedAt: modifiedAt }];
        } catch (error) {
          safeAppendTranscript(state, {
            type: 'cindy.subagent.control_error',
            at: Date.now(),
            message: 'Discarded unreadable control ' + file + ': ' + String(error),
          });
          try { fs.unlinkSync(filePath); } catch (_) {}
          return [];
        }
      }).sort(function (left, right) {
        const leftRequestedAt = Number.isFinite(left.control && left.control.requestedAt) ? left.control.requestedAt : 0;
        const rightRequestedAt = Number.isFinite(right.control && right.control.requestedAt) ? right.control.requestedAt : 0;
        if (leftRequestedAt !== rightRequestedAt) return leftRequestedAt - rightRequestedAt;
        const leftSeq = Number.isFinite(left.control && left.control.seq) ? left.control.seq : 0;
        const rightSeq = Number.isFinite(right.control && right.control.seq) ? right.control.seq : 0;
        if (leftSeq !== rightSeq) return leftSeq - rightSeq;
        if (left.modifiedAt !== right.modifiedAt) return left.modifiedAt - right.modifiedAt;
        return String(left.control && left.control.requestId || left.file)
          .localeCompare(String(right.control && right.control.requestId || right.file));
      });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        safeAppendTranscript(state, { type: 'cindy.subagent.control_error', at: Date.now(), message: String(error) });
      }
      return;
    }
    for (const entry of files) {
      try {
        const outcome = applyControl(entry.control);
        if (entry.control && entry.control.acknowledge === true && typeof entry.control.requestId === 'string') {
          atomicWriteJson(path.join(controlReceiptDir, entry.control.requestId + '.json'), {
            version: 1,
            requestId: entry.control.requestId,
            accepted: outcome && outcome.accepted === true,
            reason: outcome && outcome.reason,
            handledAt: Date.now(),
          });
          state.receiptWritesSincePrune += 1;
        }
        fs.unlinkSync(entry.filePath);
      } catch (error) {
        safeAppendTranscript(state, { type: 'cindy.subagent.control_error', at: Date.now(), message: String(error) });
      }
    }
    if (state.receiptWritesSincePrune > 0) pruneControlReceipts(true);
  }

  function launchTask(task) {
    return new Promise(function (resolve) {
      if (state.stopRequested || task.stopRequested || state.timedOut) {
        task.status = state.timedOut ? 'failed' : 'stopped';
        task.error = state.timedOut ? 'Timed out before launch.' : 'Stopped before launch.';
        task.endedAt = Date.now();
        resolve();
        return;
      }
      fs.mkdirSync(task.sessionDir, { recursive: true, mode: 0o700 });
      const args = [
        '--mode', 'rpc',
        '--no-approve',
        '--no-extensions',
        '--extension', config.bridgeExtension,
        '--tools', task.tools,
        '--append-system-prompt', task.profilePrompt,
        '--session-dir', task.sessionDir,
        '--session-id', task.sessionId,
        '--provider', task.provider,
      ];
      if (task.model) args.push('--model', task.model);
      if (task.thinking) args.push('--thinking', task.thinking);
      const childEnv = Object.assign({}, process.env, {
        CINDY_PI_PERMISSION_FILE: config.permissionFile,
        PI_CODING_AGENT_DIR: config.childConfigHome,
      });
      let routeProxySessionToken = '';
      try {
        routeProxySessionToken = deriveRouteProxySessionToken(task);
      } catch (error) {
        task.status = 'failed';
        task.error = 'Subagent proxy authentication failed closed: ' + String(error);
        task.endedAt = Date.now();
        scheduleStatus();
        resolve();
        return;
      }
      // The root token authorizes the whole parent PI proxy session and is
      // needed only inside this trusted runner to derive a provider-scoped
      // child token. Never pass the broader token through to a child whose
      // selected route does not use the compat proxy.
      delete childEnv[SESSION_TOKEN_ENV];
      if (routeProxySessionToken) childEnv[SESSION_TOKEN_ENV] = routeProxySessionToken;
      // The runner needs the parent extension's control env; the child Pi does
      // not load that extension. Do not leak paths that would let an approved
      // shell forge durable status, replace the runner, or control siblings.
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith('CINDY_PI_SUBAGENT_')) delete childEnv[key];
      }
      // The bridge keeps this value in the Pi process only: structured writes
      // into the durable run are blocked, and bash receives an env with the key
      // removed by SECRET_ENV_NAMES.
      childEnv.CINDY_PI_SUBAGENT_RUN_DIR = config.runDir;
      delete childEnv.CINDY_PI_MCP_BRIDGE;
      for (const key of Object.keys(childEnv)) {
        if (key.startsWith('CINDY_PI_REMOTE_MCP_SECRET_')) delete childEnv[key];
      }
      const childArgs = Array.isArray(config.binaryPrefixArgs)
        ? config.binaryPrefixArgs.concat(args)
        : args;
      const child = spawn(config.binary, childArgs, {
        cwd: task.cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      task.child = child;
      task.stdin = child.stdin;
      task.inputClosed = false;
      task.status = 'running';
      task.startedAt = Date.now();
      state.state = 'running';
      scheduleStatus();
      let stdoutBuffer = '';
      let stderr = '';
      let settled = false;
      let agentSettled = false;
      let terminalError = '';

      function settle(code, signal, spawnError) {
        if (settled) return;
        settled = true;
        if (task.hardKillTimer) clearTimeout(task.hardKillTimer);
        task.hardKillTimer = undefined;
        task.child = undefined;
        task.stdin = undefined;
        task.inputClosed = true;
        task.pendingApproval = undefined;
        task.endedAt = Date.now();
        if (state.stopRequested || task.stopRequested) {
          task.status = 'stopped';
          task.error = 'Stopped by user.';
        } else if (state.timedOut) {
          task.status = 'failed';
          task.error = 'Timed out.';
        } else if (spawnError) {
          task.status = 'failed';
          task.error = String(spawnError && spawnError.message ? spawnError.message : spawnError);
        } else if (terminalError) {
          task.status = 'failed';
          task.error = terminalError;
        } else if (agentSettled && code === 0) {
          task.status = 'completed';
        } else if (code === 0) {
          task.status = 'failed';
          task.error = task.error || 'PI child exited before the agent settled.';
        } else {
          task.status = 'failed';
          task.error = stderr.trim().slice(-4000) || ('PI child exited with code ' + String(code) + (signal ? ' (' + signal + ')' : ''));
        }
        scheduleStatus();
        resolve();
      }

      function handleLine(line) {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch (_) {
          safeAppendTranscript(state, { type: 'cindy.subagent.stdout', at: Date.now(), childId: task.childId, line: line });
          return;
        }
        safeAppendTranscript(state, { type: 'cindy.subagent.child_event', at: Date.now(), childId: task.childId, event: event });
        if (event.type === 'extension_ui_request') {
          task.pendingApproval = {
            id: typeof event.id === 'string' ? event.id : 'approval-' + randomUUID(),
            method: typeof event.method === 'string' ? event.method : 'confirm',
            title: typeof event.title === 'string' ? event.title.slice(0, 500) : undefined,
            message: typeof event.message === 'string' ? event.message.slice(0, 32000) : undefined,
            placeholder: typeof event.placeholder === 'string' ? event.placeholder.slice(0, 32000) : undefined,
          };
          scheduleStatus();
          return;
        }
        if (event.type === 'tool_execution_start') {
          task.toolUses += 1;
          scheduleStatus();
          return;
        }
        if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
          const text = textOf(event.message);
          if (event.message.stopReason === 'error') {
            terminalError = typeof event.message.errorMessage === 'string' && event.message.errorMessage.trim()
              ? event.message.errorMessage.trim().slice(0, 4000)
              : 'PI child model request failed.';
          } else if (text.trim()) {
            terminalError = '';
            const bounded = truncateUtf8(text, resultBudgetBytes);
            task.output = bounded.value;
            task.outputTruncated = bounded.truncated;
          }
          addUsage(task.usage, usageOf(event.message));
          scheduleStatus();
          return;
        }
        if (event.type === 'agent_settled') {
          agentSettled = true;
          task.inputClosed = true;
          try { child.stdin.end(); } catch (_) {}
          return;
        }
        if (event.type === 'auto_retry_start') {
          terminalError = '';
          return;
        }
        if (event.type === 'agent_end') {
          // agent_end can be followed by Pi's automatic retry. Keep stdin alive;
          // only agent_settled is the terminal lifecycle event.
        }
        if (event.type === 'response' && event.command === 'prompt' && event.success === false) {
          task.error = typeof event.error === 'string' ? event.error : 'PI child rejected the prompt.';
          terminateOwnedTree(child, 'SIGTERM');
        }
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function (chunk) {
        stdoutBuffer += chunk;
        for (;;) {
          const newline = stdoutBuffer.indexOf('\n');
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          handleLine(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', function (chunk) {
        if (stderr.length < 16000) stderr += chunk;
        safeAppendTranscript(state, { type: 'cindy.subagent.stderr', at: Date.now(), childId: task.childId, text: String(chunk).slice(0, 4000) });
      });
      child.on('error', function (error) { settle(null, null, error); });
      child.on('close', function (code, signal) { settle(code, signal); });
      send(task, { id: 'prompt-' + randomUUID(), type: 'prompt', message: task.task });
      for (const command of task.pendingControls.splice(0)) send(task, command);
    });
  }

  async function runAll() {
    const byStepId = new Map(tasks.map(function (task) { return [task.stepId, task]; }));
    const takeReady = function () {
      for (const task of tasks) {
        if (task.status !== 'queued' || task.scheduled) continue;
        const dependencies = task.dependsOn.map(function (id) { return byStepId.get(id); }).filter(Boolean);
        if (dependencies.some(function (dependency) { return dependency.status === 'failed' || dependency.status === 'stopped'; })) {
          task.status = 'failed';
          task.error = 'A workflow dependency failed.';
          task.endedAt = Date.now();
          scheduleStatus();
          continue;
        }
        if (!dependencies.every(function (dependency) { return dependency.status === 'completed'; })) continue;
        task.scheduled = true;
        if (dependencies.length > 0) {
          const context = dependencies.map(function (dependency) {
            return '## ' + dependency.stepId + ' (' + dependency.agent + ')\n'
              + (dependency.output || dependency.error || '(no result)');
          }).join('\n\n');
          task.task = truncateUtf8(
            task.task + '\n\nPrevious workflow results:\n\n' + context,
            64 * 1024,
          ).value;
        }
        return task;
      }
      return tasks.some(function (task) { return task.status === 'queued'; }) ? null : undefined;
    };
    const lane = async function () {
      for (;;) {
        const task = takeReady();
        if (task === undefined) return;
        if (task === null) {
          await new Promise(function (resolve) { setTimeout(resolve, 10); });
          continue;
        }
        await launchTask(task);
      }
    };
    const lanes = [];
    for (let index = 0; index < Math.min(concurrency, tasks.length); index += 1) lanes.push(lane());
    await Promise.all(lanes);
    // Validated configs are acyclic. Any residual queue here is corrupt input,
    // not permission to silently mark the workflow complete.
    for (const task of tasks) {
      if (task.status === 'queued') {
        task.status = 'failed';
        task.error = 'Workflow dependencies could not be scheduled.';
        task.endedAt = Date.now();
      }
    }
  }

  if (config.interactiveOwner === 'extension' && Number.isFinite(config.parentPid)) {
    state.parentWatchdogTimer = setInterval(function () {
      let alive = true;
      try { process.kill(config.parentPid, 0); } catch (error) { alive = error && error.code === 'EPERM'; }
      if (!alive) {
        state.stopRequested = true;
        for (const task of tasks) requestStop(task);
        scheduleStatus();
      }
    }, 1000);
    if (state.parentWatchdogTimer && typeof state.parentWatchdogTimer.unref === 'function') state.parentWatchdogTimer.unref();
  }
  state.heartbeatTimer = setInterval(function () {
    if (!state.terminal) flushStatusNow();
  }, HEARTBEAT_MS);
  if (state.heartbeatTimer && typeof state.heartbeatTimer.unref === 'function') state.heartbeatTimer.unref();
  state.controlTimer = setInterval(pollControl, CONTROL_POLL_MS);
  if (state.controlTimer && typeof state.controlTimer.unref === 'function') state.controlTimer.unref();
  state.timeoutTimer = setTimeout(function () {
    state.timedOut = true;
    for (const task of tasks) requestStop(task);
    scheduleStatus();
  }, timeoutMs);
  if (state.timeoutTimer && typeof state.timeoutTimer.unref === 'function') state.timeoutTimer.unref();

  pruneControlReceipts(true);
  flushStatusNow();
  runAll().then(function () {
    if (state.controlTimer) clearInterval(state.controlTimer);
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.parentWatchdogTimer) clearInterval(state.parentWatchdogTimer);
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    state.terminal = true;
    state.state = state.stopRequested
      ? 'stopped'
      : tasks.some(function (task) { return task.status === 'failed'; })
        ? 'failed'
        : tasks.some(function (task) { return task.status === 'stopped'; })
          ? 'stopped'
          : 'completed';
    const result = {
      version: 1,
      runId: config.runId,
      taskId: config.taskId,
      state: state.state,
      completedAt: Date.now(),
      tasks: tasks.map(function (task) {
        return {
          childId: task.childId,
          stepId: task.stepId,
          sessionId: task.sessionId,
          agent: task.agent,
          status: task.status,
          output: task.output,
          outputTruncated: task.outputTruncated || undefined,
          error: task.error,
          usage: task.usage,
          toolUses: task.toolUses,
        };
      }),
    };
    atomicWriteJson(resultPath, result);
    flushStatusNow();
  }).catch(function (error) {
    state.terminal = true;
    state.state = 'failed';
    atomicWriteJson(resultPath, { version: 1, runId: config.runId, taskId: config.taskId, state: 'failed', error: String(error) });
    flushStatusNow();
    fail(String(error));
  });
}

try { main(); } catch (error) { fail(error && error.stack ? error.stack : String(error)); }
`;
