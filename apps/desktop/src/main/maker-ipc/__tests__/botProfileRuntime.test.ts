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

  it('uses the same persisted default SOUL as the runtime fallback', () => {
    const soul = buildDefaultBotIdentity('Research helper');
    expect(
      buildBotProfilePrompt({ displayName: 'Research helper', identitySource: soul }),
    ).toBe(soul);
  });

  it('keeps the active profile marker separate from SOUL', () => {
    expect(buildBotProfileContextPrompt('Kitchen helper')).toBe(
      'Active Cindy Bot profile: Kitchen helper.',
    );
  });

  it('uses direct Bot tools and avoids whole-surface discovery loops', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('You are running as a Cindy Bot');
    expect(prompt).toContain('Use direct Bot tools');
    expect(prompt).toContain('`start_session_task`');
    expect(prompt).toContain('never selects or wakes a Bot');
    expect(prompt).toContain('do not repeatedly list the whole tool surface');
    expect(prompt).toContain('discover other available Bots');
    expect(prompt).toContain('receive the result back in this task');
    expect(prompt).toContain('inspect ongoing or completed handoffs');
    expect(prompt).toContain('cancel a handoff that is still active');
    expect(prompt).toContain('does not rewrite another Bot\'s identity');
    expect(prompt).toContain('offer the available delegation path');
    expect(prompt).not.toContain('delegate_to_bot');
    expect(prompt).not.toContain('list_bot_delegations');
  });

  it('does not advertise helper discovery or delegation when the target cannot mount it', () => {
    const prompt = buildBotCapabilityContextPrompt({ helperAvailable: false });
    expect(prompt).toContain('durable Profile');
    expect(prompt).toContain('not a diary of every turn');
    expect(prompt).not.toContain('`list_tools`');
    expect(prompt).not.toContain('discover other available Bots');
    expect(prompt).not.toContain('`start_session_task`');
    expect(prompt).not.toContain('`save_bot_skill`');
  });

  it('keeps learned Skills deliberate instead of writing a diary of every turn', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('Use a `learned-` name only for a stable reusable working habit');
    expect(prompt).toContain('not a diary of every turn');
    expect(prompt).toContain('instead of waiting for repetition');
    expect(prompt).toContain('after that first verified success');
    expect(prompt).toContain('Never start a background review worker');
    expect(prompt).toContain('never for a one-off conclusion');
  });

  /**
   * 批次 ζ:「TA 学会的」列的是**真技能**,来源是伙伴自己调 `save_bot_skill`。
   * 这条约定掉了,技能就永远长不出来 —— 判断「这次做法值不值得沉淀」是语言理解
   * 问题,代码判不了(maker-core-and-agent-behavior.md §2 的分界)。
   */
  it('only saves a verified reusable workflow as a real Skill', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('`save_bot_skill`');
    expect(prompt).toContain('`list_bot_skills`');
    expect(prompt).toContain('only after the workflow has succeeded');
    expect(prompt).toContain('reusable steps are known');
    expect(prompt).toContain('mounted from the next task onward');
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
      expect(runtimePrompt).toContain('can discover other available Bots');
      expect(runtimePrompt).toContain('hand off a bounded objective');
      expect(runtimePrompt).toContain('receive the result back in this task');
      expect(runtimePrompt).toContain('offer the available delegation path');
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
