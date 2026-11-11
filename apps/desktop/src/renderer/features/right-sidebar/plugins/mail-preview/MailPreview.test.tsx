// @vitest-environment jsdom
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GhostCardFormField } from '@cindy/maker-shared/ghost-card-form';
import { createHash } from 'node:crypto';
const h = vi.hoisted(() => ({ read: vi.fn(), owner: 1 }));
vi.mock('../../lib/mailPreview', () => ({ readMailPreview: h.read }));
vi.mock('../../registry', () => ({ registerTabKind: () => {} }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => h.owner, isDataOwnerGenerationCurrent: (o: number) => o === h.owner }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { from?: string; count?: number }) => args ? key + ' ' + (args.from ?? args.count) : key }) }));
vi.mock('@/components/chat/GhostCardForm', () => ({ GhostCardForm: ({ fields, readOnly }: { fields: GhostCardFormField[]; readOnly?: boolean }) => <div data-testid="body" data-readonly={readOnly}>{fields.find(f => f.name === 'body')?.value}</div> }));
vi.mock('@/components/chat/GhostToolCard', () => ({ MailCardEditor: ({ html, callId }: { html: string; callId: string }) => <div data-testid="editor" data-call-id={callId}>{readMailCard(html)?.fields.find(f => f.name === 'body')?.value}</div> }));
import { MailPreviewBody } from './index';
import { MailCardBody } from './MailCardBody';
import { renderMailCard } from '../../../../../main/cindy-brain/mailCards';
import { readMailCard } from '@cindy/maker-shared/ghost-card-form';
import { ingestCardPush } from '@/cindy-brain/ghostCardStore';
const ctx = { tabId: 'tab', sessionId: 'a', workdir: '', remoteHostId: null, deviceLinkDeviceId: null, patchState() {}, onVisibilityChange() {}, setCloseInterceptor: () => () => {} };
const mail = (bodyText: string) => ({ accountId: 'account', messageId: bodyText, from: 'sender', to: 'to', cc: '', bcc: '', subject: 'Subject', date: '', bodyText, bodyHtml: '', attachments: [] });
// Integration through the reader: photo failure must advance exactly once to
// public email/domain/initial fallbacks, without sending a raw email to the CDN.
it('shows sender and recipient avatars and falls back without requesting public mailbox logos', async () => {
  vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer } });
  const photo = 'https://lh3.googleusercontent.com/contact-photo';
  h.read.mockResolvedValue({ message: { ...mail('Readable'), from: 'Person <person@company.example.com>', to: 'Other <other@gmail.com>',
    participantPhotos: [{ email: 'person@company.example.com', url: photo }] } });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  const sender = () => view.container.querySelector<HTMLImageElement>('img[src="' + photo + '"]');
  expect(sender()).not.toBeNull();
  expect(sender()!.getAttribute('referrerpolicy')).toBe('no-referrer');
  await act(async () => { fireEvent.error(sender()!); });
  const hash = createHash('sha256').update('person@company.example.com').digest('hex');
  const publicImage = view.container.querySelector<HTMLImageElement>(`img[src*="${hash}"]`)!;
  expect(publicImage.src).toBe(`https://gravatar.com/avatar/${hash}?s=64&d=404&r=g`);
  await act(async () => { fireEvent.error(publicImage); });
  const logo = view.container.querySelector('img[src*="icons.duckduckgo.com"]')!;
  expect(logo.getAttribute('src')).toBe('https://icons.duckduckgo.com/ip3/company.example.com.ico');
  await act(async () => { fireEvent.error(logo); });
  const recipient = view.container.querySelector('img')!;
  expect(recipient.getAttribute('src')).toContain('gravatar.com/avatar/');
  await act(async () => { fireEvent.error(recipient); });
  expect(view.container.querySelector('img')).toBeNull();
  expect(screen.getByText('Readable')).toBeTruthy();
  expect(screen.getByText('P')).toBeTruthy();
  expect(screen.getByText('O')).toBeTruthy();
});
// The real reader must bound all header positions, not just unique addresses
// or each recipient field separately; every surplus address stays visible.
it.each(['body', 'summary'])('bounds avatar lookups across all headers and duplicates, with sender from %s', async source => {
  const digest = vi.fn(async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer);
  vi.stubGlobal('crypto', { subtle: { digest } });
  const recipients = Array.from({ length: 50 }, () => 'Repeated <repeat@company.example.com>').join(', ');
  h.read.mockResolvedValue({ message: { ...mail('Many recipients'), from: source === 'body' ? 'Owner <owner@company.example.com>' : '',
    to: recipients, cc: 'CC <cc@company.example.com>', bcc: 'BCC <bcc@company.example.com>',
    participantPhotos: [{ email: 'cc@company.example.com', url: 'https://lh3.googleusercontent.com/budget-exceeded' }],
    ...(source === 'summary' ? { conversation: { threadId: 'thread', messages: [{ messageId: 'Many recipients',
      url: 'https://mail.example/a', from: 'Owner <owner@company.example.com>', date: '', subject: '', snippet: '' }] } } : {}) } });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  expect(digest).toHaveBeenCalledTimes(12);
  expect(view.container.querySelectorAll('img')).toHaveLength(12);
  expect(screen.getAllByText('Repeated <repeat@company.example.com>')).toHaveLength(50);
  expect(screen.getByText('CC <cc@company.example.com>')).toBeTruthy();
  expect(screen.getByText('BCC <bcc@company.example.com>')).toBeTruthy();
  await act(async () => { view.container.querySelectorAll('img').forEach(image => fireEvent.error(image)); });
  expect(view.container.querySelectorAll('img')).toHaveLength(12);
  expect([...view.container.querySelectorAll('img')].map(image => image.src))
    .toEqual(Array(12).fill('https://icons.duckduckgo.com/ip3/company.example.com.ico'));
  await act(async () => { view.container.querySelectorAll('img').forEach(image => fireEvent.error(image)); });
  expect(view.container.querySelectorAll('img')).toHaveLength(0);
  expect(digest).toHaveBeenCalledTimes(12);
});

// Unit: plain-text mail previously had no clickable URLs. Only web URLs may
// become actions; local paths and task deep links from senders remain text.
it('makes plain-text mail URLs clickable without interpreting other content', async () => {
  const openExternal = vi.fn(async () => ({ success: true }));
  vi.stubGlobal('electronAPI', { openExternal });
  h.read.mockResolvedValue({ message: mail('Details: https://example.test/page.\n/private/file.png <b>literal</b>') });
  render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  const link = screen.getByRole('link', { name: 'https://example.test/page' });
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(link.parentElement!.textContent).toBe('Details: https://example.test/page.\n/private/file.png <b>literal</b>');
  await act(async () => { fireEvent.click(link); });
  expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/page');
});
// Unit regression: a remote draft binding must not replace the readable mail
// with the local-only editor. Existing link tests only exercised local tasks.
it('keeps remote drafts readable and preserves the mailbox link', async () => {
  const openExternal = vi.fn(async () => ({ success: true }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openExternal } });
  h.read.mockResolvedValue({ message: mail('Remote draft body'), draftCallId: 'remote-draft' });
  render(<MailPreviewBody state={{ url: 'https://mail.example/draft' }} ctx={{ ...ctx, deviceLinkDeviceId: 'peer' }} />);
  await act(async () => {});
  expect(screen.getByText('Remote draft body')).toBeTruthy();
  expect(screen.queryByTestId('editor')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'mailReader.openMailbox' }));
  expect(openExternal).toHaveBeenCalledWith('https://mail.example/draft');
});
it.each(['inactive', 'hidden'])('does not mark a restored %s tab read until it is visible', async kind => {
  h.read.mockResolvedValue({ message: mail('Selected') });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} active={kind !== 'inactive'} shellVisible={kind !== 'hidden'} />);
  await act(async () => {});
  expect(h.read).not.toHaveBeenCalled();
  view.rerender(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} active shellVisible />);
  await act(async () => {});
  expect(h.read).toHaveBeenCalledExactlyOnceWith('a', 'https://mail.example/a', true, null, true, undefined);
  expect(screen.getByText('Selected')).toBeTruthy();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); h.owner = 1; });

// Unit regression: existing tests start with a resolved device. During sidebar
// restoration undefined (unresolved) becomes null (local); JSON array keys used
// to collapse those states, leaving the real reader on loading indefinitely.
it('loads a restored mail when its device resolves and hides it while unresolved', async () => {
  h.read.mockResolvedValue({ message: mail('Restored mail') });
  const state = { url: 'https://mail.example/a' };
  const unresolved = { ...ctx, deviceLinkDeviceId: undefined };
  const view = render(<MailPreviewBody state={state} ctx={unresolved} />);
  await act(async () => {});
  expect(h.read).not.toHaveBeenCalled();
  view.rerender(<MailPreviewBody state={state} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByText('Restored mail')).toBeTruthy();
  expect(h.read).toHaveBeenCalledExactlyOnceWith('a', state.url, true, null, true, undefined);
  view.rerender(<MailPreviewBody state={state} ctx={unresolved} />);
  expect(screen.queryByText('Restored mail')).toBeNull();
  expect(screen.getByText('mailReader.loading')).toBeTruthy();
});

// Restored tabs (or plugin removal after a click) previously misreported a
// missing reader as a mailbox failure. Unit: expose the original URL, no retry loop.
it.each([
  [{ supported: false }, 'mailReader.unavailable'],
  [{ supported: true, error: 'MAIL_PROVIDER_NOT_READY' }, 'mailReader.notReady'],
])('offers a labelled mailbox action without retry when the reader is unavailable: %s', async (response, label) => {
  const openExternal = vi.fn(async () => ({ success: true }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openExternal } });
  h.read.mockResolvedValue(response);
  render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'mailReader.retry' })).toBeNull();
  expect(screen.queryByText('mailReader.failed')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'mailReader.openMailbox' }));
  expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://mail.example/a');
  expect(h.read).toHaveBeenCalledTimes(1);
});

// New sidebar entry: follow host edits/supersession, but never reuse another task's card.
it('shows host edits and the latest card without leaking it when switching tasks', async () => {
  const card = (callId: string, body: string, supersededBy?: string) => ({ callId, ghostId: 'provider', height: 80,
    html: renderMailCard({ accountId: 'account', draftId: 'draft', key: '00000000-0000-0000-0000-000000000000', from: 'sender',
      fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name === 'body' ? body : '' })),
      attachments: [], state: 'draft', status: 'Synced', sendLabel: 'Send', fromLabel: 'From', supersededBy }) });
  const first = card('panel-old', 'First');
  const list = vi.fn().mockResolvedValue({ cards: [first] });
  vi.stubGlobal('electronAPI', undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { ghosts: { listCardsBySession: list } } });
  const view = render(<MailCardBody ctx={ctx} state={{ callId: first.callId }} />);
  await act(async () => {});
  expect(screen.getByText('First')).toBeTruthy();
  act(() => ingestCardPush({ ...card(first.callId, 'Edited in card'), sessionId: 'a', toolUseId: null }));
  expect(screen.getByText('Edited in card')).toBeTruthy();
  const replacement = card('panel-new', 'AI updated');
  list.mockResolvedValue({ cards: [card(first.callId, 'Edited in card', replacement.callId), replacement] });
  await act(async () => ingestCardPush({ ...card(first.callId, 'Edited in card', replacement.callId), sessionId: 'a', toolUseId: null }));
  expect(screen.getByTestId('editor').getAttribute('data-call-id')).toBe(replacement.callId);
  expect(screen.getByText('AI updated')).toBeTruthy();
  list.mockResolvedValue({ cards: [] });
  view.rerender(<MailCardBody ctx={{ ...ctx, sessionId: 'b' }} state={{ callId: first.callId }} />);
  expect(screen.queryByText('AI updated')).toBeNull();
  await act(async () => {});
  expect(screen.queryByTestId('editor')).toBeNull();
  expect(screen.getByText('mailReader.failed')).toBeTruthy();
});
it('never paints a previous mail while switching tasks, including a late response', async () => {
  let first!: (v: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockResolvedValue({ message: mail('Mail B') });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  view.rerender(<MailPreviewBody state={{ url: 'https://mail.example/b' }} ctx={{ ...ctx, sessionId: 'b' }} />);
  await act(async () => {});
  expect(screen.getByText('Mail B')).toBeTruthy();
  await act(async () => { first({ message: mail('Mail A') }); });
  expect(screen.queryByText('Mail A')).toBeNull();
  expect(screen.getByTestId('body').getAttribute('data-readonly')).toBe('true');
});
it('removes already displayed content immediately when the account changes', async () => {
  h.read.mockResolvedValueOnce({ message: mail('Old account') }).mockImplementation(() => new Promise(() => {}));
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByText('Old account')).toBeTruthy();
  h.owner = 2;
  view.rerender(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  expect(screen.queryByText('Old account')).toBeNull();
});
// Clicking a URL used to discard the draft's actions and show a read-only body.
it('opens a link-resolved draft in the existing editor and keeps delivered mail read-only', async () => {
  const card = { callId: 'link-draft', ghostId: 'provider', height: 100, html: renderMailCard({
    accountId: 'account', draftId: 'stable-draft', key: '10000000-0000-0000-0000-000000000000',
    from: 'sender', attachments: [], state: 'draft', status: 'Synced', sendLabel: 'Send', fromLabel: 'From',
    fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name === 'body' ? 'Editable saved draft' : '' })),
  }) };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { ghosts: {
    listCardsBySession: vi.fn(async () => ({ cards: [card] })),
  } } });
  h.read.mockResolvedValueOnce({ message: mail('Read-only copy'), draftCallId: card.callId });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/draft' }} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByTestId('editor').getAttribute('data-call-id')).toBe('link-draft');
  expect(screen.getByText('Editable saved draft')).toBeTruthy();
  expect(screen.queryByText('Read-only copy')).toBeNull();
  h.read.mockResolvedValueOnce({ message: mail('Delivered mail') });
  view.rerender(<MailPreviewBody state={{ url: 'https://mail.example/sent' }} ctx={ctx} />);
  expect(screen.queryByTestId('editor')).toBeNull();
  await act(async () => {});
  expect(screen.getByTestId('body').getAttribute('data-readonly')).toBe('true');
});

// Right-side conversation reader: previous single-message tests did not cover
// chronological neighbors, collapsed middle history or expansion's account boundary.
// Regression: all neighbors used to be collapsed even beside the selected mail.
it('opens the selected mail and two neighbors each side, leaving distant bodies unloaded', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({
    messageId: 'm' + i, url: 'https://mail.example/m' + i, from: 'Sender ' + i, date: '', subject: 'Subject', snippet: 'Snippet ' + i,
  }));
  const selected = { ...mail('Selected body'), messageId: 'm5', from: 'Sender 5', conversation: { threadId: 'thread', messages } };
  h.read.mockResolvedValueOnce({ message: selected }).mockImplementation(async (_session: string, url: string) => ({
    message: { ...mail('Body ' + url.split('/').pop()), messageId: url.split('/').pop(), from: 'Sender ' + url.split('/').pop()!.slice(1) },
  }));
  render(<MailPreviewBody state={{ url: 'https://mail.example/m5' }} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByText('Selected body')).toBeTruthy();
  expect(screen.getByText('Sender 0')).toBeTruthy();
  expect(screen.getByText('Sender 11')).toBeTruthy();
  expect(screen.queryByText('Sender 2')).toBeNull();
  for (const i of [3, 4, 6, 7]) expect(screen.getByText('Body m' + i)).toBeTruthy();
  expect(screen.queryByText('Body m0')).toBeNull();
  expect(screen.queryByText('Body m11')).toBeNull();
  expect(h.read).toHaveBeenCalledTimes(5);
  expect(h.read).toHaveBeenCalledWith('a', 'https://mail.example/m5', true, null, true, undefined);
  for (const i of [3, 4, 6, 7]) expect(h.read).toHaveBeenCalledWith('a', 'https://mail.example/m' + i, true, null, false, undefined);
  fireEvent.click(screen.getAllByRole('button', { name: 'mailReader.showMessages 2' })[0]);
  expect(screen.getByText('Sender 2')).toBeTruthy();
  expect(h.read).toHaveBeenCalledTimes(5);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'mailReader.expandMessage Sender 2' })));
  expect(screen.getByText('Body m2')).toBeTruthy();
  expect(screen.getByText('Selected body')).toBeTruthy();
  expect(h.read).toHaveBeenLastCalledWith('a', 'https://mail.example/m2', true, null, true, undefined);
  fireEvent.click(screen.getByRole('button', { name: 'mailReader.collapseMessage Sender 2' }));
  expect(screen.queryByText('Body m2')).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'mailReader.expandMessage Sender 2' })));
  expect(h.read).toHaveBeenCalledTimes(7);
});
it('rejects a mismatched mailbox on expansion and keeps the selected mail available', async () => {
  const selected = { ...mail('Selected'), conversation: { threadId: 'thread', messages: [
    { messageId: 'Selected', url: 'https://mail.example/a', from: 'Sender', date: '', subject: '', snippet: '' },
    { messageId: 'next', url: 'https://mail.example/next', from: 'Other', date: '', subject: '', snippet: '' },
  ] } };
  h.read.mockResolvedValueOnce({ message: selected }).mockResolvedValueOnce({ message: { ...mail('Wrong account'), accountId: 'other-account', messageId: 'next' } });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByRole('button', { name: 'mailReader.collapseMessage Other' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.queryByText('Wrong account')).toBeNull();
  expect(screen.getByText('mailReader.failed')).toBeTruthy();
  expect(screen.getByText('Selected')).toBeTruthy();
  let late!: (v: unknown) => void;
  h.read.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'mailReader.retry' })));
  h.read.mockResolvedValueOnce({ message: mail('New task') });
  view.rerender(<MailPreviewBody state={{ url: 'https://mail.example/new' }} ctx={{ ...ctx, sessionId: 'new' }} />);
  await act(async () => late({ message: { ...mail('Late body'), messageId: 'next' } }));
  expect(screen.queryByText('Late body')).toBeNull();
  expect(screen.getByText('New task')).toBeTruthy();
});
// Exercise the picker through a real read, then switch tasks to ensure neither
// the selected plugin nor its mailbox body leaks into the new context.
it('chooses a matching plugin only for the current task and mail link', async () => {
  const providers = [{ id: 'root-key', name: 'Mail personal', namespace: null }, { id: 'team-key', name: 'Mail team', namespace: 'team' }];
  h.read.mockResolvedValueOnce({ providers }).mockResolvedValueOnce({ message: mail('Chosen mail'), providerId: 'team-key' });
  const view = render(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={ctx} />);
  await act(async () => {});
  expect(screen.getByText('mailReader.choosePlugin')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mail team · team' })));
  expect(h.read).toHaveBeenLastCalledWith('a', 'https://mail.example/a', true, null, true, 'team-key');
  expect(screen.getByText('Chosen mail')).toBeTruthy();
  h.read.mockResolvedValueOnce({ providers });
  view.rerender(<MailPreviewBody state={{ url: 'https://mail.example/a' }} ctx={{ ...ctx, sessionId: 'b' }} />);
  expect(screen.queryByText('Chosen mail')).toBeNull();
  await act(async () => {});
  expect(h.read).toHaveBeenLastCalledWith('b', 'https://mail.example/a', true, null, true, undefined);
  expect(screen.getByText('mailReader.choosePlugin')).toBeTruthy();
});
