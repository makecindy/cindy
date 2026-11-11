import { describe, expect, it } from 'vitest';

import { audioVideoMimeOf, classifyInboundAttachment } from '../inboundKind.js';

describe('audioVideoMimeOf', () => {
  it('trusts an audio/video MIME and normalizes parameters', () => {
    expect(audioVideoMimeOf('Video/MP4; codecs=avc1', 'x.bin')).toBe('video/mp4');
    expect(audioVideoMimeOf('audio/ogg', undefined)).toBe('audio/ogg');
  });

  it('falls back to the extension when the MIME is generic or missing', () => {
    expect(audioVideoMimeOf('application/octet-stream', 'clip.MP4')).toBe('video/mp4');
    expect(audioVideoMimeOf(undefined, 'voice.m4a')).toBe('audio/mp4');
    expect(audioVideoMimeOf('', 'movie.mkv')).toBe('video/x-matroska');
  });

  it('returns null for non audio/video files', () => {
    expect(audioVideoMimeOf('application/pdf', 'report.pdf')).toBeNull();
    expect(audioVideoMimeOf('application/octet-stream', 'archive.zip')).toBeNull();
    expect(audioVideoMimeOf(undefined, undefined)).toBeNull();
  });
});

describe('classifyInboundAttachment', () => {
  it.each([
    ['image/PNG', 'x.bin', 'image', 'image/png'],
    ['application/octet-stream', 'scan.JPG', 'image', 'image/jpeg'],
    [undefined, 'photo.webp', 'image', 'image/webp'],
    ['application/octet-stream', 'clip.mp4', 'av', 'video/mp4'],
    ['audio/ogg', 'voice.bin', 'av', 'audio/ogg'],
    ['application/pdf', 'report.pdf', 'file', 'application/pdf'],
    [undefined, 'archive.zip', 'file', 'application/octet-stream'],
  ])('%s + %s → %s (%s)', (mime, name, kind, mimeType) => {
    expect(classifyInboundAttachment(mime, name)).toEqual({ kind, mimeType });
  });
});
