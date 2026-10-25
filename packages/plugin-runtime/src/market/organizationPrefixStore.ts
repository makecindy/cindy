/**
 * 记住某个组织在插件市场登记的插件前缀。
 *
 * 前缀只能从服务端市场列表响应拿到，本地推不出来。离线、从未打开过市场页、
 * 读盘失败时，调用方必须能区分三种结果，绝不能互相折叠：
 * - `known`：确认读到了该组织的条目。`pluginPrefix` 为 `null` 表示该组织已登录
 *   但尚未登记前缀——这是确定事实，不是缺失。
 * - `absent`：确认没有该组织的条目（文件不存在，或文件里没有这个键）。
 * - `unavailable`：读盘失败、JSON 解析失败、或存量值不合法。
 *
 * 尤其不能把 `unavailable` 当成 `absent`：上层对「没有条目」和「读不出来」的
 * fail-closed 处置不同。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_PREFIX_PATTERN } from '@cindy/plugin-protocol';

const STORE_VERSION = 1 as const;

export type OrganizationPrefixLookup =
  | { kind: 'known'; pluginPrefix: string | null }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

export interface OrganizationPrefixStore {
  lookup(orgId: string): OrganizationPrefixLookup;
  remember(orgId: string, pluginPrefix: string | null): void;
}

interface OrganizationPrefixDocument {
  version: typeof STORE_VERSION;
  organizations: Record<string, unknown>;
}

/**
 * `corrupt` 与 `unreadable` 对 `lookup` 是同一个答案（都是 `unavailable`），
 * 但对 `remember` 不是：
 * - `corrupt`（坏 JSON / 版本不认 / 结构不对）：内容没救，但盘是好的。这个文件是
 *   **可重建的缓存**，下次市场列表成功就能重新填，所以要覆盖重建。若在这里也拒写，
 *   一次损坏就会让所有组织插件的特权被永久拒绝，唯一恢复路径是用户手动删文件。
 * - `unreadable`（EACCES / EIO 等）：盘本身有问题，写大概也会失败，
 *   不要拿一份空文档去覆盖可能还完好的内容。
 */
type DocumentRead =
  | { kind: 'empty' }
  | { kind: 'ok'; document: OrganizationPrefixDocument }
  | { kind: 'corrupt' }
  | { kind: 'unreadable' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidPluginPrefix(value: string | null): boolean {
  return value === null || PLUGIN_PREFIX_PATTERN.test(value);
}

function parseDocument(text: string): OrganizationPrefixDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== STORE_VERSION) return null;
  if (!isPlainObject(parsed.organizations)) return null;
  return { version: STORE_VERSION, organizations: parsed.organizations };
}

function parseEntry(value: unknown): { pluginPrefix: string | null } | null {
  if (!isPlainObject(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, 'pluginPrefix')) return null;
  const pluginPrefix = value.pluginPrefix;
  if (pluginPrefix === null) return { pluginPrefix: null };
  if (typeof pluginPrefix === 'string' && PLUGIN_PREFIX_PATTERN.test(pluginPrefix)) {
    return { pluginPrefix };
  }
  return null;
}

function writeDocumentAtomically(filePath: string, document: OrganizationPrefixDocument): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // 临时文件可能尚未创建，或 rename 已成功后不再存在。
    }
    throw error;
  }
}

export function createOrganizationPrefixStore(filePath: string): OrganizationPrefixStore {
  const readDocument = (): DocumentRead => {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' };
      return { kind: 'unreadable' };
    }
    const document = parseDocument(text);
    if (!document) return { kind: 'corrupt' };
    return { kind: 'ok', document };
  };

  return {
    lookup(orgId: string): OrganizationPrefixLookup {
      // 空 orgId 不是一个组织。调用方本该在身份为个人时压根不查，
      // 但若哪天有人写成 `lookup(orgId ?? '')`,不能让它命中一条 `""` 键的条目
      // 而拿到"有组织"的结论——那是与 installed=false 同类的 fail-open。
      if (orgId.trim() === '') return { kind: 'unavailable' };
      const read = readDocument();
      if (read.kind === 'empty') return { kind: 'absent' };
      if (read.kind === 'corrupt' || read.kind === 'unreadable') return { kind: 'unavailable' };
      if (!Object.prototype.hasOwnProperty.call(read.document.organizations, orgId)) {
        return { kind: 'absent' };
      }
      const entry = parseEntry(read.document.organizations[orgId]);
      if (!entry) return { kind: 'unavailable' };
      return { kind: 'known', pluginPrefix: entry.pluginPrefix };
    },

    remember(orgId: string, pluginPrefix: string | null): void {
      if (orgId.trim() === '') return;
      if (!isValidPluginPrefix(pluginPrefix)) return;
      const read = readDocument();
      // 盘读不了就别写(可能把还完好的内容盖掉);内容坏了要覆盖重建,
      // 否则一次损坏 = 永久拒绝，见 DocumentRead 的注释。
      if (read.kind === 'unreadable') return;
      const organizations = read.kind === 'ok' ? { ...read.document.organizations } : {};
      organizations[orgId] = { pluginPrefix };
      writeDocumentAtomically(filePath, { version: STORE_VERSION, organizations });
    },
  };
}
