/**
 * 分享的人这边的「需要换一台」凭证(provider-groups.md §6.1)：凭证紧挨在错误前面到达，只给那次错误用；
 * 交接后登记给下一次打开，带走即用掉；用户亲自接手时作废。
 */
import { describe, expect, it } from 'vitest';

import {
  createProviderGroupGuestSwitch,
  PROVIDER_GROUP_SWITCH_ARMED_TTL_MS,
  PROVIDER_GROUP_SWITCH_OFFER_TTL_MS,
} from '../guestSwitch';

describe('provider group guest switch tokens', () => {
  it('moves an offered token to the next open, once', () => {
    const tokens = createProviderGroupGuestSwitch(() => 0);
    expect(tokens.takeForOpen('s1')).toBeUndefined();
    tokens.offer('s1', 'token-a');
    expect(tokens.claim('s1')).toBe(true);
    expect(tokens.claim('s1')).toBe(false);
    expect(tokens.takeForOpen('s2')).toBeUndefined();
    expect(tokens.takeForOpen('s1')).toBe('token-a');
    expect(tokens.takeForOpen('s1')).toBeUndefined();
  });

  it('forgets tokens that are stale, released, or that the user took over from', () => {
    let now = 0;
    const tokens = createProviderGroupGuestSwitch(() => now);
    tokens.offer('s1', 'token-a');
    now += PROVIDER_GROUP_SWITCH_OFFER_TTL_MS + 1;
    expect(tokens.claim('s1')).toBe(false);

    tokens.offer('s1', 'token-b');
    tokens.drop('s1');
    expect(tokens.claim('s1')).toBe(false);

    tokens.offer('s1', 'token-c');
    expect(tokens.claim('s1')).toBe(true);
    tokens.release('s1');
    expect(tokens.takeForOpen('s1')).toBeUndefined();

    tokens.offer('s1', 'token-d');
    expect(tokens.claim('s1')).toBe(true);
    now += PROVIDER_GROUP_SWITCH_ARMED_TTL_MS + 1;
    expect(tokens.takeForOpen('s1')).toBeUndefined();
  });
});
