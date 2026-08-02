/**
 * system-contacts — macOS 系统通讯录读取 + 回写(JXA / osascript)。
 *
 * 技术选型: 不引原生模块, 用 osascript -l JavaScript 批量拉取(JXA 的
 * `people.name()` 一次 Apple Event 返回全量数组, 几百条联系人 ~6 个事件,
 * 秒级完成; 逐条访问则是每属性一个事件, 不可用)。
 *
 * 权限: 首次调用触发系统"自动化"授权弹窗(控制"通讯录"); 拒绝后 osascript
 * 报 -1743, 映射成 PERMISSION_DENIED 让 UI 给引导文案。
 * 平台: 仅 darwin; Windows 走 vCard 导入通道(调用方负责 gate)。
 * 隐私: 数据只进本地 contacts.db, 不出机器。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  ImportContactRecord,
  SystemContactGroupSyncResult,
  SystemContactWriteItem,
  SystemContactWriteResult,
} from '@cindy/maker-core';

import { throwIpcError } from '../utils/ipcValidate.js';

const execFileAsync = promisify(execFile);

// 首次调用会触发系统"自动化"授权弹窗, osascript 会阻塞等用户点击 —
// 超时必须给足决策时间, 否则弹窗未点完进程先被 kill, 报错还误导成 INTERNAL
const OSA_TIMEOUT_MS = 180_000;

/**
 * JSON 内嵌进 JXA 源码的安全序列化: JSON.stringify 不转义 U+2028/U+2029,
 * 老 JSC 里行分隔符会截断字符串字面量(displayName 是 agent 可写内容) —
 * 显式转义消掉这个引擎版本依赖的注入边界。
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// 批量拉取脚本: 每个属性一次 whose-less 全量取数, 组装成 JSON 输出。
// emails/phones 是嵌套集合, JXA 对 elements-of-elements 的批量取值返回二维数组。
const JXA_SCRIPT = `
(() => {
  const Contacts = Application('Contacts');
  const people = Contacts.people;
  const names = people.name();
  const orgs = people.organization();
  const titles = people.jobTitle();
  const notes = people.note();
  const ids = people.id();
  const companies = people.company();
  const emailValues = people.emails.value();
  const emailLabels = people.emails.label();
  const phoneValues = people.phones.value();
  const phoneLabels = people.phones.label();
  const out = [];
  for (let i = 0; i < names.length; i++) {
    out.push({
      name: names[i] || '',
      org: orgs[i] || '',
      title: titles[i] || '',
      note: notes[i] || '',
      id: ids[i] || '',
      isCompany: !!companies[i],
      emails: (emailValues[i] || []).map((v, j) => ({ v: v || '', l: (emailLabels[i] || [])[j] || '' })),
      phones: (phoneValues[i] || []).map((v, j) => ({ v: v || '', l: (phoneLabels[i] || [])[j] || '' })),
    });
  }
  return JSON.stringify(out);
})()
`;

/** Apple 内部标签("_$!<Work>!$_")→ 简洁 label */
function cleanLabel(raw: string): string | undefined {
  const m = raw.match(/^_\$!<(.+)>!\$_$/);
  const label = (m ? m[1]! : raw).trim().toLowerCase();
  return label || undefined;
}

/** 读取 macOS 系统通讯录为导入记录. 非 darwin 抛 UNSUPPORTED_CAPABILITY */
export async function readSystemContacts(): Promise<ImportContactRecord[]> {
  if (process.platform !== 'darwin') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'system contacts read is macOS-only; use vCard import');
  }
  let stdout: string;
  try {
    const res = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', JXA_SCRIPT], {
      timeout: OSA_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // -1743: 用户未授权自动化控制"通讯录"
    if (msg.includes('-1743') || /not authori[sz]ed/i.test(msg)) {
      throwIpcError(
        'PERMISSION_DENIED',
        'not authorized to access Contacts — grant access in System Settings > Privacy & Security > Automation',
      );
    }
    throwIpcError('INTERNAL', `read system contacts failed: ${msg.slice(0, 300)}`);
  }

  let raw: Array<{
    name: string;
    org: string;
    title: string;
    note: string;
    id: string;
    isCompany: boolean;
    emails: Array<{ v: string; l: string }>;
    phones: Array<{ v: string; l: string }>;
  }>;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throwIpcError('INTERNAL', 'unexpected osascript output (not JSON)');
  }

  return raw
    .filter((p) => p.name.trim().length > 0)
    .map((p) => ({
      displayName: p.name.trim(),
      // Contacts.app 的"公司"卡片 → org 档案(否则商家/服务号会被建成人)
      ...(p.isCompany ? { kind: 'org' as const } : {}),
      emails: p.emails
        .filter((e) => e.v.trim())
        .map((e) => {
          const label = cleanLabel(e.l);
          return { value: e.v.trim(), ...(label ? { label } : {}) };
        }),
      phones: p.phones
        .filter((t) => t.v.trim())
        .map((t) => {
          const label = cleanLabel(t.l);
          return { value: t.v.trim(), ...(label ? { label } : {}) };
        }),
      ...(p.org.trim() ? { org: p.org.trim() } : {}),
      ...(p.title.trim() ? { title: p.title.trim() } : {}),
      ...(p.note.trim() ? { note: p.note.trim() } : {}),
      // CNContact identifier 作为增量同步/回写的对账锚
      ...(p.id.trim() ? { anchor: { platform: 'apple-contacts', value: p.id.trim() } } : {}),
    }));
}

// ── 回写(增/改, 永不删) ──────────────────────────────────────────────────

const MAX_WRITE_BATCH = 200;

/**
 * 把智能通讯录档案写进/更新到系统通讯录(仅 darwin)。
 * 语义: 带 appleId 的更新既有联系人(公司/职位覆写, 邮箱/电话只补缺不删),
 * 不带的新建(org 档案建成"公司"卡片)并返回新 id 供调用方回填锚点。
 * 系统侧永不删除任何字段或联系人。
 */
export async function writeSystemContacts(
  items: SystemContactWriteItem[],
): Promise<SystemContactWriteResult[]> {
  if (process.platform !== 'darwin') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'system contacts write is macOS-only');
  }
  if (items.length === 0) return [];
  if (items.length > MAX_WRITE_BATCH) {
    throwIpcError('INVALID_PARAMS', `write batch too large (> ${MAX_WRITE_BATCH})`);
  }

  // payload 以 JS 字面量内嵌(execFile 无 shell, 无注入面; jsonForScript 保证合法字面量,
  // 含 U+2028/U+2029 显式转义)
  const script = `
(() => {
  const Contacts = Application('Contacts');
  const items = ${jsonForScript(items)};
  const results = [];
  const createdRefs = [];
  for (const it of items) {
    let pushedPerson = null;
    try {
      let person = null;
      let action = '';
      if (it.appleId) {
        try { person = Contacts.people.byId(it.appleId); person.name(); } catch (e) { person = null; }
        if (!person) { results.push({ contactId: it.contactId, name: it.name, action: 'missing' }); continue; }
        action = 'updated';
      } else {
        person = it.isOrg
          ? Contacts.Person({ organization: it.name, company: true })
          : Contacts.Person({ firstName: it.name });
        Contacts.people.push(person);
        pushedPerson = person;
        action = 'created';
      }
      if (action === 'updated') {
        // kind 变化(person↔org)时同步 company 标记与对应姓名字段 — 否则档案里
        // 把人改成公司(或反向)再回写, 报 updated 但系统卡仍是旧类型
        let kindFlipped = false;
        try { kindFlipped = (person.company() === true) !== it.isOrg; } catch (e2) { kindFlipped = false; }
        if (kindFlipped) {
          try { person.company = it.isOrg; } catch (e2) { /* 字段不可写不阻断 */ }
        }
        // 姓名按单字段覆写语义回写(镜像新建路径; 与公司/职位覆写同级), 否则档案里
        // 改了显示名再回写, 结果报 updated 但系统卡片姓名纹丝不动。
        // person 卡: 新建路径只写 firstName, 更新同样写 firstName 并清空参与
        // 组合显示名的 last/middle(不清会拼出"新名 旧姓"的错误组合名)。
        // kind 翻转时即使名字没变也要重写一遍, 把名字落到新类型对应的字段上。
        if (it.name && (kindFlipped || person.name() !== it.name)) {
          if (it.isOrg) {
            person.organization = it.name;
            if (kindFlipped) {
              try { person.firstName = ''; person.lastName = ''; person.middleName = ''; } catch (e2) { /* 不阻断 */ }
            }
          } else {
            person.firstName = it.name;
            try { person.lastName = ''; person.middleName = ''; } catch (e2) { /* 字段不可写不阻断 */ }
            if (kindFlipped) {
              // org→person: 旧公司卡的 organization 是原公司名, 不清掉的话
              // 没有雇主关系的人会一直顶着老公司字段(下方仅在 it.org 存在时覆写)
              try { person.organization = ''; } catch (e2) { /* 不阻断 */ }
            }
          }
        }
      }
      if (it.org && !it.isOrg) person.organization = it.org;
      if (!it.isOrg) {
        if (it.title) {
          person.jobTitle = it.title;
        } else if (it.org && action === 'updated') {
          // 带雇主但无职位的更新: 清旧职位 — 否则换雇主后系统卡显示
          // "新公司 + 旧职位"的错配; 无雇主关系时不动既有 jobTitle(只增不删)
          try { person.jobTitle = ''; } catch (e2) { /* 不阻断 */ }
        }
      }
      const existingEmails = (person.emails ? person.emails.value() : []).map((v) => String(v).toLowerCase());
      for (const e of it.emails) {
        if (!existingEmails.includes(e.value.toLowerCase())) {
          person.emails.push(Contacts.Email({ label: e.label || 'work', value: e.value }));
        }
      }
      const norm = (v) => String(v).replace(/[^0-9+]/g, '');
      const existingPhones = (person.phones ? person.phones.value() : []).map(norm);
      for (const t of it.phones) {
        if (!existingPhones.includes(norm(t.value))) {
          person.phones.push(Contacts.Phone({ label: t.label || 'work', value: t.value }));
        }
      }
      if (action === 'created') {
        // 新建联系人的 identifier 以 save 之后读到的为准 — save 前的 id 未固化,
        // 拿去当锚点可能是死值, 下次回写会误判 missing 再建重复卡
        results.push({ contactId: it.contactId, name: it.name, action });
        createdRefs.push({ idx: results.length - 1, person });
      } else {
        results.push({ contactId: it.contactId, name: it.name, action, appleId: person.id() });
      }
      pushedPerson = null; // 本条全部字段写完, 不再需要回滚
    } catch (err) {
      // 新建路径中途失败(如邮箱/电话字段被拒): 已 push 进集合的半成品必须删掉 —
      // 否则末尾无条件 save() 会把无锚点的残卡持久化, 重试导出再建一张重复卡
      if (pushedPerson) {
        try { Contacts.delete(pushedPerson); } catch (e2) { /* 删不掉不阻断, 至少 error 已记录 */ }
      }
      results.push({ contactId: it.contactId, name: it.name, action: 'error', error: String(err).slice(0, 200) });
    }
  }
  Contacts.save();
  for (const ref of createdRefs) {
    try { results[ref.idx].appleId = ref.person.id(); } catch (err) { /* 无 id 则锚点留空, 不阻断 */ }
  }
  return JSON.stringify(results);
})()
`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: OSA_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim()) as SystemContactWriteResult[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('-1743') || /not authori[sz]ed/i.test(msg)) {
      throwIpcError(
        'PERMISSION_DENIED',
        'not authorized to access Contacts — grant access in System Settings > Privacy & Security > Automation',
      );
    }
    throwIpcError('INTERNAL', `write system contacts failed: ${msg.slice(0, 300)}`);
  }
}

// ── 系统通讯录分组(幂等创建 + 只增成员) ───────────────────────────────────

const MAX_GROUP_MEMBER_BATCH = 200;

/** 构造单次 JXA 分组写入；输入已经过 host 校验与去重。 */
function buildSystemContactGroupScript(groupName: string, appleIds: string[]): string {
  return `
(() => {
  const Contacts = Application('Contacts');
  const groupName = ${jsonForScript(groupName)};
  const appleIds = ${jsonForScript(appleIds)};
  const groupNames = Contacts.groups.name();
  let group = null;
  let created = false;
  const groupIndex = groupNames.findIndex((name) => String(name) === groupName);
  if (groupIndex >= 0) {
    group = Contacts.groups[groupIndex];
  } else {
    group = Contacts.Group({ name: groupName });
    Contacts.groups.push(group);
    Contacts.save();
    created = true;
  }

  const existingIds = new Set((group.people.id() || []).map((id) => String(id)));
  // 只把全量 id 快照中明确不存在的联系人归为 missing。读取 id、add 或 save 的
  // 权限/JXA 错误必须抛给 host，不能伪装成“联系人不存在”后成功退出。
  const allPersonIds = new Set((Contacts.people.id() || []).map((id) => String(id)));
  const missingAppleIds = [];
  let added = 0;
  let alreadyPresent = 0;
  for (const appleId of appleIds) {
    if (existingIds.has(appleId)) {
      alreadyPresent += 1;
      continue;
    }
    if (!allPersonIds.has(appleId)) {
      missingAppleIds.push(appleId);
      continue;
    }
    const person = Contacts.people.byId(appleId);
    // Contacts.sdef 把 group.people 标为只读；成员关系必须走应用级
    // add <entry> to <specifier> 命令，直接对 collection.push 会被拒。
    Contacts.add(person, { to: group });
    existingIds.add(appleId);
    added += 1;
  }
  if (added > 0) Contacts.save();
  return JSON.stringify({
    groupName,
    created,
    requested: appleIds.length,
    added,
    alreadyPresent,
    missingAppleIds,
  });
})()
`;
}

/**
 * 确保 macOS 通讯录存在指定分组，并把 appleIds 对应联系人加入其中。
 * 语义刻意只增不删：这个入口用于圈定“由 Cindy 管理”的联系人，绝不把
 * 系统分组里已有成员当作镜像差异擅自移除。空列表仍会创建/确认分组。
 */
export async function syncSystemContactGroup(
  rawGroupName: string,
  rawAppleIds: string[],
): Promise<SystemContactGroupSyncResult> {
  if (process.platform !== 'darwin') {
    throwIpcError('UNSUPPORTED_CAPABILITY', 'system contacts groups are macOS-only');
  }
  const groupName = rawGroupName.trim();
  if (!groupName || groupName.length > 60) {
    throwIpcError('INVALID_PARAMS', 'system contacts group name must be 1-60 characters');
  }
  const appleIds = [...new Set(rawAppleIds.map((id) => id.trim()).filter(Boolean))];
  if (appleIds.length > MAX_GROUP_MEMBER_BATCH) {
    throwIpcError(
      'INVALID_PARAMS',
      `system contacts group batch too large (> ${MAX_GROUP_MEMBER_BATCH})`,
    );
  }

  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', '-e', buildSystemContactGroupScript(groupName, appleIds)],
      { timeout: OSA_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as SystemContactGroupSyncResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('-1743') || /not authori[sz]ed/i.test(msg)) {
      throwIpcError(
        'PERMISSION_DENIED',
        'not authorized to manage Contacts groups — grant access in System Settings > Privacy & Security > Automation',
      );
    }
    throwIpcError('INTERNAL', `sync system contacts group failed: ${msg.slice(0, 300)}`);
  }
}
