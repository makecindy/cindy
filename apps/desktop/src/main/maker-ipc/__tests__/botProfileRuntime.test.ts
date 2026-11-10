import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  buildBotCapabilityContextPrompt,
  buildBotProfileContextPrompt,
  buildBotProfilePrompt,
  resolveBotMcpReferences,
  resolveBotSkillReferences,
  resolveBotToolsetReferences,
  withBotHomeAccess,
} from '../botProfileRuntime';
import { buildDefaultBotIdentity } from '../../../shared/botProfileDefaults';
import { TEAMMATE_CORE_TOPICS, TEAMMATE_SYSTEM_SKILLS } from '@cindy/mcps';
import { TEAMMATE_CORE_MAX_CHARS, buildTeammateGuide } from '../teammateGuide';
import { buildBotMcpCatalog } from '../../maker-host/botMcpCatalog';

// Unit regression: default inheritance must retain engine connectors while an
// explicit allowlist can exclude them. Previously Apps was absent from the catalog.
it('resolves native Apps through the same Bot inheritance and selection rules', () => {
  const catalog = buildBotMcpCatalog({ agentKind: 'codex', providers: [], builtinNames: [], customServers: [] });
  expect(resolveBotMcpReferences({ configured: [], mode: 'inherit', catalog })).toEqual({ resolved: ['codex_apps'], unavailable: [] });
  expect(resolveBotMcpReferences({ configured: [], mode: 'allowlist', catalog })).toEqual({ resolved: [], unavailable: [] });
  expect(resolveBotMcpReferences({ configured: ['codex_apps'], mode: 'allowlist', catalog })).toEqual({ resolved: ['codex_apps'], unavailable: [] });
});

describe('Bot Profile runtime prompt', () => {
  it('uses the SOUL source verbatim as the complete identity slot', () => {
    const prompt = buildBotProfilePrompt({
      displayName: 'Kitchen helper',
      identitySource: 'A calm chef who explains recipes clearly.',
    });
    expect(prompt).toBe('A calm chef who explains recipes clearly.');
    expect(prompt).not.toContain('Cindy Bot Profile');
    expect(prompt).not.toContain('Profile version');
    expect(prompt).not.toContain('Configured skill');
    expect(prompt).not.toContain('tool/MCP');
    expect(prompt).not.toContain('memory policy');
    expect(prompt).not.toContain('Automation policy');
  });

  it('seeds a useful Hermes-style identity when the SOUL source is empty', () => {
    const prompt = buildBotProfilePrompt({
      displayName: 'Research helper',
      identitySource: '',
    });
    expect(prompt).toContain('You are Research helper');
  });

  it('uses a legacy empty identity’s role without replacing an explicit SOUL', () => {
    const description = '负责财务分析。';
    expect(buildBotProfilePrompt({ displayName: 'Finance', identitySource: '  ', description })).toBe(description);
    expect(buildBotProfilePrompt({ displayName: 'Finance', identitySource: 'User-authored SOUL', description })).toBe('User-authored SOUL');
  });

  it('uses the same persisted default SOUL as the runtime fallback', () => {
    const soul = buildDefaultBotIdentity('Research helper');
    expect(
      buildBotProfilePrompt({ displayName: 'Research helper', identitySource: soul }),
    ).toBe(soul);
  });

  it('keeps the active profile marker separate from SOUL', () => {
    const context = buildBotProfileContextPrompt('Kitchen helper');
    expect(context).toMatch(/^Active Cindy Bot profile: Kitchen helper\./);
    expect(context).toContain('current SOUL and user profile');
    expect(context).toContain('execution engines, not your personal identity');
    expect(context).toContain('context compaction, restarts, and model changes');
    expect(context).toContain('Use available host tools for model changes');
    expect(context).toContain('Connecting a new model or signing in to a provider is managed in Cindy settings');
    expect(context).not.toContain('direct the user to the teammate’s model settings');
    expect(context).not.toContain('claim access to settings you cannot operate');
    expect(context).toContain('Do not present terminal-only slash commands');
  });

  // Rule (cindy-bots-runtime.md §6「伙伴技能分层」, 2026-11-01): the core keeps orchestration and points to
  // details instead of preloading them; every detail it names must be one read away.
  it('keeps orchestration in a capped core and the details one read away', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt.length).toBeLessThanOrEqual(TEAMMATE_CORE_MAX_CHARS);
    for (const tool of ['`read_teammate_skill`', '`send_to_agent`', '`find_teammate_capabilities`', '`set_teammate_capability`',
      '`get_teammate_state`', '`update_teammate_profile`', '`ghost_list`', '`connect_account`'])
      expect(prompt).toContain(tool);
    for (const topic of Object.keys(TEAMMATE_CORE_TOPICS)) expect(prompt).toContain(`\`${topic}\``);
    // Moved, not dropped: the task and teammate boundaries live in their topics.
    expect(TEAMMATE_CORE_TOPICS.tasks.body).toContain('Completion returns automatically');
    expect(TEAMMATE_CORE_TOPICS.tasks.body).toContain('the user explicitly requests an independent task');
    expect(TEAMMATE_CORE_TOPICS.teammates.body).toContain('It is not a task and has no progress or cancellation');
    expect(TEAMMATE_CORE_TOPICS.teammates.body).toContain('offer either a message or a tracked Session task');
    // MCP (Chris 2026-11-01): config files are not a connection and a new task is never the fix;
    // registering uses Cindy's own form and an already-joined server is left alone.
    expect(prompt).toContain('writing config files such as `.mcp.json` connects nothing');
    expect(prompt).toContain('never tell the owner to start a new task');
    expect(TEAMMATE_CORE_TOPICS.mcp.body).toContain('`request_mcp_setup`');
    expect(TEAMMATE_CORE_TOPICS.mcp.body).toContain('If it is already joined, change nothing');
    // System Skills are listed by name only.
    expect(prompt).not.toContain('list_teammate_todos');
    expect(prompt).not.toContain('schedule_set_pre_run_hook');
    expect(prompt).not.toContain('delegate_to_bot');
  });

  it('names turned-off system Skills as unavailable and drops them from the list', () => {
    const prompt = buildBotCapabilityContextPrompt({ systemSkillsOff: ['todo'] });
    expect(prompt).toContain('On: `routine`');
    expect(prompt).not.toContain(`\`todo\` — ${TEAMMATE_SYSTEM_SKILLS.todo.description}`);
    expect(prompt).toContain('Off: `todo`. Their tools are unavailable');
  });

  // Greptile #8330: every local teammate mounts the same core file, so it must not claim a teammate's switches.
  it('keeps per-teammate system Skill state out of the shared core file', () => {
    const shared = buildTeammateGuide({ shared: true, systemSkillsOff: ['todo'] });
    expect(shared).not.toMatch(/\bOn: |\bOff: |All system Skills are off/);
    for (const id of ['todo', 'routine', 'follow']) expect(shared).toContain(`\`${id}\` — `);
    expect(shared).toContain('your preloaded profile says which are on for you');
    expect(shared.length).toBeLessThanOrEqual(TEAMMATE_CORE_MAX_CHARS);
  });

  it('does not advertise helper discovery or delegation when the target cannot mount it', () => {
    const prompt = buildBotCapabilityContextPrompt({ helperAvailable: false });
    expect(prompt).toContain('Respect the memory switch');
    expect(prompt).not.toContain('`read_teammate_skill`');
    expect(prompt).not.toContain('`send_to_agent`');
    expect(prompt).not.toContain('`save_teammate_skill`');
    expect(prompt).not.toContain('ghost_list');
  });

  it('keeps helper capability tools when cindy is not on the remote tool surface', () => {
    const prompt = buildBotCapabilityContextPrompt({ helperAvailable: true, cindyAvailable: false });
    expect(prompt).toContain('`find_teammate_capabilities`');
    expect(prompt).toContain('`set_teammate_capability`');
    expect(prompt).toContain('discover only what the work needs');
    expect(prompt).not.toContain('ghost_list');
    expect(prompt).not.toContain('`plugins`');
  });

  it('keeps learned Skills deliberate instead of writing a diary of every turn', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('Save a personal Skill only when the owner asks');
    expect(prompt).toContain('Respect the memory switch');
    const memory = TEAMMATE_CORE_TOPICS.memory.body;
    expect(memory).toContain('Use a `learned-` name only for a stable reusable working habit');
    expect(memory).toContain('without waiting for a request to remember');
    expect(memory).toContain('only when the user explicitly asks you to keep a method as a Skill');
    // 回复后复盘已于 2026-10-23 停用，提示词不得再承诺宿主会事后补漏。
    expect(memory).not.toContain('the host also reviews the completed reply for missed learning');
    expect(memory).toContain('Do not launch a separate review task yourself');
    expect(memory).toContain('only after the workflow has succeeded');
    expect(memory).toContain('at a safe turn boundary in this same chat');
  });

  it('keeps the same affirmative delegation guidance beside the default and every preset SOUL', () => {
    const identities = [
      { name: 'Default Bot', identitySource: buildDefaultBotIdentity('Default Bot') },
    ];
    for (const identity of identities) {
      const runtimePrompt = [
        buildBotProfilePrompt({
          displayName: identity.name,
          identitySource: identity.identitySource,
        }),
        buildBotProfileContextPrompt(identity.name),
        buildBotCapabilityContextPrompt(),
      ].join('\n\n');
      expect(runtimePrompt).toContain('`send_to_agent`');
      expect(runtimePrompt).toContain('`read_teammate_skill`');
      expect(runtimePrompt).not.toContain('redirecting them to a separate team workflow.\n\nYou are');
    }
  });

  it('admits only Skills proven by the selected harness catalog', () => {
    expect(
      resolveBotSkillReferences(
        ['recipe-planner', 'missing', 'broken'],
        [
          { name: 'recipe-planner', runtimeCommandName: 'recipe', enabled: true },
          { name: 'broken', runtimeStatus: 'failed' },
        ],
      ),
    ).toEqual({
      resolvedSkills: ['recipe'],
      unavailableSkills: ['missing', 'broken'],
      resolvedSkillEntries: [
        { name: 'recipe-planner', runtimeCommandName: 'recipe', enabled: true },
      ],
    });
  });

  it('keeps builtin MCP outside the custom MCP allowlist', () => {
    expect(
      resolveBotMcpReferences({
        mode: 'allowlist',
        configured: ['search', 'missing', 'cindy_memory'],
        catalog: [
          { name: 'search', source: 'custom', available: true },
          { name: 'cindy_memory', source: 'builtin', available: true },
        ],
      }),
    ).toEqual({
      resolved: ['search'],
      unavailable: ['missing', 'cindy_memory'],
    });
  });

  it('inherits available MCPs and toolsets without a companion-specific opt-in', () => {
    expect(
      resolveBotMcpReferences({
        mode: 'inherit',
        configured: [],
        catalog: [{ name: 'global-search', source: 'custom', available: true }],
      }),
    ).toEqual({ resolved: ['global-search'], unavailable: [] });
    expect(
      resolveBotToolsetReferences({
        mode: 'inherit',
        configured: [],
        catalog: [{ id: 'browser', name: 'Browser', available: true }],
      }),
    ).toEqual({ resolved: ['browser'], unavailable: [], disabled: [] });
  });

  it('combines Bot toolset policy with project availability', () => {
    expect(
      resolveBotToolsetReferences({
        mode: 'allowlist',
        configured: ['browser', 'contacts', 'missing'],
        catalog: [
          { id: 'core', name: 'Core', essential: true, available: true },
          { id: 'browser', name: 'Browser', available: true },
          { id: 'contacts', name: 'Contacts', available: false },
          { id: 'calendar', name: 'Calendar', available: true },
        ],
      }),
    ).toEqual({
      resolved: ['browser'],
      unavailable: ['contacts', 'missing'],
      disabled: ['contacts', 'calendar'],
    });
  });
});

describe('Bot Home content write boundary', () => {
  const HOME = path.join('data', 'bots', 'bot-a');
  const CONTENT = [path.join(HOME, 'workspace')];

  it('mounts only workspace but never the whole Home', () => {
    expect(withBotHomeAccess(undefined, undefined, HOME, CONTENT)).toEqual({
      extraDirs: undefined,
      writableDirs: CONTENT,
    });
  });

  it('preserves explicit references and writable grants', () => {
    expect(withBotHomeAccess(
      [path.join('work', 'design'), path.join('work', 'docs')],
      [path.join('work', 'output')],
      HOME,
      CONTENT,
    )).toEqual({
      extraDirs: [path.join('work', 'design'), path.join('work', 'docs')],
      writableDirs: [path.join('work', 'output'), ...CONTENT],
    });
  });

  it('removes the legacy whole-Home grant and deduplicates content roots', () => {
    expect(withBotHomeAccess([path.join('work', 'design'), HOME], [HOME, CONTENT[0]!], HOME, CONTENT)).toEqual({
      extraDirs: [path.join('work', 'design')],
      writableDirs: CONTENT,
    });
  });

  it('removes normalized and ancestor grants that would expose host policy files', () => {
    expect(withBotHomeAccess(
      [path.join('data'), `${HOME}${path.sep}`],
      [path.join('data'), path.join(HOME, '.')],
      HOME,
      [
        ...CONTENT,
        path.join(HOME, 'memories'),
        path.join(HOME, 'skills'),
        path.join(HOME, '..', 'outside'),
      ],
    )).toEqual({
      extraDirs: undefined,
      writableDirs: CONTENT,
    });
  });

  it('没有家(远端会话)时不动用户的设置,也不凭空造出一个空数组', () => {
    expect(withBotHomeAccess(undefined, undefined, '')).toEqual({
      extraDirs: undefined,
      writableDirs: undefined,
    });
    expect(withBotHomeAccess([path.join('work', 'design')], [path.join('work', 'output')], '   ')).toEqual({
      extraDirs: [path.join('work', 'design')],
      writableDirs: [path.join('work', 'output')],
    });
  });
});
