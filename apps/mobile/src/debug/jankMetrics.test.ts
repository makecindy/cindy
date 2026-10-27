import { afterEach, describe, expect, it } from "vitest";
import {
  recordInvokeSent,
  recordInvokeTransfer,
  recordPushHandled,
  setJankMetricsEnabled,
  setRemoteSessionStoreSizeSource,
  takeJankMetrics,
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
