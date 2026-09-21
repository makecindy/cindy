import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';

/** One system-approved stream per lease, independent of WebRTC attempt lifetime.
 * Relay frames and peer clones share this source; neither may reopen the picker. */
export class PortalCaptureStream {
  private lease: string | null = null;
  private pending: Promise<MediaStream> | null = null;
  private stream: MediaStream | null = null;
  private error: Error | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly ended: () => void) {}

  prepare(lease: string): void {
    if (this.lease === lease) return;
    this.stop();
    this.lease = lease;
    const generation = this.generation;
    const current = () => this.generation === generation;
    // User interaction is not a five-second enumeration. RPCs remain short and
    // can keep the lease alive while the local system picker waits for consent.
    this.timer = setTimeout(() => {
      if (current()) {
        this.stop();
        this.ended();
      }
    }, 120_000);
    this.pending = navigator.mediaDevices
      .getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: 30, max: 60 } },
      })
      .then((stream) => {
        if (!current()) {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error('DESKTOP_VIDEO_STOPPED');
        }
        clearTimeout(this.timer);
        this.stream = stream;
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
        track.addEventListener(
          'ended',
          () => {
            if (current()) {
              this.stop();
              this.ended();
            }
          },
          { once: true },
        );
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.srcObject = stream;
        void this.video.play().catch(() => {
          if (current()) {
            this.stop();
            this.ended();
          }
        });
        return stream;
      })
      .catch((error: unknown) => {
        if (current()) {
          clearTimeout(this.timer);
          this.error = new Error('DESKTOP_VIDEO_UNAVAILABLE');
          this.stream?.getTracks().forEach((track) => track.stop());
          this.stream = null;
        }
        throw error;
      });
    // Preparation has no awaiting RPC. Keep failure sticky for this lease so
    // fallback polling cannot turn a denied picker into an authorization loop.
    void this.pending.catch(() => {});
  }

  async capture(lease: string): Promise<MediaStream> {
    if (lease !== this.lease || !this.pending) throw new Error('DESKTOP_VIDEO_STOPPED');
    const generation = this.generation;
    const stream = await this.pending;
    if (generation !== this.generation || this.error || !stream.active)
      throw new Error('DESKTOP_VIDEO_STOPPED');
    return stream.clone(); // Peer shutdown must not stop the portal owner.
  }

  frame(lease: string): string | null {
    if (lease !== this.lease) throw new Error('DESKTOP_VIDEO_STOPPED');
    if (this.error) throw this.error;
    const video = this.video;
    const track = this.stream?.getVideoTracks()[0];
    if (
      !video ||
      !track ||
      track.muted ||
      track.readyState !== 'live' ||
      video.readyState < 2 ||
      !video.videoWidth ||
      !video.videoHeight
    )
      return null;
    const canvas = document.createElement('canvas');
    let scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    for (let attempt = 0; attempt < 4; attempt++, scale *= 0.75) {
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.55);
      if (!data.startsWith('data:image/jpeg;base64,')) return null;
      const jpeg = data.slice('data:image/jpeg;base64,'.length);
      if (jpeg.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4) return jpeg;
    }
    return null;
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.pending = null;
    this.error = null;
    this.lease = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
  }
}
