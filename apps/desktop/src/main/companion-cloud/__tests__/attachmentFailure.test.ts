import { describe, expect, it } from 'vitest';
import { isTransientAttachmentFailure } from '../types.js';

describe('attachment failures', () => {
  it('retries what may still come and gives up only on what never will', () => {
    const status = (code: number) => Object.assign(new Error('MEDIA_UPLOAD_FAILED'), { status: code });
    for (const error of [new Error('MEDIA_DOWNLOAD_FAILED'), new Error('ECONNRESET'), new Error('net::ERR_INTERNET_DISCONNECTED'),
      new TypeError('fetch failed'), Object.assign(new Error('timed out'), { name: 'TimeoutError' }), status(503), status(429),
      // An expired signed address, upload or download.
      status(403), status(401), Object.assign(new Error('MEDIA_DOWNLOAD_FAILED'), { status: 403 })]) {
      expect(isTransientAttachmentFailure(error)).toBe(true);
    }
    for (const error of [new Error('ATTACHMENT_TOO_LARGE'), new Error('ATTACHMENT_UNAVAILABLE'), new Error('INVALID_MEDIA_SIZE'),
      new Error('MEDIA_UNAVAILABLE'), status(404), status(413),
      // The chat server refusing the file is not a signature to renew.
      Object.assign(new Error('FORBIDDEN'), { status: 403 }),
      Object.assign(new Error('MEDIA_DOWNLOAD_FAILED'), { status: 404 }), 'nope']) {
      expect(isTransientAttachmentFailure(error)).toBe(false);
    }
  });
});
