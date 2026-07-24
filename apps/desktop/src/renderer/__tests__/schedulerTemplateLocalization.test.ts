import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from '@cindy/maker-scheduler/templates';

import enCommon from '../i18n/locales/en/common.json';
import zhCNCommon from '../i18n/locales/zh-CN/common.json';
import jaCommon from '../i18n/locales/ja/common.json';
import koCommon from '../i18n/locales/ko/common.json';

/**
 * 内置模板多语言同步测试。
 *
 * 包内 builtin-templates.ts 的中文是唯一正本，renderer 用
 * scheduler.builtinTemplates 覆盖展示文案。这组断言锁两件事：
 * 1. 四语言块结构完整——每个模板/分类/参数在每种语言都有非空文案；
 * 2. zh-CN 块与包正本逐字一致——防止"改包不改 JSON"或反向的静默漂移。
 */

interface ItemL10n {
  name: string;
  description: string;
  prompt: string;
  params?: Record<string, { label: string; placeholder?: string }>;
}

interface BuiltinTemplatesBlock {
  categories: Record<string, string>;
  items: Record<string, ItemL10n>;
}

interface SchedulerL10n {
  template: { capability: Record<string, string> };
  builtinTemplates: BuiltinTemplatesBlock;
}

const LOCALES: Record<string, SchedulerL10n> = {
  'zh-CN': (zhCNCommon as { scheduler: SchedulerL10n }).scheduler,
  en: (enCommon as { scheduler: SchedulerL10n }).scheduler,
  ja: (jaCommon as { scheduler: SchedulerL10n }).scheduler,
  ko: (koCommon as { scheduler: SchedulerL10n }).scheduler,
};

// 正则与运行时替换（maker-scheduler engine/template.ts）完全一致：更宽松的写法
// （如 `{{ topic }}`）会测试通过但运行时不替换。
function promptPlaceholders(prompt: string): string[] {
  return [...prompt.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g)].map((m) => m[1]).sort();
}

describe.each(Object.entries(LOCALES))('scheduler.builtinTemplates (%s)', (_locale, scheduler) => {
  const block = scheduler.builtinTemplates;

  it('covers every builtin template with non-empty copy, and has no orphan entries', () => {
    const builtinIds = BUILTIN_TEMPLATES.map((t) => t.id).sort();
    expect(Object.keys(block.items).sort()).toEqual(builtinIds);
    for (const template of BUILTIN_TEMPLATES) {
      const item = block.items[template.id];
      expect(item.name.trim().length, `${template.id} name`).toBeGreaterThan(0);
      expect(item.description.trim().length, `${template.id} description`).toBeGreaterThan(0);
      expect(item.prompt.trim().length, `${template.id} prompt`).toBeGreaterThan(0);
    }
  });

  it('covers every category with a non-empty name, and has no orphan categories', () => {
    const categoryIds = TEMPLATE_CATEGORIES.map((c) => c.id).sort();
    expect(Object.keys(block.categories).sort()).toEqual(categoryIds);
    for (const id of categoryIds) {
      expect(block.categories[id].trim().length, `category ${id}`).toBeGreaterThan(0);
    }
  });

  it('keeps prompt placeholders aligned with template parameters', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const item = block.items[template.id];
      const paramKeys = (template.parameters ?? []).map((p) => p.key).sort();
      expect(promptPlaceholders(item.prompt), `${template.id} placeholders`).toEqual(paramKeys);
      expect(Object.keys(item.params ?? {}).sort(), `${template.id} params block`).toEqual(
        paramKeys,
      );
      for (const key of paramKeys) {
        expect(item.params?.[key]?.label.trim().length, `${template.id}.${key} label`).toBeGreaterThan(0);
      }
    }
  });

  it('has a label for every capability used by builtin templates', () => {
    const used = new Set(BUILTIN_TEMPLATES.flatMap((t) => t.capabilities ?? []));
    for (const capability of used) {
      expect(
        scheduler.template.capability[capability]?.trim().length,
        `capability ${capability}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('zh-CN block mirrors the package source verbatim', () => {
  const block = LOCALES['zh-CN'].builtinTemplates;

  it('categories match', () => {
    for (const category of TEMPLATE_CATEGORIES) {
      expect(block.categories[category.id], `category ${category.id}`).toBe(category.name);
    }
  });

  it('template copy matches', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const item = block.items[template.id];
      expect(item.name, `${template.id} name`).toBe(template.name);
      expect(item.description, `${template.id} description`).toBe(template.description);
      expect(item.prompt, `${template.id} prompt`).toBe(template.prompt);
      for (const parameter of template.parameters ?? []) {
        expect(item.params?.[parameter.key]?.label, `${template.id}.${parameter.key} label`).toBe(
          parameter.label,
        );
        expect(
          item.params?.[parameter.key]?.placeholder,
          `${template.id}.${parameter.key} placeholder`,
        ).toBe(parameter.placeholder);
      }
    }
  });
});
