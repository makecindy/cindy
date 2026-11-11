/** 80 device-id characters + separator + the existing 128-character Bot profile ID. */
export const MAX_BOT_PEER_ADDRESS_CHARS = 210;

/** Stable teammate address. Names and canonical Session ids are never routing keys. */
export function parseBotPeerAddress(value: string): { deviceId: string; botId: string } | null {
  const match = /^([A-Za-z0-9_-]{1,80})::([A-Za-z0-9_-]{1,128})$/.exec(value);
  return match ? { deviceId: match[1], botId: match[2] } : null;
}

export function botPeerAddress(deviceId: string, botId: string): string {
  const address = `${deviceId}::${botId}`;
  if (!parseBotPeerAddress(address)) throw new Error('Invalid teammate address');
  return address;
}
