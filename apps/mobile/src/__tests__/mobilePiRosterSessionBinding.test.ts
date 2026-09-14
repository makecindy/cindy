import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readRoute(name: 'new.tsx' | '[sessionId].tsx'): string {
  return readFileSync(resolve(process.cwd(), 'app/sessions', name), 'utf8').replace(/\r\n/g, '\n');
}

describe('mobile Pi roster session binding', () => {
  it('binds both live-task roster requests and their slash cache to the active session', () => {
    const source = readRoute('[sessionId].tsx');

    expect(source).toContain('maker.listAgentCommands(agentKind, { sessionId: currentSession.id })');
    expect(source).toMatch(
      /maker\.listAgentSkills\(agentKind, \{[\s\S]*?sessionId: currentSession\.id,[\s\S]*?\}\)/,
    );
    expect(source).toMatch(
      /buildComposerPaletteCacheKey\([\s\S]*?currentSession\.workingDir \?\? '',[\s\S]*?currentSession\.id,[\s\S]*?\)/,
    );
  });

  it('keeps new-task roster loading on the explicit unbound preview path', () => {
    const source = readRoute('new.tsx');

    expect(source).toContain('maker.listAgentCommands(agentKind)');
    expect(source).not.toContain('maker.listAgentCommands(agentKind, { sessionId:');
    expect(source).toMatch(/maker\.listAgentSkills\(agentKind, \{[\s\S]*?forceReload: false,[\s\S]*?\}\)/);
  });
});
