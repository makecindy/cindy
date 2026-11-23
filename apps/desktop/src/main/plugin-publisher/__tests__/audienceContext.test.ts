/**
 * #1541 publish confirmation audience: what the screen may edit, what it starts with, and when
 * the prepare request carries `visibilityAudience` (servers before #1553 reject it).
 * Entry: loadPublisherAudienceContext / audienceToSend with in-memory author API fakes. Unit tier.
 */
import { describe, expect, it, vi } from 'vitest';

import { PluginAuthorUnsupportedError } from '../../plugin-author/api.js';
import {
  audienceToSend,
  loadPublisherAudienceContext,
  PublisherAudienceInvalidError,
  type AudienceContextDeps,
} from '../audienceContext.js';

const signal = new AbortController().signal;
const input = { ghostId: 'meeting-notes', orgSlug: 'acme' };

function deps(overrides: Partial<AudienceContextDeps['api']> = {}, exists = false): AudienceContextDeps {
  return {
    api: {
      listPages: vi.fn(async () => ({ plugins: [], nextCursor: null })),
      detail: vi.fn(),
      departments: vi.fn(async () => [
        { id: 'd-tech', name: '技术部', parentId: null, sortOrder: 1 },
        { id: 'd-ops-1', name: '运营部', parentId: null, sortOrder: 2 },
        { id: 'd-ops-2', name: '运营部', parentId: 'd-tech', sortOrder: 3 },
      ]),
      searchColleagues: vi.fn(async (q: string) => {
        if (q === '王一鸣') return [
          { membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com', active: true },
          { membershipId: 'm-wang2', displayName: '王一鸣明', email: 'w2@acme.com', active: true },
        ];
        if (q === '李安') return [
          { membershipId: 'm-li1', displayName: '李安', email: 'li1@acme.com', active: true },
          { membershipId: 'm-li2', displayName: '李安', email: 'li2@acme.com', active: true },
        ];
        return [];
      }),
      ...overrides,
    } as unknown as AudienceContextDeps['api'],
    existsInOrganization: vi.fn(async () => exists),
  };
}

describe('loadPublisherAudienceContext', () => {
  it('chooses unsupported, locked, new or existing from what the server lets the author read', async () => {
    await expect(loadPublisherAudienceContext(deps({
      listPages: vi.fn(async () => { throw new PluginAuthorUnsupportedError(); }),
    }), input, signal)).resolves.toEqual({ kind: 'unsupported' });

    await expect(loadPublisherAudienceContext(deps({
      listPages: vi.fn(async () => { throw new Error('network'); }),
    }), input, signal)).resolves.toEqual({ kind: 'locked' });

    // Not in a truncated author list: it may still be the member's plugin, so keep its audience.
    await expect(loadPublisherAudienceContext(deps({
      listPages: vi.fn(async () => ({ plugins: [], nextCursor: 'more' })),
    }), input, signal)).resolves.toEqual({ kind: 'locked' });

    // Someone else's existing plugin (e.g. an admin publishing it) keeps its audience.
    await expect(loadPublisherAudienceContext(deps({}, true), input, signal)).resolves.toEqual({ kind: 'locked' });

    await expect(loadPublisherAudienceContext(deps(), input, signal)).resolves.toEqual({
      kind: 'editable', isNew: true, current: { type: 'all' }, initial: { type: 'all' }, members: [], unresolved: [],
    });

    const current = { type: 'matchAny' as const, departmentIds: ['d-tech'], membershipIds: ['m-zhang'] };
    const members = [{ membershipId: 'm-zhang', displayName: '张晓', email: 'zx@acme.com' }];
    await expect(loadPublisherAudienceContext(deps({
      listPages: vi.fn(async () => ({ plugins: [{ id: 'p1', ghostId: 'meeting-notes', namespace: 'acme' }], nextCursor: null })),
      detail: vi.fn(async () => ({ id: 'p1', visibilityAudience: current, visibilityAudienceMembers: members })),
    } as never), input, signal)).resolves.toEqual({
      kind: 'editable', isNew: false, current, initial: current, members, unresolved: [],
    });

    await expect(loadPublisherAudienceContext(deps({
      listPages: vi.fn(async () => ({ plugins: [{ id: 'p1', ghostId: 'meeting-notes', namespace: 'acme' }], nextCursor: null })),
      detail: vi.fn(async () => { throw new Error('503'); }),
    } as never), input, signal)).resolves.toEqual({ kind: 'locked' });
  });

  // Review fix: an explicit audience from the conversation must never be dropped into "all
  // members" or "keep current"; and a detail without the field is not an editable "all".
  it('blocks an explicit audience request the server or plugin cannot take', async () => {
    const hint = { departments: ['技术部'] };
    await expect(loadPublisherAudienceContext(deps({
      listPages: vi.fn(async () => { throw new PluginAuthorUnsupportedError(); }),
    }), { ...input, hint }, signal)).resolves.toEqual({ kind: 'blocked', reason: 'unsupported' });
    await expect(loadPublisherAudienceContext(deps({}, true), { ...input, hint }, signal))
      .resolves.toEqual({ kind: 'blocked', reason: 'locked' });
    const withoutField = deps({
      listPages: vi.fn(async () => ({ plugins: [{ id: 'p1', ghostId: 'meeting-notes', namespace: 'acme' }], nextCursor: null })),
      detail: vi.fn(async () => ({ id: 'p1' })),
    } as never);
    await expect(loadPublisherAudienceContext(withoutField, input, signal)).resolves.toEqual({ kind: 'locked' });
    await expect(loadPublisherAudienceContext(withoutField, { ...input, hint }, signal))
      .resolves.toEqual({ kind: 'blocked', reason: 'locked' });
    // Blank names are not an intent.
    await expect(loadPublisherAudienceContext(deps({}, true), { ...input, hint: { members: ['  '] } }, signal))
      .resolves.toEqual({ kind: 'locked' });
  });

  // #1541 review: the server parses roles strictly on publish, so an audience with role names
  // outside the five current ones is kept as is (no field sent) and an explicit request is blocked.
  // Current-role audiences stay editable. Minimal failing input: roles ['model_admin'].
  it('keeps an audience with legacy roles unchanged and blocks an explicit request for it', async () => {
    const existing = (roles: string[]) => deps({
      listPages: vi.fn(async () => ({ plugins: [{ id: 'p1', ghostId: 'meeting-notes', namespace: 'acme' }], nextCursor: null })),
      detail: vi.fn(async () => ({ id: 'p1', visibilityAudience: { type: 'matchAny', departmentIds: ['d-tech'], roles } })),
    } as never);
    await expect(loadPublisherAudienceContext(existing(['admin', 'model_admin']), input, signal))
      .resolves.toEqual({ kind: 'locked', reason: 'legacyRoles' });
    await expect(loadPublisherAudienceContext(existing(['model_admin']), { ...input, hint: { departments: ['技术部'] } }, signal))
      .resolves.toEqual({ kind: 'blocked', reason: 'legacyRoles' });
    await expect(loadPublisherAudienceContext(existing(['admin']), input, signal))
      .resolves.toMatchObject({ kind: 'editable', isNew: false });
    expect(audienceToSend({ kind: 'locked', reason: 'legacyRoles' }, { confirmed: true, visibilityAudience: { type: 'all' } }))
      .toBeUndefined();
  });

  // Review fix: the colleague search returns at most 20 people and is not ordered by relevance,
  // so a full page with one exact name may still hide a namesake.
  it('does not preselect a name from a full search page unless the email matches exactly', async () => {
    const page = (exact: { membershipId: string; displayName: string; email: string }) => [
      exact,
      ...Array.from({ length: 19 }, (_, index) => ({
        membershipId: `m${index}`, displayName: `王一鸣${index}`, email: `w${index}@acme.com`, active: true,
      })),
    ].map((member) => ({ active: true, ...member }));
    const full = deps({
      searchColleagues: vi.fn(async () => page({ membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com' })),
    });
    await expect(loadPublisherAudienceContext(full, { ...input, hint: { members: ['王一鸣'] } }, signal)).resolves.toMatchObject({
      initial: { type: 'matchAny' }, members: [], unresolved: [{ kind: 'member', text: '王一鸣', reason: 'ambiguous' }],
    });
    await expect(loadPublisherAudienceContext(full, { ...input, hint: { members: ['wang@acme.com'] } }, signal)).resolves.toMatchObject({
      initial: { type: 'matchAny', membershipIds: ['m-wang'] }, unresolved: [],
    });
  });

  // #1541 review: text shaped like an email keeps email meaning. Minimal failing input: a member
  // whose display name is that text but whose email differs must not be preselected.
  it('matches email-shaped text only by exact email, never by a display name equal to it', async () => {
    const lookalike = deps({
      searchColleagues: vi.fn(async () => [
        { membershipId: 'm-fake', displayName: 'boss@acme.com', email: 'someone@acme.com', active: true },
      ]),
    });
    await expect(loadPublisherAudienceContext(lookalike, { ...input, hint: { members: ['boss@acme.com'] } }, signal))
      .resolves.toMatchObject({ initial: { type: 'matchAny', emails: ['boss@acme.com'] }, members: [], unresolved: [] });
    const owner = deps({
      searchColleagues: vi.fn(async () => [
        { membershipId: 'm-fake', displayName: 'Boss@acme.com', email: 'someone@acme.com', active: true },
        { membershipId: 'm-boss', displayName: '老板', email: 'BOSS@acme.com', active: true },
      ]),
    });
    await expect(loadPublisherAudienceContext(owner, { ...input, hint: { members: ['boss@acme.com'] } }, signal))
      .resolves.toMatchObject({ initial: { type: 'matchAny', membershipIds: ['m-boss'] }, unresolved: [] });
  });

  it('preselects what the user said and reports names it cannot match to exactly one', async () => {
    const context = await loadPublisherAudienceContext(deps(), {
      ...input,
      hint: {
        departments: ['技术部', '运营部', '市场部'],
        members: ['王一鸣', '李安', 'new@acme.com', '赵六'],
        emails: ['Ext@Partner.com', 'not-an-email'],
      },
    }, signal);
    expect(context).toEqual({
      kind: 'editable',
      isNew: true,
      current: { type: 'all' },
      initial: {
        type: 'matchAny',
        departmentIds: ['d-tech'],
        membershipIds: ['m-wang'],
        emails: ['new@acme.com', 'ext@partner.com'],
      },
      members: [{ membershipId: 'm-wang', displayName: '王一鸣', email: 'wang@acme.com' }],
      unresolved: [
        { kind: 'department', text: '运营部', reason: 'ambiguous' },
        { kind: 'department', text: '市场部', reason: 'not_found' },
        { kind: 'member', text: '李安', reason: 'ambiguous' },
        { kind: 'member', text: '赵六', reason: 'not_found' },
        { kind: 'email', text: 'not-an-email', reason: 'not_found' },
      ],
    });
  });
});

describe('audienceToSend', () => {
  const newPlugin = {
    kind: 'editable' as const, isNew: true, current: { type: 'all' as const },
    initial: { type: 'all' as const }, members: [], unresolved: [],
  };
  const existing = {
    ...newPlugin, isNew: false,
    current: { type: 'matchAny' as const, departmentIds: ['d1'], emails: ['A@acme.com'], roles: ['model_admin'] },
  };

  it('sends only a real change, normalized like the server', () => {
    expect(audienceToSend({ kind: 'unsupported' }, { confirmed: true, visibilityAudience: { type: 'matchAny', departmentIds: ['d1'] } })).toBeUndefined();
    expect(audienceToSend({ kind: 'locked' }, { confirmed: true, visibilityAudience: { type: 'matchAny', departmentIds: ['d1'] } })).toBeUndefined();
    expect(audienceToSend(newPlugin, { confirmed: true, visibilityAudience: { type: 'all' } })).toBeUndefined();
    expect(audienceToSend(newPlugin, { confirmed: true })).toBeUndefined();
    expect(audienceToSend(newPlugin, { confirmed: true, visibilityAudience: { type: 'matchAny', emails: ['B@acme.com', 'b@acme.com'] } }))
      .toEqual({ type: 'matchAny', emails: ['b@acme.com'] });
    // Unchanged even though the stored legacy role is not one this client can validate.
    expect(audienceToSend(existing, {
      confirmed: true,
      visibilityAudience: { type: 'matchAny', emails: ['a@acme.com'], departmentIds: ['d1'], roles: ['model_admin'] },
    })).toBeUndefined();
    expect(audienceToSend(existing, { confirmed: true, visibilityAudience: { type: 'all' } })).toEqual({ type: 'all' });
    // Removing a legacy role while keeping the rest is allowed; adding a role is not.
    expect(audienceToSend(existing, { confirmed: true, visibilityAudience: { type: 'matchAny', emails: ['a@acme.com'], departmentIds: ['d1'] } }))
      .toEqual({ type: 'matchAny', departmentIds: ['d1'], emails: ['a@acme.com'] });
    expect(audienceToSend(existing, { confirmed: true, visibilityAudience: { type: 'matchAny', departmentIds: ['d2'], roles: ['model_admin'] } }))
      .toEqual({ type: 'matchAny', departmentIds: ['d2'], roles: ['model_admin'] });
    expect(() => audienceToSend(existing, { confirmed: true, visibilityAudience: { type: 'matchAny', departmentIds: ['d1'], roles: ['admin'] } }))
      .toThrow(PublisherAudienceInvalidError);
    expect(() => audienceToSend(newPlugin, { confirmed: true, visibilityAudience: { type: 'matchAny' } }))
      .toThrow(PublisherAudienceInvalidError);
  });
});
