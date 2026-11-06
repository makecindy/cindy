import { describe, it, expect } from 'vitest';
import { HOST_CONTRACT_CHANNELS } from '../hostChannelContract';

describe('HOST_CONTRACT_CHANNELS', () => {
  it('has unique desktop channels and web paths', () => {
    const desktopChannels = HOST_CONTRACT_CHANNELS.map(c => c.desktopChannel);
    const webPaths = HOST_CONTRACT_CHANNELS.map(c => c.webPath);
    expect(new Set(desktopChannels).size).toBe(desktopChannels.length);
    expect(new Set(webPaths).size).toBe(webPaths.length);
  });

  it('every entry points to a valid api endpoint', () => {
    for (const entry of HOST_CONTRACT_CHANNELS) {
      expect(entry.hostPath.startsWith('/api/')).toBe(true);
      expect(entry.desktopChannel.length).toBeGreaterThan(0);
      expect(entry.webPath.length).toBeGreaterThan(0);
    }
  });

  it('correctly maps estimatedSessionValue instead of the dead estimated-value', () => {
    const entry = HOST_CONTRACT_CHANNELS.find(c => c.hostPath === '/api/messages/estimated-value');
    expect(entry?.desktopChannel).toBe('local-db:messages:estimatedSessionValue');
  });
});
