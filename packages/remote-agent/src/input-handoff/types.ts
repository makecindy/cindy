import type { InputHandoffControl, InputHandoffOption } from '@cindy/device-link';

/**
 * Host-side shapes for 代输入. Native nodes come from the macOS AX helper
 * (`macos-input.swift --handoff`); they never contain text-field values.
 */

/**
 * Everything the Host reads on a step. Only text fields and their errors are
 * ever shown to the owner; the rest tells steps apart and finds the page's
 * main button.
 */
export type ScreenControl =
  | InputHandoffControl
  | { id: string; kind: 'button'; label: string; primary?: true; link?: true }
  | { id: string; kind: 'choice'; label: string; options: InputHandoffOption[]; selected?: string }
  | { id: string; kind: 'toggle'; label: string; checked: boolean }
  | { id: string; kind: 'note'; text: string; tone: 'heading' | 'info' };

export interface NativeAxNode {
  ref: string;
  role: string;
  subrole?: string;
  depth: number;
  /** Structure-and-label identity checked again before acting. */
  fp: string;
  title?: string;
  desc?: string;
  placeholder?: string;
  help?: string;
  domId?: string;
  titleElement?: string;
  /** Static text, heading text or the selected title of a pop-up. Never a text-field value. */
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  required?: boolean;
  frame?: number[];
  alert?: boolean;
  secure?: boolean;
  hasValue?: boolean;
  checked?: boolean;
  url?: string;
  options?: string[];
  expanded?: boolean;
}

export interface NativeWindowRef {
  index: number;
  title: string;
}

export interface NativeAxSnapshot {
  pid: number;
  app: string;
  bundleId: string;
  frontmost: boolean;
  window: NativeWindowRef & { frame: number[]; modal?: boolean };
  nodes: NativeAxNode[];
  truncated?: boolean;
  secureFocused?: boolean;
}

export interface NativeWindowList {
  frontmost: number;
  apps: Array<{
    pid: number;
    app: string;
    bundleId: string;
    windows: Array<NativeWindowRef & { frame: number[]; focused: boolean; minimized: boolean }>;
  }>;
}

export type NativeActKind = 'press' | 'text' | 'key';

export interface NativeActRequest {
  pid: number;
  window: NativeWindowRef;
  ref: string;
  fp: string;
  kind: NativeActKind;
  /** Owner value for `text` / key name for `key`. Sent on stdin only. */
  value?: string;
}

export type NativeActResult =
  | { ok: true; method?: string; unverified?: boolean }
  | { ok?: false; error: string };

/**
 * Where the Host acts on the target: the owner's text fields, and the page's
 * main button it presses to confirm. Kept in Main only; never projected.
 */
export type ControlBinding =
  | { kind: 'press'; ref: string; fp: string }
  | { kind: 'text'; ref: string; fp: string; secure: boolean };

/** One step photographed for the owner. In memory only; never written to disk. */
export interface WindowCapture {
  jpeg: Buffer;
  width: number;
  height: number;
  /** Photographed area in screen points (x, y, w, h): the window, clipped to its display. */
  area: number[];
  /** The whole window's frame when photographed; input is refused once it moves. */
  windowFrame: number[];
}

/** `locked`: the screen is locked; nothing was photographed. */
export type WindowCaptureError = 'permission' | 'unavailable' | 'target_gone' | 'locked';

/** A QR code in the target window: the code cut out of it, and what it says. In memory only. */
export interface FoundQr {
  capture: WindowCapture;
  text: string;
}

/** Owner input on a screenshot step. Values travel on stdin only. */
export type PointerRequest =
  | { kind: 'tap'; pid: number; window: NativeWindowRef; windowFrame: number[]; area: number[]; point: [number, number] }
  | { kind: 'type'; pid: number; window: NativeWindowRef; windowFrame: number[]; value: string; submit: boolean; secure: boolean };

export interface HandoffTarget {
  pid: number;
  app: string;
  bundleId: string;
  window: NativeWindowRef;
}
