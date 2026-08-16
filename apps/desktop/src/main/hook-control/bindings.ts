/**
 * hook-control/bindings.ts
 * ---------------------------------------------------------------------------
 * externalKey -> sessionId 映射存储(协议铁律「同 key 同 session」的落地)。
 *
 * 结构: { [connectionId]: { [externalKey]: { sessionId, updatedAt } } }
 * —— 以 connectionId 为命名空间隔离, 两个 hook server 的同名 key 不会串台。
 * 持久化为 <userData>/hook-bindings.json(原子写), 跨 app 重启保持会话连续性。
 * 体量: 每 thread/issue 一条, 实际规模远小于消息量, JSON 文件足够;
 * 若未来需要清理策略再升级 localDb 表。
 *
 * **这里刻意不存任何授权状态。** 一条绑定能否继续用, 每次都由 dispatcher 现场
 * 按工作目录映射判定(见 resolveTarget) —— 映射是「远端能驱动哪些本地目录」的
 * 唯一边界, 判定无状态, 也就没有过期凭据、在途窗口、回滚这些东西可言。
 * 早期版本曾在这里存 workingDir 快照 + authority 以支持「对话被移出映射后继续
 * 跟随」, 那套例外要求绑定文件与会话库跨两次无事务的写保持一致, 边界条件按指数
 * 增长(PR #653 / #669 十轮 review 的全部发现都出自那块); 现改为移出映射即断开
 * 并向渠道说明, 这两个字段随之删除。老文件里的残留字段读取时忽略, 下次写入自然
 * 清掉。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface HookBindingStore {
  get(connectionId: string, externalKey: string): string | null;
  /**
   * 整行覆盖写。只在绑定真正变化时调用(新建会话、legacy 命名空间迁移、接管)——
   * 常规复用不写, 所以 updatedAt 是"这条绑定上次被改写"的时间, **不是**"上次被
   * 用到"的时间(PR #733 review 指出)。
   */
  set(connectionId: string, externalKey: string, sessionId: string): void;
  /** 删除单条绑定(session 失效重建前清理)。 */
  remove(connectionId: string, externalKey: string): void;
}

export interface HookBindingSnapshot {
  connectionId: string;
  externalKey: string;
  sessionId: string;
  updatedAt: number;
}

export interface HookBindingMigrationStore extends HookBindingStore {
  /** Stable snapshot used by Bot migration planning and rollback. */
  list(): HookBindingSnapshot[];
  /** Apply a batch delete with one atomic file replacement. */
  removeMany(rows: readonly HookBindingSnapshot[]): void;
  /** Restore an earlier batch without replacing bindings created afterwards. */
  restoreMany(rows: readonly HookBindingSnapshot[]): {
    restored: number;
    skippedConflicts: number;
  };
}

interface BindingRow {
  sessionId: string;
  updatedAt: number;
}

type BindingFile = Record<string, Record<string, BindingRow>>;

export function createHookBindingStore(deps: {
  filePath: string;
  log: { warn(msg: string): void };
}): HookBindingMigrationStore {
  const { filePath, log } = deps;

  function readAll(): BindingFile {
    try {
      if (!fs.existsSync(filePath)) return {};
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw as BindingFile;
    } catch (err) {
      log.warn(`read hook-bindings failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  function writeAll(data: BindingFile): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  /**
   * 取出可写的命名空间。readAll 只校验了顶层是对象, 二层没校验 —— 文件被手工
   * 编辑或半截写坏成 `{"conn-1": "oops"}` 时, `??=` 不会替换字符串, 随后给它赋
   * 属性在严格模式(ESM)下抛 TypeError, 绑定就再也落不了盘。坏数据直接换成空
   * 命名空间: 大不了重开一次会话, 不能卡死写入(PR #733 review 指出)。
   */
  function namespaceFor(data: BindingFile, connectionId: string): Record<string, BindingRow> {
    const ns: unknown = data[connectionId];
    // 一律搬进 null 原型对象再写: externalKey 是渠道来的不可信输入, 直接拿它当
    // 动态键写进普通对象时, `__proto__` 这类键会改到原型上去(原型污染), 结构和
    // 落盘的 JSON 都会变得不可预期。同目录 store.ts 的 EMPTY_ACCOUNTS 同款做法
    // (PR #733 review 指出)。
    const fresh: Record<string, BindingRow> = Object.create(null) as Record<string, BindingRow>;
    if (ns && typeof ns === 'object' && !Array.isArray(ns)) {
      for (const [key, row] of Object.entries(ns as Record<string, BindingRow>)) {
        fresh[key] = row;
      }
    }
    data[connectionId] = fresh;
    return fresh;
  }

  return {
    get(connectionId, externalKey) {
      const ns: unknown = readAll()[connectionId];
      if (!ns || typeof ns !== 'object' || Array.isArray(ns)) return null;
      const row = (ns as Record<string, BindingRow | undefined>)[externalKey];
      return typeof row?.sessionId === 'string' ? row.sessionId : null;
    },
    set(connectionId, externalKey, sessionId) {
      const data = readAll();
      namespaceFor(data, connectionId)[externalKey] = { sessionId, updatedAt: Date.now() };
      writeAll(data);
    },
    remove(connectionId, externalKey) {
      const data = readAll();
      const ns: unknown = data[connectionId];
      if (!ns || typeof ns !== 'object' || Array.isArray(ns)) return;
      if (!Object.hasOwn(ns, externalKey)) return;
      delete (ns as Record<string, BindingRow>)[externalKey];
      writeAll(data);
    },
    list() {
      const rows: HookBindingSnapshot[] = [];
      for (const [connectionId, rawNamespace] of Object.entries(readAll())) {
        if (!rawNamespace || typeof rawNamespace !== 'object' || Array.isArray(rawNamespace)) {
          continue;
        }
        for (const [externalKey, rawRow] of Object.entries(rawNamespace)) {
          if (
            !rawRow
            || typeof rawRow !== 'object'
            || typeof rawRow.sessionId !== 'string'
            || typeof rawRow.updatedAt !== 'number'
          ) {
            continue;
          }
          rows.push({
            connectionId,
            externalKey,
            sessionId: rawRow.sessionId,
            updatedAt: rawRow.updatedAt,
          });
        }
      }
      return rows.sort((a, b) =>
        a.connectionId.localeCompare(b.connectionId)
        || a.externalKey.localeCompare(b.externalKey),
      );
    },
    removeMany(rows) {
      if (rows.length === 0) return;
      const data = readAll();
      let changed = false;
      for (const row of rows) {
        const ns: unknown = data[row.connectionId];
        if (!ns || typeof ns !== 'object' || Array.isArray(ns)) continue;
        const current = (ns as Record<string, BindingRow | undefined>)[row.externalKey];
        if (!current || current.sessionId !== row.sessionId) continue;
        delete (ns as Record<string, BindingRow>)[row.externalKey];
        changed = true;
      }
      if (changed) writeAll(data);
    },
    restoreMany(rows) {
      if (rows.length === 0) return { restored: 0, skippedConflicts: 0 };
      const data = readAll();
      let changed = false;
      let restored = 0;
      let skippedConflicts = 0;
      for (const row of rows) {
        const ns = namespaceFor(data, row.connectionId);
        const current = ns[row.externalKey];
        if (current?.sessionId === row.sessionId && current.updatedAt === row.updatedAt) continue;
        // A newer task may claim the lane after migration removed the old
        // binding. Rollback must preserve that newer claim instead of
        // resurrecting the stale task over it.
        if (current) {
          skippedConflicts += 1;
          continue;
        }
        ns[row.externalKey] = { sessionId: row.sessionId, updatedAt: row.updatedAt };
        restored += 1;
        changed = true;
      }
      if (changed) writeAll(data);
      return { restored, skippedConflicts };
    },
  };
}
