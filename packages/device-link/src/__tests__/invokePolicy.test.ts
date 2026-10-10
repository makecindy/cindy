import { describe, expect, it } from 'vitest';
import {
  canCoalesceRemoteListing,
  isPeerResetRetryableReadChannel,
  isCompletedInvokeRetryableReadChannel,
  resolveRemoteInvokeTimeoutMs,
  TASK_MIGRATION_CHANNEL,
} from '../index.js';

describe('remote invoke policy boundaries', () => {
  it.each(['desktop', 'mobile'] as const)('waits for group sends only on %s without replaying writes', (platform) => {
    const channel = 'maker:remote-resources:invoke';
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ collectionId: 'bot-groups', actionId: 'send' }], platform)).toBe(180_000);
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ collectionId: 'bot-groups', actionId: 'update' }], platform)).not.toBe(180_000);
    expect(resolveRemoteInvokeTimeoutMs(channel, [{ collectionId: 'teammates', actionId: 'send' }], platform)).not.toBe(180_000);
    expect(isPeerResetRetryableReadChannel(channel)).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
  });

  it('gives predictions the host budget on both controllers without automatic link retries', () => {
    expect(resolveRemoteInvokeTimeoutMs('maker:predict-prompt', [], 'mobile')).toBe(45_000);
    expect(resolveRemoteInvokeTimeoutMs('maker:predict-prompt', [], 'desktop')).toBe(45_000);
    expect(isPeerResetRetryableReadChannel('maker:predict-prompt')).toBe(false);
    expect(isCompletedInvokeRetryableReadChannel('maker:predict-prompt')).toBe(false);
  });
  it.each(['local-db:sessions:list', 'local-db:sessions:get', 'local-db:sessions:get-many', 'local-db:sessions:interrupted-pending', 'maker:list-active'])(
    'explicitly permits retrying completed %s reads', (channel) => {
      expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(true);
    },
  );

  it.each([
    'maker:remote-resources:list', 'maker:remote-resources:get',
    'local-db:bots:list', 'local-db:bots:get',
    'maker:send', 'maker:input:enqueue',
    'maker:get-capabilities', 'maker:provider:list', 'maker:git-safety:get',
    'maker:schedule:list-sidebar-index-runs', 'unknown:list', undefined,
  ])('does not infer completed retry safety for %s from listing, peer-reset or background classification', (channel) => {
    expect(isCompletedInvokeRetryableReadChannel(channel)).toBe(false);
  });

  it('allows retrying a read without sharing a snapshot from before a write', () => {
    expect(isPeerResetRetryableReadChannel('local-db:sessions:get')).toBe(true);
    expect(isPeerResetRetryableReadChannel('local-db:sessions:get-many')).toBe(true);
    expect(canCoalesceRemoteListing({ channel: 'local-db:sessions:get-many', args: [['id']] })).toBe(false);
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
  it('gives the read-only task copy estimate a longer budget than other copy requests', () => {
    const budget = (action: string) =>
      resolveRemoteInvokeTimeoutMs(TASK_MIGRATION_CHANNEL, [{ action, sessionId: 's' }], 'desktop');
    expect(budget('estimate')).toBe(3 * 60_000);
    expect(budget('receive')).toBe(30 * 60_000);
    expect(budget('status')).toBe(30_000);
    expect(budget('caps')).toBe(30_000);
  });
});
