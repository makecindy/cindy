import { describe, expect, it } from 'vitest';

import {
  compilePersonaIntoIdentitySource,
  extractPersonaBlockText,
  extractPersonaFromIdentitySource,
  readBotBackground,
  removePersonaFromIdentitySource,
  writeBotBackground,
  type PersonaSelection,
} from '../botPersona';

const BASE: PersonaSelection = { style: 'concise', proactivity: 'proactive', call: 'name' };

describe('botPersona', () => {
  it('compiles into an empty identitySource and roundtrips', () => {
    const compiled = compilePersonaIntoIdentitySource('', BASE);
    expect(compiled).toContain('<!--persona:v1:');
    expect(extractPersonaFromIdentitySource(compiled)).toEqual(BASE);
  });

  it('roundtrips every style/proactivity/call combination', () => {
    const styles: PersonaSelection['style'][] = ['concise', 'lively', 'steady'];
    const proactivities: PersonaSelection['proactivity'][] = ['reactive', 'proactive', 'reportAll'];
    const calls: PersonaSelection['call'][] = ['name', 'boss', 'custom'];
    for (const style of styles) {
      for (const proactivity of proactivities) {
        for (const call of calls) {
          const selection: PersonaSelection =
            call === 'custom'
              ? { style, proactivity, call, customCall: '老大' }
              : { style, proactivity, call };
          const compiled = compilePersonaIntoIdentitySource('', selection);
          expect(extractPersonaFromIdentitySource(compiled)).toEqual(selection);
        }
      }
    }
  });

  it('preserves hand-written content that precedes the marker on first insert', () => {
    const handwritten = '你是本本，喜欢用列表说话。';
    const compiled = compilePersonaIntoIdentitySource(handwritten, BASE);
    expect(compiled.startsWith(handwritten)).toBe(true);
    expect(extractPersonaFromIdentitySource(compiled)).toEqual(BASE);
  });

  it('appends the block after existing content on first insert, without duplicating it', () => {
    const handwritten = '你是本本，喜欢用列表说话。';
    const compiled = compilePersonaIntoIdentitySource(handwritten, BASE);
    expect(compiled.match(/<!--persona:v1:/g)).toHaveLength(1);
    expect(compiled.indexOf(handwritten)).toBeLessThan(compiled.indexOf('<!--persona:v1:'));
  });

  it('replaces (not duplicates) an existing marker block on re-save, keeping surrounding content', () => {
    const before = '开场白：你好呀。';
    const after = '额外规则：永远先确认预算。';
    const firstPass = compilePersonaIntoIdentitySource(`${before}\n\n${after}`, BASE);

    const secondSelection: PersonaSelection = { style: 'steady', proactivity: 'reportAll', call: 'boss' };
    const secondPass = compilePersonaIntoIdentitySource(firstPass, secondSelection);

    expect(secondPass.match(/<!--persona:v1:/g)).toHaveLength(1);
    expect(secondPass).toContain(before);
    expect(secondPass).toContain(after);
    expect(extractPersonaFromIdentitySource(secondPass)).toEqual(secondSelection);
  });

  it('returns null for identitySource with no marker at all', () => {
    expect(extractPersonaFromIdentitySource('你是小柴，一只热心的柴犬管家。')).toBeNull();
  });

  it('returns null for a malformed/hand-broken marker instead of throwing', () => {
    expect(() =>
      extractPersonaFromIdentitySource('<!--persona:v1:{not json}-->\nzh\nen'),
    ).not.toThrow();
    expect(extractPersonaFromIdentitySource('<!--persona:v1:{not json}-->\nzh\nen')).toBeNull();
    expect(extractPersonaFromIdentitySource('<!--persona:v1:{"style":"unknown"}-->\nzh\nen')).toBeNull();
  });

  it('requires a non-empty customCall when call is custom', () => {
    const compiled = '<!--persona:v1:{"style":"concise","proactivity":"proactive","call":"custom","customCall":""}-->\nzh\nen';
    expect(extractPersonaFromIdentitySource(compiled)).toBeNull();
  });

  it('removePersonaFromIdentitySource strips only the marked block', () => {
    const before = '开场白：你好呀。';
    const after = '额外规则：永远先确认预算。';
    const compiled = compilePersonaIntoIdentitySource(`${before}\n\n${after}`, BASE);
    const stripped = removePersonaFromIdentitySource(compiled);
    expect(stripped).not.toContain('<!--persona:v1:');
    expect(stripped).toContain(before);
    expect(stripped).toContain(after);
  });

  it('removePersonaFromIdentitySource is a no-op when there is no marker', () => {
    const plain = '你是本本，喜欢用列表说话。';
    expect(removePersonaFromIdentitySource(plain)).toBe(plain);
  });
});

/*
  分段管理:「调整性格」向导管 marker 段,设置页「背景设定」管其余正文。这一组
  钉的是那条边界 —— 两个入口各写各的,谁也不能整体覆盖谁。回归到这里等于回到
  「模板写进来的角色背景用户看不到也改不了」那个状态。
*/
describe('botPersona — 背景正文段与向导段共存', () => {
  const templateIdentity =
    '你是本本，项目管家。流程你来盯。\n\nYou are a persistent delivery steward in Cindy.';

  it('shows a template teammate its full background before the wizard ever ran', () => {
    expect(readBotBackground(templateIdentity)).toBe(templateIdentity);
    expect(extractPersonaBlockText(templateIdentity)).toBeNull();
  });

  it('hides the wizard block from the background editor', () => {
    const compiled = compilePersonaIntoIdentitySource(templateIdentity, BASE);
    expect(readBotBackground(compiled)).toBe(templateIdentity);
    expect(extractPersonaBlockText(compiled)).toContain('<!--persona:v1:');
  });

  it('rewrites only the background, leaving the wizard block byte-for-byte intact', () => {
    const compiled = compilePersonaIntoIdentitySource(templateIdentity, BASE);
    const block = extractPersonaBlockText(compiled);
    const rewritten = writeBotBackground(compiled, '你是本本，只说结论。');

    expect(readBotBackground(rewritten)).toBe('你是本本，只说结论。');
    expect(rewritten).not.toContain('项目管家');
    expect(extractPersonaBlockText(rewritten)).toBe(block);
    expect(extractPersonaFromIdentitySource(rewritten)).toEqual(BASE);
  });

  it('lets the wizard run after the background was hand-edited, without eating the prose', () => {
    const handEdited = writeBotBackground('', '你是阿橘，设计搭子。');
    const compiled = compilePersonaIntoIdentitySource(handEdited, BASE);
    expect(readBotBackground(compiled)).toBe('你是阿橘，设计搭子。');
    expect(extractPersonaFromIdentitySource(compiled)).toEqual(BASE);
  });

  it('keeps the background editable down to empty without destroying the personality', () => {
    const compiled = compilePersonaIntoIdentitySource(templateIdentity, BASE);
    const cleared = writeBotBackground(compiled, '   ');
    expect(readBotBackground(cleared)).toBe('');
    expect(extractPersonaFromIdentitySource(cleared)).toEqual(BASE);
  });

  it('is stable across repeated edits — the two segments never swap order', () => {
    let source = compilePersonaIntoIdentitySource(templateIdentity, BASE);
    for (let i = 0; i < 3; i += 1) {
      source = writeBotBackground(source, `第 ${i} 版背景。`);
      source = compilePersonaIntoIdentitySource(source, BASE);
    }
    expect(source.match(/<!--persona:v1:/g)).toHaveLength(1);
    expect(source.indexOf('第 2 版背景。')).toBeLessThan(source.indexOf('<!--persona:v1:'));
  });
});
