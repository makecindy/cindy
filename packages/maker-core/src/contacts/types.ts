/**
 * Maker Contacts 类型层 — 智能通讯录(agent-native 人物实体库)的共享形状契约。
 *
 * 与 Maker Memory 的关系与差异:
 *  - Memory 是 per-workdir 的自由文本分片; Contacts 是**全局单库**(人不属于某个项目),
 *    结构化实体(人/组织) + 身份映射 + 事件流 + 分组, 存 SQLite(单一 source of truth,
 *    FTS 是同库派生索引), 不走 markdown 文件。
 *  - 核心价值是"身份反查": 任意平台标识(邮箱/飞书 id/Slack id/GitHub handle...) →
 *    完整人物卡, 解决 agent 每次跨平台找人都要重新考古的问题。
 *
 * 设计取舍:
 *  - kind 只分 person / org — 公司/团队与人是平级实体(参照用户 obsidian 的
 *    Friends/ + Companies.md 双轨结构), 关系边(任职/家人等)留给后续版本。
 *  - status 区分 confirmed / pending: agent 低置信写入先进 pending(待确认队列),
 *    用户在设置 UI 裁决后转正 — 不确定的信息不污染正册。
 *  - narrative 是自由 markdown 的"关系叙事", 不拆死字段 — 人物背景本质是叙事不是表格;
 *    events 是 append-only 带日期事件流, 信息可过期可追溯, 不静默覆盖。
 *  - identity 的 (platform, normalizedValue) 全局唯一 — 一个邮箱只能属于一个人,
 *    撞上时报 identity-conflict 并带出已有 contact, 引导调用方走 merge 而不是硬塞。
 */

export const CONTACT_KINDS = ['person', 'org'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export function isContactKind(v: unknown): v is ContactKind {
  return typeof v === 'string' && (CONTACT_KINDS as readonly string[]).includes(v);
}

export const CONTACT_STATUSES = ['confirmed', 'pending'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export function isContactStatus(v: unknown): v is ContactStatus {
  return typeof v === 'string' && (CONTACT_STATUSES as readonly string[]).includes(v);
}

/** 条目来源 — manual: 用户在 UI 手工建; agent: agent 会话中沉淀; import: 批量导入 */
export const CONTACT_SOURCES = ['manual', 'agent', 'import'] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export function isContactSource(v: unknown): v is ContactSource {
  return typeof v === 'string' && (CONTACT_SOURCES as readonly string[]).includes(v);
}

/**
 * 身份平台标识 — 常见平台给出建议值, 但存储层接受任意 [a-z0-9_-]{1,32} 字符串
 * (新平台接入不需要改枚举)。归一化规则见 normalizeIdentityValue。
 */
export const WELL_KNOWN_PLATFORMS = [
  'email',
  'phone',
  'feishu',
  'slack',
  'github',
  'gitlab',
  'wechat',
  'x',
  'telegram',
  'discord',
] as const;

/** 联系人实体(主表行) */
export interface ContactEntity {
  /** uuid */
  id: string;
  kind: ContactKind;
  /** 显示名, 可中英文 */
  displayName: string;
  /** 别名/曾用名/昵称列表 */
  aliases: string[];
  /** 一行简介, 用于列表与检索结果 */
  summary: string;
  /** 关系叙事(markdown 自由文本): 与用户的关系、背景、协作历史 */
  narrative: string;
  /** 给 agent 的处置指令, e.g. "这是老板私人邮箱, 勿群发" */
  agentNotes: string;
  status: ContactStatus;
  source: ContactSource;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

/** 身份映射行 — 整个系统的枢纽, (platform, normalizedValue) 全局唯一 */
export interface ContactIdentity {
  /** uuid */
  id: string;
  contactId: string;
  /** 平台标识, 小写 [a-z0-9_-]{1,32} */
  platform: string;
  /** 原样保存的值(展示用) */
  value: string;
  /** 归一化值(匹配用): trim + 小写 */
  normalizedValue: string;
  /** 标签, e.g. "当前" / "云岚早期" / "个人" */
  label: string;
  /** 来源备注 */
  note: string;
  createdAt: string;
}

/** 带日期的事件流条目(append-only) */
export interface ContactEvent {
  /** uuid */
  id: string;
  contactId: string;
  /** 事件日期 YYYY-MM-DD(允许仅到月 YYYY-MM) */
  date: string;
  text: string;
  /** 信息来源, e.g. "session" / "email" / "manual" */
  source: string;
  createdAt: string;
}

/** 分组 */
export interface ContactGroup {
  /** uuid */
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface ContactGroupWithCount extends ContactGroup {
  memberCount: number;
}

/**
 * 关系边(有向): from --relation--> to。
 * 典型: 人 --任职--> 组织(note=职位)、人 --家人--> 人、组织 --子公司--> 组织。
 * (from_id, to_id, relation) 唯一; 展示时双向可见(对端以 direction:'in' 呈现)。
 */
export interface ContactRelation {
  /** uuid */
  id: string;
  fromId: string;
  toId: string;
  /** 关系动词, 自由字符串, e.g. "任职" / "成员" / "家人" / "介绍人" */
  relation: string;
  /** 补充说明, e.g. 职位 "执行办" */
  note: string;
  createdAt: string;
}

/** 档案上呈现的关联对端(含双向): direction 'out' = 本人指向对方, 'in' = 对方指向本人 */
export interface RelatedContactRef {
  relationId: string;
  contactId: string;
  displayName: string;
  kind: ContactKind;
  relation: string;
  note: string;
  direction: 'out' | 'in';
}

/** 完整人物卡(get / resolve 返回) */
export interface ContactProfile extends ContactEntity {
  identities: ContactIdentity[];
  /** 按事件日期倒序 */
  events: ContactEvent[];
  groups: ContactGroup[];
  /** 关联(双向): 所属组织 / 成员 / 相关人物 */
  relations: RelatedContactRef[];
}

/** 列表行(list 返回, 不带 narrative/events 全文, 控制传输体积) */
export interface ContactSummary {
  id: string;
  kind: ContactKind;
  displayName: string;
  aliases: string[];
  summary: string;
  status: ContactStatus;
  source: ContactSource;
  identityCount: number;
  updatedAt: string;
}

// ── 写入入参 ──────────────────────────────────────────────────────────────

export interface CreateContactInput {
  kind: ContactKind;
  displayName: string;
  aliases?: string[];
  summary?: string;
  narrative?: string;
  agentNotes?: string;
  status?: ContactStatus;
  source?: ContactSource;
  /** 随建档一并挂上的身份 */
  identities?: Array<{
    platform: string;
    value: string;
    label?: string;
    note?: string;
  }>;
}

/** patch 语义: 只更新显式给出的字段; aliases 整组替换 */
export interface UpdateContactInput {
  /** 修正错档类型(公司被建成人/反之) */
  kind?: ContactKind;
  displayName?: string;
  aliases?: string[];
  summary?: string;
  narrative?: string;
  agentNotes?: string;
  status?: ContactStatus;
}

export interface AddIdentityInput {
  platform: string;
  value: string;
  label?: string;
  note?: string;
}

export interface AddRelationInput {
  /** 对端 contact id */
  toId: string;
  /** 关系动词, 1..maxRelationLen 字符 */
  relation: string;
  note?: string;
}

export interface AppendEventInput {
  /** YYYY-MM-DD 或 YYYY-MM */
  date: string;
  text: string;
  source?: string;
}

export interface ListContactsOptions {
  kind?: ContactKind;
  status?: ContactStatus;
  groupId?: string;
  /** 默认 50, 上限 200 */
  limit?: number;
  offset?: number;
}

export interface ResolveOptions {
  /** 限定平台; 缺省跨平台匹配 */
  platform?: string;
  /** 默认 5, 上限 20 */
  limit?: number;
}

/** resolve 命中 — matchType 说明命中路径, 供调用方判断置信度 */
export interface ResolveHit {
  /** 'identity': (platform,value) 精确命中; 'name': 显示名/别名精确命中; 'fts': 全文兜底 */
  matchType: 'identity' | 'name' | 'fts';
  /** identity 命中时带上命中的那条身份 */
  identity?: ContactIdentity;
  profile: ContactProfile;
}

export interface ContactsSearchOptions {
  kind?: ContactKind;
  status?: ContactStatus;
  /** 限定分组成员内检索(SQL 层过滤, 在 LIMIT 之前生效 — 客户端后过滤会被全局 top-N 挤掉组内命中) */
  groupId?: string;
  /** 默认 10, 上限 50 */
  limit?: number;
}

/** FTS 检索命中 */
export interface ContactsSearchHit {
  contactId: string;
  kind: ContactKind;
  displayName: string;
  summary: string;
  status: ContactStatus;
  /** FTS5 snippet() 高亮片段 */
  snippet: string;
  /** bm25, 越小越相关 */
  score: number;
}

/** findSimilar 命中的疑似同人候选 */
export interface DuplicateCandidate {
  /** 'identity': 平台身份精确撞(= 同一个人); 'name': 名字/别名相似(疑似, 需确认) */
  matchType: 'identity' | 'name';
  contactId: string;
  displayName: string;
  kind: ContactKind;
  status: ContactStatus;
  summary: string;
  /** identity 命中时撞上的那条身份 */
  matchedIdentity?: { platform: string; value: string };
}

/** enrichContact(把新采集信息并入已有档案)的结果 */
export interface EnrichResult {
  ok: true;
  contactId: string;
  /** 本次新增的别名 */
  addedAliases: string[];
  addedIdentities: number;
  /** 因归属它人(conflict-other)/已存在(already-exists)/本身非法或超限(invalid)而跳过的身份; conflict-other 时带占用者 contactId(调用方可引导 merge / 更新那份档案) */
  skippedIdentities: Array<{
    platform: string;
    value: string;
    reason: 'conflict-other' | 'already-exists' | 'invalid';
    conflictContactId?: string;
  }>;
  /** 由空值被填充的字段名 */
  filledFields: string[];
  narrativeAppended: boolean;
}

/** 全库疑似重复对(维护扫描) */
export interface DuplicatePair {
  aId: string;
  aName: string;
  aKind: ContactKind;
  bId: string;
  bName: string;
  bKind: ContactKind;
}

export interface MergeResult {
  ok: true;
  /** 合并后保留的 contact */
  targetId: string;
  /** 被并入并删除的 contact */
  mergedId: string;
  movedIdentities: number;
  movedEvents: number;
  /** 叙事拼接超 maxNarrativeBytes 被截断(target 全文保留, source 段从尾部截) */
  narrativeTruncated?: boolean;
}

// ── 批量导入(系统通讯录 / vCard) ─────────────────────────────────────────

/** 归一化后的外部联系人记录(vCard 解析 / 系统通讯录读取的公共形状) */
export interface ImportContactRecord {
  displayName: string;
  /** 'org' = 来源标记为公司卡片(Apple company 标记 / vCard KIND:org); 缺省按 person */
  kind?: ContactKind;
  emails: Array<{ value: string; label?: string }>;
  phones: Array<{ value: string; label?: string }>;
  /** 邮箱/电话之外的平台身份(vCard X-XDMAKER-* 扩展回读), export→import 不丢身份 */
  identities?: Array<{ platform: string; value: string; label?: string }>;
  /** 公司/组织名(导入时自动建 org + 任职关系) */
  org?: string;
  /** 职位(进任职关系的 note) */
  title?: string;
  note?: string;
  /** vCard CATEGORIES 回读的分组名(导入时按名 find-or-create 并归组), export→import 分组不丢 */
  groups?: string[];
  /** 源系统锚点身份(增量同步/回写的对账锚), e.g. {platform:'apple-contacts', value:<id>} */
  anchor?: { platform: string; value: string };
}

export interface ImportContactsOptions {
  /** 导入完成后把新建/富集的条目加入该分组 */
  groupId?: string;
  /** 新建条目的来源标记, 默认 'import' */
  source?: ContactSource;
}

export interface ImportSummary {
  /** 新建的人数 */
  created: number;
  /** 身份撞档自动并入既有档案的条数 */
  enriched: number;
  /** 名字相似需人工确认的(未创建, 带候选名) */
  needsReview: Array<{ displayName: string; candidates: string[] }>;
  /** 无效跳过(空名等) */
  skipped: Array<{ displayName: string; reason: string }>;
  orgsCreated: number;
  relationsAdded: number;
  /**
   * enrich 并入时撞上"身份已属其他联系人"(conflict-other)的记录 — 提示两份
   * 档案疑似同人, 驱动后续 merge 裁决; 不收集的话冲突随 enrich 返回值静默蒸发
   */
  identityConflicts: Array<{ displayName: string; platform: string; value: string; conflictContactId: string }>;
  /** 任职关系建边失败(重复以外的错误): 档案本体已导入, 但 employer/title 关系被跳过 */
  relationErrors: Array<{ displayName: string; org: string; reason: string }>;
}

/** 回写系统通讯录的单条计划(只含结构化公开字段) */
export interface SystemContactWriteItem {
  /** 智能通讯录侧 contact id(结果回填锚点用) */
  contactId: string;
  name: string;
  isOrg: boolean;
  /** 已有锚点(apple-contacts 身份)→ 更新该系统联系人; 缺省 → 新建 */
  appleId?: string;
  org?: string;
  title?: string;
  emails: Array<{ value: string; label?: string }>;
  phones: Array<{ value: string; label?: string }>;
}

export interface SystemContactWriteResult {
  contactId: string;
  name: string;
  action: 'created' | 'updated' | 'missing' | 'error';
  /** created 时的系统联系人 id(回填锚点) */
  appleId?: string;
  error?: string;
}

export interface ContactsStats {
  people: number;
  orgs: number;
  pending: number;
  groups: number;
}

// ── 配置与错误 ────────────────────────────────────────────────────────────

export interface ContactsConfig {
  /** displayName 长度上限, 默认 100 */
  maxDisplayNameLen: number;
  /** summary 长度上限, 默认 300 */
  maxSummaryLen: number;
  /** narrative 字节上限, 默认 16384 */
  maxNarrativeBytes: number;
  /** agentNotes 长度上限, 默认 1000 */
  maxAgentNotesLen: number;
  /** 单条事件文本长度上限, 默认 1000 */
  maxEventTextLen: number;
  /** aliases 数量上限, 默认 20 */
  maxAliases: number;
  /** 单人身份数量上限, 默认 30 */
  maxIdentitiesPerContact: number;
  /** 单条身份值长度上限, 默认 320(超长值会打爆系统回写的 osascript 参数与 FTS 行) */
  maxIdentityValueLen: number;
  /** 分组名长度上限, 默认 60 */
  maxGroupNameLen: number;
  /** 关系动词长度上限, 默认 30 */
  maxRelationLen: number;
}

export const DEFAULT_CONTACTS_CONFIG: ContactsConfig = {
  maxDisplayNameLen: 100,
  maxSummaryLen: 300,
  maxNarrativeBytes: 16384,
  maxAgentNotesLen: 1000,
  maxEventTextLen: 1000,
  maxAliases: 20,
  maxIdentitiesPerContact: 30,
  maxIdentityValueLen: 320,
  maxGroupNameLen: 60,
  maxRelationLen: 30,
};

export type ContactsErrorCode =
  | 'invalid-params'
  | 'not-found'
  | 'already-exists'
  /** (platform, value) 已挂在另一个 contact 上 — message 里带 existing contact id */
  | 'identity-conflict'
  | 'io-error';

export class ContactsError extends Error {
  constructor(
    public readonly code: ContactsErrorCode,
    message: string,
    /** identity-conflict 时带出占用该身份的 contact id, 引导调用方 merge */
    public readonly conflictContactId?: string,
  ) {
    super(`contacts:${code} ${message}`);
    this.name = 'ContactsError';
  }
}

// ── 归一化 helper(store 与调用方共用, 保证匹配语义一致) ──────────────────

/** platform 归一化: trim + 小写; 校验 [a-z0-9_-]{1,32} */
export function normalizePlatform(platform: string): string {
  const p = platform.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(p)) {
    throw new ContactsError('invalid-params', `invalid platform: ${platform}`);
  }
  return p;
}

/**
 * 身份值归一化(匹配键): trim + 小写。邮箱/handle 大小写不敏感是共识;
 * 极少数大小写敏感的平台 id 牺牲一点精确性换取"永远查得到"。
 * 附带剥掉 handle 惯用前缀 @(存储 value 保留原样, 只影响匹配键)。
 *
 * platform 为 phone 时按电话语义规范化: 剥掉全部格式字符只留数字与 + —
 * "+1 (555) 123-4567" 与 "+15551234567" 是同一号码, 不规范化会在导入/resolve
 * 漏配身份、建重复档案(系统回写侧 JXA 早已按剥数字比对, 两侧口径对齐);
 * 剥完没有数字的畸形值回落通用归一化, 不产生空匹配键。
 */
export function normalizeIdentityValue(value: string, platform?: string): string {
  let v = value.trim().toLowerCase();
  if (v.startsWith('@')) v = v.slice(1);
  if (platform && platform.trim().toLowerCase() === 'phone') {
    const canonical = v.replace(/[^0-9+]/g, '');
    if (canonical.replace(/\+/g, '').length > 0) return canonical;
  }
  return v;
}
