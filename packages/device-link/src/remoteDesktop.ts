import {
  parseClipboardContentRequest,
  type ClipboardContentRequest,
} from "./remoteClipboard";
import {
  isDesktopAttemptId,
  isDesktopIceCursor,
  parseDesktopIceCandidates,
  type RemoteDesktopIceRequest,
} from "./remoteDesktopIce";
/** Additive, same-account business channel. Never broadcast screen data or input. */
export const REMOTE_DESKTOP_CHANNEL = "device-link:remote-desktop:v1";
export const REMOTE_DESKTOP_LEASE_MS = 12_000;
export const REMOTE_DESKTOP_MAX_FRAME_BYTES = 180_000;

export const REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS = 16_384;

export type DesktopInput =
  | { kind: "move"; x: number; y: number }
  | { kind: "button"; button: 0 | 1 | 2; down: boolean; x: number; y: number }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "key"; code: string; down: boolean }
  | { kind: "text"; text: string }
  | { kind: "release" };

export const DESKTOP_KEY_CODES = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => `Key${key}`),
  ..."0123456789".split("").map((key) => `Digit${key}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ControlLeft",
  "AltLeft",
  "MetaLeft",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
] as const;
const codes = new Set<string>(DESKTOP_KEY_CODES);
const unit = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const delta = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 2000;

export function isDesktopInput(value: unknown): value is DesktopInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "release":
      return true;
    case "move":
      return unit(v.x) && unit(v.y);
    case "button":
      return (
        unit(v.x) &&
        unit(v.y) &&
        [0, 1, 2].includes(v.button as number) &&
        typeof v.down === "boolean"
      );
    case "scroll":
      return delta(v.dx) && delta(v.dy);
    case "key":
      return (
        typeof v.code === "string" &&
        codes.has(v.code) &&
        typeof v.down === "boolean"
      );
    case "text":
      return typeof v.text === "string" && v.text.length <= 4096;
    default:
      return false;
  }
}

export interface RemoteDesktopVideoSettings {
  fps: 30 | 60;
  bitrate: 0 | 2_000_000 | 8_000_000 | 20_000_000;
  audio: boolean;
}
export interface RemoteDesktopDisplayMode {
  id: string;
  width: number;
  height: number;
  current: boolean;
  /** Reported by the host OS; absent on older hosts or when unknown. */
  native?: boolean;
}
export interface RemoteDesktopDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
}
export interface RemoteDesktopCapabilities {
  version: 1;
  enabled: boolean;
  canControl: boolean;
  platform: string;
  displays: RemoteDesktopDisplay[];
  /** Optional so older desktops retain their original connection behavior. */
  permissions?: RemoteDesktopPermissions;
  /** Supports resume and preserves explicit local disconnects during recovery. */
  automaticReconnect?: boolean;
  /** Explicit same-account replacement of the active viewer. */
  connectionTakeover?: boolean;
  videoSettings?: boolean;
  trickleIce?: boolean;
  systemAudio?: boolean;
  displayModes?: boolean;
  backgroundViewing?: boolean;
  cursorOverlay?: boolean;
  clipboardText?: boolean;
  clipboardContent?: boolean;
}
export type DesktopPermission = "screenRecording" | "accessibility";
export type DesktopPermissionStatus =
  "granted" | "missing" | "unknown" | "notRequired";
export interface RemoteDesktopPermissions {
  screenRecording: DesktopPermissionStatus;
  accessibility: DesktopPermissionStatus;
}
export function isDesktopPermission(
  value: unknown,
): value is DesktopPermission {
  return value === "screenRecording" || value === "accessibility";
}
export function desktopPermissionReady(
  status: DesktopPermissionStatus,
): boolean {
  return status === "granted" || status === "notRequired";
}
export interface RemoteDesktopLease {
  lease: string;
  display: RemoteDesktopDisplay;
  controlling: boolean;
}
export type RemoteDesktopRequest =
  | RemoteDesktopIceRequest
  | ClipboardContentRequest
  | { op: "capabilities" }
  | { op: "permissions"; action: "check" | "guide" }
  | { op: "start"; displayId: string; resume?: boolean; takeover?: boolean }
  | { op: "heartbeat" | "stop"; lease: string }
  | { op: "frame"; lease: string; cursorOverlay?: boolean }
  | { op: "control" | "presentation"; lease: string; enabled: boolean }
  | { op: "input"; lease: string; sequence: number; events: DesktopInput[] }
  | {
      op: "offer";
      lease: string;
      sdp: string;
      attemptId?: string;
      cursorOverlay?: boolean;
      settings?: RemoteDesktopVideoSettings;
    }
  | { op: "clipboard"; lease: string; action: "copy" }
  | { op: "clipboard"; lease: string; action: "paste"; text: string }
  | { op: "displayModes"; lease: string }
  | { op: "resolution"; lease: string; modeId: string };

export function parseRemoteDesktopRequest(
  value: unknown,
): RemoteDesktopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const v = value as Record<string, unknown>;
  if (v.op === "capabilities") return { op: v.op };
  if (v.op === "permissions" && (v.action === "check" || v.action === "guide"))
    return { op: v.op, action: v.action };
  if (
    v.op === "start" &&
    typeof v.displayId === "string" &&
    v.displayId.length <= 128
  ) {
    if (v.resume !== undefined && typeof v.resume !== "boolean")
      throw new Error("INVALID_REQUEST");
    if (v.takeover !== undefined && typeof v.takeover !== "boolean") throw new Error("INVALID_REQUEST");
    if (v.takeover === true && v.resume === true) throw new Error("INVALID_REQUEST");
    return {
      op: v.op,
      displayId: v.displayId,
      ...(v.takeover === true ? { takeover: true } : {}),
      ...(typeof v.resume === "boolean" ? { resume: v.resume } : {}),
    };
  }
  if (typeof v.lease !== "string" || v.lease.length > 128 || !v.lease)
    throw new Error("INVALID_LEASE");
  const lease = v.lease;
  if (v.op === "ice") {
    if (!isDesktopAttemptId(v.attemptId) || !isDesktopIceCursor(v.after))
      throw new Error("INVALID_REQUEST");
    return {
      op: "ice",
      lease,
      attemptId: v.attemptId,
      after: v.after,
      candidates: parseDesktopIceCandidates(v.candidates),
    };
  }
  if (v.op === "clipboardContent")
    return parseClipboardContentRequest(v, lease);
  if (v.op === "clipboard") {
    if (v.action === "copy") return { op: v.op, lease, action: "copy" };
    if (v.action === "paste" && typeof v.text === "string" && v.text.length > 0 && v.text.length <= REMOTE_DESKTOP_MAX_CLIPBOARD_CHARS)
      return { op: v.op, lease, action: "paste", text: v.text };
    throw new Error("INVALID_REQUEST");
  }
  if (v.op === "frame") {
    if (v.cursorOverlay !== undefined && typeof v.cursorOverlay !== "boolean") throw new Error("INVALID_REQUEST");
    return { op: v.op, lease, ...(v.cursorOverlay === true ? { cursorOverlay: true } : {}) };
  }
  if (v.op === "heartbeat" || v.op === "stop")
    return { op: v.op, lease };
  if (
    (v.op === "control" || v.op === "presentation") &&
    typeof v.enabled === "boolean"
  )
    return { op: v.op, lease, enabled: v.enabled };
  if (v.op === "displayModes") return { op: v.op, lease };
  if (
    v.op === "resolution" &&
    typeof v.modeId === "string" &&
    /^[0-9]{1,10}$/.test(v.modeId)
  )
    return { op: v.op, lease, modeId: v.modeId };
  if (v.op === "offer" && typeof v.sdp === "string" && v.sdp.length <= 64_000) {
    if (v.cursorOverlay !== undefined && typeof v.cursorOverlay !== "boolean")
      throw new Error("INVALID_REQUEST");
    if (v.attemptId !== undefined && !isDesktopAttemptId(v.attemptId))
      throw new Error("INVALID_REQUEST");
    const overlay = {
      ...(v.cursorOverlay === true ? { cursorOverlay: true } : {}),
      ...(v.attemptId === undefined ? {} : { attemptId: v.attemptId }),
    };
    if (v.settings === undefined)
      return { op: v.op, lease, sdp: v.sdp, ...overlay };
    const settings = v.settings as RemoteDesktopVideoSettings;
    if (
      !settings ||
      ![30, 60].includes(settings.fps) ||
      ![0, 2_000_000, 8_000_000, 20_000_000].includes(settings.bitrate) ||
      typeof settings.audio !== "boolean"
    )
      throw new Error("INVALID_REQUEST");
    return {
      op: v.op,
      lease,
      sdp: v.sdp,
      ...overlay,
      settings: {
        fps: settings.fps,
        bitrate: settings.bitrate,
        audio: settings.audio,
      },
    };
  }
  if (
    v.op === "input" &&
    Number.isSafeInteger(v.sequence) &&
    (v.sequence as number) >= 0 &&
    Array.isArray(v.events) &&
    v.events.length <= 64 &&
    v.events.every(isDesktopInput) &&
    JSON.stringify(v.events).length <= 16_384
  ) {
    return {
      op: v.op,
      lease,
      sequence: v.sequence as number,
      events: v.events,
    };
  }
  throw new Error("INVALID_REQUEST");
}
