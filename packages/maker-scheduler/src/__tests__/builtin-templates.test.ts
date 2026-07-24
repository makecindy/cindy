import { describe, expect, it } from 'vitest';

import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from '../builtin-templates.js';
import { nextRun } from '../engine/cron.js';
import type { TemplateCapability } from '../types.js';

const CAPABILITY_VOCABULARY: TemplateCapability[] = ['worktree', 'pr', 'web', 'params'];

/**
 * 提取 prompt 里的 {{param}} 占位符集合。
 * 正则与运行时替换（engine/template.ts）完全一致：更宽松的写法（如 `{{ topic }}`）
 * 会测试通过但运行时不替换。
 */
function promptPlaceholders(prompt: string): Set<string> {
  const keys = new Set<string>();
  for (const match of prompt.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g)) {
    keys.add(match[1]);
  }
  return keys;
}

describe('BUILTIN_TEMPLATES', () => {
  it('has unique ids', () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template belongs to a declared category, with exactly 2 per category', () => {
    const categoryIds = new Set(TEMPLATE_CATEGORIES.map((c) => c.id));
    for (const template of BUILTIN_TEMPLATES) {
      expect(categoryIds.has(template.category), `${template.id} category`).toBe(true);
    }
    // desktop 模板网格是两列，每类超过 2 条会折行（2026-07-24 产品确认每类固定 2 条）。
    for (const category of TEMPLATE_CATEGORIES) {
      expect(
        BUILTIN_TEMPLATES.filter((t) => t.category === category.id).length,
        `category ${category.id} template count`,
      ).toBe(2);
    }
  });

  it('has non-empty name / description / prompt and a schedulable cron', () => {
    for (const template of BUILTIN_TEMPLATES) {
      expect(template.name.trim().length, `${template.id} name`).toBeGreaterThan(0);
      expect(template.description.trim().length, `${template.id} description`).toBeGreaterThan(0);
      expect(template.prompt?.trim().length ?? 0, `${template.id} prompt`).toBeGreaterThan(0);
      expect(template.cronExpr, `${template.id} cronExpr`).toBeTruthy();
      expect(template.timezone, `${template.id} timezone`).toBeTruthy();
      const from = Date.UTC(2026, 0, 1);
      const next = nextRun(template.cronExpr!, from, template.timezone!);
      expect(next, `${template.id} nextRun`).toBeGreaterThan(from);
    }
  });

  it('prompt placeholders and declared parameters stay in sync (both directions)', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const placeholders = promptPlaceholders(template.prompt ?? '');
      const paramKeys = new Set((template.parameters ?? []).map((p) => p.key));
      expect(placeholders, `${template.id} placeholders vs parameters`).toEqual(paramKeys);
    }
  });

  it('parameters have non-empty labels and unique keys', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const params = template.parameters ?? [];
      const keys = params.map((p) => p.key);
      expect(new Set(keys).size, `${template.id} parameter keys unique`).toBe(keys.length);
      for (const param of params) {
        expect(param.label.trim().length, `${template.id}.${param.key} label`).toBeGreaterThan(0);
      }
    }
  });

  it('capabilities stay within the vocabulary and mirror actual behavior flags', () => {
    for (const template of BUILTIN_TEMPLATES) {
      const capabilities = template.capabilities ?? [];
      expect(new Set(capabilities).size, `${template.id} capabilities unique`).toBe(
        capabilities.length,
      );
      for (const capability of capabilities) {
        expect(CAPABILITY_VOCABULARY, `${template.id} capability ${capability}`).toContain(
          capability,
        );
      }
      // chip 与真实行为字段联动，防止手工双写漂移：
      // 有参数 ⇔ 标 params；开 worktree ⇔ 标 worktree。
      expect(capabilities.includes('params'), `${template.id} params chip`).toBe(
        (template.parameters ?? []).length > 0,
      );
      expect(capabilities.includes('worktree'), `${template.id} worktree chip`).toBe(
        template.useWorktree === true,
      );
    }
  });
});
