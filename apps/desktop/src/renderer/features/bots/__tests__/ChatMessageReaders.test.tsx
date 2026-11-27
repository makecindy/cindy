// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderUI, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatReadReceipt } from '../ChatMessageReaders';
import type { BotGroupMemberView, BotGroupMessageReaders } from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => ({ readers: vi.fn(), react: vi.fn(), reactors: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' },
  t: (key: string, o?: Record<string, unknown>) => `${key.replace('bots.groupChat.server.', '')}${o ? `:${JSON.stringify(o)}` : ''}` }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true }));

const render = (ui: ReactNode) => renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
const member = (actorId: string, name: string) => ({ actorId, botId: actorId, name, avatar: '', avatarUrl: null, avatarColor: 'violet', status: 'active' }) as BotGroupMemberView;
const members = [member('a', 'Ada'), member('b', 'Bo'), member('c', 'Cy'), member('d', 'Di')];
const list = (readers: string[], others = 0): BotGroupMessageReaders => ({ messageId: 'm1', eligibleCount: readers.length + others, readCount: readers.length, listed: true,
  readers: readers.map((actorId, index) => ({ actorId, name: actorId.toUpperCase(), readAt: 1_700_000_000_000 + index * 60_000, formerMember: false })) });


const mount = (props: { read?: boolean; interactive?: boolean } = {}) => render(
  <div className="relative">
    <ChatReadReceipt groupId="room" messageId="m1" read={props.read ?? true} members={members} interactive={props.interactive ?? true} />
  </div>);
const check = () => screen.getByTestId('read-receipt');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { chatServer: mocks } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the read check', () => {
  it('is only a mark while messages are picked for sharing or the group cannot list readers, and never asks', () => {
    mount({ read: false, interactive: false });
    expect(check().tagName).toBe('SPAN');
    expect(check().getAttribute('aria-label')).toBe('readStatusSent');
    cleanup();
    mount({ read: true, interactive: false });
    expect(check().getAttribute('aria-label')).toBe('readStatusRead');
    expect(check().hasAttribute('data-share-exclude')).toBe(true);
    fireEvent.click(check());
    expect(mocks.readers).not.toHaveBeenCalled();
  });

  it('is a labelled button that reads the list only when opened, then shows readers, then who has not', async () => {
    mocks.readers.mockResolvedValue({ ok: true, readers: list(['a', 'b', 'c', 'd'], 1) });
    mount();
    expect(check().tagName).toBe('BUTTON');
    expect(check().getAttribute('aria-label')).toBe('readersView');
    expect(check().hasAttribute('data-share-exclude')).toBe(true);
    expect(mocks.readers).not.toHaveBeenCalled();
    fireEvent.click(check());
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(mocks.readers).toHaveBeenCalledOnce();
    expect(mocks.readers).toHaveBeenCalledWith({ groupId: 'room', messageId: 'm1' });
    const popover = screen.getByRole('dialog');
    expect(['Ada', 'Bo', 'Cy', 'Di'].every(name => within(popover).queryByText(name))).toBe(true);
    expect(within(popover).getByText('readersHeading')).toBeTruthy();
    // Only who has read: no unread group, nobody left out under another name.
    expect(within(popover).queryByText(/readersUnreadHeading/)).toBeNull();
    expect(within(popover).getAllByRole('listitem')).toHaveLength(4);
    // Name and avatar only, in the order the server gave (who read first); no time of reading.
    expect(popover.querySelector('time')).toBeNull();
    expect(within(popover).getAllByRole('listitem').slice(0, 4).map(item => item.querySelector('span.truncate')?.textContent)).toEqual(['Ada', 'Bo', 'Cy', 'Di']);
    expect(check().getAttribute('aria-label')).toContain('readersCount');
  });

  it('reads the list again when the message gets read while it is open, and forgets it when closed', async () => {
    mocks.readers.mockResolvedValueOnce({ ok: true, readers: list([], 1) });
    const view = mount({ read: false });
    fireEvent.click(check());
    expect(await screen.findByText('readersNone')).toBeTruthy();
    // Someone reads it: the check turns double, and the open list shows who.
    mocks.readers.mockResolvedValueOnce({ ok: true, readers: list(['a'], 0) });
    view.rerender(<Tooltip.Provider><div className="relative"><ChatReadReceipt groupId="room" messageId="m1" read members={members} interactive /></div></Tooltip.Provider>);
    expect(await screen.findByText('Ada')).toBeTruthy();
    expect(mocks.readers).toHaveBeenCalledTimes(2);
    // Closed, a stale answer is dropped: its label is back to the neutral one until opened.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(check().getAttribute('aria-label')).toContain('readersCount');
    view.rerender(<Tooltip.Provider><div className="relative"><ChatReadReceipt groupId="room" messageId="m1" read={false} members={members} interactive /></div></Tooltip.Provider>);
    await waitFor(() => expect(check().getAttribute('aria-label')).toBe('readersView'));
  });

  it('closes with Esc and gives focus back to the check', async () => {
    mocks.readers.mockResolvedValue({ ok: true, readers: list(['a']) });
    mount();
    check().focus();
    fireEvent.click(check());
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(check());
  });

  it('opens from a single check too: nobody has read it, and no one is listed', async () => {
    mocks.readers.mockResolvedValue({ ok: true, readers: list([], 2) });
    mount({ read: false });
    fireEvent.click(check());
    const popover = await screen.findByRole('dialog');
    expect(await within(popover).findByText('readersNone')).toBeTruthy();
    expect(within(popover).queryAllByRole('listitem')).toHaveLength(0);
    expect(check().getAttribute('aria-label')).toBe('readersNone');
  });

  it('falls back to a plain mark when the server says only the author may read the list', async () => {
    mocks.readers.mockResolvedValueOnce({ ok: false, errorCode: 'MESSAGE_AUTHOR_REQUIRED' });
    mount();
    fireEvent.click(check());
    await waitFor(() => expect(check().tagName).toBe('SPAN'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(check().hasAttribute('data-share-exclude')).toBe(true);
  });

  it('gives how many have read, and no names, in a group the server does not list', async () => {
    mocks.readers.mockResolvedValue({ ok: true, readers: { messageId: 'm1', eligibleCount: 180, readCount: 37, listed: false, readers: [] } });
    mount();
    fireEvent.click(check());
    const popover = await screen.findByRole('dialog');
    expect(await within(popover).findByText(/readersOfTotal.*"read":37.*"total":180/)).toBeTruthy();
    expect(within(popover).getByText('readersTooLarge')).toBeTruthy();
    expect(within(popover).queryAllByRole('listitem')).toHaveLength(0);
    expect(check().getAttribute('aria-label')).toMatch(/readersOfTotal.*"read":37.*"total":180/);
  });

  it('says so when the list cannot be read or the group is too large', async () => {
    mocks.readers.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_FAILED' });
    mount();
    fireEvent.click(check());
    expect(await screen.findByText('readersFailed')).toBeTruthy();
    cleanup();
    mocks.readers.mockResolvedValueOnce({ ok: false, errorCode: 'GROUP_TOO_LARGE' });
    mount();
    fireEvent.click(check());
    expect(await screen.findByText('readersTooLarge')).toBeTruthy();
  });
});
