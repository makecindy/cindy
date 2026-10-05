import { describe, expect, it } from 'vitest';
import {
  DESKTOP_MOTION,
  desktopEncoderLimits,
  desktopFrameChange,
  desktopVideoFramerate,
  desktopVideoProfile,
  withDesktopBitrateHints,
} from '../remoteDesktopQuality';

const offer = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 100 101',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1;x-google-min-bitrate=30',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:100 VP8/90000',
  'a=rtpmap:101 rtx/90000',
  'a=fmtp:101 apt=100',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  '',
].join('\r\n');

describe('remote desktop quality tiers', () => {
  it('lets the host own each tier, including the frame-rate ceiling', () => {
    expect(desktopVideoProfile().degradation).toBe('maintain-framerate');
    expect(desktopVideoProfile({ fps: 60, quality: 'hd', audio: false })).toMatchObject({
      degradation: 'maintain-resolution',
      sharpWhenStill: false,
    });
    expect(desktopVideoFramerate({ fps: 60, quality: 'saver', audio: false })).toBe(30);
    expect(desktopVideoFramerate({ fps: 60, quality: 'auto', audio: false })).toBe(60);
    for (const quality of ['auto', 'saver', 'hd'] as const) {
      const p = desktopVideoProfile({ fps: 30, quality, audio: false });
      expect(p.minBitrateKbps).toBeLessThanOrEqual(p.startBitrateKbps);
      expect(p.startBitrateKbps * 1000).toBeLessThanOrEqual(p.maxBitrate);
    }
  });

  it('caps a background viewer at the saver tier without changing its own choice', () => {
    const hd = { fps: 60, quality: 'hd', audio: true } as const;
    expect(desktopEncoderLimits(hd, false)).toEqual({
      maxBitrate: 20_000_000,
      maxFramerate: 60,
      degradation: 'maintain-resolution',
      sharpWhenStill: false,
    });
    expect(desktopEncoderLimits(hd, true)).toEqual({
      maxBitrate: 2_000_000,
      maxFramerate: 30,
      degradation: 'maintain-framerate',
      sharpWhenStill: true,
    });
    expect(hd.quality).toBe('hd');
    const saver = { fps: 30, quality: 'saver', audio: false } as const;
    expect(desktopEncoderLimits(saver, true)).toEqual(desktopEncoderLimits(saver, false));
  });

  it('adds bandwidth hints to every video media codec only', () => {
    const profile = desktopVideoProfile({ fps: 30, quality: 'saver', audio: false });
    const lines = withDesktopBitrateHints(offer, profile).split('\r\n');
    const hints = 'x-google-start-bitrate=1500;x-google-min-bitrate=500;x-google-max-bitrate=2000';
    expect(lines).toContain(`a=fmtp:96 packetization-mode=1;${hints}`);
    expect(lines).toContain(`a=fmtp:100 ${hints}`);
    expect(lines).toContain('a=fmtp:97 apt=96');
    expect(lines).toContain('a=fmtp:101 apt=100');
    expect(lines).toContain('a=fmtp:111 minptime=10;useinbandfec=1');
    // The inserted VP8 line stays inside the video section, before the next m= line.
    expect(lines.indexOf(`a=fmtp:100 ${hints}`)).toBeLessThan(
      lines.indexOf('m=application 9 UDP/DTLS/SCTP webrtc-datachannel'),
    );
    expect(lines.at(-1)).toBe('');
  });

  it('rewrites an fmtp line that precedes its rtpmap instead of adding a second one', () => {
    const profile = desktopVideoProfile();
    const reordered = [
      'm=video 9 UDP/TLS/RTP/SAVPF 100',
      'a=fmtp:100 x-google-min-bitrate=30',
      'a=rtpmap:100 VP8/90000',
      '',
    ].join('\n');
    const lines = withDesktopBitrateHints(reordered, profile).split('\n');
    expect(lines.filter((line) => line.startsWith('a=fmtp:100'))).toEqual([
      'a=fmtp:100 x-google-start-bitrate=4000;x-google-min-bitrate=1000;x-google-max-bitrate=20000',
    ]);
    expect(lines.at(-1)).toBe('');
  });

  it('separates large screen changes from small localized activity', () => {
    const frame = (fill: number) => new Uint8ClampedArray(64 * 36 * 4).fill(fill);
    const still = frame(100);
    expect(desktopFrameChange(still, frame(100))).toBe(0);
    const caret = frame(100);
    caret.set([255, 255, 255, 255], 4 * 500);
    expect(desktopFrameChange(still, caret)).toBeLessThan(DESKTOP_MOTION.changedShare);
    const scrolled = frame(100);
    scrolled.fill(140, 0, scrolled.length / 4);
    expect(desktopFrameChange(still, scrolled)).toBeGreaterThan(DESKTOP_MOTION.changedShare);
    expect(desktopFrameChange(still, new Uint8ClampedArray(4))).toBe(1);
  });
});
