import { describe, expect, it } from 'vitest';
import { botPeerAddress, parseBotPeerAddress } from '../botPeerAddress.js';

describe('stable teammate addresses', () => {
  it.each([1, 80, 81, 128])('round-trips a %i-character Bot ID without truncation', length => {
    const deviceId = 'd'.repeat(80);
    const botId = 'b'.repeat(length);
    const address = botPeerAddress(deviceId, botId);
    expect(address).toBe(`${deviceId}::${botId}`);
    expect(parseBotPeerAddress(address)).toEqual({ deviceId, botId });
  });

  it.each([
    ['d', 'b'.repeat(129)], ['d'.repeat(81), 'b'], ['', 'b'], ['d', ''],
    ['d', 'a::b'], ['d', '../b'], ['d', 'b\n'],
  ])('rejects malformed or over-limit identity %j / %j', (deviceId, botId) => {
    expect(parseBotPeerAddress(`${deviceId}::${botId}`)).toBeNull();
    expect(() => botPeerAddress(deviceId, botId)).toThrow('Invalid teammate address');
  });
});
