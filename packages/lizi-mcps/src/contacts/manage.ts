/**
 * contacts/manage.ts — manage 类工具(破坏性/组织性, 宿主授权语义):
 * contacts_delete / contacts_merge / 分组 CRUD 与成员管理。
 *
 * 边界: 这些操作只应在用户明确指示时执行(规则挂在 rules 字段)。真正的权限
 * 拦截仍由宿主的工具权限确认机制承担 — rules 是行为引导, 不是安全边界。
 */

import { z } from 'zod';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  findEmploymentRelation,
  importContacts,
  parseVCards,
  serializeVCards,
  type ContactProfile,
  type MakerContactsStore,
  type SystemContactWriteItem,
  type SystemContactWriteResult,
} from '@cindy/maker-core';

import { withContacts } from './_shared.js';
import type { ContactsMcpDeps } from '../types.js';
import type { ContactsToolRegistry } from '../cindy_contactsToolRegistry.js';

const MANAGE_RULES =
  'manage 类操作(删除/合并/分组管理)只在用户明确指示时执行, 不要自主决定。' +
  '删除不可恢复; 合并前先用 contacts_get 确认两份档案确实是同一人。';

/** 全量分页拉取 id 列表 — listContacts 单页硬 cap 200, 导出路径必须翻页取齐, 否则静默截断成残缺备份 */
function listAllContactIds(
  store: MakerContactsStore,
  opts: { groupId?: string; status?: 'confirmed' },
): string[] {
  const ids: string[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = store.listContacts({ ...opts, limit: 200, offset });
    ids.push(...page.map((c) => c.id));
    if (page.length < 200) break;
  }
  return ids;
}

export function registerContactsDeleteTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_delete',
    category: 'manage',
    description: '删除一份档案(级联删除其身份/事件/分组关系, 不可恢复)。仅在用户明确要求删除时使用。',
    rules: [MANAGE_RULES],
    inputShape: {
      id: z.string().min(1),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        store.deleteContact(args.id as string);
        return { deleted: true };
      }, { mutates: true }),
  });
}

export function registerContactsMergeTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_merge',
    category: 'manage',
    description:
      '把 source 档案并入 target 后删除 source: 身份/事件/分组整体迁移, 别名取并集, 叙事拼接。' +
      '处理重复建档(如 IDENTITY_CONFLICT 提示同一人有两份档案)时用; 合并前先 contacts_get 双方确认同人。',
    rules: [MANAGE_RULES],
    inputShape: {
      target_id: z.string().min(1).describe('保留的档案'),
      source_id: z.string().min(1).describe('被并入并删除的档案'),
    },
    handler: async (args) =>
      withContacts(deps, (store) => store.merge(args.target_id as string, args.source_id as string), { mutates: true }),
  });
}

export function registerContactsFindDuplicatesTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_find_duplicates',
    category: 'manage',
    description:
      '全库扫描疑似重复档案对(同类型且名字/别名相似)。用户要求整理通讯录、或怀疑有重复时调用; ' +
      '对每一对先 contacts_get 双方确认同人, 再 contacts_merge(保留信息全的那份为 target)。',
    rules: [MANAGE_RULES],
    inputShape: {
      limit: z.number().int().min(1).max(200).optional().describe('默认 50 对'),
    },
    handler: async (args) =>
      withContacts(deps, (store) => store.findDuplicatePairs(args.limit as number | undefined)),
  });
}

export function registerContactsImportSystemTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  // host 没注入系统通讯录读取能力(非 macOS)时不注册 — vCard 导入走设置页 UI
  if (!deps.readSystemContacts) return;
  registry.register({
    name: 'contacts_import_system',
    category: 'manage',
    description:
      '从 macOS 系统通讯录批量导入(只读拉取, 不改系统数据)。管道自动归并(代码保证): ' +
      '邮箱/电话与既有档案相同的自动并入; 名字相似的进 needsReview(返回清单, 逐个确认后手动处理); ' +
      '全新的创建(source=import, 带 apple-contacts 锚点身份)并可归入指定分组。' +
      '首次调用会触发系统授权弹窗; 用户拒绝过则返回 PERMISSION_DENIED(引导去系统设置开)。' +
      '先用 dry_run:true 看规模再真正导入; 大量无关联系人时用 require_email / name_contains 收窄。',
    rules: [MANAGE_RULES],
    inputShape: {
      dry_run: z.boolean().optional().describe('true = 只统计不写入(建议先跑一次)'),
      require_email: z.boolean().optional().describe('只导入有邮箱的联系人'),
      name_contains: z.string().max(50).optional().describe('姓名包含此子串才导入'),
      group: z.string().max(60).optional().describe('导入后归入的分组名(不存在则创建)'),
    },
    handler: async (args) =>
      withContacts(deps, async (store) => {
        let records = await deps.readSystemContacts!();
        if (args.require_email) records = records.filter((r) => r.emails.length > 0);
        if (args.name_contains) {
          const q = (args.name_contains as string).toLowerCase();
          records = records.filter((r) => r.displayName.toLowerCase().includes(q));
        }
        if (args.dry_run) {
          return {
            dryRun: true,
            total: records.length,
            withEmail: records.filter((r) => r.emails.length > 0).length,
            withOrg: records.filter((r) => r.org).length,
            sample: records.slice(0, 10).map((r) => r.displayName),
          };
        }
        let groupId: string | undefined;
        if (args.group) {
          const name = (args.group as string).trim();
          const existing = store.listGroups().find((g) => g.name === name);
          groupId = existing ? existing.id : store.createGroup(name).id;
        }
        return importContacts(store, records, { ...(groupId ? { groupId } : {}) });
      }, { mutates: true }),
  });
}

export function registerContactsVcfTools(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_import_vcf',
    category: 'manage',
    description:
      '从 .vcf(vCard)文件批量导入(跨平台通道, 系统通讯录之外的第二来源)。' +
      '管道与 contacts_import_system 相同: 邮箱/电话相同自动并入, 名字相似进 needsReview, 全新创建。' +
      'path 必须是本机绝对路径; 先 dry_run:true 看规模。',
    rules: [MANAGE_RULES],
    inputShape: {
      path: z.string().min(1).describe('.vcf 文件绝对路径'),
      dry_run: z.boolean().optional(),
      group: z.string().max(60).optional().describe('导入后归入的分组名(不存在则创建)'),
    },
    handler: async (args) =>
      withContacts(deps, async (store) => {
        const p = args.path as string;
        if (!path.isAbsolute(p)) throw new Error('contacts:invalid-params path must be absolute');
        const stat = await fs.stat(p).catch(() => null);
        if (!stat?.isFile()) throw new Error(`contacts:invalid-params not a file: ${p}`);
        if (stat.size > 32 * 1024 * 1024) throw new Error('contacts:invalid-params vcf too large (> 32MB)');
        const records = parseVCards(await fs.readFile(p, 'utf8'));
        if (args.dry_run) {
          return {
            dryRun: true,
            total: records.length,
            withEmail: records.filter((r) => r.emails.length > 0).length,
            sample: records.slice(0, 10).map((r) => r.displayName),
          };
        }
        let groupId: string | undefined;
        if (args.group) {
          const name = (args.group as string).trim();
          const existing = store.listGroups().find((g) => g.name === name);
          groupId = existing ? existing.id : store.createGroup(name).id;
        }
        return importContacts(store, records, { ...(groupId ? { groupId } : {}) });
      }, { mutates: true }),
  });

  registry.register({
    name: 'contacts_export_vcf',
    // 带 path 时会写本机文件, 按 manage 语义走(渐进发现下 read 类会被当"无副作用"随意调)
    category: 'manage',
    description:
      '把通讯录导出为 vCard 3.0(备份/迁移/给系统通讯录或其它 App 用)。' +
      '只导出结构化公开字段(姓名/邮箱/电话/组织与职位/一行简介/分组), 关系叙事与 agent 指令永不出库。' +
      '范围: ids > group(分组名) > 全部(默认只导 confirmed, ids/分组路径同样默认排除 pending, include_pending:true 才包含)。' +
      '给 path(绝对路径)则写文件并返回统计 — 目标已存在时拒绝, 需 overwrite:true 显式覆盖; ' +
      '不给 path 则直接返回 vcf 文本(条目多时建议写文件)。',
    rules: [MANAGE_RULES],
    inputShape: {
      ids: z.array(z.string().min(1)).max(500).optional().describe('指定档案 id 列表'),
      group: z.string().max(60).optional().describe('按分组名导出'),
      include_pending: z.boolean().optional().describe('是否包含待确认条目, 默认 false'),
      path: z.string().optional().describe('写出的 .vcf 绝对路径(可选)'),
      overwrite: z.boolean().optional().describe('path 已存在时是否覆盖, 默认 false(拒绝)'),
    },
    handler: async (args) =>
      withContacts(deps, async (store) => {
        const statusOpt = args.include_pending ? {} : { status: 'confirmed' as const };
        let idList: string[];
        if (args.ids) {
          // 同 export_system: 显式 id 列表去重, 防同一档案重复出卡
          idList = [...new Set(args.ids as string[])];
        } else if (args.group) {
          const g = store.listGroups().find((x) => x.name === (args.group as string).trim());
          if (!g) throw new Error(`contacts:not-found group not found: ${args.group}`);
          idList = listAllContactIds(store, { groupId: g.id, ...statusOpt });
        } else {
          idList = listAllContactIds(store, statusOpt);
        }
        // ids 路径不经 statusOpt 查询过滤, 这里统一按状态兜底 — 否则显式 id 列表会把
        // pending(低置信度)档案无条件导出, 与工具描述"默认只导 confirmed"不一致
        const allProfiles = idList.map((id) => store.getContact(id));
        const profiles = args.include_pending
          ? allProfiles
          : allProfiles.filter((p) => p.status !== 'pending');
        const vcf = serializeVCards(profiles);
        if (args.path) {
          const p = args.path as string;
          if (!path.isAbsolute(p)) throw new Error('contacts:invalid-params path must be absolute');
          // 防覆盖: 导出工具不能变成"任意文件覆盖"通道(如 path 指向 shell 配置)
          if (!args.overwrite) {
            const existing = await fs.stat(p).catch(() => null);
            if (existing) throw new Error(`contacts:invalid-params file exists: ${p} (pass overwrite:true to replace)`);
          }
          await fs.writeFile(p, vcf, 'utf8');
          return { written: true, path: p, count: profiles.length };
        }
        return { count: profiles.length, vcf };
      }),
  });
}

/** 档案 → 回写计划(只取结构化公开字段; 任职关系 → 公司/职位; 锚点身份 → 更新目标) */
function buildWritePlan(p: ContactProfile): SystemContactWriteItem {
  // 任职语义判定(共享 helper, 与 vCard 导出一致): 客户/供应商/投资方等非雇佣
  // org 边不进 公司/职位 字段, 否则先建的任意 org 关系会污染系统联系人卡
  const employment = findEmploymentRelation(p);
  const anchor = p.identities.find((i) => i.platform === 'apple-contacts');
  return {
    contactId: p.id,
    name: p.displayName,
    isOrg: p.kind === 'org',
    ...(anchor ? { appleId: anchor.value } : {}),
    ...(employment ? { org: employment.displayName } : {}),
    ...(employment?.note ? { title: employment.note } : {}),
    emails: p.identities
      .filter((i) => i.platform === 'email')
      .map((i) => ({ value: i.value, ...(i.label ? { label: i.label } : {}) })),
    phones: p.identities
      .filter((i) => i.platform === 'phone')
      .map((i) => ({ value: i.value, ...(i.label ? { label: i.label } : {}) })),
  };
}

export function registerContactsExportSystemTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  if (!deps.writeSystemContacts) return;
  registry.register({
    name: 'contacts_export_system',
    category: 'manage',
    description:
      '把指定档案写进/更新到 macOS 系统通讯录(回写)。**必须显式指定 ids 或 group, 没有"全部"**; ' +
      'pending 档案一律跳过。只写结构化字段(姓名/公司/职位/邮箱/电话), 关系叙事与 agent 指令永不出库; ' +
      '系统侧只增不删(邮箱/电话补缺, 不移除既有)。带 apple-contacts 锚点的更新原联系人, ' +
      '否则新建(org 档案建成公司卡片)并自动回填锚点, 下次回写即为更新。' +
      '先 dry_run:true 看计划(每条是 create 还是 update)再执行。',
    rules: [MANAGE_RULES],
    inputShape: {
      ids: z.array(z.string().min(1)).max(200).optional().describe('要回写的档案 id 列表'),
      group: z.string().max(60).optional().describe('按分组名回写'),
      dry_run: z.boolean().optional().describe('true = 只返回计划不写入'),
    },
    handler: async (args) =>
      withContacts(deps, async (store) => {
        let idList: string[];
        if (args.ids) {
          // 显式 id 列表去重 — 重复 id 会生成重复写计划, 同一联系人在系统侧被建两张卡
          // 且只有一张能回填锚点
          idList = [...new Set(args.ids as string[])];
        } else if (args.group) {
          const g = store.listGroups().find((x) => x.name === (args.group as string).trim());
          if (!g) throw new Error(`contacts:not-found group not found: ${args.group}`);
          idList = listAllContactIds(store, { groupId: g.id });
        } else {
          throw new Error('contacts:invalid-params ids or group required (no implicit "all" for system write)');
        }
        const profiles = idList.map((id) => store.getContact(id));
        const skippedPending = profiles.filter((p) => p.status === 'pending').map((p) => p.displayName);
        const plans = profiles.filter((p) => p.status !== 'pending').map(buildWritePlan);
        if (args.dry_run) {
          return {
            dryRun: true,
            toCreate: plans.filter((x) => !x.appleId).map((x) => x.name),
            toUpdate: plans.filter((x) => x.appleId).map((x) => x.name),
            skippedPending,
          };
        }
        // host 侧 writeSystemContacts 单批上限 200; ids 路径有 zod cap 而 group 路径
        // 条数不受限 — 超限前分批执行, 否则 dry_run 能过、真执行整批被拒。
        // 批上限可通过 deps.systemWriteBatchSize 注入(测试用小值省建卡开销)。
        // 只接受 1..200 的正整数:0/负数/非整数会让下方 for 步进失序或死循环,
        // 超过 200 会让单批 slice 超出 host 硬限制被拒 — 非法/超限一律回退默认 200。
        const injected = deps.systemWriteBatchSize;
        const SYSTEM_WRITE_BATCH =
          typeof injected === 'number' &&
          Number.isInteger(injected) &&
          injected > 0 &&
          injected <= 200
            ? injected
            : 200;
        const results: SystemContactWriteResult[] = [];
        let anchorsAdded = 0;
        // created 的锚点每批立即回填, 不等全部批次跑完: 后续批失败(权限中途被
        // 收回/超时/osascript 崩)时, 已建的系统卡不至于失锚 — 失锚意味着下次
        // 回写把同一人再建一张重复卡
        const backfillAnchors = (batch: SystemContactWriteResult[]) => {
          for (const r of batch) {
            if (r.action === 'created' && r.appleId) {
              try {
                store.addIdentity(r.contactId, { platform: 'apple-contacts', value: r.appleId, label: '锚点' });
                anchorsAdded += 1;
              } catch {
                // already-exists / conflict → 不阻断
              }
            }
          }
        };
        for (let i = 0; i < plans.length; i += SYSTEM_WRITE_BATCH) {
          const batchResults = await deps.writeSystemContacts!(plans.slice(i, i + SYSTEM_WRITE_BATCH));
          results.push(...batchResults);
          backfillAnchors(batchResults);
        }
        return {
          created: results.filter((r) => r.action === 'created').length,
          updated: results.filter((r) => r.action === 'updated').length,
          missing: results.filter((r) => r.action === 'missing').map((r) => r.name),
          errors: results.filter((r) => r.action === 'error').map((r) => ({ name: r.name, error: r.error })),
          anchorsAdded,
          skippedPending,
        };
      }, { mutates: true }),
  });
}

export function registerContactsGroupTools(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_create_group',
    category: 'manage',
    description: '新建分组(组名全局唯一)。',
    rules: [MANAGE_RULES],
    inputShape: {
      name: z.string().min(1).max(60),
      description: z.string().max(200).optional(),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.createGroup(args.name as string, (args.description as string | undefined) ?? ''),
        { mutates: true },
      ),
  });

  registry.register({
    name: 'contacts_update_group',
    category: 'manage',
    description: '改分组名/描述。',
    rules: [MANAGE_RULES],
    inputShape: {
      group_id: z.string().min(1),
      name: z.string().min(1).max(60).optional(),
      description: z.string().max(200).optional(),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.updateGroup(args.group_id as string, {
          ...(args.name !== undefined ? { name: args.name as string } : {}),
          ...(args.description !== undefined ? { description: args.description as string } : {}),
        }),
        { mutates: true },
      ),
  });

  registry.register({
    name: 'contacts_delete_group',
    category: 'manage',
    description: '删除分组(只删组, 不删组内联系人)。',
    rules: [MANAGE_RULES],
    inputShape: {
      group_id: z.string().min(1),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        store.deleteGroup(args.group_id as string);
        return { deleted: true };
      }, { mutates: true }),
  });

  registry.register({
    name: 'contacts_set_group_members',
    category: 'manage',
    description: '批量调整分组成员: add 加入(已在组内幂等跳过), remove 移出。',
    rules: [MANAGE_RULES],
    inputShape: {
      group_id: z.string().min(1),
      add: z.array(z.string().min(1)).max(200).optional().describe('要加入的 contact id 列表'),
      remove: z.array(z.string().min(1)).max(200).optional().describe('要移出的 contact id 列表'),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        const add = (args.add as string[] | undefined) ?? [];
        const remove = (args.remove as string[] | undefined) ?? [];
        if (add.length > 0) store.addToGroup(args.group_id as string, add);
        if (remove.length > 0) store.removeFromGroup(args.group_id as string, remove);
        return { added: add.length, removed: remove.length };
      }, { mutates: true }),
  });
}
