import { describe, expect, it, vi } from 'vitest';
import { parseAttachmentOssRef } from '@cindy/device-link';
import { parseMailAttachmentUpload } from '../mailAttachmentUpload';
import { uploadRemoteMailAttachment, REMOTE_MAIL_ATTACHMENT_MAX_BYTES } from '../remoteMailAttachment';

// Unit (privacy/protocol boundary): a remote task's mail card gets only an uploaded reference that
// its computer's existing phone-upload check accepts, never this computer's file path.
describe('uploadRemoteMailAttachment', () => {
  it('uploads the chosen file within the mail limit and returns only its reference and name', async () => {
    const upload = vi.fn(async () => ({ key: 'u/1/report.pdf', size: 3, contentType: 'application/pdf', sha256: 'a'.repeat(64) }));
    const { attachment } = await uploadRemoteMailAttachment({ pick: async () => '/Users/me/Private/report.pdf', upload, mimeOf: () => 'application/pdf' });
    expect(upload).toHaveBeenCalledWith('/Users/me/Private/report.pdf', { contentType: 'application/pdf', maxBytes: REMOTE_MAIL_ATTACHMENT_MAX_BYTES });
    expect(attachment?.name).toBe('report.pdf');
    expect(parseMailAttachmentUpload(attachment)).toEqual(attachment);
    expect(parseAttachmentOssRef(attachment!.url)).toMatchObject({ ossKey: 'u/1/report.pdf', size: 3, sha256: 'a'.repeat(64) });
    expect(JSON.stringify(attachment)).not.toContain('/Users/me');
  });

  it('treats a cancelled picker as no attachment', async () => {
    const upload = vi.fn();
    expect(await uploadRemoteMailAttachment({ pick: async () => null, upload, mimeOf: () => '' })).toEqual({ attachment: null });
    expect(upload).not.toHaveBeenCalled();
  });
});
