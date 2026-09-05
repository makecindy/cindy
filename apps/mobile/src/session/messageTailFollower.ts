import {
  createMobileFollowEndPinState,
  evaluateMobileAnchorVerify,
  evaluateMobileFollowEndContentSizePin,
  isMobileMvcpSettling,
  mobileMessageListEndOffset,
  MOBILE_ANCHOR_VERIFY_TOLERANCE,
  type MessageScrollMetrics,
} from './messageScroll';

export interface MobileTailSnapshot {
  metrics: MessageScrollMetrics;
  stickToLatest: boolean;
  userControllingScroll: boolean;
  preservingHistory: boolean;
  layoutSettleAt: number;
  animatedScrollUntil: number;
}

export interface MobileTailFollowerAdapter {
  read: () => MobileTailSnapshot;
  /** Initial / explicit seeking can materialize the last unmeasured virtualized rows. */
  seekEnd: (animated: boolean) => void | Promise<void>;
  /** Correct using the same native coordinate system used to verify the result. */
  correctOffset: (offset: number) => void;
  onMeasurementOscillation?: () => void;
}

/**
 * One tail writer and one bounded reconciliation loop for initial entry, live growth and jumps.
 * History anchoring remains owned by the platform adapter. Gesture release / layout events wake
 * this controller; holding a finger never polls. Presentation (including reveal) owns no scrolling.
 */
export function createMobileTailFollower(adapter: MobileTailFollowerAdapter) {
  let generation = 0;
  let active = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDeadline = 0;
  let resumeTimer: (() => void) | null = null;
  let pendingSeek: object | null = null;
  let pinState = createMobileFollowEndPinState();

  function cancel() {
    generation += 1;
    active = false;
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
    resumeTimer = null;
  }

  function reset() {
    cancel();
    pendingSeek = null;
    pinState = createMobileFollowEndPinState();
  }

  function reconcile() {
    if (pendingSeek) return;
    if (active) {
      const snapshot = adapter.read();
      // A touch can cancel an animation before its old deadline. Wake the same run without
      // renewing its retry budget; schedule still respects gesture/history and measurement guards.
      if (timer !== null
        && Math.max(snapshot.animatedScrollUntil, pinState.suppressedUntil) < timerDeadline) {
        clearTimeout(timer);
        const resume = resumeTimer;
        timer = null;
        resumeTimer = null;
        resume?.();
      }
      return;
    }
    active = true;
    const run = ++generation;
    const schedule = (attempts: number, waitRounds: number) => {
      const snapshot = adapter.read();
      if (!snapshot.stickToLatest || snapshot.userControllingScroll || snapshot.preservingHistory) {
        active = false;
        return;
      }
      const delay = Math.max(snapshot.animatedScrollUntil, pinState.suppressedUntil) - Date.now();
      if (delay > 0) {
        timerDeadline = Date.now() + delay;
        resumeTimer = () => {
          if (generation === run) schedule(attempts, waitRounds);
        };
        timer = setTimeout(() => {
          timer = null;
          resumeTimer = null;
          if (generation === run) schedule(attempts, waitRounds);
        }, delay);
        return;
      }
      frame = requestAnimationFrame(() => {
        if (generation !== run) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (generation !== run) return;
          const current = adapter.read();
          if (!current.stickToLatest || current.userControllingScroll || current.preservingHistory) {
            active = false;
            return;
          }
          // An explicit animation or a measurement circuit may have begun after scheduling.
          if (Math.max(current.animatedScrollUntil, pinState.suppressedUntil) > Date.now()) {
            schedule(attempts, waitRounds);
            return;
          }
          const action = evaluateMobileAnchorVerify({
            attempts,
            waitRounds,
            listVisible: true,
            metrics: current.metrics,
            stickToLatest: current.stickToLatest,
            userControllingScroll: current.userControllingScroll,
            preserveVisibleContentPosition: isMobileMvcpSettling(Date.now(), current.layoutSettleAt),
          });
          if (action === 'settled' || action === 'give-up') {
            active = false;
            return;
          }
          if (action === 'retry') adapter.correctOffset(mobileMessageListEndOffset(current.metrics));
          if (generation !== run) return;
          schedule(attempts + (action === 'retry' ? 1 : 0), waitRounds + (action === 'wait' ? 1 : 0));
        });
      });
    };
    schedule(0, 0);
  }

  function requestEnd(animated: boolean, explicit = false) {
    const snapshot = adapter.read();
    if (!snapshot.stickToLatest || snapshot.preservingHistory) return;
    if (!explicit && snapshot.userControllingScroll) return;
    reset();
    const seek = {};
    pendingSeek = seek;
    const finish = () => {
      if (pendingSeek !== seek) return;
      pendingSeek = null;
      reconcile();
    };
    // LegendList queues seeking by last index. Any offset command would cancel that seek.
    // Its promise settles the command lifecycle, not the native position: verify afterwards.
    const completion = adapter.seekEnd(animated);
    if (completion) void completion.then(finish, finish);
    else finish();
  }

  function contentChanged() {
    if (pendingSeek) return;
    const snapshot = adapter.read();
    if (!snapshot.stickToLatest || snapshot.userControllingScroll || snapshot.preservingHistory) return;
    const { contentHeight, viewportHeight, offsetY } = snapshot.metrics;
    if (contentHeight <= 0 || viewportHeight <= 0) return;
    if (snapshot.animatedScrollUntil <= Date.now()) {
      const decision = evaluateMobileFollowEndContentSizePin(pinState, {
        now: Date.now(), contentHeight,
      });
      if (decision.trippedNow) adapter.onMeasurementOscillation?.();
      // Live growth stays immediate. A short list needs only reconciliation after measurement.
      const end = mobileMessageListEndOffset(snapshot.metrics);
      if (decision.shouldScroll && contentHeight > viewportHeight
        && Math.abs(offsetY - end) > MOBILE_ANCHOR_VERIFY_TOLERANCE) {
        adapter.correctOffset(end);
      }
    }
    reconcile();
  }

  return { requestEnd, contentChanged, reconcile, reset };
}

export type MobileTailFollower = ReturnType<typeof createMobileTailFollower>;
