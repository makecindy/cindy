import { describe, expect, it } from 'vitest';

import { ghostPublishedModelText, parseGhostModelsNeeds, parseGhostPublishedModels } from '../pluginModels.js';

const route = { id: 'auto', name: 'Auto', target: { type: 'route' } };

// Rule: a plugin's list reaches the model picker only after this parser, so bad input must not
// get through, and a type this Host cannot run must not hide the models it can.
describe('parseGhostPublishedModels', () => {
  it('keeps a valid list and only the known fields', () => {
    const parsed = parseGhostPublishedModels({ models: [{ ...route, script: 'x', locales: { 'zh-CN': { name: '自动' } } }] }, ['route']);
    expect(parsed).toEqual({
      ok: true,
      skipped: [],
      models: [{ id: 'auto', name: 'Auto', locales: { 'zh-CN': { name: '自动' } }, target: { type: 'route' } }],
    });
  });

  it('skips a target this Host or manifest cannot run and keeps the rest', () => {
    const endpoint = { id: 'mine', name: 'Mine', target: { type: 'endpoint' } };
    expect(parseGhostPublishedModels({ models: [endpoint, route] }, ['route', 'endpoint'])).toMatchObject({
      ok: true, skipped: ['mine'], models: [{ id: 'auto' }],
    });
    expect(parseGhostPublishedModels({ models: [route] }, ['endpoint'])).toMatchObject({ ok: true, skipped: ['auto'], models: [] });
  });

  it.each([
    ['not a list', { models: 'auto' }],
    ['too many', { models: Array.from({ length: 17 }, (_, i) => ({ ...route, id: `m${i}` })) }],
    ['bad id', { models: [{ ...route, id: '../x' }] }],
    ['duplicate id', { models: [route, route] }],
    ['no name', { models: [{ id: 'auto', target: { type: 'route' } }] }],
    ['long name', { models: [{ ...route, name: 'x'.repeat(65) }] }],
    ['no target', { models: [{ id: 'auto', name: 'Auto' }] }],
    ['bad locale text', { models: [{ ...route, locales: { en: { name: 1 } } }] }],
  ])('rejects the whole list: %s', (_case, raw) => {
    expect(parseGhostPublishedModels(raw, ['route']).ok).toBe(false);
  });
});

describe('ghostPublishedModelText', () => {
  const model = { id: 'auto', name: 'Auto', description: 'Default', target: { type: 'route' as const },
    locales: { 'zh-CN': { name: '自动' }, ja: { name: '自動', description: '説明' } } };

  it('prefers the exact locale, then the language, then the default', () => {
    expect(ghostPublishedModelText(model, 'zh-CN')).toEqual({ name: '自动', description: 'Default' });
    expect(ghostPublishedModelText(model, 'zh-TW')).toEqual({ name: '自动', description: 'Default' });
    expect(ghostPublishedModelText(model, 'ja')).toEqual({ name: '自動', description: '説明' });
    expect(ghostPublishedModelText(model, 'fr')).toEqual({ name: 'Auto', description: 'Default' });
  });
});

describe('parseGhostModelsNeeds', () => {
  it('accepts unique type names and rejects anything else', () => {
    expect(parseGhostModelsNeeds({ types: ['route', 'endpoint'] })).toEqual({ types: ['route', 'endpoint'] });
    for (const raw of [{ types: [] }, { types: ['route', 'route'] }, { types: ['Bad Type'] }, 'route']) {
      expect(parseGhostModelsNeeds(raw)).toBeNull();
    }
  });
});
