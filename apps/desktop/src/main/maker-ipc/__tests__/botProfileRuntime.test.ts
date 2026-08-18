import { describe, expect, it } from 'vitest';

import {
  buildBotCapabilityContextPrompt,
  buildBotProfileContextPrompt,
  buildBotProfilePrompt,
  resolveBotMcpReferences,
  resolveBotSkillReferences,
  resolveBotToolsetReferences,
} from '../botProfileRuntime';
import { buildDefaultBotIdentity } from '../../../shared/botProfileDefaults';
import { BOT_TEMPLATES } from '../../../renderer/features/bots/botTemplates';

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

  it('teaches every Bot to discover its live collaboration surface before denying it', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('You are running as a Cindy Bot');
    expect(prompt).toContain('Use `list_tools`');
    expect(prompt).toContain('discover other available Bots');
    expect(prompt).toContain('receive the result back in this task');
    expect(prompt).toContain('inspect ongoing or completed handoffs');
    expect(prompt).toContain('cancel a handoff that is still active');
    expect(prompt).toContain('does not rewrite another Bot\'s identity');
    expect(prompt).toContain('offer the available delegation path');
    expect(prompt).not.toContain('delegate_to_bot');
    expect(prompt).not.toContain('list_bot_delegations');
  });

  /**
   * 批次 ε:设置页的「TA 学会的」按 `learned-` slug 前缀切片。前缀只有在这条约定
   * 还在 prompt 里时才会被写出来 —— 删掉它,那个列表就永远是空的。
   */
  it('teaches the learned- naming convention that feeds "TA 学会的"', () => {
    const prompt = buildBotCapabilityContextPrompt();
    expect(prompt).toContain('`learned-` name prefix');
    // 判断"什么值得记成可复用做法"留给模型;代码只做确定性的前缀检出。
    expect(prompt).toContain('a reusable way of working');
    // 不许暗示这是另一个存储:它就是同一份记忆,只是名字不同。
    expect(prompt).toContain('Both stay in your memory');
  });

  it('keeps the same affirmative delegation guidance beside the default and every preset SOUL', () => {
    const identities = [
      { name: 'Default Bot', identitySource: buildDefaultBotIdentity('Default Bot') },
      ...BOT_TEMPLATES.map((template) => ({
        name: template.id,
        identitySource: template.identitySource,
      })),
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
