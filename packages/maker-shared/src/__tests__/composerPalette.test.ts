import { describe, expect, it } from 'vitest';
import {
  detectComposerTrigger,
  filterAtResources,
  filterSlashCommands,
  insertAtResource,
  insertSlashCommand,
  mergeSlashCommands,
  projectSlashCommandsInText,
  restoreSlashCommandRuntimeAlias,
  serializeAtResource,
  slashCommandDisplayLabel,
  slashCommandRuntimePrefixLength,
} from '../composerPalette.js';

describe('shared composer palette model', () => {
  it('detects slash and at triggers only in active token runs', () => {
    expect(detectComposerTrigger('/com')).toEqual({ kind: 'slash', query: 'com', from: 0 });
    expect(detectComposerTrigger('/compact now')).toEqual({ kind: 'none' });
    expect(detectComposerTrigger('open @app')).toEqual({ kind: 'at', query: 'app', from: 5 });
    expect(detectComposerTrigger('mail@company')).toEqual({ kind: 'none' });
    expect(detectComposerTrigger('open @app now')).toEqual({ kind: 'none' });
  });

  it('merges slash commands with skill priority and prefix filtering', () => {
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

  it('merges desktop commands between skills and builtins (skill > desktop > builtin)', () => {
    const commands = mergeSlashCommands([
      { kind: 'agent-builtin', name: 'learn', description: 'builtin shadow' },
      { kind: 'agent-builtin', name: 'compact', description: 'compact' },
    ], [
      { kind: 'agent-skill', name: 'learn', source: 'user', description: 'skill wins' },
    ], [
      { kind: 'desktop', name: 'learn', description: 'desktop learn' },
      { kind: 'desktop', name: 'goal', description: 'desktop goal' },
    ]);

    expect(commands.map((command) => [command.kind, command.name])).toEqual([
      ['agent-skill', 'learn'],
      ['desktop', 'goal'],
      ['agent-builtin', 'compact'],
    ]);
    // 第三参缺省 = 旧签名行为不变。
    expect(mergeSlashCommands([
      { kind: 'agent-builtin', name: 'compact', description: 'compact' },
    ], []).map((command) => command.name)).toEqual(['compact']);
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

  it('ranks @ resources with agents first for empty query and fuzzy path fallback', () => {
    const items = [
      { type: 'file' as const, name: 'sessions.ts', relPath: 'apps/server/src/routes/sessions.ts' },
      { type: 'dir' as const, name: 'routes', relPath: 'apps/server/src/routes' },
      { type: 'agent' as const, name: 'reviewer', relPath: '.claude/agents/reviewer.md' },
    ];
    expect(filterAtResources(items, '').map((item) => item.name)).toEqual([
      'reviewer',
      'routes',
      'sessions.ts',
    ]);
    expect(filterAtResources(items, 'asr').map((item) => item.relPath)).toEqual([
      'apps/server/src/routes',
      '.claude/agents/reviewer.md',
      'apps/server/src/routes/sessions.ts',
    ]);
  });

  it('serializes directory and quoted @ references like the desktop composer expects', () => {
    expect(serializeAtResource({ type: 'dir', name: 'routes', relPath: 'apps/server/src/routes' }))
      .toBe('@apps/server/src/routes/');
    expect(serializeAtResource({ type: 'agent', name: 'reviewer', relPath: '.claude/agents/reviewer.md' }))
      .toBe('@.claude/agents/reviewer.md');
    expect(serializeAtResource({ type: 'file', name: 'design notes.md', relPath: 'docs/design notes.md' }))
      .toBe('@"docs/design notes.md"');
  });

  it('projects Pi runtime /skill: aliases to the human slash label', () => {
    expect(slashCommandDisplayLabel('/skill:git')).toBe('/git');
    expect(slashCommandDisplayLabel('/git')).toBe('/git');
    expect(slashCommandDisplayLabel('/compact')).toBe('/compact');
    expect(projectSlashCommandsInText('/skill:git follow-up')).toBe('/skill:git follow-up');
    expect(projectSlashCommandsInText('/skill:git follow-up', [{ start: 0, end: 10 }])).toBe(
      '/git follow-up',
    );
    expect(
      restoreSlashCommandRuntimeAlias('/skill:git follow-up', '/git please review'),
    ).toBe('/skill:git please review');
    expect(restoreSlashCommandRuntimeAlias('/skill:git follow-up', '/help')).toBe('/help');
    expect(
      slashCommandRuntimePrefixLength('/skill:git', {
        name: 'git',
        runtimeCommandName: 'skill:git',
      }),
    ).toBe(6);
    expect(
      slashCommandRuntimePrefixLength('/git', {
        name: 'git',
        runtimeCommandName: 'skill:git',
      }),
    ).toBe(0);
  });
});
