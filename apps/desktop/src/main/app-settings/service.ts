import { z } from 'zod';

export interface AppSettingsSection {
  id: string;
  title: string;
  description: string;
  effective: string;
  schema: z.ZodType<Record<string, unknown>>;
  read(): unknown | Promise<unknown>;
  update(patch: Record<string, unknown>): unknown | Promise<unknown>;
  reset?(): unknown | Promise<unknown>;
}

/** Explicit setting sections, not arbitrary IPC or file access. Adapters own side effects. */
export function createAppSettingsService(sections: readonly AppSettingsSection[]) {
  const byId = new Map(sections.map(section => [section.id, section]));
  if (byId.size !== sections.length) throw new Error('Duplicate settings section');
  return async (input: { operation: 'list' | 'get' | 'update' | 'reset'; section?: string;
    query?: string; patch?: Record<string, unknown> }, assertCurrent: () => Promise<void>) => {
    await assertCurrent();
    if (input.operation === 'list') {
      const query = input.query?.trim().toLowerCase();
      return { scope: 'local', sections: sections.filter(section => !query ||
        `${section.id} ${section.title} ${section.description}`.toLowerCase().includes(query))
        .map(({ id, title, description, effective, reset }) => ({ id, title, description, effective,
          operations: ['get', 'update', ...(reset ? ['reset'] : [])] })) };
    }
    const section = byId.get(input.section ?? '');
    if (!section) return { ok: false, errorCode: 'UNKNOWN_SETTINGS_SECTION', message: '请先用 list_app_settings 查询分类。' };
    let result: unknown;
    if (input.operation === 'update') {
      const parsed = section.schema.safeParse(input.patch);
      if (!parsed.success || !Object.keys(parsed.data).length) return {
        ok: false, errorCode: 'INVALID_ARGS', message: '请按 schema 提交至少一个需要修改的字段。',
        schema: z.toJSONSchema(section.schema),
      };
      await assertCurrent();
      result = await section.update(parsed.data);
    } else if (input.operation === 'reset') {
      if (!section.reset) return { ok: false, errorCode: 'RESET_NOT_SUPPORTED', message: '此分类不提供整组恢复，请按字段修改。' };
      await assertCurrent();
      result = await section.reset();
    }
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return {
      ok: false, errorCode: 'SETTINGS_NOT_APPLIED', message: '设置尚未完成，请按返回状态处理后重新读取。', result,
    };
    await assertCurrent();
    const state = await section.read();
    await assertCurrent();
    return { ...(result === undefined ? {} : { result }), section: section.id, scope: 'local', effective: section.effective, state,
      schema: z.toJSONSchema(section.schema) };
  };
}
