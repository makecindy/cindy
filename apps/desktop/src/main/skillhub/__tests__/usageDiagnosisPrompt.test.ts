import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSkillUsageDiagnosisPrompt } from '../usageDiagnosisPrompt';

const skillName = '工具 "alpha" $&';
const skillPath = path.join('skills', skillName, 'SKILL.md');
const rawFilePath = path.join('transcripts', 'chat.jsonl');
const params = {
  skillName,
  skillPath,
  stats: { totalUseCount: 2 },
  evidenceIndexes: [{ rawFilePath, rawLineNo: 17, agentKind: 'pi' }],
};

describe('Skill usage diagnosis prompt', () => {
  it.each([
    ['zh-CN', '请根据实际执行记录', '默认使用简体中文', '用户明确要求其他语言'],
    ['zh-TW', '請根據實際執行記錄', '預設使用繁體中文', '使用者明確要求其他語言'],
    ['en', 'Diagnose', 'in English by default', 'explicit user request for another language'],
    ['ja', '実際の実行記録に基づいて', '原則として日本語', 'ユーザーが別の言語を明示'],
    ['ko', '실제 실행 기록을 바탕으로', '기본적으로 한국어', '사용자가 다른 언어를 명시적으로 요청'],
  ] as const)('uses %s for instructions and raw indexes', (locale, request, language, override) => {
    const prompt = renderSkillUsageDiagnosisPrompt({ ...params, locale });
    expect(prompt).toContain(request);
    expect(prompt).toContain(language);
    expect(prompt).toContain(override);
    expect(prompt).toContain(skillName);
    expect(prompt).toContain(JSON.stringify(skillPath));
    expect(prompt).toContain(JSON.stringify(rawFilePath));
    expect(prompt).toContain('"rawLineNo": 17');
    expect(prompt).toContain('"agentKind": "pi"');
    expect(prompt).not.toContain('{{skillName}}');
    expect(prompt).not.toContain('{{days}}');
  });

  it('uses the shared default locale without substituting dynamic strings as templates', () => {
    const prompt = renderSkillUsageDiagnosisPrompt(params);
    expect(prompt).toContain(`Diagnose how Skill "${skillName}" was used in actual tasks.`);
    expect(prompt).toContain('"totalUseCount": 2');
    expect(prompt).toContain('not final success rates or quality scores');
    expect(prompt).toContain('smallest concrete edit');
  });

  it('discloses stale and unavailable evidence in the material sent to the agent', () => {
    const prompt = renderSkillUsageDiagnosisPrompt({
      ...params,
      locale: 'en',
      refreshStatus: { phase: 'incomplete', scanned: 2, total: 3, lastSuccessAt: 1_700_000_000_000,
        incomplete: true, missingCount: 1, error: null, hasSnapshot: true },
    });
    expect(prompt).toContain('"incomplete": true');
    expect(prompt).toContain('"missingTranscriptCount": 1');
    expect(prompt).toContain('2023-11-14T22:13:20.000Z');
    expect(prompt).toContain('Do not interpret missing or outdated evidence as no usage');
  });
});
