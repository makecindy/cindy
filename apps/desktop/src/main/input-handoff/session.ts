import {
  INPUT_HANDOFF_PICTURE_TEXT_ID,
  validateInputHandoffSubmissionForStep,
  type InputHandoffControl,
  type InputHandoffDecision,
  type InputHandoffFailure,
  type InputHandoffHolder,
  type InputHandoffPhase,
  type InputHandoffPicture,
  type InputHandoffQr,
  type InputHandoffSnapshot,
  type InputHandoffSource,
  type InputHandoffSubmission,
} from '@cindy/device-link';
import { HumanDesktopInput } from '../remote-desktop/inputOwnership.js';
import type { HandoffDriver } from './macDriver.js';
import { isBrowserBundle } from './originPolicy.js';
import { qrContent } from './qrCode.js';
import { extractStep, type ExtractedStep } from './stepExtractor.js';
import type {
  ControlBinding,
  FoundQr,
  HandoffTarget,
  NativeActKind,
  NativeActResult,
  NativeAxSnapshot,
  NativeWindowList,
  WindowCapture,
} from './types.js';

/** The current screenshot step; the JPEG is wiped as soon as the step is left. */
interface PictureStep extends WindowCapture {
  /** A text field had focus when photographed; the card shows one box for it. */
  field?: 'text' | 'password';
  /** Scan-to-sign-in: the picture is a QR code cut out of the window, and this is what it says. */
  qr?: InputHandoffQr;
}

/** How often a QR code on screen is looked at again, to follow a refresh or see that it was scanned. */
const QR_WATCH_MS = 2000;

/** Where the flow stood when its QR code was first shown; leaving it means the scan went through. */
interface QrBaseline {
  pid: number;
  windowIndex: number;
  windowTitle: string;
  url?: string;
}

/**
 * Something on the step the owner is asked for: a field to type into, or a
 * sign-in code to use on their own device.
 */
const actionable = (step: ExtractedStep) =>
  !!step.deviceCode || step.shown.some((control) => control.kind === 'text');

/** The window's structure can be read (it has controls), whether or not any are for the owner. */
const readable = (step: ExtractedStep) => step.controls.some((control) => control.kind !== 'note');

export interface HandoffTargetSpec {
  app?: string;
  pid?: number;
  windowTitle?: string;
}

export interface HandoffCompletionHints {
  windowClosed?: boolean;
  textAppears?: string;
  urlContains?: string;
}

export type HandoffEndReason = 'owner' | 'owner_message' | 'detected' | 'cancelled' | 'timeout' | 'failure' | 'session_closed';

export interface HandoffResult {
  status: 'succeeded' | 'cancelled' | 'failed' | 'expired';
  reason: HandoffEndReason;
  steps: number;
  failure?: InputHandoffFailure;
  finalApp?: string;
  finalWindow?: string;
  finalOrigin?: string;
  /** Device that answered the last applied step; absent when no values were applied. */
  answeredOn?: InputHandoffHolder;
  /** The program had several windows and the request named none: their titles, for asking again. */
  ambiguousTitles?: string[];
  /** A QR code from the agent's own screenshot: the owner reports the scan, Cindy cannot see it. */
  scanned?: true;
}

/** The window a live view shows, located by the host when the owner opens it. */
export interface LiveHandoffWindow {
  pid: number;
  app: string;
  title?: string;
  windowId: number;
  /** Screen frame in points: x, y, width, height. */
  frame: number[];
}

export interface HandoffSessionOptions {
  requestId: string;
  purpose: string;
  note?: string;
  requester?: string;
  target: HandoffTargetSpec;
  completeWhen?: HandoffCompletionHints;
  timeoutMs: number;
  /** Cindy itself; never a handoff target and never followed into. */
  hostPid: number;
  remoteInput: boolean;
  /** Whether another device may open a live view of the window right now (remote desktop allowed). */
  liveView?: () => boolean;
  driver: HandoffDriver;
  publish(snapshot: InputHandoffSnapshot): void;
  finish(result: HandoffResult): void;
  /** A secret was typed into a page the agent controls (automation browser); restrict its page reads. */
  onSecretEntered?(target: { pid: number; url?: string; windowTitle?: string }): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  finishingDelayMs?: number;
  settleTimeoutMs?: number;
  windowWatchMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Handoffs move keyboard focus; only one may act on the desktop at a time.
 * While Cindy types for the owner it holds the same lease as remote-desktop
 * input, so the agent's own Computer Use waits and must observe again after.
 */
let desktopTurn: Promise<unknown> = Promise.resolve();
function withDesktopTurn<T>(work: () => Promise<T>): Promise<T> {
  const owned = async () => {
    const lease = new HumanDesktopInput();
    const turn = lease.begin([]);
    try {
      await turn.ready;
      return await work();
    } finally {
      turn.complete();
      lease.release();
    }
  };
  const run = desktopTurn.then(owned, owned);
  desktopTurn = run.catch(() => undefined);
  return run;
}

function sameHolder(a: InputHandoffHolder, b: InputHandoffHolder): boolean {
  return a.local === true ? b.local === true : b.local !== true && a.deviceId === b.deviceId;
}

const AUTOMATION_FLAGS = /--(remote-debugging-(port|pipe)|enable-automation|headless)\b/;

const bundleTail = (bundleId: string): string => bundleId.slice(bundleId.lastIndexOf('.') + 1).toLowerCase();

/**
 * The window a handoff works on: by pid, else by app name or bundle id, else
 * the frontmost app; never Cindy itself. Shared with the request-time check so
 * a bad target is reported to the agent at once instead of minutes later.
 *
 * Minimized windows stay reachable (Cindy's browser window opens minimized), but
 * only when named or when the app has nothing else: a shown window answers first.
 */
export function resolveHandoffTarget(list: NativeWindowList, spec: HandoffTargetSpec, hostPid: number): HandoffTarget | null {
  const others = list.apps.filter((app) => app.pid !== hostPid && app.windows.length > 0);
  const showing = (app: NativeWindowList['apps'][number]) => app.windows.some((w) => !w.minimized);
  const candidates = [...others.filter(showing), ...others.filter((app) => !showing(app))];
  let app = spec.pid !== undefined ? candidates.find((entry) => entry.pid === spec.pid) : undefined;
  if (!app && spec.app) {
    const wanted = spec.app.trim().toLowerCase();
    app = candidates.find((entry) => entry.app.toLowerCase() === wanted || entry.bundleId.toLowerCase() === wanted)
      ?? candidates.find((entry) => entry.app.toLowerCase().includes(wanted))
      // Agents name apps in English while a localized desktop lists 访达 for
      // Finder; the bundle id's last part (com.apple.finder) still says it.
      ?? candidates.find((entry) => bundleTail(entry.bundleId) === wanted)
      ?? (wanted.length >= 3 ? candidates.find((entry) => bundleTail(entry.bundleId).includes(wanted)) : undefined);
  }
  if (!app && spec.pid === undefined && !spec.app) app = candidates.find((entry) => entry.pid === list.frontmost);
  if (!app) return null;
  const title = spec.windowTitle?.toLowerCase();
  const named = (w: { title: string }) => !!title && w.title.toLowerCase().includes(title);
  // The same browser can run as several processes (profiles, an automation copy): the named window may be in any of them.
  if (title && spec.pid === undefined && !app.windows.some(named)) {
    const sameApp = candidates.filter((entry) => entry.bundleId === app!.bundleId && entry.windows.some(named));
    app = sameApp.find((entry) => entry.windows.some((w) => named(w) && !w.minimized)) ?? sameApp[0] ?? app;
  }
  // A title that matches nothing is not "the focused window": the owner would be sent, and type, in the wrong one.
  if (title && !app.windows.some(named)) return null;
  const visibleWindows = app.windows.filter((window) => !window.minimized);
  const window = visibleWindows.find(named)
    ?? app.windows.find(named)
    ?? visibleWindows.find((w) => w.focused)
    ?? visibleWindows[0]
    ?? app.windows[0];
  if (!window) return null;
  return {
    pid: app.pid, app: app.app, bundleId: app.bundleId, window: { index: window.index, title: window.title },
    ...(window.minimized ? { minimized: true } : {}),
  };
}

/** How long a window just brought back may take to draw its form (a sign-in page loads frames). */
const RESTORED_PAGE_WAIT_MS = 6000;
/** How long a browser may take to expose its page to accessibility on the first read. */
const BROWSER_PAGE_WAIT_MS = 3000;
/** How often a waiting card looks at its window; reading does not bring it forward. */
const WINDOW_WATCH_MS = 2000;
/** Reads in a row before concluding: pages clear their forms for a moment while they load. */
const FIELDS_GONE_READS = 3;
const WINDOW_GONE_READS = 2;

/** What the owner would be asked, ignoring what they typed; the ids bind an open form to its fields. */
const fieldShape = (step: ExtractedStep): string =>
  JSON.stringify(step.shown.map((control) => (control.kind === 'text'
    ? [control.id, control.label, control.contentType]
    : [control.id, control.kind === 'note' ? control.text : ''])));

/**
 * The windows of one program when the agent named neither a window nor a process, so that guessing
 * which one the owner means could send them to the wrong browser profile; null when there is no doubt.
 * Shared by the request-time check and the session, so a check that was skipped cannot be bypassed.
 */
export function ambiguousWindowTitles(
  list: NativeWindowList,
  spec: HandoffTargetSpec,
  resolved: HandoffTarget,
  hostPid: number,
): string[] | null {
  if (spec.windowTitle || (spec.pid === undefined && !spec.app)) return null;
  const sameApp = spec.pid !== undefined
    ? list.apps.filter((app) => app.pid === resolved.pid)
    : list.apps.filter((app) => app.pid !== hostPid && app.bundleId === resolved.bundleId);
  const titles = sameApp.flatMap((app) => app.windows.map((w) => w.title)).filter(Boolean);
  return titles.length < 2 ? null : titles;
}

/**
 * One 代输入 request: a loop of read step → owner answers → act → wait for
 * the screen to settle → read the next step, until the flow ends.
 *
 * The agent never sees steps or values. It only receives the final result.
 */
export class InputHandoffSession {
  private revision = 0;
  private unheldClaimFrom: number | null = null;
  private phase: InputHandoffPhase = 'reading';
  private failure: InputHandoffFailure | undefined;
  private target: HandoffTarget | null = null;
  private initial: HandoffTarget | null = null;
  private step: ExtractedStep | null = null;
  private stepNumber = 0;
  private submissions = 0;
  private finishingUntil: number | undefined;
  private finishingTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private agentControlled = false;
  private stayedOn: string | undefined;
  private holder: InputHandoffHolder | undefined;
  private answeredOn: InputHandoffHolder | undefined;
  private ended = false;
  private busy = false;
  private picture: PictureStep | null = null;
  /** The owner chose the screenshot for this flow; stays until they go back to the form. */
  private pictureChosen = false;
  /** Scan-to-sign-in: a code is on screen (`scan`), or it went away and the sign-in is finishing (`scanned`). */
  private qrState: 'scan' | 'scanned' | null = null;
  private qrBaseline: QrBaseline | null = null;
  private qrTimer: ReturnType<typeof setTimeout> | undefined;
  private qrChecking = false;
  /** A step of this request asked for a sign-in: the owner signs in on the window itself. */
  private signInMode = false;
  /** The owner has been asked something, so a screen with nothing to ask means they finished it. */
  private asked = false;
  /** The asked fields went away without an answer through the card: the owner did it on the window. */
  private doneOutside = false;
  private ambiguousTitles: string[] | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchList: NativeWindowList | null = null;
  private fieldsGoneReads = 0;
  private windowGoneReads = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HandoffSessionOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.options = { ...options, driver: this.watchLock(options.driver) };
  }

  /**
   * A screen that locks while the card is open ends the handoff as
   * screen_locked, whichever read, action or wait noticed it first.
   */
  private watchLock(driver: HandoffDriver): HandoffDriver {
    const locked = () => {
      if (!this.ended) this.end('failed', 'failure', 'screen_locked');
    };
    return new Proxy(driver, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          try {
            const result: unknown = await value.apply(target, args);
            if (result && typeof result === 'object' && (result as { error?: unknown }).error === 'locked') locked();
            return result;
          } catch (error) {
            if (error instanceof Error && error.message === 'locked') locked();
            throw error;
          }
        };
      },
    });
  }

  get requestId(): string {
    return this.options.requestId;
  }

  snapshot(): InputHandoffSnapshot {
    const step = this.step;
    const picture = this.picture && this.phase === 'ready' ? this.picture : null;
    const controls: InputHandoffControl[] = picture
      ? picture.field && !picture.qr
        ? [{ id: INPUT_HANDOFF_PICTURE_TEXT_ID, kind: 'text', label: '', contentType: picture.field }]
        : []
      : this.qrState === 'scanned'
        ? []
        : this.phase === 'ready' || this.phase === 'finishing'
          ? step?.shown ?? []
          : [];
    const qr = this.phase !== 'ready' ? null : picture?.qr ? 'scan' : this.qrState === 'scanned' ? 'scanned' : null;
    return {
      kind: 'input_handoff',
      requestId: this.options.requestId,
      revision: this.revision,
      phase: this.phase,
      purpose: this.options.purpose,
      ...(this.options.note ? { note: this.options.note } : {}),
      ...(this.holder ? { holder: { ...this.holder } } : {}),
      ...(this.options.requester ? { requester: this.options.requester } : {}),
      source: this.source(),
      stepNumber: Math.max(1, this.stepNumber),
      controls,
      ...(this.finishingUntil !== undefined && this.phase === 'finishing' ? { finishingUntil: this.finishingUntil } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.agentControlled ? { agentControlled: true as const } : {}),
      ...(this.options.remoteInput && !this.ended ? { remoteInput: true as const } : {}),
      ...(this.ended ? { terminal: true as const } : {}),
      ...(picture ? { picture: true as const } : {}),
      ...(this.liveViewOffered() ? { liveView: true as const } : {}),
      ...(this.directSignInOffered() ? { directSignIn: true as const } : {}),
      ...(!picture && !qr && this.phase === 'ready' && step?.deviceCode ? { deviceCode: { ...step.deviceCode } } : {}),
      ...(qr ? { qr } : {}),
    };
  }

  private liveViewOffered(): boolean {
    return !this.ended && !!this.target && !!this.options.driver.raise
      && (this.phase === 'ready' || this.phase === 'finishing') && this.options.liveView?.() === true;
  }

  /**
   * The owner does this on the window: a sign-in, or a browser page nothing can be
   * read from (the form could only be guessed at). `picture` then stays the way to
   * answer from a device with no live view.
   */
  private directSignInOffered(): boolean {
    if (this.ended || this.phase !== 'ready' || this.qrState || !this.options.driver.raise) return false;
    if (this.picture) return !this.pictureChosen && !!this.step?.pageMissing;
    return this.signInMode && !!this.step?.signIn && !this.step.deviceCode;
  }

  /** The owner chose to sign in on the window: show it to them. */
  async bringToFront(): Promise<boolean> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.raise || this.ended || this.busy) return false;
    const raised = await withDesktopTurn(() => driver.raise!(target)).catch(() => null);
    return !!raised && !('error' in raised);
  }

  /**
   * The owner opened a live view of the window: bring it to the front and say
   * where it is. Only while this request is waiting for the owner.
   */
  async liveWindow(): Promise<LiveHandoffWindow | null> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.raise || !this.liveViewOffered() || this.busy) return null;
    const raised = await withDesktopTurn(() => driver.raise!(target)).catch(() => null);
    if (!raised || 'error' in raised || this.ended || this.target !== target) return null;
    return {
      pid: target.pid,
      app: target.app,
      ...(target.window.title ? { title: target.window.title } : {}),
      windowId: raised.windowId,
      frame: raised.frame,
    };
  }

  /** The live view closed: read the window again, so the card shows where things are now. */
  async afterLiveView(): Promise<void> {
    if (this.ended || this.busy || this.phase !== 'ready') return;
    await this.decide({ kind: 'input_handoff', action: 'refresh', expectedRevision: this.revision });
  }

  /** The current screenshot, for the executing Desktop and the sealed offer only. */
  pictureFor(revision: number): InputHandoffPicture | null {
    const picture = this.picture;
    if (!picture || !this.isActionable(revision)) return null;
    return {
      mime: 'image/jpeg',
      width: picture.width,
      height: picture.height,
      data: picture.jpeg.toString('base64'),
      ...(picture.qr ? { qr: { ...picture.qr } } : {}),
    };
  }

  isActionable(revision: number): boolean {
    return !this.ended && !this.busy && this.phase === 'ready' && this.acceptsRevision(revision);
  }

  /** The current revision, or the one just before this screen was taken while nobody held it (see `decide`). */
  private acceptsRevision(revision: number): boolean {
    return revision === this.revision || (this.unheldClaimFrom !== null && revision === this.unheldClaimFrom && this.revision === revision + 1);
  }

  async start(): Promise<void> {
    this.publish('reading');
    this.expiryTimer = setTimeout(() => this.end('expired', 'timeout', 'timeout'), this.options.timeoutMs);
    this.expiryTimer.unref?.();
    this.armWindowWatch();
    try {
      const permission = await this.options.driver.permission();
      if (permission !== 'granted') {
        if (permission === 'missing') await this.options.driver.requestPermission();
        if ((await this.options.driver.permission()) !== 'granted') {
          this.end('failed', 'failure', 'permission');
          return;
        }
      }
      const windows = await this.options.driver.windows({ background: true });
      const target = this.resolveTarget(windows);
      // What the window watch compares against, so a page renaming its window from here on is not a closed window.
      this.watchList = windows;
      const ambiguous = target ? ambiguousWindowTitles(windows, this.options.target, target, this.options.hostPid) : null;
      if (!target || ambiguous) {
        // Several windows and no title: say so, with their titles, so the agent can ask again naming one.
        if (ambiguous) this.ambiguousTitles = [...new Set(ambiguous)].slice(0, 8);
        this.end('failed', 'failure', 'target_gone');
        return;
      }
      await this.useTarget(target);
      this.initial = target;
      if (target.minimized) await this.coverBeforeRestoring(target);
      const restored = await this.restoreTarget(target);
      const step = await this.readFirstStep(restored);
      // The code and screenshot probes below raise the window: an unreadable page is covered before them,
      // by the title it has now (reading may have renamed the window).
      if (!step || step.pageMissing) this.coverUnreadablePage(this.target ?? target);
      if (step && actionable(step)) {
        // A sign-in happens on the window itself, wherever the owner answers from.
        if (step.signIn && !restored) {
          this.guardSignInPage(step);
          await this.bringToFront();
        }
        this.present(step);
        return;
      }
      // Nothing to type, but a QR code to scan (scan-to-sign-in, in any app or page).
      this.step = step;
      if (await this.showQr()) {
        this.publish('ready');
        return;
      }
      // A readable screen without a field to type into ends at once: its buttons and options are the agent's.
      if (step && readable(step)) {
        this.present(step);
        return;
      }
      // Nothing readable in the window's structure (canvas, self-drawn UI): answer on a picture of it.
      if (await this.showPicture()) {
        this.publish('ready');
        return;
      }
      // Neither its structure nor a picture of it can reach the owner.
      this.end('failed', 'failure', 'unreadable');
    } catch (error) {
      // A locked screen is not read at all: say so, rather than blame the window.
      this.end('failed', 'failure', error instanceof Error && error.message === 'locked' ? 'screen_locked' : 'unreadable');
    }
  }

  /** Owner values. Returns false when the step is no longer the one the owner answered. */
  async submit(submission: InputHandoffSubmission, actor?: InputHandoffHolder): Promise<boolean> {
    if (!this.isActionable(submission.expectedRevision)) return false;
    // The revision before a quiet claim is good only for the device that claimed.
    if (submission.expectedRevision !== this.revision && !(actor && this.holder && sameHolder(actor, this.holder))) return false;
    if (!validateInputHandoffSubmissionForStep({ ...this.snapshot(), revision: submission.expectedRevision }, submission)) return false;
    if (this.picture) return this.submitPicture(this.picture, submission, actor);
    const current = this.step;
    if (!current) return false;
    this.busy = true;
    // Answering a step is starting to handle it: this device now holds the handoff.
    if (actor) this.holder = actor;
    this.clearFinishing();
    this.failure = undefined;
    this.publish('working');
    const before = { signature: current.signature, windows: await this.options.driver.windows().catch(() => null) };
    let outcome: boolean | 'origin_changed' = false;
    try {
      outcome = await withDesktopTurn(() => this.perform(current, submission));
    } catch {
      outcome = false;
    } finally {
      for (const key of Object.keys(submission.values)) delete submission.values[key];
    }
    if (this.ended) return true;
    const ok = outcome === true;
    if (outcome !== 'origin_changed') this.submissions++;
    if (ok) this.answeredOn = actor ?? this.answeredOn;
    try {
      const next = await this.awaitSettled(before.signature, before.windows);
      if (this.ended) return true;
      if (next === 'ended') {
        this.end('succeeded', 'detected');
        return true;
      }
      if (outcome !== 'origin_changed') this.stepNumber++;
      if (!ok) this.failure = outcome === 'origin_changed' ? 'origin_changed' : 'action_failed';
      if (outcome === 'origin_changed' && !actionable(next)) {
        // The page changed under the owner and now asks for nothing: say what happened, not "nothing to fill".
        this.end('failed', 'failure', 'origin_changed');
        return true;
      }
      // After a password, the next screen may ask to scan a code (a second factor).
      if (ok && !actionable(next) && !this.hintsMet(next)) {
        this.step = next;
        if (await this.showQr()) {
          this.publish('ready');
          return true;
        }
      }
      this.present(next, !ok);
    } catch {
      // The next screen cannot be read as a form: show it as a picture instead.
      this.step = null;
      if (!(await this.showPicture().catch(() => false))) this.failure = 'unreadable';
      this.publish('ready');
    } finally {
      this.busy = false;
    }
    return true;
  }

  async decide(decision: InputHandoffDecision, actor?: InputHandoffHolder): Promise<boolean> {
    if (this.ended || decision.expectedRevision !== this.revision) return false;
    if (decision.action === 'cancel') {
      this.end('cancelled', 'cancelled');
      return true;
    }
    if (decision.action === 'claim') {
      if (!actor || this.busy) return false;
      if (this.holder && sameHolder(this.holder, actor)) return true;
      // Taking over bumps the revision, so an answer already in flight from the
      // previous holder is rejected as stale instead of racing this device. Taking
      // a screen nobody held keeps the answer it was typed against valid (a
      // password manager can fill and submit before the claim comes back).
      const unheld = this.holder ? null : this.revision;
      this.holder = actor;
      this.publish(this.phase);
      this.unheldClaimFrom = unheld;
      return true;
    }
    if (this.busy) return false;
    if (decision.action === 'done') {
      this.end('succeeded', 'owner');
      return true;
    }
    if (decision.action === 'stay') {
      if (this.phase !== 'finishing') return false;
      this.clearFinishing();
      this.stayedOn = this.step?.signature;
      this.publish('ready');
      return true;
    }
    if (decision.action === 'picture') {
      // The card's form does not match what the owner needs to see (a captcha image, a slider…).
      if (this.phase !== 'ready') return false;
      if (this.picture && !this.picture.qr) return true;
      this.busy = true;
      try {
        // On a QR step this shows the whole window instead of just the code.
        this.stopQr();
        this.pictureChosen = true;
        if (await this.showPicture()) this.failure = undefined;
        else {
          this.pictureChosen = false;
          this.failure = 'picture_unavailable';
        }
        this.publish('ready');
      } finally {
        this.busy = false;
      }
      return true;
    }
    // refresh: re-read, following whatever is now in front; from a picture this is "back to the form".
    this.busy = true;
    this.pictureChosen = false;
    try {
      const windows = await this.options.driver.windows().catch(() => null);
      const follow = windows ? this.followTarget(windows, null) : null;
      if (follow === 'ended') {
        this.end('succeeded', 'detected');
        return true;
      }
      if (follow) await this.useTarget(follow);
      const step = await this.read().catch(() => null);
      if (step && actionable(step)) {
        this.failure = undefined;
        this.present(step, true);
        return true;
      }
      this.step = step;
      if (await this.showQr()) {
        this.failure = undefined;
        this.publish('ready');
        return true;
      }
      if (step && !step.pageMissing && !this.picture) {
        this.failure = undefined;
        this.present(step, true);
        return true;
      }
      if (await this.showPicture()) this.failure = undefined;
      else {
        this.dropPicture();
        this.failure = 'unreadable';
      }
      this.publish('ready');
    } finally {
      this.busy = false;
    }
    return true;
  }

  cancel(reason: HandoffEndReason = 'cancelled'): void {
    this.end('cancelled', reason);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private publish(phase: InputHandoffPhase): void {
    this.phase = phase;
    this.revision++;
    // The owner is sent to type in a page nothing could be read from: cover it before they do.
    if (this.directSignInOffered() && this.step?.pageMissing && this.target) {
      this.options.onSecretEntered?.({ pid: this.target.pid, windowTitle: this.target.window.title });
    }
    this.options.publish(this.snapshot());
  }

  /** The owner types a password straight into this page: the agent's page reads pause there, as after a form. */
  private guardSignInPage(step: ExtractedStep): void {
    // Every direct sign-in field counts, not only a password: a one-time code or an account typed in the window is as readable.
    if (step.signIn && this.target)
      this.options.onSecretEntered?.({ pid: this.target.pid, ...(step.url ? { url: step.url } : {}) });
  }

  private present(read: ExtractedStep, suppressAutoFinish = false): void {
    this.stopQr();
    this.dropPicture();
    this.fieldsGoneReads = 0;
    if (read.signIn) this.signInMode = true;
    // Past a sign-in, a page's own fields (a reply box) are not its next step.
    const signInOver = this.signInMode && !read.signIn && !read.pageMissing && !read.deviceCode;
    const step = signInOver ? { ...read, shown: [] } : read;
    this.step = step;
    this.guardSignInPage(step);
    this.doneOutside = this.asked && this.submissions === 0 && !actionable(step) && !step.pageMissing;
    if (this.submissions === 0 && !actionable(step) && !this.doneOutside) {
      // Nothing was asked of the owner yet and there is nothing to type: hand the screen back to the agent.
      this.end('cancelled', 'detected', 'nothing_to_fill');
      return;
    }
    this.asked = true;
    if (this.stepNumber === 0) this.stepNumber = 1;
    if ((!suppressAutoFinish || this.doneOutside) && this.shouldFinish(step)) {
      this.finishingUntil = this.now() + (this.options.finishingDelayMs ?? 3000);
      this.publish('finishing');
      this.finishingTimer = setTimeout(() => {
        if (this.phase === 'finishing') this.end('succeeded', 'detected');
      }, this.options.finishingDelayMs ?? 3000);
      this.finishingTimer.unref?.();
      return;
    }
    this.publish('ready');
  }

  /** The agent said what the end looks like, and this screen shows it. */
  private hintsMet(step: ExtractedStep): boolean {
    const hints = this.options.completeWhen;
    if (hints?.textAppears && step.texts.some((text) => text.includes(hints.textAppears!))) return true;
    return !!hints?.urlContains && !!step.url?.includes(hints.urlContains);
  }

  private shouldFinish(step: ExtractedStep): boolean {
    if (this.stayedOn !== undefined && this.stayedOn === step.signature) return false;
    if (this.hintsMet(step) || this.doneOutside) return true;
    // A sign-in code is still waiting to be used on the owner's device; they say when they are done.
    if (step.deviceCode) return false;
    // Generic end: after the owner answered, nothing is left to type. Buttons from here on are the agent's.
    return this.submissions > 0 && !actionable(step);
  }

  /** What the card says it shows: the page when it can be read, otherwise the window. */
  private source(): InputHandoffSource {
    if (this.step) return this.step.source;
    const app = this.target?.app ?? this.options.target.app ?? '';
    return this.target?.window.title ? { app, window: this.target.window.title } : { app };
  }

  /** Photographs the target window for this step. False when the platform or permission does not allow it. */
  private async showPicture(): Promise<boolean> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.capture) return false;
    const shot = await withDesktopTurn(() => driver.capture!(target)).catch(() => null);
    if (!shot || 'error' in shot) return false;
    const focus = await driver.focusedField?.(target.pid).catch(() => null);
    this.stopQr();
    this.dropPicture();
    this.picture = { ...shot, ...(focus?.editable ? { field: focus.secure ? 'password' : 'text' } : {}) };
    if (this.stepNumber === 0) this.stepNumber = 1;
    return true;
  }

  private dropPicture(): void {
    this.picture?.jpeg.fill(0);
    this.picture = null;
  }

  /**
   * Scan-to-sign-in: looks for a QR code in the target window and, when there
   * is one, makes it this step. Works on any app or page; nothing product-specific.
   */
  private async showQr(): Promise<boolean> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.qr || this.pictureChosen) return false;
    const found = await withDesktopTurn(() => driver.qr!(target, null)).catch(() => null);
    if (!found || 'error' in found) return false;
    const qr = qrContent(found.text);
    if (!qr || this.ended) {
      found.capture.jpeg.fill(0);
      return false;
    }
    this.dropPicture();
    this.picture = { ...found.capture, qr };
    this.qrState = 'scan';
    const current = this.target ?? target;
    this.qrBaseline = {
      pid: current.pid,
      windowIndex: current.window.index,
      windowTitle: current.window.title,
      ...(this.step?.url ? { url: this.step.url } : {}),
    };
    if (this.stepNumber === 0) this.stepNumber = 1;
    this.watchQr();
    return true;
  }

  private stopQr(): void {
    if (this.qrTimer) clearTimeout(this.qrTimer);
    this.qrTimer = undefined;
    this.qrState = null;
    this.qrBaseline = null;
  }

  private watchQr(): void {
    if (this.qrTimer) clearTimeout(this.qrTimer);
    const tick = async () => {
      this.qrTimer = undefined;
      if (this.ended || !this.qrState) return;
      await this.checkQr().catch(() => undefined);
      if (!this.ended && this.qrState && !this.qrTimer) {
        this.qrTimer = setTimeout(() => void tick(), QR_WATCH_MS);
        this.qrTimer.unref?.();
      }
    };
    this.qrTimer = setTimeout(() => void tick(), QR_WATCH_MS);
    this.qrTimer.unref?.();
  }

  /**
   * Looks at the window again while its code waits to be scanned: a new code
   * (refreshed or expired) replaces the old one; a code that went away means
   * it was scanned, and leaving the page (a new window, address or title)
   * means the sign-in went through. Anything the owner did meanwhile wins:
   * a look that raced it is dropped.
   */
  private async checkQr(): Promise<void> {
    const driver = this.options.driver;
    const target = this.target;
    if (!target || !driver.qr || this.busy || this.phase !== 'ready' || this.qrChecking) return;
    const revision = this.revision;
    const current = () => !this.ended && !this.busy && this.revision === revision && this.qrState !== null;
    this.qrChecking = true;
    try {
      const windows = await driver.windows().catch(() => null);
      if (!windows || !current()) return;
      const mine = windows.apps.find((entry) => entry.pid === target.pid);
      const window = mine?.windows.find((w) => w.index === target.window.index && w.title === target.window.title)
        ?? mine?.windows.find((w) => w.title === target.window.title);
      const otherFocused = windows.frontmost === target.pid && mine?.windows.some((w) => w.focused && !w.minimized && w !== window);
      if (!window || otherFocused) {
        // The window closed, changed its title, or a new one of the same app took over. Whatever
        // other app happens to be in front is not followed: it says nothing about this sign-in.
        const follow = this.followTarget({ ...windows, frontmost: target.pid }, null);
        if (follow === 'ended') {
          this.submissions++;
          this.end('succeeded', 'detected');
          return;
        }
        if (!follow) return;
        // Nothing changes until the look is known to be current: an owner tap meanwhile keeps its window.
        const agentControlled = follow.pid === target.pid
          ? this.agentControlled
          : AUTOMATION_FLAGS.test(await driver.commandLine(follow.pid).catch(() => ''));
        if (!current()) return;
        // A title that changed while the code still shows (a counter, a tab badge) is not a sign-in.
        const frame = windows.apps.find((entry) => entry.pid === follow.pid)?.windows
          .find((w) => w.index === follow.window.index && w.title === follow.window.title)?.frame;
        const still = frame && frame.length === 4 ? await driver.qr(follow, frame).catch(() => null) : null;
        if (!current()) {
          if (still && !('error' in still)) still.capture.jpeg.fill(0);
          return;
        }
        this.target = follow;
        this.agentControlled = agentControlled;
        const stillQr = still && !('error' in still) ? qrContent(still.text) : null;
        if (still && !('error' in still) && stillQr) {
          this.showFoundQr(still, stillQr);
          return;
        }
        if (still && !('error' in still)) still.capture.jpeg.fill(0);
        await this.qrLeft(true, current);
        return;
      }
      // Another app in front (or the window minimized) hides the code: no conclusion from what cannot be seen.
      if (window.minimized || windows.frontmost !== target.pid || !window.focused) return;
      // A look that failed says nothing about the code: keep waiting.
      const found = await driver.qr(target, window.frame).catch(() => ({ error: 'unavailable' as const }));
      if (!current()) {
        if (found && !('error' in found)) found.capture.jpeg.fill(0);
        return;
      }
      if (found && 'error' in found) return;
      const qr = found ? qrContent(found.text) : null;
      if (found && qr) {
        if (this.qrState === 'scan' && this.picture?.qr?.text === qr.text) {
          found.capture.jpeg.fill(0);
          return;
        }
        // A new code, or the code came back (expired, or the scan was cancelled on the phone).
        this.showFoundQr(found, qr);
        return;
      }
      found?.capture.jpeg.fill(0);
      await this.qrLeft(false, current);
    } finally {
      this.qrChecking = false;
    }
  }

  /** Shows a code found while waiting, in the window now followed. */
  private showFoundQr(found: FoundQr, qr: InputHandoffQr): void {
    this.dropPicture();
    this.picture = { ...found.capture, qr };
    this.qrState = 'scan';
    this.failure = undefined;
    const target = this.target;
    if (target && this.qrBaseline) {
      this.qrBaseline = { ...this.qrBaseline, pid: target.pid, windowIndex: target.window.index, windowTitle: target.window.title };
    }
    this.publish('ready');
  }

  /** The code is no longer on screen; `moved` when the flow went to another window. */
  private async qrLeft(moved: boolean, current: () => boolean): Promise<void> {
    const step = await this.read().catch(() => null);
    if (!current()) return;
    const baseline = this.qrBaseline;
    if (step && actionable(step)) {
      // Something to type next (for example a code sent after the scan).
      this.submissions++;
      this.stepNumber++;
      this.present(step);
      return;
    }
    const navigated = moved || (!!step && !!baseline?.url && !!step.url && step.url !== baseline.url) ||
      (!!step && this.hintsMet(step));
    if (navigated) {
      // The page moved on: the scan went through. Hand back after the usual countdown.
      this.submissions++;
      this.stepNumber++;
      if (step) {
        this.present(step);
        return;
      }
      this.end('succeeded', 'detected');
      return;
    }
    if (this.qrState === 'scanned') return;
    // Still the same page without its code: scanned, and waiting (for example a confirmation on the phone).
    this.dropPicture();
    if (step) this.step = step;
    this.qrState = 'scanned';
    this.publish('ready');
  }

  /** One tap, or typing into the focused field, on a screenshot step; then show what came next. */
  private async submitPicture(
    picture: PictureStep,
    submission: InputHandoffSubmission,
    actor?: InputHandoffHolder,
  ): Promise<boolean> {
    this.busy = true;
    if (actor) this.holder = actor;
    this.clearFinishing();
    this.failure = undefined;
    this.publish('working');
    const before = await this.options.driver.windows().catch(() => null);
    let outcome: boolean | 'origin_changed' = false;
    try {
      outcome = await withDesktopTurn(() => this.performPicture(picture, submission));
    } catch {
      outcome = false;
    } finally {
      for (const key of Object.keys(submission.values)) delete submission.values[key];
    }
    try {
      if (this.ended) return true;
      if (outcome !== 'origin_changed') this.submissions++;
      if (outcome === true) this.answeredOn = actor ?? this.answeredOn;
      const failure: InputHandoffFailure | undefined = outcome === true ? undefined
        : outcome === 'origin_changed' ? 'origin_changed' : 'action_failed';
      await this.sleep(700);
      const windows = await this.options.driver.windows().catch(() => null);
      if (windows) {
        const follow = this.followTarget(windows, before);
        if (follow === 'ended') {
          this.end('succeeded', 'detected');
          return true;
        }
        if (follow) await this.useTarget(follow);
      }
      if (this.ended) return true;
      const step = await this.read().catch(() => null);
      if (step && actionable(step) && !this.pictureChosen) {
        // The screen can be read again and asks for typing: back to the card.
        this.stepNumber++;
        this.failure = failure;
        this.present(step, failure !== undefined);
        return true;
      }
      this.step = step;
      this.failure = failure;
      // A code to scan is (still) there, for example after tapping an expired one to refresh it.
      if (await this.showQr()) {
        this.publish('ready');
        return true;
      }
      if (step && readable(step) && !this.pictureChosen) {
        // Done when nothing is left to type.
        this.stepNumber++;
        this.present(step, failure !== undefined);
        return true;
      }
      // No code any more: stop watching for one while the window is shown as a picture.
      this.stopQr();
      if (!(await this.showPicture())) {
        this.dropPicture();
        this.failure = 'picture_unavailable';
      }
      this.publish('ready');
    } finally {
      this.busy = false;
    }
    return true;
  }

  private async performPicture(
    picture: PictureStep,
    submission: InputHandoffSubmission,
  ): Promise<boolean | 'origin_changed'> {
    const driver = this.options.driver;
    const target = this.target;
    if (this.ended || !target || !driver.pointer) return false;
    const base = { pid: target.pid, window: target.window, windowFrame: picture.windowFrame };
    const action = submission.action;
    let result: NativeActResult;
    if (action.kind === 'tap') {
      const [x, y, w, h] = picture.area;
      result = await driver.pointer({ kind: 'tap', ...base, area: picture.area, point: [x + action.x * w, y + action.y * h] });
    } else {
      const typed = submission.values[INPUT_HANDOFF_PICTURE_TEXT_ID];
      const value = typeof typed === 'string' ? typed : '';
      if (!picture.field || (action.kind === 'fill' && !value)) return false;
      const secure = picture.field === 'password';
      result = await driver.pointer({ kind: 'type', ...base, value, submit: action.kind === 'submit', secure });
      if ('ok' in result && result.ok && secure && value && this.agentControlled) {
        this.options.onSecretEntered?.({ pid: target.pid, ...(this.step?.url ? { url: this.step.url } : {}) });
      }
    }
    if ('error' in result && result.error === 'moved') return 'origin_changed';
    return 'ok' in result && result.ok === true;
  }

  private clearFinishing(): void {
    if (this.finishingTimer) clearTimeout(this.finishingTimer);
    this.finishingTimer = undefined;
    this.finishingUntil = undefined;
  }

  private armWindowWatch(): void {
    if (this.ended) return;
    this.watchTimer = setTimeout(() => {
      void this.checkWindow().catch(() => undefined).finally(() => this.armWindowWatch());
    }, this.options.windowWatchMs ?? WINDOW_WATCH_MS);
    this.watchTimer.unref?.();
  }

  /** Waiting on a form nobody has started answering through the card, so the window is the only news. */
  private watching(): boolean {
    if (this.ended || this.busy || this.phase !== 'ready' || this.qrState || !this.target) return false;
    // Another device holding the card is answering a form, whose fields must not change under it; a sign-in on
    // the window has no form to protect, so taking it over does not stop the watching.
    if (this.holder && !this.directSignInOffered()) return false;
    if (this.picture) return !this.pictureChosen;
    return !!this.step && actionable(this.step) && !this.step.deviceCode;
  }

  /**
   * The owner may finish on the window itself, or close it, without touching
   * the card. Nothing is concluded from what cannot be seen: a window that is
   * minimized, on another desktop or behind another app may just be out of reach.
   */
  private async checkWindow(): Promise<void> {
    if (!this.watching()) {
      this.watchList = null;
      this.fieldsGoneReads = 0;
      this.windowGoneReads = 0;
      return;
    }
    const driver = this.options.driver;
    const target = this.target!;
    const list = await driver.windows().catch(() => null);
    if (!list || !this.watching() || this.target !== target) return;
    const previous = this.watchList;
    this.watchList = list;
    // Coming back from answering or a picture: this read is only the new baseline.
    if (!previous) return;
    const mine = list.apps.find((app) => app.pid === target.pid);
    if (!mine) {
      // Nothing of it on screen: minimized or on another desktop is still there; no window at all, or no program, is gone.
      const all = await driver.windows({ background: true }).catch(() => null);
      if (!this.watching() || this.target !== target) return;
      const entry = all?.apps.find((app) => app.pid === target.pid);
      if (all ? !entry || entry.windows.length === 0 : !(await driver.commandLine(target.pid).catch(() => 'unknown'))) this.noteWindowGone();
      return;
    }
    const known = mine.windows.find((w) => w.index === target.window.index && w.title === target.window.title)
      ?? mine.windows.find((w) => w.title === target.window.title);
    const window = known ?? this.renamedWindow(mine.windows, previous.apps.find((app) => app.pid === target.pid)?.windows);
    if (!window) {
      if (list.frontmost === target.pid) this.noteWindowGone();
      return;
    }
    this.windowGoneReads = 0;
    if (window.minimized) return;
    if (!known) this.target = { ...target, window: { index: window.index, title: window.title } };
    const step = await this.read().catch(() => null);
    // The hold on an unreadable page lasts a while: keep renewing it for as long as the owner may still type.
    if (step?.pageMissing && this.watching()) this.coverUnreadablePage(this.target ?? target);
    if (!step || step.pageMissing || !this.watching()) return;
    // Answering on a picture because nothing could be read: now something can.
    if (this.picture) {
      if (actionable(step)) this.present(step, true);
      return;
    }
    if (!this.step) return;
    if (this.signInMode ? step.signIn : actionable(step)) {
      this.fieldsGoneReads = 0;
      // Whatever page the owner is on is covered, whoever is typing where.
      this.guardSignInPage(step);
      if (fieldShape(step) === fieldShape(this.step)) {
        // Same question: keep the card as it is (a form may be open), but act on the fresh screen.
        this.step = step;
      } else if (!this.holder) {
        this.present(step, true);
      }
      // Held: the holder may be typing in this card's form (the way back from the window); swapping its
      // fields for the new ones would throw the draft away, and the window needs no card update to be used.
      return;
    }
    if (++this.fieldsGoneReads < FIELDS_GONE_READS) return;
    // The fields went away: before calling it done, the next step may be a code to scan (a second factor).
    if (!this.hintsMet(step)) {
      this.step = step;
      const scanning = await this.showQr();
      // The owner may have ended it or started answering meanwhile.
      if (this.ended || this.busy || this.phase !== 'ready') return;
      if (scanning) {
        this.publish('ready');
        return;
      }
    }
    this.present(step, true);
  }

  /**
   * The target's title went away and exactly one new one came, with as many windows as
   * before: a page changed its title, the window is the same. (Another window's title
   * can change as the target closes, say an unread count.)
   */
  private renamedWindow<W extends { title: string }>(windows: W[], before: Array<{ title: string }> | undefined): W | undefined {
    if (before?.length !== windows.length || !before.some((w) => w.title === this.target?.window.title)) return undefined;
    const fresh = windows.filter((w) => !before.some((old) => old.title === w.title));
    return fresh.length === 1 ? fresh[0] : undefined;
  }

  private noteWindowGone(): void {
    if (++this.windowGoneReads < WINDOW_GONE_READS) return;
    if (this.options.completeWhen?.windowClosed) this.end('succeeded', 'detected');
    else this.end('failed', 'failure', 'target_gone');
  }

  private end(status: HandoffResult['status'], reason: HandoffEndReason, failure?: InputHandoffFailure): void {
    if (this.ended) return;
    this.ended = true;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.clearFinishing();
    this.stopQr();
    this.dropPicture();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.failure = failure;
    const phase: InputHandoffPhase = status === 'succeeded' ? 'succeeded' : status === 'expired' ? 'expired'
      : status === 'cancelled' ? 'cancelled' : 'failed';
    this.publish(phase);
    this.options.finish({
      status,
      reason,
      steps: this.submissions,
      ...(failure ? { failure } : {}),
      ...(this.target ? { finalApp: this.target.app } : {}),
      ...(this.target?.window.title ? { finalWindow: this.target.window.title.slice(0, 200) } : {}),
      ...(this.step?.source.origin ? { finalOrigin: this.step.source.origin } : {}),
      ...(this.answeredOn ? { answeredOn: { ...this.answeredOn } } : {}),
      ...(this.ambiguousTitles ? { ambiguousTitles: this.ambiguousTitles } : {}),
    });
  }

  private resolveTarget(list: NativeWindowList): HandoffTarget | null {
    return resolveHandoffTarget(list, this.options.target, this.options.hostPid);
  }

  private async useTarget(target: HandoffTarget): Promise<void> {
    if (this.target?.pid !== target.pid) {
      this.agentControlled = AUTOMATION_FLAGS.test(await this.options.driver.commandLine(target.pid));
    }
    this.target = target;
  }

  /**
   * The window is about to come back where the owner can type in it. Read it first while it is still
   * minimized (accessibility sees it), and cover a sign-in page before it shows; a browser page that
   * cannot be read is covered by its window title, since it may well be one.
   */
  private async coverBeforeRestoring(target: HandoffTarget): Promise<void> {
    const before = await this.read().catch(() => null);
    if (before && !before.pageMissing) {
      this.guardSignInPage(before);
      return;
    }
    this.coverUnreadablePage(target);
  }

  /** A browser page nothing could be read from may well be a sign-in: cover it by its window title before any probe can raise it. */
  private coverUnreadablePage(target: HandoffTarget): void {
    if (isBrowserBundle(target.bundleId)) {
      this.options.onSecretEntered?.({ pid: target.pid, windowTitle: target.window.title });
    }
  }

  /** A minimized window draws nothing and the owner cannot see it: bring it back before asking anything. */
  private async restoreTarget(target: HandoffTarget): Promise<boolean> {
    const driver = this.options.driver;
    if (!target.minimized || !driver.raise) return false;
    await withDesktopTurn(() => driver.raise!(target)).catch(() => null);
    return true;
  }

  /**
   * The first read, given a page time to appear: a browser builds its page for
   * accessibility on demand, and a window just restored is still loading. Other
   * windows answer on the first read.
   */
  private async readFirstStep(restored: boolean): Promise<ExtractedStep | null> {
    const deadline = this.now() + (restored ? RESTORED_PAGE_WAIT_MS : BROWSER_PAGE_WAIT_MS);
    for (;;) {
      const step = await this.read().catch(() => null);
      const waiting = restored ? !step || !actionable(step) : !!step?.pageMissing;
      if (!waiting || this.ended || this.now() >= deadline) return step;
      await this.sleep(350);
      // The page's title is the window's: it may have changed while loading, so find the raised window again.
      if (restored && !step && this.target) {
        const pid = this.target.pid;
        const list = await this.options.driver.windows().catch(() => null);
        const window = list?.apps.find((app) => app.pid === pid)?.windows.find((w) => w.focused && !w.minimized);
        if (window) this.target = { ...this.target, window: { index: window.index, title: window.title } };
      }
    }
  }

  private async read(): Promise<ExtractedStep | null> {
    if (!this.target) return null;
    const raw = await this.options.driver.snapshot(this.target.pid, this.target.window);
    if ('error' in raw) return null;
    this.target = { ...this.target, window: { index: raw.window.index, title: raw.window.title } };
    return extractStep(raw as NativeAxSnapshot);
  }

  private async act(binding: ControlBinding, kind: NativeActKind, value?: string): Promise<boolean> {
    // Checked before every fill and press: an ended request never touches the window again.
    if (this.ended || !this.target) return false;
    const request = { pid: this.target.pid, window: this.target.window, ref: binding.ref, fp: binding.fp, kind, ...(value !== undefined ? { value } : {}) };
    let result: NativeActResult = await this.options.driver.act(request);
    if (!('ok' in result && result.ok) && 'error' in result && result.error === 'stale') {
      // The screen re-rendered; find the same element by identity and retry once.
      const fresh = await this.options.driver.snapshot(this.target.pid, this.target.window);
      if ('error' in fresh) return false;
      const matches = fresh.nodes.filter((node) => node.fp === binding.fp);
      if (matches.length !== 1 || this.ended) return false;
      result = await this.options.driver.act({ ...request, ref: matches[0].ref, window: { index: fresh.window.index, title: fresh.window.title } });
    }
    return 'ok' in result && result.ok === true;
  }

  /** Some forms enable their button only after input events settle. */
  private async pressSettled(binding: ControlBinding & { kind: 'press' }): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.act(binding, 'press')) return true;
      await this.sleep(300);
    }
    return false;
  }

  /** The page a secret is about to go into is still the one the owner was shown. */
  private async sameSurface(step: ExtractedStep): Promise<boolean> {
    if (!this.target) return false;
    const raw = await this.options.driver.snapshot(this.target.pid, this.target.window);
    if ('error' in raw || raw.window.title !== this.target.window.title) return false;
    return extractStep(raw).source.origin === step.source.origin;
  }

  private async perform(step: ExtractedStep, submission: InputHandoffSubmission): Promise<boolean | 'origin_changed'> {
    // Waiting for the desktop may outlast the request (cancelled, timed out, task closed): then nothing is typed.
    if (this.ended) return false;
    let lastText: (ControlBinding & { kind: 'text' }) | undefined;
    let secretEntered = false;
    // Secrets are bound to the page the owner saw: re-check it before typing anything in this step.
    const carriesSecret = step.controls.some((control) => {
      const binding = step.bindings.get(control.id);
      return binding?.kind === 'text' && binding.secure && typeof submission.values[control.id] === 'string';
    });
    if (carriesSecret && !(await this.sameSurface(step))) return 'origin_changed';
    for (const control of step.shown) {
      if (!Object.hasOwn(submission.values, control.id)) continue;
      const value = submission.values[control.id];
      const binding = step.bindings.get(control.id);
      if (binding?.kind !== 'text' || typeof value !== 'string') return false;
      if (!(await this.act(binding, 'text', value))) return false;
      if (binding.secure && !secretEntered) {
        secretEntered = true;
        if (this.agentControlled && this.target) {
          this.options.onSecretEntered?.({ pid: this.target.pid, ...(step.url ? { url: step.url } : {}) });
        }
      }
      lastText = binding;
      await this.sleep(60);
    }
    // The owner only typed; confirm with the page's own main button, as they would, else Return.
    const primary = step.controls.find((control) => control.kind === 'button' && control.primary);
    const button = primary && step.bindings.get(primary.id);
    if (button?.kind === 'press') return this.pressSettled(button);
    const field = lastText ?? [...step.bindings.values()].find((b): b is ControlBinding & { kind: 'text' } => b.kind === 'text');
    return !!field && this.act(field, 'key', 'return');
  }

  /**
   * Wait until the screen stops changing, following the flow into a new
   * window or another app (for example a browser opened for authorization).
   */
  private async awaitSettled(previous: string, before: NativeWindowList | null): Promise<ExtractedStep | 'ended'> {
    const deadline = this.now() + (this.options.settleTimeoutMs ?? 15_000);
    const start = this.now();
    let last: ExtractedStep | null = null;
    let stableReads = 0;
    await this.sleep(400);
    while (!this.ended) {
      const windows = await this.options.driver.windows().catch(() => null);
      if (windows) {
        const asks = last ? actionable(last) : !!this.step && actionable(this.step);
        const follow = this.followTarget(windows, before, asks);
        if (follow === 'ended') return 'ended';
        if (follow && (follow.pid !== this.target?.pid || follow.window.index !== this.target?.window.index ||
            follow.window.title !== this.target?.window.title)) {
          await this.useTarget(follow);
          last = null;
          stableReads = 0;
        }
      }
      const step = await this.read().catch(() => null);
      if (step) {
        if (last && last.signature === step.signature) stableReads++;
        else stableReads = 0;
        last = step;
        const changed = step.signature !== previous;
        if (stableReads >= 1 && !step.pageMissing && (changed || this.now() - start >= 4000)) return step;
      }
      if (this.now() >= deadline) {
        if (last) return last;
        throw new Error('INPUT_HANDOFF_UNREADABLE');
      }
      await this.sleep(350);
    }
    return last ?? 'ended';
  }

  /** Decide which window the flow now lives in. `'ended'` when nothing remains to follow. */
  private followTarget(list: NativeWindowList, before: NativeWindowList | null, currentAsks = false): HandoffTarget | 'ended' | null {
    const current = this.target;
    if (!current) return null;
    const hints = this.options.completeWhen;
    const app = (pid: number) => list.apps.find((entry) => entry.pid === pid);
    const toTarget = (entry: NativeWindowList['apps'][number], window: NativeWindowList['apps'][number]['windows'][number]): HandoffTarget => ({
      pid: entry.pid, app: entry.app, bundleId: entry.bundleId, window: { index: window.index, title: window.title },
    });
    // Another app came to the front (for example the browser for an authorization page). While the
    // form still asks the owner for something, only a window that just opened or changed counts:
    // someone switching to an app they already had open is not where the sign-in went.
    if (list.frontmost !== current.pid && list.frontmost !== this.options.hostPid) {
      const front = app(list.frontmost);
      const window = front?.windows.find((w) => w.focused && !w.minimized) ?? front?.windows.find((w) => !w.minimized);
      const unchanged = !!window && !!before?.apps.find((entry) => entry.pid === list.frontmost)?.windows
        .some((w) => w.index === window.index && w.title === window.title);
      if (front && window && !(currentAsks && unchanged)) return toTarget(front, window);
    }
    const mine = app(current.pid);
    const sameWindow = mine?.windows.find((w) => w.index === current.window.index && w.title === current.window.title)
      ?? mine?.windows.find((w) => w.title === current.window.title);
    // A new window in the same app took focus (dialogs, popups, sign-in windows).
    const focused = mine?.windows.find((w) => w.focused && !w.minimized);
    if (focused && focused !== sameWindow) {
      const existedBefore = before?.apps.find((entry) => entry.pid === current.pid)?.windows
        .some((w) => w.title === focused.title && w.index === focused.index);
      if (!existedBefore || !sameWindow) return toTarget(mine!, focused);
    }
    if (sameWindow) return null;
    // The window closed.
    if (hints?.windowClosed && this.initial && current.pid === this.initial.pid &&
        current.window.title === this.initial.window.title) return 'ended';
    if (mine) {
      const next = mine.windows.find((w) => w.focused && !w.minimized) ?? mine.windows.find((w) => !w.minimized);
      if (next) return toTarget(mine, next);
    }
    const origin = this.initial && app(this.initial.pid);
    if (origin && origin.pid !== current.pid) {
      const next = origin.windows.find((w) => w.focused && !w.minimized) ?? origin.windows.find((w) => !w.minimized);
      if (next) return toTarget(origin, next);
    }
    return 'ended';
  }
}
