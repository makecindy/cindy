import { createHash } from 'node:crypto';
import { resolveRemoteText, type RemoteActionDescriptor, type RemoteActionInvokeResponse, type RemoteLocalizedText, type RemoteResource } from '@cindy/device-link';
import type { BotRemoteSettingsDeps, createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import type { BotSkillDetail } from '../../../shared/botSkill.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { createBotRemoteMemoryEditor, memoryCopy, type BotRemoteMemoryService } from './botRemoteMemory.js';

type Kind = 'skill' | 'mcp' | 'toolset';
type Capability = { id: string; name: string; description: string; available: boolean; joined: boolean };
export interface BotRemoteEditorDeps extends Pick<BotRemoteSettingsDeps, 'owner' | 'assertOwner' | 'read' | 'update' | 'skills'> {
  create(input: { id: string; name: string; avatarImageBase64: string; locale?: string }): Promise<void>;
  avatar(botId: string, bytes: string, version: number, expectedAvatar: string): Promise<void>;
  skill(botId: string, slug: string): Promise<BotSkillDetail | null>;
  saveSkill(botId: string, skill: BotSkillDetail): Promise<void>;
  removeSkill(botId: string, slug: string): Promise<void>;
  capabilities(sessionId: string, kind: Kind): Promise<Capability[]>;
  memory: BotRemoteMemoryService;
}
export interface BotRemoteEditorOptions {
  /** `RemoteResourceGetRequest.query`, honored only by pages that advertise `search`. */
  query?: string;
  primitives?: readonly string[];
}
const text = (fallback: string, cn: string, tw: string, ja: string, ko: string): RemoteLocalizedText => ({ fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko } });
export const editorCopy = {
  create: text('New Teammate', '创建伙伴', '建立夥伴', 'チームメイトを作成', '팀원 만들기'),
  name: text('Name', '名字', '名字', '名前', '이름'),
  avatar: text('Avatar', '头像', '頭像', 'アバター', '아바타'),
  skills: text('Personal Skills', '学会的技能', '學會的技能', '学習したスキル', '학습한 스킬'),
  connections: text('Skills & Connections', '技能与连接', '技能與連接', 'スキルと接続', '스킬 및 연결'),
  memories: memoryCopy.memories,
  skill: text('Skill References', '引用的技能', '引用的技能', '参照スキル', '참조 스킬'),
  mcp: text('Connections', '连接', '連接', '接続', '연결'),
  toolset: text('Toolsets', '工具集', '工具集', 'ツールセット', '도구 모음'),
  description: text('Description', '说明', '說明', '説明', '설명'),
  body: text('Content', '内容', '內容', '内容', '내용'),
  joined: text('Available to This Teammate', '供此伙伴使用', '供此夥伴使用', 'このチームメイトで使用', '이 팀원에서 사용'),
  largeSkill: text('Preview only. Open this skill on your computer to read or edit the full content.', '仅预览部分内容。请在电脑上阅读或编辑完整技能。', '僅預覽部分內容。請在電腦上閱讀或編輯完整技能。', '一部のプレビューです。全文の閲覧・編集はパソコンで行ってください。', '일부 내용만 미리 봅니다. 전체 내용은 컴퓨터에서 읽거나 편집하세요.'),
  save: text('Save', '保存', '儲存', '保存', '저장'),
  saved: text('Saved', '已保存', '已儲存', '保存しました', '저장됨'),
  remove: text('Delete Skill', '删除技能', '刪除技能', 'スキルを削除', '스킬 삭제'),
  removeBody: text('Delete this teammate’s saved skill?', '删除此伙伴保存的这项技能？', '刪除此夥伴儲存的這項技能？', 'このチームメイトが保存したスキルを削除しますか？', '이 팀원이 저장한 스킬을 삭제할까요?'),
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (id: string) => ({ collectionId: 'teammates', kind: 'bot', id });
const fail = () => throwIpcError('INVALID_PARAMS', 'Invalid teammate editor input');
const string = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : fail();
const keys = (input: Record<string, unknown>, allowed: string[]) => { if (Object.keys(input).some(key => !allowed.includes(key))) fail(); };
const form = (id: string, title: RemoteLocalizedText, fields: NonNullable<RemoteActionDescriptor['fields']>, values: Record<string, string | boolean>) => ({
  block: { id, title, primitive: 'form', fallbackMarkdown: title.fallback, data: { actionId: id, values } },
  action: { id, label: title, fields },
});
const receipt = (id: string): RemoteActionInvokeResponse => ({ effects: [
  { kind: 'refresh-resource', ref: ref(id) }, { kind: 'refresh-collection', collectionId: 'teammates' }, { kind: 'toast', message: editorCopy.saved },
] });

/** Finite settings resources over existing owner-bound services; no global installation or credentials. */
export function createBotRemoteEditors(deps: BotRemoteEditorDeps, bind: ReturnType<typeof createBotRemoteSettingsResource>['bindResource']) {
  const memoryEditor = createBotRemoteMemoryEditor(deps, bind);
  return async (context: RemoteResourceHostContext, id: string, locale?: string, options: BotRemoteEditorOptions = {}): Promise<RemoteResource> => {
    const owner = deps.owner(); deps.assertOwner(owner);
    if (id === 'create') {
      const panel = form('create', editorCopy.create, [
        { id: 'name', label: editorCopy.name, kind: 'text', required: true },
        { id: 'avatarImageBase64', label: editorCopy.avatar, kind: 'text', required: true },
      ], { name: '', avatarImageBase64: '' });
      return bind(context, { ref: ref(id), revision: '1', display: { title: editorCopy.create }, links: [], blocks: [panel.block], actions: [panel.action] }, async () => '1', async request => {
        const input = request.input ?? {}; keys(input, ['name', 'avatarImageBase64', 'requestId']);
        const requestId = string(input.requestId, 80);
        if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) fail();
        const name = string(input.name, 200).trim(); if (!name) fail();
        const avatarImageBase64 = string(input.avatarImageBase64, 60_000); if (!avatarImageBase64) fail();
        // Same paired controller + intent maps to the same durable identity after ACK loss/restart.
        // Never overwrite an existing profile during reconciliation.
        const botId = `bot_mobile_${hash([owner, context.controllerDeviceId, requestId]).slice(0, 40)}`;
        await deps.create({ id: botId, name, avatarImageBase64, locale });
        deps.assertOwner(owner);
        return { effects: [{ kind: 'refresh-collection', collectionId: 'teammates' }, { kind: 'navigate', target: { kind: 'resource', ref: ref(botId) } }] };
      });
    }
    const memory = /^settings:([A-Za-z0-9_-]{1,128})\/memory(?:\/([a-z0-9_-]{1,80}))?$/.exec(id);
    if (memory) {
      const settings = await deps.read(memory[1]); deps.assertOwner(owner);
      return memoryEditor(context, { botId: memory[1], botName: settings.source.name, entry: memory[2], locale, query: options.query, primitives: options.primitives ?? [] });
    }
    const match = /^settings:([A-Za-z0-9_-]{1,128})\/(skills|connections|avatar)(?:\/([a-z0-9-]+))?(?:\/([a-f0-9]{64}))?$/.exec(id);
    if (!match) throwIpcError('NOT_FOUND', 'Unknown teammate editor');
    const [, botId, page, section, entryId] = match;
    const settings = await deps.read(botId); deps.assertOwner(owner);
    const revision = async (extra?: unknown) => {
      const next = await deps.read(botId); deps.assertOwner(owner);
      return hash([next.source.currentVersion, next.source.avatar, extra]);
    };
    const resource: RemoteResource = { ref: ref(id), revision: await revision(), display: { title: editorCopy[page as 'skills' | 'connections' | 'avatar'] }, links: [], blocks: [], actions: [] };
    if (page === 'skills') {
      if (entryId) throwIpcError('NOT_FOUND', 'Unknown skill');
      if (!section) {
        const skills = await deps.skills(botId); deps.assertOwner(owner);
        resource.blocks = [{ id: 'skills', primitive: 'list', fallbackMarkdown: '',
          data: { entries: skills.map(skill => ({ id: skill.slug, title: skill.name, resourceId: `${id}/${skill.slug}` })) } }];
        return resource;
      }
      const skill = await deps.skill(botId, section); deps.assertOwner(owner);
      if (!skill) throwIpcError('NOT_FOUND', 'Skill unavailable');
      resource.display.title = skill.name;
      const readRevision = async () => revision(await deps.skill(botId, section));
      resource.revision = await revision(skill);
      // Large imported skills remain intact; mobile's transport must never clip and save them.
      if (Buffer.byteLength(JSON.stringify(skill)) > 55_000) {
        resource.blocks = [{ id: 'skill', primitive: 'markdown', fallbackMarkdown: `${resolveRemoteText(editorCopy.largeSkill, locale)}\n\n${skill.body.slice(0, 12_000)}…` }];
        return resource;
      }
      const panel = form('skill', editorCopy.save, [
        { id: 'name', label: editorCopy.name, kind: 'text', required: true },
        { id: 'description', label: editorCopy.description, kind: 'multiline' },
        { id: 'body', label: editorCopy.body, kind: 'multiline', required: true },
      ], { name: skill.name, description: skill.description, body: skill.body });
      resource.blocks = [panel.block, { id: 'remove', primitive: 'action', fallbackMarkdown: editorCopy.remove.fallback, data: { actionId: 'remove' } }];
      resource.actions = [{ ...panel.action, disabled: settings.source.status !== 'active' }, { id: 'remove', label: editorCopy.remove, tone: 'destructive', confirmation: { title: editorCopy.remove, body: editorCopy.removeBody, confirmLabel: editorCopy.remove } }];
      return bind(context, resource, readRevision, async request => {
        const input = request.input ?? {};
        if (request.actionId === 'remove') { keys(input, []); await deps.removeSkill(botId, section); }
        else {
          keys(input, ['name', 'description', 'body']);
          const next = { ...skill };
          for (const key of ['name', 'description', 'body'] as const) if (key in input) next[key] = string(input[key], key === 'name' ? 64 : key === 'description' ? 280 : 55_000);
          await deps.saveSkill(botId, next);
        }
        return receipt(id);
      });
    }
    if (page === 'avatar') {
      if (section || entryId) fail();
      const panel = form('avatar', editorCopy.avatar, [{ id: 'avatarImageBase64', label: editorCopy.avatar, kind: 'text', required: true }], { avatarImageBase64: '' });
      resource.display.avatar = { kind: 'media', value: settings.source.avatar, fallbackText: settings.source.name[0] };
      resource.blocks = [panel.block]; resource.actions = [panel.action];
      return bind(context, resource, () => revision(), async request => {
        const input = request.input ?? {}; keys(input, ['avatarImageBase64']);
        await deps.avatar(botId, string(input.avatarImageBase64, 60_000), settings.source.currentVersion, settings.source.avatar);
        return receipt(id);
      });
    }
    if (!section) {
      resource.blocks = [{ id: 'connections', primitive: 'list', fallbackMarkdown: '', data: { entries: (['skill', 'mcp', 'toolset'] as const).map(kind => ({ id: kind, title: editorCopy[kind], resourceId: `${id}/${kind}` })) } }];
      return resource;
    }
    if (!['skill', 'mcp', 'toolset'].includes(section) || !settings.source.canonicalSessionId) throwIpcError('NOT_FOUND', 'Capability catalog unavailable');
    const kind = section as Kind;
    const catalog = await deps.capabilities(settings.source.canonicalSessionId, kind); deps.assertOwner(owner);
    resource.display.title = editorCopy[kind];
    if (!entryId) {
      resource.blocks = [{ id: kind, primitive: 'list', fallbackMarkdown: '', data: { entries: catalog.map(entry => ({ id: hash(entry.id), title: entry.name, resourceId: `${id}/${hash(entry.id)}` })) } }];
      return resource;
    }
    const entry = catalog.find(entry => hash(entry.id) === entryId);
    if (!entry) throwIpcError('NOT_FOUND', 'Capability unavailable');
    resource.display.title = entry.name;
    const panel = form('capability', editorCopy.joined, [{ id: 'joined', label: editorCopy.joined, kind: 'toggle' }], { joined: entry.joined });
    resource.blocks = [panel.block]; resource.actions = [{ ...panel.action, disabled: !entry.available && !entry.joined }];
    panel.block.fallbackMarkdown = entry.description;
    return bind(context, resource, () => revision(), async request => {
      const input = request.input ?? {}; keys(input, ['joined']);
      if (typeof input.joined !== 'boolean' || input.joined && !entry.available) fail();
      const field = { skill: 'skills', mcp: 'mcpServers', toolset: 'toolsets' }[kind];
      const selected = { skill: settings.skills, mcp: settings.connections, toolset: settings.toolsets }[kind];
      const mode = { skill: 'skillMode', mcp: 'mcpMode', toolset: 'toolsetMode' }[kind];
      await deps.update({ id: botId, capabilities: { [field]: input.joined ? [...new Set([...selected, entry.id])] : selected.filter(id => id !== entry.id), [mode]: 'allowlist' } }, settings.source.currentVersion);
      return receipt(id);
    });
  };
}
