import { expect, it } from 'vitest';
import { botSystemSkillIdsFor, effectiveBotSystemSkillsOff } from '../botSystemSkills';

// 依据：V2 伙伴没有自己的例行任务与跟进（用普通自动化和普通任务），这两项在所有读取处都按关掉算，
// 设置页也只列待办。缺口：跟进仍按原始开关运行。tier：unit。
it('treats routines and follow-up as absent for a project-mode teammate', () => {
  expect(botSystemSkillIdsFor({ projectMode: true })).toEqual(['todo']);
  expect(effectiveBotSystemSkillsOff({ projectMode: true })).toEqual(['routine', 'follow']);
  expect(effectiveBotSystemSkillsOff({ projectMode: true, systemSkillsOff: ['todo'] })).toEqual(['todo', 'routine', 'follow']);
  expect(effectiveBotSystemSkillsOff({ systemSkillsOff: ['follow'] })).toEqual(['follow']);
});
