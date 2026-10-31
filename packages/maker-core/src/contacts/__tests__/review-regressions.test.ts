/**
 * 对抗式 review 修复的回归测试集 — 每个 describe 对应一个曾实测确认的缺陷:
 * FTS 对端一致性 / enrich 原子性 / merge 字段保留 / vCard round-trip 与注入面 /
 * import 组织精确归并与批内去重 / 输入收紧(重复身份、超长值、日期)。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { MakerContactsStore } from '../store.js';
import { parseVCards, serializeVCards } from '../vcard.js';
import { importContacts } from '../import.js';
import type { Logger } from '../../interfaces/logger.js';

function noopLogger(): Logger {
  const noop = () => {};
  const l: Logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => l };
  return l;
}

describe('review 回归', () => {
  let db: Database.Database;
  let store: MakerContactsStore;

  beforeEach(() => {
    db = new DatabaseCtor(':memory:');
    store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
  });

  afterEach(() => {
    db.close();
  });

  describe('关系对端 FTS 一致性(rename/merge/delete 后搜组织名捞成员)', () => {
    it('组织改名后, 用新名能搜到成员, 旧名不再脏命中', () => {
      const org = store.createContact({ kind: 'org', displayName: '旧云岚' });
      const p = store.createContact({ kind: 'person', displayName: '员工甲' });
      store.addRelation(p.id, { toId: org.id, relation: '任职' });
      expect(store.search('旧云岚').map((h) => h.contactId)).toContain(p.id);

      store.updateContact(org.id, { displayName: '新云岚' });
      expect(store.search('新云岚').map((h) => h.contactId)).toContain(p.id);
      expect(store.search('旧云岚').map((h) => h.contactId)).not.toContain(p.id);
    });

    it('组织被 merge 掉后, 成员的 FTS 关系文本换成 target 名', () => {
      const orgKeep = store.createContact({ kind: 'org', displayName: '保留组织' });
      const orgGone = store.createContact({ kind: 'org', displayName: '被并组织' });
      const p = store.createContact({ kind: 'person', displayName: '员工乙' });
      store.addRelation(p.id, { toId: orgGone.id, relation: '任职' });

      store.merge(orgKeep.id, orgGone.id);
      expect(store.search('保留组织').map((h) => h.contactId)).toContain(p.id);
      expect(store.search('被并组织').map((h) => h.contactId)).not.toContain(p.id);
    });

    it('对端被删除后, 本人 FTS 里不再残留其名字', () => {
      const org = store.createContact({ kind: 'org', displayName: '临时公司' });
      const p = store.createContact({ kind: 'person', displayName: '员工丙' });
      store.addRelation(p.id, { toId: org.id, relation: '任职' });
      store.deleteContact(org.id);
      expect(store.search('临时公司').map((h) => h.contactId)).not.toContain(p.id);
    });
  });

  describe('enrichContact 原子性', () => {
    it('非法身份不再中途抛错留半套写入, 记入 skipped(invalid), 合法部分照常并入', () => {
      const p = store.createContact({ kind: 'person', displayName: '张三' });
      const r = store.enrichContact(p.id, {
        kind: 'person',
        displayName: '张三丰',
        summary: '一行简介',
        identities: [
          { platform: 'email', value: 'zhang@example.com' },
          { platform: '!!!非法平台!!!', value: 'x' },
          { platform: 'email', value: '   ' }, // 空值
        ],
      });
      expect(r.addedIdentities).toBe(1);
      expect(r.skippedIdentities.map((s) => s.reason)).toEqual(['invalid', 'invalid']);
      const after = store.getContact(p.id);
      expect(after.summary).toBe('一行简介');
      expect(after.aliases).toContain('张三丰');
      expect(after.identities).toHaveLength(1);
    });
  });

  describe('merge 字段保留', () => {
    it('target 为空的 summary/agentNotes 由 source 填充; 别名并集大小写不敏感', () => {
      const target = store.createContact({ kind: 'person', displayName: 'Remy Kim', aliases: ['remy'] });
      const source = store.createContact({
        kind: 'person',
        displayName: 'Remy',
        aliases: ['REMY', 'K.D.'],
        summary: '技术合伙人',
        agentNotes: '勿群发营销邮件',
      });
      store.merge(target.id, source.id);
      const after = store.getContact(target.id);
      expect(after.summary).toBe('技术合伙人');
      expect(after.agentNotes).toBe('勿群发营销邮件');
      // 'REMY' 与已有 'remy' 大小写不敏感去重, 不重复入列
      expect(after.aliases.filter((a) => a.toLowerCase() === 'remy')).toHaveLength(1);
      expect(after.aliases).toContain('K.D.');
    });
  });

  describe('resolve FTS 幽灵行兜底', () => {
    it('FTS 残留 stale 行时 resolve 跳过该条而不是整个崩掉', () => {
      const p = store.createContact({ kind: 'person', displayName: '幽灵测试员', summary: '特征词鲲鹏' });
      // 绕过 store 直删主表行, 模拟 fts.delete 失败后的残留
      db.prepare(`DELETE FROM contacts WHERE id = ?`).run(p.id);
      expect(() => store.resolve('鲲鹏')).not.toThrow();
      expect(store.resolve('鲲鹏')).toEqual([]);
    });
  });

  describe('createContact 输入收紧', () => {
    it('入参内重复身份自动去重, 不抛裸 SqliteError', () => {
      const p = store.createContact({
        kind: 'person',
        displayName: '重复身份',
        identities: [
          { platform: 'email', value: 'dup@example.com' },
          { platform: 'email', value: 'DUP@example.com' }, // 归一化后同值
        ],
      });
      expect(p.identities).toHaveLength(1);
    });

    it('超长身份值被拒(默认 320)', () => {
      expect(() =>
        store.createContact({
          kind: 'person',
          displayName: '超长值',
          identities: [{ platform: 'email', value: `${'a'.repeat(400)}@example.com` }],
        }),
      ).toThrow(/too long/);
    });

    it('事件日期拒绝非法月份/日(2026-99-99)', () => {
      const p = store.createContact({ kind: 'person', displayName: '日期校验' });
      expect(() => store.appendEvent(p.id, { date: '2026-99-99', text: 'x' })).toThrow(/date/);
      expect(() => store.appendEvent(p.id, { date: '2026-12-31', text: 'ok' })).not.toThrow();
      expect(() => store.appendEvent(p.id, { date: '2026-02', text: 'ok' })).not.toThrow();
    });
  });

  describe('vCard round-trip 与注入面', () => {
    it('org 档案导出带 KIND:org / X-ABSHOWAS, 读回仍是 org(不再退化成 person)', () => {
      const org = store.createContact({ kind: 'org', displayName: '云岚网络' });
      const vcf = serializeVCards([store.getContact(org.id)]);
      expect(vcf).toContain('KIND:org');
      expect(vcf).toContain('X-ABSHOWAS:COMPANY');
      const back = parseVCards(vcf);
      expect(back[0]).toMatchObject({ displayName: '云岚网络', kind: 'org' });
    });

    it('EMAIL 值与 TYPE label 被转义/净化, 换行注入不产生伪造行', () => {
      const p = store.createContact({ kind: 'person', displayName: '注入测试' });
      const profile = store.getContact(p.id);
      // 手工构造带危险字符的身份(绕过 store 校验直接喂序列化器)
      profile.identities = [
        {
          id: 'x',
          contactId: p.id,
          platform: 'email',
          value: 'evil@example.com\r\nX-INJECTED:pwned',
          normalizedValue: 'evil@example.com',
          label: 'work;X-EVIL',
          note: '',
          createdAt: '',
        },
      ];
      const vcf = serializeVCards([profile]);
      expect(vcf).not.toMatch(/^X-INJECTED/m);
      expect(vcf).toContain('TYPE=WORKX-EVIL'); // 非 token 字符被剥掉
    });

    it('反转义单趟: 字面反斜杠+n(\\\\n)还原为两个字符, 不误变换行', () => {
      const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:转义员', 'NOTE:路径 C:\\\\network\\\\next', 'END:VCARD'].join(
        '\r\n',
      );
      const rec = parseVCards(vcf)[0]!;
      expect(rec.note).toBe('路径 C:\\network\\next');
      expect(rec.note).not.toContain('\n');
    });

    it('X-XDMAKER 平台身份 export→import 不丢(回读进 identities)', () => {
      const p = store.createContact({
        kind: 'person',
        displayName: '平台身份',
        identities: [{ platform: 'feishu', value: 'ou_abc123' }],
      });
      const back = parseVCards(serializeVCards([store.getContact(p.id)]));
      expect(back[0]!.identities).toEqual([{ platform: 'feishu', value: 'ou_abc123' }]);

      // 走完整导入管道后身份可反查
      const db2 = new DatabaseCtor(':memory:');
      const store2 = new MakerContactsStore({ db: db2, logger: noopLogger() });
      store2.init();
      importContacts(store2, back);
      expect(store2.resolve('ou_abc123')[0]!.profile.displayName).toBe('平台身份');
      db2.close();
    });
  });

  describe('import 组织精确归并与批内去重', () => {
    it('org 名只做精确等值归并: "云岚" 不再模糊挂进 "云岚网络"', () => {
      store.createContact({ kind: 'org', displayName: '云岚网络' });
      const summary = importContacts(store, [
        { displayName: 'Employee X', emails: [{ value: 'ex@example.com' }], phones: [], org: '云岚' },
      ]);
      expect(summary.orgsCreated).toBe(1); // 新建了 "云岚", 没挂错到 "云岚网络"
      const orgs = store.listContacts({ kind: 'org' }).map((c) => c.displayName);
      expect(orgs).toContain('云岚');
      expect(orgs).toContain('云岚网络');
    });

    it('org 名与既有 org 精确同名(大小写差异)时归并, 不重复建档', () => {
      store.createContact({ kind: 'org', displayName: 'Apple' });
      const summary = importContacts(store, [
        { displayName: 'Employee Y', emails: [{ value: 'ey@apple.com' }], phones: [], org: 'apple' },
      ]);
      expect(summary.orgsCreated).toBe(0);
    });

    it('批内同名记录: 第二条进 needsReview 而不是重复建档', () => {
      const summary = importContacts(store, [
        { displayName: '王重复', emails: [{ value: 'a@x.com' }], phones: [] },
        { displayName: '王重复', emails: [{ value: 'b@y.com' }], phones: [] },
      ]);
      expect(summary.created).toBe(1);
      expect(summary.needsReview).toHaveLength(1);
    });
  });
});

describe('bot review 回归(PR #875 threads)', () => {
  let db: Database.Database;
  let store: MakerContactsStore;

  beforeEach(() => {
    db = new DatabaseCtor(':memory:');
    store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
  });

  afterEach(() => {
    db.close();
  });

  it('import: groupId 不存在时入口抛错, 统计不产生 created+skipped 双计', () => {
    expect(() =>
      importContacts(store, [{ displayName: '张统计', emails: [{ value: 'a@x.com' }], phones: [] }], {
        groupId: 'no-such-group',
      }),
    ).toThrow(/group not found/);
    expect(store.stats().people).toBe(0); // 入口拦截, 没有半写入
  });

  it('vCard 序列化行折叠: 超 75 字节折行且 round-trip 内容不变', () => {
    const longSummary = '这是一段非常长的简介用来触发折行逻辑,' + '合作背景'.repeat(30);
    const p = store.createContact({ kind: 'person', displayName: '长简介', summary: longSummary.slice(0, 200) });
    const vcf = serializeVCards([store.getContact(p.id)]);
    for (const line of vcf.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    const back = parseVCards(vcf);
    expect(back[0]!.note).toBe(longSummary.slice(0, 200));
  });

  it('hasCjk 覆盖 CJK 扩展 A: 含 U+3400 区生僻字的名字走 CJK 子串路径', () => {
    const p = store.createContact({ kind: 'person', displayName: '㐀㑊明' });
    const hits = store.findSimilar({ kind: 'person', displayName: '㑊明' });
    expect(hits.some((h) => h.contactId === p.id)).toBe(true);
  });

  it('enrich skippedIdentities 的 conflict-other 携带 conflictContactId', () => {
    const owner = store.createContact({
      kind: 'person',
      displayName: '占用者',
      identities: [{ platform: 'email', value: 'taken@example.com' }],
    });
    const target = store.createContact({ kind: 'person', displayName: '被并入' });
    const r = store.enrichContact(target.id, {
      kind: 'person',
      displayName: '被并入',
      identities: [{ platform: 'email', value: 'taken@example.com' }],
    });
    expect(r.skippedIdentities).toEqual([
      { platform: 'email', value: 'taken@example.com', reason: 'conflict-other', conflictContactId: owner.id },
    ]);
  });

  it('resolve 带 platform: 无该平台身份时不落到名字/FTS 兜底(消歧参数不返回错人)', () => {
    // 回归: platform 只过滤 tier-1, 名字兜底仍全库跑 — 查 github handle "may"
    // 会把恰好叫 may、但不持有 github 身份的人当命中返回
    store.createContact({ kind: 'person', displayName: 'may' }); // 同名但无 github 身份
    const owner = store.createContact({
      kind: 'person',
      displayName: '梅姐',
      identities: [{ platform: 'github', value: 'may' }],
    });

    const hits = store.resolve('may', { platform: 'github' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matchType).toBe('identity');
    expect(hits[0]!.profile.id).toBe(owner.id);

    store.removeIdentity(owner.identities[0]!.id);
    // 唯一的 github 身份没了 → 空结果, 而不是名字兜底把同名人顶上来
    expect(store.resolve('may', { platform: 'github' })).toEqual([]);
    // 不带 platform 的普通 resolve 仍走名字兜底
    expect(store.resolve('may').some((h) => h.matchType === 'name')).toBe(true);
  });

  it('import 组织归并: 无关身份值撞公司名不再抢占, 精确名命中既有 org', () => {
    // 回归: resolve identity-first 短路 — 某人 handle 恰好叫 "acme" 时,
    // 导入 ORG:Acme 的员工会重复建 org(真正的 Acme org 在名字层永远轮不到)
    const acmeOrg = store.createContact({ kind: 'org', displayName: 'Acme' });
    store.createContact({
      kind: 'person',
      displayName: '路人',
      identities: [{ platform: 'x', value: 'acme' }],
    });

    const summary = importContacts(store, [
      { displayName: '员工丙', emails: [{ value: 'c@acme.com' }], phones: [], org: 'Acme' },
    ]);
    expect(summary.orgsCreated).toBe(0);
    const employee = store.resolve('c@acme.com')[0]!.profile;
    expect(employee.relations[0]).toMatchObject({ relation: '任职', contactId: acmeOrg.id });
  });

  it('merge 叙事拼接超 maxNarrativeBytes 截断落库(target 全文保留 + 返回值标注)', () => {
    // 回归: 拼接不校验会把超限行值落库, 之后 enrich 追加因 combined 超限
    // 静默跳过(narrativeAppended:false)且无从解释
    const big = 'A'.repeat(10000);
    const target = store.createContact({ kind: 'person', displayName: '目标', narrative: big });
    const source = store.createContact({
      kind: 'person',
      displayName: '来源',
      narrative: `B${'C'.repeat(9999)}`,
    });

    const result = store.merge(target.id, source.id);
    expect(result.narrativeTruncated).toBe(true);
    const merged = store.getContact(target.id);
    expect(Buffer.byteLength(merged.narrative, 'utf8')).toBeLessThanOrEqual(16384);
    expect(merged.narrative.startsWith(big)).toBe(true); // target 全文保留

    // 截断后的库值不再卡死后续 enrich 追加
    const r = store.enrichContact(target.id, { kind: 'person', displayName: '目标', narrative: '新增一句' });
    expect(r.narrativeAppended).toBe(true);
  });

  it('import: enrich 撞上第三方档案的身份冲突收进 identityConflicts, 不静默蒸发', () => {
    // 回归: enrichContact 返回值被丢弃, 记录同时带 X 的身份和已属 Y 的身份时,
    // 摘要只见 enriched:1, X/Y 疑似同人的信号无从驱动 merge 裁决
    const x = store.createContact({
      kind: 'person',
      displayName: 'X',
      identities: [{ platform: 'email', value: 'x@example.com' }],
    });
    const y = store.createContact({
      kind: 'person',
      displayName: 'Y',
      identities: [{ platform: 'email', value: 'y@example.com' }],
    });

    const summary = importContacts(store, [
      { displayName: '同一人', emails: [{ value: 'x@example.com' }, { value: 'y@example.com' }], phones: [] },
    ]);
    expect(summary.enriched).toBe(1);
    expect(summary.identityConflicts).toEqual([
      { displayName: '同一人', platform: 'email', value: 'y@example.com', conflictContactId: y.id },
    ]);
    // X 档案本体正常并入
    expect(store.getContact(x.id).aliases).toContain('同一人');
  });

  it('search 带 groupId: SQL 层过滤在 LIMIT 前生效, 组内命中不被全局 top-N 挤掉', () => {
    // 回归: 客户端"先取全局前 N 再求交"在大库下漏掉排位靠后的组内命中
    const g = store.createGroup('目标组');
    const member = store.createContact({ kind: 'person', displayName: '组员搜索词' });
    store.addToGroup(g.id, [member.id]);
    // 组外同词命中若干, 占满 limit:1 的全局头名
    for (let i = 0; i < 3; i += 1) {
      store.createContact({ kind: 'person', displayName: `组外搜索词${i}` });
    }

    const hits = store.search('搜索词', { groupId: g.id, limit: 1 });
    expect(hits.map((h) => h.contactId)).toEqual([member.id]);
    // 无 groupId 的全局搜索不受影响
    expect(store.search('搜索词', { limit: 10 }).length).toBeGreaterThan(1);
  });

  it('search: FTS 部分命中时仍合并 LIKE 兜底, CJK 子串命中不被整 token 命中遮蔽', () => {
    // 回归: MATCH 命中≥1 就提前返回 — 搜「设计方案」命中整 token 行,
    // 含「通讯录设计方案」(子串)的行被跳过
    const exact = store.createContact({ kind: 'person', displayName: '甲', summary: '设计方案 负责人' });
    const substr = store.createContact({ kind: 'person', displayName: '乙', summary: '通讯录设计方案评审' });

    const ids = store.search('设计方案', { limit: 10 }).map((h) => h.contactId);
    expect(ids).toContain(exact.id);
    expect(ids).toContain(substr.id);
  });

  it('search: MATCH 命中已满 limit 时为 LIKE-only 子串命中保留一个名额', () => {
    // 回归: MATCH 满 limit 就 return, LIKE 兜底永不执行 — 「LinkedIn」是单个 token,
    // 搜「link」时 phrase MATCH 命不中, 只有 LIKE 子串扫描捞得到
    for (let i = 0; i < 7; i += 1) {
      store.createContact({ kind: 'person', displayName: `link 联系人 ${i}` });
    }
    const linkedin = store.createContact({ kind: 'person', displayName: '乙', summary: 'LinkedIn 社交平台' });

    const hits = store.search('link', { limit: 3 });
    expect(hits).toHaveLength(3);
    expect(hits.some((h) => h.contactId === linkedin.id)).toBe(true);
  });

  it('search: limit=1 且 MATCH 满额时不预留, 保住唯一最佳 MATCH', () => {
    const exact = store.createContact({ kind: 'person', displayName: 'link 甲' });
    store.createContact({ kind: 'person', displayName: '乙', summary: 'LinkedIn 社交平台' });

    const hits = store.search('link', { limit: 1 });
    expect(hits.map((h) => h.contactId)).toEqual([exact.id]);
  });

  it('import: 任职关系建边失败(非重复)浮进 relationErrors, 不无声报成功', () => {
    // 用收紧的 maxRelationLen 让 addRelation 确定性抛 invalid-params
    const strictStore = new MakerContactsStore({ db, logger: noopLogger(), config: { maxRelationLen: 1 } });
    strictStore.init();
    const summary = importContacts(strictStore, [
      { displayName: '关系失败者', emails: [{ value: 'rel@example.com' }], phones: [], org: '某公司', title: '经理' },
    ]);
    expect(summary.created).toBe(1); // 档案本体导入成功
    expect(summary.relationsAdded).toBe(0);
    expect(summary.relationErrors).toEqual([
      { displayName: '关系失败者', org: '某公司', reason: expect.stringContaining('relation must be') },
    ]);
  });

  it('名字面快照不封顶: 第 2000 行之后的档案仍参与查重, 大库导入不漏检', () => {
    // 回归: loadNameSnapshot 曾 LIMIT 2000(恰好等于单批导入上限), 两批导入后
    // 靠后的档案对 findSimilar 完全隐身, 同名新建绕过 DUPLICATE_SUSPECT/needsReview
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO contacts(id, kind, display_name, aliases, summary, narrative, agent_notes, status, source, created_at, updated_at)
       VALUES (?, 'person', ?, '[]', '', '', '', 'confirmed', 'import', ?, ?)`,
    );
    const fill = db.transaction(() => {
      for (let i = 0; i < 2000; i += 1) insert.run(`filler-${i}`, `填充${i}`, now, now);
      insert.run('beyond-cap', '超限目标人', now, now);
    });
    fill();

    const candidates = store.findSimilar({ kind: 'person', displayName: '超限目标人' });
    expect(candidates.some((c) => c.contactId === 'beyond-cap')).toBe(true);
  });

  it('vCard 导出跳过 apple-contacts 锚点: 换机还原不携带死锚, 其它平台身份保留', () => {
    // 回归: 锚点是本机 Contacts.app 对账 id, 带出去再导回会让 export_system
    // 拿死值当更新目标, byId 失配整条 missing, 联系人永远写不进新机系统通讯录
    const p = store.createContact({
      kind: 'person',
      displayName: '有锚点的人',
      identities: [
        { platform: 'apple-contacts', value: 'ABC-LOCAL-123', label: '锚点' },
        { platform: 'github', value: 'anchor-dude' },
      ],
    });
    const vcf = serializeVCards([store.getContact(p.id)]);
    expect(vcf).not.toContain('APPLE-CONTACTS');
    expect(vcf).not.toContain('ABC-LOCAL-123');
    expect(vcf).toContain('X-XDMAKER-GITHUB:anchor-dude');
  });

  it('vCard 导入丢弃 X-XDMAKER-APPLE-CONTACTS: 旧版导出/外来 vcf 的死锚不进库', () => {
    // 回归: 导出侧已跳过锚点, 但导入侧对旧文件仍照单全收 — 别机死锚导回会被
    // export_system 当更新目标, 且同锚值可能让两个人被去重误并
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:旧文件联系人',
      'EMAIL:old@example.com',
      'X-XDMAKER-APPLE-CONTACTS:DEAD-ANCHOR-999',
      'X-XDMAKER-GITHUB:legit-handle',
      'END:VCARD',
    ].join('\r\n');
    const recs = parseVCards(vcf);
    expect(recs).toHaveLength(1);
    const platforms = (recs[0]!.identities ?? []).map((i) => i.platform);
    expect(platforms).toContain('github');
    expect(platforms).not.toContain('apple-contacts');
  });

  it('import: org 建档失败(公司名超上限)记 relationErrors, 人不被双计进 skipped', () => {
    // 回归: org find-or-create 在人已建档计数后抛错 → 外层 catch 把同一条记录
    // 再计入 skipped(created+skipped 双计), 雇主关系静默丢失
    const summary = importContacts(store, [
      { displayName: '公司名超长者', emails: [{ value: 'longorg@example.com' }], phones: [], org: 'X'.repeat(101) },
    ]);
    expect(summary.created).toBe(1);
    expect(summary.skipped).toHaveLength(0); // 不双计
    expect(summary.orgsCreated).toBe(0);
    expect(summary.relationErrors).toHaveLength(1);
    expect(summary.relationErrors[0]).toMatchObject({ displayName: '公司名超长者' });
    // 人已正常入库
    expect(store.resolve('longorg@example.com')[0]!.profile.displayName).toBe('公司名超长者');
  });

  it('导出雇主取最新任职关系: 换工作没删旧关系时不导出老东家', () => {
    // 回归: findEmploymentRelation 曾取第一条命中(relations 按 created_at 升序
    // = 最旧), OldCo→NewCo 后导出的公司/职位还是 OldCo
    const p = store.createContact({ kind: 'person', displayName: '跳槽者' });
    const oldCo = store.createContact({ kind: 'org', displayName: '老东家' });
    const newCo = store.createContact({ kind: 'org', displayName: '新公司' });
    store.addRelation(p.id, { toId: oldCo.id, relation: '任职', note: '旧职位' });
    store.addRelation(p.id, { toId: newCo.id, relation: '任职', note: '新职位' });

    const vcf = serializeVCards([store.getContact(p.id)]);
    expect(vcf).toContain('ORG:新公司');
    expect(vcf).toContain('TITLE:新职位');
    expect(vcf).not.toContain('ORG:老东家');
  });

  it('ORG 含转义分号 round-trip: 未转义分号才是组件分隔, 公司名不被截断', () => {
    // 回归: ORG 解析曾在反转义前按裸 ";" 切分 — "Foo\\;Bar" 断成 "Foo\\",
    // 备份还原把人挂进错误组织
    const org = store.createContact({ kind: 'org', displayName: 'Foo;Bar 集团' });
    const p = store.createContact({
      kind: 'person',
      displayName: '分号公司员工',
      identities: [{ platform: 'email', value: 'semi@example.com' }],
    });
    store.addRelation(p.id, { toId: org.id, relation: '任职', note: '工程师' });

    const vcf = serializeVCards([store.getContact(p.id)]);
    const back = parseVCards(vcf);
    expect(back[0]!.org).toBe('Foo;Bar 集团');
  });

  it('电话身份按数字规范化匹配: 带格式与不带格式是同一号码, 不建重复档案', () => {
    // 回归: 匹配键曾保留格式字符, "+1 (555) 123-4567" 与 "+15551234567" 被当成
    // 两个身份 — 导入/resolve 漏配, 重复建档
    const p = store.createContact({
      kind: 'person',
      displayName: '电话人',
      identities: [{ platform: 'phone', value: '+1 (555) 123-4567' }],
    });

    // 无 platform 的 resolve: 电话规范键参与候选
    expect(store.resolve('+15551234567')[0]!.profile.id).toBe(p.id);
    // 带 platform 的 resolve: 按电话口径单键
    expect(store.resolve('+1 555 123 4567', { platform: 'phone' })[0]!.profile.id).toBe(p.id);
    // 导入不同格式的同一号码 → enrich 并入, 不新建
    const summary = importContacts(store, [
      { displayName: '电话人别名', emails: [], phones: [{ value: '+1-555-123-4567' }] },
    ]);
    expect(summary.enriched).toBe(1);
    expect(summary.created).toBe(0);
    // 同号不同格式在 createContact 也撞唯一约束(identity-conflict), 不静默双档
    expect(() =>
      store.createContact({
        kind: 'person',
        displayName: '重复电话人',
        identities: [{ platform: 'phone', value: '+15551234567' }],
      }),
    ).toThrow(/identity/);
  });

  it('init 幂等重归一化: 旧口径(带格式)的 phone 匹配键升级后自动修复', () => {
    const p = store.createContact({
      kind: 'person',
      displayName: '存量电话人',
      identities: [{ platform: 'phone', value: '+86 138-0000-0000' }],
    });
    // 模拟旧库: 匹配键退回未剥格式的旧口径
    db.prepare(`UPDATE contact_identities SET normalized_value = ? WHERE contact_id = ?`).run(
      '+86 138-0000-0000',
      p.id,
    );
    // 新 store 实例 init → 重归一化兜底生效
    const store2 = new MakerContactsStore({ db, logger: noopLogger() });
    store2.init();
    expect(store2.resolve('+8613800000000')[0]!.profile.id).toBe(p.id);
  });

  it('removeFromGroup: 组/联系人不存在按 not-found 报错, 非成员移除幂等', () => {
    // 回归: remove 路径无任何存在性校验, 打错组名也返回假成功
    const g = store.createGroup('存在组');
    const p = store.createContact({ kind: 'person', displayName: '成员' });
    store.addToGroup(g.id, [p.id]);

    expect(() => store.removeFromGroup('no-such-group', [p.id])).toThrow(/group not found/);
    expect(() => store.removeFromGroup(g.id, ['no-such-contact'])).toThrow(/contact not found/);
    // 联系人存在但不在组内 → 幂等成功(与 add 的"已在组内幂等"对称)
    const outsider = store.createContact({ kind: 'person', displayName: '非成员' });
    expect(() => store.removeFromGroup(g.id, [outsider.id])).not.toThrow();
    // 正常移除仍生效
    store.removeFromGroup(g.id, [p.id]);
    expect(store.getContact(p.id).groups).toHaveLength(0);
  });
});
