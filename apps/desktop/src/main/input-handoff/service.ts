import { randomUUID } from 'node:crypto';
import {
  parseInputHandoffDecision,
  parseInputHandoffSubmission,
  type InputHandoffHolder,
  type InputHandoffPicture,
  type InputHandoffSnapshot,
} from '@cindy/device-link';
import { INPUT_HANDOFF_ENDED_PREFIX } from '@cindy/maker-shared/synthetic-trigger';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import {
  InputHandoffSession,
  resolveHandoffTarget,
  type HandoffCompletionHints,
  type HandoffEndReason,
  type HandoffResult,
  type HandoffTargetSpec,
  type LiveHandoffWindow,
} from './session.js';
import type { HandoffDriver } from './macDriver.js';
import { markSecretEntered } from './secretTaint.js';
import { TerminalPromptSession, type TerminalProgram } from './terminalPrompt.js';
import { ImageQrHandoffSession } from './imageQr.js';
import { qrContent } from './qrCode.js';

/**
 * Process-local registry of 代输入 requests. Owns card broadcast, owner
 * decisions and the agent continuation. Every input path ends here:
 * the trusted local Desktop channel, the signed remote v3 exchange, and
 * value-less plain decisions (hand back / cancel / stay / refresh).
 */

export interface InputHandoffStartRequest {
  sessionId: string;
  purpose: string;
  note?: string;
  requester?: string;
  target: HandoffTargetSpec;
  completeWhen?: HandoffCompletionHints;
  timeoutMinutes?: number;
}

export type InputHandoffStartError = 'HANDOFF_ACTIVE' | 'UNSUPPORTED' | 'RATE_LIMITED';

/** A sign-in QR code in a picture the agent supplied (not a window on this computer). */
export interface InputHandoffImageStartRequest {
  sessionId: string;
  purpose: string;
  note?: string;
  requester?: string;
  /** The picture's bytes; read by the caller from the agent's path or managed media URL. */
  image: Buffer;
  timeoutMinutes?: number;
}

export type InputHandoffImageStartError = InputHandoffStartError | 'NOT_AN_IMAGE' | 'NO_QR_FOUND' | 'QR_UNREADABLE' | 'NO_SESSION_CONTEXT';

/** Why a target cannot be handed off, known before starting. */
export interface InputHandoffTargetProblem {
  errorCode: 'TARGET_IS_CINDY' | 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS';
  message: string;
}

/** A password prompt from a verified terminal program in the task's shell. */
export interface TerminalPromptRequest {
  sessionId: string;
  prompt: string;
  program: TerminalProgram;
  command: string;
  requester?: string;
  /** Receives the owner's answer once; null when there is none. */
  answer(value: string | null): void;
}

/** What the registry needs from a running handoff of either kind. */
interface HandoffRun {
  readonly requestId: string;
  start(): Promise<void>;
  submit: InputHandoffSession['submit'];
  decide: InputHandoffSession['decide'];
  cancel(reason?: HandoffEndReason): void;
  isActionable(revision: number): boolean;
  /** Live view of the window (screen steps only; terminal prompts have no window). */
  liveWindow?(): Promise<LiveHandoffWindow | null>;
  afterLiveView?(): Promise<void>;
  /** Show the window to the owner on this computer (screen steps only). */
  bringToFront?(): Promise<boolean>;
  /** Screenshot of the current step, when the step is answered on a picture. */
  pictureFor?(revision: number): InputHandoffPicture | null;
}

export interface InputHandoffServiceDeps {
  broadcast(channel: string, payload: unknown): void;
  createDriver(): HandoffDriver | null;
  hostPid: number;
  remoteInputAvailable(): boolean;
  /** Whether another device may open a live view of the window (remote desktop allowed here). */
  liveViewAvailable?(): boolean;
  /** Hidden continuation to the requesting agent; metadata only. */
  continueAgent(sessionId: string, requestId: string, message: string): Promise<void>;
  /** Owner attention outside the app (mobile push, Agent Island). Never includes values. */
  notifyOwner?(sessionId: string, snapshot: InputHandoffSnapshot): void;
  onClosed?(sessionId: string, requestId: string): void;
  /** Display facts (name, platform) for a server-verified owner device id. */
  describeDevice?(deviceId: string): Omit<InputHandoffHolder, 'local' | 'deviceId'>;
  logger?: { info?(message: string, context?: Record<string, unknown>): void; warn(message: string, context?: Record<string, unknown>): void };
  terminalRetentionMs?: number;
  /**
   * The QR code in a picture, cut out with its quiet zone; null when there is
   * none. Absent where the platform cannot read codes.
   */
  qrFromPicture?(image: Buffer): Promise<{ text: string; jpeg: Buffer; width: number; height: number } | null | { error: 'not_image' | 'unreadable' }>;
  /** Test clock/sleep and countdown overrides passed through to each session. */
  sessionTiming?: { now?(): number; sleep?(ms: number): Promise<void>; finishingDelayMs?: number };
}

interface Entry {
  sessionId: string;
  session: HandoffRun;
  snapshot: InputHandoffSnapshot | null;
  /** The card has been shown. Until the first screen is read there may be nothing for the owner at all. */
  shown: boolean;
  /**
   * No continuation is sent: the task closed, or the agent is still inside the
   * command that asked (terminal prompts) and simply sees it finish.
   */
  silent: boolean;
  /** How it ended; kept for the short retention so a remote answer that finished it can report success. */
  result?: HandoffResult;
}

type StartResult =
  | { ok: true; requestId: string }
  | { ok: false; errorCode: InputHandoffStartError; message: string };

export const INPUT_HANDOFF_DEFAULT_TIMEOUT_MINUTES = 15;
export const INPUT_HANDOFF_MAX_TIMEOUT_MINUTES = 60;
/** Per-task limit so a looping agent cannot keep paging the owner. */
export const INPUT_HANDOFF_MAX_PER_TASK = 6;
export const INPUT_HANDOFF_RATE_WINDOW_MS = 60 * 60_000;

function timeoutMs(minutes: number | undefined): number {
  return Math.min(
    INPUT_HANDOFF_MAX_TIMEOUT_MINUTES,
    Math.max(1, Math.round(minutes ?? INPUT_HANDOFF_DEFAULT_TIMEOUT_MINUTES)),
  ) * 60_000;
}

export function buildInputHandoffContinuation(result: HandoffResult): string {
  const facts = [
    `status=${result.status}`,
    `ended_by=${result.reason}`,
    `steps=${result.steps}`,
    ...(result.failure ? [`failure=${result.failure}`] : []),
    ...(result.finalApp ? [`app=${JSON.stringify(result.finalApp)}`] : []),
    ...(result.finalWindow ? [`window=${JSON.stringify(result.finalWindow)}`] : []),
    ...(result.finalOrigin ? [`origin=${result.finalOrigin}`] : []),
    ...(result.answeredOn ? [`answered_on=${answeredOnFact(result.answeredOn)}`] : []),
  ].join(' ');
  const next = result.scanned && result.status === 'succeeded'
    ? 'The owner says they scanned the code. Check yourself whether the sign-in finished; if the code had expired, take a fresh screenshot and ask again.'
    : result.failure === 'nothing_to_fill'
    ? 'The screen has no field for the owner to type into. Press its buttons or pick its options yourself; request input handoff again only when a field appears that needs the owner.'
    : result.status === 'succeeded' && result.steps === 0 && result.reason === 'detected'
    ? 'The owner finished on the window itself: the fields you asked about are gone. Check the current screen yourself and continue; ask again only if something still needs them.'
    : result.status === 'succeeded'
    ? 'The owner\'s fields were typed in and confirmed. Check the current screen yourself and handle any buttons or options left; values they entered were not shared with you.'
    : result.failure === 'permission'
      ? 'Cindy lacks macOS Accessibility permission for input handoff. Ask the owner to allow it on this computer, or continue another way.'
    : result.failure === 'screen_locked'
      ? 'This computer\'s screen is locked (a display going to sleep locks it too), so nothing was read or typed. Ask the owner to wake and unlock it; request input handoff again only after they say it is unlocked.'
      : 'The handoff did not complete. Do not retry it automatically; tell the owner what is still needed or continue another way.';
  return `${INPUT_HANDOFF_ENDED_PREFIX} ${facts}. ${next}`;
}

function answeredOnFact(holder: InputHandoffHolder): string {
  if (holder.local) return 'this_computer';
  const name = holder.name?.replace(/[\u0000-\u001f"]/g, '').trim().slice(0, 60);
  return name ? JSON.stringify(name) : holder.platform === 'mobile' ? 'phone' : 'another_device';
}

export class InputHandoffService {
  private readonly entries = new Map<string, Entry>();
  private readonly recentStarts = new Map<string, number[]>();
  private readonly decoding = new Set<{ sessionId: string; cancelled: boolean }>();
  private readonly ownerMessageNotes = new Set<string>();

  constructor(private readonly deps: InputHandoffServiceDeps) {}

  start(request: InputHandoffStartRequest): StartResult {
    const refused = this.admit(request.sessionId);
    if (refused) return refused;
    const driver = this.deps.createDriver();
    if (!driver) return { ok: false, errorCode: 'UNSUPPORTED', message: 'Input handoff is only available on macOS for now.' };
    return this.launch(request.sessionId, false, (requestId, entry) => new InputHandoffSession({
      requestId,
      purpose: request.purpose,
      ...(request.note ? { note: request.note } : {}),
      ...(request.requester ? { requester: request.requester } : {}),
      target: request.target,
      ...(request.completeWhen ? { completeWhen: request.completeWhen } : {}),
      timeoutMs: timeoutMs(request.timeoutMinutes),
      hostPid: this.deps.hostPid,
      remoteInput: this.deps.remoteInputAvailable(),
      ...(this.deps.liveViewAvailable ? { liveView: this.deps.liveViewAvailable } : {}),
      driver,
      publish: (snapshot) => this.publish(entry, snapshot),
      finish: (result) => this.finish(entry, result),
      onSecretEntered: ({ url }) => markSecretEntered(url),
      ...this.deps.sessionTiming,
    }));
  }

  /**
   * Checks the target before a handoff starts, so the agent learns at once that
   * it named Cindy itself or a window that is not there (it used to get a
   * pending receipt and a target_gone minutes later). Null: go ahead; the
   * session still resolves the window itself. Without macOS Accessibility the
   * session asks for it as before, so nothing is checked here.
   */
  async checkTarget(target: HandoffTargetSpec): Promise<InputHandoffTargetProblem | null> {
    const driver = this.deps.createDriver();
    if (!driver) return null;
    if ((await driver.permission().catch(() => 'unknown' as const)) !== 'granted') return null;
    const list = await driver.windows({ background: true }).catch(() => null);
    if (!list) return null;
    const resolved = resolveHandoffTarget(list, target, this.deps.hostPid);
    if (resolved) {
      if (target.windowTitle) {
        const title = target.windowTitle.toLowerCase();
        if (resolved.window.title.toLowerCase().includes(title)) return null;
        const titles = list.apps.filter((app) => app.bundleId === resolved.bundleId).flatMap((app) => app.windows.map((w) => w.title)).filter(Boolean);
        return {
          errorCode: 'TARGET_NOT_FOUND',
          message: `${resolved.app} has no window titled ${JSON.stringify(target.windowTitle)}. `
            + (titles.length ? `Its windows: ${[...new Set(titles)].slice(0, 8).map((t) => JSON.stringify(t)).join(', ')}. ` : '')
            + 'Pages change their titles: read the current one and ask again.',
        };
      }
      if (target.pid === undefined && !target.app) return null;
      // Guessing could send the owner to the wrong window (the agent's page is often minimized behind theirs).
      // Without a pid the program may run as several processes (profiles, an automation copy): all of them count.
      const sameApp = target.pid !== undefined
        ? list.apps.filter((app) => app.pid === resolved.pid)
        : list.apps.filter((app) => app.pid !== this.deps.hostPid && app.bundleId === resolved.bundleId);
      const titles = sameApp.flatMap((app) => app.windows.map((w) => w.title)).filter(Boolean);
      if (titles.length < 2) return null;
      return {
        errorCode: 'TARGET_AMBIGUOUS',
        message: `${resolved.app} has several windows: ${[...new Set(titles)].slice(0, 8).map((title) => JSON.stringify(title)).join(', ')}. `
          + 'Ask again with target.window_title naming the one that shows the step.',
      };
    }
    const host = list.apps.find((app) => app.pid === this.deps.hostPid);
    const wanted = target.app?.trim().toLowerCase();
    // By name too: a dev or renamed build is not listed as "Cindy", and no other
    // visible window answered to it.
    const namesHost = target.pid === this.deps.hostPid || (!!wanted && (/^cindy\b/.test(wanted)
      || (!!host && (host.app.toLowerCase().includes(wanted) || host.bundleId.toLowerCase() === wanted))));
    const frontIsHost = !!host && target.pid === undefined && !wanted && list.frontmost === this.deps.hostPid;
    if (namesHost || frontIsHost) {
      return {
        errorCode: 'TARGET_IS_CINDY',
        message: (frontIsHost ? 'Cindy itself is in front, and ' : '')
          + 'Cindy\'s own window cannot be handed off. A screen shown inside Cindy (such as the device simulator) is not a '
          + 'window here: for a sign-in QR code on it, ask again with kind="scan" and `image` set to a fresh screenshot; '
          + 'for other fields there, tell the owner what is needed.',
      };
    }
    const visible = [...new Set(list.apps
      .filter((app) => app.pid !== this.deps.hostPid && app.windows.some((w) => !w.minimized))
      .map((app) => app.app))].slice(0, 12);
    return {
      errorCode: 'TARGET_NOT_FOUND',
      message: 'No visible window matches that target. '
        + (visible.length ? `Apps with visible windows: ${visible.join(', ')}. ` : '')
        + 'Pass target.app (and window_title) of the window that shows the step.',
    };
  }

  /**
   * Scan-to-sign-in from a picture the agent supplied. The code is read here,
   * before anything is shown, so a picture without one fails at once.
   */
  async startImageQr(request: InputHandoffImageStartRequest): Promise<
    { ok: true; requestId: string } | { ok: false; errorCode: InputHandoffImageStartError; message: string }
  > {
    const refused = this.admit(request.sessionId);
    if (refused) return refused;
    if (!this.deps.qrFromPicture)
      return { ok: false, errorCode: 'UNSUPPORTED', message: 'Reading QR codes from a picture is only available on macOS for now.' };
    // Not in `entries` until the picture is read: a task closed meanwhile marks this instead.
    const decoding = { sessionId: request.sessionId, cancelled: false };
    this.decoding.add(decoding);
    const found = await this.deps.qrFromPicture(request.image)
      .catch(() => ({ error: 'unreadable' as const }))
      .finally(() => this.decoding.delete(decoding));
    if (decoding.cancelled) {
      if (found && !('error' in found)) found.jpeg.fill(0);
      return { ok: false, errorCode: 'NO_SESSION_CONTEXT', message: 'This task stopped before the code could be shown.' };
    }
    if (found && 'error' in found) {
      return found.error === 'not_image'
        ? { ok: false, errorCode: 'NOT_AN_IMAGE', message: 'That file is not a picture Cindy can read (use PNG or JPEG).' }
        : { ok: false, errorCode: 'QR_UNREADABLE', message: 'Cindy could not read that picture right now. Tell the owner what is needed instead.' };
    }
    const qr = found ? qrContent(found.text) : null;
    if (!found || !qr) {
      found?.jpeg.fill(0);
      return { ok: false, errorCode: 'NO_QR_FOUND', message: 'No QR code found in that picture. Take a screenshot that shows the whole code and ask again.' };
    }
    // Another request may have started while the picture was read.
    const late = this.admit(request.sessionId);
    if (late) {
      found.jpeg.fill(0);
      return late;
    }
    return this.launch(request.sessionId, false, (requestId, entry) => new ImageQrHandoffSession({
      requestId,
      purpose: request.purpose,
      ...(request.note ? { note: request.note } : {}),
      ...(request.requester ? { requester: request.requester } : {}),
      timeoutMs: timeoutMs(request.timeoutMinutes),
      remoteInput: this.deps.remoteInputAvailable(),
      picture: { jpeg: found.jpeg, width: found.width, height: found.height, qr },
      publish: (snapshot) => this.publish(entry, snapshot),
      finish: (result) => this.finish(entry, result),
    }));
  }

  /**
   * A terminal program in the task asked for a password. The agent did not
   * call anything and gets no continuation: its command just proceeds once the
   * program has the answer (or fails without one).
   */
  startTerminalPrompt(request: TerminalPromptRequest): StartResult & { abandon?(): void } {
    const refused = this.admit(request.sessionId);
    if (refused) return refused;
    let run: TerminalPromptSession | undefined;
    const started = this.launch(request.sessionId, true, (requestId, entry) => {
      run = new TerminalPromptSession({
        requestId,
        prompt: request.prompt,
        program: request.program,
        command: request.command,
        ...(request.requester ? { requester: request.requester } : {}),
        timeoutMs: timeoutMs(undefined),
        remoteInput: this.deps.remoteInputAvailable(),
        answer: request.answer,
        publish: (snapshot) => this.publish(entry, snapshot),
        finish: (result) => this.finish(entry, result),
      });
      return run;
    });
    return started.ok ? { ...started, abandon: () => run?.abandon() } : started;
  }

  private admit(sessionId: string): Extract<StartResult, { ok: false }> | null {
    const now = this.now();
    const recent = (this.recentStarts.get(sessionId) ?? []).filter((at) => now - at < INPUT_HANDOFF_RATE_WINDOW_MS);
    this.recentStarts.set(sessionId, recent);
    if (recent.length >= INPUT_HANDOFF_MAX_PER_TASK)
      return { ok: false, errorCode: 'RATE_LIMITED', message: 'Too many input handoffs in this task recently. Tell the owner what is blocked instead of asking again.' };
    const waiting = [...this.entries.values()].filter((entry) => entry.sessionId === sessionId && !entry.snapshot?.terminal);
    // A terminal command is still blocked on its prompt; a card is only a question, and the new one replaces it.
    if (waiting.some((entry) => entry.silent))
      return { ok: false, errorCode: 'HANDOFF_ACTIVE', message: 'An input handoff is already waiting for the owner in this task.' };
    for (const entry of waiting) {
      entry.silent = true;
      entry.session.cancel('cancelled');
    }
    return null;
  }

  private launch(sessionId: string, silent: boolean, create: (requestId: string, entry: Entry) => HandoffRun): StartResult {
    this.recentStarts.get(sessionId)?.push(this.now());
    const requestId = randomUUID();
    const entry: Entry = { sessionId, session: null as unknown as HandoffRun, snapshot: null, shown: false, silent };
    entry.session = create(requestId, entry);
    this.entries.set(requestId, entry);
    this.deps.logger?.info?.('input handoff started', { sessionId, requestId, ...(silent ? { kind: 'terminal' } : {}) });
    void entry.session.start();
    return { ok: true, requestId };
  }

  private now(): number {
    return (this.deps.sessionTiming?.now ?? Date.now)();
  }

  /** Snapshot for the given request if it is still awaiting this exact revision. */
  actionable(requestId: string, revision: number): InputHandoffSnapshot | null {
    const entry = this.entries.get(requestId);
    if (!entry?.snapshot || !entry.session.isActionable(revision)) return null;
    // A quiet claim may have moved the revision on; the answer stays bound to the one it was typed against.
    return entry.snapshot.revision === revision ? entry.snapshot : { ...entry.snapshot, revision };
  }

  /**
   * The current step's screenshot. Callers: the executing Desktop's trusted
   * Renderer and the sealed v3 offer only; never a snapshot, push or log.
   */
  picture(requestId: string, revision: number): InputHandoffPicture | null {
    return this.entries.get(requestId)?.session.pictureFor?.(revision) ?? null;
  }

  /**
   * The window a live view should show, raised. Caller: the remote desktop host
   * only, after its own same-account authorization; never a viewer-named window.
   */
  /** Bring the step's window to the front on this computer. */
  async bringToFront(requestId: string): Promise<boolean> {
    return (await this.entries.get(requestId)?.session.bringToFront?.()) ?? false;
  }

  async liveWindow(requestId: string): Promise<LiveHandoffWindow | null> {
    const entry = this.entries.get(requestId);
    if (!entry?.snapshot?.liveView || entry.snapshot.terminal) return null;
    return (await entry.session.liveWindow?.()) ?? null;
  }

  /** The live view closed; the card catches up with the window. */
  liveViewEnded(requestId: string): void {
    void this.entries.get(requestId)?.session.afterLiveView?.().catch(() => undefined);
  }

  isCurrent(requestId: string): boolean {
    const entry = this.entries.get(requestId);
    return !!entry?.snapshot && !entry.snapshot.terminal;
  }

  /** The handoff ended because it was done (not cancelled, timed out or failed). */
  succeeded(requestId: string): boolean {
    return this.entries.get(requestId)?.result?.status === 'succeeded';
  }

  /** Values path. Callers: trusted Desktop IPC and the signed v3 exchange only. */
  async submit(requestId: string, raw: unknown, actor: InputHandoffHolder = { local: true }): Promise<boolean> {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    let submission;
    try {
      submission = parseInputHandoffSubmission(raw);
    } catch {
      return false;
    }
    return entry.session.submit(submission, this.describe(actor));
  }

  /** Value-less decisions; safe for the plain remote interaction channel. */
  resolve(requestId: string, raw: unknown, actor: InputHandoffHolder = { local: true }): boolean {
    const entry = this.entries.get(requestId);
    const decision = parseInputHandoffDecision(raw);
    if (!entry || !decision) return false;
    void entry.session.decide(decision, this.describe(actor)).catch((error) => {
      this.deps.logger?.warn('input handoff decision failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  pendingSnapshots(sessionId?: string): Array<{ sessionId: string; request: InputHandoffSnapshot }> {
    return [...this.entries.values()]
      .filter((entry) => entry.shown && entry.snapshot && !entry.snapshot.terminal
        && (sessionId === undefined || entry.sessionId === sessionId))
      .map((entry) => ({ sessionId: entry.sessionId, request: entry.snapshot! }));
  }

  hasPending(sessionId: string): boolean {
    return this.pendingSnapshots(sessionId).length > 0;
  }

  /**
   * The owner wrote in the task while a card waited: the card is over. No second
   * turn is started for it; the agent learns from a note on the owner's message.
   * Terminal prompts stay: their command would fail without an answer.
   */
  dismissForOwnerMessage(sessionId: string): void {
    for (const pending of this.decoding) if (pending.sessionId === sessionId) pending.cancelled = true;
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId || entry.snapshot?.terminal || entry.silent) continue;
      entry.silent = true;
      entry.session.cancel('owner_message');
      this.ownerMessageNotes.add(sessionId);
    }
  }

  /**
   * The note for the message that closed the card, until `ownerMessageNoteDelivered`:
   * a steer that is refused falls back to a normal send, and that send still owes it.
   */
  ownerMessageNote(sessionId: string): string | null {
    if (!this.ownerMessageNotes.has(sessionId)) return null;
    return 'Your input handoff card was closed because the owner sent the message below. Check the screen yourself before relying on it; ask again if a field still needs them.';
  }

  ownerMessageNoteDelivered(sessionId: string): void {
    this.ownerMessageNotes.delete(sessionId);
  }

  cleanupForSession(sessionId: string): void {
    this.ownerMessageNotes.delete(sessionId);
    for (const pending of this.decoding) if (pending.sessionId === sessionId) pending.cancelled = true;
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId || entry.snapshot?.terminal) continue;
      entry.silent = true;
      entry.session.cancel('session_closed');
    }
  }

  cleanupAll(): void {
    for (const pending of this.decoding) pending.cancelled = true;
    for (const entry of this.entries.values()) {
      if (entry.snapshot?.terminal) continue;
      entry.silent = true;
      entry.session.cancel('session_closed');
    }
  }

  private describe(actor: InputHandoffHolder): InputHandoffHolder {
    if (actor.local || !actor.deviceId) return actor;
    try {
      return { ...this.deps.describeDevice?.(actor.deviceId), deviceId: actor.deviceId };
    } catch {
      return actor;
    }
  }

  private publish(entry: Entry, snapshot: InputHandoffSnapshot): void {
    entry.snapshot = snapshot;
    // Nothing reaches the owner before the first screen is read: a screen with nothing
    // to type ends unseen, leaving only the record line in the task.
    if (!entry.shown && (snapshot.phase === 'reading' || snapshot.terminal)) return;
    entry.shown = true;
    try {
      this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, { sessionId: entry.sessionId, request: snapshot });
    } catch (error) {
      this.deps.logger?.warn('input handoff broadcast failed', {
        requestId: snapshot.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (snapshot.phase === 'ready' && !snapshot.terminal) this.deps.notifyOwner?.(entry.sessionId, snapshot);
  }

  private finish(entry: Entry, result: HandoffResult): void {
    const requestId = entry.session.requestId;
    entry.result = result;
    this.deps.logger?.info?.('input handoff ended', {
      sessionId: entry.sessionId,
      requestId,
      status: result.status,
      reason: result.reason,
      steps: result.steps,
      ...(result.failure ? { failure: result.failure } : {}),
    });
    const retention = setTimeout(() => {
      this.entries.delete(requestId);
      try {
        this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
          sessionId: entry.sessionId,
          requestId,
          reason: result.status,
        });
      } catch { /* window gone */ }
      this.deps.onClosed?.(entry.sessionId, requestId);
    }, this.deps.terminalRetentionMs ?? 4000);
    retention.unref?.();
    if (entry.silent) return;
    void this.deps.continueAgent(entry.sessionId, requestId, buildInputHandoffContinuation(result)).catch((error) => {
      this.deps.logger?.warn('input handoff continuation failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

let singleton: InputHandoffService | null = null;
export function initInputHandoffService(deps: InputHandoffServiceDeps): InputHandoffService {
  singleton = new InputHandoffService(deps);
  return singleton;
}
export function getInputHandoffService(): InputHandoffService | null {
  return singleton;
}
