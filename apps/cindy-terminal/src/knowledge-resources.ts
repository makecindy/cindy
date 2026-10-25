import path from 'node:path';
import { z } from 'zod';
import type { RemoteResourceRegistry, RemoteText, RemoteCollectionItem, RemoteActionField, RemoteResource, RemoteActionDescriptor } from '@cindy/device-link';
import type { MemoryRecord, ContactProfile } from '@cindy/maker-core';
import type { TerminalKnowledge } from './knowledge.js';

const copy = {
  memory: ['Memory', '记忆', '記憶', 'メモリ', '메모리'], contacts: ['Contacts', '通讯录', '通訊錄', '連絡先', '연락처'],
  settings: ['Settings', '设置', '設定', '設定', '설정'], agentAccess: ['Allow agent access', '允许 Agent 使用', '允許 Agent 使用', 'エージェントのアクセスを許可', '에이전트 접근 허용'],
  create: ['Add', '添加', '新增', '追加', '추가'], edit: ['Edit', '编辑', '編輯', '編集', '편집'], remove: ['Delete', '删除', '刪除', '削除', '삭제'],
  confirm: ['Delete this record?', '删除这条记录？', '刪除這筆記錄？', 'この記録を削除しますか？', '이 기록을 삭제할까요?'],
  title: ['Title', '标题', '標題', 'タイトル', '제목'], name: ['Name', '名称', '名稱', '名前', '이름'],
  slug: ['File name', '文件名', '檔案名稱', 'ファイル名', '파일 이름'], summary: ['Summary', '简介', '簡介', '概要', '요약'],
  body: ['Content', '内容', '內容', '内容', '내용'], directory: ['Working directory', '工作目录', '工作目錄', '作業ディレクトリ', '작업 디렉터리'],
  type: ['Type', '类型', '類型', '種類', '유형'], user: ['User', '用户', '使用者', 'ユーザー', '사용자'],
  feedback: ['Feedback', '反馈', '回饋', 'フィードバック', '피드백'], project: ['Project', '项目', '專案', 'プロジェクト', '프로젝트'],
  reference: ['Reference', '参考', '參考', '参照', '참조'], person: ['Person', '个人', '個人', '個人', '개인'],
  org: ['Organization', '组织', '組織', '組織', '조직'], status: ['Status', '状态', '狀態', '状態', '상태'],
  confirmed: ['Confirmed', '已确认', '已確認', '確認済み', '확인됨'], pending: ['Pending', '待确认', '待確認', '未確認', '확인 대기'],
  notes: ['Agent notes', 'Agent 备注', 'Agent 備註', 'エージェント向けメモ', '에이전트 메모'],
  aliases: ['Aliases (one per line)', '别名（每行一个）', '別名（每行一個）', '別名（1 行に 1 つ）', '별칭 (한 줄에 하나)'],
  identity: ['Add identity', '添加身份', '新增身分', '識別情報を追加', '식별 정보 추가'],
  platform: ['Platform', '平台', '平台', 'プラットフォーム', '플랫폼'], value: ['Value', '标识', '識別資訊', '識別情報', '식별자'],
  label: ['Label', '标签', '標籤', 'ラベル', '라벨'], event: ['Add event', '添加事件', '新增事件', '出来事を追加', '이벤트 추가'],
  date: ['Date (YYYY-MM-DD)', '日期（YYYY-MM-DD）', '日期（YYYY-MM-DD）', '日付（YYYY-MM-DD）', '날짜 (YYYY-MM-DD)'],
  removeIdentity: ['Remove identity', '移除身份', '移除身分', '識別情報を削除', '식별 정보 삭제'],
  groups: ['Contact groups', '通讯录分组', '通訊錄群組', '連絡先グループ', '연락처 그룹'], group: ['Group', '分组', '群組', 'グループ', '그룹'],
  addGroup: ['Add to group', '加入分组', '加入群組', 'グループに追加', '그룹에 추가'], removeGroup: ['Remove from group', '移出分组', '移出群組', 'グループから削除', '그룹에서 제거'],
} as const;
type Key = keyof typeof copy;
function t(key: Key): RemoteText { const [fallback, cn, tw, ja, ko] = copy[key]; return { fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko } }; }
const text = (id: string, label: Key, kind: RemoteActionField['kind'] = 'text', required = false): RemoteActionField => ({ id, label: t(label), kind, required });
const select = (id: string, label: Key, keys: Key[]): RemoteActionField => ({ ...text(id, label, 'select', true), options: keys.map(value => ({ value, label: t(value) })) });
const del: RemoteActionDescriptor = { id: 'delete', label: t('remove'), tone: 'destructive', confirmation: { title: t('confirm'), confirmLabel: t('remove') } };
const form = (actionId: string, values: Record<string, unknown>) => ({ id: actionId, primitive: 'form', fallbackMarkdown: '', data: { actionId, values } });
function page<T>(items: T[], cursor?: string, limit = 100) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new Error('INVALID_CURSOR');
  const end = offset + Math.min(200, Math.max(1, limit));
  return { items: items.slice(offset, end), ...(end < items.length ? { nextCursor: String(end) } : {}) };
}
const memoryFields = [select('type', 'type', ['user', 'feedback', 'project', 'reference']), text('name', 'slug', 'text', true), text('title', 'title', 'text', true), text('description', 'summary', 'text', true), text('body', 'body', 'multiline', true)];
const contactFields = [text('displayName', 'name', 'text', true), select('kind', 'type', ['person', 'org']), text('summary', 'summary'), text('narrative', 'body', 'multiline'), text('agentNotes', 'notes', 'multiline'), text('aliases', 'aliases', 'multiline'), select('status', 'status', ['confirmed', 'pending'])];
const memoryInput = z.object({ type: z.enum(['user', 'feedback', 'project', 'reference']), name: z.string().regex(/^[a-z0-9_-]{1,64}$/), title: z.string().min(1).max(100), description: z.string().min(1).max(200), body: z.string().min(1) });
const contactInput = z.object({ displayName: z.string().trim().min(1), kind: z.enum(['person', 'org']), summary: z.string().default(''), narrative: z.string().default(''), agentNotes: z.string().default(''), aliases: z.string().default('').transform(value => value.split('\n').map(item => item.trim()).filter(Boolean)), status: z.enum(['confirmed', 'pending']) });

/** Existing remote resources are the common management surface for GUI/TUI. */
export function registerKnowledgeResources(registry: RemoteResourceRegistry, knowledge: TerminalKnowledge) {
  const ensure = async (check?: () => void) => { await knowledge.ready; knowledge.guard(); check?.(); };
  const memoryRows = async () => {
    const rows: Array<{ id: string; scope: string; record: MemoryRecord }> = [];
    for (const { id, scope } of await knowledge.scopes()) {
      const records = await (await knowledge.memory.getStore(scope, { skipDisabledCheck: true })).list();
      for (const record of records) rows.push({ id: `${id}:${record.filename}`, scope, record });
    }
    knowledge.guard(); return rows;
  };
  const memoryItem = (row: Awaited<ReturnType<typeof memoryRows>>[number]): RemoteCollectionItem => ({
    ref: { collectionId: 'memory', kind: 'memory', id: row.id }, links: [], revision: row.record.frontmatter.updatedAt,
    display: { title: row.record.frontmatter.title, subtitle: row.scope }, actions: [{ id: 'edit', label: t('edit'), fields: memoryFields.slice(2) }, del],
  });
  registry.register({
    collection: { id: 'memory', resourceKind: 'memory', title: t('memory'), placement: 'settings', actions: [
      { id: 'create', label: t('create'), fields: [text('workingDir', 'directory', 'text', true), ...memoryFields] },
      { id: 'settings', label: t('settings'), fields: [text('enabled', 'agentAccess', 'toggle', true)] },
    ] },
    list: async (context, request) => {
      await ensure(context.assertCurrent); const rows = await memoryRows(); await ensure(context.assertCurrent);
      const query = request.query?.trim().toLowerCase();
      return { collectionId: 'memory', revision: JSON.stringify(knowledge.snapshot()), ...page(rows.filter(row => !query || `${row.record.frontmatter.title}\n${row.record.body}\n${row.scope}`.toLowerCase().includes(query)).map(memoryItem), request.cursor, request.limit) };
    },
    get: async (context, request) => {
      await ensure(context.assertCurrent); const row = (await memoryRows()).find(row => row.id === request.ref.id); if (!row) throw new Error('MEMORY_NOT_FOUND');
      await ensure(context.assertCurrent);
      return { ...memoryItem(row), blocks: [{ id: 'body', primitive: 'text', fallbackMarkdown: row.record.body }, form('edit', { title: row.record.frontmatter.title, description: row.record.frontmatter.description, body: row.record.body, expectedUpdatedAt: row.record.frontmatter.updatedAt })] };
    },
    invoke: async (context, request) => {
      await ensure(context.assertCurrent);
      if (request.actionId === 'settings') await knowledge.configure({ memory: z.boolean().parse(request.input?.enabled) }, context.assertCurrent);
      else if (request.actionId === 'create') {
        const input = memoryInput.parse(request.input); const dir = z.string().refine(path.isAbsolute).parse(request.input?.workingDir);
        const { resolveMemoryScopeKey } = await import('@cindy/maker-core'); const scope = await resolveMemoryScopeKey(dir);
        await ensure(context.assertCurrent); const store = await knowledge.memory.getStore(scope, { skipDisabledCheck: true });
        await ensure(context.assertCurrent); await store.write({ ...input, mode: 'create' });
      } else {
        const row = (await memoryRows()).find(row => row.id === request.resourceRef?.id); if (!row) throw new Error('MEMORY_NOT_FOUND');
        const store = await knowledge.memory.getStore(row.scope, { skipDisabledCheck: true }); await ensure(context.assertCurrent);
        if (request.actionId === 'delete') await store.delete(row.record.filename, row.record.frontmatter.updatedAt);
        else if (request.actionId === 'edit') {
          const input = z.object({ title: z.string().min(1), description: z.string().min(1), body: z.string().min(1), expectedUpdatedAt: z.string().optional() }).parse(request.input);
          if (input.expectedUpdatedAt && input.expectedUpdatedAt !== row.record.frontmatter.updatedAt) throw new Error('MEMORY_CHANGED');
          await store.update(row.record.filename, row.record.frontmatter.updatedAt, { title: input.title, description: input.description, body: input.body });
        } else throw new Error('INVALID_ACTION');
      }
      await ensure(context.assertCurrent); return { effects: [{ kind: 'refresh-collection', collectionId: 'memory' }] };
    },
  });
  const contactItem = (contact: Pick<ContactProfile, 'id' | 'displayName' | 'summary' | 'updatedAt'>): RemoteCollectionItem => ({ ref: { collectionId: 'contacts', kind: 'contact', id: contact.id }, links: [], revision: contact.updatedAt, display: { title: contact.displayName, subtitle: contact.summary } });
  registry.register({
    collection: { id: 'contacts', resourceKind: 'contact', title: t('contacts'), placement: 'settings', actions: [
      { id: 'create', label: t('create'), fields: contactFields }, { id: 'settings', label: t('settings'), fields: [text('enabled', 'agentAccess', 'toggle', true)] },
    ] },
    list: async (context, request) => {
      await ensure(context.assertCurrent); const store = knowledge.contacts.getStore(); const offset = request.cursor ? Number(request.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('INVALID_CURSOR');
      const limit = Math.min(request.limit ?? 100, 200); const query = request.query?.trim();
      const found = query ? store.search(query, { limit: 200 }).map(hit => store.getContact(hit.contactId)) : store.listContacts({ offset, limit });
      const result = query ? page<Pick<ContactProfile, 'id' | 'displayName' | 'summary' | 'updatedAt'>>(found, request.cursor, limit) : { items: found, ...(found.length === limit ? { nextCursor: String(offset + limit) } : {}) };
      return { collectionId: 'contacts', revision: JSON.stringify(knowledge.snapshot()), ...result, items: result.items.map(contactItem) };
    },
    get: async (context, request): Promise<RemoteResource> => {
      await ensure(context.assertCurrent); const store = knowledge.contacts.getStore(); const contact = store.getContact(request.ref.id);
      const actions: RemoteActionDescriptor[] = [
        { id: 'edit', label: t('edit'), fields: contactFields },
        { id: 'identity', label: t('identity'), fields: [text('platform', 'platform', 'text', true), text('value', 'value', 'text', true), text('label', 'label')] },
        { id: 'event', label: t('event'), fields: [text('date', 'date', 'text', true), text('text', 'body', 'multiline', true)] },
      ];
      if (contact.identities.length) actions.push({ id: 'remove-identity', label: t('removeIdentity'), fields: [{ ...text('id', 'value', 'select', true), options: contact.identities.map(identity => ({ value: identity.id, label: `${identity.platform}: ${identity.value}` })) }] });
      const groups = store.listGroups();
      if (groups.length) actions.push({ id: 'add-group', label: t('addGroup'), fields: [{ ...text('id', 'group', 'select', true), options: groups.map(group => ({ value: group.id, label: group.name })) }] });
      if (contact.groups.length) actions.push({ id: 'remove-group', label: t('removeGroup'), fields: [{ ...text('id', 'group', 'select', true), options: contact.groups.map(group => ({ value: group.id, label: group.name })) }] });
      actions.push(del);
      return { ...contactItem(contact), actions, blocks: [
        { id: 'body', primitive: 'text', fallbackMarkdown: [contact.summary, contact.narrative, contact.identities.map(item => `${item.platform}: ${item.value}`).join('\n'), contact.events.map(event => `${event.date} ${event.text}`).join('\n')].filter(Boolean).join('\n\n') },
        form('edit', { ...contact, aliases: contact.aliases.join('\n'), expectedUpdatedAt: contact.updatedAt }),
      ] };
    },
    invoke: async (context, request) => {
      await ensure(context.assertCurrent); const store = knowledge.contacts.getStore();
      if (request.actionId === 'settings') await knowledge.configure({ contacts: z.boolean().parse(request.input?.enabled) }, context.assertCurrent);
      else if (request.actionId === 'create') store.createContact({ ...contactInput.parse(request.input), source: 'manual' });
      else {
        const contact = store.getContact(z.string().parse(request.resourceRef?.id));
        if (request.actionId === 'edit') {
          if (request.input?.expectedUpdatedAt && request.input.expectedUpdatedAt !== contact.updatedAt) throw new Error('CONTACT_CHANGED');
          store.updateContact(contact.id, contactInput.parse(request.input));
        } else if (request.actionId === 'delete') store.deleteContact(contact.id);
        else if (request.actionId === 'identity') store.addIdentity(contact.id, z.object({ platform: z.string().min(1), value: z.string().min(1), label: z.string().default('') }).parse(request.input));
        else if (request.actionId === 'remove-identity') { const id = z.string().parse(request.input?.id); if (!contact.identities.some(item => item.id === id)) throw new Error('IDENTITY_NOT_FOUND'); store.removeIdentity(id); }
        else if (request.actionId === 'event') store.appendEvent(contact.id, { ...z.object({ date: z.string().min(1), text: z.string().min(1) }).parse(request.input), source: 'manual' });
        else if (request.actionId === 'add-group') store.addToGroup(z.string().parse(request.input?.id), [contact.id]);
        else if (request.actionId === 'remove-group') store.removeFromGroup(z.string().parse(request.input?.id), [contact.id]);
        else throw new Error('INVALID_ACTION');
      }
      await ensure(context.assertCurrent); return { effects: [{ kind: 'refresh-collection', collectionId: 'contacts' }] };
    },
  });
  registry.register({
    collection: { id: 'contact-groups', resourceKind: 'contact-group', title: t('groups'), placement: 'settings', actions: [{ id: 'create', label: t('create'), fields: [text('name', 'name', 'text', true), text('description', 'summary')] }] },
    list: async context => { await ensure(context.assertCurrent); return { collectionId: 'contact-groups', revision: '1', items: knowledge.contacts.getStore().listGroups().map(group => ({ ref: { collectionId: 'contact-groups', kind: 'contact-group', id: group.id }, links: [], revision: group.createdAt, display: { title: group.name, subtitle: String(group.memberCount) } })) }; },
    get: async (context, request) => { await ensure(context.assertCurrent); const group = knowledge.contacts.getStore().listGroups().find(item => item.id === request.ref.id); if (!group) throw new Error('GROUP_NOT_FOUND'); return { ref: request.ref, links: [], revision: group.createdAt, display: { title: group.name }, actions: [{ id: 'edit', label: t('edit'), fields: [text('name', 'name', 'text', true), text('description', 'summary')] }, del], blocks: [form('edit', { ...group })] }; },
    invoke: async (context, request) => { await ensure(context.assertCurrent); const store = knowledge.contacts.getStore(); if (request.actionId === 'delete') store.deleteGroup(z.string().parse(request.resourceRef?.id)); else { const input = z.object({ name: z.string().min(1), description: z.string().default('') }).parse(request.input); if (request.actionId === 'create') store.createGroup(input.name, input.description); else if (request.actionId === 'edit') store.updateGroup(z.string().parse(request.resourceRef?.id), input); else throw new Error('INVALID_ACTION'); } return { effects: [{ kind: 'refresh-collection', collectionId: 'contact-groups' }] }; },
  });
}
