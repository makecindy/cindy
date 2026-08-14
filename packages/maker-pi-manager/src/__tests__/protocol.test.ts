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
  // ---- 合法通过 ----
  describe('valid messages', () => {
    it('accepts a valid request', () => {
      expect(isRpcMessage({ type: 'request', id: 1, method: 'test' })).toBe(true);
    });

    it('accepts a request with id = 0', () => {
      expect(isRpcMessage({ type: 'request', id: 0, method: 't' })).toBe(true);
    });

    it('accepts a valid response with result', () => {
      expect(
        isRpcMessage({ type: 'response', id: 1, result: 'ok' }),
      ).toBe(true);
    });

    it('accepts a valid response with error', () => {
      expect(
        isRpcMessage({
          type: 'response',
          id: 42,
          error: { code: 'INTERNAL', message: 'boom' },
        }),
      ).toBe(true);
    });

    it('accepts a response without result/error (ack pattern)', () => {
      expect(isRpcMessage({ type: 'response', id: 99 })).toBe(true);
    });

    it('accepts a valid notification', () => {
      expect(isRpcMessage({ type: 'notification', method: 'session/closed' })).toBe(
        true,
      );
    });

    it('accepts a notification with params', () => {
      expect(
        isRpcMessage({
          type: 'notification',
          method: 'session/closed',
          params: { sessionId: 'abc' },
        }),
      ).toBe(true);
    });
  });

  // ---- NaN id 拒绝 ----
  describe('NaN id', () => {
    it('rejects request with NaN id', () => {
      expect(
        isRpcMessage({ type: 'request', id: NaN, method: 'test' }),
      ).toBe(false);
    });

    it('rejects response with NaN id', () => {
      expect(isRpcMessage({ type: 'response', id: NaN })).toBe(false);
    });
  });

  // ---- Infinity id 拒绝 ----
  describe('Infinity id', () => {
    it('rejects request with Infinity id', () => {
      expect(
        isRpcMessage({ type: 'request', id: Infinity, method: 'test' }),
      ).toBe(false);
    });

    it('rejects request with -Infinity id', () => {
      expect(
        isRpcMessage({ type: 'request', id: -Infinity, method: 'test' }),
      ).toBe(false);
    });

    it('rejects response with Infinity id', () => {
      expect(isRpcMessage({ type: 'response', id: Infinity })).toBe(false);
    });
  });

  // ---- 负数 id 允许(server→client 反向请求需要负数 id 命名空间) ----
  describe('negative id (accepted for bidirectional use)', () => {
    it('accepts request with id = -1 (used by server→client reverse request)', () => {
      expect(
        isRpcMessage({ type: 'request', id: -1, method: 'test' }),
      ).toBe(true);
    });

    it('accepts request with id = Number.MIN_SAFE_INTEGER', () => {
      expect(
        isRpcMessage({
          type: 'request',
          id: Number.MIN_SAFE_INTEGER,
          method: 'test',
        }),
      ).toBe(true);
    });

    it('accepts response with id = -1 (client responds to server reverse request)', () => {
      expect(isRpcMessage({ type: 'response', id: -1 })).toBe(true);
    });

    it('accepts response with decrementing negative id = -10', () => {
      expect(isRpcMessage({ type: 'response', id: -10 })).toBe(true);
    });
  });

  // ---- float id 拒绝 ----
  describe('float id', () => {
    it('rejects request with float id', () => {
      expect(
        isRpcMessage({ type: 'request', id: 1.5, method: 'test' }),
      ).toBe(false);
    });

    it('rejects request with id = 0.1', () => {
      expect(
        isRpcMessage({ type: 'request', id: 0.1, method: 'test' }),
      ).toBe(false);
    });

    it('rejects response with float id', () => {
      expect(isRpcMessage({ type: 'response', id: 1.5 })).toBe(false);
    });
  });

  // ---- 缺 id ----
  describe('missing id', () => {
    it('rejects request without id', () => {
      expect(
        isRpcMessage({ type: 'request', method: 'test' }),
      ).toBe(false);
    });

    it('rejects response without id', () => {
      expect(isRpcMessage({ type: 'response' })).toBe(false);
    });
  });

  // ---- 缺 method ----
  describe('missing method', () => {
    it('rejects request without method', () => {
      expect(isRpcMessage({ type: 'request', id: 1 })).toBe(false);
    });

    it('rejects notification without method', () => {
      expect(
        isRpcMessage({ type: 'notification', params: {} }),
      ).toBe(false);
    });
  });

  // ---- 未知 type ----
  describe('unknown type', () => {
    it('rejects unknown type string', () => {
      expect(isRpcMessage({ type: 'event', id: 1 })).toBe(false);
    });

    it('rejects empty type', () => {
      expect(isRpcMessage({ type: '', id: 1 })).toBe(false);
    });
  });

  // ---- 非 object ----
  describe('non-object values', () => {
    it('rejects null', () => {
      expect(isRpcMessage(null)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(isRpcMessage(undefined)).toBe(false);
    });

    it('rejects string', () => {
      expect(isRpcMessage('not an object')).toBe(false);
    });

    it('rejects number', () => {
      expect(isRpcMessage(42)).toBe(false);
    });

    it('rejects boolean', () => {
      expect(isRpcMessage(true)).toBe(false);
    });

    it('rejects array', () => {
      expect(isRpcMessage([1, 2, 3])).toBe(false);
    });

    it('rejects function', () => {
      expect(isRpcMessage(() => {})).toBe(false);
    });
  });

  // ---- 边缘 ----
  describe('edge cases', () => {
    it('rejects request with null method', () => {
      expect(
        isRpcMessage({ type: 'request', id: 1, method: null }),
      ).toBe(false);
    });

    it('rejects request with id as string', () => {
      expect(
        isRpcMessage({ type: 'request', id: '42', method: 'test' }),
      ).toBe(false);
    });

    it('rejects object without type', () => {
      expect(isRpcMessage({ id: 1, method: 'test' })).toBe(false);
    });

    it('accepts request with params = undefined (implicit)', () => {
      expect(isRpcMessage({ type: 'request', id: 1, method: 'test' })).toBe(true);
    });
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
