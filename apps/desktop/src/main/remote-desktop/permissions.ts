import type {
  DesktopPermission,
  RemoteDesktopPermissions,
  DesktopPermissionStatus,
} from '@cindy/device-link';
import { desktopPermissionReady } from '@cindy/device-link';

/** Readiness is independent of the persisted opt-in. Reads never open OS UI. */
export class RemoteDesktopPermissionsService {
  private reading: Promise<RemoteDesktopPermissions> | null = null;
  private generation = 0;
  private opening = false;
  private requestAbort: AbortController | null = null;
  guideOpen = false;
  constructor(
    private readonly deps: {
      required: boolean;
      screen(): DesktopPermissionStatus;
      accessibility(): Promise<DesktopPermissionStatus>;
      request(
        permission: DesktopPermission,
        isCurrent: () => boolean,
        signal: AbortSignal,
      ): Promise<void>;
      openSettings(permission: DesktopPermission): Promise<void>;
      showGuide(): void;
    },
  ) {}
  read(): Promise<RemoteDesktopPermissions> {
    if (!this.deps.required)
      return Promise.resolve({ screenRecording: 'notRequired', accessibility: 'notRequired' });
    if (this.reading) return this.reading;
    this.reading = (async () => {
      const accessibility = await this.deps.accessibility().catch(() => 'unknown' as const);
      let screenRecording: DesktopPermissionStatus = 'unknown';
      try {
        screenRecording = this.deps.screen();
      } catch {
        /* unknown is not granted */
      }
      return { screenRecording, accessibility };
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
  show(): void {
    if (!this.deps.required || this.guideOpen) return;
    this.guideOpen = true;
    this.deps.showGuide();
  }
  async showIfNeeded(stillEnabled: () => boolean): Promise<void> {
    const generation = this.generation;
    const status = await this.read();
    if (
      generation === this.generation &&
      stillEnabled() &&
      (!desktopPermissionReady(status.screenRecording) ||
        !desktopPermissionReady(status.accessibility))
    )
      this.show();
  }
  dismiss(): void {
    this.generation++;
    this.requestAbort?.abort();
    this.guideOpen = false;
  }
  async open(permission: DesktopPermission): Promise<void> {
    if (!this.deps.required || this.opening) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.requestAbort = abort;
    this.opening = true;
    try {
      // A failed prompt must still offer the exact System Settings pane.
      await this.deps
        .request(permission, () => generation === this.generation, abort.signal)
        .catch(() => {});
      if (generation === this.generation) await this.deps.openSettings(permission);
    } finally {
      if (this.requestAbort === abort) this.requestAbort = null;
      this.opening = false;
    }
  }
}
