/** Provider-neutral binding, preferences, and recent-session query contract. */

import { describe, expect, it } from 'vitest';

import {
  HOOK_FEATURE_PROVIDER_BIND,
  HOOK_FEATURE_PROVIDER_FEISHU,
  HOOK_FEATURE_PROVIDER_PREFS,
  HOOK_FEATURE_PROVIDER_TELEGRAM,
  HOOK_FEATURE_PROVIDER_X,
  HOOK_FEATURE_SESSION_PICKER,
  PROVIDER_BIND_STATES,
  makeBindStart,
  makeProviderBindCancel,
  makeProviderBindRevoke,
  makeProviderBindSelect,
  makeProviderBindSelection,
  makeProviderBindStart,
  makeProviderBindState,
  makeProviderBindUpdate,
  makeProviderPrefsGet,
  makeProviderPrefsSet,
  makeProviderPrefsState,
  makeQueryResponse,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type ProviderBindStatusPayload,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

function expectReject(message: unknown, keyword: string): void {
  const parsed = parseHookMessage(message);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const PENDING: ProviderBindStatusPayload = {
  provider: 'telegram',
  replyTo: 'request-1',
  state: 'pending',
  attemptId: 'attempt-1',
  bindingId: null,
  principalId: null,
  principalName: null,
  scopeId: 'bot-1',
  scopeName: 'cindy_example_bot',
  connectUrl: 'https://t.me/cindy_example_bot?start=abcdefghijklmnopqrstuvwxyz_0123456789-ABCDE',
  expiresAt: 1_800_000_000_000,
  reason: null,
  remediationUrl: null,
  actions: ['open_connect_url', 'copy_connect_url', 'cancel'],
};

const CONFIRMED: ProviderBindStatusPayload = {
  provider: 'telegram',
  replyTo: null,
  state: 'confirmed',
  attemptId: null,
  bindingId: 'binding-1',
  principalId: 'telegram-user-1',
  principalName: 'Cindy User',
  scopeId: 'bot-1',
  scopeName: 'cindy_example_bot',
  connectUrl: null,
  expiresAt: null,
  reason: null,
  remediationUrl: 'https://t.me/cindy_example_bot',
  actions: ['revoke', 'open_provider', 'add_to_group'],
};

function statusFor(state: ProviderBindStatusPayload['state']): ProviderBindStatusPayload {
  if (state === 'pending') return PENDING;
  if (state === 'confirmed') return CONFIRMED;
  if (state === 'none') {
    return {
      ...CONFIRMED,
      state,
      bindingId: null,
      principalId: null,
      principalName: null,
      remediationUrl: null,
      actions: [],
    };
  }
  if (state === 'awaiting_confirmation') {
    return {
      ...PENDING,
      state,
      connectUrl: null,
      principalId: 'telegram-user-1',
      principalName: 'Cindy User',
      actions: ['cancel'],
    };
  }
  const bindingTerminal = state === 'revoked' || state === 'superseded';
  return {
    ...PENDING,
    state,
    attemptId: bindingTerminal ? null : PENDING.attemptId,
    bindingId: bindingTerminal ? 'binding-1' : null,
    principalId: bindingTerminal ? 'telegram-user-1' : null,
    principalName: bindingTerminal ? 'Cindy User' : null,
    connectUrl: null,
    expiresAt: null,
    reason: `telegram-${state}`,
    actions: ['retry'],
  };
}

describe('provider feature negotiation constants', () => {
  it('uses stable append-only capability names', () => {
    expect(HOOK_FEATURE_PROVIDER_BIND).toBe('provider-bind-v1');
    expect(HOOK_FEATURE_PROVIDER_PREFS).toBe('provider-prefs-v1');
    expect(HOOK_FEATURE_SESSION_PICKER).toBe('session-picker-v1');
    expect(HOOK_FEATURE_PROVIDER_TELEGRAM).toBe('provider:telegram');
    expect(HOOK_FEATURE_PROVIDER_X).toBe('provider:x');
    expect(HOOK_FEATURE_PROVIDER_FEISHU).toBe('provider:feishu');
  });

  it('does not alter the legacy Slack bind.start payload', () => {
    const legacy = JSON.parse(serializeHookMessage(makeBindStart({}))) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(legacy.type).toBe('bind.start');
    expect(legacy.payload).toEqual({});
  });
});

describe('provider.bind frames', () => {
  it('round-trips start, cancel, revoke, update, and state', () => {
    roundTrip(makeProviderBindStart({ requestId: 'request-1', provider: 'telegram' }));
    roundTrip(
      makeProviderBindStart({ requestId: 'request-2', provider: 'slack', scopeId: 'team-1' }),
    );
    roundTrip(
      makeProviderBindCancel({
        requestId: 'request-3',
        provider: 'telegram',
        attemptId: 'attempt-1',
      }),
    );
    roundTrip(
      makeProviderBindRevoke({
        requestId: 'request-4',
        provider: 'telegram',
        bindingId: 'binding-1',
      }),
    );
    for (const state of PROVIDER_BIND_STATES) {
      const payload = statusFor(state);
      roundTrip(makeProviderBindUpdate(payload));
      roundTrip(makeProviderBindState(payload));
    }
  });

  it('round-trips the x provider through bind and prefs frames', () => {
    // 'x' is an append-only HOOK_PROVIDERS value: the frames are identical to
    // Telegram's, only the provider id (and its connect-URL host) differ.
    roundTrip(makeProviderBindStart({ requestId: 'request-x-1', provider: 'x' }));
    roundTrip(
      makeProviderBindCancel({ requestId: 'request-x-2', provider: 'x', attemptId: 'attempt-x' }),
    );
    roundTrip(
      makeProviderBindRevoke({ requestId: 'request-x-3', provider: 'x', bindingId: 'binding-x' }),
    );
    const xPending: ProviderBindStatusPayload = {
      ...PENDING,
      provider: 'x',
      scopeId: 'x-app-1',
      scopeName: 'cindy_example_app',
      connectUrl: 'https://example.com/x/connect?attempt=attempt-x',
    };
    roundTrip(makeProviderBindUpdate(xPending));
    roundTrip(makeProviderBindState(xPending));
    roundTrip(
      makeProviderPrefsGet({
        requestId: 'prefs-x-1',
        provider: 'x',
        bindingId: 'binding-x',
        scopeId: null,
      }),
    );
    roundTrip(
      makeProviderPrefsState({
        provider: 'x',
        bindingId: 'binding-x',
        scopeId: null,
        replyTo: 'prefs-x-1',
        bound: true,
        prefs: [],
      }),
    );
  });

  it('carries the feishu bind code only on a pending attempt', () => {
    // Feishu / Lark pending attempts carry both the web authorization URL and
    // a short code the user can send to the bot when web authorization is
    // unavailable (users outside the app tenant).
    const feishuPending: ProviderBindStatusPayload = {
      ...PENDING,
      provider: 'feishu',
      scopeId: 'cli_example_app',
      scopeName: 'Cindy',
      connectUrl:
        'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_example_app&state=abc',
      bindCode: '7KQ4-M2XD',
      actions: ['open_connect_url', 'copy_connect_url', 'copy_bind_code', 'cancel'],
    };
    roundTrip(makeProviderBindUpdate(feishuPending));
    roundTrip(makeProviderBindState(feishuPending));
    roundTrip(makeProviderBindStart({ requestId: 'request-f-1', provider: 'feishu' }));

    const update = makeProviderBindUpdate(feishuPending);
    for (const bindCode of ['7kq4-m2xd', 'ABC', '-7KQ4', '7KQ4 M2XD', 7_404_202]) {
      expectReject(
        { ...update, payload: { ...feishuPending, bindCode } },
        'bindCode must be 4-32',
      );
    }
    const awaiting = { ...statusFor('awaiting_confirmation'), provider: 'feishu' };
    expectReject(
      { ...update, payload: { ...awaiting, bindCode: '7KQ4-M2XD' } },
      'bindCode must be null unless state is pending',
    );
  });

  it('rejects unknown providers and unsafe links', () => {
    const start = makeProviderBindStart({ requestId: 'request-1', provider: 'telegram' });
    expectReject(
      { ...start, payload: { ...start.payload, provider: 'discord' } },
      'provider.bind.start.provider',
    );
    const state = makeProviderBindState(PENDING);
    expectReject(
      { ...state, payload: { ...PENDING, connectUrl: 'http://t.me/example?start=token' } },
      'safe HTTPS URL',
    );
    expectReject(
      { ...state, payload: { ...PENDING, connectUrl: 'https://user:pass@t.me/example' } },
      'safe HTTPS URL',
    );
  });

  it('enforces state-linked identity, attempt, expiry, and reason fields', () => {
    const pending = makeProviderBindUpdate(PENDING);
    expectReject(
      { ...pending, payload: { ...PENDING, attemptId: null } },
      'attemptId must be non-empty',
    );
    expectReject(
      { ...pending, payload: { ...PENDING, expiresAt: null } },
      'expiresAt must be non-null',
    );
    for (const state of ['pending', 'awaiting_confirmation'] as const) {
      const active = statusFor(state);
      for (const frame of [makeProviderBindUpdate(active), makeProviderBindState(active)]) {
        expectReject(
          { ...frame, payload: { ...active, bindingId: 'stale-binding' } },
          'bindingId must be null',
        );
      }
    }
    const confirmed = makeProviderBindState(CONFIRMED);
    expectReject(
      { ...confirmed, payload: { ...CONFIRMED, principalId: null } },
      'principalId must be non-empty',
    );
    expectReject(
      { ...confirmed, payload: { ...CONFIRMED, connectUrl: 'https://t.me/example' } },
      'connectUrl must be null',
    );
    expectReject(
      {
        ...confirmed,
        payload: {
          ...CONFIRMED,
          state: 'superseded',
          reason: null,
        },
      },
      'reason must be non-empty',
    );
    for (const state of ['revoked', 'superseded'] as const) {
      const terminal = statusFor(state);
      for (const frame of [makeProviderBindUpdate(terminal), makeProviderBindState(terminal)]) {
        expectReject(
          { ...frame, payload: { ...terminal, attemptId: 'stale-attempt' } },
          'attemptId and expiresAt must be null',
        );
        expectReject(
          { ...frame, payload: { ...terminal, expiresAt: Date.now() + 60_000 } },
          'attemptId and expiresAt must be null',
        );
      }
    }
    for (const state of ['denied', 'expired', 'failed'] as const) {
      const terminal = statusFor(state);
      for (const frame of [makeProviderBindUpdate(terminal), makeProviderBindState(terminal)]) {
        for (const field of ['bindingId', 'principalId', 'principalName'] as const) {
          expectReject(
            { ...frame, payload: { ...terminal, [field]: `stale-${field}` } },
            `${field} must be null`,
          );
        }
        expectReject(
          { ...frame, payload: { ...terminal, expiresAt: Date.now() + 60_000 } },
          'expiresAt must be null',
        );
      }
    }
  });
});

describe('provider.prefs frames', () => {
  it('round-trips provider-isolated get/set/state', () => {
    roundTrip(
      makeProviderPrefsGet({
        requestId: 'prefs-1',
        provider: 'telegram',
        bindingId: 'binding-1',
        scopeId: null,
      }),
    );
    roundTrip(
      makeProviderPrefsSet({
        requestId: 'prefs-2',
        provider: 'telegram',
        bindingId: 'binding-1',
        scopeId: null,
        workspace: 'cindy',
        model: 'model-1',
        effort: 'high',
      }),
    );
    roundTrip(
      makeProviderPrefsState({
        provider: 'telegram',
        bindingId: 'binding-1',
        scopeId: null,
        replyTo: 'prefs-2',
        bound: true,
        prefs: [
          {
            workspace: 'cindy',
            model: 'model-1',
            effort: 'high',
            agentKind: 'codex',
            permissionMode: 'full-access',
          },
        ],
      }),
    );
  });

  it('requires exactly one neutral selector and rejects Slack-only teamId', () => {
    const get = makeProviderPrefsGet({
      requestId: 'prefs-1',
      provider: 'telegram',
      bindingId: 'binding-1',
      scopeId: null,
    });
    expectReject(
      { ...get, payload: { ...get.payload, bindingId: null, scopeId: null } },
      'exactly one',
    );
    expectReject({ ...get, payload: { ...get.payload, scopeId: 'bot-1' } }, 'exactly one');
    const state = makeProviderPrefsState({
      provider: 'telegram',
      bindingId: 'binding-1',
      scopeId: null,
      replyTo: null,
      bound: true,
      prefs: [],
    });
    expectReject(
      {
        ...state,
        payload: {
          ...state.payload,
          prefs: [
            {
              workspace: 'cindy',
              model: null,
              effort: null,
              agentKind: null,
              permissionMode: null,
              teamId: 'team-1',
            },
          ],
        },
      },
      'Slack-specific',
    );
  });

  it('rejects absolute workspace paths in writes and snapshots', () => {
    const set = makeProviderPrefsSet({
      requestId: 'prefs-absolute',
      provider: 'telegram',
      bindingId: 'binding-1',
      scopeId: null,
      workspace: 'cindy',
    });
    const state = makeProviderPrefsState({
      provider: 'telegram',
      bindingId: 'binding-1',
      scopeId: null,
      replyTo: null,
      bound: true,
      prefs: [
        {
          workspace: 'cindy',
          model: null,
          effort: null,
          agentKind: null,
          permissionMode: null,
        },
      ],
    });
    for (const workspace of ['/Users/cindy/project', 'C:\\Users\\cindy', 'file:///tmp/cindy']) {
      expectReject(
        { ...set, payload: { ...set.payload, workspace } },
        'must not be an absolute path',
      );
      expectReject(
        {
          ...state,
          payload: {
            ...state.payload,
            prefs: [{ ...state.payload.prefs[0], workspace }],
          },
        },
        'must not be an absolute path',
      );
    }
  });
});

describe('query.kind=sessions', () => {
  it('round-trips at most 20 privacy-minimised session entries', () => {
    roundTrip(
      makeQueryResponse({
        queryId: 'sessions-1',
        kind: 'sessions',
        ok: true,
        error: null,
        sessions: [
          { id: 'session-1', title: 'Telegram task', workspace: 'cindy', lastActiveAt: 1 },
        ],
      }),
    );
  });

  it('rejects over-limit, duplicate, and absolute-path entries', () => {
    const sessions = Array.from({ length: 21 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      workspace: 'cindy',
      lastActiveAt: index + 1,
    }));
    const response = makeQueryResponse({
      queryId: 'sessions-1',
      kind: 'sessions',
      ok: true,
      error: null,
      sessions,
    });
    expectReject(response, 'at most 20');
    expectReject(
      {
        ...response,
        payload: {
          ...response.payload,
          sessions: [sessions[0], { ...sessions[1], id: sessions[0].id }],
        },
      },
      'must be unique',
    );
    for (const workspace of ['/Users/cindy/project', 'C:\\Users\\cindy', 'file:///tmp/cindy']) {
      expectReject(
        {
          ...response,
          payload: { ...response.payload, sessions: [{ ...sessions[0], workspace }] },
        },
        'must not be an absolute path',
      );
    }
    expectReject(
      {
        ...response,
        payload: {
          ...response.payload,
          sessions: [{ ...sessions[0], path: '/Users/cindy/project' }],
        },
      },
      'privacy-minimised session shape',
    );
    expectReject(
      {
        ...response,
        payload: {
          ...response.payload,
          sessions: [{ ...sessions[0], message: 'private conversation text' }],
        },
      },
      'privacy-minimised session shape',
    );
  });
});

// The select_device action is the opt-in capability; selection acknowledgments never imply a binding.
describe('working computer selection', () => {
  it('round-trips an exact binding request and boolean result, rejecting incomplete identities', () => {
    const payload = { requestId: 'select-1', provider: 'feishu' as const, bindingId: 'binding-1' };
    roundTrip(makeProviderBindSelect(payload));
    roundTrip(makeProviderBindSelection({ ...payload, ok: true }));
    roundTrip(makeProviderBindSelection({ ...payload, ok: false }));
    expectReject({ ...makeProviderBindSelect(payload), payload: { ...payload, bindingId: '' } }, 'bindingId');
    expectReject({ ...makeProviderBindSelection({ ...payload, ok: true }), payload: { ...payload, ok: 'true' } }, 'ok');
  });
});


// Multi-account snapshots grant task authority. The production parser must reject
// ambiguous/nested identities rather than letting the UI authorize an unrelated account.
describe('Feishu store multi-account contract', () => {
  it('round-trips distinct identities and rejects nested, duplicate, cross-app or mismatched snapshots', () => {
    const first: ProviderBindStatusPayload = { ...CONFIRMED, provider: 'feishu', tenantKey: 'tenant-a' };
    const second: ProviderBindStatusPayload = { ...first, bindingId: 'binding-2', principalId: 'ou_second', tenantKey: 'tenant-b' };
    roundTrip(makeProviderBindState({ ...first, bindings: [first, second] }));
    roundTrip(makeProviderBindUpdate({ ...second, completedAttemptId: 'attempt-2' }));
    for (const rows of [[first, first], [first, { ...second, scopeId: 'different-app' }],
      [first, { ...second, bindings: [] }], [second], [second, first],
      [{ ...first, principalName: 'different-name' }, second], [{ ...first, actions: [] }, second]]) {
      expectReject(makeProviderBindState({ ...first, bindings: rows }), 'bindings');
    }
    expectReject(makeProviderBindUpdate({ ...first, bindings: [first] }), 'bindings');
    expectReject(makeProviderBindState({ ...first, provider: 'telegram', tenantKey: undefined, bindings: [first] }), 'bindings');
  });
});

// The application set is the authority for multiple bot accounts. Old single-app
// frames still round-trip; ambiguous projections and cross-app bindings cannot.
describe('Feishu application coexistence contract', () => {
  // Review regression / unit: both container and row are independently valid,
  // but the same app cannot have different brand/type identities inside one frame.
  it.each(['brand', 'appType'] as const)('rejects contradictory nested app %s metadata', (field) => {
    const app = { appId: CONFIRMED.scopeId!, brand: 'feishu' as const, appType: 'store' as const, botName: 'Cindy', organization: null };
    const contradictory = field === 'brand' ? { ...app, brand: 'lark' as const } : { ...app, appType: 'self_built' as const };
    const row: ProviderBindStatusPayload = { ...CONFIRMED, provider: 'feishu', appInfo: contradictory };
    expectReject(makeProviderBindState({ ...row, applications: [{ app, bindings: [row] }] }), 'applications');
  });

  it('accepts two app scopes and rejects duplicated apps, foreign bindings and nested authority', () => {
    const first: ProviderBindStatusPayload = { ...CONFIRMED, provider: 'feishu' };
    const org: ProviderBindStatusPayload = { ...first, scopeId: 'cli_org', bindingId: 'org-binding', principalId: 'org-user' };
    const app = { appId: first.scopeId!, brand: 'feishu' as const, appType: 'store' as const, botName: 'Cindy', organization: null };
    const other = { ...app, appId: 'cli_org', appType: 'self_built' as const, botName: 'Acme Cindy', tenantName: 'Feishu Acme' };
    const applications = [{ app, bindings: [first] }, { app: other, bindings: [org] }];
    roundTrip(makeProviderBindState({ ...first, applications }));
    // Presentation labels may reflect the saved owner; app identity stays stable.
    const enriched = { ...first, appInfo: { ...app, botName: null, organization: 'saved-owner' } };
    roundTrip(makeProviderBindState({ ...enriched, applications: [{ app, bindings: [enriched] }, applications[1]!] }));
    roundTrip(makeProviderBindState(first));
    const secondary = { ...first, bindingId: 'store-second', principalId: 'store-user-2' };
    expectReject(makeProviderBindState({ ...secondary, applications: [{ app, bindings: [first, secondary] }, applications[1]!] }), 'applications');
    expectReject(makeProviderBindState({ ...first, applications: [{ app, bindings: [{ ...first, principalName: 'different-name' }] }, applications[1]!] }), 'applications');
    expectReject(makeProviderBindState({ ...first, bindings: [secondary, first], applications: [{ app, bindings: [first, secondary] }, applications[1]!] }), 'applications');
    for (const invalid of [
      [applications[0], applications[0]],
      [{ app, bindings: [org] }, applications[1]],
      [{ app, bindings: [{ ...first, applications }] }, applications[1]],
      [applications[0], { app: other, bindings: [org, { ...org, bindingId: 'org-2', principalId: 'org-user-2' }] }],
      [applications[1]],
    ]) expectReject({ ...makeProviderBindState(first), payload: { ...first, applications: invalid } }, 'applications');
    expectReject(makeProviderBindUpdate({ ...first, applications }), 'applications');
  });
});

// Display metadata must not contradict the authoritative legacy projection.
describe('Feishu working computer metadata', () => {
  it('round-trips optional names and rejects malformed or contradictory metadata', () => {
    const row = { ...CONFIRMED, provider: 'feishu' as const, workingDevice: { name: 'Office PC', isCurrent: false } };
    roundTrip(makeProviderBindState({ ...row, bindings: [row] }));
    for (const workingDevice of [{ name: 42, isCurrent: false }, { name: 'Office PC', isCurrent: 'yes' }, null]) {
      expectReject({ ...makeProviderBindState(row), payload: { ...row, workingDevice } }, 'workingDevice');
    }
    expectReject(makeProviderBindState({ ...row, bindings: [{ ...row, workingDevice: { name: 'Other PC', isCurrent: true } }] }), 'bindings');
    roundTrip(makeProviderBindSelection({ requestId: 'select', provider: 'feishu', bindingId: 'b', ok: true, workingDevice: { name: null, isCurrent: true } }));
    expectReject({ ...makeProviderBindSelection({ requestId: 'select', provider: 'feishu', bindingId: 'b', ok: false }), payload: { requestId: 'select', provider: 'feishu', bindingId: 'b', ok: false, workingDevice: row.workingDevice } }, 'workingDevice');
  });
});

// An empty authoritative app set revokes all prior identities, not a stale snapshot.
it('accepts an empty Feishu application set only with an empty legacy projection', () => {
  const empty: ProviderBindStatusPayload = { ...CONFIRMED, provider: 'feishu', state: 'none', bindingId: null,
    principalId: null, principalName: null, scopeId: null, scopeName: null, remediationUrl: null, actions: [], applications: [], bindings: [] };
  roundTrip(makeProviderBindState(empty));
  expectReject(makeProviderBindState({ ...empty, scopeId: 'stale-app' }), 'applications');
  expectReject(makeProviderBindState({ ...empty, actions: ['open_provider'] }), 'applications');
  expectReject(makeProviderBindState({ ...empty, bindings: [{ ...CONFIRMED, provider: 'feishu' }] }), 'applications');
});
