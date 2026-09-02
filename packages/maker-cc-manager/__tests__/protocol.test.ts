import { describe, expect, it } from 'vitest';

import {
  CC_MGR_BUNDLE_VERSION,
  PROTOCOL_VERSION,
  METHODS,
  NOTIFICATIONS,
  SERVER_METHODS,
  isRpcMessage,
  isRpcRequest,
  isRpcResponse,
  isRpcNotification,
  makeRpcError,
} from '../src/protocol.js';

describe('protocol constants', () => {
  it('PROTOCOL_VERSION is a positive integer', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('requires v4 so old daemons cannot ignore subagent model preflight', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(4);
  });

  it('requires v6 so old daemons cannot ignore either v5 wire contract', () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });

  it('bumps the daemon bundle when the wire contract changes', () => {
    expect(CC_MGR_BUNDLE_VERSION).toBe('0.0.11');
  });

  it('METHODS has expected method names', () => {
    expect(METHODS.PROTOCOL_HELLO).toBe('protocol/hello');
    expect(METHODS.QUERY_START).toBe('query/start');
    expect(METHODS.QUERY_SEND).toBe('query/send');
    expect(METHODS.QUERY_GET_CONTEXT_USAGE).toBe('query/getContextUsage');
    expect(METHODS.QUERY_INTERRUPT).toBe('query/interrupt');
    expect(METHODS.SESSION_ATTACH).toBe('session/attach');
    expect(METHODS.SESSION_LIST).toBe('session/list');
  });

  it('NOTIFICATIONS has expected notification names', () => {
    expect(NOTIFICATIONS.QUERY_EVENT).toBe('query/event');
    expect(NOTIFICATIONS.SESSION_CLOSED).toBe('session/closed');
    expect(NOTIFICATIONS.CLIENT_REPLACED).toBe('client/replaced');
  });

  it('declares the live subagent model access reverse request', () => {
    expect(SERVER_METHODS.SUBAGENT_MODEL_ACCESS).toBe('subagent/model-access');
  });
});

describe('isRpcMessage', () => {
  it('accepts a valid request', () => {
    expect(
      isRpcMessage({
        type: 'request',
        id: 1,
        method: 'x',
        params: {},
      }),
    ).toBe(true);
  });

  it('accepts a valid response', () => {
    expect(isRpcMessage({ type: 'response', id: 1, result: { ok: true } })).toBe(true);
    expect(isRpcMessage({ type: 'response', id: 1, error: { code: 'INTERNAL', message: 'x' } })).toBe(
      true,
    );
  });

  it('accepts a valid notification', () => {
    expect(isRpcMessage({ type: 'notification', method: 'evt', params: {} })).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isRpcMessage(null)).toBe(false);
    expect(isRpcMessage(42)).toBe(false);
    expect(isRpcMessage('hi')).toBe(false);
    expect(isRpcMessage([])).toBe(false);
  });

  it('rejects request without numeric id', () => {
    expect(isRpcMessage({ type: 'request', id: 'one', method: 'x', params: {} })).toBe(false);
  });

  it('rejects request without method', () => {
    expect(isRpcMessage({ type: 'request', id: 1, params: {} })).toBe(false);
  });

  it('rejects response without id', () => {
    expect(isRpcMessage({ type: 'response', result: {} })).toBe(false);
  });

  it('rejects notification without method', () => {
    expect(isRpcMessage({ type: 'notification', params: {} })).toBe(false);
  });

  it('rejects unknown type', () => {
    expect(isRpcMessage({ type: 'whatever', id: 1 })).toBe(false);
  });
});

describe('isRpcRequest / isRpcResponse / isRpcNotification narrowing', () => {
  it('isRpcRequest only matches requests', () => {
    expect(
      isRpcRequest({ type: 'request', id: 1, method: 'x', params: {} }),
    ).toBe(true);
    expect(isRpcRequest({ type: 'response', id: 1, result: {} })).toBe(false);
    expect(isRpcRequest({ type: 'notification', method: 'x', params: {} })).toBe(false);
  });

  it('isRpcResponse only matches responses', () => {
    expect(isRpcResponse({ type: 'response', id: 1, result: {} })).toBe(true);
    expect(isRpcResponse({ type: 'request', id: 1, method: 'x', params: {} })).toBe(false);
  });

  it('isRpcNotification only matches notifications', () => {
    expect(isRpcNotification({ type: 'notification', method: 'x', params: {} })).toBe(true);
    expect(isRpcNotification({ type: 'request', id: 1, method: 'x', params: {} })).toBe(false);
  });
});

describe('makeRpcError', () => {
  it('builds an error with code and message', () => {
    const err = makeRpcError('INTERNAL', 'boom');
    expect(err).toEqual({ code: 'INTERNAL', message: 'boom' });
  });

  it('includes data when provided', () => {
    const err = makeRpcError('SDK_ERROR', 'failed', { detail: 'foo' });
    expect(err).toEqual({ code: 'SDK_ERROR', message: 'failed', data: { detail: 'foo' } });
  });

  it('omits data when undefined', () => {
    const err = makeRpcError('INTERNAL', 'boom', undefined);
    expect(err).not.toHaveProperty('data');
  });
});
