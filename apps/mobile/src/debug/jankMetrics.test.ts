import { afterEach, describe, expect, it } from "vitest";
import {
  invokeMetricLabel,
  recordGunzip,
  recordInvokeSent,
  recordInvokeTransfer,
  recordLoopLag,
  recordPushHandled,
  recordUiThreadLag,
  setJankMetricsEnabled,
  setRemoteSessionStoreSizeSource,
  takeJankMetrics,
  takeSyncWorkMetrics,
} from "./jankMetrics";
import { serializeMobileDebugRecord } from "./mobileDebugRecord";

const store = {
  sessionCount: 2,
  messageCount: 120,
  maxSessionMessageCount: 80,
  subscriberCount: 40,
  homeStatusSubscriberCount: 12,
  previewSubscriberCount: 30,
};

describe("jank metrics", () => {
  afterEach(() => setJankMetricsEnabled(false));

  // Unit, PR #6325: the single-channel case misses the writer's 120-value budget.
  // Exercise the real serializer with full push/invoke lists and a large transfer
  // inserted last; important bytes and all emitted rows must survive on disk.
  it("keeps the largest relay channels within the actual log writer budget", () => {
    setJankMetricsEnabled(true);
    setRemoteSessionStoreSizeSource(() => store);
    for (let i = 0; i < 10; i++) {
      const channel = `channel:${i}`;
      recordPushHandled(channel, i + 1);
      recordInvokeSent(channel);
      recordInvokeTransfer({ channel, phase: 'sent' });
      recordInvokeTransfer({ channel, phase: 'result', payloadBytes: (i + 1) * 100 });
    }
    const line = serializeMobileDebugRecord('debug', 'performance', ['jank metrics', takeJankMetrics()]);
    expect(line).not.toContain('[truncated]');
    const snapshot = JSON.parse(line).args[1];
    expect(snapshot.relayTransfers[0]).toMatchObject({ channel: 'channel:9', payloadBytes: 1000 });
    expect(snapshot.relayTransfers).toHaveLength(6);
    expect(snapshot.relayTransfersOmitted).toBe(4);
    expect(snapshot.pushCount).toBe(10);
    expect(snapshot.invokeCount).toBe(10);
  });

  it("records nothing while diagnostics are off", () => {
    recordPushHandled("local-db:messages:created", 5);
    setJankMetricsEnabled(true);
    expect(takeJankMetrics()).toMatchObject({
      pushCount: 0,
      invokeCount: 0,
      pushes: [],
      invokes: [],
    });
  });

  it("reports per-channel push time and request counts for one interval, then resets", () => {
    setJankMetricsEnabled(true);
    setRemoteSessionStoreSizeSource(() => store);
    recordPushHandled("maker:event", 1);
    recordPushHandled("local-db:messages:created", 4);
    recordPushHandled("local-db:messages:created", 10);
    recordInvokeSent("git-context:pr-status");
    recordInvokeSent("git-context:pr-status");

    expect(takeJankMetrics()).toEqual({
      store,
      pushCount: 3,
      pushMs: 15,
      pushes: [
        {
          channel: "local-db:messages:created",
          count: 2,
          totalMs: 14,
          maxMs: 10,
        },
        { channel: "maker:event", count: 1, totalMs: 1, maxMs: 1 },
      ],
      invokeCount: 2,
      invokes: [{ channel: "git-context:pr-status", count: 2 }],
      relayTransfers: [],
      relayTransfersOmitted: 0,
    });
    expect(takeJankMetrics()).toMatchObject({ pushCount: 0, invokeCount: 0 });
  });

  it("reports sync work on its own line, within the writer budget, then resets", () => {
    setJankMetricsEnabled(true);
    for (let i = 0; i < 10; i++) {
      recordInvokeTransfer({ channel: `channel:${i}`, phase: 'decoded', inflateMs: i, parseMs: 1 });
    }
    const channel = invokeMetricLabel('maker:remote-resources:invoke', [{ collectionId: 'plugins', actionId: 'settings:open' }]);
    recordInvokeTransfer({ channel, phase: 'result', payloadBytes: 950_000, gzip: true });
    recordInvokeTransfer({ channel, phase: 'decoded', inflateMs: 812.4, parseMs: 96.6 });
    recordGunzip({ offThread: true });
    recordGunzip({ offThread: false, onThreadMs: 40.4, fallback: true });
    recordLoopLag(100);
    recordLoopLag(1500);
    recordUiThreadLag(20);
    recordUiThreadLag(700);

    const line = serializeMobileDebugRecord('debug', 'performance', ['sync work metrics', takeSyncWorkMetrics()]);
    expect(line).not.toContain('[truncated]');
    expect(line).not.toContain('[redacted]');
    const snapshot = JSON.parse(line).args[1];
    expect(snapshot.decodes).toHaveLength(6);
    expect(snapshot.decodes[0]).toEqual({
      channel: 'maker:remote-resources:invoke#plugins/settings:open', count: 1, inflateMs: 812, parseMs: 97,
    });
    expect(snapshot).toMatchObject({
      gunzip: { offThread: 1, onThread: 1, onThreadMs: 40, fallbacks: 1 },
      loopLag: { maxMs: 1500, over250: 1, over1000: 1 },
      uiThread: { pings: 2, maxLagMs: 700, over250: 1 },
    });
    expect(takeSyncWorkMetrics()).toEqual({
      decodes: [],
      gunzip: { offThread: 0, onThread: 0, onThreadMs: 0, fallbacks: 0 },
      loopLag: { maxMs: 0, over250: 0, over1000: 0 },
      uiThread: { pings: 0, maxLagMs: 0, over250: 0 },
    });
  });

  it("names a resource action only from the known allowlist", () => {
    const label = (request: unknown) => invokeMetricLabel('maker:remote-resources:invoke', [request]);
    expect(invokeMetricLabel('git-context:pr-status', [{ actionId: 'ignored' }])).toBe('git-context:pr-status');
    expect(label({ collectionId: 'teammates', actionId: 'management:settings', input: { op: 'channels.im.listLanes' } }))
      .toBe('maker:remote-resources:invoke#teammates/management:settings/channels.im.listLanes');
    expect(label({ collectionId: 'plugins', actionId: 'settings:open' }))
      .toBe('maker:remote-resources:invoke#plugins/settings:open');
    // Harmless-looking but unknown values, including ones a host or plugin chooses, are not logged.
    expect(label({
      collectionId: 'acme-private',
      actionId: 'opaque-token',
      resourceRef: { id: 'instance-id' },
      input: { query: 'private text', op: 'opaque-op' },
    })).toBe('maker:remote-resources:invoke#?/?/?');
    expect(label({ collectionId: 'plugins', actionId: 'manage_connection:connection:acct-secret-id' }))
      .toBe('maker:remote-resources:invoke#plugins/?');
    expect(label(undefined)).toBe('maker:remote-resources:invoke#?/?');
  });

  it("keeps every number through the debug log redaction", () => {
    setJankMetricsEnabled(true);
    setRemoteSessionStoreSizeSource(() => store);
    // Channel names that look sensitive must not take their counts with them.
    recordPushHandled("auth:token-refreshed", 3);
    recordInvokeSent("local-db:messages:view");
    recordInvokeTransfer({ channel: 'local-db:messages:view', phase: 'sent' });
    recordInvokeTransfer({ channel: 'local-db:messages:view', phase: 'result', payloadBytes: 95, notModified: true });
    const line = serializeMobileDebugRecord("debug", "performance", [
      "jank metrics",
      takeJankMetrics(),
    ]);

    expect(line).not.toContain("[redacted]");
    expect(JSON.parse(line).args[1]).toMatchObject({
      store,
      pushes: [{ count: 1, totalMs: 3 }],
      invokes: [{ channel: "local-db:messages:view", count: 1 }],
      relayTransfers: [{ channel: 'local-db:messages:view', sent: 1, results: 1, payloadBytes: 95, notModified: 1, gzip: 0 }],
    });
    expect(takeJankMetrics().relayTransfers).toEqual([]);
  });
});
