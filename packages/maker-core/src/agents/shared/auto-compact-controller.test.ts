import { describe, expect, it } from 'vitest';

import type { Logger } from '../../interfaces/logger.js';
import { AutoCompactController, isDeterministicHostCompactFailure } from './auto-compact-controller.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function makeController(
  getThresholdPct: () => number | undefined,
  compactWhenFull?: boolean,
): AutoCompactController {
  return new AutoCompactController({
    logger: noopLogger,
    workdir: '/tmp/project',
    agentKind: 'claude-code',
    getThresholdPct,
    compactWhenFull,
  });
}

describe('AutoCompactController', () => {
  it('triggers once after crossing the threshold', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(150, 200);

    expect(controller.shouldCompactNow()).toBe(true);
    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('can trigger again after compact boundary resets fired state', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(150, 200);
    expect(controller.shouldCompactNow()).toBe(true);

    controller.onCompactBoundary();
    controller.onUsageUpdate(160, 200);

    expect(controller.shouldCompactNow()).toBe(true);
  });

  it('can trigger again after compact is canceled before boundary', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(150, 200);
    expect(controller.shouldCompactNow()).toBe(true);

    controller.onCompactCanceled('bridge_aborted');

    expect(controller.shouldCompactNow()).toBe(true);
  });

  it('does not reuse stale usage after compact boundary', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(150, 200);
    expect(controller.shouldCompactNow()).toBe(true);

    controller.onCompactBoundary();

    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('does not trigger when threshold is undefined', () => {
    const controller = makeController(() => undefined);

    controller.onUsageUpdate(190, 200);

    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('does not trigger below the threshold', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(149, 200);

    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('recomputes ratio when the context window changes (large → small model switch)', () => {
    const controller = makeController(() => 75);

    // 150K / 1M = 15% — 远低于阈值
    controller.onUsageUpdate(150_000, 1_000_000);
    expect(controller.shouldCompactNow()).toBe(false);

    // 切到 200K 窗口模型: 150K / 200K = 75% — 立即可触发
    controller.onContextWindowChanged(200_000);
    expect(controller.shouldCompactNow()).toBe(true);
  });

  it('window change without prior usage snapshot is a no-op', () => {
    const controller = makeController(() => 75);

    controller.onContextWindowChanged(200_000);

    expect(controller.shouldCompactNow()).toBe(false);
    expect(controller.getLatestSnapshot()).toBeNull();
  });

  it('ignores invalid window values on window change', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(150_000, 1_000_000);
    controller.onContextWindowChanged(0);
    controller.onContextWindowChanged(Number.NaN);

    expect(controller.getLatestSnapshot()?.contextWindow).toBe(1_000_000);
    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('window change can also lower the ratio (small → large model switch)', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(150_000, 200_000); // 75%
    controller.onContextWindowChanged(1_000_000); // 15%

    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('reads the latest threshold value on every decision', () => {
    let threshold = 90;
    const controller = makeController(() => threshold);

    controller.onUsageUpdate(160, 200);
    expect(controller.shouldCompactNow()).toBe(false);

    threshold = 75;
    expect(controller.shouldCompactNow()).toBe(true);
  });

  it('still compacts at 99% of the window', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(198, 200);

    expect(controller.shouldCompactNow()).toBe(true);
  });

  it('does not compact when occupancy is already full', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(200, 200);

    expect(controller.shouldCompactNow()).toBe(false);
  });

  it('still compacts a full window when compactWhenFull is set', () => {
    const controller = makeController(() => 75, true);

    controller.onUsageUpdate(200, 200);

    expect(controller.shouldCompactNow()).toBe(true);
  });

  it('does not compact after a deterministic host compact failure is latched', () => {
    const controller = makeController(() => 75);

    controller.onUsageUpdate(160, 200);
    expect(controller.shouldCompactNow()).toBe(true);

    controller.markNeedsRollover('empty-summary');
    expect(controller.needsRollover()).toBe(true);
    expect(controller.shouldCompactNow()).toBe(false);
  });
});

describe('isDeterministicHostCompactFailure', () => {
  it('recognizes empty summaries and compact-origin invalid requests', () => {
    expect(isDeterministicHostCompactFailure('Error during compaction: summarization produced empty response')).toBe(true);
    expect(
      isDeterministicHostCompactFailure(
        'Error during compaction: API Error: 400 litellm.BadRequestError: XaiException - {"error":{"message":"Upstream error: 400","type":"invalid_request_error"}}',
      ),
    ).toBe(true);
    expect(isDeterministicHostCompactFailure('pi compact failed: invalid_request_error')).toBe(true);
  });

  it('does not treat network, auth, or ordinary empty responses as compact failure', () => {
    expect(isDeterministicHostCompactFailure('The model returned an empty response')).toBe(false);
    expect(isDeterministicHostCompactFailure('Error during compaction: 401 unauthorized')).toBe(false);
    expect(isDeterministicHostCompactFailure('Error during compaction: Rate limit exceeded')).toBe(false);
    expect(isDeterministicHostCompactFailure('API Error: 400 invalid_request_error')).toBe(false);
  });
});
