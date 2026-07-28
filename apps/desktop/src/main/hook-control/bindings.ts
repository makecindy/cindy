/**
 * hook-control/bindings.ts
 * ---------------------------------------------------------------------------
 * externalKey -> sessionId 映射存储(协议铁律「同 key 同 session」的落地)。
 *
 * 结构:
 * { [connectionId]: { [externalKey]: { sessionId, workingDir, authority, updatedAt } } }
 * —— 以 connectionId 为命名空间隔离, 两个 hook server 的同名 key 不会串台。
 * 持久化为 <userData>/hook-bindings.json(原子写), 跨 app 重启保持会话连续性。
 * 体量: 每 thread/issue 一条, 实际规模远小于消息量, JSON 文件足够;
 * 若未来需要清理策略再升级 localDb 表。
 *
 * workingDir + authority 记录**上次确认这条绑定可用时**的工作目录, 以及那次
 * 是凭什么放行的。dispatcher 靠这两个字段区分三件本来看起来一样的事:
 * 「用户在桌面端把对话移出了工作目录映射」(目录相对快照变了 -> 跟随, 并把
 * authority 记为 local-move)、「上一条消息已按本地移动放行过」(目录没再变且
 * authority=local-move -> 继续跟随, 否则跟随只生效一次)、「用户改动了工作
 * 目录映射」(目录没变且 authority=workspace -> 撤权, 丢绑定重建)。
 * 老文件没有这两个字段 = null/undefined, 判定按保守侧(见 resolveTarget)。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 上次放行这条绑定的依据:
 * - 'workspace': 目录当时落在工作目录映射(或内置对话根)内, 授权随映射走 ——
 *   映射被改/删且目录没动时即失效(撤权)。
 * - 'local-move': 用户在桌面端把对话移出了映射, 由这次**本地**移动授权 ——
 *   目录不在映射内也继续复用, 直到它再被移动(重新判定)或移回映射内。
 */
export type HookBindingAuthority = 'workspace' | 'local-move';

/** 一条绑定的完整视图(get 只要 sessionId 时用 get, 需要目录快照时用 getEntry)。 */
export interface HookBindingEntry {
  sessionId: string;
  /** 上次确认时会话的工作目录; null = 老数据未记录快照。 */
  workingDir: string | null;
  /** 上次放行的依据; null = 老数据未记录。 */
  authority: HookBindingAuthority | null;
}

export interface HookBindingStore {
  get(connectionId: string, externalKey: string): string | null;
  /** 含工作目录快照与授权来源的绑定视图; 不存在时 null。 */
  getEntry(connectionId: string, externalKey: string): HookBindingEntry | null;
  /** 整行覆盖写: 省略 workingDir / authority 等于把它们清空, 调用方应显式传。 */
  set(
    connectionId: string,
    externalKey: string,
    sessionId: string,
    workingDir?: string | null,
    authority?: HookBindingAuthority | null,
  ): void;
  /** 删除单条绑定(session 失效重建前清理)。 */
  remove(connectionId: string, externalKey: string): void;
}

interface BindingRow {
  sessionId: string;
  /** 见文件头: 上次确认时的工作目录快照; 缺省 = 老数据。 */
  workingDir?: string | null;
  /** 见文件头: 上次放行的依据; 缺省 = 老数据。 */
  authority?: HookBindingAuthority | null;
  updatedAt: number;
}

type BindingFile = Record<string, Record<string, BindingRow>>;

export function createHookBindingStore(deps: {
  filePath: string;
  log: { warn(msg: string): void };
}): HookBindingStore {
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

  return {
    get(connectionId, externalKey) {
      const row = readAll()[connectionId]?.[externalKey];
      return typeof row?.sessionId === 'string' ? row.sessionId : null;
    },
    getEntry(connectionId, externalKey) {
      const row = readAll()[connectionId]?.[externalKey];
      if (typeof row?.sessionId !== 'string') return null;
      return {
        sessionId: row.sessionId,
        workingDir: typeof row.workingDir === 'string' ? row.workingDir : null,
        // 未知字面量(手改文件 / 更早的实验值)按"没有授权记录"处理, fail closed
        authority:
          row.authority === 'workspace' || row.authority === 'local-move' ? row.authority : null,
      };
    },
    set(connectionId, externalKey, sessionId, workingDir, authority) {
      const data = readAll();
      (data[connectionId] ??= {})[externalKey] = {
        sessionId,
        ...(typeof workingDir === 'string' && workingDir.length > 0 ? { workingDir } : {}),
        ...(authority === 'workspace' || authority === 'local-move' ? { authority } : {}),
        updatedAt: Date.now(),
      };
      writeAll(data);
    },
    remove(connectionId, externalKey) {
      const data = readAll();
      if (data[connectionId]?.[externalKey]) {
        delete data[connectionId][externalKey];
        writeAll(data);
      }
    },
  };
}
