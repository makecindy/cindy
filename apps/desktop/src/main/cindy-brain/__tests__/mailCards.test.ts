import { expect, it, vi } from 'vitest';
import { MailCardService, renderMailCard } from '../mailCards';
import { GhostCardService, type GhostCardRow } from '../cardService';
import { readMailCard, type MailCardData } from '@cindy/maker-shared/ghost-card-form';
import { sanitizeGhostCardHtml } from '../cardSanitizer';

const snapshot = (extra: Partial<MailCardData> = {}): MailCardData => ({
  accountId: 'account', draftId: 'draft', key: '12345678-1234-1234-1234-123456789abc',
  from: 'Dash <dash@example.test>', attachments: [], state: 'draft', status: 'Synced', sendLabel: 'Send', fromLabel: 'From',
  fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name === 'subject' ? 'Same subject' : name === 'body' ? 'Original' : '' })), ...extra,
});
function fixture() {
  const rows = new Map<string, GhostCardRow>();
  const persist = vi.fn(async (row: GhostCardRow) => { rows.set(row.callId, row); });
  const broadcast = vi.fn();
  const cards = new GhostCardService({ hasCardSlot: () => false, sanitize: sanitizeGhostCardHtml, persist, broadcast });
  const service = new MailCardService({ cards, read: async id => rows.get(id) ?? null,
    list: async session => [...rows.values()].filter(r => r.sessionId === session), persist, broadcast });
  const register = (id: string, ghostId = 'gmail', sessionId = 'session') => cards.registerCall(id, { ghostId, sessionId, toolUseId: null });
  const publish = (id: string, draft = snapshot(), sender = 'gmail') => service.handle(sender, { callId: id, draft }, () => true);
  return { rows, cards, service, register, publish, broadcast };
}
it('updates autosaves in place; a new view collapses old snapshots and rejects late updates', async () => {
  const f = fixture(); f.register('old'); f.register('new');
  expect(await f.publish('old')).toEqual({ ok: true });
  const edited = snapshot(); edited.fields[4].value = 'Edited';
  expect(await f.publish('old', edited)).toEqual({ ok: true });
  expect(f.rows.size).toBe(1);
  expect(await f.publish('new', snapshot())).toEqual({ ok: true });
  const old = f.rows.get('old')!;
  expect(readMailCard(old.html)?.supersededBy).toBe('new');
  expect(readMailCard(old.html)?.fields[4].value).toBe('Edited');
  expect(old.html).not.toContain('data-ghost-action');
  expect(old.html).not.toContain('data-ghost-change');
  expect(await f.publish('old', edited)).toEqual({ ok: false });
  expect(readMailCard(f.rows.get('new')!.html)?.supersededBy).toBeUndefined();
});
it('does not conflate equal subjects across drafts, accounts, plugins or tasks', async () => {
  const f = fixture();
  const cases = [['a', 'gmail', 'session', snapshot()], ['b', 'gmail', 'session', snapshot({ accountId: 'other' })],
    ['c', 'gmail', 'session', snapshot({ draftId: 'other' })], ['d', 'qq', 'session', snapshot()], ['e', 'gmail', 'other', snapshot()]] as const;
  for (const [id, ghost, session, draft] of cases) { f.register(id, ghost, session); expect((await f.publish(id, draft, ghost)).ok).toBe(true); }
  expect([...f.rows.values()].every(r => !readMailCard(r.html)?.supersededBy)).toBe(true);
});
it('rejects unknown/foreign calls and stale owners; a real tool can reopen its persisted view', async () => {
  const f = fixture();
  expect((await f.publish('unknown')).ok).toBe(false);
  f.register('old'); await f.publish('old');
  expect((await f.publish('old', snapshot(), 'qq')).ok).toBe(false);
  f.register('source');
  expect((await f.service.handle('gmail', { callId: 'old', sourceCallId: 'source', draft: snapshot() }, () => false)).ok).toBe(false);
  expect((await f.service.handle('gmail', { callId: 'old', sourceCallId: 'source', draft: snapshot() }, () => true)).ok).toBe(true);
});
it('sent is terminal and cannot restore editing or a second send', async () => {
  const f = fixture(); f.register('old'); await f.publish('old');
  expect((await f.service.handle('gmail', { callId: 'old', statusOnly: { state: 'sent', status: 'Sent', continueLabel: 'Continue' } }, () => true)).ok).toBe(true);
  expect(f.rows.get('old')!.html).not.toContain('mail:send:');
  expect(f.rows.get('old')!.html).toContain('mail:continue:');
  expect((await f.publish('old')).ok).toBe(false);
});
// URL readers previously had no editor binding. Reuse only the latest owned row;
// equal subjects or provider-supplied call IDs cannot authorize a foreign card.
it('resolves draft links within the exact task, provider and mailbox without replacing edits', async () => {
  const f = fixture(); f.register('edited'); f.register('open');
  const draft = snapshot({ state: 'syncing' }); draft.fields[4].value = 'Typing';
  await f.publish('edited', draft);
  const resolve = (sender = 'gmail', session = 'session', source = 'open', account = 'account', id = 'draft', current = true) =>
    f.service.resolveLink(sender, session, source, account, id, () => current);
  expect(await resolve()).toBe('edited');
  expect(readMailCard(f.rows.get('edited')!.html)?.fields[4].value).toBe('Typing');
  expect(await resolve('qq')).toBeUndefined();
  expect(await resolve('gmail', 'other')).toBeUndefined();
  expect(await resolve('gmail', 'session', 'open', 'other')).toBeUndefined();
  expect(await resolve('gmail', 'session', 'open', 'account', 'other')).toBeUndefined();
  expect(await resolve('gmail', 'session', 'open', 'account', 'draft', false)).toBeUndefined();
  f.register('foreign', 'gmail', 'other');
  expect(await resolve('gmail', 'session', 'foreign')).toBeUndefined();
  await f.publish('edited', snapshot({ state: 'sent' }));
  expect(await resolve()).toBeUndefined();
});
// Restore must retain the last synchronized baseline and unsaved view without
// granting another plugin/task access. Existing tests only covered publication.
it('restores both versions only for the active owning call and keeps old cards readable', async () => {
  const f = fixture(); f.register('card'); f.register('source');
  const draft = snapshot();
  draft.baseValues = Object.fromEntries(draft.fields.map(field => [field.name, field.value]));
  draft.fields[4].value = 'Unsaved typing'; draft.state = 'syncing';
  await f.publish('card', draft);
  expect(await f.service.restore('gmail', { callId: 'card', sourceCallId: 'source' }, () => true))
    .toEqual({ ok: true, draft });
  expect((await f.service.restore('qq', { callId: 'card' }, () => true)).ok).toBe(false);
  expect((await f.service.restore('gmail', { callId: 'card' }, () => false)).ok).toBe(false);
  f.register('foreign-task', 'gmail', 'other');
  expect((await f.service.restore('gmail', { callId: 'card', sourceCallId: 'foreign-task' }, () => true)).ok).toBe(false);
  expect((await f.publish('card', { ...draft, baseValues: { ...draft.baseValues, body: 'x'.repeat(16001) } })).ok).toBe(false);
  await f.publish('card', snapshot());
  expect((await f.service.restore('gmail', { callId: 'card' }, () => true)).draft?.baseValues).toBeUndefined();
  await f.publish('card', snapshot({ state: 'sent' }));
  expect((await f.service.restore('gmail', { callId: 'card' }, () => true)).ok).toBe(false);
});
it('keeps sender and body literal; ordinary plugin HTML cannot forge host mail metadata', () => {
  const mail = snapshot({ from: '<img src=x onerror=alert(1)>' });
  mail.fields[4].value = 'Text &lt;img&gt; <script>evil</script> "quoted"';
  const html = renderMailCard(mail);
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(readMailCard(html)).toEqual(mail);
  const sanitized = sanitizeGhostCardHtml(html);
  expect(sanitized.ok).toBe(true);
  if (sanitized.ok) expect(readMailCard(sanitized.html)).toBeNull();
});

it('only drafts with delete support show the button; deleted cards cannot become editable again', async () => {
  const f = fixture(); f.register('draft');
  expect(renderMailCard(snapshot())).not.toContain('mail:delete:');
  await f.publish('draft', snapshot({ deleteLabel: 'Delete draft' }));
  expect(f.rows.get('draft')!.html).toContain('mail:delete:');
  for (const state of ['deleting', 'deleted'] as const) {
    expect((await f.service.handle('gmail', { callId: 'draft', statusOnly: { state, status: state } }, () => true)).ok).toBe(true);
    expect(f.rows.get('draft')!.html).not.toContain('data-ghost-action');
    expect(f.rows.get('draft')!.html).not.toContain('data-ghost-change');
  }
  expect((await f.publish('draft')).ok).toBe(false);
  expect((await f.publish('draft', snapshot({ state: 'sent' }))).ok).toBe(false);
});

it('persists larger HTML drafts as inert metadata without rendering source in the card footer', async () => {
  const f = fixture(); f.register('rich');
  const mail = snapshot();
  mail.fields.push({ name: 'bodyHtml', kind: 'mail-html', label: 'Body', value: '<p>' + 'Long formatted message '.repeat(1800) + '</p>' },
    { name: 'attachmentItems', kind: 'mail-attachments', label: 'Files', value: '[]' });
  expect((await f.publish('rich', mail)).ok).toBe(true);
  expect(readMailCard(f.rows.get('rich')!.html)?.fields.at(-2)?.value).toBe(mail.fields.at(-2)?.value);
  expect(f.rows.get('rich')!.html).not.toContain('<p>Long formatted');
  mail.fields.at(-1)!.value = '{"path":"/private"}';
  expect((await f.publish('rich', mail)).ok).toBe(false);
});
it('publishes undo/send-now only while waiting and removes the deadline after cancellation', async () => {
  const f = fixture(); f.register('card'); await f.publish('card');
  const pendingSend = { deadline: Date.now() + 10000, label: '{seconds}s', cancelLabel: 'Undo', sendNowLabel: 'Send now' };
  expect((await f.service.handle('gmail', { callId: 'card', statusOnly: { state: 'sending', status: 'Waiting', pendingSend } }, () => true)).ok).toBe(true);
  const html = f.rows.get('card')!.html;
  expect(readMailCard(html)?.pendingSend).toEqual(pendingSend);
  expect(html).toContain('mail:cancel:');
  expect(html).toContain('mail:now:');
  expect(html).not.toContain('mail:send:');
  expect(html).not.toContain('data-ghost-change');
  expect((await f.service.handle('gmail', { callId: 'card', statusOnly: { state: 'draft', status: 'Cancelled' } }, () => true)).ok).toBe(true);
  expect(readMailCard(f.rows.get('card')!.html)?.pendingSend).toBeUndefined();
  expect(f.rows.get('card')!.html).not.toContain('mail:now:');
});
