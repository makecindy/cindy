import { describe, expect, it } from 'vitest';

import { isBotToolsetAvailableOnTarget } from '../botRemoteCapabilities';

describe('isBotToolsetAvailableOnTarget', () => {
  it('keeps every enabled Toolset available for local Bots and SSH Pi', () => {
    expect(isBotToolsetAvailableOnTarget({
      agentKind: 'codex',
      remoteHostId: null,
      toolsetId: 'browser',
    })).toBe(true);
    expect(isBotToolsetAvailableOnTarget({
      agentKind: 'pi',
      remoteHostId: 'host-1',
      toolsetId: 'browser',
    })).toBe(true);
  });

  it('only exposes the scoped host bridge to SSH Claude and Codex Bots', () => {
    for (const agentKind of ['claude-code', 'codex'] as const) {
      expect(isBotToolsetAvailableOnTarget({
        agentKind,
        remoteHostId: 'host-1',
        toolsetId: 'collab',
      })).toBe(true);
      expect(isBotToolsetAvailableOnTarget({
        agentKind,
        remoteHostId: 'host-1',
        toolsetId: 'memory',
      })).toBe(true);
      expect(isBotToolsetAvailableOnTarget({
        agentKind,
        remoteHostId: 'host-1',
        toolsetId: 'browser',
      })).toBe(false);
    }
  });
});
