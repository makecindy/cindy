import { describe, expect, it } from 'vitest';
import {
  detectComposerTrigger,
  filterAtResources,
  filterSlashCommands,
  insertAtResource,
  insertSlashCommand,
  mergeSlashCommands,
  serializeAtResource,
} from '@/session/composerPalette';

describe('composerPalette', () => {
  it('detects slash and at triggers only in active token runs', () => {
    expect(detectComposerTrigger('/com')).toEqual({ kind: 'slash', query: 'com', from: 0 });
    expect(detectComposerTrigger('/compact now')).toEqual({ kind: 'none' });
    expect(detectComposerTrigger('open @app')).toEqual({ kind: 'at', query: 'app', from: 5 });
    expect(detectComposerTrigger('mail@company')).toEqual({ kind: 'none' });
    expect(detectComposerTrigger('open @app now')).toEqual({ kind: 'none' });
  });

  it('merges slash commands with skill priority and query filtering', () => {
    const commands = mergeSlashCommands([
      { kind: 'agent-builtin', name: 'compact', description: 'builtin compact' },
      { kind: 'agent-builtin', name: 'status', description: 'status' },
    ], [
      { kind: 'agent-skill', name: 'compact', source: 'user', description: 'custom compact' },
      { kind: 'agent-skill', name: 'codereview', source: 'skill' },
    ]);

    expect(commands.map((command) => [command.kind, command.name])).toEqual([
      ['agent-skill', 'codereview'],
      ['agent-skill', 'compact'],
      ['agent-builtin', 'status'],
    ]);
    expect(filterSlashCommands(commands, 'co').map((command) => command.name)).toEqual([
      'codereview',
      'compact',
    ]);
  });

  it('inserts selected slash commands and at resources as desktop-compatible text', () => {
    const slashTrigger = detectComposerTrigger('/com');
    expect(insertSlashCommand('/com', slashTrigger, { name: 'compact' })).toBe('/compact ');

    const atTrigger = detectComposerTrigger('read @ses');
    expect(insertAtResource('read @ses', atTrigger, {
      type: 'file',
      name: 'sessions.ts',
      relPath: 'apps/desktop/src/main/localDb/ipc/sessions.ts',
    })).toBe('read @apps/desktop/src/main/localDb/ipc/sessions.ts ');
  });

  it('serializes dirs, agents, and paths with spaces using the desktop mention format', () => {
    expect(serializeAtResource({
      type: 'dir',
      relPath: 'apps/server/src/routes',
    })).toBe('@apps/server/src/routes/');
    expect(serializeAtResource({
      type: 'agent',
      relPath: '.claude/agents/reviewer.md',
    })).toBe('@.claude/agents/reviewer.md');
    expect(serializeAtResource({
      type: 'file',
      relPath: 'docs/design notes.md',
    })).toBe('@"docs/design notes.md"');
  });

  it('ranks at resources by filename before path fuzzy matches', () => {
    const ranked = filterAtResources([
      { type: 'file', name: 'index.ts', relPath: 'apps/mobile/src/session/index.ts' },
      { type: 'file', name: 'sessionControls.ts', relPath: 'apps/mobile/src/session/sessionControls.ts' },
      { type: 'agent', name: 'session-reviewer', relPath: '.claude/agents/session-reviewer.md' },
    ], 'session');

    expect(ranked.map((item) => item.name)).toEqual([
      'session-reviewer',
      'sessionControls.ts',
      'index.ts',
    ]);
  });
});
