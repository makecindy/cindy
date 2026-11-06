import { desktopCapturer, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { DesktopCaptureWindow } from '../remote-desktop/captureWindow';
import { enumerateDesktopSources } from '../remote-desktop/captureSource';
import { throwIpcError } from '../utils/ipcValidate';
import { RECORDING_AUDIO, type RecordingAudioOptions, type RecordingAudioError } from '../../shared/recordingAudio';

const hosts = new Map<number, RecordingAudioHost>();
const MAX_PCM_BYTES = 38400; // 100 ms, stereo float32 at 48 kHz; never retain history.
let registered = false;

export function registerRecordingAudioIpc(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle(RECORDING_AUDIO.REGISTER, (event) => {
    const host = hosts.get(event.sender.id);
    if (!host) return throwIpcError('PERMISSION_DENIED', 'Invalid recording process');
    host.window.registered(event);
    return host.options;
  });
  ipcMain.on(RECORDING_AUDIO.DATA, (event, bytes: unknown) => {
    const host = hosts.get(event.sender.id);
    if (!host || event.senderFrame !== event.sender.mainFrame) return;
    try { host.window.assertSender(event as IpcMainInvokeEvent); } catch { return; }
    host.accept(bytes);
  });
  ipcMain.on(RECORDING_AUDIO.STATE, (event, error: unknown) => {
    const host = hosts.get(event.sender.id);
    if (!host || event.senderFrame !== event.sender.mainFrame) return;
    try { host.window.assertSender(event as IpcMainInvokeEvent); } catch { return; }
    if (error === undefined) host.ready();
    else host.fail(error === 'systemAudioFailed' || error === 'microphoneFailed' ? error : 'audioFailed');
  });
}

/** Owns only this local recording's audio. Destroying the capture process revokes
 * even uncooperative media streams; the reusable screenshot UI never gets one. */
export class RecordingAudioHost {
  readonly window: DesktopCaptureWindow;
  private samples = new Uint8Array(0);
  private failure: RecordingAudioError | null = null;
  private stopped = false;
  private lastData = Date.now();
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(readonly options: RecordingAudioOptions, private readonly displayId: number) {
    this.window = new DesktopCaptureWindow(() => this.fail('audioFailed'), 'recording', options);
  }

  async start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Permission prompts can remain open; cancellation still destroys the owner.
    const timer = setTimeout(() => this.fail('audioFailed'), 60_000);
    try {
      const starting = this.window.start();
      const completed = Promise.all([starting, ready]);
      // Window construction can fail before there is an owner to register.
      // Observe both promises even if the synchronous setup below then fails.
      void completed.catch(() => {});
      const owner = this.window.contents;
      if (!owner) throw new Error('audioFailed');
      hosts.set(owner.id, this);
      owner.session.setDisplayMediaRequestHandler((request, callback) => {
        if (this.stopped || !this.options.system || request.frame !== owner.mainFrame || !request.videoRequested || !request.audioRequested) {
          callback({}); return;
        }
        void enumerateDesktopSources(() => desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }), 5000)
          .then(sources => {
            const source = sources.find(item => item.display_id === String(this.displayId));
            // Only the isolated capture process receives a video source. Its
            // video is immediately stopped; no uncropped pixels leave it.
            callback(!this.stopped && !owner.isDestroyed() && this.window.contents === owner && source
              ? { video: source, audio: 'loopback' } : {});
          }, () => callback({}));
      });
      await completed;
    } catch (error) {
      this.stop();
      throw error;
    } finally { clearTimeout(timer); }
  }

  ready(): void { this.lastData = Date.now(); this.resolveReady?.(); this.resolveReady = this.rejectReady = null; }
  fail(error: RecordingAudioError): void { this.failure = error; this.stop(); }
  accept(raw: unknown): void {
    if (this.stopped) return;
    if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_PCM_BYTES || raw.length % 8) { this.fail('audioFailed'); return; }
    this.lastData = Date.now();
    const keep = Math.min(this.samples.length, MAX_PCM_BYTES - raw.length);
    const next = new Uint8Array(keep + raw.length);
    next.set(this.samples.subarray(this.samples.length - keep)); next.set(raw, keep);
    this.samples = next;
  }
  read(): Uint8Array {
    if (!this.stopped && Date.now() - this.lastData > 3000) this.fail('audioFailed');
    if (this.stopped) return throwIpcError('INTERNAL', this.failure ?? 'audioFailed');
    const result = this.samples; this.samples = new Uint8Array(0); return result;
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectReady?.(new Error(this.failure ?? 'audioFailed'));
    this.resolveReady = this.rejectReady = null;
    const owner = this.window.contents;
    if (owner) hosts.delete(owner.id);
    this.window.dispose();
    this.samples = new Uint8Array(0);
  }
}
