// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderMailCard } from '../../../../main/cindy-brain/mailCards';
import type { MailCardData } from '@cindy/maker-shared/ghost-card-form';
import { mailCardFooterHtml } from '../mailCardFooter';

const draft = (): MailCardData => ({
  accountId: 'test', draftId: 'test', key: '12345678-1234-1234-1234-123456789abc',
  from: 'self@example.test', attachments: [], state: 'error', status: 'Body conflict',
  sendLabel: 'Send', fromLabel: 'From', deleteLabel: 'Delete',
  fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name })),
});

// Browser srcdoc equality determines navigation: persisted local edits and
// merge baselines must not reload the visible footer while typing in a conflict.
it('keeps the footer document stable across conflict edits but updates actual status/actions', () => {
  const mail = draft();
  const first = mailCardFooterHtml(renderMailCard(mail));
  mail.baseValues = Object.fromEntries(mail.fields.map(f => [f.name, f.value]));
  mail.fields.find(f => f.name === 'body')!.value = 'Continued typing <>&"';
  expect(mailCardFooterHtml(renderMailCard(mail))).toBe(first);
  expect(first).toContain('Body conflict');
  expect(first).toContain('mail:send:');
  expect(first).not.toContain('data-ghost-form');
  expect(first).not.toContain('data-cindy-mail');
  mail.state = 'sent'; mail.status = 'Sent';
  const sent = mailCardFooterHtml(renderMailCard(mail));
  expect(sent).not.toBe(first);
  expect(sent).not.toContain('mail:send:');
  expect(sent).toContain('Sent');
});

it('leaves ordinary plugin cards and their forms intact', () => {
  const html = '<div data-ghost-form="[]">Plugin content</div>';
  expect(mailCardFooterHtml(html)).toBe(html);
});
