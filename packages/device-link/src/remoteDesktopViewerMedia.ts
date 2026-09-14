import {
  isDesktopAttemptId,
  isDesktopIceCursor,
  parseDesktopIceCandidates,
  parseDesktopIceReply,
} from "./remoteDesktopIce.js";
import type {
  RemoteDesktopCapabilities,
  RemoteDesktopLease,
  RemoteDesktopVideoSettings,
} from "./remoteDesktop.js";
import type { DesktopViewerRequest } from "./remoteDesktopViewerSession.js";
import type { DesktopIceServer } from "./remoteDesktopIceConfig.js";

/** Signaling adapter shared by both viewer shells. Media recovery retains the
 * lease; only the browser runtime owns ICE retries and frame handoff.
 */
export class RemoteDesktopViewerMedia {
  private attempt: string | null = null;
  private generation = 0;
  constructor(
    private readonly deps: {
      request: DesktopViewerRequest;
      loadIce: (attemptId: string) => Promise<DesktopIceServer[]>;
      send: (message: object) => void;
      current: () => {
        lease: RemoteDesktopLease;
        caps: RemoteDesktopCapabilities;
        settings: RemoteDesktopVideoSettings;
      } | null;
      onAttempt?: (attempt: string) => void;
      onOfferStart?: (lease: RemoteDesktopLease) => void;
      onOfferSettled?: (lease: RemoteDesktopLease) => void;
      onOfferFailure?: () => void;
    },
  ) {}
  reset(): void {
    this.generation++;
    this.attempt = null;
  }
  matches(attempt: unknown): boolean {
    return attempt === this.attempt;
  }
  get attemptId(): string | undefined {
    return this.attempt ?? undefined;
  }
  async handle(message: Record<string, unknown>): Promise<boolean> {
    if (!["iceConfig", "offer", "ice"].includes(String(message.type)))
      return false;
    const current = this.deps.current();
    if (
      !current ||
      message.epoch !== current.lease.lease ||
      !isDesktopAttemptId(message.attemptId)
    )
      return true;
    const epoch = this.generation;
    const attempt = message.attemptId;
    if (message.type !== "ice") {
      this.attempt = attempt;
      this.deps.onAttempt?.(attempt);
    }
    const valid = () =>
      this.generation === epoch &&
      this.attempt === attempt &&
      this.deps.current()?.lease === current.lease;
    const check = () => {
      if (!valid()) throw new Error("DESKTOP_VIDEO_STOPPED");
    };
    const send = (value: object) => {
      if (valid())
        this.deps.send({
          ...value,
          epoch: current.lease.lease,
          attemptId: attempt,
        });
    };
    if (message.type === "iceConfig") {
      try {
        send({
          type: "iceConfig",
          iceServers: await this.deps.loadIce(attempt),
        });
      } catch (error) {
        if (valid()) throw error;
      }
    } else if (message.type === "offer") {
      if (typeof message.sdp !== "string" || message.sdp.length > 64_000)
        return true;
      this.deps.onOfferStart?.(current.lease);
      try {
        const answer = await this.deps.request<{ sdp: string }>(
          {
            op: "offer",
            lease: current.lease.lease,
            sdp: message.sdp,
            ...(current.caps.trickleIce ? { attemptId: attempt } : {}),
            cursorOverlay: current.caps.cursorOverlay === true,
            ...(current.caps.videoSettings
              ? { settings: current.settings }
              : {}),
          },
          check,
        );
        send({ type: "answer", sdp: answer.sdp });
      } catch (error) {
        const permanent =
          /DESKTOP_(AUDIO_UNAVAILABLE|SCREEN_PERMISSION_REQUIRED|DISABLED|STOPPED|LEASE_EXPIRED)/.test(
            String(error),
          );
        send({ type: "fallback", retry: !permanent });
        if (valid()) this.deps.onOfferFailure?.();
      } finally {
        this.deps.onOfferSettled?.(current.lease);
      }
    } else {
      if (attempt !== this.attempt) return true;
      if (
        !current.caps.trickleIce ||
        !isDesktopIceCursor(message.after) ||
        !Number.isSafeInteger(message.exchangeId)
      )
        return true;
      try {
        const reply = parseDesktopIceReply(
          await this.deps.request(
            {
              op: "ice",
              lease: current.lease.lease,
              attemptId: attempt,
              after: message.after,
              candidates: parseDesktopIceCandidates(message.candidates),
            },
            check,
          ),
        );
        if (reply.attemptId === attempt)
          send({ type: "ice", exchangeId: message.exchangeId, ...reply });
      } catch {
        send({ type: "ice", exchangeId: message.exchangeId, error: true });
      }
    }
    return true;
  }
}
