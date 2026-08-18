import { describe, expect, it, vi } from 'vitest';

import {
  agentSkillInvocationForDispatch,
  ambiguousPendingProjectSkillName,
  filterSlashCommands,
  firstAvailableSlashCommandIndex,
  hasAvailableSlashCommand,
  hasUnavailableProjectSkillPreview,
  isSlashCommandUnavailable,
  isSlashCommandSelectable,
  isSameProjectSkillAcrossRoots,
  mergeCommands,
  nextAvailableSlashCommandIndex,
  pendingProjectSkillForMessage,
  reconcilePiRuntimeCommandForDispatch,
  reconcilePiRuntimeCommandForDispatchWithRetry,
  resolvePendingPiProjectSkillForDispatch,
  resolvePendingPiUserSkillForDispatch,
  rollbackUnclaimedPiProjectSkillSession,
  type UnifiedCommand,
} from '@/lib/slashCommands';

const skill = (overrides: Partial<Extract<UnifiedCommand, { kind: 'agent-skill' }>> = {}) => ({
  kind: 'agent-skill' as const,
  name: 'demo',
  source: 'skill' as const,
  ...overrides,
});

describe('filterSlashCommands', () => {
  it('matches command names by case-insensitive containment', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'lark-drive', description: 'Drive' },
      { kind: 'desktop' as const, name: 'github', description: 'GitHub' },
    ];

    expect(filterSlashCommands(commands, 'DRIVE').map((command) => command.name)).toEqual([
      'lark-drive',
    ]);
  });

  it('ranks exact and prefix matches before ordinary contains matches', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'my-drive-tool', description: '' },
      { kind: 'desktop' as const, name: 'drive-sync', description: '' },
      { kind: 'desktop' as const, name: 'archive-drive', description: '' },
      { kind: 'desktop' as const, name: 'drive', description: '' },
      { kind: 'desktop' as const, name: 'lark-drive', description: '' },
    ];

    expect(filterSlashCommands(commands, 'drive').map((command) => command.name)).toEqual([
      'drive',
      'drive-sync',
      'my-drive-tool',
      'archive-drive',
      'lark-drive',
    ]);
  });

  it('keeps an exact match visible when contains matches exceed the limit', () => {
    const containsMatches = Array.from({ length: 25 }, (_, index) => ({
      kind: 'desktop' as const,
      name: `plugin-${index}-drive`,
      description: '',
    }));

    expect(
      filterSlashCommands([
        ...containsMatches,
        { kind: 'desktop' as const, name: 'drive', description: '' },
      ], 'drive', 25).map((command) => command.name),
    ).toContain('drive');
  });
});

describe('Pi project skill availability', () => {
  it('does not apply Pi runtime retry delays to non-Pi sessions', async () => {
    const sleeps: number[] = [];
    const reload = vi.fn(async () => [] as UnifiedCommand[]);

    await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'codex',
      sessionId: 'session-1',
      commandName: 'missing',
      commands: [],
      retryDelaysMs: [10, 20],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reload,
    })).resolves.toEqual({ command: undefined, commands: [] });
    expect(sleeps).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not retry a Pi slash name absent from the refreshed filesystem catalog', async () => {
    const sleeps: number[] = [];
    const reload = vi.fn(async () => [] as UnifiedCommand[]);

    await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'missing',
      commands: [],
      retryDelaysMs: [10, 20],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reload,
    })).resolves.toEqual({ command: undefined, commands: [] });
    expect(sleeps).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('disables only discovered project skills', () => {
    expect(isSlashCommandUnavailable(skill({ scope: 'repo', runtimeStatus: 'discovered' }))).toBe(true);
    expect(isSlashCommandUnavailable(skill({ scope: 'repo', runtimeStatus: 'loaded' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'user', runtimeStatus: 'discovered' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'repo' }))).toBe(false);
  });

  it('allows New Maker to select a discovered project skill without marking it loaded', () => {
    const discovered = skill({ scope: 'repo', runtimeStatus: 'discovered' });

    expect(isSlashCommandUnavailable(discovered)).toBe(true);
    expect(isSlashCommandSelectable(discovered)).toBe(false);
    expect(isSlashCommandSelectable(discovered, true)).toBe(true);
    expect(firstAvailableSlashCommandIndex([discovered], true)).toBe(0);
    expect(hasAvailableSlashCommand([discovered], true)).toBe(true);
  });

  it('hides ambiguous same-name project skills instead of binding an arbitrary path', () => {
    const first = skill({
      name: 'demo',
      path: '/repo/.pi/skills/demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const second = skill({
      name: 'Demo',
      path: '/repo/.agents/skills/demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });

    const merged = mergeCommands([], [], [first, second]);

    expect(merged).toEqual([]);
    expect(hasAvailableSlashCommand(merged, true)).toBe(false);
    expect(hasUnavailableProjectSkillPreview(merged)).toBe(true);
    expect(ambiguousPendingProjectSkillName('/DEMO run', merged, true)).toBe('demo');
    expect(ambiguousPendingProjectSkillName('  \n/DEMO run', merged, true)).toBe('demo');
    expect(ambiguousPendingProjectSkillName('/demo run', merged, false)).toBeUndefined();
  });

  it('deduplicates repeated discovery of the same project skill path', () => {
    const discovered = skill({
      name: 'demo',
      path: '/repo/.pi/skills/demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });

    const merged = mergeCommands([], [], [discovered, { ...discovered, name: 'Demo' }]);

    expect(merged).toEqual([discovered]);
    expect(hasAvailableSlashCommand(merged, true)).toBe(true);
    expect(ambiguousPendingProjectSkillName('/demo', merged, true)).toBeUndefined();
  });

  it('binds a uniquely typed project Skill alias to its exact discovery path', () => {
    const discovered = skill({
      name: 'demo',
      path: '/repo/.pi/skills/demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const merged = mergeCommands([], [], [discovered]);

    expect(pendingProjectSkillForMessage('/DEMO run this', merged, true)).toEqual(discovered);
    expect(pendingProjectSkillForMessage('  \n/DEMO run this', merged, true)).toEqual(discovered);
    expect(pendingProjectSkillForMessage('/demo', merged, false)).toBeUndefined();
  });

  it('fails closed instead of choosing a typed ambiguous project Skill path', () => {
    const merged = mergeCommands([], [], [
      skill({
        name: 'demo',
        path: '/repo/.pi/skills/demo',
        scope: 'repo',
        runtimeStatus: 'discovered',
      }),
      skill({
        name: 'Demo',
        path: '/repo/.agents/skills/demo',
        scope: 'repo',
        runtimeStatus: 'discovered',
      }),
    ]);

    expect(pendingProjectSkillForMessage('/demo', merged, true)).toBeUndefined();
  });

  it('does not turn a typed executable same-name command into a pending project Skill', () => {
    const discovered = skill({
      name: 'help',
      path: '/repo/.pi/skills/help',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'help', description: 'Help' };
    const merged = mergeCommands([desktop], [], [discovered]);

    expect(pendingProjectSkillForMessage('/help', merged, true)).toBeUndefined();
  });

  it('keeps an explicit executable owner when same-name project previews are ambiguous', () => {
    const discovered = (name: string, path: string) => skill({
      name,
      path,
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'demo', description: '' };

    const merged = mergeCommands(
      [desktop],
      [],
      [
        discovered('demo', '/repo/.pi/skills/demo'),
        discovered('Demo', '/repo/.agents/skills/demo'),
      ],
    );

    expect(merged).toEqual([desktop]);
    expect(ambiguousPendingProjectSkillName('/demo', merged, true)).toBeUndefined();
  });

  it('keeps the palette label and records the Pi runtime command separately', () => {
    const loaded = skill({
      name: 'demo',
      path: '/repo/.pi/skills/demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });

    expect(loaded.name).toBe('demo');
    expect(agentSkillInvocationForDispatch('/demo arg', loaded)).toEqual({
      name: 'demo',
      runtimeCommandName: 'skill:demo',
      scope: 'repo',
      sourcePath: '/repo/.pi/skills/demo',
    });
    expect(agentSkillInvocationForDispatch('  \n/demo arg', loaded)).toEqual({
      name: 'demo',
      runtimeCommandName: 'skill:demo',
      scope: 'repo',
      sourcePath: '/repo/.pi/skills/demo',
    });
    expect(agentSkillInvocationForDispatch('/demo', skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
      runtimeCommandName: 'skill:demo',
    }))).toBeUndefined();
    expect(agentSkillInvocationForDispatch(
      '/help',
      { kind: 'desktop', name: 'help', description: 'Help' },
    )).toBeUndefined();
  });

  it('keeps an available same-name skill ahead of a discovered project preview', () => {
    const discovered = skill({ scope: 'repo', runtimeStatus: 'discovered', path: '/repo/.pi/skills/demo' });
    const available = skill({ scope: 'user', path: '/home/user/.agents/skills/demo' });

    expect(mergeCommands([], [], [discovered, available])).toEqual([available]);
  });

  it('does not let a discovered preview shadow same-name executable tiers', () => {
    const discovered = skill({ name: 'help', scope: 'repo', runtimeStatus: 'discovered' });
    const desktop: UnifiedCommand = {
      kind: 'desktop',
      name: 'help',
      description: 'Open help',
    };

    expect(mergeCommands([desktop], [], [discovered])).toEqual([desktop]);
  });

  it('keeps hidden discovered collisions visible to Pi palette polling', () => {
    const discovered = skill({ name: 'help', scope: 'repo', runtimeStatus: 'discovered' });
    const desktop: UnifiedCommand = {
      kind: 'desktop',
      name: 'help',
      description: 'Open help',
    };

    const commands = mergeCommands([desktop], [], [discovered]);

    expect(commands).toEqual([desktop]);
    expect(hasUnavailableProjectSkillPreview(commands)).toBe(true);
    expect(hasUnavailableProjectSkillPreview([desktop])).toBe(false);
  });

  it('initializes and moves keyboard focus past unavailable project skills', () => {
    const commands = [
      skill({ name: 'first', scope: 'repo', runtimeStatus: 'discovered' }),
      skill({ name: 'second', scope: 'user' }),
      skill({ name: 'third', scope: 'repo', runtimeStatus: 'discovered' }),
      skill({ name: 'fourth', scope: 'user' }),
    ];

    expect(firstAvailableSlashCommandIndex(commands)).toBe(1);
    expect(nextAvailableSlashCommandIndex(commands, 1, 1)).toBe(3);
    expect(nextAvailableSlashCommandIndex(commands, 3, 1)).toBe(1);
    expect(nextAvailableSlashCommandIndex(commands, 1, -1)).toBe(3);
  });

  it('keeps focus stable when every matching command is unavailable', () => {
    const commands = [
      skill({ name: 'first', scope: 'repo', runtimeStatus: 'discovered' }),
      skill({ name: 'second', scope: 'repo', runtimeStatus: 'discovered' }),
    ];

    expect(firstAvailableSlashCommandIndex(commands)).toBe(0);
    expect(nextAvailableSlashCommandIndex(commands, 0, 1)).toBe(0);
    expect(hasAvailableSlashCommand(commands)).toBe(false);
  });

  it('refreshes a Pi desktop hit before dispatch so a loaded same-name skill wins', async () => {
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'help', description: 'Help' };
    const loaded = skill({ name: 'help', scope: 'repo', runtimeStatus: 'loaded' });

    await expect(reconcilePiRuntimeCommandForDispatch({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'help',
      commands: [desktop],
      reload: async () => [loaded],
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
  });

  it('refreshes a stale discovered Pi skill before rewriting a typed alias', async () => {
    const discovered = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });

    await expect(reconcilePiRuntimeCommandForDispatch({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [discovered],
      reload: async () => [loaded],
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
  });

  it('waits for a transient discovered Pi skill to enter the runtime catalog', async () => {
    const discovered = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });
    const sleeps: number[] = [];
    let reloads = 0;

    await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [discovered],
      retryDelaysMs: [10, 20, 30],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reload: async () => (++reloads < 3 ? [discovered] : [loaded]),
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
    expect(sleeps).toEqual([10, 20]);
    expect(reloads).toBe(3);
  });

  it('waits for a user Skill with a guessed command to gain loaded runtime proof', async () => {
    const pending = skill({
      name: 'demo',
      scope: 'user',
      path: '/home/user/.agents/skills/demo',
      runtimeCommandName: 'skill:demo',
    });
    const loaded = skill({
      ...pending,
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:frontmatter-demo',
    });
    const sleeps: number[] = [];
    let reloads = 0;

    const result = await reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [pending],
      retryDelaysMs: [10, 20],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reload: async () => (++reloads < 2 ? [pending] : [loaded]),
    });

    expect(result).toEqual({ command: loaded, commands: [loaded] });
    expect(agentSkillInvocationForDispatch('/demo run this', result.command)).toEqual({
      name: 'demo',
      scope: 'user',
      sourcePath: '/home/user/.agents/skills/demo',
      runtimeCommandName: 'skill:frontmatter-demo',
    });
    expect(sleeps).toEqual([10]);
    expect(reloads).toBe(2);
  });

  it('keeps waiting when a Desktop command temporarily shadows a same-name Pi skill', async () => {
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'help', description: 'Help' };
    const discovered = skill({ name: 'help', scope: 'repo', runtimeStatus: 'discovered' });
    const loaded = skill({
      name: 'help',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:help',
    });
    const sleeps: number[] = [];
    let reloads = 0;
    const initial = mergeCommands([desktop], [], [discovered]);

    await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'help',
      commands: initial,
      retryDelaysMs: [10, 20, 30],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reload: async () => (
        ++reloads < 3
          ? mergeCommands([desktop], [], [discovered])
          : mergeCommands([desktop], [], [loaded])
      ),
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
    expect(sleeps).toEqual([10, 20]);
    expect(reloads).toBe(3);
  });

  it('starts the selected project runtime before resolving its first Pi skill command', async () => {
    const discovered = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
    });
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });
    const events: string[] = [];
    let runtimeReady = false;

    await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [],
      retryDelaysMs: [],
      prepareRuntime: async () => {
        events.push('runtime');
        runtimeReady = true;
      },
      reload: async () => {
        events.push('catalog');
        return runtimeReady ? [loaded] : [discovered];
      },
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
    expect(events).toEqual(['runtime', 'catalog']);
  });

  it('does not restart the runtime for an already loaded Pi skill', async () => {
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });
    let prepared = false;

    await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [loaded],
      prepareRuntime: async () => { prepared = true; },
      reload: async () => [],
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
    expect(prepared).toBe(false);
  });

  it('refreshes an unknown Pi alias in case the runtime catalog arrived late', async () => {
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });

    await expect(reconcilePiRuntimeCommandForDispatch({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [],
      reload: async () => [loaded],
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
  });

  it('does not refresh an already available Pi skill', async () => {
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });
    let reloaded = false;

    await expect(reconcilePiRuntimeCommandForDispatch({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'demo',
      commands: [loaded],
      reload: async () => {
        reloaded = true;
        return [];
      },
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
    expect(reloaded).toBe(false);
  });

  it('keeps the cached command when a best-effort refresh has no matching result', async () => {
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'help', description: 'Help' };

    await expect(reconcilePiRuntimeCommandForDispatch({
      agentKind: 'pi',
      sessionId: 'session-1',
      commandName: 'help',
      commands: [desktop],
      reload: async () => [],
    })).resolves.toEqual({ command: desktop, commands: [desktop] });
  });

  it('does not refresh a non-Pi desktop hit', async () => {
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'help', description: 'Help' };
    let reloaded = false;

    await expect(reconcilePiRuntimeCommandForDispatch({
      agentKind: 'claude-code',
      sessionId: 'session-1',
      commandName: 'help',
      commands: [desktop],
      reload: async () => {
        reloaded = true;
        return [];
      },
    })).resolves.toEqual({ command: desktop, commands: [desktop] });
    expect(reloaded).toBe(false);
  });
});

describe('resolvePendingPiProjectSkillForDispatch', () => {
  it('prepares the runtime, binds the Skill to the new worktree, and rewrites the alias', async () => {
    const prepareRuntime = vi.fn(async () => {});
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });

    await expect(resolvePendingPiProjectSkillForDispatch({
      sessionId: 'session-1',
      commandName: 'demo',
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.pi/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/demo',
      prepareRuntime,
      reload: async () => [{ ...loaded, path: '/repo/.cindy-worktrees/demo/.pi/skills/demo' }],
      retryDelaysMs: [],
    })).resolves.toEqual({
      name: 'demo',
      runtimeCommandName: 'skill:demo',
      scope: 'repo',
      sourcePath: '/repo/.cindy-worktrees/demo/.pi/skills/demo',
    });
    expect(prepareRuntime).toHaveBeenCalledOnce();
  });

  it('fails closed when the selected project Skill is absent from the new worktree', async () => {
    await expect(resolvePendingPiProjectSkillForDispatch({
      sessionId: 'session-1',
      commandName: 'demo',
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.pi/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/demo',
      prepareRuntime: async () => {},
      reload: async () => [],
      retryDelaysMs: [],
    })).resolves.toBeNull();
  });

  it('waits through an initially empty worktree catalog before the selected Skill loads', async () => {
    const sleeps: number[] = [];
    let reloads = 0;
    await expect(resolvePendingPiProjectSkillForDispatch({
      sessionId: 'session-1',
      commandName: 'demo',
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.pi/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/demo',
      prepareRuntime: async () => {},
      reload: async () => {
        reloads += 1;
        return reloads === 1
          ? []
          : [skill({
              name: 'demo',
              path: '/repo/.cindy-worktrees/demo/.pi/skills/demo',
              scope: 'repo',
              runtimeStatus: 'loaded',
              runtimeCommandName: 'skill:demo',
            })];
      },
      retryDelaysMs: [10],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    })).resolves.toEqual({
      name: 'demo',
      runtimeCommandName: 'skill:demo',
      scope: 'repo',
      sourcePath: '/repo/.cindy-worktrees/demo/.pi/skills/demo',
    });
    expect(sleeps).toEqual([10]);
  });

  it('does not accept a same-name global Skill as the selected project Skill', async () => {
    await expect(resolvePendingPiProjectSkillForDispatch({
      sessionId: 'session-1',
      commandName: 'demo',
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.pi/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/demo',
      prepareRuntime: async () => {},
      reload: async () => [skill({
        name: 'demo',
        scope: 'user',
        runtimeStatus: 'loaded',
        runtimeCommandName: 'skill:demo',
      })],
      retryDelaysMs: [],
    })).resolves.toBeNull();
  });

  it('ignores a same-name global Skill when the exact project Skill is also loaded', async () => {
    await expect(resolvePendingPiProjectSkillForDispatch({
      sessionId: 'session-1',
      commandName: 'demo',
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.pi/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/demo',
      prepareRuntime: async () => {},
      reload: async () => [
        skill({
          name: 'demo',
          scope: 'user',
          runtimeStatus: 'loaded',
          runtimeCommandName: 'skill:global-demo',
        }),
        skill({
          name: 'demo',
          path: '/repo/.cindy-worktrees/demo/.pi/skills/demo',
          scope: 'repo',
          runtimeStatus: 'loaded',
          runtimeCommandName: 'skill:project-demo',
        }),
      ],
      retryDelaysMs: [],
    })).resolves.toEqual({
      name: 'demo',
      runtimeCommandName: 'skill:project-demo',
      scope: 'repo',
      sourcePath: '/repo/.cindy-worktrees/demo/.pi/skills/demo',
    });
  });

  it('rejects a same-name project Skill at a different relative path', async () => {
    await expect(resolvePendingPiProjectSkillForDispatch({
      sessionId: 'session-1',
      commandName: 'demo',
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.pi/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/demo',
      prepareRuntime: async () => {},
      reload: async () => [skill({
        name: 'demo',
        path: '/repo/.cindy-worktrees/demo/.agents/skills/demo',
        scope: 'repo',
        runtimeStatus: 'loaded',
        runtimeCommandName: 'skill:demo',
      })],
      retryDelaysMs: [],
    })).resolves.toBeNull();
  });
});

describe('resolvePendingPiUserSkillForDispatch', () => {
  it('waits for the exact selected user Skill path in the new runtime', async () => {
    const prepareRuntime = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    const reload = vi.fn()
      .mockResolvedValueOnce([
        skill({
          name: 'demo',
          scope: 'user',
          path: '/home/user/.agents/skills/other-demo',
          runtimeStatus: 'loaded',
          runtimeCommandName: 'skill:demo',
        }),
      ])
      .mockResolvedValueOnce([
        skill({
          name: 'Demo',
          scope: 'user',
          path: '/home/user/.agents/skills/demo',
          runtimeCommandName: 'skill:frontmatter-demo',
        }),
      ]);

    await expect(resolvePendingPiUserSkillForDispatch({
      message: '/demo run this',
      pendingInvocation: {
        name: 'demo',
        scope: 'user',
        sourcePath: '/home/user/.agents/skills/demo',
        runtimeCommandName: 'skill:demo',
      },
      prepareRuntime,
      reload,
      retryDelaysMs: [0],
      sleep,
    })).resolves.toEqual({
      name: 'Demo',
      scope: 'user',
      sourcePath: '/home/user/.agents/skills/demo',
      runtimeCommandName: 'skill:frontmatter-demo',
    });
    expect(prepareRuntime).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('fails closed when only a same-name user Skill from another path is loaded', async () => {
    await expect(resolvePendingPiUserSkillForDispatch({
      message: '/demo',
      pendingInvocation: {
        name: 'demo',
        scope: 'user',
        sourcePath: '/home/user/.agents/skills/demo',
        runtimeCommandName: 'skill:demo',
      },
      prepareRuntime: async () => undefined,
      reload: async () => [skill({
        name: 'demo',
        scope: 'user',
        path: '/other/.agents/skills/demo',
        runtimeStatus: 'loaded',
        runtimeCommandName: 'skill:demo',
      })],
      retryDelaysMs: [],
    })).resolves.toBeNull();
  });
});

describe('rollbackUnclaimedPiProjectSkillSession', () => {
  it('closes the runtime before durable deletion and only then hides local state', async () => {
    const order: string[] = [];
    await rollbackUnclaimedPiProjectSkillSession({
      sessionId: 'session-1',
      closeRuntime: async () => { order.push('close'); },
      markDeleted: async () => { order.push('delete'); },
      patchDeleted: () => { order.push('patch'); },
      purgeRuntimeState: () => { order.push('purge'); },
    });
    expect(order).toEqual(['close', 'delete', 'patch', 'purge']);
  });

  it.each(['close', 'delete'] as const)(
    'keeps the session visible when %s rollback fails',
    async (failure) => {
      const patchDeleted = vi.fn();
      const purgeRuntimeState = vi.fn();
      await expect(rollbackUnclaimedPiProjectSkillSession({
        sessionId: 'session-1',
        closeRuntime: async () => {
          if (failure === 'close') throw new Error('close failed');
        },
        markDeleted: async () => {
          if (failure === 'delete') throw new Error('delete failed');
        },
        patchDeleted,
        purgeRuntimeState,
      })).rejects.toThrow(`${failure} failed`);
      expect(patchDeleted).not.toHaveBeenCalled();
      expect(purgeRuntimeState).not.toHaveBeenCalled();
    },
  );
});

describe('isSameProjectSkillAcrossRoots', () => {
  it('matches POSIX project-relative paths across worktree roots', () => {
    expect(isSameProjectSkillAcrossRoots({
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/repo/.agents/skills/demo',
      targetProjectRoot: '/repo/.cindy-worktrees/task',
      targetSkillPath: '/repo/.cindy-worktrees/task/.agents/skills/demo',
    })).toBe(true);
  });

  it('matches Windows paths only when their project-relative spelling is exact', () => {
    expect(isSameProjectSkillAcrossRoots({
      sourceProjectRoot: 'C:\\Repo',
      sourceSkillPath: 'C:\\Repo\\.pi\\skills\\Demo',
      targetProjectRoot: 'D:\\Worktrees\\Task',
      targetSkillPath: 'D:\\Worktrees\\Task\\.pi\\skills\\Demo',
    })).toBe(true);
    expect(isSameProjectSkillAcrossRoots({
      sourceProjectRoot: '\\\\server\\share\\Repo',
      sourceSkillPath: '\\\\server\\share\\Repo\\.agents\\skills\\demo',
      targetProjectRoot: '\\\\server\\share\\worktrees\\task',
      targetSkillPath: '\\\\server\\share\\worktrees\\task\\.agents\\skills\\demo',
    })).toBe(true);
    expect(isSameProjectSkillAcrossRoots({
      sourceProjectRoot: 'C:\\Repo',
      sourceSkillPath: 'C:\\Repo\\.pi\\skills\\Demo',
      targetProjectRoot: 'D:\\Worktrees\\Task',
      targetSkillPath: 'D:\\Worktrees\\Task\\.pi\\skills\\demo',
    })).toBe(false);
  });

  it('does not erase meaningful trailing spaces from Windows Skill paths', () => {
    expect(isSameProjectSkillAcrossRoots({
      sourceProjectRoot: 'C:\\Repo',
      sourceSkillPath: 'C:\\Repo\\.pi\\skills\\Demo ',
      targetProjectRoot: 'D:\\Worktrees\\Task',
      targetSkillPath: 'D:\\Worktrees\\Task\\.pi\\skills\\Demo',
    })).toBe(false);
  });

  it('rejects paths outside either project root', () => {
    expect(isSameProjectSkillAcrossRoots({
      sourceProjectRoot: '/repo',
      sourceSkillPath: '/other/.pi/skills/demo',
      targetProjectRoot: '/worktree',
      targetSkillPath: '/worktree/.pi/skills/demo',
    })).toBe(false);
  });
});
