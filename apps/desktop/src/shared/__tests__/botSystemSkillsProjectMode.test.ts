import { expect, it } from 'vitest';
import { botSystemSkillIdsFor, effectiveBotSystemSkillsOff } from '../botSystemSkills';

// 依据：V2 伙伴没有系统技能（例行任务、跟进、待办都由普通自动化、普通任务和项目文件承担），
// 所有读取处都按关掉算，设置页也不列。缺口：跟进与待办仍按原始开关运行。tier：unit。
it('treats every system Skill as absent for a project-mode teammate', () => {
  expect(botSystemSkillIdsFor({ projectMode: true })).toEqual([]);
  expect(effectiveBotSystemSkillsOff({ projectMode: true })).toEqual(['routine']);
  // A stored V1 `follow` / `todo` switch is ignored.
  expect(effectiveBotSystemSkillsOff({ systemSkillsOff: ['follow', 'todo'] })).toEqual([]);
});
