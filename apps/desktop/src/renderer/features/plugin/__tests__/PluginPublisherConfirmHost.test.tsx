/** @vitest-environment jsdom */
/**
 * #1541 publish confirmation screen (conversation and UI publishing share it).
 * Protects: the audience the user sees and returns — conversation preselection with unmatched
 * names, "specified" needs at least one item, and a screen that may not edit the audience never
 * returns one. Entry: PluginPublisherConfirmHost driven by the real preload push shape. jsdom tier.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginPublisherConfirmPayload } from '../../../../shared/pluginPublisher';
import { PluginPublisherConfirmHost } from '../PluginPublisherConfirmHost';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  isDataOwnerPushStampCurrent: (stamp: { dataOwnerId: string }) => stamp.dataOwnerId === 'owner-a',
}));

const audience = 'settings.ghosts.audience';
let push: ((request: unknown) => void) | null = null;
const resolveConfirm = vi.fn(async () => ({ handled: true }));

beforeEach(() => {
  push = null;
  resolveConfirm.mockClear();
  Object.assign(window, {
    electronAPI: {
      pluginPublisher: {
        onConfirm: (callback: (request: unknown) => void) => {
          push = callback;
          return () => { push = null; };
        },
        resolveConfirm,
      },
      pluginAuthor: {
        departments: vi.fn(async () => [
          { id: 'd-tech', name: '技术部', parentId: null, sortOrder: 1 },
          { id: 'd-fe', name: '前端组', parentId: 'd-tech', sortOrder: 1 },
        ]),
        departmentMembers: vi.fn(async () => ({
          members: [{ membershipId: 'm-zx', displayName: '张晓', email: 'zx@acme.com', active: true }], total: 1,
        })),
        searchColleagues: vi.fn(async () => []),
        lookupColleagues: vi.fn(),
      },
      onAuthStateChange: () => () => undefined,
    },
  });
});
afterEach(cleanup);

function request(audienceContext: PluginPublisherConfirmPayload['audience'], requestId = 'request-1'): PluginPublisherConfirmPayload {
  return {
    requestId,
    ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    facts: { orgSlug: 'acme', orgName: 'Acme', ghostId: 'meeting-notes', name: 'Meeting Notes', version: '1.0.0', sizeBytes: 2048 },
    audience: audienceContext,
  };
}

function deliver(payload: PluginPublisherConfirmPayload) {
  act(() => push?.(payload));
  return screen.getByRole('dialog');
}

describe('PluginPublisherConfirmHost', () => {
  it('preselects what the user asked for and marks names it could not match', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' },
      initial: { type: 'matchAny', departmentIds: ['d-tech'], membershipIds: ['m-wang'] },
      members: [{ membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com' }],
      unresolved: [{ kind: 'member', text: '赵六', reason: 'not_found' }, { kind: 'member', text: '李安', reason: 'ambiguous' }],
    }));
    // Preselected people show their email so namesakes can be told apart.
    expect(within(dialog).getByText('wang@acme.com')).toBeTruthy();
    expect(within(dialog).getByRole('radio', { name: `${audience}.specified` }).getAttribute('aria-checked')).toBe('true');
    expect(await within(dialog).findByText('技术部')).toBeTruthy();
    expect(within(dialog).getByText('赵六').nextSibling?.textContent).toBe(`${audience}.notFound`);
    expect(within(dialog).getByText('李安').nextSibling?.textContent).toBe(`${audience}.ambiguous`);

    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, {
      type: 'matchAny', departmentIds: ['d-tech'], membershipIds: ['m-wang'],
    }));
  });

  it('requires at least one item for a specified audience and defaults new plugins to all members', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    const publish = within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' });
    expect(within(dialog).getByRole('radio', { name: `${audience}.all` }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    expect(publish).toHaveProperty('disabled', true);
    expect(within(dialog).getByText(`${audience}.requireOne`)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.all` }));
    fireEvent.click(publish);
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, { type: 'all' }));
  });

  it('blocks publishing when the audience the user asked for cannot be applied', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({ kind: 'blocked', reason: 'locked' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(`${audience}.blockedLocked`);
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.cancel' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', false, undefined));
  });

  // #1593 publish-context: an upload the server rejects for anyone (member publishing off,
  // archived or managed plugin) is explained and cannot be confirmed.
  it('explains why a plugin cannot be published and blocks confirming', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({ kind: 'denied', reason: 'forbidden' }));
    expect(within(dialog).getByRole('alert').textContent).toContain('settings.ghosts.publish.denied.forbidden');
    expect(within(dialog).queryByRole('radio')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.cancel' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', false, undefined));
  });

  it('keeps the current audience when it may not be edited', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({ kind: 'locked' }));
    expect(within(dialog).getByText(`${audience}.keepCurrent`)).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, undefined));
  });

  // #1541 review: publish requests parse roles strictly, so a current audience with legacy role
  // names is shown read-only with where to change it, and confirming sends no audience.
  it('keeps a current audience with legacy roles read-only and explains where to change it', async () => {
    render(<PluginPublisherConfirmHost />);
    let dialog = deliver(request({ kind: 'locked', reason: 'legacyRoles' }));
    expect(within(dialog).getByText(`${audience}.keepCurrent`)).toBeTruthy();
    expect(within(dialog).getByText(`${audience}.legacyRolesNote`)).toBeTruthy();
    expect(within(dialog).queryByRole('radio')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, undefined));

    dialog = await waitFor(() => deliver(request({ kind: 'blocked', reason: 'legacyRoles' }, 'request-2')));
    expect(within(dialog).getByRole('alert').textContent).toContain(`${audience}.blockedLegacyRoles`);
    expect(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' })).toHaveProperty('disabled', true);
  });

  // #1504 rule 1 picker shape: members of a selected department show "included"; a full email with
  // no active member can be added on its own; the result returns to the confirmation screen.
  it('picks departments, shows included members and adds an email from the picker', async () => {
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    fireEvent.click(within(dialog).getByRole('button', { name: `${audience}.choose` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    fireEvent.click(await within(picker).findByRole('button', { name: `${audience}.picker.expand` }));
    const member = await within(picker).findByText('张晓');
    fireEvent.click(within(picker).getAllByRole('checkbox')[0]!);
    await waitFor(() => expect(member.closest('label')?.textContent).toContain(`${audience}.picker.included`));
    expect(within(member.closest('label')!).getByRole('checkbox')).toHaveProperty('disabled', true);

    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'Guest@Partner.com' } });
    fireEvent.click(await within(picker).findByText(`${audience}.picker.addEmail`));
    fireEvent.click(within(picker).getByRole('button', { name: `${audience}.picker.done` }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.ghosts.publish.confirm' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('request-1', true, {
      type: 'matchAny', departmentIds: ['d-tech'], emails: ['guest@partner.com'],
    }));
  });

  // Greptile review on #12208: a failed department read replaced the whole picker body, hiding
  // member search results and adding by email while those requests still ran. Minimal failing
  // input: departments() rejects, then searching a name and an email.
  it('keeps member search and adding by email when the department list fails', async () => {
    const author = (window as unknown as { electronAPI: { pluginAuthor: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.pluginAuthor;
    author.departments.mockRejectedValue(new Error('[NETWORK_UNREACHABLE] offline'));
    author.searchColleagues.mockResolvedValue([{ membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com', active: true }]);
    render(<PluginPublisherConfirmHost />);
    const dialog = deliver(request({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    }));
    fireEvent.click(within(dialog).getByRole('radio', { name: `${audience}.specified` }));
    fireEvent.click(within(dialog).getByRole('button', { name: `${audience}.choose` }));
    const picker = await screen.findByRole('dialog', { name: `${audience}.picker.title` });
    expect(await within(picker).findByRole('alert')).toBeTruthy();
    expect(within(picker).getByRole('button', { name: `${audience}.picker.retry` })).toBeTruthy();
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: '王一鸣' } });
    expect(await within(picker).findByText('王一鸣')).toBeTruthy();
    fireEvent.change(within(picker).getByRole('searchbox'), { target: { value: 'guest@partner.com' } });
    expect(await within(picker).findByText(`${audience}.picker.addEmail`)).toBeTruthy();
    expect(within(picker).getByRole('button', { name: `${audience}.picker.retry` })).toBeTruthy();
  });
});
