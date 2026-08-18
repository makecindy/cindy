import { describe, expect, it } from 'vitest';

import {
  compilePersonaIntoIdentitySource,
  extractPersonaFromIdentitySource,
  removePersonaFromIdentitySource,
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
