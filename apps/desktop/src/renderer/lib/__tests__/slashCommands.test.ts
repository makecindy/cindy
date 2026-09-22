import { afterEach, describe, expect, it, vi } from 'vitest';
import { CINDY_LEARN_SOURCE_DESCRIPTION } from '../../../shared/cindyBuiltInSkills';

import {
  commandsForHelpCard,
  filterSlashCommands,
  filterSlashCommandsWithMeta,
  firstAvailableSlashCommandIndex,
  hasAvailableSlashCommand,
  hasUnavailableProjectSkillPreview,
  isCindyOfficialSlashCommand,
  isSlashCommandUnavailable,
  loadAllCommands,
  mergeCommands,
  nextAvailableSlashCommandIndex,
  rebaseInlineRangesAfterSlashCommandRewrite,
  reconcilePiRuntimeCommandForDispatch,
  reconcilePiRuntimeCommandForDispatchWithRetry,
  rewriteAgentSkillInvocationForDispatch,
  rewritePiSkillAliasFromCommand,
  rewritePiSkillMessageForSend,
  slashCommandInvocationName,
  type UnifiedCommand,
} from '@/lib/slashCommands';

const skill = (overrides: Partial<Extract<UnifiedCommand, { kind: 'agent-skill' }>> = {}) => ({
  kind: 'agent-skill' as const,
  name: 'demo',
  source: 'skill' as const,
  ...overrides,
});

const ISSUE_4788_TARGET = 'run-cindy-e2e-pr-testcase';

function issue4788Commands(): UnifiedCommand[] {
  return mergeCommands([], [], [
    ...Array.from({ length: 32 }, (_, index) => skill({
      name: `cindy-e2e-${String(index + 1).padStart(2, '0')}`,
      description: 'Cindy E2E fixture Skill',
    })),
    skill({ name: ISSUE_4788_TARGET, description: 'Run the Cindy E2E PR testcase' }),
    ...Array.from({ length: 4 }, (_, index) => skill({
      name: `z-skill-${String(index + 1).padStart(2, '0')}`,
      description: 'Trailing fixture Skill',
    })),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubCommandLists(skillResult: { success: boolean; skills?: UnifiedCommand[] }) {
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        listDesktopCommands: vi.fn(async () => ({
          success: true,
          commands: [{ kind: 'desktop', name: 'learn', description: 'Learn' }],
        })),
        listAgentCommands: vi.fn(async () => ({ success: true, commands: [] })),
        listAgentSkills: vi.fn(async () => skillResult),
      },
    },
  });
}

describe('loadAllCommands Learn fallback', () => {
  it.each([
    ['the Skill query fails', { success: false }],
    ['Learn is not discovered yet', { success: true, skills: [] }],
  ])('keeps the Desktop Learn command when %s', async (_label, result) => {
    stubCommandLists(result as { success: boolean; skills?: UnifiedCommand[] });

    await expect(loadAllCommands('claude-code', null)).resolves.toEqual([
      { kind: 'desktop', name: 'learn', description: 'Learn' },
    ]);
  });

  it('uses an available Agent Skill instead of the Desktop Learn fallback', async () => {
    const learnSkill = skill({ name: 'learn', builtIn: true });
    stubCommandLists({ success: true, skills: [learnSkill] });

    await expect(loadAllCommands('claude-code', null)).resolves.toEqual([learnSkill]);
  });
});

describe('commandsForHelpCard', () => {
  it('preserves only the Main-attested built-in marker needed for localized descriptions', () => {
    expect(commandsForHelpCard([
      skill({ name: 'learn', builtIn: true, description: CINDY_LEARN_SOURCE_DESCRIPTION }),
      skill({ name: 'custom', description: 'Custom description' }),
    ])).toEqual([
      {
        name: 'learn',
        description: CINDY_LEARN_SOURCE_DESCRIPTION,
        source: 'skill',
        builtIn: true,
      },
      { name: 'custom', description: 'Custom description', source: 'skill' },
    ]);
  });
});

describe('rewriteAgentSkillInvocationForDispatch', () => {
  it('rewrites a directly typed loaded Pi skill alias and preserves its arguments', () => {
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });

    expect(rewriteAgentSkillInvocationForDispatch('/demo   keep spacing', loaded)).toBe(
      '/skill:demo   keep spacing',
    );
    expect(rewriteAgentSkillInvocationForDispatch('  \n/demo keep', loaded)).toBe(
      '  \n/skill:demo keep',
    );
    expect(rewriteAgentSkillInvocationForDispatch('please /demo', loaded)).toBe('please /demo');
    expect(rewriteAgentSkillInvocationForDispatch('> quoted\n\n/demo', loaded)).toBe(
      '> quoted\n\n/demo',
    );
  });

  it('rebases command and later inline metadata when the runtime alias grows', () => {
    const original = '/demo @task pasted';
    const rewritten = '/skill:demo @task pasted';

    expect(rebaseInlineRangesAfterSlashCommandRewrite(
      [
        { start: 0, end: 5, kind: 'slash' },
        { start: 6, end: 11, kind: 'reference' },
        { start: 12, end: 18, kind: 'paste' },
      ],
      original,
      rewritten,
    )).toEqual([
      { start: 0, end: 11, kind: 'slash' },
      { start: 12, end: 17, kind: 'reference' },
      { start: 18, end: 24, kind: 'paste' },
    ]);

    expect(rebaseInlineRangesAfterSlashCommandRewrite(
      [
        { start: 3, end: 8, kind: 'slash' },
        { start: 9, end: 14, kind: 'reference' },
      ],
      '  \n/demo @task',
      '  \n/skill:demo @task',
    )).toEqual([
      { start: 3, end: 14, kind: 'slash' },
      { start: 15, end: 20, kind: 'reference' },
    ]);
  });

  it('does not rewrite unavailable, mismatched, or non-skill commands', () => {
    const discovered = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'discovered',
      runtimeCommandName: 'skill:demo',
    });
    const desktop: UnifiedCommand = { kind: 'desktop', name: 'demo', description: 'Demo' };

    expect(rewriteAgentSkillInvocationForDispatch('/demo', discovered)).toBe('/demo');
    expect(rewriteAgentSkillInvocationForDispatch('/other', {
      ...discovered,
      runtimeStatus: 'loaded',
    })).toBe('/other');
    expect(rewriteAgentSkillInvocationForDispatch('/demo', desktop)).toBe('/demo');
  });

  it('leaves non-Pi first messages untouched without loading a roster', async () => {
    await expect(rewritePiSkillMessageForSend({
      agentKind: 'codex',
      message: '/git please',
    })).resolves.toBe('/git please');
  });

  it('rewrites a discovered Pi project skill that already has a runtime alias', () => {
    const discovered = skill({
      name: 'git',
      scope: 'repo',
      runtimeStatus: 'discovered',
      runtimeCommandName: 'skill:git',
    });
    expect(rewriteAgentSkillInvocationForDispatch('/git please', discovered)).toBe('/git please');
    expect(rewritePiSkillAliasFromCommand('/git please', discovered)).toBe('/skill:git please');
    expect(rewritePiSkillAliasFromCommand(' \n/git please', discovered)).toBe(' \n/skill:git please');
    expect(rewritePiSkillAliasFromCommand('note /git', discovered)).toBe('note /git');
  });
});

describe('filterSlashCommands', () => {
  it('places Cindy official entries before ordinary commands in the initial palette', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'help', description: 'Help' },
      {
        kind: 'agent-skill' as const,
        name: 'cindy-skill-creator',
        description: 'Create or update a Cindy Skill',
        builtIn: true,
        source: 'skill' as const,
      },
      {
        kind: 'agent-skill' as const,
        name: 'learn',
        description: CINDY_LEARN_SOURCE_DESCRIPTION,
        builtIn: true,
        source: 'skill' as const,
      },
      { kind: 'agent-skill' as const, name: 'release-notes', source: 'skill' as const },
    ];

    expect(filterSlashCommands(commands, '').map((command) => command.name)).toEqual([
      'cindy-skill-creator',
      'learn',
      'help',
      'release-notes',
    ]);
  });

  it('recognizes the Cindy Learn Skill but not a same-name desktop command or user Skill', () => {
    expect(isCindyOfficialSlashCommand({
      kind: 'desktop',
      name: 'learn',
      description: 'Learn',
    })).toBe(false);
    expect(isCindyOfficialSlashCommand({
      kind: 'agent-skill',
      name: 'learn',
      description: CINDY_LEARN_SOURCE_DESCRIPTION,
      builtIn: true,
      source: 'skill',
    })).toBe(true);
    expect(isCindyOfficialSlashCommand({
      kind: 'agent-skill',
      name: 'learn',
      description: 'Distill a reusable Skill with Cindy',
      builtIn: true,
      source: 'skill',
    })).toBe(true);
    expect(isCindyOfficialSlashCommand({
      kind: 'agent-skill',
      name: 'learn',
      description: CINDY_LEARN_SOURCE_DESCRIPTION,
      source: 'skill',
    })).toBe(false);
  });

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

  it('reproduces issue #4788 with a Skill ranked beyond the visible limit', () => {
    const commands = issue4788Commands();
    expect(commands).toHaveLength(37);
    expect(commands[32]?.name).toBe(ISSUE_4788_TARGET);

    for (const query of ['', 'cindy', 'e2e']) {
      const result = filterSlashCommandsWithMeta(commands, query);
      expect(result.items).toHaveLength(25);
      expect(result.hasMore).toBe(true);
      expect(result.items.some((command) => command.name === ISSUE_4788_TARGET)).toBe(false);
    }

    expect(filterSlashCommandsWithMeta(commands, '').totalMatches).toBe(37);
    expect(filterSlashCommandsWithMeta(commands, 'cindy').totalMatches).toBe(33);
    expect(filterSlashCommandsWithMeta(commands, 'e2e').totalMatches).toBe(33);
    expect(filterSlashCommandsWithMeta(commands, 'run').items.map((command) => command.name)).toEqual([
      ISSUE_4788_TARGET,
    ]);
    expect(filterSlashCommandsWithMeta(commands, 'testcase').items.map((command) => command.name)).toEqual([
      ISSUE_4788_TARGET,
    ]);
  });

  it('reports truncation metadata without changing the ranked visible items', () => {
    const commands = [
      { kind: 'desktop' as const, name: 'drive-sync', description: '' },
      { kind: 'desktop' as const, name: 'archive-drive', description: '' },
      { kind: 'desktop' as const, name: 'drive', description: '' },
    ];

    expect(filterSlashCommandsWithMeta(commands, 'drive', 2)).toEqual({
      items: [commands[2], commands[0]],
      totalMatches: 3,
      hasMore: true,
    });
    expect(filterSlashCommands(commands, 'drive', 2)).toEqual(
      filterSlashCommandsWithMeta(commands, 'drive', 2).items,
    );
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

  it.each(['foo', 'path'])(
    'forwards unknown Pi slash text /%s after one refresh without retry delays',
    async (commandName) => {
      const sleeps: number[] = [];
      const reload = vi.fn(async () => [] as UnifiedCommand[]);

      await expect(reconcilePiRuntimeCommandForDispatchWithRetry({
        agentKind: 'pi',
        sessionId: 'session-1',
        commandName,
        commands: [],
        retryDelaysMs: [10, 20],
        sleep: async (delayMs) => { sleeps.push(delayMs); },
        reload,
      })).resolves.toEqual({ command: undefined, commands: [] });
      expect(sleeps).toEqual([]);
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it('disables unproven runtime skills while keeping approved new-task previews available', () => {
    expect(isSlashCommandUnavailable(skill({ scope: 'repo', runtimeStatus: 'discovered' }))).toBe(true);
    expect(isSlashCommandUnavailable(skill({ scope: 'repo', runtimeStatus: 'loaded' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'user', runtimeStatus: 'discovered' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'user', runtimeStatus: 'unknown' }))).toBe(true);
    expect(isSlashCommandUnavailable(skill({ scope: 'user', runtimeStatus: 'failed' }))).toBe(true);
    expect(isSlashCommandUnavailable(skill({ scope: 'user', runtimeStatus: 'approved' }))).toBe(false);
    expect(isSlashCommandUnavailable(skill({ scope: 'repo' }))).toBe(false);
  });

  it('keeps the palette / composer label while invoking Pi skills by their runtime command name', () => {
    const loaded = skill({
      name: 'demo',
      scope: 'repo',
      runtimeStatus: 'loaded',
      runtimeCommandName: 'skill:demo',
    });

    expect(loaded.name).toBe('demo');
    expect(slashCommandInvocationName(loaded)).toBe('skill:demo');
    expect(slashCommandInvocationName({ kind: 'desktop', name: 'help', description: 'Help' })).toBe('help');
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

  it('retries a missing command after explicitly starting its project runtime', async () => {
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
      commands: [],
      prepareRuntime: async () => undefined,
      retryDelaysMs: [10, 20],
      sleep: async (delayMs) => { sleeps.push(delayMs); },
      reload: async () => (++reloads < 2 ? [] : [loaded]),
    })).resolves.toEqual({ command: loaded, commands: [loaded] });
    expect(sleeps).toEqual([10]);
    expect(reloads).toBe(2);
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
