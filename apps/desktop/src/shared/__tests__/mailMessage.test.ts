import { expect, it } from 'vitest';
import { parseMailMessage, parseMailReader, mailMessageFields } from '@cindy/maker-shared/mail-message';
import { validateGhostManifest } from '../ghost';
import { validateGhostManifest as validateProtocolManifest } from '@cindy/plugin-protocol';
// Unit: protocol and installer must reject an unusable known capability, not
// silently accept it as a future extension (PR #6404 review). Prior tests only
// exercised reader shape; malformed mail and cross-field links were accepted.
it('validates mail and reader dependencies in both manifest entry points', () => {
  for (const schemaVersion of [2, 3]) for (const validate of [validateGhostManifest, validateProtocolManifest]) {
    const base = { schemaVersion, ...(schemaVersion === 2 ? { slots: ['tool'] } : { minCindyVersion: '0.1.92' }),
      id: 'example-mail', name: 'Mail', version: '1.0.0', entry: 'main.js',
      tools: [{ name: 'read_mail', description: 'Read only' }] };
    for (const mail of [false, 'yes', null, {}, []]) expect(validate({ ...base, mail }).ok).toBe(false);
    const valid = validate({ ...base, mail: true });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.manifest.mail).toBe(true);
    const mailReader = { tool: 'read_mail', hosts: ['mail.example.com'] };
    for (const patch of [{}, { mail: true, tools: undefined }, { mail: true, tools: [{ name: 'other', description: 'Other' }] }]) {
      expect(validate({ ...base, mailReader, ...patch }).ok).toBe(false);
    }
    expect(validate({ ...base, mail: true, mailReader }).ok).toBe(true);
  }
});
it.each([null, false, [], { tool: 'read_mail', hosts: 'mail.example.com' }, { tool: 'read_mail', hosts: ['*.com'] }, { hosts: ['mail.example.com'] },
  ...[false, 'false', 'true', 0, 1, null, {}, []].map(markRead => ({ tool: 'read_mail', hosts: ['mail.example.com'], markRead })),
].map(mailReader => ({ mailReader })))('rejects a malformed known mailReader declaration: $mailReader', ({ mailReader }) => {
  expect(parseMailReader(mailReader)).toBeNull();
  for (const validate of [validateGhostManifest, validateProtocolManifest]) {
    const result = validate({ schemaVersion: 3, minCindyVersion: '0.1.92', id: 'example-mail', name: 'Mail', version: '1.0.0', entry: 'main.js', mailReader });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('mailReader');
  }
});
it.each([undefined, true])('preserves a valid reader and future metadata through normalization (markRead=%j)', markRead => {
  const reader = { tool: 'read_mail', hosts: ['mail.example.com'], ...(markRead === undefined ? {} : { markRead }), future: { mode: 'extension' } };
  expect(parseMailReader(reader)).toEqual({ tool: reader.tool, hosts: reader.hosts, ...(markRead === undefined ? {} : { markRead }) });
  const result = validateGhostManifest({ schemaVersion: 3, minCindyVersion: '0.1.92', id: 'example-mail', name: 'Mail', version: '1.0.0', entry: 'main.js', agent: {}, mail: true, mailReader: reader,
    tools: [{ name: 'read_mail', description: 'Read only', parameters: { type: 'object', properties: {} } }] });
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  if (result.ok) expect(result.manifest.mailReader).toEqual(reader);
  if (result.ok) {
    const protocol = validateProtocolManifest(result.manifest);
    expect(protocol.ok).toBe(true);
    if (protocol.ok) expect(protocol.manifest.mailReader).toEqual(reader);
  }
  expect(parseMailReader({ tool: 'read_mail', hosts: ['*.com'] })).toBeNull();
});
it('accepts large read-only HTML, filters untrusted preview URLs and preserves CID', () => {
  const message = parseMailMessage({ accountId: 'a', messageId: 'm', from: 'A', to: 'B', cc: '', bcc: '', subject: 'Subject', date: '', bodyText: 'text', bodyHtml: '<p>' + 'x'.repeat(70000) + '</p>',
    attachments: [{ key: 'part', filename: 'image.png', contentId: 'photo', previewUrl: 'https://tracker.example/a' }] });
  expect(message).not.toBeNull();
  expect(message!.attachments[0].previewUrl).toBeUndefined();
  expect(message!.attachments[0].contentId).toBe('photo');
  expect(mailMessageFields(message!, k => k).some(f => f.kind === 'mail-html')).toBe(true);
});
it('drops invalid history without losing the selected message or accepting duplicate IDs', () => {
  const mail = { accountId: 'a', messageId: 'm', from: '', to: '', cc: '', bcc: '', subject: '', date: '', bodyText: 'selected', bodyHtml: '', attachments: [] };
  const summary = { messageId: 'm', url: 'https://mail.example.com/m', from: '', date: '', subject: '', snippet: '' };
  for (const messages of [[summary, summary], [{ ...summary, messageId: 'other' }], [{ ...summary, url: 'javascript:alert(1)' }]]) {
    const parsed = parseMailMessage({ ...mail, conversation: { threadId: 'thread', messages } });
    expect(parsed?.bodyText).toBe('selected');
    expect(parsed?.conversation).toBeUndefined();
    expect(parsed?.conversationUnavailable).toBe(true);
  }
});
// Provider photo metadata is optional: invalid images must not lose the mail or
// introduce file/script/custom-protocol access in the reader (including peers).
it('keeps only bounded, normalized email photos with credential-free HTTPS URLs', () => {
  const mail = { accountId: 'a', messageId: 'm', from: '', to: '', cc: '', bcc: '', subject: '', date: '', bodyText: 'selected', bodyHtml: '', attachments: [] };
  const photo = { email: 'person@example.test', url: 'https://photos.example.test/photo.png' };
  const invalid = ['file:///secret.png', 'javascript:alert(1)', 'http://photos.example.test/a', 'https://user:pass@photos.example.test/a', 'https://photos.example.test:123/a'];
  const parsed = parseMailMessage({ ...mail, participantPhotos: [photo, ...invalid.map(url => ({ ...photo, url })), { ...photo, email: 'Not an email' }] });
  expect(parsed?.participantPhotos).toEqual([photo]);
  expect(parsed?.bodyText).toBe('selected');
  expect(parseMailMessage(mail)?.participantPhotos).toBeUndefined();
  expect(parseMailMessage({ ...mail, participantPhotos: Array(100).fill(photo) })?.participantPhotos).toHaveLength(64);
});
