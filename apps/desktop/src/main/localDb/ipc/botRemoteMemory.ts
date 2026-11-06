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

const text = (fallback: string, cn: string, tw: string, ja: string, ko: string, additionalTranslations: Record<string, string> = {}): RemoteLocalizedText =>
  ({ fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko, ...additionalTranslations } });
export const memoryCopy = {
  memories: text('Saved Memories', '已存记忆', '已存記憶', '保存した記憶', '저장된 기억', {"es":"Recuerdos guardados","fr":"Souvenirs enregistrés","de":"Gespeicherte Erinnerungen","pt-PT":"Memórias guardadas","pt-BR":"Memórias salvas","zh-Hant-x-lzh":"所存記憶","zh-Hans-x-lzh":"所存记忆"}),
  search: text('Search memories', '搜索记忆', '搜尋記憶', '記憶を検索', '기억 검색', {"es":"Buscar recuerdos","fr":"Rechercher des souvenirs","de":"Erinnerungen suchen","pt-PT":"Pesquisar memórias","pt-BR":"Buscar memórias","zh-Hant-x-lzh":"尋記憶","zh-Hans-x-lzh":"寻记忆"}),
  types: {
    user: text('About you', '关于你', '關於你', 'あなたについて', '나에 대해', {"es":"Sobre ti","fr":"À votre sujet","de":"Über dich","pt-PT":"Sobre si","pt-BR":"Sobre você","zh-Hant-x-lzh":"關於君","zh-Hans-x-lzh":"关于君"}),
    feedback: text('Your preferences', '你的要求', '你的要求', 'あなたの要望', '요청 사항', {"es":"Tus preferencias","fr":"Vos préférences","de":"Deine Vorlieben","pt-PT":"As suas preferências","pt-BR":"Suas preferências","zh-Hant-x-lzh":"君之所求","zh-Hans-x-lzh":"君之所求"}),
    project: text('Projects', '项目', '專案', 'プロジェクト', '프로젝트', {"es":"Proyectos","fr":"Projets","de":"Projekte","pt-PT":"Projetos","pt-BR":"Projetos","zh-Hant-x-lzh":"案","zh-Hans-x-lzh":"案"}),
    reference: text('References', '参考', '參考', '参考', '참고', {"es":"Referencias","fr":"Références","de":"Referenzen","pt-PT":"Referências","pt-BR":"Referências","zh-Hant-x-lzh":"參考","zh-Hans-x-lzh":"参考"}),
  } satisfies Record<BotMemoryType, RemoteLocalizedText>,
  edit: text('Edit', '编辑', '編輯', '編集', '편집', {"es":"Editar","fr":"Modifier","de":"Bearbeiten","pt-PT":"Editar","pt-BR":"Editar","zh-Hant-x-lzh":"修","zh-Hans-x-lzh":"修"}),
  title: text('Title', '标题', '標題', 'タイトル', '제목', {"es":"Título","fr":"Titre","de":"Titel","pt-PT":"Título","pt-BR":"Título","zh-Hant-x-lzh":"標題","zh-Hans-x-lzh":"标题"}),
  body: text('Content', '内容', '內容', '内容', '내용', {"es":"Contenido","fr":"Contenu","de":"Inhalt","pt-PT":"Conteúdo","pt-BR":"Conteúdo","zh-Hant-x-lzh":"內容","zh-Hans-x-lzh":"内容"}),
  remove: text('Delete Memory', '删除记忆', '刪除記憶', '記憶を削除', '기억 삭제', {"es":"Eliminar recuerdo","fr":"Supprimer le souvenir","de":"Erinnerung löschen","pt-PT":"Eliminar memória","pt-BR":"Excluir memória","zh-Hant-x-lzh":"刪記憶","zh-Hans-x-lzh":"删记忆"}),
  removeTitle: text('Delete this memory?', '删除这条记忆？', '刪除這條記憶？', 'この記憶を削除しますか？', '이 기억을 삭제할까요?', {"es":"¿Eliminar este recuerdo?","fr":"Supprimer ce souvenir ?","de":"Diese Erinnerung löschen?","pt-PT":"Eliminar esta memória?","pt-BR":"Excluir esta memória?","zh-Hant-x-lzh":"刪此記憶乎？","zh-Hans-x-lzh":"删此记忆乎？"}),
  delete: text('Delete', '删除', '刪除', '削除', '삭제', {"es":"Eliminar","fr":"Supprimer","de":"Löschen","pt-PT":"Eliminar","pt-BR":"Excluir","zh-Hant-x-lzh":"刪","zh-Hans-x-lzh":"删"}),
  saved: text('Memory saved', '记忆已保存', '記憶已儲存', '記憶を保存しました', '기억을 저장했습니다', {"es":"Recuerdo guardado","fr":"Souvenir enregistré","de":"Erinnerung gespeichert","pt-PT":"Memória guardada","pt-BR":"Memória salva","zh-Hant-x-lzh":"記憶已存","zh-Hans-x-lzh":"记忆已存"}),
  deleted: text('Memory deleted', '记忆已删除', '記憶已刪除', '記憶を削除しました', '기억을 삭제했습니다', {"es":"Recuerdo eliminado","fr":"Souvenir supprimé","de":"Erinnerung gelöscht","pt-PT":"Memória eliminada","pt-BR":"Memória excluída","zh-Hant-x-lzh":"記憶已刪","zh-Hans-x-lzh":"记忆已删"}),
};
const removeBody = (name: string, title: string) => text(
  `${name} will no longer refer to “${title}”.`,
  `${name}之后不会再参考「${title}」。`,
  `${name}之後不會再參考「${title}」。`,
  `${name}は今後「${title}」を参照しません。`,
  `${name}은(는) 앞으로 “${title}”을(를) 참고하지 않습니다.`,
  {
    es: `${name} ya no consultará «${title}».`,
    fr: `${name} ne se référera plus à « ${title} ».`,
    de: `${name} wird „${title}“ nicht mehr berücksichtigen.`,
    'pt-PT': `${name} deixará de consultar «${title}».`,
    'pt-BR': `${name} não consultará mais “${title}”.`,
    'zh-Hant-x-lzh': `${name}此後不復參考「${title}」。`,
    'zh-Hans-x-lzh': `${name}此后不复参考「${title}」。`,
  },
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
