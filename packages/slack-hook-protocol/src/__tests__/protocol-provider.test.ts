/** Provider-neutral binding, preferences, and recent-session query contract. */

import { describe, expect, it } from 'vitest';

import {
  HOOK_FEATURE_PROVIDER_BIND,
  HOOK_FEATURE_PROVIDER_PREFS,
  HOOK_FEATURE_PROVIDER_TELEGRAM,
  HOOK_FEATURE_PROVIDER_X,
  HOOK_FEATURE_SESSION_PICKER,
  PROVIDER_BIND_STATES,
  makeBindStart,
  makeProviderBindCancel,
  makeProviderBindRevoke,
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
