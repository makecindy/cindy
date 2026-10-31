import type { BotAutonomySettingsView } from '../../../shared/botAutonomy.js';
import { serializeModelRoutes } from '@cindy/maker-shared/model-route';
import { normalizeBotModelChain, type BotModelRoute } from '../../../shared/botModelChain.js';
import { createHash } from 'node:crypto';
import { resolveRemoteText, type RemoteActionDescriptor, type RemoteActionInvokeResponse, type RemoteLocalizedText, type RemoteResource } from '@cindy/device-link';
import type { BotRemoteSettingsDeps, createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import type { BotSkillDetail } from '../../../shared/botSkill.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { createBotRemoteMemoryEditor, memoryCopy, type BotRemoteMemoryService } from './botRemoteMemory.js';
import type { BotProjectOption } from '../../../shared/botWorkbench.js';

type Kind = 'skill' | 'mcp' | 'toolset';
type Capability = { id: string; name: string; description: string; available: boolean; joined: boolean };
export interface BotRemoteEditorDeps extends Pick<BotRemoteSettingsDeps, 'owner' | 'assertOwner' | 'read' | 'update' | 'skills'> {
  projects?: { list(botId: string): Promise<BotProjectOption[]>; set(botId: string, id: string, linked: boolean): Promise<unknown> };
  followUp?: { get(): Promise<BotAutonomySettingsView>; set(botId: string | null): Promise<BotAutonomySettingsView> };
  modelDefaults(): Promise<BotModelRoute[]>;
  create(input: { id: string; name: string; avatarImageBase64: string; locale?: string; capabilities?: { modelChainOverride: BotModelRoute[] } }): Promise<void>;
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
const text = (fallback: string, cn: string, tw: string, ja: string, ko: string, additionalTranslations: Record<string, string> = {}): RemoteLocalizedText => ({ fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko, ...additionalTranslations } });
export const editorCopy = {
  projects: text('Linked Projects', '关联项目', '關聯專案', '関連プロジェクト', '연결된 프로젝트', {"es":"Proyectos vinculados","fr":"Projets liés","de":"Verknüpfte Projekte","pt-PT":"Projetos associados","pt-BR":"Projetos vinculados","zh-Hant-x-lzh":"所繫之案","zh-Hans-x-lzh":"所系之案"}),
  projectLinked: text('Link This Project', '关联此项目', '關聯此專案', 'このプロジェクトを関連付ける', '이 프로젝트 연결', {"es":"Vincular este proyecto","fr":"Lier ce projet","de":"Dieses Projekt verknüpfen","pt-PT":"Associar este projeto","pt-BR":"Vincular este projeto","zh-Hant-x-lzh":"繫此案","zh-Hans-x-lzh":"系此案"}),
  projectHelp: text('Read materials when needed. Linking does not assign sessions or start background work.', '需要时读取资料。关联不会接手任务，也不会启动后台工作。', '需要時讀取資料。關聯不會接手任務，也不會啟動背景工作。', '必要なときに資料を読みます。関連付けてもセッションの担当やバックグラウンド作業は開始しません。', '필요할 때 자료를 읽습니다. 연결해도 세션을 맡거나 백그라운드 작업을 시작하지 않습니다.', {"es":"Consulta los materiales cuando sea necesario. Vincular no asigna sesiones ni inicia trabajo en segundo plano.","fr":"Consulter les documents au besoin. Lier un projet n’attribue aucune session et ne lance aucun travail en arrière-plan.","de":"Materialien bei Bedarf lesen. Durch das Verknüpfen werden weder Sitzungen zugewiesen noch Hintergrundarbeiten gestartet.","pt-PT":"Consulte os materiais quando necessário. A associação não atribui sessões nem inicia trabalho em segundo plano.","pt-BR":"Consulte materiais quando necessário. Vincular não atribui sessões nem inicia tarefas em segundo plano.","zh-Hant-x-lzh":"需時方閱資料。繫之不代接差事，亦不啟背景工作。","zh-Hans-x-lzh":"需时方阅资料。系之不代接差事，亦不启背景工作。"}),
  projectRemote: text('On another computer', '位于另一台电脑', '位於另一台電腦', '別のコンピューターにあります', '다른 컴퓨터에 있음', {"es":"En otro equipo","fr":"Sur un autre ordinateur","de":"Auf einem anderen Computer","pt-PT":"Noutro computador","pt-BR":"Em outro computador","zh-Hant-x-lzh":"在他機","zh-Hans-x-lzh":"在他机"}),
  projectUnavailable: text('Directory unavailable', '目录暂不可用', '目錄暫不可用', 'ディレクトリを利用できません', '디렉터리를 사용할 수 없습니다', {"es":"Directorio no disponible","fr":"Dossier indisponible","de":"Verzeichnis nicht verfügbar","pt-PT":"Diretório indisponível","pt-BR":"Diretório indisponível","zh-Hant-x-lzh":"目錄暫不可用","zh-Hans-x-lzh":"目录暂不可用"}),
  projectEmpty: text('Add projects to the project list on the teammate’s computer first.', '请先在伙伴所在电脑的项目列表中添加项目。', '請先在夥伴所在電腦的專案列表中新增專案。', '先にチームメイトのコンピューターのプロジェクト一覧に追加してください。', '먼저 팀원이 실행되는 컴퓨터의 프로젝트 목록에 프로젝트를 추가하세요.', {"es":"Añade primero los proyectos a la lista de proyectos en el equipo del compañero.","fr":"Ajoutez d’abord les projets à la liste des projets sur l’ordinateur du coéquipier.","de":"Füge zuerst Projekte zur Projektliste auf dem Computer des Teammitglieds hinzu.","pt-PT":"Adicione primeiro os projetos à lista de projetos no computador do colega de equipa.","pt-BR":"Primeiro, adicione projetos à lista de projetos no computador do colega de equipe.","zh-Hant-x-lzh":"請先於同僚所在之機，在案錄中增案。","zh-Hans-x-lzh":"请先于同僚所在之机，在案录中增案。"}),
  followUp: text("Follow Up on My Sessions", "跟进我的任务", "跟進我的任務", "自分のセッションをフォロー", "내 세션 후속 확인", {"es":"Hacer seguimiento de mis sesiones","fr":"Assurer le suivi de mes sessions","de":"Meine Sitzungen nachverfolgen","pt-PT":"Acompanhar as minhas sessões","pt-BR":"Acompanhar minhas sessões","zh-Hant-x-lzh":"跟進吾之差事","zh-Hans-x-lzh":"跟进吾之差事"}),
  followUpConsent: text("Once enabled, I’ll read summaries of sessions you create on the teammate’s computer, assess progress, and let you know about important changes. This uses your model allowance. You can turn it off anytime.", "开启后，我会读取伙伴所在电脑上你创建的任务摘要，分析进展并提醒你重要变化。这会使用模型额度，你可以随时关闭。", "開啟後，我會讀取夥伴所在電腦上你建立的任務摘要，分析進度並提醒你重要變化。這會使用模型額度，你可以隨時關閉。", "有効にすると、チームメイトが動作するコンピューターであなたが作成したセッションの要約を読み、進捗を確認して重要な変化をお知らせします。モデルの利用枠を消費します。いつでも無効にできます。", "켜면 팀원이 실행되는 컴퓨터에서 직접 만든 세션의 요약을 읽고 진행 상황을 분석하여 중요한 변화를 알려드립니다. 모델 사용량이 소모되며 언제든 끌 수 있습니다.", {"es":"Una vez activado, leeré los resúmenes de las sesiones que crees en el equipo del compañero, evaluaré el progreso y te avisaré de los cambios importantes. Esto consume tu cuota de uso del modelo. Puedes desactivarlo en cualquier momento.","fr":"Une fois cette option activée, je lirai les résumés des sessions que vous créez sur l’ordinateur du coéquipier, évaluerai leur progression et vous informerai des changements importants. Cela consomme votre quota de modèle. Vous pouvez désactiver cette option à tout moment.","de":"Nach der Aktivierung lese ich Zusammenfassungen der Sitzungen, die du auf dem Computer des Teammitglieds erstellst, bewerte den Fortschritt und informiere dich über wichtige Änderungen. Dabei wird dein Modellkontingent genutzt. Du kannst dies jederzeit deaktivieren.","pt-PT":"Após a ativação, lerei os resumos das sessões que criar no computador do colega de equipa, avaliarei o progresso e informarei sobre alterações importantes. Isto utiliza a sua quota de utilização do modelo. Pode desativar esta opção a qualquer momento.","pt-BR":"Quando ativado, lerei os resumos das sessões que você criar no computador do colega de equipe, avaliarei o progresso e avisarei sobre mudanças importantes. Isso consome sua cota de uso do modelo. Você pode desativar a qualquer momento.","zh-Hant-x-lzh":"啟之，吾將閱同僚所在之機上君所立差事之摘要，析其進度，遇要變則告君。此舉耗用模型限額，君可隨時關之。","zh-Hans-x-lzh":"启之，吾将阅同僚所在之机上君所立差事之摘要，析其进度，遇要变则告君。此举耗用模型限额，君可随时关之。"}),
  followUpStart: text("Start Following Up", "开始跟进", "開始跟進", "フォローを開始", "후속 확인 시작", {"es":"Empezar seguimiento","fr":"Commencer le suivi","de":"Nachverfolgung starten","pt-PT":"Começar a acompanhar","pt-BR":"Começar a acompanhar","zh-Hant-x-lzh":"始跟進","zh-Hans-x-lzh":"始跟进"}),
  followUpSkip: text("Not Now", "暂不开启", "暫不開啟", "今はしない", "나중에", {"es":"Ahora no","fr":"Pas maintenant","de":"Nicht jetzt","pt-PT":"Agora não","pt-BR":"Agora não","zh-Hant-x-lzh":"暫不啟","zh-Hans-x-lzh":"暂不启"}),

  create: text('New Teammate', '创建伙伴', '建立夥伴', 'チームメイトを作成', '팀원 만들기', {"es":"Nuevo compañero","fr":"Nouveau coéquipier","de":"Neues Teammitglied","pt-PT":"Novo colega de equipa","pt-BR":"Novo colega de equipe","zh-Hant-x-lzh":"立同僚","zh-Hans-x-lzh":"立同僚"}),
  name: text('Name', '名字', '名字', '名前', '이름', {"es":"Nombre","fr":"Nom","de":"Name","pt-PT":"Nome","pt-BR":"Nome","zh-Hant-x-lzh":"名","zh-Hans-x-lzh":"名"}),
  avatar: text('Avatar', '头像', '頭像', 'アバター', '아바타', {"es":"Avatar","fr":"Avatar","de":"Avatar","pt-PT":"Avatar","pt-BR":"Avatar","zh-Hant-x-lzh":"頭像","zh-Hans-x-lzh":"头像"}),
  skills: text('Personal Skills', '学会的技能', '學會的技能', '学習したスキル', '학습한 스킬', {"es":"Habilidades personales","fr":"Compétences personnelles","de":"Persönliche Skills","pt-PT":"Competências pessoais","pt-BR":"Habilidades pessoais","zh-Hant-x-lzh":"所習技藝","zh-Hans-x-lzh":"所习技艺"}),
  connections: text('Skills & Connections', '技能与连接', '技能與連接', 'スキルと接続', '스킬 및 연결', {"es":"Habilidades y conexiones","fr":"Compétences et connexions","de":"Skills & Verbindungen","pt-PT":"Competências e ligações","pt-BR":"Habilidades e conexões","zh-Hant-x-lzh":"技藝與連接","zh-Hans-x-lzh":"技艺与连接"}),
  memories: memoryCopy.memories,
  skill: text('Skill References', '引用的技能', '引用的技能', '参照スキル', '참조 스킬', {"es":"Referencias de habilidades","fr":"Références de compétences","de":"Skill-Referenzen","pt-PT":"Referências de competências","pt-BR":"Referências de habilidades","zh-Hant-x-lzh":"所引技藝","zh-Hans-x-lzh":"所引技艺"}),
  mcp: text('Connections', '连接', '連接', '接続', '연결', {"es":"Conexiones","fr":"Connexions","de":"Verbindungen","pt-PT":"Ligações","pt-BR":"Conexões","zh-Hant-x-lzh":"連接","zh-Hans-x-lzh":"连接"}),
  toolset: text('Toolsets', '工具集', '工具集', 'ツールセット', '도구 모음', {"es":"Conjuntos de herramientas","fr":"Ensembles d’outils","de":"Toolsets","pt-PT":"Conjuntos de ferramentas","pt-BR":"Conjuntos de ferramentas","zh-Hant-x-lzh":"工具集","zh-Hans-x-lzh":"工具集"}),
  description: text('Description', '说明', '說明', '説明', '설명', {"es":"Descripción","fr":"Description","de":"Beschreibung","pt-PT":"Descrição","pt-BR":"Descrição","zh-Hant-x-lzh":"說明","zh-Hans-x-lzh":"说明"}),
  body: text('Content', '内容', '內容', '内容', '내용', {"es":"Contenido","fr":"Contenu","de":"Inhalt","pt-PT":"Conteúdo","pt-BR":"Conteúdo","zh-Hant-x-lzh":"內容","zh-Hans-x-lzh":"内容"}),
  joined: text('Available to This Teammate', '供此伙伴使用', '供此夥伴使用', 'このチームメイトで使用', '이 팀원에서 사용', {"es":"Disponible para este compañero","fr":"Disponible pour ce coéquipier","de":"Für dieses Teammitglied verfügbar","pt-PT":"Disponível para este colega de equipa","pt-BR":"Disponível para este colega de equipe","zh-Hant-x-lzh":"供此同僚用","zh-Hans-x-lzh":"供此同僚用"}),
  largeSkill: text('Preview only. Open this skill on your computer to read or edit the full content.', '仅预览部分内容。请在电脑上阅读或编辑完整技能。', '僅預覽部分內容。請在電腦上閱讀或編輯完整技能。', '一部のプレビューです。全文の閲覧・編集はパソコンで行ってください。', '일부 내용만 미리 봅니다. 전체 내용은 컴퓨터에서 읽거나 편집하세요.', {"es":"Solo vista previa. Abre esta habilidad en tu equipo para leer o editar el contenido completo.","fr":"Aperçu uniquement. Ouvrez cette compétence sur votre ordinateur pour lire ou modifier l’intégralité du contenu.","de":"Nur Vorschau. Öffne diesen Skill auf deinem Computer, um den vollständigen Inhalt zu lesen oder zu bearbeiten.","pt-PT":"Apenas pré-visualização. Abra esta competência no seu computador para ler ou editar o conteúdo completo.","pt-BR":"Somente prévia. Abra esta habilidade no seu computador para ler ou editar o conteúdo completo.","zh-Hant-x-lzh":"僅先覽其部分。全篇技藝請於機上閱之、修之。","zh-Hans-x-lzh":"仅先览其部分。全篇技艺请于机上阅之、修之。"}),
  save: text('Save', '保存', '儲存', '保存', '저장', {"es":"Guardar","fr":"Enregistrer","de":"Speichern","pt-PT":"Guardar","pt-BR":"Salvar","zh-Hant-x-lzh":"存之","zh-Hans-x-lzh":"存之"}),
  saved: text('Saved', '已保存', '已儲存', '保存しました', '저장됨', {"es":"Guardado","fr":"Enregistré","de":"Gespeichert","pt-PT":"Guardado","pt-BR":"Salvo","zh-Hant-x-lzh":"已存","zh-Hans-x-lzh":"已存"}),
  remove: text('Delete Skill', '删除技能', '刪除技能', 'スキルを削除', '스킬 삭제', {"es":"Eliminar habilidad","fr":"Supprimer la compétence","de":"Skill löschen","pt-PT":"Eliminar competência","pt-BR":"Excluir habilidade","zh-Hant-x-lzh":"刪技藝","zh-Hans-x-lzh":"删技艺"}),
  removeBody: text('Delete this teammate’s saved skill?', '删除此伙伴保存的这项技能？', '刪除此夥伴儲存的這項技能？', 'このチームメイトが保存したスキルを削除しますか？', '이 팀원이 저장한 스킬을 삭제할까요?', {"es":"¿Eliminar la habilidad guardada de este compañero?","fr":"Supprimer la compétence enregistrée de ce coéquipier ?","de":"Den gespeicherten Skill dieses Teammitglieds löschen?","pt-PT":"Eliminar a competência guardada deste colega de equipa?","pt-BR":"Excluir a habilidade salva deste colega de equipe?","zh-Hant-x-lzh":"刪此同僚所存之技藝乎？","zh-Hans-x-lzh":"删此同僚所存之技艺乎？"}),
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
    const projectMatch = /^settings:([A-Za-z0-9_-]{1,128})\/projects(?:\/([a-f0-9]{64}))?$/.exec(id);
    if (projectMatch && deps.projects) {
      const [, botId, projectId] = projectMatch;
      const settings = await deps.read(botId); deps.assertOwner(owner);
      const projects = await deps.projects.list(botId); deps.assertOwner(owner);
      const title = (project: BotProjectOption) => `${project.name}${project.deviceId ? ` · ${resolveRemoteText(editorCopy.projectRemote, locale)} (${project.deviceId})` : ''}`;
      const resource: RemoteResource = { ref: ref(id), revision: hash(projects), display: { title: editorCopy.projects }, links: [], blocks: [] };
      if (!projectId) {
        resource.blocks = [{ id: 'projects', primitive: 'list', fallbackMarkdown: projects.length ? resolveRemoteText(editorCopy.projectHelp, locale) : resolveRemoteText(editorCopy.projectEmpty, locale),
          data: { entries: projects.map(project => ({ id: project.id, title: `${project.linked ? '✓ ' : ''}${title(project)}`, resourceId: `${id}/${project.id}` })) } }];
        return resource;
      }
      const project = projects.find(project => project.id === projectId);
      if (!project) throwIpcError('NOT_FOUND', 'Project unavailable');
      resource.display.title = title(project);
      const panel = form('project', editorCopy.projects, [{ id: 'linked', label: editorCopy.projectLinked, kind: 'toggle' }], { linked: project.linked });
      resource.blocks = [{ ...panel.block, fallbackMarkdown: [resolveRemoteText(editorCopy.projectHelp, locale), project.deviceId ? resolveRemoteText(editorCopy.projectRemote, locale) : !project.available ? resolveRemoteText(editorCopy.projectUnavailable, locale) : ''].filter(Boolean).join('\n\n') }];
      resource.actions = [{ ...panel.action, disabled: settings.source.status !== 'active' }];
      return bind(context, resource, async () => {
        await deps.read(botId); deps.assertOwner(owner);
        const next = await deps.projects!.list(botId); deps.assertOwner(owner);
        return hash(next);
      }, async request => {
        const input = request.input ?? {}; keys(input, ['linked']);
        if (typeof input.linked !== 'boolean') fail();
        await deps.projects!.set(botId, projectId, input.linked as boolean); deps.assertOwner(owner);
        return receipt(id);
      });
    }
    if (id === 'create') {
      const modelChain = await deps.modelDefaults(); deps.assertOwner(owner);
      const panel = form('create', editorCopy.create, [
        { id: 'name', label: editorCopy.name, kind: 'text', required: true },
        { id: 'avatarImageBase64', label: editorCopy.avatar, kind: 'text', required: true },
      ], { name: '', avatarImageBase64: '' });
      // Metadata keeps older generic form renderers from displaying raw model JSON.
      const block = { ...panel.block, data: { ...panel.block.data, creationModelChain: serializeModelRoutes(modelChain.slice(0, 1)) } };
      return bind(context, { ref: ref(id), revision: '1', display: { title: editorCopy.create }, links: [], blocks: [block], actions: [panel.action] }, async () => '1', async request => {
        const input = request.input ?? {}; keys(input, ['name', 'avatarImageBase64', 'requestId', 'modelChain']);
        const requestId = string(input.requestId, 80);
        if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) fail();
        const name = string(input.name, 200).trim(); if (!name) fail();
        const avatarImageBase64 = string(input.avatarImageBase64, 60_000); if (!avatarImageBase64) fail();
        // Same paired controller + intent maps to the same durable identity after ACK loss/restart.
        // Never overwrite an existing profile during reconciliation.
        const botId = `bot_mobile_${hash([owner, context.controllerDeviceId, requestId]).slice(0, 40)}`;
        let capabilities: { modelChainOverride: BotModelRoute[] } | undefined;
        if (input.modelChain !== undefined) {
          let value: unknown;
          try { value = JSON.parse(string(input.modelChain, 4000)); } catch { fail(); }
          const chain = normalizeBotModelChain(value);
          if (!Array.isArray(value) || value.length !== 1 || chain.length !== 1 || !['claude', 'codex', 'pi'].includes(value[0]?.harness)) fail();
          capabilities = { modelChainOverride: chain };
        }
        await deps.create({ id: botId, name, avatarImageBase64, locale, ...(capabilities ? { capabilities } : {}) });
        deps.assertOwner(owner);
        return { effects: [{ kind: 'refresh-collection', collectionId: 'teammates' }, { kind: 'navigate', target: { kind: 'resource', ref: ref(botId) } }] };
      });
    }
    const memory = /^settings:([A-Za-z0-9_-]{1,128})\/memory(?:\/([a-z0-9_-]{1,80}))?$/.exec(id);
    if (memory) {
      const settings = await deps.read(memory[1]); deps.assertOwner(owner);
      return memoryEditor(context, { botId: memory[1], botName: settings.source.name, entry: memory[2], locale, query: options.query, primitives: options.primitives ?? [] });
    }
    const followUp = /^settings:([A-Za-z0-9_-]{1,128})\/follow-up$/.exec(id);
    if (followUp && deps.followUp) {
      const botId = followUp[1];
      const profile = await deps.read(botId); deps.assertOwner(owner);
      const choice = await deps.followUp.get(); deps.assertOwner(owner);
      const enabled = choice.schedulerBotId === botId;
      const readRevision = async () => {
        const next = await deps.read(botId); deps.assertOwner(owner);
        const current = await deps.followUp!.get(); deps.assertOwner(owner);
        return hash([next.source.currentVersion, current]);
      };
      const panel = form('follow-up', editorCopy.followUp, [
        { id: 'enabled', label: editorCopy.followUp, kind: 'toggle' },
      ], { enabled });
      const resource: RemoteResource = {
        ref: ref(id), revision: hash([profile.source.currentVersion, choice]),
        display: { title: editorCopy.followUp }, links: [],
        blocks: [{ ...panel.block, fallbackMarkdown: resolveRemoteText(editorCopy.followUpConsent, locale),
          data: { ...panel.block.data, invitationAvailable: !choice.isCustomized && choice.schedulerBotId === null && profile.source.status === 'active' } }],
        actions: [{ ...panel.action, ...(!enabled ? { confirmation: { title: editorCopy.followUp, body: editorCopy.followUpConsent, confirmLabel: editorCopy.followUpStart } } : {}) },
          { id: 'dismiss', label: editorCopy.followUpSkip }],
      };
      return bind(context, resource, readRevision, async request => {
        const input = request.input ?? {};
        keys(input, request.actionId === 'dismiss' ? [] : ['enabled']);
        if (request.actionId !== 'dismiss' && typeof input.enabled !== 'boolean') fail();
        await deps.followUp!.set(request.actionId === 'dismiss' || input.enabled === false ? null : botId);
        deps.assertOwner(owner);
        return receipt(id);
      });
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
