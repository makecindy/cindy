import {
  isPointInsideAnyWindow,
  resolveSessionDragPreviewBounds,
  type ScreenPoint,
  type WindowBounds,
} from './windowBounds.js';
import type { SessionDragPreviewPalette } from '../shared/sessionDragPreview.js';

export interface SessionDragPreviewScreenLike {
  getCursorScreenPoint(): ScreenPoint;
  getDisplayNearestPoint(point: ScreenPoint): { workArea: WindowBounds };
}

export interface SessionDragPreviewWindowLike {
  readonly ready: Promise<void>;
  isDestroyed(): boolean;
  setPosition(x: number, y: number, animate?: boolean): void;
  setOpacity(opacity: number): void;
  showInactive(): void;
  hide(): void;
  close(): void;
}

export interface SessionDragPreviewControllerDeps {
  screen: SessionDragPreviewScreenLike;
  getAppWindowBounds: () => readonly WindowBounds[];
  createPreviewWindow: (
    label: string,
    palette: SessionDragPreviewPalette,
  ) => SessionDragPreviewWindowLike;
  onStopped?: (token: number) => void;
  intervalMs?: number;
  maxDurationMs?: number;
}

interface ActiveSessionDrag {
  owner: object;
  token: number;
  label: string;
  startedAt: number;
  preview: SessionDragPreviewWindowLike | null;
  previewReady: boolean;
  previewVisible: boolean;
  isOutside: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

const DEFAULT_INTERVAL_MS = 16;
const DEFAULT_MAX_DURATION_MS = 30_000;

/**
 * Drives the short-lived native preview shown only outside Cindy windows.
 *
 * The HTML5 drag image is transparent, so this controller owns the visible
 * preview and can hide it while the cursor is over any Cindy app window. Main
 * reads screen coordinates to keep the preview correct across displays and
 * renderer zoom levels.
 */
export class SessionDragPreviewController {
  private active: ActiveSessionDrag | null = null;
  private nextToken = 1;

  constructor(private readonly deps: SessionDragPreviewControllerDeps) {}

  begin(owner: object, labelInput: string, palette: SessionDragPreviewPalette): number | null {
    if (this.active?.owner && this.active.owner !== owner) return null;
    this.stop();

    const active: ActiveSessionDrag = {
      owner,
      token: this.nextToken++,
      label: labelInput,
      startedAt: Date.now(),
      preview: null,
      previewReady: false,
      previewVisible: false,
      isOutside: false,
      timer: null,
    };
    this.active = active;
    this.preparePreview(active, palette);
    this.tick(active);
    active.timer = setInterval(
      () => this.tick(active),
      this.deps.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    return active.token;
  }

  end(owner?: object): boolean {
    if (owner !== undefined && this.active?.owner !== owner) return false;
    return this.stop();
  }

  isActive(): boolean {
    return this.active !== null;
  }

  endByToken(token: number): boolean {
    if (this.active?.token !== token) return false;
    return this.stop(this.active.owner);
  }

  private preparePreview(active: ActiveSessionDrag, palette: SessionDragPreviewPalette): void {
    const preview = this.deps.createPreviewWindow(active.label, palette);
    active.preview = preview;
    void preview.ready.then(() => {
      if (this.active !== active || preview.isDestroyed()) return;
      active.previewReady = true;
      if (active.isOutside && !active.previewVisible) {
        preview.showInactive();
        active.previewVisible = true;
      }
    });
  }

  private tick(active: ActiveSessionDrag): void {
    if (this.active !== active) return;
    if (Date.now() - active.startedAt > (this.deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)) {
      this.stop(active.owner);
      return;
    }

    const point = this.deps.screen.getCursorScreenPoint();
    active.isOutside = !isPointInsideAnyWindow(point, this.deps.getAppWindowBounds());

    if (!active.isOutside) {
      if (active.preview && active.previewVisible && !active.preview.isDestroyed()) {
        active.preview.hide();
        active.previewVisible = false;
      }
      return;
    }

    const preview = active.preview;
    if (!preview || preview.isDestroyed()) {
      this.stop(active.owner);
      return;
    }

    const workArea = this.deps.screen.getDisplayNearestPoint(point).workArea;
    const bounds = resolveSessionDragPreviewBounds(point, workArea);
    preview.setPosition(bounds.x, bounds.y, false);
    if (active.previewReady && !active.previewVisible) {
      preview.showInactive();
      active.previewVisible = true;
    }
  }

  private stop(owner?: object): boolean {
    if (owner !== undefined && this.active?.owner !== owner) return false;
    const active = this.active;
    this.active = null;
    if (!active) return false;
    this.deps.onStopped?.(active.token);
    if (active.timer) clearInterval(active.timer);
    const preview = active.preview;
    if (preview && !preview.isDestroyed()) {
      // Hide synchronously on release. BrowserWindow.close() can spend a
      // noticeable amount of time in native window teardown, so do not make
      // the visible drag-end path wait for it.
      preview.hide();
      setTimeout(() => {
        // A test double or future window implementation may reuse the same
        // BrowserWindow for a new drag; never tear down that new preview.
        if (this.active?.preview === preview || preview.isDestroyed()) return;
        // Opacity zero is a second guard for a delayed native close after the
        // synchronous hide call has already returned.
        preview.setOpacity(0);
        preview.close();
      }, 0);
    }
    return true;
  }
}
