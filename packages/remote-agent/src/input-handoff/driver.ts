import type { FoundQr, NativeActRequest, NativeActResult, NativeAxSnapshot, NativeWindowList, NativeWindowRef, PointerRequest, WindowCapture, WindowCaptureError } from './types.js';

/** Operating-system surface used by a handoff session; faked in tests. */
export interface HandoffDriver {
  permission(): Promise<'granted' | 'missing' | 'unknown'>;
  requestPermission(): Promise<void>;
  windows(): Promise<NativeWindowList>;
  snapshot(pid: number, window?: NativeWindowRef): Promise<NativeAxSnapshot | { error: string }>;
  act(request: NativeActRequest): Promise<NativeActResult>;
  /** Command line of a process, for agent-controlled target detection only. */
  commandLine(pid: number): Promise<string>;
  /** Screenshot steps. Absent where the platform cannot photograph a single window. */
  capture?(target: { pid: number; window: NativeWindowRef }): Promise<WindowCapture | { error: WindowCaptureError }>;
  focusedField?(pid: number): Promise<{ editable: boolean; secure: boolean }>;
  pointer?(request: PointerRequest): Promise<NativeActResult>;
  /**
   * Scan-to-sign-in: the QR code in the window, cut out of it, or null when it
   * shows none. With `frame` the window is photographed where it is, without
   * bringing it forward (watching a code already shown); otherwise it is raised first.
   */
  qr?(target: { pid: number; window: NativeWindowRef }, frame: number[] | null): Promise<FoundQr | null | { error: WindowCaptureError }>;
  /** Bring the window to the front; its frame and window-server id, for a live view of just that window. */
  raise?(target: { pid: number; window: NativeWindowRef }): Promise<{ frame: number[]; windowId: number } | { error: WindowCaptureError }>;
}

