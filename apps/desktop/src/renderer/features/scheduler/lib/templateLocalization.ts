import type { i18n as I18nInstance } from 'i18next';
import type { ScheduleTemplate, TemplateCategory } from '@cindy/maker-scheduler';

/**
 * 内置模板本地化：包内 `builtin-templates.ts` 的中文是唯一正本，各语言文案
 * 存放在 locale common.json 的 `scheduler.builtinTemplates` 块，这里做覆盖。
 *
 * 不用 t() 而用 getResource 取原始字符串：模板 prompt 里的 `{{topic}}` 是
 * 调度器自己的参数占位符，走 t() 会被 i18next 当插值变量吃掉。
 * 回落链与 fallbackLng 一致：当前语言 → en → 包正本。
 */
function rawResource(i18n: I18nInstance, key: string): string | undefined {
  for (const lng of [i18n.language, 'en']) {
    const value: unknown = i18n.getResource(lng, 'common', key);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** builtin 模板按当前语言覆盖 name/description/prompt/参数文案；其它来源原样返回。 */
export function localizeTemplate(i18n: I18nInstance, template: ScheduleTemplate): ScheduleTemplate {
  if (template.source !== 'builtin') return template;
  const base = `scheduler.builtinTemplates.items.${template.id}`;
  const localized: ScheduleTemplate = {
    ...template,
    name: rawResource(i18n, `${base}.name`) ?? template.name,
    description: rawResource(i18n, `${base}.description`) ?? template.description,
  };
  const prompt = rawResource(i18n, `${base}.prompt`);
  if (prompt !== undefined && template.prompt !== undefined) localized.prompt = prompt;
  if (template.parameters?.length) {
    localized.parameters = template.parameters.map((parameter) => ({
      ...parameter,
      label: rawResource(i18n, `${base}.params.${parameter.key}.label`) ?? parameter.label,
      placeholder:
        rawResource(i18n, `${base}.params.${parameter.key}.placeholder`) ?? parameter.placeholder,
    }));
  }
  return localized;
}

/** 分类名按当前语言覆盖，缺译回落包正本。 */
export function localizeTemplateCategory(
  i18n: I18nInstance,
  category: TemplateCategory,
): TemplateCategory {
  const name = rawResource(i18n, `scheduler.builtinTemplates.categories.${category.id}`);
  return name ? { ...category, name } : category;
}
