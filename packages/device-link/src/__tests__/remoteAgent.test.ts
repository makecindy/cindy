import { describe, expect, it } from 'vitest';
import {
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
  parseRemoteAgentStreamItem,
  remoteAgentErrorCode,
} from '../index';

const runId = '0f9c4a2e-6d1b-4c3a-9e8f-1a2b3c4d5e6f';
const otherId = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

describe('remote agent channel', () => {
  // Shared-task guests are refused by the desktop shared-task gate (not in its channel list).
  it('is registered on the same-account allowlist', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(REMOTE_AGENT_CHANNEL)).toBe(true);
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
