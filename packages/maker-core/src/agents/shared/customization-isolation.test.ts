import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAgent } from '../claude-code/index.js';
import { CodexAgent } from '../codex/index.js';
import { PiAgent } from '../pi/index.js';
import type { ListCustomizationsResult } from '../../types/customizations.js';

vi.mock('../claude-code/customization-scanner.js', () => ({
  scanClaudeCustomizations: vi.fn(() => { throw new Error('Main must not scan'); }),
  scanClaudeRuntimeSkills: vi.fn(),
}));
vi.mock('../codex/customization-scanner.js', () => ({
  scanCodexCustomizations: vi.fn(() => { throw new Error('Main must not scan'); }),
}));
vi.mock('../pi/customization-scanner.js', () => ({
  scanPiCustomizations: vi.fn(() => { throw new Error('Main must not scan'); }),
}));

describe('host-isolated customization discovery', () => {
  it.each([
    ['claude-code', ClaudeCodeAgent, true],
    ['codex', CodexAgent, false],
    ['pi', PiAgent, true],
  ] as const)('%s uses host discovery and preserves managed Skills on scan failure', async (engine, Agent, includesManaged) => {
    const result: ListCustomizationsResult = { items: [], errors: [{ message: 'Scan timed out' }] };
    const scanLocalCustomizations = vi.fn(async () => result);
    const getManagedSkills = vi.fn(async () => [{
      name: 'managed', path: '/host/managed/SKILL.md', enabled: false, claudeCommandName: 'managed',
    }]);
    // Discovery uses only the injected dependencies; no runtime, auth or child CLI is needed.
    const agent = Object.create(Agent.prototype);
    Object.defineProperty(agent, 'deps', { value: { scanLocalCustomizations, getManagedSkills } });
    const options = { workingDirs: ['/project'], kinds: ['skill'] };
    const listed = await agent.listCustomizations(options);
    expect(scanLocalCustomizations).toHaveBeenCalledExactlyOnceWith(engine, options);
    expect(listed.errors).toEqual(result.errors);
    expect(listed.items).toHaveLength(includesManaged ? 1 : 0);
    if (includesManaged) expect(listed.items[0]).toMatchObject({ engine, name: 'managed', enabled: false });
  });
});
