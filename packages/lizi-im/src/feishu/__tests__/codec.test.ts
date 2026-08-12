import { describe, expect, it } from 'vitest';

import { decodeLaneUserId, encodeLaneUserId } from '../codec.js';

describe('feishu lane codec', () => {
  it('round-trips a plain group lane', () => {
    const lane = encodeLaneUserId('oc_abc123');
    expect(lane).toBe('g/oc_abc123');
    expect(decodeLaneUserId(lane)).toEqual({ chatId: 'oc_abc123', threadId: '' });
  });

  it('round-trips a topic lane', () => {
    const lane = encodeLaneUserId('oc_abc123', 'omt_topic9');
    expect(lane).toBe('g/oc_abc123/omt_topic9');
    expect(decodeLaneUserId(lane)).toEqual({ chatId: 'oc_abc123', threadId: 'omt_topic9' });
  });

  it('treats empty/nullish threadId as the plain group lane', () => {
    expect(encodeLaneUserId('oc_x', '')).toBe('g/oc_x');
    expect(encodeLaneUserId('oc_x', null)).toBe('g/oc_x');
    expect(encodeLaneUserId('oc_x', undefined)).toBe('g/oc_x');
  });

  it('returns null for non-lane userIds (p2p open_id)', () => {
    expect(decodeLaneUserId('ou_owner_open_id')).toBeNull();
    expect(decodeLaneUserId('')).toBeNull();
    expect(decodeLaneUserId('g/')).toBeNull();
  });
});
