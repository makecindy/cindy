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

  it('uses direct Bot tools and avoids whole-surface discovery loops', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('You are a teammate with a durable profile');
    expect(prompt).toContain('Use direct teammate tools');
    expect(prompt).toContain('`find_teammate_capabilities`');
    expect(prompt).toContain('`set_teammate_capability`');
    expect(prompt).toContain('installed-plugin gateway (`ghost_list`, `ghost_info`, `ghost_call`)');
    expect(prompt).toContain('New mounts take effect next turn in this same task');
    expect(prompt).toContain('`start_session_task`');
    expect(prompt).toContain('proactively start independent tasks for coding and medium or large work');
    expect(prompt).toContain('`check_session_task`');
    expect(prompt).toContain('`message_session_task`');
    expect(prompt).toContain('`stop_session_task`');
    expect(prompt).toContain('`send_to_agent`');
    expect(prompt).toContain('do not repeatedly list the whole tool surface');
    expect(prompt).toContain('Completion returns automatically');
    expect(prompt).toContain('It is not a task and has no progress or cancellation');
    expect(prompt).toContain('does not rewrite another teammate\'s identity');
    expect(prompt).toContain('offer either a message or a tracked Session task');
    expect(prompt).not.toContain('delegate_to_bot');
    expect(prompt).not.toContain('list_bot_delegations');
  });

  it('does not advertise helper discovery or delegation when the target cannot mount it', () => {
    const prompt = buildBotCapabilityContextPrompt({ helperAvailable: false });
    expect(prompt).toContain('durable profile');
    expect(prompt).toContain('Respect the user’s memory switch');
    expect(prompt).not.toContain('`list_tools`');
    expect(prompt).not.toContain('discover other available Bots');
    expect(prompt).not.toContain('`start_session_task`');
    expect(prompt).not.toContain('`save_teammate_skill`');
    expect(prompt).not.toContain('ghost_list');
  });

  it('keeps helper capability tools when cindy is not on the remote tool surface', () => {
    const prompt = buildBotCapabilityContextPrompt({ helperAvailable: true, cindyAvailable: false });
    expect(prompt).toContain('`find_teammate_capabilities`');
    expect(prompt).toContain('`set_teammate_capability`');
    expect(prompt).toContain('`start_session_task`');
    expect(prompt).toContain('do not repeatedly list the whole tool surface');
    expect(prompt).not.toContain('ghost_list');
    expect(prompt).not.toContain('ghost_info');
    expect(prompt).not.toContain('ghost_call');
  });

  it('keeps learned Skills deliberate instead of writing a diary of every turn', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('Use a `learned-` name only for a stable reusable working habit');
    expect(prompt).toContain('Respect the user’s memory switch');
    expect(prompt).toContain('without waiting for a request to remember');
    expect(prompt).toContain('One verified reusable success is enough');
    expect(prompt).toContain('not an extra learning model or background review worker');
    expect(prompt).toContain('never for a one-off conclusion');
  });

  /**
   * 批次 ζ:「TA 学会的」列的是**真技能**,来源是伙伴自己调 `save_teammate_skill`。
   * 这条约定掉了,技能就永远长不出来 —— 判断「这次做法值不值得沉淀」是语言理解
   * 问题,代码判不了(maker-core-and-agent-behavior.md §2 的分界)。
   */
  it('only saves a verified reusable workflow as a real Skill', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('`save_teammate_skill`');
    expect(prompt).toContain('`list_teammate_skills`');
    expect(prompt).toContain('only after the workflow has succeeded');
    expect(prompt).toContain('reusable steps are known');
    expect(prompt).toContain('at a safe turn boundary in this same chat');
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
      expect(runtimePrompt).toContain('`start_session_task`');
      expect(runtimePrompt).toContain('Completion returns automatically');
      expect(runtimePrompt).toContain('offer either a message or a tracked Session task');
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

  it('treats legacy inherit as no ambient MCP or toolset grants', () => {
    expect(
      resolveBotMcpReferences({
        mode: 'inherit',
        configured: [],
        catalog: [{ name: 'global-search', source: 'custom', available: true }],
      }),
    ).toEqual({ resolved: [], unavailable: [] });
    expect(
      resolveBotToolsetReferences({
        mode: 'inherit',
        configured: [],
        catalog: [{ id: 'browser', name: 'Browser', available: true }],
      }),
    ).toEqual({ resolved: [], unavailable: [], disabled: ['browser'] });
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
