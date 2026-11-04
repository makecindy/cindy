import { describe, expect, it } from 'vitest';
import {
  PROVIDER_GROUP_REMOTE_CHANNEL,
  REMOTE_AGENT_CHANNEL,
  REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS,
  REMOTE_AGENT_UPLOAD_CHUNK_BYTES,
  REMOTE_INVOKE_ALLOWLIST,
  isPeerResetRetryableInvoke,
  isRemoteAgentReadInvoke,
  parseRemoteAgentCaps,
  parseRemoteAgentForkResult,
  parseRemoteAgentPollResult,
  parseRemoteAgentReadResult,
  parseRemoteAgentReply,
  parseRemoteAgentRequest,
  parseRemoteAgentReshareResult,
  parseRemoteAgentStreamItem,
  remoteAgentErrorCode,
} from '../index';

const runId = '0f9c4a2e-6d1b-4c3a-9e8f-1a2b3c4d5e6f';
const otherId = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

describe('subscription Fast policy wire compatibility', () => {
  it('advertises support only with an explicit capability', () => {
    const caps = { version: 1, maxRuns: 10, uploadChunkBytes: 1024, maxPayloadBytes: 8192 };
    expect(parseRemoteAgentCaps(caps).subscriptionFastPolicy).toBeUndefined();
    expect(parseRemoteAgentCaps({ ...caps, subscriptionFastPolicy: true }).subscriptionFastPolicy).toBe(true);
    expect(parseRemoteAgentCaps({ ...caps, subscriptionFastPolicy: 'true' }).subscriptionFastPolicy).toBeUndefined();
  });
  it('parses a narrow registration without trusting arbitrary execution options', () => {
    const command = { op: 'fast-policy', group: 'openai-account', revision: 2, allowFast: false,
      binding: { sessionId: runId, controllerDeviceId: 'computer', relay: 'abcdefghijklmnop' } };
    expect(parseRemoteAgentRequest({ ...command, providerId: 'some-other-account' })).toEqual(command);
    for (const patch of [{ allowFast: 'false' }, { revision: -1 }, { group: '../owner' },
      { binding: { sessionId: '../task' } }, { binding: { sessionId: runId, controllerDeviceId: '{}' } }]) {
      expect(() => parseRemoteAgentRequest({ ...command, ...patch })).toThrow();
    }
  });
  it('preserves only the bounded direct guest task binding', () => {
    const guest = { shareId: 'share', memberId: 'member', guestDeviceId: 'laptop' };
    const command = { op: 'fast-policy', group: 'openai', revision: 1, allowFast: false,
      binding: { sessionId: runId, providerShareGuest: guest } };
    expect(parseRemoteAgentRequest(command)).toEqual(command);
    expect(() => parseRemoteAgentRequest({ ...command,
      binding: { ...command.binding, controllerDeviceId: 'owner' } })).toThrow();
    expect(() => parseRemoteAgentRequest({ ...command,
      binding: { ...command.binding, providerShareGuest: { ...guest, shareId: '../share' } } })).toThrow();
  });
});

describe('remote agent channel', () => {
  // Production parser / unit: locating history is scoped by the authenticated
  // peer, never a guest-supplied share/member/device. Legacy allocate is unchanged.
  it('parses only the bounded direct-location task and preserves legacy requests', () => {
    expect(parseRemoteAgentRequest({ op: 'direct-locate', sessionId: runId, memberId: 'other', deviceId: 'other' }))
      .toEqual({ op: 'direct-locate', sessionId: runId });
    for (const sessionId of ['', '../task', 'x'.repeat(129)]) {
      expect(() => parseRemoteAgentRequest({ op: 'direct-locate', sessionId })).toThrow('REMOTE_AGENT_INVALID');
    }
    const legacy = { op: 'allocate', agentKind: 'pi', model: 'model', sessionId: runId };
    expect(parseRemoteAgentRequest(legacy)).toEqual(legacy);
    expect(() => parseRemoteAgentRequest({ op: 'future-direct-op', sessionId: runId })).toThrow('REMOTE_AGENT_INVALID');
  });

  // Unit / production parser: after O restarts, dropping this wire field would
  // silently assign M2 while G's existing task and reliable link still live on M1.
  it('preserves the current executor when parsing a direct-task renewal', () => {
    const request = { op: 'allocate', agentKind: 'pi', model: 'model-b',
      sessionId: runId, preferredExecutorDeviceId: 'executor-1' };
    expect(parseRemoteAgentRequest(request)).toEqual(request);
    expect(() => parseRemoteAgentRequest({ ...request, preferredExecutorDeviceId: '' })).toThrow('REMOTE_AGENT_INVALID');
  });

  it('binds a failed direct-open release to one allocation generation', () => {
    const release = { op: 'direct-release', sessionId: runId,
      generation: '11111111-1111-4111-8111-111111111111' };
    expect(parseRemoteAgentRequest(release)).toEqual(release);
    expect(() => parseRemoteAgentRequest({ ...release, generation: '../newer' })).toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentRequest({ ...release, sessionId: '../other' })).toThrow('REMOTE_AGENT_INVALID');
    expect(isRemoteAgentReadInvoke(REMOTE_AGENT_CHANNEL, [release])).toBe(false);
  });

  // Shared-model fork wire: old peers must not gain write support by default; task IDs
  // include group-relay IDs, while filesystem roots are never accepted from callers.
  it('validates native fork boundaries and never retries a fork as a read', () => {
    const request = { op: 'fork', sourceSessionId: 'g123', newSessionId: otherId,
      agentKind: 'pi', sourceSdkSessionId: '/guest/pi-sessions/source.jsonl', model: 'model' };
    expect(parseRemoteAgentRequest({ ...request, hostedGuestHome: '/owner', workingDir: '/owner' })).toEqual(request);
    // The FORK_FAILED opt-in survives the group relay hop only as an explicit `true`.
    expect(parseRemoteAgentRequest({ ...request, acceptsForkFailed: true })).toEqual({ ...request, acceptsForkFailed: true });
    expect(parseRemoteAgentRequest({ ...request, acceptsForkFailed: 'yes' })).toEqual(request);
    expect(() => parseRemoteAgentRequest({ ...request, sourceSessionId: '../owner' })).toThrow();
    expect(() => parseRemoteAgentRequest({ ...request, tailTurnsToDrop: -1 })).toThrow();
    expect(isRemoteAgentReadInvoke(REMOTE_AGENT_CHANNEL, [request])).toBe(false);
    expect(isPeerResetRetryableInvoke(REMOTE_AGENT_CHANNEL, [request])).toBe(false);
    expect(parseRemoteAgentForkResult({ newSdkSessionId: 'child', uuidMap: [['a', 'b']] })).toEqual({
      newSdkSessionId: 'child', uuidMap: [['a', 'b']],
    });
    expect(() => parseRemoteAgentForkResult({ newSdkSessionId: 'child', uuidMap: [['a', 1]] })).toThrow();
    const caps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
    expect(parseRemoteAgentCaps(caps).nativeFork).toBeUndefined();
    expect(parseRemoteAgentCaps({ ...caps, nativeFork: true }).nativeFork).toBe(true);
  });
  // Shared-task guests are refused by the desktop shared-task gate (not in its channel list).
  it('is registered on the same-account allowlist', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(REMOTE_AGENT_CHANNEL)).toBe(true);
    // 供应商组：同账号电脑问组所在电脑该用哪台(受邀者在 Desktop dispatch 被拒)。
    expect(REMOTE_INVOKE_ALLOWLIST.has(PROVIDER_GROUP_REMOTE_CHANNEL)).toBe(true);
  });

  it('parses the provider group forget op and the guest relay capability', () => {
    const relay = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(parseRemoteAgentRequest({ op: 'forget', relay, extra: 1 })).toEqual({ op: 'forget', relay });
    expect(() => parseRemoteAgentRequest({ op: 'forget', relay: 'short' })).toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentRequest({ op: 'forget' })).toThrow('REMOTE_AGENT_INVALID');
    const directGuest = { shareId: 'share', memberId: 'member', guestDeviceId: 'laptop',
      forgetId: runId, cleanupEpoch: 1 };
    expect(parseRemoteAgentRequest({ op: 'forget', directGuest })).toEqual({ op: 'forget', directGuest });
    expect(() => parseRemoteAgentRequest({ op: 'forget', relay, directGuest })).toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentRequest({ op: 'forget', directGuest: { ...directGuest, forgetId: 'short' } }))
      .toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentRequest({ op: 'forget', directGuest: { ...directGuest, cleanupEpoch: -1 } }))
      .toThrow('REMOTE_AGENT_INVALID');
    const caps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
    expect(parseRemoteAgentCaps({ ...caps, guestRelay: true }).guestRelay).toBe(true);
    expect(parseRemoteAgentCaps({ ...caps, guestRelay: 'yes' })).not.toHaveProperty('guestRelay');
    // Restricted relays require an explicit capability; legacy/non-boolean
    // values cannot authorize forwarding to an older execution host.
    expect(parseRemoteAgentCaps(caps)).not.toHaveProperty('relayModelAccess');
    expect(parseRemoteAgentCaps({ ...caps, relayModelAccess: true }).relayModelAccess).toBe(true);
    expect(parseRemoteAgentCaps({ ...caps, relayModelAccess: 'yes' })).not.toHaveProperty('relayModelAccess');
    const request = { t: 'request', requestId: otherId, request: { type: 'model-access', model: 'opus' } };
    expect(parseRemoteAgentStreamItem(JSON.stringify(request))).toEqual(request);
    expect(parseRemoteAgentStreamItem(JSON.stringify({ ...request, request: { type: 'model-access' } }))).toMatchObject({ request: { type: 'model-access' } });
    for (const model of ['', 1, 'a'.repeat(513)]) {
      expect(() => parseRemoteAgentStreamItem(JSON.stringify({ ...request, request: { type: 'model-access', model } }))).toThrow('REMOTE_AGENT_INVALID');
    }
  });

  // 提供方闲置收回(provider-sharing.md §3)：三个都是可选字段，旧端忽略；不合法的值只当作没有，不能让整条 caps 作废，
  // 也不能把非 true 的值当成 hold / idleReclaimed(前者会让任务永不收回，后者会让控制端误留已结束的连接)。
  it('parses idle reclaim minutes, the poll hold flag and the reclaimed close marker', () => {
    const caps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
    for (const minutes of [0, 30, 1440]) {
      expect(parseRemoteAgentCaps({ ...caps, idleReclaimMinutes: minutes }).idleReclaimMinutes).toBe(minutes);
    }
    for (const minutes of [-1, 1441, 2.5, '30', null]) {
      expect(parseRemoteAgentCaps({ ...caps, idleReclaimMinutes: minutes })).not.toHaveProperty('idleReclaimMinutes');
    }
    expect(parseRemoteAgentRequest({ op: 'poll', runs: [{ runId, cursor: 3, hold: true }, { runId: otherId, cursor: 0, hold: 'yes' }] }))
      .toEqual({ op: 'poll', runs: [{ runId, cursor: 3, hold: true }, { runId: otherId, cursor: 0 }] });
    expect(parseRemoteAgentStreamItem(JSON.stringify({ t: 'closed', reason: 'ended', idleReclaimed: true })))
      .toEqual({ t: 'closed', reason: 'ended', idleReclaimed: true });
    expect(parseRemoteAgentStreamItem(JSON.stringify({ t: 'closed', reason: 'ended', idleReclaimed: 'yes' })))
      .toEqual({ t: 'closed', reason: 'ended' });
  });

  // 转分享(provider-sharing.md §4.3)：组所在电脑把它分享的人报给分享来的组内电脑，由那台的主人逐人同意。
  it('parses the reshare op, its result and the consent capability', () => {
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const other = 'b1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(parseRemoteAgentRequest({
      op: 'reshare',
      entries: [
        { key, name: '  Bob ', avatar: 'https://cdn.example.com/a.png', extra: 1 },
        { key: other, name: 'Carol', avatar: 'http://insecure.example.com/a.png' },
      ],
    })).toEqual({
      op: 'reshare',
      entries: [
        { key, name: 'Bob', avatar: 'https://cdn.example.com/a.png' },
        { key: other, name: 'Carol' },
      ],
    });
    expect(parseRemoteAgentRequest({ op: 'reshare', entries: [] })).toEqual({ op: 'reshare', entries: [] });
    for (const bad of [
      { op: 'reshare' },
      { op: 'reshare', entries: [{ key: 'short', name: 'Bob' }] },
      { op: 'reshare', entries: [{ key, name: '' }] },
      { op: 'reshare', entries: [{ key, name: 'a\u0000b' }] },
      { op: 'reshare', entries: [{ key, name: 'x'.repeat(129) }] },
      { op: 'reshare', entries: [{ key, name: 'Bob' }, { key, name: 'Bob again' }] },
      { op: 'reshare', entries: Array.from({ length: 257 }, (_, i) => ({ key: `${String(i).padStart(3, '0')}${key.slice(3)}`, name: 'x' })) },
    ]) {
      expect(() => parseRemoteAgentRequest(bad)).toThrow('REMOTE_AGENT_INVALID');
    }
    // 回包：不认识的状态与请求外的键丢掉。
    expect(parseRemoteAgentReshareResult({
      entries: [
        { key, state: 'approved' },
        { key: other, state: 'maybe' },
        { key: 'c1b2c3d4e5f60718293a4b5c6d7e8f90', state: 'pending' },
      ],
    }, new Set([key, other]))).toEqual({ entries: [{ key, state: 'approved' }] });
    expect(() => parseRemoteAgentReshareResult({
      entries: [{ key, state: 'pending' }, { key, state: 'approved' }],
    })).toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentReshareResult({
      entries: Array.from({ length: 257 }, (_, index) => ({
        key: String(index).padStart(3, '0') + key.slice(3),
        state: 'pending',
      })),
    })).toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentReshareResult({})).toThrow('REMOTE_AGENT_INVALID');
    const caps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
    expect(parseRemoteAgentCaps({ ...caps, reshareConsent: true }).reshareConsent).toBe(true);
    expect(parseRemoteAgentCaps({ ...caps, reshareConsent: 1 })).not.toHaveProperty('reshareConsent');
    expect(remoteAgentErrorCode('[REMOTE_AGENT_RESHARE_NOT_ALLOWED] no')).toBe('REMOTE_AGENT_RESHARE_NOT_ALLOWED');
  });

  it('parses reshare batches and rejects malformed batch metadata', () => {
    const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const batchId = 'batch-a1b2c3d4e5f6';
    expect(parseRemoteAgentRequest({
      op: 'reshare',
      entries: [{ key, name: 'Bob' }],
      batch: { id: batchId, index: 1, count: 2 },
    })).toEqual({
      op: 'reshare',
      entries: [{ key, name: 'Bob' }],
      batch: { id: batchId, index: 1, count: 2 },
    });
    expect(parseRemoteAgentRequest({
      op: 'reshare',
      entries: [{ key, name: 'Bob' }],
      batch: { id: batchId, index: 4096, count: 4097 },
    })).toMatchObject({ batch: { index: 4096, count: 4097 } });
    expect(parseRemoteAgentReshareResult({
      entries: [{ key, state: 'approved' }],
      batch: { id: batchId, index: 1, count: 2, complete: true },
    }, new Set([key]))).toEqual({
      entries: [{ key, state: 'approved' }],
      batch: { id: batchId, index: 1, count: 2, complete: true },
    });
    for (const batch of [
      { id: 'short', index: 0, count: 1 },
      { id: 123, index: 0, count: 1 },
      { id: batchId, index: -1, count: 2 },
      { id: batchId, index: 2, count: 2 },
      { id: batchId, index: 0, count: 0 },
      { id: batchId, index: 0, count: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => parseRemoteAgentRequest({ op: 'reshare', entries: [{ key, name: 'Bob' }], batch }))
        .toThrow('REMOTE_AGENT_INVALID');
    }
    const caps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
    expect(parseRemoteAgentCaps({ ...caps, reshareConsent: true, reshareBatch: true })).toMatchObject({
      reshareConsent: true,
      reshareBatch: true,
    });
    expect(parseRemoteAgentCaps({ ...caps, reshareBatch: 'yes' })).not.toHaveProperty('reshareBatch');
  });

  it('parses every op and drops unknown fields', () => {
    expect(parseRemoteAgentRequest({ op: 'caps', x: 1 })).toEqual({ op: 'caps' });
    expect(parseRemoteAgentRequest({ op: 'open', runId, agentKind: 'pi', payload: { json: { a: 1 } }, extra: 1 }))
      .toEqual({ op: 'open', runId, agentKind: 'pi', payload: { json: { a: 1 } } });
    expect(parseRemoteAgentRequest({ op: 'call', runId, callId: otherId, method: 'send', payload: { json: [1] } }))
      .toEqual({ op: 'call', runId, callId: otherId, method: 'send', payload: { json: [1] } });
    expect(parseRemoteAgentRequest({ op: 'poll', runs: [{ runId, cursor: 7 }, { runId: otherId, cursor: 0 }] }))
      .toEqual({ op: 'poll', runs: [{ runId, cursor: 7 }, { runId: otherId, cursor: 0 }] });
    expect(parseRemoteAgentRequest({ op: 'reply', runId, requestId: otherId, payload: { uploadId: otherId, chunks: 2, bytes: 10 } }))
      .toEqual({ op: 'reply', runId, requestId: otherId, payload: { uploadId: otherId, chunks: 2, bytes: 10 } });
    expect(parseRemoteAgentRequest({ op: 'push', runId, seq: 3, frames: [{ connId: 'c1', kind: 'message', data: '{}' }] }))
      .toEqual({ op: 'push', runId, seq: 3, frames: [{ connId: 'c1', kind: 'message', data: '{}' }] });
    // Optional busy-state addition to v1: retain only true; legacy senders omit it.
    for (const hold of [true, false, 'true']) {
      expect(parseRemoteAgentRequest({ op: 'push', runId, seq: 3, hold, frames: [{ connId: 'c1', kind: 'message', data: '{}' }] }))
        .toEqual({ op: 'push', runId, seq: 3, ...(hold === true ? { hold: true } : {}), frames: [{ connId: 'c1', kind: 'message', data: '{}' }] });
    }
    expect(parseRemoteAgentRequest({ op: 'close', runId, mode: 'detach', reason: 'navigation' })).toEqual({ op: 'close', runId, mode: 'detach', reason: 'navigation' });
    expect(parseRemoteAgentRequest({ op: 'upload', uploadId: otherId, index: 0, data: 'AAAA' }))
      .toEqual({ op: 'upload', uploadId: otherId, index: 0, data: 'AAAA' });
  });

  // A delayed usage receipt must identify the exact server grant; a new grant for the same M cannot relabel it.
  it('requires a grant generation on delegated usage and grant installation', () => {
    const generation = '11111111-1111-4111-8111-111111111111';
    const identity = { shareId: 'share-1', memberId: 'member-1', guestDeviceId: 'guest-pc', sessionId: 'task-1' };
    const grant = { op: 'delegate', action: 'grant', ...identity, providerId: 'openai', model: 'gpt', generation };
    expect(parseRemoteAgentRequest(grant)).toMatchObject(grant);
    expect(() => parseRemoteAgentRequest({ ...grant, generation: undefined })).toThrow('REMOTE_AGENT_INVALID');
    const usage = { op: 'direct-usage', ...identity, agentKind: 'codex', generation,
      usageId: '22222222-2222-4222-8222-222222222222', samples: [{ model: 'gpt', turns: 1,
        inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 }] };
    expect(parseRemoteAgentRequest(usage)).toMatchObject(usage);
    expect(() => parseRemoteAgentRequest({ ...usage, generation: undefined })).toThrow('REMOTE_AGENT_INVALID');
  });

  it('rejects malformed identities, unknown methods and oversize payloads', () => {
    const bad: unknown[] = [
      null,
      { op: 'nope' },
      { op: 'open', runId: 'x', agentKind: 'pi', payload: { json: 1 } },
      { op: 'open', runId, agentKind: 'gemini', payload: { json: 1 } },
      { op: 'call', runId, callId: otherId, method: 'dispose', payload: { json: [] } },
      { op: 'call', runId, callId: otherId, method: 'send', payload: { json: 'x'.repeat(REMOTE_AGENT_MAX_INLINE_PAYLOAD_CHARS + 1) } },
      { op: 'reply', runId, requestId: otherId, payload: { uploadId: otherId, chunks: 0, bytes: 0 } },
      { op: 'reply', runId, requestId: otherId, payload: { uploadId: otherId, chunks: 1, bytes: REMOTE_AGENT_UPLOAD_CHUNK_BYTES + 1 } },
      { op: 'poll', runs: [{ runId, cursor: -1 }] },
      { op: 'poll', runs: [] },
      { op: 'poll', runs: [{ runId, cursor: 1 }, { runId, cursor: 2 }] },
      { op: 'push', runId, seq: 1, frames: [] },
      { op: 'push', runId, seq: 1, frames: [{ connId: 'bad id!', kind: 'message', data: '' }] },
      { op: 'push', runId, seq: 1, frames: [{ connId: 'c1', kind: 'message' }] },
      { op: 'close', runId, mode: 'kill', reason: 'navigation' },
      { op: 'close', runId, mode: 'close', reason: 'whatever' },
      { op: 'upload', uploadId: otherId, index: 0, data: 'not base64!' },
    ];
    for (const value of bad) expect(() => parseRemoteAgentRequest(value)).toThrow('REMOTE_AGENT_INVALID');
  });

  it('retries only cursor polls after a peer reset', () => {
    expect(isRemoteAgentReadInvoke(REMOTE_AGENT_CHANNEL, [{ op: 'poll', runs: [{ runId, cursor: 0 }] }])).toBe(true);
    expect(isPeerResetRetryableInvoke(REMOTE_AGENT_CHANNEL, [{ op: 'poll', runs: [{ runId, cursor: 0 }] }])).toBe(true);
    for (const op of ['open', 'call', 'reply', 'push', 'close', 'upload', 'caps', 'read']) {
      expect(isPeerResetRetryableInvoke(REMOTE_AGENT_CHANNEL, [{ op }])).toBe(false);
    }
    expect(isPeerResetRetryableInvoke('local-db:sessions:list')).toBe(true);
  });

  it('parses stream items defensively and skips unknown kinds from newer hosts', () => {
    expect(parseRemoteAgentStreamItem(JSON.stringify({ t: 'event', event: { type: 'text', text: 'hi' } })))
      .toEqual({ t: 'event', event: { type: 'text', text: 'hi' } });
    expect(parseRemoteAgentStreamItem(JSON.stringify({ t: 'future-kind' }))).toBeNull();
    expect(parseRemoteAgentStreamItem(JSON.stringify({
      t: 'request', requestId: otherId,
      request: { type: 'http', method: 'POST', path: '/exec/read', headers: [['content-type', 'application/json']], body: 'e30=' },
    }))).toMatchObject({ t: 'request', request: { type: 'http', path: '/exec/read' } });
    expect(parseRemoteAgentStreamItem(JSON.stringify({ t: 'result', callId: otherId, ok: false, error: { code: 'X', message: 'm'.repeat(5000), name: 'AgentNotAuthenticatedError' } })))
      .toMatchObject({ ok: false, error: { code: 'X', name: 'AgentNotAuthenticatedError' } });
    expect(() => parseRemoteAgentStreamItem('{not json')).toThrow('REMOTE_AGENT_INVALID');
    expect(() => parseRemoteAgentStreamItem(JSON.stringify({ t: 'request', requestId: otherId, request: { type: 'http', method: 'POST', path: 'no-slash', headers: [] } })))
      .toThrow('REMOTE_AGENT_INVALID');
  });

  it('validates host replies and read results', () => {
    expect(parseRemoteAgentReply({ type: 'http', status: 200, headers: [], body: 'YQ==' })).toEqual({ type: 'http', status: 200, headers: [], body: 'YQ==' });
    expect(() => parseRemoteAgentReply({ type: 'http', status: 42, headers: [] })).toThrow();
    expect(parseRemoteAgentReadResult({ cursor: 3, data: 'YWJj', done: true })).toEqual({ cursor: 3, data: 'YWJj', done: true });
    expect(parseRemoteAgentPollResult({ runs: [{ runId, cursor: 3, data: 'YWJj' }, { runId: otherId, cursor: 0, missing: true }] }))
      .toEqual({ runs: [{ runId, cursor: 3, data: 'YWJj' }, { runId: otherId, cursor: 0, missing: true }] });
    expect(parseRemoteAgentCaps({ version: 1, agents: [{ kind: 'pi', available: true }, { kind: 'x' }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 10 }))
      .toEqual({ version: 1, agents: [{ kind: 'pi', available: true }], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 10 });
    expect(remoteAgentErrorCode('[REMOTE_AGENT_BUSY] x')).toBe('REMOTE_AGENT_BUSY');
    expect(remoteAgentErrorCode('[REMOTE_AGENT_PEER_TOO_OLD] update')).toBe('REMOTE_AGENT_PEER_TOO_OLD');
    expect(remoteAgentErrorCode('[REMOTE_AGENT_SOMETHING] x')).toBeNull();
  });
});

// #6412: additive native-image recovery must accept old caps and never accept caller paths.
it('negotiates native image recovery and validates scoped chunk requests', () => {
  const caps = { version: 1, agents: [], maxRuns: 1, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
  expect(parseRemoteAgentCaps(caps).imageRecovery).toBeUndefined();
  expect(parseRemoteAgentCaps(caps).imageRecoveryRelay).toBeUndefined();
  expect(parseRemoteAgentCaps({ ...caps, imageRecoveryRelay: true }).imageRecoveryRelay).toBe(true);
  expect(parseRemoteAgentRequest({ op: 'images', sessionId: 'task', relay: 'r'.repeat(16), action: 'release', imageId: 'a'.repeat(64) }))
    .toMatchObject({ relay: 'r'.repeat(16), sessionId: 'task' });
  expect(parseRemoteAgentRequest({ op: 'images', sessionId: 'internal-task', action: 'list' })).toEqual({ op: 'images', sessionId: 'internal-task', action: 'list', offset: 0 });
  expect(parseRemoteAgentCaps({ ...caps, imageRecovery: true }).imageRecovery).toBe(true);
  expect(parseRemoteAgentRequest({ op: 'images', sessionId: runId, action: 'read', imageId: 'a'.repeat(64), offset: 512, path: '/private/image.png' }))
    .toEqual({ op: 'images', sessionId: runId, action: 'read', imageId: 'a'.repeat(64), offset: 512 });
  for (const patch of [{ offset: -1 }, { offset: 0.5 }, { imageId: '../image.png' }, { sessionId: '' }, { relay: '../unsafe' }]) {
    expect(() => parseRemoteAgentRequest({ op: 'images', sessionId: runId, action: 'read', imageId: 'a'.repeat(64), offset: 0, ...patch })).toThrow('REMOTE_AGENT_INVALID');
  }
});


it('negotiates native-history transfer without making mutations retryable on old peers', () => {
  const caps = { version: 1, agents: [], maxRuns: 1, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
  expect(parseRemoteAgentCaps(caps).nativeHistoryTransfer).toBeUndefined();
  expect(parseRemoteAgentCaps({ ...caps, nativeHistoryTransfer: true }).nativeHistoryTransfer).toBe(true);
  expect(parseRemoteAgentCaps({ ...caps, nativeHistoryTransfer: 'yes' }).nativeHistoryTransfer).toBeUndefined();
  const request = { op: 'native-history', sessionId: 'task', command: { action: 'export', kind: 'codex', nativeId: runId } };
  expect(parseRemoteAgentRequest({ ...request, workingDir: '/owner' })).toEqual(request);
  expect(() => parseRemoteAgentRequest({ ...request, sessionId: '../task' })).toThrow('REMOTE_AGENT_INVALID');
  expect(() => parseRemoteAgentRequest({ ...request, command: null })).toThrow('REMOTE_AGENT_INVALID');
  expect(isRemoteAgentReadInvoke(REMOTE_AGENT_CHANNEL, [request])).toBe(false);
  expect(isPeerResetRetryableInvoke(REMOTE_AGENT_CHANNEL, [request])).toBe(false);
});
