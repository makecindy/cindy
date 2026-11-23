import type { BrowserWindow, WebContents } from 'electron';
import type { SupportedLocale } from '../../shared/locale';
import { CLOUD_LOGIN_WINDOW, type CloudLoginWindowState } from '../../shared/cloudLoginWindow';
import { ResourceUsageWindowController } from '../resource-usage-window/controller';
import { CloudClientError } from './transport';

interface LoginWindowDeps {
  createWindow(): BrowserWindow;
  isOpenSender(sender: WebContents): boolean;
  ownerKey(): string | undefined;
  authorize(
    sender: WebContents,
    deviceId: string,
  ): Promise<NonNullable<CloudLoginWindowState['target']>>;
  invalidate(senderId: number): void;
  title(): string;
}

/** Uses the shared auxiliary lifecycle; owns only the account/target binding. */
export class CloudLoginWindow {
  readonly controller: ResourceUsageWindowController;
  private win: BrowserWindow | null = null;
  private generation = 0;
  private openRequest = 0;
  private binding: {
    owner: string;
    target: NonNullable<CloudLoginWindowState['target']>;
    opener: WebContents;
  } | null = null;

  constructor(private readonly deps: LoginWindowDeps) {
    this.controller = new ResourceUsageWindowController({
      createWindow: () => {
        const win = deps.createWindow();
        this.win = win;
        const id = win.webContents.id;
        win.webContents.once('destroyed', () => deps.invalidate(id));
        win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
          if (this.win !== win || isInPlace || !isMainFrame) return;
          deps.invalidate(id);
          this.generation++;
        });
        return win;
      },
      isOpenSender: deps.isOpenSender,
      // No parent/owner visibility coupling: the client remains usable during login.
      prewarmWork: false,
      pauseWhenHidden: false,
      activityChannel: CLOUD_LOGIN_WINDOW.changed,
      localeChannel: CLOUD_LOGIN_WINDOW.locale,
      activityPayload: () => this.state(),
      resolveNativeTitle: deps.title,
      onActivityChanged: (win, active) => {
        if (!active) {
          deps.invalidate(win.webContents.id);
          // A crashed/reloaded renderer must obtain a new login handle. Its old
          // callbacks cannot complete or cancel the recovered window.
          this.generation++;
        }
      },
      onCloseRequested: (win) => this.close(win.webContents, this.generation),
    });
  }

  async open(sender: WebContents, deviceId: string): Promise<void> {
    if (!this.deps.isOpenSender(sender)) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    const owner = this.deps.ownerKey();
    if (!owner) throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    const request = ++this.openRequest;
    const target = await this.deps.authorize(sender, deviceId);
    if (request !== this.openRequest || owner !== this.deps.ownerKey() || sender.isDestroyed())
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    if (this.binding?.owner !== owner || this.binding.target.deviceId !== deviceId) {
      if (this.win && !this.win.isDestroyed()) this.deps.invalidate(this.win.webContents.id);
      this.generation++;
      this.binding = { owner, target, opener: sender };
    }
    if (!this.controller.open(sender)) {
      this.reset();
      throw new CloudClientError('CLOUD_SETTINGS_UNAVAILABLE');
    }
  }

  state(): CloudLoginWindowState {
    return { generation: this.generation, target: this.binding?.target ?? null };
  }
  assertSender(sender: WebContents): void {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents)
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
  }
  assertCurrent(
    sender: WebContents,
    generation: number,
  ): NonNullable<CloudLoginWindowState['target']> {
    this.assertSender(sender);
    if (
      !this.binding ||
      generation !== this.generation ||
      this.binding.owner !== this.deps.ownerKey()
    )
      throw new CloudClientError('CLOUD_SETTINGS_SCOPE_CHANGED');
    return this.binding.target;
  }
  /** Every generation bump invalidates this window's login sessions, so a
   * superseded generation has nothing left to end. */
  isSuperseded(sender: WebContents, generation: number): boolean {
    this.assertSender(sender);
    return generation < this.generation;
  }
  close(sender: WebContents, generation: number): void {
    this.assertSender(sender);
    if (generation !== this.generation) return;
    this.reset();
  }
  complete(sender: WebContents, generation: number): void {
    this.assertCurrent(sender, generation);
    const opener = this.binding!.opener;
    this.reset();
    // A status notification only; never navigate/focus the user's workspace.
    if (!opener.isDestroyed()) opener.send(CLOUD_LOGIN_WINDOW.completed);
  }
  reset(): void {
    this.openRequest++;
    this.binding = null;
    this.generation++;
    this.controller.hideWithOwner();
  }
  prewarm(): void {
    this.controller.prewarm();
  }
  setLocale(locale: SupportedLocale): void {
    this.controller.setLocale(locale);
  }
  destroy(): void {
    this.reset();
    this.controller.destroyWindow();
    this.win = null;
  }
}
