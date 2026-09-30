import { createHash } from 'node:crypto';
import type { RemoteActionInvokeResponse, RemoteLocalizedText, RemoteResource, RemoteResourceBlock } from '@cindy/device-link';
import {
  BOT_MEMORY_TYPES,
  type BotMemoryDeleteInput,
  type BotMemoryDetail,
  type BotMemorySummary,
  type BotMemoryType,
  type BotMemoryUpdateInput,
} from '../../../shared/botMemory.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import { RemoteResourceRegistryError, type RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import type { createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

/** The same service instance the local settings page uses (serialization + refresh coalescing). */
export interface BotRemoteMemoryService {
  list(botId: string, query?: string): Promise<BotMemorySummary[]>;
  read(botId: string, filename: string): Promise<BotMemoryDetail>;
  update(input: BotMemoryUpdateInput): Promise<BotMemoryDetail>;
  delete(input: BotMemoryDeleteInput): Promise<void>;
}
export interface BotRemoteMemoryDeps {
  owner(): string;
  assertOwner(owner: string): void;
  memory: BotRemoteMemoryService;
}
export interface BotRemoteMemoryRequest {
  botId: string;
  botName: string;
  /** Entry segment of `settings:<botId>/memory/<entry>`; absent for the list. */
  entry?: string;
  locale?: string;
  query?: string;
  primitives: readonly string[];
}

const text = (fallback: string, cn: string, tw: string, ja: string, ko: string): RemoteLocalizedText =>
  ({ fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko } });
export const memoryCopy = {
  memories: text('Saved Memories', '已存记忆', '已存記憶', '保存した記憶', '저장된 기억'),
  search: text('Search memories', '搜索记忆', '搜尋記憶', '記憶を検索', '기억 검색'),
  types: {
    user: text('About you', '关于你', '關於你', 'あなたについて', '나에 대해'),
    feedback: text('Your preferences', '你的要求', '你的要求', 'あなたの要望', '요청 사항'),
    project: text('Projects', '项目', '專案', 'プロジェクト', '프로젝트'),
    reference: text('References', '参考', '參考', '参考', '참고'),
  } satisfies Record<BotMemoryType, RemoteLocalizedText>,
  edit: text('Edit', '编辑', '編輯', '編集', '편집'),
  title: text('Title', '标题', '標題', 'タイトル', '제목'),
  body: text('Content', '内容', '內容', '内容', '내용'),
  remove: text('Delete Memory', '删除记忆', '刪除記憶', '記憶を削除', '기억 삭제'),
  removeTitle: text('Delete this memory?', '删除这条记忆？', '刪除這條記憶？', 'この記憶を削除しますか？', '이 기억을 삭제할까요?'),
  delete: text('Delete', '删除', '刪除', '削除', '삭제'),
  saved: text('Memory saved', '记忆已保存', '記憶已儲存', '記憶を保存しました', '기억을 저장했습니다'),
  deleted: text('Memory deleted', '记忆已删除', '記憶已刪除', '記憶を削除しました', '기억을 삭제했습니다'),
};
const removeBody = (name: string, title: string) => text(
  `${name} will no longer refer to “${title}”.`,
  `${name}之后不会再参考「${title}」。`,
  `${name}之後不會再參考「${title}」。`,
  `${name}は今後「${title}」を参照しません。`,
  `${name}은(는) 앞으로 “${title}”을(를) 참고하지 않습니다.`,
);

/** `parseRemoteResourceRef` rejects longer ids; long teammate ids use a digest segment (fits a 128-char id). */
const MAX_REF_ID_CHARS = 160;
/**
 * The list must fit one device-link frame (2 MB), so it is bounded by bytes, not a fixed count:
 * previews stop first, then the oldest titles. Mobile keeps at most 2000 entries per list block.
 */
const LIST_BUDGET_BYTES = 1_000_000;
const PREVIEW_BUDGET_BYTES = 400_000;
const MAX_GROUP_ENTRIES = 2_000;
const PREVIEW_CHARS = 140;
const ENTRY_RE = /^(?:(?:user|feedback|project|reference)_[a-z0-9_-]{1,64}|h[a-f0-9]{12})$/;

const ref = (id: string) => ({ collectionId: 'teammates', kind: 'bot', id });
const fail = (): never => throwIpcError('INVALID_PARAMS', 'Invalid memory input');
/** Provider IPC errors reach controllers as INTERNAL; a registry NOT_FOUND tells them the entry is gone. */
const missing = (): never => { throw new RemoteResourceRegistryError('NOT_FOUND', 'Memory not found'); };
const digest = (filename: string) => createHash('sha256').update(filename).digest('hex').slice(0, 12);
const listId = (botId: string) => `settings:${botId}/memory`;
export function botMemoryEntryResourceId(botId: string, filename: string): string {
  const direct = `${listId(botId)}/${filename.replace(/\.md$/, '')}`;
  return direct.length <= MAX_REF_ID_CHARS ? direct : `${listId(botId)}/h${digest(filename)}`;
}
const timestamp = (iso: string) => {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? { timestamp: value } : {};
};
const preview = (value: string) => {
  const chars = Array.from(value);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('').trimEnd()}…` : value;
};

/**
 * Remote face of the teammate Memory page. Everything goes through the owner-bound memory
 * service: no digest entries, no paths, no descriptions. Detail actions are bound to the
 * entry's `updatedAt`, so a save or delete never overwrites what the teammate changed meanwhile.
 */
export function createBotRemoteMemoryEditor(deps: BotRemoteMemoryDeps, bind: ReturnType<typeof createBotRemoteSettingsResource>['bindResource']) {
  return async (context: RemoteResourceHostContext, request: BotRemoteMemoryRequest): Promise<RemoteResource> => {
    const owner = deps.owner(); deps.assertOwner(owner);
    const { botId, entry } = request;
    const base = listId(botId);
    if (!entry) {
      const query = request.query?.trim().slice(0, 200) ?? '';
      const summaries = await deps.memory.list(botId, query || undefined); deps.assertOwner(owner);
      const shown: Array<{ item: (typeof summaries)[number]; entry: Record<string, unknown> }> = [];
      const perType = new Map<string, number>();
      let used = 0;
      for (const item of summaries) {
        if ((perType.get(item.type) ?? 0) >= MAX_GROUP_ENTRIES) continue;
        const entry = { id: item.filename.replace(/\.md$/, ''), title: item.title,
          ...(used < PREVIEW_BUDGET_BYTES ? { subtitle: preview(item.preview) } : {}),
          ...timestamp(item.updatedAt), resourceId: botMemoryEntryResourceId(botId, item.filename) };
        // The block's fallback Markdown repeats each title once.
        const bytes = Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(item.title) + 3;
        if (used + bytes > LIST_BUDGET_BYTES) break;
        used += bytes; perType.set(item.type, (perType.get(item.type) ?? 0) + 1); shown.push({ item, entry });
      }
      const blocks: RemoteResourceBlock[] = request.primitives.includes('search')
        ? [{ id: 'search', primitive: 'search', fallbackMarkdown: '', data: { query, placeholder: memoryCopy.search } }]
        : [];
      for (const type of BOT_MEMORY_TYPES) {
        const items = shown.filter(({ item }) => item.type === type);
        if (!items.length) continue;
        blocks.push({ id: `memory-${type}`, primitive: 'list', title: memoryCopy.types[type],
          fallbackMarkdown: items.map(({ item }) => `- ${item.title}`).join('\n'),
          data: {
            count: summaries.filter(item => item.type === type).length,
            entries: items.map(({ entry }) => entry),
          } });
      }
      const revision = createHash('sha256').update(JSON.stringify([query, shown.map(({ item }) => [item.filename, item.updatedAt, item.title])])).digest('hex');
      return { ref: ref(base), revision, display: { title: memoryCopy.memories }, links: [], blocks };
    }
    if (!ENTRY_RE.test(entry)) missing();
    let filename = `${entry}.md`;
    if (entry.startsWith('h')) {
      const match = (await deps.memory.list(botId)).find(item => digest(item.filename) === entry.slice(1));
      deps.assertOwner(owner);
      filename = match?.filename ?? missing();
    }
    const read = async () => {
      const value = await deps.memory.read(botId, filename).catch((error: unknown) => {
        if (isIpcError(error) && error.code === 'NOT_FOUND') missing();
        throw error;
      });
      deps.assertOwner(owner);
      return value;
    };
    const detail = await read();
    const id = `${base}/${entry}`;
    const resource: RemoteResource = {
      ref: ref(id),
      // The service compares this exact value again inside its storage lock.
      revision: detail.updatedAt,
      display: { title: detail.title, subtitle: memoryCopy.types[detail.type], ...timestamp(detail.updatedAt) },
      links: [],
      blocks: [
        { id: 'entry', primitive: 'form', title: memoryCopy.edit, fallbackMarkdown: detail.body, data: { actionId: 'entry', values: { title: detail.title, body: detail.body } } },
        { id: 'remove', primitive: 'action', fallbackMarkdown: memoryCopy.remove.fallback, data: { actionId: 'remove' } },
      ],
      actions: [
        { id: 'entry', label: memoryCopy.edit, fields: [
          { id: 'title', label: memoryCopy.title, kind: 'text', required: true },
          { id: 'body', label: memoryCopy.body, kind: 'multiline', required: true },
        ] },
        { id: 'remove', label: memoryCopy.remove, tone: 'destructive',
          confirmation: { title: memoryCopy.removeTitle, body: removeBody(request.botName, detail.title), confirmLabel: memoryCopy.delete } },
      ],
    };
    return bind(context, resource, async () => (await read()).updatedAt, async (invocation): Promise<RemoteActionInvokeResponse> => {
      const input = invocation.input ?? {};
      if (invocation.actionId === 'remove') {
        if (Object.keys(input).length) fail();
        await deps.memory.delete({ botId, filename, expectedUpdatedAt: detail.updatedAt }); deps.assertOwner(owner);
        return { effects: [{ kind: 'refresh-resource', ref: ref(base) }, { kind: 'toast', message: memoryCopy.deleted }] };
      }
      if (Object.keys(input).some(key => key !== 'title' && key !== 'body') || !('title' in input || 'body' in input)) fail();
      // Length limits and normalization stay with the service shared with the Desktop page.
      const field = (key: 'title' | 'body', fallback: string) => key in input
        ? typeof input[key] === 'string' && (input[key] as string).length <= 65_536 ? input[key] as string : fail()
        : fallback;
      await deps.memory.update({ botId, filename, title: field('title', detail.title), body: field('body', detail.body), expectedUpdatedAt: detail.updatedAt });
      deps.assertOwner(owner);
      return { effects: [{ kind: 'refresh-resource', ref: ref(id) }, { kind: 'refresh-resource', ref: ref(base) }, { kind: 'toast', message: memoryCopy.saved }] };
    });
  };
}
