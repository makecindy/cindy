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
  private readonly openedSettings = new Map<DesktopPermission, 'standard' | 'separate'>();
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
      ): Promise<boolean>;
      openSettings(permission: DesktopPermission, separateWindow: boolean): Promise<void>;
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
      if (desktopPermissionReady(screenRecording)) this.openedSettings.delete('screenRecording');
      if (desktopPermissionReady(accessibility)) this.openedSettings.delete('accessibility');
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
    this.openedSettings.clear();
    this.guideOpen = false;
  }
  get separateWindowRetries(): DesktopPermission[] {
    return [...this.openedSettings].filter(([, state]) => state === 'standard').map(([permission]) => permission);
  }
  async open(permission: DesktopPermission): Promise<void> {
    if (!this.deps.required || this.opening) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.requestAbort = abort;
    this.opening = true;
    try {
      // A sheet in System Settings can absorb a successful URL dispatch.
      // The retry button opens that pane directly without another OS prompt.
      if (this.openedSettings.get(permission) === 'standard') {
        this.openedSettings.set(permission, 'separate');
        try {
          await this.deps.openSettings(permission, true);
        } catch {
          // Keep the usual pane available when System Settings refuses another instance.
          if (generation === this.generation && this.openedSettings.has(permission)) {
            await this.deps.openSettings(permission, false);
          }
        }
        return;
      }
      const granted = await this.deps
        .request(permission, () => generation === this.generation, abort.signal)
        .catch(() => false);
      if (generation !== this.generation) return;
      if (granted) {
        this.openedSettings.delete(permission);
        return;
      }
      if (!this.openedSettings.has(permission)) this.openedSettings.set(permission, 'standard');
      await this.deps.openSettings(permission, false);
    } finally {
      if (this.requestAbort === abort) this.requestAbort = null;
      this.opening = false;
    }
  }
}
