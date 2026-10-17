import { describe, expect, it } from 'vitest';

import { verifiedInboundMediaMime } from '../inboundMediaVerify';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.7 fake');
const OGG = new TextEncoder().encode('OggS\u0000\u0002rest-of-page');

describe('verifiedInboundMediaMime', () => {
  it('uses the sniffed canonical MIME even when the declared one is generic', () => {
    expect(verifiedInboundMediaMime(PNG, 'application/octet-stream', 'image')).toBe('image/png');
    expect(verifiedInboundMediaMime(OGG, 'audio/ogg; codecs=opus', 'av')).toBe('audio/ogg');
  });

  it('rejects bytes that are not real media, whatever the name or MIME claimed', () => {
    expect(() => verifiedInboundMediaMime(PDF, 'image/png', 'image')).toThrow();
    expect(() => verifiedInboundMediaMime(PDF, 'video/mp4', 'av')).toThrow();
  });

  it('rejects media of the wrong family for the requested store', () => {
    expect(() => verifiedInboundMediaMime(PNG, 'image/png', 'av')).toThrow();
    expect(() => verifiedInboundMediaMime(OGG, 'audio/ogg', 'image')).toThrow();
  });
});
