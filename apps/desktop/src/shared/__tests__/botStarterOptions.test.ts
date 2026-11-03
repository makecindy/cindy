import { expect, it } from 'vitest';
import { readBotStarterOptions, stripStarterOptionList } from '../botStarterOptions';

it('reads only a clean list of 1–4 short options', () => {
  expect(readBotStarterOptions(['审计一个模块', '复查改动'])).toEqual(['审计一个模块', '复查改动']);
  expect(readBotStarterOptions(['a1', 'b2', 'c3', 'd4', 'e5'])).toHaveLength(4);
  for (const bad of [undefined, 'x', [], [1], ['ok', ''], ['长'.repeat(61)]]) expect(readBotStarterOptions(bad)).toEqual([]);
});

it('hides exactly the stored trailing list and nothing else', () => {
  const options = ['审计一个模块', '复查改动'];
  expect(stripStarterOptionList('你好。\n\n- 审计一个模块\n- 复查改动', options)).toBe('你好。');
  expect(stripStarterOptionList('你好。\n\n- 审计一个模块\n- 其它', options)).toBe('你好。\n\n- 审计一个模块\n- 其它');
  expect(stripStarterOptionList('你好。', [])).toBe('你好。');
});
