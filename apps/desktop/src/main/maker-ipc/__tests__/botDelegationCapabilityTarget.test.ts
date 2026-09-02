import { describe, expect, it } from 'vitest';

import {
  isBotRuntimeSnapshotForCapabilityTarget,
  unavailableRequiredBotCapabilities,
} from '../botDelegationService';

describe('Bot delegation capability target runtime', () => {
  it('uses only the canonical task for ordinary roster capability claims', () => {
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'canonical-1',
      canonicalSessionId: 'canonical-1',
    })).toBe(true);
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'delegation-child-1',
      canonicalSessionId: 'canonical-1',
    })).toBe(false);
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'canonical-1',
      canonicalSessionId: null,
    })).toBe(false);
  });

  it('does not turn inherited ambient Skills into frozen delegation requirements', () => {
    expect(unavailableRequiredBotCapabilities({
      skillMode: 'inherit',
      skills: [],
      mcpMode: 'inherit',
      mcpServers: [],
      toolsetMode: 'inherit',
      toolsets: [],
    }, {
      unavailableSkills: ['agent-ops', 'git-workflow', 'x-ops'],
      unavailableMcpServers: ['optional-plugin'],
      unavailableToolsets: ['optional-tools'],
    })).toEqual([]);
  });

  it('still blocks capabilities explicitly frozen by an allowlist', () => {
    expect(unavailableRequiredBotCapabilities({
      skillMode: 'allowlist',
      skills: ['required-skill'],
      mcpMode: 'allowlist',
      mcpServers: ['required-mcp'],
      toolsetMode: 'allowlist',
      toolsets: ['required-tools'],
    }, {
      unavailableSkills: ['required-skill', 'ambient-skill'],
      unavailableMcpServers: ['required-mcp'],
      unavailableToolsets: ['required-tools'],
    })).toEqual([
      'skill:required-skill',
      'mcp:required-mcp',
      'toolset:required-tools',
    ]);
  });
});
