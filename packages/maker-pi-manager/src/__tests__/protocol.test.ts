/**
 * protocol.test.ts — isRpcMessage / makeRpcError / type guards 完整覆盖。
 *
 * 覆盖清单 (自审轮 9):
 *   isRpcMessage 守卫:合法 request/response/notification 通过;
 *     NaN id / Infinity id / 负数 id / float id / 缺 id / 缺 method 拒绝;
 *     未知 type / null / string / array 拒绝。
 *   makeRpcError:有 data / 无 data / undefined data / null data 四种形态。
 *   附属守卫:isRpcRequest / isRpcResponse / isRpcNotification。
 */

import { describe, expect, it } from 'vitest';

import {
  isRpcMessage,
  isRpcRequest,
  isRpcResponse,
  isRpcNotification,
  makeRpcError,
  PROTOCOL_VERSION,
  PI_MANAGER_BUNDLE_VERSION,
  METHODS,
  NOTIFICATIONS,
} from '../protocol.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
describe('PROTOCOL_VERSION', () => {
  it('should be 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('PI_MANAGER_BUNDLE_VERSION', () => {
  it('should be a semver string', () => {
    expect(PI_MANAGER_BUNDLE_VERSION).toBe('0.1.5');
  });
});

describe('METHODS', () => {
  it('should expose all method names', () => {
    expect(METHODS.PROTOCOL_HELLO).toBe('protocol/hello');
    expect(METHODS.PI_ENSURE).toBe('pi/ensure');
    expect(METHODS.PI_KILL).toBe('pi/kill');
    expect(METHODS.PI_LIST).toBe('pi/list');
    expect(METHODS.PI_SHUTDOWN).toBe('pi/shutdown');
  });
});

describe('NOTIFICATIONS', () => {
  it('should expose all notification names', () => {
    expect(NOTIFICATIONS.SESSION_CLOSED).toBe('session/closed');
  });
});

// ---------------------------------------------------------------------------
// isRpcMessage — 主守卫
// ---------------------------------------------------------------------------
describe('isRpcMessage', () => {
  // Each row remains an independently reported case, including omitted fields.
  it.each<[string, unknown]>([
    ['accepts a valid request', { type: 'request', id: 1, method: 'test' }],
    ['accepts a request with id = 0', { type: 'request', id: 0, method: 't' }],
    ['accepts a valid response with result', { type: 'response', id: 1, result: 'ok' }],
    ['accepts a valid response with error', {
      type: 'response', id: 42, error: { code: 'INTERNAL', message: 'boom' },
    }],
    ['accepts a response without result/error (ack pattern)', { type: 'response', id: 99 }],
    ['accepts a valid notification', { type: 'notification', method: 'session/closed' }],
    ['accepts a notification with params', {
      type: 'notification', method: 'session/closed', params: { sessionId: 'abc' },
    }],
    // Negative IDs belong to the server-to-client reverse request namespace.
    ['accepts request with id = -1 (used by server→client reverse request)', {
      type: 'request', id: -1, method: 'test',
    }],
    ['accepts request with id = Number.MIN_SAFE_INTEGER', {
      type: 'request', id: Number.MIN_SAFE_INTEGER, method: 'test',
    }],
    ['accepts response with id = -1 (client responds to server reverse request)', {
      type: 'response', id: -1,
    }],
    ['accepts response with decrementing negative id = -10', { type: 'response', id: -10 }],
    ['accepts request with params = undefined (implicit)', {
      type: 'request', id: 1, method: 'test',
    }],
  ])('%s', (_name, input) => {
    expect(isRpcMessage(input)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['rejects request with NaN id', { type: 'request', id: NaN, method: 'test' }],
    ['rejects response with NaN id', { type: 'response', id: NaN }],
    ['rejects request with Infinity id', { type: 'request', id: Infinity, method: 'test' }],
    ['rejects request with -Infinity id', { type: 'request', id: -Infinity, method: 'test' }],
    ['rejects response with Infinity id', { type: 'response', id: Infinity }],
    ['rejects request with float id', { type: 'request', id: 1.5, method: 'test' }],
    ['rejects request with id = 0.1', { type: 'request', id: 0.1, method: 'test' }],
    ['rejects response with float id', { type: 'response', id: 1.5 }],
    ['rejects request without id', { type: 'request', method: 'test' }],
    ['rejects response without id', { type: 'response' }],
    ['rejects request without method', { type: 'request', id: 1 }],
    ['rejects notification without method', { type: 'notification', params: {} }],
    ['rejects unknown type string', { type: 'event', id: 1 }],
    ['rejects empty type', { type: '', id: 1 }],
    ['rejects null', null],
    ['rejects undefined', undefined],
    ['rejects string', 'not an object'],
    ['rejects number', 42],
    ['rejects boolean', true],
    ['rejects array', [1, 2, 3]],
    ['rejects function', () => {}],
    ['rejects request with null method', { type: 'request', id: 1, method: null }],
    ['rejects request with id as string', { type: 'request', id: '42', method: 'test' }],
    ['rejects object without type', { id: 1, method: 'test' }],
  ])('%s', (_name, input) => {
    expect(isRpcMessage(input)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 附属 type guards
// ---------------------------------------------------------------------------
describe('isRpcRequest', () => {
  it('returns true for a request', () => {
    expect(
      isRpcRequest({ type: 'request', id: 1, method: 't', params: {} }),
    ).toBe(true);
  });

  it('returns false for a response', () => {
    expect(isRpcRequest({ type: 'response', id: 1 })).toBe(false);
  });

  it('returns false for a notification', () => {
    expect(
      isRpcRequest({ type: 'notification', method: 't', params: {} }),
    ).toBe(false);
  });
});

describe('isRpcResponse', () => {
  it('returns true for a response', () => {
    expect(isRpcResponse({ type: 'response', id: 1 })).toBe(true);
  });

  it('returns false for a request', () => {
    expect(
      isRpcResponse({ type: 'request', id: 1, method: 't', params: {} }),
    ).toBe(false);
  });

  it('returns false for a notification', () => {
    expect(
      isRpcResponse({ type: 'notification', method: 't', params: {} }),
    ).toBe(false);
  });
});

describe('isRpcNotification', () => {
  it('returns true for a notification', () => {
    expect(
      isRpcNotification({ type: 'notification', method: 't', params: {} }),
    ).toBe(true);
  });

  it('returns false for a request', () => {
    expect(
      isRpcNotification({ type: 'request', id: 1, method: 't', params: {} }),
    ).toBe(false);
  });

  it('returns false for a response', () => {
    expect(isRpcNotification({ type: 'response', id: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeRpcError
// ---------------------------------------------------------------------------
describe('makeRpcError', () => {
  it('creates error without data (no data property)', () => {
    const err = makeRpcError('INTERNAL', 'test message');
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('test message');
    expect(err).not.toHaveProperty('data');
    expect(Object.keys(err)).toEqual(['code', 'message']);
  });

  it('creates error with data', () => {
    const err = makeRpcError('INVALID_PARAMS', 'bad input', { field: 'cmd' });
    expect(err).toEqual({
      code: 'INVALID_PARAMS',
      message: 'bad input',
      data: { field: 'cmd' },
    });
  });

  it('creates error with undefined data (data key omitted)', () => {
    const err = makeRpcError('SESSION_NOT_FOUND', 'gone', undefined);
    expect(err).toEqual({ code: 'SESSION_NOT_FOUND', message: 'gone' });
    expect(err).not.toHaveProperty('data');
  });

  it('creates error with null data', () => {
    const err = makeRpcError('UNKNOWN_METHOD', '??', null);
    expect(err).toEqual({
      code: 'UNKNOWN_METHOD',
      message: '??',
      data: null,
    });
  });

  it('creates error with nested data', () => {
    const err = makeRpcError('INTERNAL', 'spawn failed', {
      exitCode: 1,
      stderr: '/bin/sh: not found',
    });
    expect(err.data).toEqual({ exitCode: 1, stderr: '/bin/sh: not found' });
  });

  it('supports all RpcErrorCode values', () => {
    const codes = [
      'INVALID_PROTOCOL_VERSION',
      'UNKNOWN_METHOD',
      'INVALID_PARAMS',
      'NOT_INITIALIZED',
      'SESSION_NOT_FOUND',
      'SESSION_ALREADY_EXISTS',
      'SESSION_KILL_SURVIVED',
      'INTERNAL',
    ] as const;
    for (const code of codes) {
      const err = makeRpcError(code, code);
      expect(err.code).toBe(code);
    }
  });
});
