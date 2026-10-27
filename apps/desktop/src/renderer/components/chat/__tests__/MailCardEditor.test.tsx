// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MailCardEditor } from '../GhostToolCard';
import { renderMailCard } from '../../../../main/cindy-brain/mailCards';
import { ingestCardPush } from '@/cindy-brain/ghostCardStore';
import type { MailCardData } from '@cindy/maker-shared/ghost-card-form';
import { pendingGhostCardFormDelivery } from '@cindy/maker-shared/ghost-card-form';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/cindy-brain/useGhostCardThemeVars', () => ({ useGhostCardThemeVars: () => '' }));
vi.mock('@/features/right-sidebar/lib/mailPreview', () => ({ openMailCard: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Regression: an old useId must not block chat after the failed editor is gone.
it('releases a failed view on unmount and allows the remounted editor to sync', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const dispatch = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
  vi.stubGlobal('electronAPI', { ghosts: { dispatchCardAction: dispatch } });
  const mail: MailCardData = { accountId: 'account', draftId: 'draft', key: '20000000-0000-0000-0000-000000000000',
    from: 'sender', fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: '', multiline: name === 'body' })),
    attachments: [], state: 'draft', status: 'Synced', sendLabel: 'Send', fromLabel: 'From' };
  const props = { callId: 'failed-view', sessionId: 'reopened-session', height: 80, html: renderMailCard(mail) };
  const first = render(<MailCardEditor {...props} />);
  fireEvent.change(screen.getByLabelText('body'), { target: { value: 'First edit' } });
  await act(async () => {});
  expect(await pendingGhostCardFormDelivery(props.sessionId)).toBe(false);
  first.unmount();
  await act(async () => {});
  expect(pendingGhostCardFormDelivery(props.sessionId)).toBeUndefined();
  render(<MailCardEditor {...props} />);
  fireEvent.change(screen.getByLabelText('body'), { target: { value: 'New edit' } });
  await act(async () => {});
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(pendingGhostCardFormDelivery(props.sessionId)).toBeUndefined();
});

// Regression boundary (unit): two views of one draft. Form-only tests do not
// cover the send bridge: sending from the stale view must use the delivered edit.
it('sends the latest delivered text when the other view has not repainted yet', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const mail: MailCardData = { accountId: 'account', draftId: 'draft', key: '10000000-0000-0000-0000-000000000000',
    from: 'sender', fields: ['to', 'cc', 'bcc', 'subject', 'body'].map(name => ({ name, label: name, value: name === 'body' ? 'Original' : '', multiline: name === 'body' })),
    attachments: [], state: 'draft', status: 'Synced', sendLabel: 'Send', fromLabel: 'From' };
  const callId = 'shared-editor-test';
  let complete!: () => void;
  const dispatch = vi.fn((_id: string, action: string, _prompt: unknown, values: Record<string, string>) => {
    if (action.startsWith('mail:change:')) return new Promise<{ ok: boolean }>(resolve => {
      complete = () => {
        ingestCardPush({ callId, sessionId: 'editor-session', ghostId: 'provider', toolUseId: null, height: 80,
          html: renderMailCard({ ...mail, fields: mail.fields.map(f => ({ ...f, value: values[f.name] })) }) });
        resolve({ ok: true });
      };
    });
    return Promise.resolve({ ok: true });
  });
  vi.stubGlobal('electronAPI', { ghosts: { dispatchCardAction: dispatch } });
  const props = { callId, sessionId: 'editor-session', height: 80, html: renderMailCard(mail) };
  render(<><MailCardEditor {...props} /><MailCardEditor {...props} /></>);
  fireEvent.change(screen.getAllByLabelText('body')[0], { target: { value: 'Edited in sidebar' } });
  await act(async () => {});
  const frame = screen.getAllByTitle('mailReader.title')[1] as HTMLIFrameElement;
  frame.contentDocument!.open(); frame.contentDocument!.write(frame.srcdoc); frame.contentDocument!.close();
  fireEvent.load(frame);
  fireEvent.click(frame.contentDocument!.querySelector('[data-ghost-submit]')!);
  await act(async () => {});
  expect(dispatch).toHaveBeenCalledTimes(1);
  await act(async () => complete());
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls[1][1]).toBe(`mail:send:${mail.key}`);
  expect(dispatch.mock.calls[1][3].body).toBe('Edited in sidebar');
});
