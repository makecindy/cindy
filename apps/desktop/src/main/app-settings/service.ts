import { z } from 'zod';

export interface AppSettingsSection {
  id: string;
  title: string;
  description: string;
  effective: string;
  schema: z.ZodType<Record<string, unknown>>;
  read(): unknown | Promise<unknown>;
  update(patch: Record<string, unknown>, guard?: AppSettingsWriteGuard): unknown | Promise<unknown>;
  reset?(guard?: AppSettingsWriteGuard): unknown | Promise<unknown>;
}

/**
 * A save based on an earlier read. The section checks it where the value is persisted, with no
 * wait before its first write, so a save that another window or controller has overtaken fails
 * instead of overwriting the newer value.
 */
export interface AppSettingsWriteGuard {
  /** Throws if the setting changed since that read. */
  assertUnchanged(): void;
  /** The values that read returned, for a section the app window persists and compares itself. */
  readonly expected?: Readonly<Record<string, unknown>>;
}

const isNotApplied = (result: unknown): boolean => !!result && typeof result === 'object' && 'ok' in result && result.ok === false;

/** Explicit setting sections, not arbitrary IPC or file access. Adapters own side effects. */
export function createAppSettingsService(sections: readonly AppSettingsSection[]) {
  const byId = new Map(sections.map(section => [section.id, section]));
  if (byId.size !== sections.length) throw new Error('Duplicate settings section');
  return async (input: { operation: 'list' | 'get' | 'update' | 'reset'; section?: string;
    query?: string; patch?: Record<string, unknown> }, assertCurrent: () => Promise<void>,
  write: { guard?: AppSettingsWriteGuard; onPersisted?(): void } = {}) => {
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
      result = await section.update(parsed.data, write.guard);
    } else if (input.operation === 'reset') {
      if (!section.reset) return { ok: false, errorCode: 'RESET_NOT_SUPPORTED', message: '此分类不提供整组恢复，请按字段修改。' };
      await assertCurrent();
      result = await section.reset(write.guard);
    }
    // Later checks and the read below can still fail; the caller learns the value was saved.
    if ((input.operation === 'update' || input.operation === 'reset') && !isNotApplied(result)) write.onPersisted?.();
    await assertCurrent();
    if (isNotApplied(result)) {
      const failure = result as { errorCode?: unknown; message?: unknown };
      return {
        ok: false,
        errorCode: typeof failure.errorCode === 'string' ? failure.errorCode : 'SETTINGS_NOT_APPLIED',
        message: typeof failure.message === 'string' ? failure.message : '设置尚未完成，请按返回状态处理后重新读取。',
        result,
      };
    }
    const state = await section.read();
    await assertCurrent();
    return { ...(result === undefined ? {} : { result }), section: section.id, scope: 'local', effective: section.effective, state,
      schema: z.toJSONSchema(section.schema) };
  };
}
