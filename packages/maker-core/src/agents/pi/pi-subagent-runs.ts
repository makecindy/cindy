import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type {
  SubagentControlAction,
  SubagentToolPhase,
  SubagentTranscriptEntry,
  SubagentTranscriptPageResponse,
} from '@cindy/maker-shared/subagent-workspace';

const RUN_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024 + 4096;
const MAX_TRANSCRIPT_PAGE_SIZE = 200;
const MAX_TRANSCRIPT_ENTRY_CHARS = 32 * 1024;
/** Tool arguments are display metadata, not a payload to mirror in full. */
const MAX_TOOL_INPUT_CHARS = 4 * 1024;
/** One-line tool summary budget: the key argument, not the whole record. */
const MAX_TOOL_SUMMARY_ARG_CHARS = 120;
const STALE_HEARTBEAT_MS = 15_000;
/** Exit-confirmation budget after a kill signal; each attempt spawns a probe. */
const KILL_CONFIRM_ATTEMPTS = 5;
const KILL_CONFIRM_INTERVAL_MS = 200;
/** Windows share-violation retry budget for replacing a concurrently read file. */
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_STEP_MS = 25;
const RENAME_RETRY_MAX_MS = 100;
let controlWriteSequence = 0;

export function piSubagentRunRoot(agentHome: string, sessionId: string): string {
  const id = sessionId.trim();
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    throw new Error('unsafe PI Subagent parent session id');
  }
  return path.join(agentHome, 'runtime', 'pi-subagent-runs', id);
}

export type PiSubagentRunState = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

export interface PiSubagentTaskStatus {
  childId: string;
  sessionId: string;
  agent: string;
  title?: string;
  task?: string;
  status: PiSubagentRunState;
  model?: string;
  thinking?: string;
  toolUses?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
  output?: string;
  outputTruncated?: boolean;
  error?: string;
  pendingApproval?: {
    id: string;
    method: string;
    title?: string;
    message?: string;
    placeholder?: string;
  };
  startedAt?: number;
  endedAt?: number;
}

export interface PiSubagentRunStatus {
  version: 1;
  runId: string;
  taskId: string;
  parentSessionId: string;
  /** Runtime instance allowed to mutate permissions and answer approvals. */
  runtimeOwnerId?: string;
  runnerInstanceId: string;
  runnerPid?: number;
  /**
   * Absolute path of the generated runner script, as the OS reports it in the
   * process command line. It lives inside the run's UUID directory, so it is
   * the identity proof that lets an account boundary signal `runnerPid`
   * without risking a recycled pid. Absent on records written before this
   * field existed — those are never signalled.
   */
  runnerScript?: string;
  interactiveOwner?: 'host' | 'extension';
  state: PiSubagentRunState;
  title?: string;
  description?: string;
  mode?: 'single' | 'parallel' | 'chain' | 'workflow';
  context?: 'fresh' | 'fork';
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  stopRequested?: boolean;
  timedOut?: boolean;
  toolUses?: number;
  totalTokens?: number;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
  transcriptPath?: string;
  resultPath?: string;
  tasks: PiSubagentTaskStatus[];
}

export interface PiSubagentRunDiagnostic {
  kind: 'corrupt' | 'stale';
  runId: string;
  taskId?: string;
  parentSessionId?: string;
  title?: string;
  description?: string;
  startedAt: number;
  updatedAt: number;
  message: string;
}

export type PiSubagentControlAction = 'stop' | 'steer' | 'follow_up' | 'approval';

interface TranscriptCursor {
  version: 1;
  runId: string;
  offset: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isState(value: unknown): value is PiSubagentRunState {
  return value === 'queued'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'stopped';
}

function parseStatus(value: unknown, expectedRunId: string): PiSubagentRunStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || raw.runId !== expectedRunId) return null;
  if (typeof raw.taskId !== 'string' || !raw.taskId) return null;
  if (typeof raw.parentSessionId !== 'string' || !raw.parentSessionId) return null;
  if (raw.runtimeOwnerId !== undefined && (typeof raw.runtimeOwnerId !== 'string' || !raw.runtimeOwnerId)) return null;
  if (typeof raw.runnerInstanceId !== 'string' || !raw.runnerInstanceId) return null;
  if (raw.runnerScript !== undefined && typeof raw.runnerScript !== 'string') return null;
  if (!isState(raw.state) || !finiteNonNegative(raw.startedAt) || !finiteNonNegative(raw.updatedAt)) return null;
  if (!Array.isArray(raw.tasks)) return null;
  const tasks: PiSubagentTaskStatus[] = [];
  for (const value of raw.tasks) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const task = value as Record<string, unknown>;
    if (
      typeof task.childId !== 'string'
      || !task.childId
      || typeof task.sessionId !== 'string'
      || !task.sessionId
      || typeof task.agent !== 'string'
      || !task.agent
      || !isState(task.status)
    ) return null;
    tasks.push(value as PiSubagentTaskStatus);
  }
  return { ...(value as PiSubagentRunStatus), tasks };
}

async function readSmallJson(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATUS_BYTES) {
    throw new Error('oversized, linked, or non-file subagent status');
  }
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

export function isPiSubagentTerminal(state: PiSubagentRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped';
}

/**
 * Read the live command line for `pid`, or null when it cannot be established.
 *
 * Bounded and best-effort: an unreadable command line is indistinguishable from
 * a hostile one for our purposes, and both must stop the kill.
 */
function readProcessCommandLine(pid: number): string | null {
  try {
    const probe = process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
          { encoding: 'utf8', timeout: 5_000, windowsHide: true },
        )
      : spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf8',
          timeout: 5_000,
        });
    if (probe.error || probe.status !== 0) return null;
    const text = typeof probe.stdout === 'string' ? probe.stdout.trim() : '';
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Is the process at `status.runnerPid` really this run's runner?
 *
 * The proof is the generated runner script path, which contains the run's UUID
 * directory — a recycled pid running something else cannot match it. Anything
 * we cannot establish (no recorded path, no readable command line, no match)
 * answers false, because the caller's next step is SIGKILL.
 */
export function verifyPiSubagentRunnerIdentity(status: PiSubagentRunStatus): boolean {
  const pid = status.runnerPid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return false;
  const script = status.runnerScript;
  if (typeof script !== 'string' || script.length === 0) return false;
  const commandLine = readProcessCommandLine(pid!);
  return commandLine !== null && commandLine.includes(script);
}

/**
 * Account-boundary escalation: kill a runner that never consumed its stop
 * mailbox, but only after proving the pid is still that runner.
 *
 * This is the documented exception to "never signal a pid read from disk" (see
 * the runner file header). It exists because a durable child inherits direct
 * BYOM credentials that, unlike the proxy token, cannot be revoked — so leaving
 * it running past a logout keeps the outgoing account's credentials in use.
 *
 * The runner is spawned detached, so it leads its own process group; killing
 * the group reaps the Pi children it owns too.
 *
 * Success is *exit confirmation*, never "the signal was sent": `taskkill` fails
 * by exit status rather than by throwing, and a caller that reports reclaimed
 * runners it never reclaimed lets an account switch proceed with the outgoing
 * account's BYOM credentials still in use.
 */
export async function killVerifiedPiSubagentRunner(status: PiSubagentRunStatus): Promise<boolean> {
  if (!verifyPiSubagentRunnerIdentity(status)) return false;
  const pid = status.runnerPid!;
  let signalled = false;
  try {
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      });
      signalled = !killed.error && killed.status === 0;
    } else {
      process.kill(-pid, 'SIGKILL');
      signalled = true;
    }
  } catch { /* fall through to the single-process attempt */ }
  if (!signalled) {
    // The tree kill can fail on a permission or timing race while the runner
    // itself is still reachable — and it also "fails" when the process is
    // already gone. Neither is a verdict, so try the narrower signal and let
    // the confirmation loop decide.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone, or unreachable */ }
  }
  // Confirm by re-verifying identity rather than `kill(pid, 0)`: a zombie still
  // "exists" for `kill(pid, 0)` and would be reported as unreclaimed forever,
  // while its command line no longer carries the runner script. The same
  // predicate also covers a recycled pid and, on Windows, a dead pid (the CIM
  // query returns nothing) — one cross-platform judgement for "that runner is
  // no longer running". Each attempt costs a `ps`/CIM spawn, so keep it short.
  for (let attempt = 0; ; attempt += 1) {
    if (!verifyPiSubagentRunnerIdentity(status)) return true;
    if (attempt >= KILL_CONFIRM_ATTEMPTS - 1) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_CONFIRM_INTERVAL_MS));
  }
}

/**
 * Runtime owner identity for a durable run.
 *
 * `scopeId` is the per-session-instance id that decides who may answer
 * approvals and rewrite permissions — it is freshly minted for every
 * `Maker.createSession`, so it identifies a *handle*, not an app instance.
 *
 * Agent-home-wide sweeps (quit, account boundary) need the coarser question
 * "did *this* Cindy process start the run?", because `pi-agent-home` is shared
 * by dev + packaged + every `--passive` instance. Prefixing the owner id with
 * the host pid answers that without a durable schema change: the id stays an
 * opaque, equality-compared string for the runner and the in-Pi extension, and
 * only the Host ever parses it back.
 */
export function piSubagentRuntimeOwnerId(hostPid: number, scopeId: string): string {
  return `${hostPid}:${scopeId}`;
}

/** Host pid encoded by `piSubagentRuntimeOwnerId`, or null for a legacy/absent id. */
export function piSubagentOwnerHostPid(runtimeOwnerId: string | undefined): number | null {
  if (typeof runtimeOwnerId !== 'string' || runtimeOwnerId.length === 0) return null;
  const separator = runtimeOwnerId.indexOf(':');
  if (separator <= 0) return null;
  const pid = Number(runtimeOwnerId.slice(0, separator));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Does an agent-home-wide sweep in `hostPid` own this run?
 *
 * Fail closed on anything we cannot attribute (missing status, legacy id
 * without a host prefix): an unattributable run is treated as ours and stopped.
 * Only a run whose owning process is a *different, still-live* one is skipped —
 * that is the shared-userData case where stopping would kill another running
 * instance's Subagent.
 */
/**
 * Who owns this run relative to `hostPid`, for *user-initiated control*
 * (stop / steer / follow-up).
 *
 * Deliberately the mirror image of `isSweepableByHost`. A sweep is automatic
 * and fails closed (stop anything it cannot attribute); a control is the user
 * asking for something now, so an unattributable or orphaned run must stay
 * controllable — otherwise a run left behind by a crashed instance could never
 * be stopped from the UI. The one case that must be refused is a run owned by
 * a *different, still-live* instance: writing into its mailbox would steer or
 * stop work the other window is driving.
 */
export type PiSubagentControlOwnership = 'self' | 'orphaned' | 'unattributable' | 'foreign-live';

export function piSubagentControlOwnership(
  status: PiSubagentRunStatus,
  hostPid: number,
): PiSubagentControlOwnership {
  const ownerPid = piSubagentOwnerHostPid(status.runtimeOwnerId);
  // Missing or legacy prefix-less owner id: cannot attribute, stay controllable.
  if (ownerPid === null) return 'unattributable';
  if (ownerPid === hostPid) return 'self';
  // Unknown liveness counts as live: refusing is recoverable (the user is told
  // which window owns it), silently steering someone else's run is not.
  return isProcessAlive(ownerPid) === false ? 'orphaned' : 'foreign-live';
}

/**
 * May a *newly built* handle answer an approval parked by an earlier handle of
 * the same task?
 *
 * Navigation close leaves approvals parked by generation, and a reopened task
 * gets a fresh `sessionInstanceId`, so the strict owner fence made those
 * approvals permanently unreachable — the sidebar showed "waiting" with no
 * allow/deny entry and the child waited out its whole run timeout.
 *
 * Adoption is deliberately narrow: same parent session, and either the same
 * host process (provable from the owner id's pid segment) or an owner process
 * that is gone. A legacy owner id with no pid segment cannot prove either, so
 * it is refused.
 *
 * **This changes the delivery surface only, never the verdict.** Callers must
 * put an adopted approval through explicit user confirmation — see
 * `resolvePiSubagentApproval`, where `adopted` bypasses both the Auto-review
 * dispatcher and the `bypassPermissions` auto-allow. Otherwise reopening a task
 * under a Full Access session would launder the pending approvals of a child
 * spawned under `ask`.
 */
export type PiSubagentApprovalScope = 'own' | 'adopted' | 'refused';

export function piSubagentApprovalScope(
  status: PiSubagentRunStatus,
  runtimeOwnerId: string,
  hostPid: number,
  parentSessionId: string | undefined,
): PiSubagentApprovalScope {
  if (status.runtimeOwnerId === runtimeOwnerId) return 'own';
  if (!status.runtimeOwnerId) return 'refused';
  if (!parentSessionId || status.parentSessionId !== parentSessionId) return 'refused';
  const ownership = piSubagentControlOwnership(status, hostPid);
  return ownership === 'self' || ownership === 'orphaned' ? 'adopted' : 'refused';
}

/** True when this host may write control requests for the run. */
export function canHostControlPiSubagentRun(
  status: PiSubagentRunStatus,
  hostPid: number,
): boolean {
  return piSubagentControlOwnership(status, hostPid) !== 'foreign-live';
}

function isSweepableByHost(status: PiSubagentRunStatus | undefined, hostPid: number): boolean {
  const ownerPid = piSubagentOwnerHostPid(status?.runtimeOwnerId);
  if (ownerPid === null) return true;
  if (ownerPid === hostPid) return true;
  // A dead owner process leaves an orphan runner that nobody will ever stop.
  return isProcessAlive(ownerPid) === false;
}

function isProcessAlive(pid: number | undefined): boolean | null {
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return null;
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return null;
  }
}

export function isPiSubagentRunStale(
  status: PiSubagentRunStatus,
  now = Date.now(),
): boolean {
  if (isPiSubagentTerminal(status.state)) return false;
  if (now - status.updatedAt <= STALE_HEARTBEAT_MS) return false;
  if (!Number.isSafeInteger(status.runnerPid) || status.runnerPid! <= 0) return true;
  return isProcessAlive(status.runnerPid) === false;
}

async function listRunDirectoryIds(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && RUN_DIR_RE.test(entry.name))
    .map((entry) => entry.name);
}

export async function countPiSubagentRunDirectories(root: string): Promise<number> {
  return (await listRunDirectoryIds(root)).length;
}

export async function listPiSubagentRuns(root: string): Promise<PiSubagentRunStatus[]> {
  const runIds = await listRunDirectoryIds(root);
  const now = Date.now();
  const statuses = await Promise.all(runIds
    .map(async (runId): Promise<PiSubagentRunStatus | null> => {
      try {
        return parseStatus(
          await readSmallJson(path.join(root, runId, 'status.json')),
          runId,
        );
      } catch {
        return null;
      }
    }));
  return statuses
    .filter((status): status is PiSubagentRunStatus => status !== null)
    .filter((status) => !isPiSubagentRunStale(status, now))
    .sort((left, right) => right.startedAt - left.startedAt || right.runId.localeCompare(left.runId));
}

export async function listPiSubagentRunDiagnostics(root: string): Promise<PiSubagentRunDiagnostic[]> {
  const runIds = await listRunDirectoryIds(root);
  const diagnostics: PiSubagentRunDiagnostic[] = [];
  for (const runId of runIds) {
    let parsedStatus: PiSubagentRunStatus | null = null;
    try {
      parsedStatus = parseStatus(await readSmallJson(path.join(root, runId, 'status.json')), runId);
      if (parsedStatus && !isPiSubagentRunStale(parsedStatus)) continue;
    } catch {
      // Fall through to the immutable config snapshot for safe display metadata.
    }
    if (parsedStatus) {
      diagnostics.push({
        kind: 'stale',
        runId,
        taskId: parsedStatus.taskId,
        parentSessionId: parsedStatus.parentSessionId,
        title: parsedStatus.title,
        description: parsedStatus.description,
        startedAt: parsedStatus.startedAt,
        updatedAt: parsedStatus.updatedAt,
        message: 'PI Subagent runner stopped unexpectedly. Its last durable state is shown for diagnosis, but controls are disabled.',
      });
      continue;
    }
    let config: Record<string, unknown> = {};
    try {
      const value = await readSmallJson(path.join(root, runId, 'config.json'));
      if (value && typeof value === 'object' && !Array.isArray(value)) config = value as Record<string, unknown>;
    } catch {
      // A missing config still yields a UUID-contained diagnostic record.
    }
    let updatedAt = 0;
    try { updatedAt = Math.floor((await fs.stat(path.join(root, runId))).mtimeMs); } catch { /* best effort */ }
    diagnostics.push({
      kind: 'corrupt',
      runId,
      taskId: typeof config.taskId === 'string' ? config.taskId : undefined,
      parentSessionId: typeof config.parentSessionId === 'string' ? config.parentSessionId : undefined,
      title: typeof config.title === 'string' ? config.title : undefined,
      description: typeof config.description === 'string' ? config.description : undefined,
      startedAt: finiteNonNegative(config.startedAt) ? Math.floor(config.startedAt) : updatedAt,
      updatedAt,
      message: 'PI Subagent durable status is missing, corrupt, or oversized. The run was not resumed or signaled from disk metadata.',
    });
  }
  return diagnostics;
}

function clampTranscriptContent(value: string): string {
  if (value.length <= MAX_TRANSCRIPT_ENTRY_CHARS) return value;
  return `${value.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS - 1)}…`;
}

function transcriptText(message: unknown): string {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
      const value = block as Record<string, unknown>;
      return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
    })
    .join('');
}

/**
 * Text of a tool result frame. PI sends `{ content: [{ type: 'text', … }] }`
 * (same shape the foreground translator reads), but older/other harness frames
 * may carry a bare string or a single `text` field — accept all three rather
 * than dumping the raw JSON at the user.
 */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const record = result as Record<string, unknown>;
  if (Array.isArray(record.content)) return transcriptText(record);
  if (typeof record.text === 'string') return record.text;
  if (typeof record.output === 'string') return record.output;
  return '';
}

/**
 * Argument keys worth putting in the one-line tool summary, most specific
 * first. Same intent as the renderer's ToolCallCard key-param mapping, but keyed
 * by argument name instead of tool name: PI tool names are harness-defined and
 * lowercase, so a tool-name table would silently miss every renamed tool.
 */
const TOOL_SUMMARY_ARG_KEYS = [
  'file_path',
  'filePath',
  'path',
  'command',
  'cmd',
  'pattern',
  'query',
  'url',
  'file',
  'target',
  'name',
] as const;

function toolSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolName;
  const record = args as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_ARG_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const display = text.length > MAX_TOOL_SUMMARY_ARG_CHARS
      ? `${text.slice(0, MAX_TOOL_SUMMARY_ARG_CHARS - 1)}…`
      : text;
    return `${toolName}(${display})`;
  }
  return toolName;
}

function toolInputJson(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (typeof serialized !== 'string' || serialized === '{}' || serialized === 'null') return undefined;
  return serialized.length > MAX_TOOL_INPUT_CHARS
    ? `${serialized.slice(0, MAX_TOOL_INPUT_CHARS - 1)}…`
    : serialized;
}

function controlAction(value: unknown): SubagentControlAction | undefined {
  return value === 'steer' || value === 'follow_up' || value === 'resume' || value === 'stop'
    ? value
    : undefined;
}

/**
 * Normalize one durable transcript line into the harness-neutral entry the
 * sidebar renders as a conversation. Tool frames become structured card data
 * (summary + serialized input + paired result) instead of raw event JSON, and
 * parent control lines carry their action as a field instead of a `[steer]`
 * text prefix — the renderer owns that presentation, not the record.
 */
function transcriptEntry(
  runId: string,
  offset: number,
  rawLine: string,
): SubagentTranscriptEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const occurredAt = finiteNonNegative(record.at) ? Math.floor(record.at) : 0;
  let role: SubagentTranscriptEntry['role'] = 'system';
  let content = '';
  let toolName: string | undefined;
  let childId: string | undefined;
  let toolCallId: string | undefined;
  let toolPhase: SubagentToolPhase | undefined;
  let inputJson: string | undefined;
  let isError: boolean | undefined;
  let action: SubagentControlAction | undefined;
  // A finished tool call with an empty result must still be recorded, otherwise
  // its card can never leave the "running" state in the conversation.
  let allowEmptyContent = false;
  if (record.type === 'cindy.subagent.control') {
    const control = record.control && typeof record.control === 'object' && !Array.isArray(record.control)
      ? record.control as Record<string, unknown>
      : {};
    childId = typeof control.childId === 'string' ? control.childId : undefined;
    action = controlAction(control.action);
    const message = typeof control.message === 'string' ? control.message.trim() : '';
    if (message) {
      role = 'parent';
      content = message;
    } else {
      role = 'system';
      content = action === 'stop'
        ? 'A stop was requested from the parent task.'
        : 'A control request was sent from the parent task.';
    }
  } else if (record.type === 'cindy.subagent.stderr') {
    content = typeof record.text === 'string' ? record.text : '';
  } else if (record.type === 'cindy.subagent.stdout') {
    content = typeof record.line === 'string' ? record.line : '';
  } else if (record.type === 'cindy.subagent.control_error') {
    content = typeof record.message === 'string' ? record.message : '';
  } else if (record.type === 'cindy.subagent.transcript_truncated') {
    content = 'Transcript storage limit reached.';
  } else if (record.type === 'cindy.subagent.child_event') {
    childId = typeof record.childId === 'string' ? record.childId : undefined;
    if (!record.event || typeof record.event !== 'object' || Array.isArray(record.event)) return null;
    const event = record.event as Record<string, unknown>;
    if (event.type === 'message_end') {
      const message = event.message && typeof event.message === 'object' && !Array.isArray(event.message)
        ? event.message as Record<string, unknown>
        : {};
      role = message.role === 'assistant' ? 'subagent' : message.role === 'user' ? 'parent' : 'system';
      content = transcriptText(message);
    } else if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      role = 'tool';
      toolName = typeof event.toolName === 'string' && event.toolName
        ? event.toolName
        : typeof event.name === 'string' && event.name
          ? event.name
          : undefined;
      toolCallId = typeof event.toolCallId === 'string' && event.toolCallId
        ? event.toolCallId
        : typeof event.toolUseId === 'string' && event.toolUseId
          ? event.toolUseId
          : undefined;
      if (event.type === 'tool_execution_start') {
        toolPhase = 'start';
        inputJson = toolInputJson(event.args);
        content = toolSummary(toolName ?? 'tool', event.args);
      } else {
        toolPhase = 'end';
        isError = event.isError === true;
        content = toolResultText(event.result);
        allowEmptyContent = true;
      }
    } else if (event.type === 'agent_end') {
      content = 'Subagent turn ended.';
    } else if (event.type === 'response' && event.success === false) {
      content = typeof event.error === 'string' ? event.error : 'PI rejected a child command.';
    } else {
      return null;
    }
  } else {
    return null;
  }
  if (!allowEmptyContent && !content.trim()) return null;
  return {
    id: `${runId}:${offset}`,
    sequence: offset,
    role,
    content: clampTranscriptContent(content),
    occurredAt,
    ...(toolName ? { toolName } : {}),
    ...(childId ? { childId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolPhase ? { toolPhase } : {}),
    ...(inputJson ? { toolInputJson: inputJson } : {}),
    ...(isError === undefined ? {} : { isError }),
    ...(action ? { controlAction: action } : {}),
  };
}

function decodeTranscriptCursor(raw: string | undefined, runId: string): number {
  if (!raw) return 0;
  if (raw.length > 512) throw new Error('invalid PI Subagent transcript cursor');
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as TranscriptCursor;
    if (
      value.version !== 1
      || value.runId !== runId
      || !Number.isSafeInteger(value.offset)
      || value.offset < 0
      || value.offset > MAX_TRANSCRIPT_BYTES
    ) throw new Error('invalid');
    return value.offset;
  } catch {
    throw new Error('invalid PI Subagent transcript cursor');
  }
}

function encodeTranscriptCursor(runId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, runId, offset } satisfies TranscriptCursor), 'utf8')
    .toString('base64url');
}

/** Read a bounded chronological page without trusting transcript paths from status.json. */
export async function readPiSubagentTranscriptPage(
  root: string,
  runId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<SubagentTranscriptPageResponse> {
  if (!RUN_DIR_RE.test(runId)) {
    return { supported: false, entries: [] };
  }
  const transcriptPath = path.join(root, runId, 'transcript.jsonl');
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(transcriptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { supported: false, entries: [] };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error('oversized, linked, or non-file PI Subagent transcript');
  }
  const start = decodeTranscriptCursor(options.cursor, runId);
  if (start > stat.size) throw new Error('PI Subagent transcript cursor exceeds file size');
  const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.floor(options.limit)
    : 50;
  const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE_SIZE, requested));
  const entries: SubagentTranscriptEntry[] = [];
  let offset = start;
  const input = createReadStream(transcriptPath, { encoding: 'utf8', start });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const lineOffset = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
      const entry = transcriptEntry(runId, lineOffset, line);
      if (entry) entries.push(entry);
      if (entries.length >= limit) {
        lines.close();
        input.destroy();
        break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  // `tailCursor` is returned even at EOF, where `nextCursor` is deliberately
  // absent: the renderer keeps it to resume from the byte it stopped at and
  // append only newly written lines, instead of re-reading a record that may
  // grow to the 50MB cap while a long-lived child keeps running.
  const tailCursor = encodeTranscriptCursor(runId, offset);
  return {
    supported: true,
    entries,
    ...(offset < stat.size ? { nextCursor: tailCursor } : {}),
    tailCursor,
  };
}

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  try {
    // Windows cannot replace a file another process has open: a runner reading
    // permission.json (or an AV scanner) turns this into a transient
    // EPERM/EACCES/EBUSY rather than a durable failure, so retry briefly.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temp, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!transient || attempt >= RENAME_RETRY_ATTEMPTS - 1) throw error;
        await new Promise<void>((resolve) => setTimeout(
          resolve,
          Math.min(RENAME_RETRY_STEP_MS * (attempt + 1), RENAME_RETRY_MAX_MS),
        ));
      }
    }
    await fs.chmod(file, 0o600).catch(() => undefined);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureExistingPrivateDirectory(parent: string, directory: string): Promise<void> {
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('PI Subagent run directory is unavailable');
  }
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const directoryStat = await fs.lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('PI Subagent control directory is unavailable');
  }
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function writeRunControl(
  root: string,
  runId: string,
  action: PiSubagentControlAction,
  options: {
    message?: string;
    childId?: string;
    approvalId?: string;
    confirmed?: boolean;
    value?: string;
  } = {},
): Promise<{ requestId: string; receiptFile: string }> {
  const requestId = randomUUID();
  const runDir = path.join(root, runId);
  const controlDir = path.join(runDir, 'controls');
  // Do not recursively recreate a run that parent deletion removed between
  // durable discovery and control delivery. A control may restore only its
  // mailbox inside an existing, non-linked UUID run directory.
  await ensureExistingPrivateDirectory(runDir, controlDir);
  const requestedAt = Date.now();
  controlWriteSequence = (controlWriteSequence + 1) % 1000;
  await writeAtomicJson(path.join(controlDir, `${requestId}.json`), {
    version: 1,
    seq: requestedAt * 1000 + controlWriteSequence,
    requestId,
    action,
    ...(options.message?.trim() ? { message: options.message.trim() } : {}),
    ...(options.childId ? { childId: options.childId } : {}),
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    ...(typeof options.confirmed === 'boolean' ? { confirmed: options.confirmed } : {}),
    ...(typeof options.value === 'string' ? { value: options.value } : {}),
    acknowledge: true,
    requestedAt,
  });
  return {
    requestId,
    receiptFile: path.join(runDir, 'control-receipts', `${requestId}.json`),
  };
}

async function waitForControlReceipt(
  root: string,
  runId: string,
  receiptFile: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await readSmallJson(receiptFile);
      await fs.rm(receiptFile, { force: true }).catch(() => undefined);
      return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as Record<string, unknown>).accepted === true,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    try {
      const status = parseStatus(
        await readSmallJson(path.join(root, runId, 'status.json')),
        runId,
      );
      if (!status || isPiSubagentTerminal(status.state) || isProcessAlive(status.runnerPid) === false) return false;
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Send a control request without ever interpreting taskId as a filesystem path.
 * The status record is discovered from UUID-only run directories, then the
 * request is written inside that already-contained directory.
 */
export async function syncPiSubagentPermissions(
  root: string,
  snapshot: unknown,
  runtimeOwnerId?: string,
): Promise<number> {
  const runs = (await listPiSubagentRuns(root)).filter((run) =>
    !isPiSubagentTerminal(run.state)
    && (runtimeOwnerId === undefined || run.runtimeOwnerId === runtimeOwnerId));
  let updated = 0;
  for (const run of runs) {
    try {
      await writeAtomicJson(path.join(root, run.runId, 'permission.json'), snapshot);
      updated += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return updated;
}

function matchesRunReference(run: PiSubagentRunStatus, reference: string): boolean {
  return run.taskId === reference || run.runId === reference;
}

export async function controlPiSubagentRuns(
  root: string,
  taskId: string,
  action: PiSubagentControlAction,
  options: {
    message?: string;
    childId?: string;
    approvalId?: string;
    confirmed?: boolean;
    value?: string;
    runtimeOwnerId?: string;
  } = {},
): Promise<number> {
  const id = taskId.trim();
  if (!id) return 0;
  if ((action === 'steer' || action === 'follow_up') && !options.message?.trim()) {
    throw new Error(`${action} requires a non-empty message`);
  }
  if (
    action === 'approval'
    && (
      !options.approvalId
      || (
        typeof options.confirmed !== 'boolean'
        && (typeof options.value !== 'string' || options.value.length === 0 || options.value.length > 64)
      )
    )
  ) {
    throw new Error('approval requires approvalId and a confirmed or value response');
  }
  const runs = (await listPiSubagentRuns(root)).filter(
    (run) => {
      if (!matchesRunReference(run, id) || isPiSubagentTerminal(run.state)) return false;
      if (options.runtimeOwnerId !== undefined && run.runtimeOwnerId !== options.runtimeOwnerId) return false;
      if (!options.childId) return true;
      const task = run.tasks.find((candidate) => candidate.childId === options.childId);
      if (!task) return false;
      if (action === 'approval') {
        return task.pendingApproval?.id === options.approvalId;
      }
      if (action === 'steer' && task.output?.trim()) return false;
      return task.status === 'queued' || task.status === 'running';
    },
  );
  const outcomes = await Promise.all(runs.map(async (run) => {
    const request = await writeRunControl(root, run.runId, action, options);
    // A status without a live runner identity is disk metadata, not proof that
    // anyone can consume the mailbox. Keep the request for diagnosis but do
    // not report successful delivery.
    if (isProcessAlive(run.runnerPid) !== true) return false;
    return waitForControlReceipt(root, run.runId, request.receiptFile);
  }));
  return outcomes.filter(Boolean).length;
}

interface ResumeRunnerConfig {
  version: 1;
  runId: string;
  taskId: string;
  parentSessionId: string;
  runtimeOwnerId?: string;
  runDir: string;
  cwd: string;
  binary: string;
  binaryPrefixArgs?: string[];
  depth?: number;
  mode?: string;
  context?: string;
  title?: string;
  description?: string;
  concurrency?: number;
  timeoutMs?: number;
  tasks: Array<{
    childId: string;
    stepId?: string;
    sessionId: string;
    sessionDir: string;
    agent: string;
    title?: string;
    task: string;
    tools: string;
    profilePrompt: string;
    provider: string;
    model?: string;
    sourceProviderId?: string;
    proxySessionAuth?: boolean;
    thinking?: string;
    cwd?: string;
  }>;
}

interface PiSubagentResumeLaunch {
  nodeExecutable: string;
  env: NodeJS.ProcessEnv;
  runtimeOwnerId: string;
  permissionSnapshot: unknown;
  runnerFallbackFile?: string;
  runtimeSnapshot?: {
    modelsJson: Buffer;
    bridgeSource: Buffer;
    runnerSource: Buffer;
  };
}

const resumeOperationTails = new Map<string, Promise<void>>();

async function serializePiSubagentResume<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const previous = resumeOperationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  resumeOperationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (resumeOperationTails.get(key) === tail) resumeOperationTails.delete(key);
  }
}

/**
 * Cross-process resume claim.
 *
 * The in-process promise map only serialises resumes inside one Cindy. Two
 * instances sharing `pi-agent-home` can read the same terminal generation, both
 * pass the "no active run" check, and each launch a runner over the *same* Pi
 * session dir and session id — concurrent writes into one session file and the
 * follow-up executed twice.
 *
 * The claim is an `O_EXCL` create, which is the one filesystem primitive that
 * is atomic across processes on both POSIX and Windows. It lives in the source
 * run directory, so it is scoped to exactly the generation being resumed.
 */
const RESUME_CLAIM_FILENAME = 'resume.claim';

interface PiSubagentResumeClaim {
  version: 1;
  runtimeOwnerId?: string;
  hostPid: number;
  claimedAt: number;
}

function parseResumeClaim(value: unknown): PiSubagentResumeClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.hostPid) || (raw.hostPid as number) <= 0) return null;
  return {
    version: 1,
    ...(typeof raw.runtimeOwnerId === 'string' ? { runtimeOwnerId: raw.runtimeOwnerId } : {}),
    hostPid: raw.hostPid as number,
    claimedAt: finiteNonNegative(raw.claimedAt) ? raw.claimedAt : 0,
  };
}

/** Raised when another *live* instance already holds the resume claim. */
export class PiSubagentResumeClaimedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSubagentResumeClaimedError';
  }
}

/** Filesystems without hard links; the claim falls back to a plain `wx` write. */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV']);
/** Budget for a claim whose payload has not landed yet — see `readSettledClaim`. */
const RESUME_CLAIM_READ_ATTEMPTS = 5;
const RESUME_CLAIM_READ_INTERVAL_MS = 100;

/**
 * Take the claim for `sourceDir`, or explain why not.
 *
 * Returns a release function on success. A claim left behind by a dead process
 * is taken over by renaming it aside first: `rename` is atomic, so exactly one
 * racer can move a given path and the losers fall through to the retry.
 * No TTL — a slow but live resume must never have its claim stolen.
 */
async function acquirePiSubagentResumeClaim(
  sourceDir: string,
  runtimeOwnerId: string | undefined,
  hostPid: number,
): Promise<(() => Promise<void>) | null> {
  const claimPath = path.join(sourceDir, RESUME_CLAIM_FILENAME);
  const payload = `${JSON.stringify({
    version: 1,
    ...(runtimeOwnerId ? { runtimeOwnerId } : {}),
    hostPid,
    claimedAt: Date.now(),
  })}\n`;
  const release = async (): Promise<void> => {
    await fs.rm(claimPath, { force: true }).catch(() => undefined);
  };

  /**
   * Create the claim with its payload already complete, or throw EEXIST.
   *
   * `link` is O_EXCL *with content*: the path appears atomically and whole, so a
   * racer can never read a partial claim. A bare `wx` write leaves the file
   * existing-but-empty for a moment, and a racer reading it there cannot tell
   * "still being written" from "corrupt" — it would take the claim over, and two
   * live instances would drive the same PI child session.
   */
  const publishClaim = async (): Promise<void> => {
    const staging = `${claimPath}.pub-${process.pid}-${randomUUID()}`;
    await fs.writeFile(staging, payload, { mode: 0o600 });
    try {
      await fs.link(staging, claimPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!LINK_UNSUPPORTED_CODES.has(code ?? '')) throw error;
      // No hard links here. The historical write comes back, and with it the
      // empty window that `readSettledClaim` below is bounded to absorb.
      await fs.writeFile(claimPath, payload, { mode: 0o600, flag: 'wx' });
    } finally {
      await fs.rm(staging, { force: true }).catch(() => undefined);
    }
  };

  /**
   * Read the claim, allowing a racer that created the file to finish writing it.
   *
   * Unreadable is retried rather than trusted: taking over on the first failed
   * parse is what lets a mid-write claim be stolen. Null only after the budget,
   * where the record is genuinely corrupt or from an older build — refusing
   * forever would wedge resume instead.
   */
  const readSettledClaim = async (): Promise<PiSubagentResumeClaim | null> => {
    for (let attempt = 0; ; attempt += 1) {
      const claim = parseResumeClaim(await readSmallJson(claimPath).catch(() => null));
      if (claim) return claim;
      if (attempt >= RESUME_CLAIM_READ_ATTEMPTS - 1) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, RESUME_CLAIM_READ_INTERVAL_MS));
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await publishClaim();
      return release;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The generation was deleted underneath us (task removal): nothing to resume.
      if (code === 'ENOENT') return null;
      if (code !== 'EEXIST') throw error;
    }
    const holder = await readSettledClaim();
    if (holder && isProcessAlive(holder.hostPid) !== false) {
      throw new PiSubagentResumeClaimedError(
        'Another running Cindy instance is already resuming this Subagent generation.',
      );
    }
    if (attempt === 0) {
      await fs.rename(claimPath, `${claimPath}.stale-${process.pid}-${randomUUID()}`)
        .catch(() => undefined);
    }
  }
  throw new PiSubagentResumeClaimedError(
    'This Subagent generation is already being resumed.',
  );
}

function isResumeConfig(value: unknown, runId: string): value is ResumeRunnerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === 1
    && raw.runId === runId
    && typeof raw.taskId === 'string'
    && typeof raw.parentSessionId === 'string'
    && typeof raw.cwd === 'string'
    && typeof raw.binary === 'string'
    && Array.isArray(raw.tasks)
    && raw.tasks.length > 0
    && raw.tasks.length <= 8;
}

/**
 * Resume the latest terminal generation on its existing PI child session ids.
 * Credentials are supplied only by the live parent handle and are never copied
 * into durable config. The new runner receives fresh private runtime snapshots.
 */
async function resumePiSubagentRunUnlocked(
  root: string,
  taskId: string,
  message: string,
  launch: PiSubagentResumeLaunch,
  childId?: string,
): Promise<string | null> {
  const followUp = message.trim();
  if (!taskId.trim() || !followUp || followUp.length > 32_000) {
    throw new Error('invalid PI Subagent resume request');
  }
  const runs = await listPiSubagentRuns(root);
  const source = runs.find((run) => matchesRunReference(run, taskId));
  if (!source || !isPiSubagentTerminal(source.state)) return null;
  if (runs.some((run) => run.taskId === source.taskId && !isPiSubagentTerminal(run.state))) return null;
  const sourceDir = path.join(root, source.runId);
  // Everything from here to the new run's status.json is the critical section:
  // that file is what makes the "already has an active run" check above true
  // for anyone else. Hold the cross-process claim across it.
  const releaseClaim = await acquirePiSubagentResumeClaim(
    sourceDir,
    launch.runtimeOwnerId,
    process.pid,
  );
  if (!releaseClaim) return null;
  try {
    return await resumeClaimedPiSubagentRun(
      root, source, sourceDir, followUp, launch, childId,
    );
  } finally {
    // Released as soon as the new generation exists on disk: from then on the
    // ordinary active-run check is the guard, so keeping the claim would only
    // leak a file that blocks the next legitimate resume.
    await releaseClaim();
  }
}

async function resumeClaimedPiSubagentRun(
  root: string,
  source: PiSubagentRunStatus,
  sourceDir: string,
  followUp: string,
  launch: PiSubagentResumeLaunch,
  childId?: string,
): Promise<string | null> {
  // Re-check under the claim: a racer may have won and already published a new
  // active generation between our listing and taking the claim.
  const claimedRuns = await listPiSubagentRuns(root);
  if (claimedRuns.some((run) => run.taskId === source.taskId && !isPiSubagentTerminal(run.state))) {
    return null;
  }
  const sourceConfigValue = await readSmallJson(path.join(sourceDir, 'config.json'));
  if (!isResumeConfig(sourceConfigValue, source.runId)) {
    throw new Error('PI Subagent resume config is unavailable');
  }
  const sourceConfig = sourceConfigValue;
  const selectedTasks = childId
    ? sourceConfig.tasks.filter((task) => task.childId === childId)
    : sourceConfig.tasks;
  if (selectedTasks.length === 0) return null;
  const canonicalRoot = await fs.realpath(root);
  const canonicalSourceDir = await fs.realpath(sourceDir);
  if (path.dirname(canonicalSourceDir) !== canonicalRoot) {
    throw new Error('PI Subagent resume source escaped its run root');
  }
  const canonicalSourcePrefix = `${canonicalSourceDir}${path.sep}`;
  for (const task of sourceConfig.tasks) {
    if (typeof task.sessionDir !== 'string' || !path.resolve(task.sessionDir).startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new Error('PI Subagent resume session escaped its run root');
    }
    const sessionStat = await fs.lstat(task.sessionDir);
    const canonicalSessionDir = await fs.realpath(task.sessionDir);
    const canonicalSessionRunDir = path.dirname(canonicalSessionDir);
    const sessionRunStat = await fs.lstat(canonicalSessionRunDir);
    if (
      sessionStat.isSymbolicLink()
      || !sessionStat.isDirectory()
      || path.basename(canonicalSessionDir) !== 'sessions'
      || sessionRunStat.isSymbolicLink()
      || !sessionRunStat.isDirectory()
      || path.dirname(canonicalSessionRunDir) !== canonicalRoot
      || !RUN_DIR_RE.test(path.basename(canonicalSessionRunDir))
    ) {
      throw new Error('PI Subagent resume session escaped its source run');
    }
  }
  const sourceConfigHome = path.join(sourceDir, 'pi-home');
  const sourceModelsFile = path.join(sourceConfigHome, 'models.json');
  const sourceBridgeFile = path.join(sourceDir, 'cindy-bridge.ts');
  const sourceRunnerFile = path.join(sourceDir, 'runner.cjs');
  const [configHomeStat, modelsStat, bridgeStat, canonicalConfigHome, canonicalModelsFile, canonicalBridgeFile] = await Promise.all([
    fs.lstat(sourceConfigHome),
    fs.lstat(sourceModelsFile),
    fs.lstat(sourceBridgeFile),
    fs.realpath(sourceConfigHome),
    fs.realpath(sourceModelsFile),
    fs.realpath(sourceBridgeFile),
  ]);
  if (
    configHomeStat.isSymbolicLink()
    || !configHomeStat.isDirectory()
    || !canonicalConfigHome.startsWith(canonicalSourcePrefix)
    || modelsStat.isSymbolicLink()
    || !modelsStat.isFile()
    || modelsStat.size > MAX_STATUS_BYTES
    || !canonicalModelsFile.startsWith(canonicalSourcePrefix)
    || bridgeStat.isSymbolicLink()
    || !bridgeStat.isFile()
    || bridgeStat.size > MAX_STATUS_BYTES
    || !canonicalBridgeFile.startsWith(canonicalSourcePrefix)
  ) {
    throw new Error('PI Subagent resume runtime artifacts escaped their source run');
  }
  let selectedRunnerFile = sourceRunnerFile;
  let runnerStat: import('node:fs').Stats;
  try {
    runnerStat = await fs.lstat(sourceRunnerFile);
  } catch (error) {
    if (!launch.runnerFallbackFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    selectedRunnerFile = launch.runnerFallbackFile;
    runnerStat = await fs.lstat(selectedRunnerFile);
  }
  if (runnerStat.isSymbolicLink() || !runnerStat.isFile() || runnerStat.size > MAX_STATUS_BYTES) {
    throw new Error('PI Subagent resume runner is linked, oversized, or unavailable');
  }
  const [modelsJson, bridgeSource, runnerSource] = launch.runtimeSnapshot
    ? [
        launch.runtimeSnapshot.modelsJson,
        launch.runtimeSnapshot.bridgeSource,
        launch.runtimeSnapshot.runnerSource,
      ]
    : await Promise.all([
        fs.readFile(sourceModelsFile),
        fs.readFile(sourceBridgeFile),
        fs.readFile(selectedRunnerFile),
      ]);
  JSON.parse(modelsJson.toString('utf8'));
  const runId = randomUUID();
  const runDir = path.join(root, runId);
  const childConfigHome = path.join(runDir, 'pi-home');
  const bridgeExtension = path.join(runDir, 'cindy-bridge.ts');
  const permissionFile = path.join(runDir, 'permission.json');
  const runnerFile = path.join(runDir, 'runner.cjs');
  const config: ResumeRunnerConfig & Record<string, unknown> = {
    ...sourceConfig,
    runId,
    runDir,
    childConfigHome,
    bridgeExtension,
    permissionFile,
    title: sourceConfig.title ? `Resume: ${sourceConfig.title}` : 'Resumed Subagent',
    description: followUp,
    runtimeOwnerId: launch.runtimeOwnerId,
    interactiveOwner: 'host',
    parentPid: undefined,
    mode: selectedTasks.length > 1 ? 'parallel' : 'single',
    tasks: selectedTasks.map((task, index) => ({
      ...task,
      childId: `${runId}-${index + 1}`,
      stepId: `resume-${index + 1}`,
      dependsOn: [],
      task: followUp,
      // Session dir/id intentionally point at the prior durable generation.
      sessionDir: task.sessionDir,
    })),
  };
  const launchStartedAt = Date.now();
  try {
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(childConfigHome, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(childConfigHome, 'models.json'), modelsJson, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(bridgeExtension, bridgeSource, { mode: 0o600, flag: 'wx' });
    await writeAtomicJson(permissionFile, launch.permissionSnapshot);
    await fs.writeFile(runnerFile, runnerSource, { mode: 0o600, flag: 'wx' });
    await Promise.all([
      fs.chmod(runDir, 0o700).catch(() => undefined),
      fs.chmod(bridgeExtension, 0o600).catch(() => undefined),
      fs.chmod(permissionFile, 0o600).catch(() => undefined),
      fs.chmod(runnerFile, 0o600).catch(() => undefined),
    ]);
    await writeAtomicJson(path.join(runDir, 'config.json'), config);
    await writeAtomicJson(path.join(runDir, 'status.json'), {
      version: 1,
      runId,
      taskId: sourceConfig.taskId,
      parentSessionId: sourceConfig.parentSessionId,
      runtimeOwnerId: launch.runtimeOwnerId,
      runnerInstanceId: `launch-pending-${runId}`,
      state: 'queued',
      title: config.title,
      description: config.description,
      startedAt: launchStartedAt,
      updatedAt: launchStartedAt,
      tasks: config.tasks.map((task) => ({
        childId: task.childId,
        sessionId: task.sessionId,
        agent: task.agent,
        title: task.title,
        status: 'queued',
      })),
    });
  } catch (error) {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const child = spawn(launch.nodeExecutable, [runnerFile, path.join(runDir, 'config.json')], {
    cwd: sourceConfig.cwd,
    env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', (error) => {
    const now = Date.now();
    void writeAtomicJson(path.join(runDir, 'status.json'), {
      version: 1,
      runId,
      taskId: sourceConfig.taskId,
      parentSessionId: sourceConfig.parentSessionId,
      runtimeOwnerId: launch.runtimeOwnerId,
      runnerInstanceId: `launch-error-${runId}`,
      state: 'failed',
      title: config.title,
      description: config.description,
      startedAt: now,
      updatedAt: now,
      endedAt: now,
      tasks: config.tasks.map((task) => ({
        childId: task.childId,
        sessionId: task.sessionId,
        agent: task.agent,
        title: task.title,
        status: 'failed',
        error: `Durable runner failed to resume: ${String(error)}`.slice(0, 4_000),
        endedAt: now,
      })),
    }).catch(() => undefined);
  });
  child.unref();
  return runId;
}

export async function resumePiSubagentRun(
  root: string,
  taskId: string,
  message: string,
  launch: PiSubagentResumeLaunch,
  childId?: string,
): Promise<string | null> {
  return serializePiSubagentResume(root, () => resumePiSubagentRunUnlocked(
    root,
    taskId,
    message,
    launch,
    childId,
  ));
}

/**
 * Is anything still running that *this* host would have to stop on exit?
 *
 * `hostPid` scopes the answer to this process (plus unattributable and orphaned
 * runs). Without it a concurrent instance sharing `pi-agent-home` would make
 * this host warn about, and later stop, work it does not own.
 */
export function hasActivePiSubagentRunsSync(
  agentHome: string,
  scope: PiSubagentSweepScope = {},
): boolean {
  const parentRoot = path.join(agentHome, 'runtime', 'pi-subagent-runs');
  let sessionEntries: import('node:fs').Dirent[];
  try { sessionEntries = readdirSync(parentRoot, { withFileTypes: true }); } catch { return false; }
  for (const sessionEntry of sessionEntries) {
    if (!sessionEntry.isDirectory()) continue;
    let runEntries: import('node:fs').Dirent[];
    const root = path.join(parentRoot, sessionEntry.name);
    try { runEntries = readdirSync(root, { withFileTypes: true }); } catch { return true; }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || !RUN_DIR_RE.test(runEntry.name)) continue;
      try {
        const status = parseStatus(
          JSON.parse(readFileSync(path.join(root, runEntry.name, 'status.json'), 'utf8')),
          runEntry.name,
        );
        if (status && scope.hostPid !== undefined && !isSweepableByHost(status, scope.hostPid)) {
          continue;
        }
        if (!status || (!isPiSubagentTerminal(status.state) && !isPiSubagentRunStale(status))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/** Force-quit variant of the exit sweep; same ownership scoping. */
export function requestStopAllPiSubagentRunsSync(
  agentHome: string,
  scope: PiSubagentSweepScope = {},
): number {
  const parentRoot = path.join(agentHome, 'runtime', 'pi-subagent-runs');
  let requested = 0;
  let sessionEntries: import('node:fs').Dirent[];
  try { sessionEntries = readdirSync(parentRoot, { withFileTypes: true }); } catch { return 0; }
  for (const sessionEntry of sessionEntries) {
    if (!sessionEntry.isDirectory()) continue;
    const root = path.join(parentRoot, sessionEntry.name);
    let runEntries: import('node:fs').Dirent[];
    try { runEntries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const runEntry of runEntries) {
      if (!runEntry.isDirectory() || !RUN_DIR_RE.test(runEntry.name)) continue;
      const runDir = path.join(root, runEntry.name);
      try {
        let status: PiSubagentRunStatus | null = null;
        try {
          status = parseStatus(
            JSON.parse(readFileSync(path.join(runDir, 'status.json'), 'utf8')),
            runEntry.name,
          );
        } catch { /* unreadable status is treated as potentially active */ }
        if (status && (isPiSubagentTerminal(status.state) || isPiSubagentRunStale(status))) continue;
        if (status && scope.hostPid !== undefined && !isSweepableByHost(status, scope.hostPid)) continue;
        const controlPath = path.join(runDir, 'control.json');
        let seq = 0;
        try {
          const previous = JSON.parse(readFileSync(controlPath, 'utf8')) as { seq?: unknown };
          if (finiteNonNegative(previous.seq)) seq = Math.floor(previous.seq);
        } catch { /* first request */ }
        const temp = `${controlPath}.tmp-exit-${process.pid}-${randomUUID()}`;
        writeFileSync(temp, `${JSON.stringify({
          version: 1,
          seq: seq + 1,
          requestId: randomUUID(),
          action: 'stop',
          requestedAt: Date.now(),
        })}\n`, { mode: 0o600 });
        renameSync(temp, controlPath);
        requested += 1;
      } catch {
        // Force-quit is best effort. Ordinary quit uses the awaited variant.
      }
    }
  }
  return requested;
}

/**
 * Ownership scope for a stop sweep.
 *
 * - `runtimeOwnerId` — exact handle scope (one parent task's own children).
 * - `hostPid` — agent-home-wide scope: everything this Cindy process started,
 *   plus anything unattributable or orphaned by a dead process. A run owned by
 *   a different, still-live instance is left alone.
 *
 * Both are optional; omitting them sweeps everything (legacy behaviour).
 */
export interface PiSubagentSweepScope {
  runtimeOwnerId?: string;
  hostPid?: number;
  /**
   * Account boundary only: when the stop mailbox is still unconsumed at the
   * deadline, escalate to killing the runner itself after verifying its
   * identity. Ordinary quit does not set this — there the process is going away
   * anyway, and a mailbox timeout is not a credential-safety problem.
   */
  killUnresponsiveRunners?: boolean;
}

/**
 * Runs under `root` that this sweep still owns, as one universe.
 *
 * `status` is undefined when status.json is missing, corrupt, oversized or
 * unreadable. Those runs stay in the set deliberately, and every pass of the
 * sweep derives its work from *this* function: when the stop pass and the kill
 * pass disagree about which runs exist, a record we cannot read drops out of the
 * escalation and the boundary reports itself clean.
 *
 * Skipping a stale run is not "assumed handled" — it is that there is nothing
 * left to handle *and* nothing to signal. Stale means the runner process is
 * provably gone (dead pid or expired heartbeat), so no one will consume a stop
 * control written here; the run is also already hidden from
 * `listPiSubagentRuns`. Its Pi children are reaped by the runner's death closing
 * their stdin (see the stdin-EOF regression in
 * `cindySubagentParentWatchdog.test.ts`). The only other option would be
 * signalling child pids read off disk, which the runner header forbids because
 * of pid reuse.
 */
async function sweepableRunsUnderRoot(
  root: string,
  scope: PiSubagentSweepScope,
): Promise<Array<{ runId: string; status: PiSubagentRunStatus | undefined }>> {
  const runIds = await listRunDirectoryIds(root);
  const [listedStatuses, diagnostics] = await Promise.all([
    listPiSubagentRuns(root),
    listPiSubagentRunDiagnostics(root),
  ]);
  const statuses = new Map(listedStatuses.map((status) => [status.runId, status]));
  const staleRunIds = new Set(
    diagnostics.filter((diagnostic) => diagnostic.kind === 'stale').map((diagnostic) => diagnostic.runId),
  );
  const sweepable: Array<{ runId: string; status: PiSubagentRunStatus | undefined }> = [];
  for (const runId of runIds) {
    const status = statuses.get(runId);
    if ((status && isPiSubagentTerminal(status.state)) || staleRunIds.has(runId)) continue;
    if (
      scope.runtimeOwnerId !== undefined
      && status?.runtimeOwnerId !== undefined
      && status.runtimeOwnerId !== scope.runtimeOwnerId
    ) {
      continue;
    }
    if (scope.hostPid !== undefined && !isSweepableByHost(status, scope.hostPid)) continue;
    sweepable.push({ runId, status });
  }
  return sweepable;
}

/**
 * Request stop for every non-terminal run under `roots` and wait until they are
 * all terminal (or the deadline passes). An unreadable status stays in scope so
 * a corrupt record can never keep a child alive past its boundary.
 */
async function stopPiSubagentRunsUnderRoots(
  roots: readonly string[],
  timeoutMs: number,
  scope: PiSubagentSweepScope = {},
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, Math.floor(timeoutMs));
  const requested = new Set<string>();
  for (;;) {
    let activeCount = 0;
    for (const root of roots) {
      for (const { runId } of await sweepableRunsUnderRoot(root, scope)) {
        activeCount += 1;
        const key = `${root}:${runId}`;
        if (requested.has(key)) continue;
        requested.add(key);
        await writeRunControl(root, runId, 'stop').catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    }
    if (activeCount === 0) return true;
    if (Date.now() >= deadline) {
      // The mailbox was never consumed. At an account boundary that is not
      // something we can log and walk away from: the child holds direct BYOM
      // credentials that no token revocation can reach, so it would keep
      // spending the outgoing account and editing the workspace. Escalate to a
      // verified kill; anything we cannot positively identify is left alone.
      if (!scope.killUnresponsiveRunners) return false;
      let killedAll = true;
      for (const root of roots) {
        // Re-derived, so a run whose directory vanished in the meantime is gone
        // from the set and counts as reclaimed.
        for (const { status } of await sweepableRunsUnderRoot(root, scope)) {
          if (!status) {
            // No readable status means no runner identity to verify, and the
            // header forbids signalling a pid we cannot prove. So we cannot
            // reclaim it — but the caller must not hear that the boundary is
            // clean, or an account switch proceeds with this child still live.
            killedAll = false;
            continue;
          }
          if (!await killVerifiedPiSubagentRunner(status)) killedAll = false;
        }
      }
      return killedAll;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Quit / account-boundary sweep across the whole agent home.
 *
 * `scope.hostPid` keeps a concurrent instance's Subagents alive: dev +
 * packaged + every `--passive` launch share one `pi-agent-home`, so an
 * unscoped sweep would stop another live instance's children.
 */
export async function stopAllPiSubagentRunsForExit(
  agentHome: string,
  timeoutMs = 4_000,
  scope: PiSubagentSweepScope = {},
): Promise<boolean> {
  const parentRoot = path.join(agentHome, 'runtime', 'pi-subagent-runs');
  let sessionEntries: import('node:fs').Dirent[];
  try {
    sessionEntries = await fs.readdir(parentRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const roots = sessionEntries
    .filter((entry) => entry.isDirectory() && entry.name !== '.' && entry.name !== '..')
    .map((entry) => path.join(parentRoot, entry.name));
  return stopPiSubagentRunsUnderRoots(roots, timeoutMs, scope);
}

/**
 * Account boundary (logout / account switch) teardown for one parent task.
 *
 * Unlike ordinary navigation close, the owning account's database and gateway
 * credentials are being replaced, so its detached children must not keep
 * running against the next owner's routing. Durable files are deliberately left
 * on disk — this is an ownership boundary, not a data-removal boundary.
 */
export async function stopPiSubagentRunsForAccountBoundary(
  root: string,
  options: { runtimeOwnerId?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  return stopPiSubagentRunsUnderRoots([root], options.timeoutMs ?? 4_000, {
    ...(options.runtimeOwnerId !== undefined ? { runtimeOwnerId: options.runtimeOwnerId } : {}),
    killUnresponsiveRunners: true,
  });
}

/**
 * Explicit parent deletion lifecycle: request stop for every UUID-contained
 * runner, wait for runner-owned process termination, then remove durable files.
 * A timeout never deletes live ownership metadata; callers may retry cleanup.
 */
export async function stopAndRemovePiSubagentRuns(
  root: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 6_000;
  const deadline = Date.now() + timeout;
  const requested = new Set<string>();
  for (;;) {
    const runIds = await listRunDirectoryIds(root);
    if (runIds.length === 0) {
      await fs.rm(root, { recursive: true, force: true });
      return true;
    }
    const [listedStatuses, diagnostics] = await Promise.all([
      listPiSubagentRuns(root),
      listPiSubagentRunDiagnostics(root),
    ]);
    const statuses = new Map(listedStatuses.map((status) => [status.runId, status]));
    const staleRunIds = new Set(
      diagnostics.filter((diagnostic) => diagnostic.kind === 'stale').map((diagnostic) => diagnostic.runId),
    );
    const active = runIds.filter((runId) => {
      if (staleRunIds.has(runId)) return false;
      const status = statuses.get(runId);
      return !status || !isPiSubagentTerminal(status.state);
    });
    if (active.length === 0) {
      await fs.rm(root, { recursive: true, force: true });
      return true;
    }
    await Promise.all(active.map(async (runId) => {
      if (requested.has(runId)) return;
      requested.add(runId);
      try {
        await writeRunControl(root, runId, 'stop');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
