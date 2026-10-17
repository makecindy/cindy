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

describe('remote agent channel', () => {
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
    const caps = { version: 1, agents: [], maxRuns: 16, uploadChunkBytes: 1024, maxPayloadBytes: 2048 };
    expect(parseRemoteAgentCaps({ ...caps, guestRelay: true }).guestRelay).toBe(true);
    expect(parseRemoteAgentCaps({ ...caps, guestRelay: 'yes' })).not.toHaveProperty('guestRelay');
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
    expect(parseRemoteAgentRequest({ op: 'close', runId, mode: 'detach', reason: 'navigation' })).toEqual({ op: 'close', runId, mode: 'detach', reason: 'navigation' });
    expect(parseRemoteAgentRequest({ op: 'upload', uploadId: otherId, index: 0, data: 'AAAA' }))
      .toEqual({ op: 'upload', uploadId: otherId, index: 0, data: 'AAAA' });
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
    expect(remoteAgentErrorCode('[REMOTE_AGENT_SOMETHING] x')).toBeNull();
  });
});
