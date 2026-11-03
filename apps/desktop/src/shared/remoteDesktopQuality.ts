import type { RemoteDesktopVideoSettings } from '@cindy/device-link';

/** Host-owned meaning of each viewer quality tier. Viewers only send the tier,
 * so these values can be tuned without a coordinated viewer release.
 */
export interface DesktopVideoProfile {
  /** WebRTC sender ceiling; congestion control still picks the rate below it. */
  maxBitrate: number;
  /** Bandwidth-estimate floor and starting point, in kbps (SDP x-google-* hints).
   * A near-static desktop sends almost nothing, so one jitter spike can otherwise
   * collapse the estimate to ~100 kbps and pin the encoder to a low resolution. */
  minBitrateKbps: number;
  startBitrateKbps: number;
  /** What WebRTC gives up first while the screen is changing. */
  degradation: 'maintain-framerate' | 'maintain-resolution';
  /** While the screen is (nearly) still, keep full resolution regardless of tier:
   * WebRTC otherwise chooses resolution from bitrate alone, even for static frames. */
  sharpWhenStill: boolean;
  /** Track hint; `text` makes the encoder favour sharp screen content. */
  contentHint: '' | 'text';
  /** First JPEG quality tried for native capture frames (0–1). */
  jpegQuality: number;
  /** macOS: capture physical pixels with this long-edge cap; 0 keeps logical points. */
  physicalMaxEdge: number;
  /** macOS: largest native JPEG frame before quality/scale fallback. */
  maxFrameBytes: number;
  /** Windows helper still reads the legacy bitrate to pick its JPEG budget. */
  windowsBitrate: 0 | 8_000_000 | 20_000_000;
}

const PROFILES: Record<RemoteDesktopVideoSettings['quality'], DesktopVideoProfile> = {
  // Smooth while moving; as sharp as HD whenever the screen is still.
  auto: {
    maxBitrate: 20_000_000,
    minBitrateKbps: 1_000,
    startBitrateKbps: 4_000,
    degradation: 'maintain-framerate',
    sharpWhenStill: true,
    contentHint: '',
    jpegQuality: 0.8,
    physicalMaxEdge: 2560,
    maxFrameBytes: 1_500_000,
    windowsBitrate: 8_000_000,
  },
  // Bounded traffic while moving, but still frames stay readable.
  saver: {
    maxBitrate: 2_000_000,
    minBitrateKbps: 500,
    startBitrateKbps: 1_500,
    degradation: 'maintain-framerate',
    sharpWhenStill: true,
    contentHint: '',
    jpegQuality: 0.65,
    physicalMaxEdge: 0,
    maxFrameBytes: 1_000_000,
    windowsBitrate: 0,
  },
  // Sharp text first; frame rate drops when the link cannot keep up.
  hd: {
    maxBitrate: 20_000_000,
    minBitrateKbps: 1_000,
    startBitrateKbps: 4_000,
    degradation: 'maintain-resolution',
    sharpWhenStill: false,
    contentHint: 'text',
    jpegQuality: 0.9,
    physicalMaxEdge: 3840,
    maxFrameBytes: 3_000_000,
    windowsBitrate: 20_000_000,
  },
};

export function desktopVideoProfile(settings?: RemoteDesktopVideoSettings): DesktopVideoProfile {
  return PROFILES[settings?.quality ?? 'auto'];
}

/** Capture/encode frame rate. Quality tiers never override the viewer's choice. */
export function desktopVideoFramerate(settings?: RemoteDesktopVideoSettings): 30 | 60 {
  return settings?.fps ?? 30;
}

/** Live encoder ceilings. A background viewer (phone picture-in-picture) only
 * shows a small window, so it gets the saver tier at 30 fps until it returns to
 * fullscreen; the viewer's own choice is untouched and applies again once it is back. */
export function desktopEncoderLimits(
  settings: RemoteDesktopVideoSettings,
  background: boolean,
): Pick<DesktopVideoProfile, 'maxBitrate' | 'degradation' | 'sharpWhenStill'> & {
  maxFramerate: 30 | 60;
} {
  const tier: RemoteDesktopVideoSettings = background
    ? { ...settings, quality: 'saver' }
    : settings;
  const { maxBitrate, degradation, sharpWhenStill } = desktopVideoProfile(tier);
  return {
    maxBitrate,
    degradation,
    sharpWhenStill,
    maxFramerate: background ? 30 : desktopVideoFramerate(settings),
  };
}

const BITRATE_HINTS = ['x-google-start-bitrate', 'x-google-min-bitrate', 'x-google-max-bitrate'];
const MEDIA_CODECS = /^(H264|VP8|VP9|AV1|H265)$/i;

/** Adds bandwidth-estimate hints to the viewer's video codecs before the host
 * applies the offer. libwebrtc reads them from the negotiated send codec; viewers
 * that ignore x-google-* parameters are unaffected. */
export function withDesktopBitrateHints(sdp: string, profile: DesktopVideoProfile): string {
  const hints =
    `x-google-start-bitrate=${profile.startBitrateKbps};` +
    `x-google-min-bitrate=${profile.minBitrateKbps};` +
    `x-google-max-bitrate=${Math.round(profile.maxBitrate / 1000)}`;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const trailing = lines.at(-1) === '' ? lines.pop() : undefined;
  // Attribute order inside a media section is free, so collect the section's
  // media payload types before rewriting any fmtp line.
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push([]);
    sections[sections.length - 1].push(line);
  }
  const out = sections.flatMap((section) => {
    if (!section[0]?.startsWith('m=video')) return section;
    const media = new Set<string>();
    for (const line of section) {
      const rtpmap = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);
      if (rtpmap && MEDIA_CODECS.test(rtpmap[2])) media.add(rtpmap[1]);
    }
    const missing = new Set(media);
    const rewritten = section.map((line) => {
      const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (!fmtp || !media.has(fmtp[1])) return line;
      missing.delete(fmtp[1]);
      const kept = fmtp[2]
        .split(';')
        .filter((p) => p && !BITRATE_HINTS.includes(p.split('=')[0].trim()));
      return `a=fmtp:${fmtp[1]} ${[...kept, hints].join(';')}`;
    });
    return [...rewritten, ...[...missing].map((pt) => `a=fmtp:${pt} ${hints}`)];
  });
  if (trailing !== undefined) out.push(trailing);
  return out.join(eol);
}

/** Share of a frame that changed (0–1), from two equally sized RGBA thumbnails.
 * Thumbnails average away small localized activity such as a blinking caret. */
export function desktopFrameChange(previous: Uint8ClampedArray, next: Uint8ClampedArray): number {
  if (previous.length !== next.length || !next.length) return 1;
  let changed = 0;
  for (let i = 0; i < next.length; i += 4) {
    if (
      Math.abs(previous[i] - next[i]) > 10 ||
      Math.abs(previous[i + 1] - next[i + 1]) > 10 ||
      Math.abs(previous[i + 2] - next[i + 2]) > 10
    )
      changed++;
  }
  return changed / (next.length / 4);
}

/** Moving only when a meaningful area changed; still again after a quiet second. */
export const DESKTOP_MOTION = { changedShare: 0.02, stillAfterMs: 1_000 } as const;
