import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
// 用 namespace 静态 import 让 vite 真正把 utils.js inline 进 bundle。早先用
// createRequire + require('drizzle-orm/utils') 会在 bundle 里留下一条运行时
// require$1，而打包产物的 node_modules 不带整包 drizzle-orm（平时全靠 inline
// bundle），导致 packaged app 启动即 `Cannot find module 'drizzle-orm/utils'`。
// mapResultRow / orderSelectedFields 在 utils.js 里确实 export，但其 .d.ts 没声明
// (drizzle 内部 API)，所以这里走 namespace import + 显式 cast 拿回类型。
import * as drizzleUtils from 'drizzle-orm/utils';

import * as schema from '../schema.js';
import type { DbTransport } from './DbTransport.js';

type AnyObject = Record<PropertyKey, unknown>;
type SelectedField = { path: string[]; field: unknown };

const { mapResultRow, orderSelectedFields } = drizzleUtils as unknown as {
  mapResultRow: (
    fields: SelectedField[],
    row: unknown[],
    joinsNotNullableMap?: Record<string, boolean>,
  ) => unknown;
  orderSelectedFields: (fields: Record<string, unknown>) => SelectedField[];
};

const fakeSqliteClient = {
  prepare() {
    throw new Error('DbClient.drizzle proxy should execute through worker RPC');
  },
};

const terminalMethods = new Set(['all', 'get', 'run', 'values', 'execute', 'then', 'catch', 'finally']);

export function createDrizzleProxy(transport: DbTransport | (() => DbTransport)) {
  const db = drizzle(fakeSqliteClient as unknown as Database.Database, { schema });
  return wrapDrizzleObject(db, transport);
}

function wrapDrizzleObject<T>(target: T, transport: DbTransport | (() => DbTransport)): T {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;

  const proxy = new Proxy(target as AnyObject, {
    get(currentTarget, prop, receiver) {
      if (typeof prop === 'string' && terminalMethods.has(prop) && canBuildSql(currentTarget)) {
        return terminalExecutor(prop, currentTarget, transport);
      }

      const value = Reflect.get(currentTarget, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => {
        const result = value.apply(currentTarget, args);
        if (result === currentTarget) return receiver;
        return shouldWrap(result) ? wrapDrizzleObject(result, transport) : result;
      };
    },
  });

  return proxy as T;
}

function terminalExecutor(prop: string, builder: AnyObject, transport: DbTransport | (() => DbTransport)) {
  const getTransport = () => typeof transport === 'function' ? transport() : transport;
  if (prop === 'then') {
    return (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
      executeAll(builder, getTransport()).then(onfulfilled, onrejected);
  }
  if (prop === 'catch') {
    return (onrejected?: (reason: unknown) => unknown) =>
      executeAll(builder, getTransport()).catch(onrejected);
  }
  if (prop === 'finally') {
    return (onfinally?: () => void) => executeAll(builder, getTransport()).finally(onfinally);
  }
  if (prop === 'execute' || prop === 'all') {
    return () => executeAll(builder, getTransport());
  }
  if (prop === 'get') {
    return () => executeGet(builder, getTransport());
  }
  if (prop === 'values') {
    return () => executeValues(builder, getTransport());
  }
  return () => executeRun(builder, getTransport());
}

async function executeAll<T>(builder: AnyObject, transport: DbTransport): Promise<T[]> {
  if (hasSelectFields(builder)) {
    const { sql, params } = toSql(builder);
    const fieldsList = orderSelectedFields(builder.config.fields);
    const rawRows = await transport.send<unknown[][]>('rawAll', { sql, params });
    return rawRows.map((row) =>
      mapResultRow(fieldsList, row, normalizeJoins(builder.joinsNotNullableMap)) as T,
    );
  }
  // 写语句带 .returning()(#3496):此前该分支固定回 [],UPDATE ... RETURNING 在
  // 磁盘上成功、调用方却判未命中 —— compareAndClearSdkSessionId 的 CAS 清除被
  // 误判失败,invalid-resume 的一次性 fresh fallback 被拦成 UI 终态错误。
  // config.returning 是 drizzle 已排序的字段列表;RETURNING 语句是 reader
  // statement,worker 'rawAll'(stmt.raw().all())合法,按 select 同款映射回行。
  const returningFields = returningFieldsList(builder);
  const { sql, params } = toSql(builder);
  if (returningFields) {
    const rawRows = await transport.send<unknown[][]>('rawAll', { sql, params });
    return rawRows.map((row) => mapResultRow(returningFields, row, undefined) as T);
  }
  // 非 SELECT 且无 RETURNING:走 'run' op(worker 'query' 用 stmt.all(),
  // better-sqlite3 对纯写语句 .all() 会抛 "This statement does not return
  // data")。await db.insert(...) / db.update(...) 这种隐式 terminal 落到
  // executeAll,调用方忽略返回值。
  await transport.send('run', { sql, params });
  return [];
}

/** drizzle 写 builder 的 .returning() 字段列表(SelectedFieldsOrdered);无则 null。 */
function returningFieldsList(value: AnyObject): SelectedField[] | null {
  const config = value.config;
  if (!config || typeof config !== 'object') return null;
  const returning = (config as { returning?: unknown }).returning;
  return Array.isArray(returning) && returning.length > 0
    ? (returning as SelectedField[])
    : null;
}

async function executeGet<T>(builder: AnyObject, transport: DbTransport): Promise<T | undefined> {
  if (hasSelectFields(builder)) {
    const { sql, params } = toSql(builder);
    const fieldsList = orderSelectedFields(builder.config.fields);
    const row = await transport.send<unknown[] | undefined>('rawGet', { sql, params });
    return row
      ? (mapResultRow(fieldsList, row, normalizeJoins(builder.joinsNotNullableMap)) as T)
      : undefined;
  }
  // 写语句带 .returning() 的 .get():与 executeAll 同因(#3496),字段别名与列名
  // 不一致时 queryOne 的按列名对象会映射错,统一走 rawGet + mapResultRow。
  const returningFields = returningFieldsList(builder);
  const { sql, params } = toSql(builder);
  if (returningFields) {
    const row = await transport.send<unknown[] | undefined>('rawGet', { sql, params });
    return row ? (mapResultRow(returningFields, row, undefined) as T) : undefined;
  }
  return transport.send<T | undefined>('queryOne', { sql, params });
}

function normalizeJoins(value: unknown): Record<string, boolean> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, boolean>) : undefined;
}

async function executeValues(builder: AnyObject, transport: DbTransport): Promise<unknown[][]> {
  const { sql, params } = toSql(builder);
  return transport.send<unknown[][]>('rawAll', { sql, params });
}

async function executeRun(
  builder: AnyObject,
  transport: DbTransport,
): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
  const { sql, params } = toSql(builder);
  return transport.send('run', { sql, params });
}

function canBuildSql(value: AnyObject): boolean {
  return typeof value.toSQL === 'function';
}

function hasSelectFields(value: AnyObject): value is AnyObject & {
  config: { fields: Record<string, unknown> };
} {
  return (
    typeof value.config === 'object' &&
    value.config !== null &&
    typeof (value.config as { fields?: unknown }).fields === 'object'
  );
}

function shouldWrap(value: unknown): boolean {
  return !!value && (typeof value === 'object' || typeof value === 'function');
}

function toSql(builder: AnyObject): { sql: string; params: unknown[] } {
  const built = (builder.toSQL as () => { sql: string; params?: unknown[] })();
  return { sql: built.sql, params: built.params ?? [] };
}
