import { describe, expect, it } from 'vitest';
import {
  canCoalesceRemoteListing,
  isPeerResetRetryableReadChannel,
  resolveRemoteInvokeTimeoutMs,
} from '../index.js';

describe('remote invoke policy boundaries', () => {
  it('allows retrying a read without sharing a snapshot from before a write', () => {
    expect(isPeerResetRetryableReadChannel('local-db:sessions:get')).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:get', args: ['id'] })).toBe(false);
    expect(isPeerResetRetryableReadChannel('local-db:sessions:list')).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:list', args: [] })).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:list', args: [null, null, { fresh: true }] })).toBe(false);
  });

  it.each(['maker:send', 'maker:create-session', 'maker:schedule:mark-run-read', 'unknown:read'])(
    'does not infer retry or coalescing permission from %s', (channel) => {
      expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
      expect(canCoalesceRemoteListing({ channel, args: [] })).toBe(false);
    },
  );

  it('preserves schedule index coalescing without enabling peer-reset retries', () => {
    const channel = 'maker:schedule:list-sidebar-index-runs';
    expect(canCoalesceRemoteListing({ channel, args: [] })).toBe(true);
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
  });

  it('keeps mobile execution budgets and desktop defaults separate', () => {
    expect(resolveRemoteInvokeTimeoutMs('maker:send', [], 'mobile')).toBe(30_000);
    expect(resolveRemoteInvokeTimeoutMs('maker:send', [], 'desktop')).toBeUndefined();
    expect(resolveRemoteInvokeTimeoutMs('maker:schedule:list', [], 'mobile')).toBe(40_000);
    expect(resolveRemoteInvokeTimeoutMs('device-link:remote-desktop:v1', [{ op: 'heartbeat' }], 'mobile')).toBe(5_000);
    expect(resolveRemoteInvokeTimeoutMs('device-link:remote-desktop:v1', [{ op: 'heartbeat' }], 'desktop')).toBe(59_000);
    expect(resolveRemoteInvokeTimeoutMs('unknown:read', [], 'mobile')).toBeUndefined();
  });
});
