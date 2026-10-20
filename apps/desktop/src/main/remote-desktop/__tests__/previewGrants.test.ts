import { isPreviewGrant } from '@cindy/device-link';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_GRANT_REUSE_MIN_MS,
  PREVIEW_GRANT_TTL_MS,
  PreviewGrantTable,
} from '../previewGrants';

interface Target {
  tab: string;
  generation: number;
}
const table = (clock: { now: number }) =>
  new PreviewGrantTable<Target>(
    (target) => `${target.tab}:${target.generation}`,
    () => clock.now,
  );

describe('preview grants', () => {
  it('issues 32-byte base64url tokens that are valid once, for the asking peer only', () => {
    const clock = { now: 1_000 };
    const grants = table(clock);
    const grant = grants.issue('phone', { tab: 'a', generation: 1 });
    expect(isPreviewGrant(grant)).toBe(true);
    expect(grants.redeem('other', grant)).toBeNull();
    expect(grants.redeem('phone', grant)).toEqual({ tab: 'a', generation: 1 });
    expect(grants.redeem('phone', grant)).toBeNull();
    expect(grants.redeem('phone', 'x'.repeat(43))).toBeNull();
  });

  it('expires after 60 s', () => {
    const clock = { now: 0 };
    const grants = table(clock);
    const grant = grants.issue('phone', { tab: 'a', generation: 1 });
    clock.now = PREVIEW_GRANT_TTL_MS - 1;
    expect(grants.redeem('phone', grant)).not.toBeNull();
    const second = grants.issue('phone', { tab: 'a', generation: 1 });
    clock.now += PREVIEW_GRANT_TTL_MS;
    expect(grants.redeem('phone', second)).toBeNull();
    expect(grants.size).toBe(0);
  });

  it('hands the same unused grant back to a polling phone until little time is left', () => {
    const clock = { now: 0 };
    const grants = table(clock);
    const first = grants.issue('phone', { tab: 'a', generation: 1 });
    clock.now = 4_000;
    expect(grants.issue('phone', { tab: 'a', generation: 1 })).toBe(first);
    expect(grants.size).toBe(1);
    clock.now = PREVIEW_GRANT_TTL_MS - PREVIEW_GRANT_REUSE_MIN_MS;
    expect(grants.issue('phone', { tab: 'a', generation: 1 })).toBe(first);
    clock.now += 1;
    const renewed = grants.issue('phone', { tab: 'a', generation: 1 });
    expect(renewed).not.toBe(first);
    expect(grants.size).toBe(1);
    expect(grants.redeem('phone', first)).toBeNull();
    expect(grants.redeem('phone', renewed)).not.toBeNull();
  });

  it('does not reuse across peers, tabs or guest generations, nor after use', () => {
    const clock = { now: 0 };
    const grants = table(clock);
    const base = grants.issue('phone', { tab: 'a', generation: 1 });
    expect(grants.issue('tablet', { tab: 'a', generation: 1 })).not.toBe(base);
    expect(grants.issue('phone', { tab: 'b', generation: 1 })).not.toBe(base);
    expect(grants.issue('phone', { tab: 'a', generation: 2 })).not.toBe(base);
    expect(grants.redeem('phone', base)).not.toBeNull();
    expect(grants.issue('phone', { tab: 'a', generation: 1 })).not.toBe(base);
  });

  it('bounds the table, dropping the oldest grants first', () => {
    const clock = { now: 0 };
    const grants = table(clock);
    const first = grants.issue('phone', { tab: 'tab0', generation: 1 });
    for (let i = 1; i < 40; i++) grants.issue('phone', { tab: `tab${i}`, generation: 1 });
    expect(grants.size).toBe(32);
    expect(grants.redeem('phone', first)).toBeNull();
    for (let i = 0; i < 80; i++) grants.issue(`peer${i}`, { tab: 'a', generation: 1 });
    expect(grants.size).toBeLessThanOrEqual(64);
    grants.clearPeer('peer79');
    expect(grants.size).toBeLessThanOrEqual(63);
  });
});
