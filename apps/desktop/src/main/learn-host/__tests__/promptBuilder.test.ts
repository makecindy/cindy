import { describe, expect, it } from 'vitest';

import { buildLearnPrompt, SKILL_AUTHORING_SPEC } from '../promptBuilder';

describe('buildLearnPrompt', () => {
  const base = { userRequest: 'learn how I release the mobile app', evidenceBlock: '' };

  it('always contains the staging write constraint (防回归:代码扫描依赖它)', () => {
    const p = buildLearnPrompt(base);
    expect(p).toContain('Write ONLY inside ./<skill-name>/');
    expect(p).toContain('Do not create more than one skill directory');
    expect(p).toContain(SKILL_AUTHORING_SPEC);
  });

  it('includes the user request verbatim', () => {
    const p = buildLearnPrompt(base);
    expect(p).toContain('learn how I release the mobile app');
  });

  it('omits the evidence section when there is no evidence', () => {
    const p = buildLearnPrompt(base);
    expect(p).not.toContain('LOCAL USAGE EVIDENCE');
  });

  it('embeds the evidence block and the redaction guard when present', () => {
    const p = buildLearnPrompt({
      ...base,
      evidenceBlock: '--- Evidence 1 ---\nUser: run pnpm test',
    });
    expect(p).toContain('LOCAL USAGE EVIDENCE');
    expect(p).toContain('User: run pnpm test');
    expect(p).toContain('[REDACTED:*]');
  });

  it('embeds reference and existing skill sections when provided', () => {
    const p = buildLearnPrompt({
      ...base,
      referenceSkillContent: '--- ref skill md ---',
      existingSkillContent: '--- existing skill md ---',
    });
    expect(p).toContain('REFERENCE SKILL');
    expect(p).toContain('--- ref skill md ---');
    expect(p).toContain('EXISTING LOCAL SKILL');
    expect(p).toContain('--- existing skill md ---');
  });

  it('marks hub reference files as partial when omissions are present', () => {
    const p = buildLearnPrompt({
      ...base,
      referenceSkillContent: '--- ref skill md ---',
      referenceFilesDir: './_reference/demo-skill/',
      referenceFilesOmissions: [
        { path: 'scripts/missing.py', reason: 'not fetched; reference file limit is 40' },
      ],
    });

    expect(p).toContain('the reference\nfile set is PARTIAL');
    expect(p).toContain('OMITTED REFERENCE FILES');
    expect(p).toContain('- scripts/missing.py: not fetched; reference file limit is 40');
    expect(p).not.toContain('Its complete published files');
  });

  it('embeds the user profile with the project-scope guard, and personalization directives', () => {
    const p = buildLearnPrompt({
      ...base,
      userProfileBlock: '--- Chris (user) ---\nprefers concise',
    });
    expect(p).toContain('USER PROFILE');
    expect(p).toContain('prefers concise');
    expect(p).toContain('never transplant a project-scoped rule');
    expect(p).toContain('PERSONALIZE');
    // 无画像时省略段落(语言规则行仍会提及 USER PROFILE,按段落头判定),
    // 个性化指令恒在
    const bare = buildLearnPrompt(base);
    expect(bare).not.toContain('USER PROFILE (durable facts');
    expect(bare).toContain('PERSONALIZE');
  });

  it('embeds the conversation block and the installed skills index with the improve-vs-create rule', () => {
    const p = buildLearnPrompt({
      ...base,
      conversationBlock: 'User: deploy it\n\nAssistant: deployed',
      installedSkillsIndex: '- xdmaker-dev: dev rules [/skills/xdmaker-dev]',
    });
    expect(p).toContain('THE CURRENT CONVERSATION');
    expect(p).toContain('User: deploy it');
    expect(p).toContain('INSTALLED SKILLS INDEX');
    expect(p).toContain('REUSE ITS EXACT NAME');
    expect(p).toContain('do NOT read local');
    expect(p).not.toContain('read its SKILL.md');
    // 缺省时两段都省略
    const bare = buildLearnPrompt(base);
    expect(bare).not.toContain('THE CURRENT CONVERSATION');
    expect(bare).not.toContain('INSTALLED SKILLS INDEX');
  });

  it('spec keeps the frontmatter hard rules (name 规则 / description / no disable-model-invocation)', () => {
    expect(SKILL_AUTHORING_SPEC).toContain('must EQUAL the directory name');
    expect(SKILL_AUTHORING_SPEC).toContain('Do NOT set disable-model-invocation');
    expect(SKILL_AUTHORING_SPEC).toContain('under 200 characters');
  });

  it('requires a structured final reply in the app locale language (审查者的主要阅读材料)', () => {
    const p = buildLearnPrompt({ ...base, appLocale: 'zh-CN' });
    expect(p).toContain('FINAL REPLY');
    expect(p).toContain('Reply in Simplified Chinese (简体中文)');
    expect(p).toContain('Decisions and trade-offs');
    expect(p).toContain('What changed');
    expect(buildLearnPrompt({ ...base, appLocale: 'zh-TW' })).toContain(
      'Reply in Traditional Chinese (繁體中文)',
    );
    // locale 未知/缺省 → 回退 English
    expect(buildLearnPrompt(base)).toContain('Reply in English');
  });
});
