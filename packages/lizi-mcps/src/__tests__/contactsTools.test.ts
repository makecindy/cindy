/**
 * cindy_contacts 工具层集成测试 — 真 better-sqlite3 临时库跑 registry.call 全链路:
 * strict 参数校验 / 开关拦截 / create→resolve→append_event→merge 主路径 /
 * IDENTITY_CONFLICT 结构化返回 / manage 工具。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import { MakerContactsManager } from '@cindy/maker-core';

import { ContactsToolRegistry } from '../cindy_contactsToolRegistry.js';
import {
  registerContactsAddIdentityTool,
  registerContactsAppendEventTool,
  registerContactsCreateTool,
  registerContactsDeleteTool,
  registerContactsGetTool,
  registerContactsGroupTools,
  registerContactsListGroupsTool,
  registerContactsListTool,
  registerContactsMergeTool,
  registerContactsFindDuplicatesTool,
  registerContactsVcfTools,
  registerContactsExportSystemTool,
  registerContactsRelationTools,
  registerContactsRemoveIdentityTool,
  registerContactsResolveTool,
  registerContactsSearchTool,
  registerContactsStatsTool,
  registerContactsUpdateTool,
} from '../contacts/index.js';
import type { ContactsMcpDeps } from '../types.js';
import type { SystemContactWriteItem, SystemContactWriteResult } from '@cindy/maker-core';

function noopLogger() {
  const noop = () => {};
  const l = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => l };
  return l;
}

/** 测试用的小批上限:注入 deps.systemWriteBatchSize 让分批在几笔建卡内触发,
 * 避免为跨过 host 默认 200 上限而建 201 张卡(Windows 慢 runner 上撞 vitest 5s
 * 超时, 见 #1598)。分批/锚点回归意图不变。 */
const TEST_SYSTEM_WRITE_BATCH_SIZE = 5;

function parseResult(res: { content: Array<{ type: string; text?: string }> }): {
  ok: boolean;
  data?: unknown;
  code?: string;
  errorCode?: string;
  conflictContactId?: string;
  [k: string]: unknown;
} {
  const text = res.content[0]?.text ?? '{}';
  return JSON.parse(text);
}

describe('cindy_contacts tools', () => {
  let tmpDir: string;
  let manager: MakerContactsManager;
  let registry: ContactsToolRegistry;
  let enabled: boolean;
  let writeCalls: SystemContactWriteItem[][];
  let mutations: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lizi-contacts-mcp-test-'));
    manager = new MakerContactsManager({
      basePath: tmpDir,
      sqliteFactory: (p) => new DatabaseCtor(p),
      logger: noopLogger(),
    });
    enabled = true;
    writeCalls = [];
    mutations = 0;
    const deps: ContactsMcpDeps = {
      getManager: () => manager,
      isEnabled: () => enabled,
      onMutated: () => {
        mutations += 1;
      },
      // 测试用小批上限:分批/锚点回归在几笔建卡内触发, 避免建 201 张卡撞超时
      systemWriteBatchSize: TEST_SYSTEM_WRITE_BATCH_SIZE,
      // stub 回写器: 记录计划, created 返回伪 apple id
      writeSystemContacts: async (items): Promise<SystemContactWriteResult[]> => {
        writeCalls.push(items);
        return items.map((it) => ({
          contactId: it.contactId,
          name: it.name,
          action: it.appleId ? ('updated' as const) : ('created' as const),
          appleId: it.appleId ?? `fake-apple-${it.contactId.slice(0, 8)}`,
        }));
      },
    };
    registry = new ContactsToolRegistry();
    registerContactsResolveTool(registry, deps);
    registerContactsSearchTool(registry, deps);
    registerContactsGetTool(registry, deps);
    registerContactsListTool(registry, deps);
    registerContactsListGroupsTool(registry, deps);
    registerContactsStatsTool(registry, deps);
    registerContactsCreateTool(registry, deps);
    registerContactsUpdateTool(registry, deps);
    registerContactsAddIdentityTool(registry, deps);
    registerContactsRemoveIdentityTool(registry, deps);
    registerContactsAppendEventTool(registry, deps);
    registerContactsDeleteTool(registry, deps);
    registerContactsMergeTool(registry, deps);
    registerContactsFindDuplicatesTool(registry, deps);
    registerContactsVcfTools(registry, deps);
    registerContactsExportSystemTool(registry, deps);
    registerContactsRelationTools(registry, deps);
    registerContactsGroupTools(registry, deps);
  });

  afterEach(() => {
    manager.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const createNeo = async () => {
    const res = parseResult(
      await registry.call('contacts_create', {
        kind: 'person',
        display_name: '林子航',
        aliases: ['Neo'],
        summary: '长期老搭档',
        identities: [
          { platform: 'email', value: 'neo@example.com', label: '当前' },
          { platform: 'x', value: '@neolin' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    return (res.data as { profile: { id: string } }).profile;
  };

  it('注册面完整: 23 个工具 4 个类目(export_system 依赖 host 注入)', () => {
    expect(registry.list()).toHaveLength(23);
    expect(new Set(registry.listCategories())).toEqual(new Set(['search', 'read', 'write', 'manage']));
  });

  it('write 类工具携带采集边界 rules', () => {
    const writeTools = registry.list('write');
    expect(writeTools.some((t) => (t.rules ?? []).some((r) => r.includes('建档边界')))).toBe(true);
  });

  it('create → resolve → get → append_event 主路径', async () => {
    const neo = await createNeo();

    const resolved = parseResult(await registry.call('contacts_resolve', { value: 'NEO@EXAMPLE.COM' }));
    expect(resolved.ok).toBe(true);
    const hits = resolved.data as Array<{ matchType: string; profile: { id: string; totalEvents: number } }>;
    expect(hits[0]!.matchType).toBe('identity');
    expect(hits[0]!.profile.id).toBe(neo.id);

    const ev = parseResult(
      await registry.call('contacts_append_event', {
        contact_id: neo.id,
        date: '2026-07-01',
        text: '一起过了通讯录设计方案',
        source: 'session',
      }),
    );
    expect(ev.ok).toBe(true);

    const got = parseResult(await registry.call('contacts_get', { id: neo.id }));
    expect(got.ok).toBe(true);
    expect((got.data as { events: unknown[] }).events).toHaveLength(1);

    const searched = parseResult(await registry.call('contacts_search', { query: '设计方案' }));
    expect((searched.data as unknown[]).length).toBe(1);
  });

  it('身份相同 → 不新建, 自动并入既有档案(merged:true)', async () => {
    const neo = await createNeo();
    const res = parseResult(
      await registry.call('contacts_create', {
        kind: 'person',
        display_name: 'Neo Lin',
        summary: '来自邮件签名的采集',
        identities: [
          { platform: 'email', value: 'neo@example.com' },
          { platform: 'github', value: 'neolin' },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    const data = res.data as {
      merged: boolean;
      mergedInto: { id: string };
      enrich: { addedIdentities: number; addedAliases: string[] };
      profile: { identities: unknown[] };
    };
    expect(data.merged).toBe(true);
    expect(data.mergedInto.id).toBe(neo.id);
    expect(data.enrich.addedIdentities).toBe(1); // github 新增, email 已在本人跳过
    expect(data.profile.identities).toHaveLength(3);
    // 全库仍然只有这一个人
    const stats = parseResult(await registry.call('contacts_stats', {})).data as { people: number };
    expect(stats.people).toBe(1);
  });

  it('名字相似且无身份 → DUPLICATE_SUSPECT 拦截, allow_duplicate 放行', async () => {
    await createNeo();
    const blocked = parseResult(
      await registry.call('contacts_create', { kind: 'person', display_name: 'Neo Lin' }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('DUPLICATE_SUSPECT');
    expect((blocked.candidates as Array<{ displayName: string }>)[0]!.displayName).toBe('林子航');

    const forced = parseResult(
      await registry.call('contacts_create', {
        kind: 'person',
        display_name: 'Neo Lin',
        allow_duplicate: true,
      }),
    );
    expect(forced.ok).toBe(true);
    const dupes = parseResult(await registry.call('contacts_find_duplicates', {})).data as unknown[];
    expect(dupes.length).toBeGreaterThan(0);
  });

  it('strict 校验: 未知字段 / 缺必填返回 INVALID_ARGS + schema', async () => {
    const res = parseResult(await registry.call('contacts_create', { kind: 'person', displayName: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_ARGS');
    expect((res.data as { schema: unknown }).schema).toBeTruthy();
  });

  it('开关关闭时全部工具返 CONTACTS_NOT_READY', async () => {
    enabled = false;
    for (const name of ['contacts_resolve', 'contacts_list', 'contacts_stats'] as const) {
      const res = parseResult(await registry.call(name, name === 'contacts_resolve' ? { value: 'x' } : {}));
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONTACTS_NOT_READY');
    }
  });

  it('merge + delete + 分组管理(manage 类)', async () => {
    const neo = await createNeo();
    // "Neo H." 与林子航的别名 "Neo" 相似, 会被 DUPLICATE_SUSPECT 拦 — 显式放行造重复
    const dup = (
      parseResult(
        await registry.call('contacts_create', {
          kind: 'person',
          display_name: 'Neo H.',
          identities: [{ platform: 'github', value: 'neolin' }],
          allow_duplicate: true,
        }),
      ).data as { profile: { id: string } }
    ).profile;

    const merged = parseResult(
      await registry.call('contacts_merge', { target_id: neo.id, source_id: dup.id }),
    );
    expect(merged.ok).toBe(true);
    expect((merged.data as { movedIdentities: number }).movedIdentities).toBe(1);

    const g = parseResult(await registry.call('contacts_create_group', { name: '老搭档' })).data as {
      id: string;
    };
    const setRes = parseResult(
      await registry.call('contacts_set_group_members', { group_id: g.id, add: [neo.id] }),
    );
    expect(setRes.ok).toBe(true);

    const groups = parseResult(await registry.call('contacts_list_groups', {})).data as Array<{
      memberCount: number;
    }>;
    expect(groups[0]!.memberCount).toBe(1);

    const del = parseResult(await registry.call('contacts_delete', { id: neo.id }));
    expect(del.ok).toBe(true);
    const stats = parseResult(await registry.call('contacts_stats', {})).data as { people: number };
    expect(stats.people).toBe(0);
  });

  it('关系边: add_relation 双向可见, remove_relation 清除', async () => {
    const neo = await createNeo();
    const org = (
      parseResult(await registry.call('contacts_create', { kind: 'org', display_name: '云岚网络' }))
        .data as { profile: { id: string } }
    ).profile;

    const rel = parseResult(
      await registry.call('contacts_add_relation', {
        from_id: neo.id,
        to_id: org.id,
        relation: '任职',
        note: '执行办',
      }),
    );
    expect(rel.ok).toBe(true);

    const got = parseResult(await registry.call('contacts_get', { id: org.id })).data as {
      relations: Array<{ direction: string; displayName: string; relation: string }>;
    };
    expect(got.relations[0]).toMatchObject({ direction: 'in', displayName: '林子航', relation: '任职' });

    // resolve 返回的 compactProfile 也带 relations
    const resolved = parseResult(await registry.call('contacts_resolve', { value: 'neo@example.com' }))
      .data as Array<{ profile: { relations: Array<{ displayName: string }> } }>;
    expect(resolved[0]!.profile.relations[0]!.displayName).toBe('云岚网络');

    const relId = (rel.data as { id: string }).id;
    const removed = parseResult(await registry.call('contacts_remove_relation', { relation_id: relId }));
    expect(removed.ok).toBe(true);
  });

  it('vcf 导出→导入 round-trip(agent 备份/迁移通道)', async () => {
    const neo = await createNeo();
    const vcfPath = path.join(tmpDir, 'export.vcf');
    const exported = parseResult(
      await registry.call('contacts_export_vcf', { ids: [neo.id], path: vcfPath }),
    );
    expect(exported.ok).toBe(true);
    expect((exported.data as { count: number }).count).toBe(1);
    expect(fs.existsSync(vcfPath)).toBe(true);

    const dry = parseResult(await registry.call('contacts_import_vcf', { path: vcfPath, dry_run: true }));
    expect((dry.data as { total: number }).total).toBe(1);
    // 真导回: 邮箱撞档 → enrich 不新建(幂等)
    const back = parseResult(await registry.call('contacts_import_vcf', { path: vcfPath }));
    expect((back.data as { enriched: number; created: number }).enriched).toBe(1);
    expect((back.data as { created: number }).created).toBe(0);

    const rel = parseResult(await registry.call('contacts_import_vcf', { path: 'relative.vcf' }));
    expect(rel.ok).toBe(false);
    expect(rel.code).toBe('INVALID_PARAMS');
  });

  it('系统回写: 强制显式范围 / pending 跳过 / 锚点回填 / 二次回写变更新', async () => {
    const neo = await createNeo();
    parseResult(
      await registry.call('contacts_create', {
        kind: 'person', display_name: '待确认者', status: 'pending', allow_duplicate: true,
      }),
    );
    const g = parseResult(await registry.call('contacts_create_group', { name: '回写组' })).data as { id: string };
    await registry.call('contacts_set_group_members', { group_id: g.id, add: [neo.id] });

    // 无 ids/group → 拒绝(不存在"全部回写")
    const noScope = parseResult(await registry.call('contacts_export_system', {}));
    expect(noScope.ok).toBe(false);
    expect(noScope.code).toBe('INVALID_PARAMS');

    // dry_run 计划
    const dry = parseResult(
      await registry.call('contacts_export_system', { group: '回写组', dry_run: true }),
    ).data as { toCreate: string[]; toUpdate: string[] };
    expect(dry.toCreate).toEqual(['林子航']);

    // 真回写: created + 锚点回填
    const run1 = parseResult(await registry.call('contacts_export_system', { ids: [neo.id] })).data as {
      created: number; anchorsAdded: number;
    };
    expect(run1.created).toBe(1);
    expect(run1.anchorsAdded).toBe(1);
    expect(writeCalls[0]![0]!.emails.length).toBeGreaterThan(0);

    // 二次回写: 锚点在 → 走更新, 不再新建
    const run2 = parseResult(await registry.call('contacts_export_system', { ids: [neo.id] })).data as {
      created: number; updated: number;
    };
    expect(run2.created).toBe(0);
    expect(run2.updated).toBe(1);
  });

  it('回写/vcf 导出: 只有任职语义的 org 边才映射公司/职位(客户等非雇佣边不出卡)', async () => {
    // 回归: 曾取"第一条指向 org 的出边"当雇主, 先建的 客户/供应商 关系会污染
    // 系统联系人卡的 公司/职位 字段
    const neo = await createNeo();
    const clientOrg = (
      parseResult(await registry.call('contacts_create', { kind: 'org', display_name: '甲方客户公司' }))
        .data as { profile: { id: string } }
    ).profile;
    const employer = (
      parseResult(await registry.call('contacts_create', { kind: 'org', display_name: '云岚网络' }))
        .data as { profile: { id: string } }
    ).profile;
    // 客户边先建(旧逻辑会命中它), 任职边后建
    await registry.call('contacts_add_relation', { from_id: neo.id, to_id: clientOrg.id, relation: '客户' });
    await registry.call('contacts_add_relation', {
      from_id: neo.id, to_id: employer.id, relation: '任职', note: '制作人',
    });

    parseResult(await registry.call('contacts_export_system', { ids: [neo.id] }));
    expect(writeCalls[0]![0]).toMatchObject({ org: '云岚网络', title: '制作人' });

    const vcf = (
      parseResult(await registry.call('contacts_export_vcf', { ids: [neo.id] })).data as { vcf: string }
    ).vcf;
    expect(vcf).toContain('ORG:云岚网络');
    expect(vcf).not.toContain('甲方客户公司');

    // 只有非雇佣 org 边的档案 → 公司/职位不写
    const clientOnly = (
      parseResult(await registry.call('contacts_create', { kind: 'person', display_name: '甲方联系人' }))
        .data as { profile: { id: string } }
    ).profile;
    await registry.call('contacts_add_relation', {
      from_id: clientOnly.id, to_id: clientOrg.id, relation: '客户',
    });
    parseResult(await registry.call('contacts_export_system', { ids: [clientOnly.id] }));
    const plan = writeCalls[writeCalls.length - 1]![0]!;
    expect(plan.org).toBeUndefined();
    expect(plan.title).toBeUndefined();
  });

  it('系统回写/vcf 导出: 显式 ids 去重, 重复 id 不生成重复卡片', async () => {
    // 回归: 重复 id 会生成重复写计划 → 系统侧同一人建两张卡且只有一张能回填锚点
    const neo = await createNeo();
    parseResult(await registry.call('contacts_export_system', { ids: [neo.id, neo.id, neo.id] }));
    expect(writeCalls[0]).toHaveLength(1);

    const vcfExport = parseResult(
      await registry.call('contacts_export_vcf', { ids: [neo.id, neo.id] }),
    ).data as { count: number };
    expect(vcfExport.count).toBe(1);
  });

  it('系统回写: group 超单批上限时按批上限分批执行, 不整批被拒', async () => {
    // 回归: group 路径条数不受 zod cap 约束, 曾把超单批上限的 plans 整批传给
    // writeSystemContacts(host 上限 200 直接拒绝) — dry_run 能过, 真执行全军覆没
    const store = manager.getStore();
    const g = parseResult(await registry.call('contacts_create_group', { name: '大组' })).data as {
      id: string;
    };
    const ids: string[] = [];
    for (let i = 0; i < TEST_SYSTEM_WRITE_BATCH_SIZE + 1; i += 1) {
      ids.push(store.createContact({ kind: 'person', displayName: `批量成员${i}`, source: 'agent' }).id);
    }
    store.addToGroup(g.id, ids);

    const res = parseResult(await registry.call('contacts_export_system', { group: '大组' }));
    expect(res.ok).toBe(true);
    expect((res.data as { created: number }).created).toBe(TEST_SYSTEM_WRITE_BATCH_SIZE + 1);
    expect(writeCalls.map((batch) => batch.length)).toEqual([TEST_SYSTEM_WRITE_BATCH_SIZE, 1]);
  });

  it('系统回写: 非法 systemWriteBatchSize(0/负数/非整数/超限)回退默认 200, 小批量单批不分批', async () => {
    // 回归: 注入值只接受 1..200 正整数, 0/负数/非整数/超限一律回退默认 200
    // (防 for 步进失序或死循环, 防单批 slice 超 host 硬限制被拒)
    const store = manager.getStore();
    const g = parseResult(await registry.call('contacts_create_group', { name: '回退组' })).data as {
      id: string;
    };
    const ids: string[] = [];
    for (let i = 0; i < TEST_SYSTEM_WRITE_BATCH_SIZE + 1; i += 1) {
      ids.push(store.createContact({ kind: 'person', displayName: `回退成员${i}`, source: 'agent' }).id);
    }
    store.addToGroup(g.id, ids);

    for (const bad of [0, -1, 1.5, Number.NaN, 201] as const) {
      writeCalls.length = 0; // 每次迭代独立统计
      const badDeps: ContactsMcpDeps = {
        getManager: () => manager,
        isEnabled: () => true,
        systemWriteBatchSize: bad,
        writeSystemContacts: async (items): Promise<SystemContactWriteResult[]> => {
          writeCalls.push(items);
          return items.map((it) => ({
            contactId: it.contactId,
            name: it.name,
            action: 'created' as const,
            appleId: `fake-${it.contactId.slice(0, 8)}`,
          }));
        },
      };
      const badRegistry = new ContactsToolRegistry();
      registerContactsExportSystemTool(badRegistry, badDeps);
      const res = parseResult(await badRegistry.call('contacts_export_system', { group: '回退组' }));
      expect(res.ok).toBe(true);
      // 回退 200 > 6: 单批写入, 未跨批
      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]).toHaveLength(TEST_SYSTEM_WRITE_BATCH_SIZE + 1);
    }
  });

  it('系统回写: 锚点每批立即回填, 后续批失败时已建卡不失锚', async () => {
    // 回归: 锚点回填曾等全部批次完成后统一做 — 第二批抛错(权限被收回/超时)时
    // 首批已建的系统卡失锚, 下次回写同一批人会重复建卡。
    const store = manager.getStore();
    let call = 0;
    const failingDeps: ContactsMcpDeps = {
      getManager: () => manager,
      isEnabled: () => true,
      systemWriteBatchSize: TEST_SYSTEM_WRITE_BATCH_SIZE,
      writeSystemContacts: async (items): Promise<SystemContactWriteResult[]> => {
        call += 1;
        if (call > 1) throw new Error('[PERMISSION_DENIED] revoked mid-run');
        return items.map((it) => ({
          contactId: it.contactId,
          name: it.name,
          action: 'created' as const,
          appleId: `fake-${it.contactId.slice(0, 8)}`,
        }));
      },
    };
    const failingRegistry = new ContactsToolRegistry();
    registerContactsExportSystemTool(failingRegistry, failingDeps);
    registerContactsGroupTools(failingRegistry, failingDeps);

    const g = parseResult(await failingRegistry.call('contacts_create_group', { name: '中断组' })).data as {
      id: string;
    };
    const ids: string[] = [];
    for (let i = 0; i < TEST_SYSTEM_WRITE_BATCH_SIZE + 1; i += 1) {
      ids.push(store.createContact({ kind: 'person', displayName: `中断成员${i}`, source: 'agent' }).id);
    }
    store.addToGroup(g.id, ids);

    const res = parseResult(await failingRegistry.call('contacts_export_system', { group: '中断组' }));
    expect(res.ok).toBe(false); // 第二批失败照常报错
    // 但首批的锚点已落库, 不会因后续批失败而丢
    const anchored = ids.filter((id) =>
      store.getContact(id).identities.some((i) => i.platform === 'apple-contacts'),
    );
    expect(anchored).toHaveLength(TEST_SYSTEM_WRITE_BATCH_SIZE);
  });

  it('write/manage 工具成功后触发 onMutated, 只读工具不触发(UI 刷新通道)', async () => {
    // 回归: onMutated 注入后从未被调用 — agent 经 MCP 直写 store 不经 IPC 层,
    // 设置页列表/待确认角标/统计全部不自动刷新
    const neo = await createNeo();
    expect(mutations).toBe(1); // contacts_create

    await registry.call('contacts_search', { query: 'Neo' });
    await registry.call('contacts_get', { id: neo.id });
    await registry.call('contacts_export_vcf', { ids: [neo.id] }); // 只写文件不动库
    expect(mutations).toBe(1); // 只读/导出不触发

    await registry.call('contacts_update', { id: neo.id, summary: '更新简介' });
    expect(mutations).toBe(2);
    await registry.call('contacts_delete', { id: neo.id });
    expect(mutations).toBe(3);
  });

  it('未知工具名返回 UNKNOWN_TOOL + 可用列表', async () => {
    const res = parseResult(await registry.call('contacts_nope', {}));
    expect(res.errorCode).toBe('UNKNOWN_TOOL');
  });

  it('export_vcf: ids 路径同样默认排除 pending, include_pending:true 才导出', async () => {
    // 回归: ids 路径曾跳过状态过滤, 显式 id 列表会把 pending(低置信度)档案
    // 无条件泄漏进 vCard, 与工具描述"默认只导 confirmed"不一致
    const neo = await createNeo();
    const pending = (
      parseResult(
        await registry.call('contacts_create', {
          kind: 'person', display_name: '低置信度', status: 'pending', allow_duplicate: true,
        }),
      ).data as { profile: { id: string } }
    ).profile;

    const defaultExport = parseResult(
      await registry.call('contacts_export_vcf', { ids: [neo.id, pending.id] }),
    ).data as { count: number; vcf: string };
    expect(defaultExport.count).toBe(1);
    expect(defaultExport.vcf).toContain('林子航');
    expect(defaultExport.vcf).not.toContain('低置信度');

    const withPending = parseResult(
      await registry.call('contacts_export_vcf', { ids: [neo.id, pending.id], include_pending: true }),
    ).data as { count: number; vcf: string };
    expect(withPending.count).toBe(2);
    expect(withPending.vcf).toContain('低置信度');
  });

  it('export_vcf: 目标文件已存在时拒绝, overwrite:true 才覆盖(防任意文件覆盖)', async () => {
    await registry.call('contacts_create', {
      kind: 'person',
      display_name: '导出防覆盖',
      identities: [{ platform: 'email', value: 'ow@example.com' }],
    });
    const target = path.join(tmpDir, 'existing.vcf');
    fs.writeFileSync(target, 'precious data', 'utf8');
    const refused = parseResult(await registry.call('contacts_export_vcf', { path: target }));
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('INVALID_PARAMS');
    expect(fs.readFileSync(target, 'utf8')).toBe('precious data'); // 原文件未被动
    const ok = parseResult(await registry.call('contacts_export_vcf', { path: target, overwrite: true }));
    expect(ok.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('BEGIN:VCARD');
  });

  it('host IPC [CODE] 前缀全集还原, INVALID_PARAMS 等业务码不落 INTERNAL 兜底', async () => {
    // 回归: ipcTag 正则曾只列 PERMISSION_DENIED/UNSUPPORTED_CAPABILITY,
    // host throwIpcError 的 [INVALID_PARAMS] 落进 INTERNAL, agent 无法按码自纠
    const { classifyContactsError } = await import('../contacts/errors.js');
    expect(classifyContactsError(new Error('[INVALID_PARAMS] write batch too large (> 200)'))).toEqual({
      code: 'INVALID_PARAMS',
      message: '[INVALID_PARAMS] write batch too large (> 200)',
    });
    expect(classifyContactsError(new Error('[NOT_FOUND] contact gone')).code).toBe('NOT_FOUND');
    expect(classifyContactsError(new Error('[INTERNAL] osascript failed')).code).toBe('INTERNAL');
    expect(classifyContactsError(new Error('[PERMISSION_DENIED] not authorized')).code).toBe('PERMISSION_DENIED');
  });

  it('host IPC 协议错误([PERMISSION_DENIED] 前缀)在工具面还原成结构化错误码', async () => {
    const deniedDeps: ContactsMcpDeps = {
      getManager: () => manager,
      isEnabled: () => true,
      readSystemContacts: async () => {
        throw new Error('[PERMISSION_DENIED] contacts automation permission denied');
      },
    };
    const r2 = new ContactsToolRegistry();
    const { registerContactsImportSystemTool } = await import('../contacts/index.js');
    registerContactsImportSystemTool(r2, deniedDeps);
    const res = parseResult(await r2.call('contacts_import_system', { dry_run: true }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PERMISSION_DENIED');
  });
});
