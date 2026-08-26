import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

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

function containedParentSessionId(sessionId: string): string {
  const id = sessionId.trim();
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    throw new Error('unsafe PI Subagent parent session id');
  }
  return id;
}

export function piSubagentRunRoot(agentHome: string, sessionId: string): string {
  return path.join(agentHome, 'runtime', 'pi-subagent-runs', containedParentSessionId(sessionId));
}

/**
 * Cross-process tombstone for a *deleted parent task*.
 *
 * Lives next to the run root, never inside it: `stopAndRemovePiSubagentRuns`
 * deletes the run directory, and a marker that vanished with it could not stop
 * another instance sharing `userData` from recreating the root. The in-Pi
 * launcher reads this after publishing `queued` and before spawn, using the
 * same opposite-order protocol as the launch fence.
 */
export function piSubagentDeletedTombstonePath(agentHome: string, sessionId: string): string {
  return path.join(agentHome, 'runtime', 'pi-subagent-deleted', containedParentSessionId(sessionId));
}

export async function writePiSubagentDeletedTombstone(
  agentHome: string,
  sessionId: string,
): Promise<void> {
  const file = piSubagentDeletedTombstonePath(agentHome, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(staging, `${JSON.stringify({
    version: 1,
    sessionId: containedParentSessionId(sessionId),
    deletedAt: Date.now(),
    hostPid: process.pid,
  })}\n`, { mode: 0o600 });
  try {
    await fs.rename(staging, file);
  } finally {
    await fs.rm(staging, { force: true }).catch(() => undefined);
  }
}

export function isPiSubagentDeletedTombstonePresent(agentHome: string, sessionId: string): boolean {
  try {
    lstatSync(piSubagentDeletedTombstonePath(agentHome, sessionId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

/**
 * IM sessions reuse a deterministic id. After a soft-delete, an inbound
 * message flips the same row back to active. Leave this marker in place and
 * every later durable launch fails as "parent task was deleted". ENOENT means
 * there is already nothing to retire.
 */
export async function clearPiSubagentDeletedTombstone(
  agentHome: string,
  sessionId: string,
): Promise<void> {
  const file = piSubagentDeletedTombstonePath(agentHome, sessionId);
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
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

/**
 * Cross-process launch fence.
 *
 * An update relaunch has to guarantee that no durable runner appears between
 * "the agent home is quiet" and `process.exit(0)`. Re-scanning cannot give that
 * guarantee, because the spawn does not happen here: `launchDurableRun` runs
 * inside the Pi process, in an injected extension the Host never calls. So the
 * agreement is a file both sides can see.
 *
 * Protocol:
 *  - The Host writes `{ version: 1, hostPid, createdAt }` into the shared runs
 *    directory before its first reclaim pass, and removes it on every exit from
 *    the relaunch — success or cancellation.
 *  - A launcher refuses only when the fence names *its own* host and that pid is
 *    alive. A fence from another instance sharing the agent home is ignored, and
 *    a fence whose owner died is inert, so a crashed Host can never wedge
 *    Subagent launches for anyone (including its own replacement).
 *  - The reclaim loop still runs: the fence closes the window, the loop clears
 *    whatever was already in flight when it closed.
 *
 * **Ownership is the file name.** `pi-agent-home` is shared by dev, packaged and
 * every `--passive` launch, so two instances can update at once. With a single
 * shared file the later writer overwrote the earlier one's fence and either
 * one's cancellation deleted it outright — after which the still-restarting
 * instance's own launcher read a fence naming somebody else, ignored it, and
 * spawned a runner straight through the window. Per-host names make the whole
 * class impossible: nobody writes or deletes a file that is not theirs, and the
 * content check stays as a second line of defence.
 */
export const PI_SUBAGENT_LAUNCH_FENCE_FILENAME = '.launch-fence.json';
const PI_SUBAGENT_LAUNCH_FENCE_PREFIX = '.launch-fence-';
const PI_SUBAGENT_LAUNCH_FENCE_SUFFIX = '.json';

interface PiSubagentLaunchFence {
  version: 1;
  hostPid: number;
  /**
   * Start second of the host that raised it. A pid alone cannot say "this fence
   * is mine": a crash leaves the file behind, the OS hands the same pid to the
   * next instance, and that instance then refuses *every* durable launch for
   * its whole life — its own fence check matches, and the stale sweep keeps the
   * file because the pid is alive. Absent on fences written before this field.
   */
  hostStartTimeSec?: number;
  /**
   * Identifies the individual acquisition, not the host.
   *
   * Two boundaries in one process share a fence file (an update reclaim while
   * the user quits; an account teardown overlapping a quit), and the counter in
   * `launchFenceLeases` composes them. This field guards the case the counter
   * cannot see: a release that runs against a *file* somebody else wrote —
   * because the counter was lost with a reload, or because a second writer
   * overwrote the payload. A release only deletes a file whose `leaseId` is its
   * own. Absent on fences written before this field, which keep the old
   * unconditional delete.
   */
  leaseId?: string;
  createdAt: number;
}

/**
 * Live fence acquisitions in this process, keyed by fence file.
 *
 * Per-host isolation made the file unambiguous but not re-entrant: whichever
 * boundary released first deleted the file, tearing down the fence the other
 * one was still relying on to keep launchers out. Counting means the last
 * holder is the one that lowers it.
 */
const launchFenceLeases = new Map<string, { leaseId: string; holders: number }>();

/**
 * Serialises every *disk* operation on a given fence file within this process.
 *
 * Removing a fence is read-then-delete, and the delete is an await: the read
 * saw our own lease, and by the time the `rm` ran a new boundary could have
 * published its own file into the same path. The delete then took the *new*
 * fence down while its holder was counted and believed itself fenced — the
 * launcher inside Pi reads the file, finds nothing, and spawns.
 *
 * There is no POSIX "unlink only if the content still matches", and
 * rename-out/check/rename-back has a replay race of its own, so the read and
 * the delete are made indivisible the only way available in one process: every
 * publish and every removal queues behind the last one on the same path.
 *
 * This is only about the file. The in-memory reservation is still taken
 * synchronously before the first await — that is what makes two boundaries
 * starting in the same tick compose, and it is deliberately untouched here.
 */
const launchFenceDiskChain = new Map<string, Promise<void>>();

/** Run `work` after every disk operation already queued for `file`. */
function queueLaunchFenceDiskWork<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = launchFenceDiskChain.get(file) ?? Promise.resolve();
  // Both arms run `work`: a link that failed is still a link that finished, and
  // its error belongs to the caller that queued it, not to whoever comes next.
  const result = previous.then(work, work);
  const link = result.then(() => undefined, () => undefined);
  launchFenceDiskChain.set(file, link);
  void link.then(() => {
    // Only the tail clears the entry, or a late link would drop a newer one.
    if (launchFenceDiskChain.get(file) === link) launchFenceDiskChain.delete(file);
  });
  return result;
}

function piSubagentRunsRoot(agentHome: string): string {
  return path.join(agentHome, 'runtime', 'pi-subagent-runs');
}

/**
 * Inverse of `piSubagentRunRoot`: `<agentHome>/runtime/pi-subagent-runs/<sid>`
 * back to `<agentHome>`. Spelled out once so the two fence checks on this path
 * cannot disagree about how many levels to climb — getting it wrong disables
 * the fence silently.
 */
function piSubagentAgentHomeFromRunRoot(runRoot: string): string {
  return path.dirname(path.dirname(path.dirname(runRoot)));
}

/**
 * This host's own fence file. The pid in the name is what makes ownership
 * unambiguous without reading anything.
 */
export function piSubagentLaunchFencePath(agentHome: string, hostPid = process.pid): string {
  return path.join(
    piSubagentRunsRoot(agentHome),
    `${PI_SUBAGENT_LAUNCH_FENCE_PREFIX}${hostPid}${PI_SUBAGENT_LAUNCH_FENCE_SUFFIX}`,
  );
}

/**
 * The pre-per-host file name.
 *
 * Read alongside the owned one so a half-upgraded pair of instances (one build
 * writing the shared name, one writing its own) still blocks correctly. Safe to
 * delete once no shipped build writes the shared name any more.
 */
function legacyLaunchFencePath(agentHome: string): string {
  return path.join(piSubagentRunsRoot(agentHome), PI_SUBAGENT_LAUNCH_FENCE_FILENAME);
}

function readLaunchFence(file: string): PiSubagentLaunchFence | null {
  return readLaunchFenceFile(file).fence ?? null;
}

/**
 * Read a fence, keeping "there is no such file" apart from "I could not read
 * it".
 *
 * Collapsing the two is what let a transient failure read as "no fence": a
 * Windows sharing conflict while the Host rewrites the file, a permission
 * error, or content that does not parse. Callers that gate a launch have to
 * treat the second case as a fence, because being unable to verify the fence is
 * exactly the window it exists to close.
 */
function readLaunchFenceFile(
  file: string,
): { unreadable: boolean; fence?: PiSubagentLaunchFence } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { unreadable: false };
    return { unreadable: true };
  }
  let fence: PiSubagentLaunchFence | null;
  try {
    fence = parseLaunchFence(JSON.parse(raw));
  } catch {
    // Readable but not JSON. Nothing atomic could have published that, so it is
    // debris — but it is debris sitting at a path a launcher obeys, so treat it
    // as a fence here and let the stale sweep be the one to remove it.
    return { unreadable: true };
  }
  return fence ? { unreadable: false, fence } : { unreadable: true };
}

function parseLaunchFence(value: unknown): PiSubagentLaunchFence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (!Number.isSafeInteger(raw.hostPid) || (raw.hostPid as number) <= 0) return null;
  return {
    version: 1,
    hostPid: raw.hostPid as number,
    ...(Number.isSafeInteger(raw.hostStartTimeSec) && (raw.hostStartTimeSec as number) > 0
      ? { hostStartTimeSec: raw.hostStartTimeSec as number }
      : {}),
    ...(typeof raw.leaseId === 'string' && raw.leaseId ? { leaseId: raw.leaseId } : {}),
    createdAt: finiteNonNegative(raw.createdAt) ? raw.createdAt : 0,
  };
}

/**
 * Was this fence raised by *this* incarnation of `hostPid`?
 *
 * A fence with no recorded start time keeps the historical pid-only answer —
 * conservative, and the only thing an older writer left us to go on.
 */
function fenceMatchesOwnIncarnation(fence: PiSubagentLaunchFence): boolean {
  if (fence.hostStartTimeSec === undefined) return true;
  return Math.abs(ownProcessStartTimeSec() - fence.hostStartTimeSec) <= OWNER_START_TIME_TOLERANCE_SEC;
}

/**
 * Does a fence currently forbid `hostPid` from starting new durable runs?
 *
 * Synchronous and cheap on purpose: it sits in front of a spawn, and both
 * callers (the in-Pi extension and the Host's resume path) need an answer
 * without an await budget. Unreadable or absent means "no fence".
 *
 * Readers stay outside the per-file serialisation chain. What that chain
 * guarantees is the *settled* state — a counted holder implies a file on disk
 * once its publish has run — and a reader that lands before a publish or after
 * the last release is seeing a window that genuinely has no fence in it.
 * Queueing readers behind pending writes would not remove that window, only
 * move it, and would put an await in front of a spawn decision.
 */
export function isPiSubagentLaunchFenceActive(agentHome: string, hostPid: number): boolean {
  // Named lookup, no directory scan: only this host's own fence can block it.
  // The legacy shared name is still consulted for the upgrade window.
  for (const file of [piSubagentLaunchFencePath(agentHome, hostPid), legacyLaunchFencePath(agentHome)]) {
    const read = readLaunchFenceFile(file);
    if (read.unreadable) {
      // Fail closed, matching the in-Pi launcher. The owned path's *name*
      // already proves whose fence it is, so no content is needed to know it
      // would bind us; the legacy shared name cannot prove it, and not being
      // able to read it is not being able to rule out that it is ours. Both
      // conditions are transient, so the cost is a retry.
      if (isProcessAlive(hostPid) !== false) return true;
      continue;
    }
    const fence = read.fence;
    if (!fence || fence.hostPid !== hostPid) continue;
    // Ours by pid, but possibly a previous life's: a fence that outlived a
    // crash and had its pid recycled onto us would otherwise refuse every
    // launch this process ever makes.
    if (hostPid === process.pid && !fenceMatchesOwnIncarnation(fence)) continue;
    if (isProcessAlive(fence.hostPid) !== false) return true;
  }
  return false;
}

/**
 * Raise the fence for this process. The returned release is idempotent and must
 * run on every path out of the relaunch, or this host's own next launch attempt
 * would be refused until it exits.
 *
 * Re-entrant across the boundaries that share this process. Two of them can be
 * open at once — an update reclaim the user quits out of, an account teardown
 * that overlaps a quit — and the fence must stay up until the last one is done.
 * Two mechanisms, guarding different things:
 *  - the in-process counter composes overlapping holders, so an early release
 *    lowers nothing while another holder is still inside its window;
 *  - the `leaseId` in the payload makes the delete conditional, so a release
 *    can never remove a file it did not write. That is what covers the case the
 *    counter cannot see at all — a second writer having replaced the payload,
 *    or the counter itself having been lost.
 * Neither replaces the stale sweep: a process killed outright leaves the file,
 * and the next instance's start-identity check is what clears it.
 */
export async function acquirePiSubagentLaunchFence(agentHome: string): Promise<() => Promise<void>> {
  // Writes and deletes only this host's file, so a concurrent instance's fence
  // can neither be clobbered by this one nor removed by its cancellation.
  const file = piSubagentLaunchFencePath(agentHome);
  // Reserved in one synchronous run, before the first await. Registering after
  // the write looked safer — a failed acquire could not pin the fence up — but
  // it left the read and the registration on opposite sides of two awaits, and
  // two boundaries of this process do start together (an update reclaim the
  // user quits out of, an account teardown overlapping a quit). Both then read
  // `undefined`, minted separate leases, and the later write and the later
  // `set` each replaced the earlier one — leaving a Map that knew about one
  // holder. Whichever boundary finished first matched that entry, matched the
  // file, and took the fence down while the other was still reclaiming.
  //
  // Node runs this block to completion before any other task, so a second
  // caller cannot miss this reservation: it either runs entirely before it, and
  // this one joins *its* lease, or entirely after, and joins this one. Its own
  // rewrite is then the same payload with the same leaseId — idempotent.
  const existing = launchFenceLeases.get(file);
  const leaseId = existing?.leaseId ?? randomUUID();
  launchFenceLeases.set(file, { leaseId, holders: (existing?.holders ?? 0) + 1 });
  /**
   * Undo this acquisition's reservation, leaving any concurrent one intact.
   *
   * Dropping the last holder also takes the file down. The reservation is taken
   * before the write, so the last holder can be one whose own write failed
   * while an earlier holder had already published the file and released —
   * leaving a fence naming a live pid with nobody behind it, which refuses
   * every durable launch for the rest of the process's life and which the stale
   * sweep will not touch (it only clears dead owners).
   */
  const dropReservation = async (): Promise<void> => {
    const lease = launchFenceLeases.get(file);
    if (!lease || lease.leaseId !== leaseId) return;
    if (lease.holders > 1) {
      // Somebody else is still inside their window; the file stays up.
      launchFenceLeases.set(file, { leaseId, holders: lease.holders - 1 });
      return;
    }
    launchFenceLeases.delete(file);
    await queueLaunchFenceDiskWork(file, () => removeOwnedLaunchFenceFile(file, leaseId));
  };
  try {
    await queueLaunchFenceDiskWork(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Every acquisition rewrites, including a nested one: the file may have
      // been swept away underneath us, and rewriting with the *same* leaseId
      // keeps the holders that are already counted able to release it.
      await writeAtomicJson(file, {
        version: 1,
        hostPid: process.pid,
        hostStartTimeSec: ownProcessStartTimeSec(),
        leaseId,
        createdAt: Date.now(),
      } satisfies PiSubagentLaunchFence);
    });
  } catch (error) {
    // Balance the reservation before the caller ever hears about the failure,
    // or a failed acquire would pin the fence up for the process's life. A
    // concurrent holder that incremented in between keeps its count: this only
    // takes back the one increment it made.
    await dropReservation();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const lease = launchFenceLeases.get(file);
    if (lease && lease.leaseId === leaseId) {
      if (lease.holders > 1) {
        // Another boundary is still inside its window; the fence stays up.
        launchFenceLeases.set(file, { leaseId, holders: lease.holders - 1 });
        return;
      }
      launchFenceLeases.delete(file);
    }
    await queueLaunchFenceDiskWork(file, () => removeOwnedLaunchFenceFile(file, leaseId));
  };
}

/**
 * Remove a fence file this lease owns, and only that.
 *
 * Shared by the release closure and by the reservation rollback so the two can
 * never drift: someone else's fence (a `leaseId` that is not ours) is not ours
 * to drop, and a pre-`leaseId` file has no owner to compare against and keeps
 * the old unconditional delete, which is what an upgrade in place leaves.
 *
 * Always called through `queueLaunchFenceDiskWork`, which is what makes the
 * read and the delete indivisible against a concurrent publish.
 */
async function removeOwnedLaunchFenceFile(file: string, leaseId: string): Promise<void> {
  const onDisk = readLaunchFence(file);
  if (onDisk?.leaseId !== undefined && onDisk.leaseId !== leaseId) return;
  await removeLaunchFenceFile(file);
}

/**
 * How long to keep trying to unlink a fence file that is momentarily locked.
 *
 * Windows hands back EPERM/EACCES/EBUSY while a virus scanner or a runner that
 * is mid-read still has the file open; those clear well inside a second. Same
 * shape and the same reasoning as the runner's rename retry: ten attempts on a
 * 25ms step capped at 100ms, so the whole budget is under a second and a
 * genuinely stuck file does not hold a boundary open.
 */
const FENCE_UNLINK_RETRY_ATTEMPTS = 10;
const FENCE_UNLINK_RETRY_STEP_MS = 25;
const FENCE_UNLINK_RETRY_MAX_MS = 100;

/**
 * Delete a fence file, riding out a transient lock.
 *
 * The single deletion point for every caller (release, the reservation
 * rollback, and the stale sweep), because swallowing a lock is not harmless
 * here: the in-memory lease is already gone, so the file left behind names a
 * *live* pid with nobody holding it — every durable launch this process makes
 * is then refused as "restarting", and the stale sweep will not clean it either
 * because it only clears dead owners.
 *
 * Still silent when the retries run out, and there is no logger on this path.
 * The residue is the same one described above, and it is self-healing rather
 * than permanent: the next acquire on this path rewrites the file with its own
 * lease, and that holder's release deletes it.
 */
async function removeLaunchFenceFile(file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(file, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // `force` already treats a missing file as success; belt and braces.
      if (code === 'ENOENT') return;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= FENCE_UNLINK_RETRY_ATTEMPTS - 1) return;
      await new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          Math.min(FENCE_UNLINK_RETRY_MAX_MS, FENCE_UNLINK_RETRY_STEP_MS * (attempt + 1)),
        );
      });
    }
  }
}

/**
 * Drop a fence left behind by a process that is gone — the ordinary case after
 * an update relaunch, where the fence was raised by the host we replaced. A
 * fence owned by a live process (another instance mid-relaunch) is left alone.
 *
 * Each file's judge-and-delete goes through that file's serialisation chain.
 * The earlier reading — that this could never reach a file *this* process
 * publishes — does not survive pid reuse: the OS hands our pid to us, this sweep
 * finds `.launch-fence-<our pid>.json` written by the previous incarnation,
 * correctly calls it stale, and its unlink sits in the event loop while a quit
 * or account boundary publishes a new fence on the very same path. The stale
 * unlink then removes the *new* fence, and the boundary believes a door is
 * closed that is standing open.
 *
 * Ownership is therefore re-read inside the chain. The pass before it only
 * narrows the candidates; a verdict formed outside the chain is a verdict on
 * data that may already be stale by the time the delete runs.
 */
export async function clearStalePiSubagentLaunchFence(agentHome: string): Promise<void> {
  const runsRoot = piSubagentRunsRoot(agentHome);
  let entries: string[];
  try {
    entries = await fs.readdir(runsRoot);
  } catch {
    return;
  }
  const fences = entries.filter((entry) => (
    entry === PI_SUBAGENT_LAUNCH_FENCE_FILENAME
    || (entry.startsWith(PI_SUBAGENT_LAUNCH_FENCE_PREFIX)
      && entry.endsWith(PI_SUBAGENT_LAUNCH_FENCE_SUFFIX))
  ));
  // One chain per path, so the scan still runs the files concurrently: two
  // different fences never share a chain and cannot block each other.
  await Promise.all(fences.map(async (entry) => {
    const file = path.join(runsRoot, entry);
    await queueLaunchFenceDiskWork(file, async () => {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch (error) {
        // ENOENT: somebody else already cleared it, nothing to do. Anything else
        // is a transient read failure, and a fence we cannot read is one we must
        // not delete either — a launcher now obeys it, so removing it on a
        // sharing conflict would open the window the owner is still holding shut.
        // The next sweep tries again.
        return;
      }
      let fence: PiSubagentLaunchFence | null;
      try {
        fence = parseLaunchFence(JSON.parse(content));
      } catch {
        // Readable and malformed. No atomic writer publishes that, so it names no
        // owner — and it is the one case that must still be removed: the launch
        // check now treats an unparseable file as a fence, so leaving it would
        // block this host's durable launches for good.
        await removeLaunchFenceFile(file);
        return;
      }
      // A live owner is an instance genuinely mid-relaunch; leave it alone —
      // unless the live process at that pid started at a different time than the
      // fence records, which means the pid was recycled and this file is a
      // previous life's leftover. An unreadable start time stays conservative.
      if (fence && isProcessAlive(fence.hostPid) !== false) {
        if (fence.hostStartTimeSec === undefined) return;
        const startTimeSec = fence.hostPid === process.pid
          ? ownProcessStartTimeSec()
          : probeProcessStartTimeSec(fence.hostPid, Date.now());
        if (startTimeSec === null) return;
        if (Math.abs(startTimeSec - fence.hostStartTimeSec) <= OWNER_START_TIME_TOLERANCE_SEC) return;
      }
      await removeLaunchFenceFile(file);
    });
  }));
}

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
function posixPsArgs(pid: number): string[] {
  return ['-ww', '-p', String(pid), '-o', 'args='];
}

type CommandLineProbe =
  | { status: 'unreadable' }
  | { status: 'text'; text: string };

function commandLineFromStdout(stdout: unknown): CommandLineProbe {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  return text.length > 0 ? { status: 'text', text } : { status: 'unreadable' };
}

function readLinuxCmdline(pid: number): CommandLineProbe | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const text = raw.toString('utf8').replace(/\0/g, ' ').trim();
    return text.length > 0 ? { status: 'text', text } : { status: 'unreadable' };
  } catch {
    return null;
  }
}

function readProcessCommandLine(pid: number): CommandLineProbe {
  if (process.platform === 'linux') {
    const fromProc = readLinuxCmdline(pid);
    if (fromProc) return fromProc;
  }
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
      : spawnSync('ps', posixPsArgs(pid), {
          encoding: 'utf8',
          timeout: 5_000,
        });
    if (probe.error || probe.status !== 0) return { status: 'unreadable' };
    return commandLineFromStdout(probe.stdout);
  } catch {
    return { status: 'unreadable' };
  }
}

const execFileAsync = promisify(execFile);

/**
 * Non-blocking twin of `readProcessCommandLine`, for the reclaim path.
 *
 * `spawnSync` blocks the event loop, so reclaiming several runners with it is
 * strictly serial no matter how the callers are composed — the exact opposite of
 * what a bounded quit needs. The timeout is a second rather than five: a process
 * probe that has not answered by then is not going to rescue a quit budget, and
 * an unanswered probe is already handled conservatively (`unverifiable` never
 * claims a reclaim). The synchronous version keeps its longer timeout, because
 * its callers (stale detection on the force-quit path) treat a failed probe as
 * evidence rather than as "unknown".
 */
const KILL_PROBE_TIMEOUT_MS = 1_000;

async function readProcessCommandLineAsync(pid: number): Promise<CommandLineProbe> {
  if (process.platform === 'linux') {
    const fromProc = readLinuxCmdline(pid);
    if (fromProc) return fromProc;
  }
  try {
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
          { encoding: 'utf8', timeout: KILL_PROBE_TIMEOUT_MS, windowsHide: true },
        )
      : await execFileAsync('ps', posixPsArgs(pid), {
          encoding: 'utf8',
          timeout: KILL_PROBE_TIMEOUT_MS,
        });
    return commandLineFromStdout(stdout);
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * What is at `status.runnerPid` right now?
 *
 * - `gone` — no live process, or the pid now runs something else. Either way
 *   the recorded runner is finished; a replacement process is not ours to touch.
 * - `running` — the live process's command line still carries the generated
 *   runner script, whose path contains the run's UUID directory.
 * - `unverifiable` — the pid is live but the command line could not be read (or
 *   the record predates `runnerScript`). Nothing may be concluded from it.
 */
type PiSubagentRunnerPresence = 'gone' | 'running' | 'unverifiable';

/**
 * Is the process at `status.runnerPid` really this run's runner?
 *
 * The proof is the generated runner script path, which contains the run's UUID
 * directory — a recycled pid running something else cannot match it. Anything
 * we cannot establish (no recorded path, no readable command line, no match)
 * answers false, because the caller's next step is SIGKILL.
 */
function classifyRunnerCommandLine(
  commandLine: string,
  script: string,
): PiSubagentRunnerPresence {
  // A readable listing is complete enough to decide. The proof is this run's
  // generated script path (UUID directory). Another Subagent utility process
  // at a recycled pid also contains `piSubagentRunnerProcess`, but not *this*
  // script — that is gone, not unverifiable. Unreadable probes stay unknown.
  return commandLine.includes(script) ? 'running' : 'gone';
}

function classifyCommandLineProbe(
  probe: CommandLineProbe,
  script: string,
): PiSubagentRunnerPresence {
  if (probe.status === 'unreadable') return 'unverifiable';
  return classifyRunnerCommandLine(probe.text, script);
}

function resolveUnreadablePresence(pid: number): PiSubagentRunnerPresence {
  // ps/CIM/empty output is also what a pid looks like after it exits between
  // the liveness check and the listing. Recheck before treating that as a live
  // process we cannot identify.
  return isProcessAlive(pid) === false ? 'gone' : 'unverifiable';
}

export function verifyPiSubagentRunnerIdentity(status: PiSubagentRunStatus): boolean {
  const pid = status.runnerPid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return false;
  const script = status.runnerScript;
  if (typeof script !== 'string' || script.length === 0) return false;
  return classifyCommandLineProbe(readProcessCommandLine(pid!), script) === 'running';
}

/**
 * Synchronous mirror of `classifyRunnerPresence`.
 *
 * Liveness is checked before the command line so a dead pid never costs a spawn
 * and never depends on a probe that a dead process cannot answer.
 *
 * Same three answers from the same evidence, in the same order — the only
 * difference is the blocking probe, which the callers on the synchronous
 * force-quit and list paths have no way around. A cross-check test pins the two
 * against each other so they cannot drift into disagreeing about a process.
 */
function classifyRunnerPresenceSync(status: PiSubagentRunStatus): PiSubagentRunnerPresence {
  const pid = status.runnerPid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return 'gone';
  if (isProcessAlive(pid!) === false) return 'gone';
  const script = status.runnerScript;
  if (typeof script !== 'string' || script.length === 0) return 'unverifiable';
  const classified = classifyCommandLineProbe(readProcessCommandLine(pid!), script);
  return classified === 'unverifiable' ? resolveUnreadablePresence(pid!) : classified;
}

async function classifyRunnerPresence(status: PiSubagentRunStatus): Promise<PiSubagentRunnerPresence> {
  const pid = status.runnerPid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) return 'gone';
  // Free, and it settles the common case without spawning anything.
  if (isProcessAlive(pid!) === false) return 'gone';
  const script = status.runnerScript;
  if (typeof script !== 'string' || script.length === 0) return 'unverifiable';
  const classified = classifyCommandLineProbe(await readProcessCommandLineAsync(pid!), script);
  return classified === 'unverifiable' ? resolveUnreadablePresence(pid!) : classified;
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
 * The live runner must receive SIGTERM first so it can reap the Pi children it
 * spawned. Utility-process runners are not process-group leaders; signalling
 * `-pid` would miss those children and, on a shared group, could hit Cindy.
 * Windows `taskkill /T` already walks the process tree.
 *
 * Success is *exit confirmation*, never "the signal was sent": `taskkill` fails
 * by exit status rather than by throwing, and a caller that reports reclaimed
 * runners it never reclaimed lets an account switch proceed with the outgoing
 * account's BYOM credentials still in use.
 */
export async function killVerifiedPiSubagentRunner(status: PiSubagentRunStatus): Promise<boolean> {
  // "Cannot verify" is not one answer but three, and collapsing them into a
  // failure is what let an already-finished runner block an account switch: the
  // stale check had cached "still the runner", the runner then exited on its
  // own, and this refused to report a reclaim for a process that no longer
  // existed. Nothing to reclaim *is* a reclaim.
  const presence = await classifyRunnerPresence(status);
  if (presence === 'gone') return true;
  // Unverifiable and still live: we may not signal a pid we cannot prove is
  // ours, and we may not claim it was reclaimed either.
  if (presence === 'unverifiable') return false;
  const pid = status.runnerPid!;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5_000,
    });
    // taskkill reports failure through its exit status. A follow-up SIGKILL
    // is what lets the confirmation loop observe a pid that actually died.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone, or unreachable */ }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone, or unreachable */ }
  }
  // Confirm by re-verifying identity rather than `kill(pid, 0)`: a zombie still
  // "exists" for `kill(pid, 0)` and would be reported as unreclaimed forever,
  // while its command line no longer carries the runner script. The same
  // predicate also covers a recycled pid and, on Windows, a dead pid (the CIM
  // query returns nothing) — one cross-platform judgement for "that runner is
  // no longer running". Each attempt costs a `ps`/CIM spawn, so keep it short.
  if (await waitUntilRunnerGone(status)) return true;
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone, or unreachable */ }
    return waitUntilRunnerGone(status);
  }
  return false;
}

async function waitUntilRunnerGone(status: PiSubagentRunStatus): Promise<boolean> {
  for (let attempt = 0; attempt < KILL_CONFIRM_ATTEMPTS; attempt += 1) {
    if (await classifyRunnerPresence(status) === 'gone') return true;
    if (attempt === KILL_CONFIRM_ATTEMPTS - 1) break;
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_CONFIRM_INTERVAL_MS));
  }
  return await classifyRunnerPresence(status) === 'gone';
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
  // The start time may only be stamped for *this* process, because it is the
  // only one whose start time we can read without a probe. Minting an id for
  // another pid (tests, tooling) must fall back to the legacy two-part shape:
  // stamping our own start time onto someone else's pid would assert a start
  // identity that is simply false, and the liveness comparison against it then
  // succeeds or fails on nothing but how close the two processes launched —
  // a live foreign owner reads as an orphan the moment the gap exceeds the
  // tolerance. A legacy id has no start time, so liveness stays conservative.
  return hostPid === process.pid
    ? `${hostPid}.${ownProcessStartTimeSec()}:${scopeId}`
    : `${hostPid}:${scopeId}`;
}

/** Wall-clock second this process started, in the form the owner id records. */
function ownProcessStartTimeSec(): number {
  return Math.round(Date.now() / 1000 - process.uptime());
}

export interface PiSubagentOwnerIdentity {
  pid: number;
  /** Absent on ids written before the start time was recorded. */
  startTimeSec?: number;
}

/**
 * Host process encoded by `piSubagentRuntimeOwnerId`, or null when the id
 * carries none.
 *
 * Accepts both shapes: `<pid>:<scope>` (legacy) and `<pid>.<startSec>:<scope>`.
 * The scope half is never parsed, so an id minted by a newer build stays a
 * plain opaque string for the runner and the in-Pi extension — only the Host
 * ever splits it, which is what makes the extra segment wire-compatible.
 */
export function piSubagentOwnerIdentity(
  runtimeOwnerId: string | undefined,
): PiSubagentOwnerIdentity | null {
  if (typeof runtimeOwnerId !== 'string' || runtimeOwnerId.length === 0) return null;
  const separator = runtimeOwnerId.indexOf(':');
  if (separator <= 0) return null;
  const host = runtimeOwnerId.slice(0, separator);
  const dot = host.indexOf('.');
  const pid = Number(dot < 0 ? host : host.slice(0, dot));
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (dot < 0) return { pid };
  const startTimeSec = Number(host.slice(dot + 1));
  return Number.isSafeInteger(startTimeSec) && startTimeSec > 0 ? { pid, startTimeSec } : { pid };
}

/** Host pid encoded by `piSubagentRuntimeOwnerId`, or null for a legacy/absent id. */
export function piSubagentOwnerHostPid(runtimeOwnerId: string | undefined): number | null {
  return piSubagentOwnerIdentity(runtimeOwnerId)?.pid ?? null;
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
  const identity = piSubagentOwnerIdentity(status.runtimeOwnerId);
  // Missing or legacy prefix-less owner id: cannot attribute, stay controllable.
  if (identity === null) return 'unattributable';
  // A pid equal to ours still has to prove it is *this* incarnation: after a
  // crash and restart the OS can hand us the pid of the instance that left the
  // run behind, and that run is an orphan, not ours.
  if (identity.pid === hostPid && isOwnerInstanceAlive(identity)) return 'self';
  // Unknown liveness counts as live: refusing is recoverable (the user is told
  // which window owns it), silently steering someone else's run is not.
  return isOwnerInstanceAlive(identity) ? 'foreign-live' : 'orphaned';
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

function isSweepableByHost(
  status: PiSubagentRunStatus | undefined,
  hostPid: number,
  memo?: ProcessStartTimeMemo,
): boolean {
  const identity = piSubagentOwnerIdentity(status?.runtimeOwnerId);
  if (identity === null) return true;
  if (identity.pid === hostPid) return true;
  // A dead owner process leaves an orphan runner that nobody will ever stop.
  // "Dead" includes a pid that is live but belongs to a *different* process
  // than the one that minted the id (recycled pid).
  return !isOwnerInstanceAlive(identity, memo);
}

/**
 * Elapsed-time text from `ps -o etime=` as seconds, or null when unparsable.
 *
 * `[[dd-]hh:]mm:ss` is the one format every ps agrees on — `etimes` (plain
 * seconds) is a procps extension that macOS does not have.
 */
function parseElapsedSeconds(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const dash = trimmed.indexOf('-');
  const days = dash > 0 ? Number(trimmed.slice(0, dash)) : 0;
  const parts = (dash > 0 ? trimmed.slice(dash + 1) : trimmed).split(':').map(Number);
  if (!Number.isFinite(days) || days < 0) return null;
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0]!, parts[1]!];
  return days * 86_400 + hours! * 3_600 + minutes! * 60 + seconds!;
}

/** Start second of the live process at `pid`, or null when it cannot be read. */
function probeProcessStartTimeSec(pid: number, now: number): number | null {
  try {
    if (process.platform === 'win32') {
      // Get-Process StartTime is the reliable Windows identity; Win32_Process
      // CreationDate via CIM is often empty or unparsable on CI runners, which
      // made a live-but-foreign claim look like a still-held one (probe null →
      // conservative "alive").
      const probe = spawnSync(
        'powershell.exe',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `[int64]((Get-Process -Id ${pid}).StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds`,
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      );
      if (probe.error || probe.status !== 0) return null;
      const match = (typeof probe.stdout === 'string' ? probe.stdout : '').match(/-?\d+/);
      const seconds = match ? Number(match[0]) : NaN;
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
    }
    const probe = spawnSync('ps', ['-p', String(pid), '-o', 'etime='], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (probe.error || probe.status !== 0) return null;
    const elapsed = parseElapsedSeconds(typeof probe.stdout === 'string' ? probe.stdout : '');
    return elapsed === null ? null : Math.round(now / 1_000 - elapsed);
  } catch {
    return null;
  }
}

/**
 * Per-sweep memo for the start-time probe, passed down rather than held.
 *
 * The reason for memoising at all is that one sweep asks the same question once
 * per run directory and each miss is a `ps`/CIM spawn — a scope that ends with
 * the sweep covers exactly that. A process-wide cache with a TTL does not: a pid
 * that dies and is recycled inside the TTL keeps answering with the *dead*
 * owner's start time, which is precisely the value the recorded id was minted
 * with, so the orphan reads as "another live instance" and is skipped. Time
 * cannot detect reuse; only a fresh probe can, and a sweep-scoped memo is the
 * largest window in which reuse is not observable anyway.
 */
type ProcessStartTimeMemo = Map<number, number | null>;

function readProcessStartTimeSec(pid: number, memo?: ProcessStartTimeMemo): number | null {
  const cached = memo?.get(pid);
  if (cached !== undefined) return cached;
  const startTimeSec = probeProcessStartTimeSec(pid, Date.now());
  memo?.set(pid, startTimeSec);
  return startTimeSec;
}

/** `ps` rounds to the second and samples after we read the clock. */
const OWNER_START_TIME_TOLERANCE_SEC = 5;

/**
 * Is the *instance* that minted this owner id still running?
 *
 * A pid alone cannot answer that. Pids are recycled, and a recycled one makes a
 * crashed instance's orphan read as "owned by another live instance" — which
 * the sweep then skips forever and the user cannot stop from the UI, while the
 * runner spends the BYOM credentials it inherited until its run timeout.
 * Comparing the recorded process start time settles it.
 *
 * Conservative in exactly one direction: anything we cannot disprove counts as
 * alive (legacy id without a start time, unreadable probe). Killing a live
 * instance's Subagent is unrecoverable; leaving an orphan is bounded by the run
 * timeout and still reachable through the diagnostics path.
 */
function isOwnerInstanceAlive(
  identity: PiSubagentOwnerIdentity,
  memo?: ProcessStartTimeMemo,
): boolean {
  if (isProcessAlive(identity.pid) === false) return false;
  if (identity.startTimeSec === undefined) return true;
  const startTimeSec = identity.pid === process.pid
    ? ownProcessStartTimeSec()
    : readProcessStartTimeSec(identity.pid, memo);
  if (startTimeSec === null) return true;
  return Math.abs(startTimeSec - identity.startTimeSec) <= OWNER_START_TIME_TOLERANCE_SEC;
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

/**
 * Identity memo for the stale check, keyed by the pair it proves.
 *
 * Same shape and TTL as the owner start-time memo: the check only runs for runs
 * whose heartbeat already expired, but a wedged run stays in that state and the
 * panel polls the list once a second.
 */
const RUNNER_IDENTITY_TTL_MS = 10_000;
const RUNNER_IDENTITY_CACHE_MAX = 64;
const runnerIdentityCache = new Map<string, { at: number; presence: PiSubagentRunnerPresence }>();

function runnerPresenceForStale(status: PiSubagentRunStatus): PiSubagentRunnerPresence {
  const key = `${status.runnerPid}:${status.runnerScript}`;
  const now = Date.now();
  // Liveness ahead of the memo, so a cached "still the runner" can never
  // outlive the runner itself. Belt and braces today — the only caller,
  // `isPiSubagentRunStale`, already refuses a dead pid before it gets here — but
  // the memo must not be a trap for the next caller: a cached true that
  // outlived its process is what makes a sweep count work that is already over.
  // A signal-0 syscall, no spawn, and only on the expired-heartbeat path.
  if (isProcessAlive(status.runnerPid) === false) {
    runnerIdentityCache.set(key, { at: now, presence: 'gone' });
    return 'gone';
  }
  const cached = runnerIdentityCache.get(key);
  if (cached && now - cached.at < RUNNER_IDENTITY_TTL_MS) return cached.presence;
  const presence = classifyRunnerPresenceSync(status);
  runnerIdentityCache.set(key, { at: now, presence });
  if (runnerIdentityCache.size > RUNNER_IDENTITY_CACHE_MAX) {
    for (const [entryKey, entry] of runnerIdentityCache) {
      if (now - entry.at >= RUNNER_IDENTITY_TTL_MS) runnerIdentityCache.delete(entryKey);
    }
  }
  return presence;
}

export function isPiSubagentRunStale(
  status: PiSubagentRunStatus,
  now = Date.now(),
): boolean {
  if (isPiSubagentTerminal(status.state)) return false;
  // Hot path: this runs for every run on every list read (the panel polls once
  // a second). A live heartbeat is proof enough — never probe here.
  if (now - status.updatedAt <= STALE_HEARTBEAT_MS) return false;
  // A launch that published queued but has not written runnerPid yet is still
  // the in-process launcher copying runtime files. That can take longer than
  // the heartbeat. Treating it as stale hides it from fence sweeps, which then
  // exit while the already-admitted launcher can still spawn. Only the owner
  // process going away makes this an abandoned launch.
  if (
    status.state === 'queued'
    && status.runnerInstanceId.startsWith('launch-pending-')
    && !Number.isSafeInteger(status.runnerPid)
  ) {
    const identity = piSubagentOwnerIdentity(status.runtimeOwnerId);
    if (identity !== null && isOwnerInstanceAlive(identity)) return false;
  }
  // The heartbeat expired but the pid may be live. Three answers, not two:
  //
  //  - `gone`: no process, or the pid now runs something else. Stale — a
  //    recycled pid would otherwise make the record read as running forever,
  //    route controls to a process that never consumes them, and deadlock the
  //    account boundary (the kill correctly refuses to signal the replacement,
  //    so `killedAll` never becomes true).
  //  - `running`: still that runner, just quiet. Active.
  //  - `unverifiable`: the pid is live but the command line could not be read,
  //    or the record predates `runnerScript`. **Active**, because the opposite
  //    is far worse: calling a live runner stale hides it from the sweep, which
  //    then reports success it did not achieve, and makes parent-task deletion
  //    remove the metadata of a run that is still going. A false "active" only
  //    costs an honest failure at the boundary — the kill path answers
  //    `unverifiable` with a refusal too, so the two stay consistent.
  return runnerPresenceForStale(status) === 'gone';
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

/**
 * Every UUID run directory under `root`, readable status or not.
 *
 * The honest denominator for "is this run still there?": `listPiSubagentRuns`
 * omits anything it cannot parse, so a caller that only has that list cannot
 * tell a removed run from one whose status.json is momentarily unreadable.
 */
export async function listPiSubagentRunDirectoryIds(root: string): Promise<string[]> {
  return listRunDirectoryIds(root);
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
  // Set whenever the sentence below is *ours*, not runtime output we forwarded.
  // The English text stays in `content` for older clients; a current renderer
  // localizes from this instead. See `SubagentTranscriptEntry.systemEvent`.
  let systemEvent: SubagentTranscriptEntry['systemEvent'];
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
      if (action === 'stop') {
        content = 'A stop was requested from the parent task.';
        systemEvent = { kind: 'stop-requested' };
      } else {
        content = 'A control request was sent from the parent task.';
        systemEvent = { kind: 'control-requested' };
      }
    }
  } else if (record.type === 'cindy.subagent.stderr') {
    content = typeof record.text === 'string' ? record.text : '';
  } else if (record.type === 'cindy.subagent.stdout') {
    content = typeof record.line === 'string' ? record.line : '';
  } else if (record.type === 'cindy.subagent.control_error') {
    content = typeof record.message === 'string' ? record.message : '';
  } else if (record.type === 'cindy.subagent.transcript_truncated') {
    content = 'Transcript storage limit reached.';
    systemEvent = { kind: 'transcript-truncated' };
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
      systemEvent = { kind: 'turn-ended' };
    } else if (event.type === 'response' && event.success === false) {
      // A harness-supplied reason is the harness's own text, not ours to
      // localize; only the fallback sentence gets a slug.
      if (typeof event.error === 'string' && event.error) {
        content = event.error;
      } else {
        content = 'PI rejected a child command.';
        systemEvent = { kind: 'command-refused' };
      }
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
    ...(systemEvent ? { systemEvent } : {}),
  };
}

/**
 * Locate a cursor within the generation list.
 *
 * The cursor already carried `runId`, so it addresses a generation as well as a
 * byte offset without any change to its shape: a cursor minted by an older Host
 * for a single-generation run still resolves here, and one minted here is still
 * a plain offset cursor to an older Host.
 *
 * A generation that is no longer listed — evicted from the caller's rolling
 * window — is rejected exactly as an unrelated run id always was.
 */
function decodeTranscriptCursor(
  raw: string | undefined,
  generations: readonly string[],
): { index: number; offset: number } {
  if (!raw) return { index: 0, offset: 0 };
  if (raw.length > 512) throw new Error('invalid PI Subagent transcript cursor');
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as TranscriptCursor;
    const index = generations.indexOf(value.runId);
    if (
      value.version !== 1
      || index < 0
      || !Number.isSafeInteger(value.offset)
      || value.offset < 0
      || value.offset > MAX_TRANSCRIPT_BYTES
    ) throw new Error('invalid');
    return { index, offset: value.offset };
  } catch {
    throw new Error('invalid PI Subagent transcript cursor');
  }
}

function encodeTranscriptCursor(runId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, runId, offset } satisfies TranscriptCursor), 'utf8')
    .toString('base64url');
}

/**
 * Open one generation's transcript, or report why it cannot be read.
 *
 * `unsupported` is the "no such record" answer a sole generation still returns
 * verbatim; `unreadable` is a record that exists but must not be streamed
 * (symlink, non-file, past the byte cap).
 */
async function openTranscriptGeneration(
  root: string,
  runId: string,
): Promise<
  { kind: 'ok'; file: string; size: number }
  | { kind: 'unsupported' }
  | { kind: 'unreadable'; error: Error }
> {
  const file = path.join(root, runId, 'transcript.jsonl');
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'unsupported' };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) {
    return { kind: 'unreadable', error: new Error('oversized, linked, or non-file PI Subagent transcript') };
  }
  return { kind: 'ok', file, size: stat.size };
}

/**
 * Read a bounded chronological page without trusting transcript paths from
 * status.json.
 *
 * `runId` may be a single run directory or the caller's full generation list,
 * **oldest first** — a resumed task keeps its logical identity across runs and
 * the panel shows one conversation, so paging walks the generations in order
 * and steps to the next one as each is exhausted. Reading only the newest (the
 * previous behaviour) lost the original task, its replies and its tool cards
 * the moment a follow-up created a second generation.
 *
 * Only the tail generation can still be growing: a resume is admitted solely
 * after the previous generation reached a terminal state (see
 * `claimPiSubagentResume`), so an earlier generation's EOF is final and
 * stepping past it cannot skip a line that arrives later. Generations the
 * caller's rolling window has already evicted are simply not in the list, and
 * the transcript then starts at the oldest one that survived.
 */
export async function readPiSubagentTranscriptPage(
  root: string,
  runId: string | readonly string[],
  options: { cursor?: string; limit?: number } = {},
): Promise<SubagentTranscriptPageResponse> {
  const generations = (typeof runId === 'string' ? [runId] : [...runId])
    .filter((id) => RUN_DIR_RE.test(id));
  if (generations.length === 0) return { supported: false, entries: [] };
  const sole = generations.length === 1;
  const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.floor(options.limit)
    : 50;
  const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE_SIZE, requested));
  const position = decodeTranscriptCursor(options.cursor, generations);
  const entries: SubagentTranscriptEntry[] = [];
  // Where this page stopped. Kept as (generation, offset) rather than a global
  // sequence so a resume lands on the same byte of the same record.
  let cursorIndex = position.index;
  let cursorOffset = position.offset;
  let more = false;
  for (let index = position.index; index < generations.length; index += 1) {
    if (entries.length >= limit) {
      // Filled exactly at a generation boundary: the remainder is real.
      more = true;
      break;
    }
    const generation = generations[index]!;
    const start = index === position.index ? position.offset : 0;
    const opened = await openTranscriptGeneration(root, generation);
    if (opened.kind !== 'ok') {
      // A sole generation keeps the original answers: "no such transcript", or
      // a hard failure for a record that exists but is not safe to stream.
      if (sole) {
        if (opened.kind === 'unsupported') return { supported: false, entries: [] };
        throw opened.error;
      }
      // One damaged generation must not cost the user the others. Mark the gap
      // where it belongs in the timeline and carry on. The marker's id is
      // stable, so a page that resumes here merges instead of duplicating.
      entries.push({
        id: `${generation}:0`,
        sequence: 0,
        role: 'system',
        content: 'An earlier part of this conversation could not be read.',
        occurredAt: 0,
        systemEvent: { kind: 'generation-unreadable' },
      });
      // Point past this generation, not at it. The marker *is* this
      // generation's whole contribution — there is nothing left in it to read —
      // so a cursor still naming it means the next page re-emits the same
      // marker and gets no further. That only shows when the marker lands on
      // the page bound, which `limit: 1` hits every time: the reader then
      // repeated one placeholder for ever and never reached the resumed
      // generations behind it.
      //
      // With no next generation there is nothing to point at; the loop is about
      // to end and `more` stays false, so the page correctly reads as EOF.
      cursorIndex = index + 1 < generations.length ? index + 1 : index;
      cursorOffset = 0;
      continue;
    }
    if (start > opened.size) throw new Error('PI Subagent transcript cursor exceeds file size');
    let offset = start;
    const input = createReadStream(opened.file, { encoding: 'utf8', start });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const lineOffset = offset;
        offset += Buffer.byteLength(line, 'utf8') + 1;
        const entry = transcriptEntry(generation, lineOffset, line);
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
    cursorIndex = index;
    cursorOffset = offset;
    if (offset < opened.size) {
      more = true;
      break;
    }
    // Exhausted this generation. The cursor stays on its EOF rather than
    // jumping to the next one's zero: for the newest generation that is exactly
    // the tail a change event resumes from, and for an older one the next read
    // finds EOF immediately and steps forward on its own.
    if (entries.length >= limit && index < generations.length - 1) {
      more = true;
      break;
    }
  }
  // `tailCursor` is returned even at EOF, where `nextCursor` is deliberately
  // absent: the renderer keeps it to resume from the byte it stopped at and
  // append only newly written lines, instead of re-reading a record that may
  // grow to the 50MB cap while a long-lived child keeps running.
  const tailCursor = encodeTranscriptCursor(generations[cursorIndex]!, cursorOffset);
  return {
    supported: true,
    entries,
    ...(more ? { nextCursor: tailCursor } : {}),
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
    /**
     * Consulted immediately before each run's mailbox write, after every await
     * this function makes. `false` skips that write and reports no delivery.
     *
     * A caller that checked a fence *before* calling this had already lost the
     * window: discovery and the directory guard below are several awaits long,
     * and an account teardown can start and finish its stop sweep inside them —
     * after which an `allow` still lands, and the child may act on it with the
     * outgoing account's credentials. The check has to sit next to the write.
     */
    beforeMailboxWrite?: () => boolean;
    /** Fired once every mailbox write has settled, before the receipt wait. */
    onMailboxWritesSettled?: () => void;
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
  // Two phases, so "the mailbox is written" is observable separately from "the
  // runner acknowledged". A teardown has to wait for the first — a bounded fs
  // write — and must not be held up by the second, which waits on the runner.
  const written = await Promise.all(runs.map(async (run) => {
    if (options.beforeMailboxWrite && !options.beforeMailboxWrite()) return null;
    return { run, request: await writeRunControl(root, run.runId, action, options) };
  }));
  options.onMailboxWritesSettled?.();
  const outcomes = await Promise.all(written.map(async (entry) => {
    if (!entry) return false;
    // A status without a live runner identity is disk metadata, not proof that
    // anyone can consume the mailbox. Keep the request for diagnosis but do
    // not report successful delivery.
    if (isProcessAlive(entry.run.runnerPid) !== true) return false;
    return waitForControlReceipt(root, entry.run.runId, entry.request.receiptFile);
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
  launchRunner: (request: {
    runId: string;
    runDir: string;
    runnerFile: string;
    configFile: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>;
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
  /**
   * Start second of the holder process. Same reason as the owner id carries
   * one: a recycled pid would otherwise keep a dead holder's claim alive
   * forever and wedge resume. Absent on claims written by older builds.
   */
  hostStartTimeSec?: number;
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
    ...(Number.isSafeInteger(raw.hostStartTimeSec) && (raw.hostStartTimeSec as number) > 0
      ? { hostStartTimeSec: raw.hostStartTimeSec as number }
      : {}),
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
    hostStartTimeSec: ownProcessStartTimeSec(),
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
    // Same judgement as run ownership: a live pid only proves a live holder
    // when it is still the process that wrote the claim.
    if (holder && isOwnerInstanceAlive({
      pid: holder.hostPid,
      ...(holder.hostStartTimeSec !== undefined ? { startTimeSec: holder.hostStartTimeSec } : {}),
    })) {
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

/** Launch/stop gave up waiting for exit; disk must stay non-terminal so sweep can still signal. */
export class PiSubagentRunnerExitUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSubagentRunnerExitUnconfirmedError';
  }
}

/** Host saw the runner exit even if status.json could not be persisted. */
export class PiSubagentRunnerHostExitedError extends Error {
  readonly runnerExited = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PiSubagentRunnerHostExitedError';
  }
}

/** Persist a host-observed runner failure without overwriting a real terminal result. */
export async function recordPiSubagentRunnerFailure(
  runDir: string,
  message: string,
): Promise<void> {
  const runId = path.basename(runDir);
  if (!RUN_DIR_RE.test(runId)) return;
  const [configValue, statusValue] = await Promise.all([
    readSmallJson(path.join(runDir, 'config.json')).catch(() => null),
    readSmallJson(path.join(runDir, 'status.json')).catch(() => null),
  ]);
  if (!isResumeConfig(configValue, runId)) return;
  const current = parseStatus(statusValue, runId);
  if (current && isPiSubagentTerminal(current.state)) return;

  const now = Date.now();
  const error = message.slice(0, 4_000);
  await writeAtomicJson(path.join(runDir, 'status.json'), {
    version: 1,
    runId,
    taskId: configValue.taskId,
    parentSessionId: configValue.parentSessionId,
    runtimeOwnerId: configValue.runtimeOwnerId,
    runnerInstanceId: `launch-error-${runId}`,
    state: 'failed',
    title: configValue.title,
    description: configValue.description,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
    endedAt: now,
    tasks: configValue.tasks.map((task) => {
      const previous = current?.tasks.find((candidate) => candidate.childId === task.childId);
      const taskAlreadyTerminal = previous
        && (previous.status === 'completed' || previous.status === 'failed' || previous.status === 'stopped');
      return {
        ...(previous ?? {}),
        childId: task.childId,
        sessionId: task.sessionId,
        agent: task.agent,
        title: task.title,
        status: taskAlreadyTerminal ? previous.status : 'failed',
        ...(!taskAlreadyTerminal ? { error } : {}),
        endedAt: previous?.endedAt ?? now,
      };
    }),
  });
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
  //
  // Over the *directory* set, not `listPiSubagentRuns`, which hides records it
  // cannot parse. The newest generation is exactly the one most likely to be
  // briefly unreadable — a Windows sharing conflict on a status.json that is
  // being rewritten is enough — and hiding it made this check see only the
  // previous terminal generation and let a second runner start on the same PI
  // session directories.
  //
  // Deliberately global rather than per task: an unreadable status carries no
  // taskId, so it cannot be attributed, and "not attributable to my task" is
  // exactly what we are unable to prove. Refusing the whole resume is the only
  // conservative reading. Provably dead runs (stale) do not count, so a crashed
  // generation does not wedge resume forever, and the diagnostics surface still
  // shows the user what is unreadable.
  const [claimedRuns, claimedIds, claimedDiagnostics] = await Promise.all([
    listPiSubagentRuns(root),
    listRunDirectoryIds(root),
    listPiSubagentRunDiagnostics(root),
  ]);
  if (claimedRuns.some((run) => run.taskId === source.taskId && !isPiSubagentTerminal(run.state))) {
    return null;
  }
  const claimedStale = new Set(
    claimedDiagnostics.filter((diagnostic) => diagnostic.kind === 'stale').map((d) => d.runId),
  );
  const readable = new Set(claimedRuns.map((run) => run.runId));
  const unreadable = claimedIds.filter((runId) => !readable.has(runId) && !claimedStale.has(runId));
  if (unreadable.length > 0) {
    throw new PiSubagentResumeClaimedError(
      'This Subagent has a run whose state cannot be read right now, so resuming could start a second runner on the same session. Try again shortly.',
    );
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
    // Shape only. Containment is decided by the canonical block below, which
    // resolves both sides and walks the parent chain — a textual
    // `resolve(sessionDir).startsWith(resolve(root))` test here was both weaker
    // (it does not follow symlinks, so a sessionDir symlinked out of the root
    // passed it) and wrong in the other direction: a run root reached through a
    // symlink, or through a Windows 8.3 short path, is not a textual prefix of
    // its own session paths, so a legitimate resume was rejected as an escape.
    if (typeof task.sessionDir !== 'string' || task.sessionDir.length === 0) {
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
    // Keep the original title: the sidebar renders it verbatim, so an English
    // prefix would leak into zh/ja/ko. Continuation is already the same logical
    // run (same taskId); untitled stays untitled.
    title: sourceConfig.title,
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
    // Same ordering as the in-Pi launcher, for the same reason: publish a
    // record the relaunch's scan can see, *then* read the fence. A fence check
    // before this write could be overtaken by a relaunch that raises its fence
    // and finishes scanning in the gap. See `launchDurableRun`'s comment for
    // the full argument; the rollback below is what a refusal leaves behind.
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
    const agentHome = piSubagentAgentHomeFromRunRoot(root);
    if (isPiSubagentLaunchFenceActive(agentHome, process.pid)) {
      throw new Error('Cindy is restarting for an update; retry this resume shortly.');
    }
    if (isPiSubagentDeletedTombstonePresent(agentHome, path.basename(root))) {
      throw new Error('The parent task was deleted; this resume will not start.');
    }
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
    // Staging above awaits. A sibling instance can write the tombstone in that
    // window; the queued check would already have passed. Recheck immediately
    // before spawn so a deleted parent never starts a runner. Refusal falls
    // into the rollback below.
    if (isPiSubagentLaunchFenceActive(agentHome, process.pid)) {
      throw new Error('Cindy is restarting for an update; retry this resume shortly.');
    }
    if (isPiSubagentDeletedTombstonePresent(agentHome, path.basename(root))) {
      throw new Error('The parent task was deleted; this resume will not start.');
    }
  } catch (error) {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const configFile = path.join(runDir, 'config.json');
  try {
    await launch.launchRunner({
      runId,
      runDir,
      runnerFile,
      configFile,
      cwd: sourceConfig.cwd,
      env: launch.env,
    });
  } catch (error) {
    if (!(error instanceof PiSubagentRunnerExitUnconfirmedError)) {
      const message = error instanceof Error ? error.message : String(error);
      await recordPiSubagentRunnerFailure(runDir, message).catch(() => undefined);
    }
    throw error;
  }
  return runId;
}

export async function resumePiSubagentRun(
  root: string,
  taskId: string,
  message: string,
  launch: PiSubagentResumeLaunch,
  childId?: string,
): Promise<string | null> {
  // Resume is the Host's own way of putting a new runner on disk, so it obeys
  // the same fence the in-Pi launcher does. `root` is the per-session run
  // directory; the fence lives one level up, next to every session's runs.
  const agentHome = piSubagentAgentHomeFromRunRoot(root);
  if (isPiSubagentLaunchFenceActive(agentHome, process.pid)) {
    throw new Error('Cindy is restarting for an update; retry this resume shortly.');
  }
  if (isPiSubagentDeletedTombstonePresent(agentHome, path.basename(root))) {
    throw new Error('The parent task was deleted; this resume will not start.');
  }
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
  try {
    sessionEntries = readdirSync(parentRoot, { withFileTypes: true });
  } catch (error) {
    // Only a missing directory proves there is nothing to reclaim. EACCES /
    // EPERM / a transient I/O error must not look like "no active runs", or
    // the updater proceeds to exit while an unreadable runner is still going.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
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
  /**
   * Ceiling for the whole escalation, not per runner. Reclaims run in parallel
   * (the identity probe is async, so several really do overlap), but a wedged
   * probe must not be able to push the caller past its own deadline — quit gets
   * one bounded async phase and then the process exits regardless. Anything
   * still unfinished when this expires is reported as unreclaimed, which is the
   * truth: we did not confirm it stopped.
   */
  killBudgetMs?: number;
}

/** Wide enough for a handful of runners at ~0.8s of exit confirmation each. */
const DEFAULT_KILL_BUDGET_MS = 8_000;

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
  startTimeMemo?: ProcessStartTimeMemo,
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
    if (scope.hostPid !== undefined && !isSweepableByHost(status, scope.hostPid, startTimeMemo)) continue;
    sweepable.push({ runId, status });
  }
  return sweepable;
}

/** Resolve false if `work` has not settled within `ms`, without leaking a timer. */
async function raceWithDeadline(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    // One memo per pass, discarded with it: within a single pass a pid cannot
    // meaningfully be recycled, and across passes we must see it if it was.
    const startTimeMemo: ProcessStartTimeMemo = new Map();
    let activeCount = 0;
    for (const root of roots) {
      for (const { runId } of await sweepableRunsUnderRoot(root, scope, startTimeMemo)) {
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
      const killDeadline = Date.now() + (scope.killBudgetMs ?? DEFAULT_KILL_BUDGET_MS);
      let killedAll = true;
      for (const root of roots) {
        // Re-derived, so a run whose directory vanished in the meantime is gone
        // from the set and counts as reclaimed.
        const work = await sweepableRunsUnderRoot(root, scope, startTimeMemo);
        // In parallel: each reclaim is mostly waiting on its own process probe,
        // and serialising them multiplied the worst case by the number of
        // runners — enough to overrun a quit budget with only a few of them.
        const outcomes = await Promise.all(work.map(async ({ status }) => {
          if (!status) {
            // No readable status means no runner identity to verify, and the
            // header forbids signalling a pid we cannot prove. So we cannot
            // reclaim it — but the caller must not hear that the boundary is
            // clean, or an account switch proceeds with this child still live.
            return false;
          }
          const remaining = killDeadline - Date.now();
          if (remaining <= 0) return false;
          return raceWithDeadline(killVerifiedPiSubagentRunner(status), remaining);
        }));
        if (outcomes.some((reclaimed) => !reclaimed)) killedAll = false;
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
 *
 * The wait alone was not a lifecycle. A runner that is alive but never turns its
 * event loop back to the control mailbox never sees the stop, so every attempt
 * re-posted the same message, hit the same deadline and returned false — and the
 * caller's backoff re-entered that identical loop forever. For a *deleted* task
 * that is unbounded: the child keeps spending the task's inherited credentials
 * and editing its workspace, and the durable metadata is never reclaimed.
 *
 * So this delegates to the same sweep the quit and account-boundary paths use,
 * with the same escalation contract: ask, wait out the grace, then reclaim by
 * identity-verified kill. Reusing it rather than growing a second escalation
 * here is deliberate — the rules that matter (only runs attributable to this
 * root, terminal and stale ones excluded, `unverifiable` never signalled and
 * never reported as reclaimed) are stated once, in one place.
 *
 * Deletion is the one caller that also removes the files, and it may only do so
 * on a `true`: `unverifiable` still returns false, so metadata belonging to a
 * runner we could not identify is left for the next attempt rather than blindly
 * dropped.
 */
export async function stopAndRemovePiSubagentRuns(
  root: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 6_000;
  // The grace is that budget, measured from the first stop write. A live runner
  // polls its mailbox every `CONTROL_POLL_MS` (200ms, `cindy-subagent-runner`),
  // so 6s is thirty consumption cycles: long enough that "did not answer" means
  // the loop is not coming back rather than that it was busy, and short enough
  // that a deleted task's cleanup is not left waiting on it.
  const reclaimed = await stopPiSubagentRunsUnderRoots([root], timeout, {
    killUnresponsiveRunners: true,
  });
  if (!reclaimed) return false;
  // Windows: a just-killed runner still holds cwd/open handles, so the first
  // rmdir comes back EBUSY/EPERM. Node's own retry is the same remedy the
  // test teardown uses; a throw here would leave deleted-task files behind.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return true;
}
