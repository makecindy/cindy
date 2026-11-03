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
import { BOT_SYSTEM_SKILL_IDS, isBotSystemSkillId, readBotSystemSkillsOff, withBotSystemSkill } from '../../../shared/botSystemSkills.js';

type Kind = 'skill' | 'mcp' | 'toolset';
type Capability = { id: string; name: string; description: string; available: boolean; joined: boolean };
export interface BotRemoteEditorDeps extends Pick<BotRemoteSettingsDeps, 'owner' | 'assertOwner' | 'read' | 'update' | 'skills'> {
  projects?: { list(botId: string): Promise<BotProjectOption[]>; set(botId: string, id: string, linked: boolean): Promise<unknown> };
  followUp?: { get(): Promise<BotAutonomySettingsView>; set(botId: string | null): Promise<BotAutonomySettingsView> };
  /** Learned skills, including turned-off ones (`enabled: false`). */
  skills(botId: string): Promise<Array<{ slug: string; name: string; description: string; updatedAt: string | number; enabled?: boolean }>>;
  modelDefaults(): Promise<BotModelRoute[]>;
  create(input: { id: string; name: string; avatarImageBase64: string; locale?: string; capabilities?: { modelChainOverride: BotModelRoute[] } }): Promise<void>;
  avatar(botId: string, bytes: string, version: number, expectedAvatar: string): Promise<void>;
  skill(botId: string, slug: string): Promise<BotSkillDetail | null>;
  saveSkill(botId: string, skill: BotSkillDetail): Promise<void>;
  removeSkill(botId: string, slug: string): Promise<void>;
  /** Moves a learned skill between its enabled and disabled stores and refreshes the runtime. */
  setSkillEnabled(botId: string, slug: string, enabled: boolean): Promise<void>;
  /** The shared core Skill text as this teammate receives it. */
  coreGuide(systemSkillsOff: readonly string[]): string | Promise<string>;
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
  // Skill layers (cindy-bots-runtime.md §6「伙伴技能分层」): the shared core, the system Skills and the learned ones.
  skillsPage: text('Skills', '技能', '技能', 'スキル', '스킬', {"es":"Habilidades","fr":"Skills","de":"Skills","pt-PT":"Skills","pt-BR":"Skills","zh-Hant-x-lzh":"技藝","zh-Hans-x-lzh":"技艺"}),
  coreSkill: text('Core Skill', '核心技能', '核心技能', 'コアスキル', '핵심 스킬', {"es":"Habilidad principal","fr":"Skill principal","de":"Kern-Skill","pt-PT":"Skill principal","pt-BR":"Skill principal","zh-Hant-x-lzh":"核心技藝","zh-Hans-x-lzh":"核心技艺"}),
  coreSkillDetail: text('Shared by every teammate · Always on · Updated with Cindy', '所有伙伴共用 · 始终开启 · 随 Cindy 更新', '所有夥伴共用 · 始終開啟 · 隨 Cindy 更新', 'すべてのチームメイトで共通 · 常にオン · Cindy とともに更新', '모든 팀원이 공유 · 항상 켜짐 · Cindy와 함께 업데이트', {"es":"Compartida por todos los compañeros · Siempre activa · Se actualiza con Cindy","fr":"Partagé par tous les coéquipiers · Toujours actif · Mis à jour avec Cindy","de":"Für alle Teammitglieder · Immer aktiv · Wird mit Cindy aktualisiert","pt-PT":"Partilhada por todos os colegas de equipa · Sempre ativa · Atualizada com Cindy","pt-BR":"Compartilhada por todos os colegas de equipe · Sempre ativa · Atualizada com Cindy","zh-Hant-x-lzh":"諸同僚共用 · 恆啟 · 隨 Cindy 而新","zh-Hans-x-lzh":"诸同僚共用 · 恒启 · 随 Cindy 而新"}),
  coreSummary: text(
    'Every teammate starts from this skill. It covers:\n· Sessions: finishes work in the chat, and starts a background session when the work needs one.\n· Teammates: sends messages to other teammates to work together.\n· Models and tools: changes its model when you ask, and finds the tools and plugins the work needs.\n· Memory: remembers your preferences and corrections, and saves a skill when you ask.\n· Knowing itself: knows what it can do, and turns its abilities on or off when you ask.',
    '每位伙伴都以这项技能为基础，内容包括：\n· 任务：在对话里完成工作，需要时开启后台任务。\n· 伙伴：给其他伙伴发消息，一起协作。\n· 模型与工具：按你的要求更换模型，查找工作需要的工具和插件。\n· 记忆：记住你的偏好和纠正，按你的要求保存技能。\n· 了解自己：知道自己能做什么，按你的要求开关自己的能力。',
    '每位夥伴都以這項技能為基礎，內容包括：\n· 任務：在對話中完成工作，需要時開啟背景任務。\n· 夥伴：傳訊息給其他夥伴，一起協作。\n· 模型與工具：依你的要求更換模型，尋找工作需要的工具和插件。\n· 記憶：記住你的偏好和指正，依你的要求儲存技能。\n· 了解自己：知道自己能做什麼，依你的要求開關自己的能力。',
    'すべてのチームメイトはこのスキルを土台にしています。内容：\n· セッション：会話の中で作業を終え、必要なときはバックグラウンドのセッションを開始します。\n· チームメイト：ほかのチームメイトにメッセージを送り、協力します。\n· モデルとツール：指示に応じてモデルを切り替え、作業に必要なツールやプラグインを探します。\n· 記憶：好みや訂正を覚え、指示があればスキルとして保存します。\n· 自分を知る：自分にできることを把握し、指示に応じて機能をオン・オフします。',
    '모든 팀원은 이 스킬을 기반으로 합니다. 포함 내용:\n· 세션: 대화 안에서 작업을 마치고, 필요할 때 백그라운드 세션을 시작합니다.\n· 팀원: 다른 팀원에게 메시지를 보내 함께 작업합니다.\n· 모델과 도구: 요청에 따라 모델을 바꾸고, 작업에 필요한 도구와 플러그인을 찾습니다.\n· 기억: 선호와 수정 사항을 기억하고, 요청하면 스킬로 저장합니다.\n· 자기 이해: 자신이 할 수 있는 일을 알고, 요청에 따라 기능을 켜거나 끕니다.',
    {"es":"Todos los compañeros parten de esta habilidad. Incluye:\n· Sesiones: termina el trabajo en el chat y, si hace falta, inicia una sesión en segundo plano.\n· Compañeros: envía mensajes a otros compañeros para colaborar.\n· Modelos y herramientas: cambia de modelo cuando se lo pides y busca las herramientas y complementos que necesita el trabajo.\n· Memoria: recuerda tus preferencias y correcciones, y guarda una habilidad cuando se lo pides.\n· Conocerse: sabe lo que puede hacer y activa o desactiva sus funciones cuando se lo pides.",
      "fr":"Chaque coéquipier s’appuie sur ce skill. Il couvre :\n· Sessions : termine le travail dans la conversation et lance une session en arrière-plan si nécessaire.\n· Coéquipiers : envoie des messages aux autres coéquipiers pour collaborer.\n· Modèles et outils : change de modèle à votre demande et trouve les outils et plugins nécessaires.\n· Mémoire : retient vos préférences et corrections, et enregistre un skill à votre demande.\n· Se connaître : sait ce qu’il peut faire et active ou désactive ses capacités à votre demande.",
      "de":"Alle Teammitglieder bauen auf diesem Skill auf. Er umfasst:\n· Sitzungen: erledigt Arbeit im Chat und startet bei Bedarf eine Sitzung im Hintergrund.\n· Teammitglieder: schreibt anderen Teammitgliedern, um zusammenzuarbeiten.\n· Modelle und Tools: wechselt auf Wunsch das Modell und findet die Tools und Plugins, die die Arbeit braucht.\n· Gedächtnis: merkt sich deine Vorlieben und Korrekturen und speichert auf Wunsch einen Skill.\n· Sich selbst kennen: weiß, was es kann, und schaltet seine Fähigkeiten auf Wunsch ein oder aus.",
      "pt-PT":"Todos os colegas de equipa partem desta Skill. Inclui:\n· Sessões: conclui o trabalho na conversa e, quando necessário, inicia uma sessão em segundo plano.\n· Colegas de equipa: envia mensagens a outros colegas de equipa para colaborar.\n· Modelos e ferramentas: muda de modelo quando pede e encontra as ferramentas e plugins de que o trabalho precisa.\n· Memória: lembra-se das suas preferências e correções e guarda uma Skill quando pede.\n· Conhecer-se: sabe o que consegue fazer e ativa ou desativa as suas capacidades quando pede.",
      "pt-BR":"Todo colega de equipe parte desta Skill. Inclui:\n· Sessões: conclui o trabalho no chat e, quando necessário, inicia uma sessão em segundo plano.\n· Colegas de equipe: envia mensagens a outros colegas de equipe para colaborar.\n· Modelos e ferramentas: troca de modelo quando você pede e encontra as ferramentas e plugins de que o trabalho precisa.\n· Memória: lembra suas preferências e correções e salva uma Skill quando você pede.\n· Autoconhecimento: sabe o que pode fazer e ativa ou desativa suas capacidades quando você pede.",
      "zh-Hant-x-lzh":"諸同僚皆以此技藝為本，其要如下：\n· 差事：於對話中竟其事，需時則另啟背景差事。\n· 同僚：致訊他同僚，共協其事。\n· 模型與工具：依君之命易模型，尋事之所需工具與法器。\n· 記憶：記君之所好與所正，依君之命存為技藝。\n· 自知：知己之所能，依君之命啟閉其能。",
      "zh-Hans-x-lzh":"诸同僚皆以此技艺为本，其要如下：\n· 差事：于对话中竟其事，需时则另启背景差事。\n· 同僚：致讯他同僚，共协其事。\n· 模型与工具：依君之命易模型，寻事之所需工具与法器。\n· 记忆：记君之所好与所正，依君之命存为技艺。\n· 自知：知己之所能，依君之命启闭其能。"}),
  coreOriginal: text('Original Text', '原文', '原文', '原文', '원문', {"es":"Texto original","fr":"Texte d’origine","de":"Originaltext","pt-PT":"Texto original","pt-BR":"Texto original","zh-Hant-x-lzh":"原文","zh-Hans-x-lzh":"原文"}),
  systemSkills: text('System Skills', '系统技能', '系統技能', 'システムスキル', '시스템 스킬', {"es":"Habilidades del sistema","fr":"Skills système","de":"System-Skills","pt-PT":"Skills do sistema","pt-BR":"Skills do sistema","zh-Hant-x-lzh":"系統技藝","zh-Hans-x-lzh":"系统技艺"}),
  todo: text('Todos', '待办', '待辦', 'Todo', '할 일', {"es":"Tareas pendientes","fr":"Tâches à faire","de":"Aufgaben","pt-PT":"Tarefas","pt-BR":"Tarefas","zh-Hant-x-lzh":"待辦","zh-Hans-x-lzh":"待办"}),
  todoHelp: text('Keeps what you ask for and what it notices, and reminds you when due.', '记下你交代的事和它留意到的事，到期提醒你。', '記下你交代的事和它留意到的事，到期提醒你。', '頼まれたことや気づいたことを記録し、期限になったらお知らせします。', '요청한 일과 알아챈 일을 기록하고, 기한이 되면 알려 드립니다.', {"es":"Guarda lo que le pides y lo que detecta, y te avisa cuando llega la fecha.","fr":"Note ce que vous demandez et ce qu’il remarque, et vous le rappelle à l’échéance.","de":"Hält fest, worum du bittest und was ihm auffällt, und erinnert dich bei Fälligkeit.","pt-PT":"Regista o que pede e o que nota, e lembra-o quando chega o prazo.","pt-BR":"Anota o que você pede e o que percebe, e avisa você quando chega o prazo.","zh-Hant-x-lzh":"錄君所囑與其所察，屆期則告君。","zh-Hans-x-lzh":"录君所嘱与其所察，届期则告君。"}),
  routine: text('Routines', '例行任务', '例行任務', 'ルーティン', '루틴', {"es":"Rutinas","fr":"Routines","de":"Routinen","pt-PT":"Rotinas","pt-BR":"Rotinas","zh-Hant-x-lzh":"例行差事","zh-Hans-x-lzh":"例行差事"}),
  routineHelp: text('Sets up and maintains routines that run on a schedule.', '设置并维护按时运行的例行任务。', '設定並維護按時執行的例行任務。', '決まった時間に実行するルーティンを設定・管理します。', '일정에 따라 실행되는 루틴을 설정하고 관리합니다.', {"es":"Crea y mantiene rutinas que se ejecutan según un horario.","fr":"Crée et gère des routines qui s’exécutent selon un horaire.","de":"Richtet Routinen ein, die nach Zeitplan laufen, und pflegt sie.","pt-PT":"Configura e mantém rotinas que são executadas segundo um horário.","pt-BR":"Configura e mantém rotinas que rodam em horários definidos.","zh-Hant-x-lzh":"設並守按時而行之例行差事。","zh-Hans-x-lzh":"设并守按时而行之例行差事。"}),
  follow: text('Workbench and Follow-up', '工作台与跟进', '工作台與跟進', 'ワークベンチとフォローアップ', '워크벤치 및 후속 확인', {"es":"Panel de trabajo y seguimiento","fr":"Plan de travail et suivi","de":"Arbeitsbereich und Nachverfolgung","pt-PT":"Área de trabalho e acompanhamento","pt-BR":"Área de trabalho e acompanhamento","zh-Hant-x-lzh":"工作臺與跟進","zh-Hans-x-lzh":"工作台与跟进"}),
  followHelp: text('Watches how all your sessions are going and follows up on the ones you hand to it.', '留意你所有任务的进展，跟进你交给它的任务。', '留意你所有任務的進展，跟進你交給它的任務。', 'すべてのセッションの進み具合を見守り、任されたセッションをフォローします。', '모든 세션의 진행 상황을 지켜보고, 맡긴 세션을 후속 확인합니다.', {"es":"Vigila cómo van todas tus sesiones y hace seguimiento de las que le encargas.","fr":"Surveille l’avancement de toutes vos sessions et assure le suivi de celles que vous lui confiez.","de":"Behält im Blick, wie all deine Sitzungen laufen, und verfolgt die nach, die du ihm überträgst.","pt-PT":"Acompanha o andamento de todas as suas sessões e dá seguimento às que lhe confiar.","pt-BR":"Acompanha o andamento de todas as suas sessões e dá seguimento às que você confiar a ele.","zh-Hant-x-lzh":"察君諸差事之進度，跟進君所託者。","zh-Hans-x-lzh":"察君诸差事之进度，跟进君所托者。"}),
  useSkill: text('Use This Skill', '使用这个技能', '使用這個技能', 'このスキルを使う', '이 스킬 사용', {"es":"Usar esta habilidad","fr":"Utiliser ce skill","de":"Diesen Skill verwenden","pt-PT":"Usar esta Skill","pt-BR":"Usar esta Skill","zh-Hant-x-lzh":"用此技藝","zh-Hans-x-lzh":"用此技艺"}),
  skillOff: text('Off', '已关闭', '已關閉', 'オフ', '꺼짐', {"es":"Desactivada","fr":"Désactivé","de":"Aus","pt-PT":"Desativada","pt-BR":"Desativada","zh-Hant-x-lzh":"已閉","zh-Hans-x-lzh":"已闭"}),
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
    // `_`-prefixed sections are host Skill layers; learned skill slugs never contain `_`.
    const match = /^settings:([A-Za-z0-9_-]{1,128})\/(skills|connections|avatar)(?:\/([a-z0-9-]+|_[a-z]+))?(?:\/([a-f0-9]{64}))?$/.exec(id);
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
      const systemOff = readBotSystemSkillsOff(settings.systemSkillsOff);
      if (!section) {
        const skills = await deps.skills(botId); deps.assertOwner(owner);
        resource.display.title = editorCopy.skillsPage;
        // Older controllers draw these entries as one flat list (titles only); newer ones add the
        // block titles as section headers and the subtitles under each row.
        resource.blocks = [
          { id: 'core', primitive: 'list', fallbackMarkdown: '',
            data: { entries: [{ id: 'core', title: editorCopy.coreSkill, subtitle: editorCopy.coreSkillDetail, resourceId: `${id}/_core` }] } },
          { id: 'system', title: editorCopy.systemSkills, primitive: 'list', fallbackMarkdown: '',
            data: { entries: BOT_SYSTEM_SKILL_IDS.map(skillId => ({ id: skillId, title: editorCopy[skillId], ...(systemOff.includes(skillId) ? { subtitle: editorCopy.skillOff } : {}), resourceId: `${id}/_${skillId}` })) } },
          { id: 'skills', title: editorCopy.skills, primitive: 'list', fallbackMarkdown: '',
            data: { entries: skills.map(skill => ({ id: skill.slug, title: skill.name, ...(skill.enabled === false ? { subtitle: editorCopy.skillOff } : {}), resourceId: `${id}/${skill.slug}` })) } },
        ];
        return resource;
      }
      if (section === '_core') {
        // Read-only: the core is maintained by the app; the original reflects this teammate's switches.
        const original = await deps.coreGuide(systemOff); deps.assertOwner(owner);
        resource.display.title = editorCopy.coreSkill;
        resource.blocks = [
          { id: 'core', primitive: 'markdown', fallbackMarkdown: `${resolveRemoteText(editorCopy.coreSkillDetail, locale)}\n\n${resolveRemoteText(editorCopy.coreSummary, locale)}` },
          { id: 'core-original', title: editorCopy.coreOriginal, primitive: 'markdown', fallbackMarkdown: original },
        ];
        return resource;
      }
      if (section.startsWith('_')) {
        const skillId = section.slice(1);
        if (!isBotSystemSkillId(skillId)) throwIpcError('NOT_FOUND', 'Unknown skill');
        resource.display.title = editorCopy[skillId];
        // `capability` is the toggle-with-description layout every controller already draws.
        const panel = form('capability', editorCopy.useSkill, [{ id: 'enabled', label: editorCopy.useSkill, kind: 'toggle' }], { enabled: !systemOff.includes(skillId) });
        panel.block.fallbackMarkdown = resolveRemoteText(editorCopy[`${skillId}Help`], locale);
        resource.blocks = [panel.block]; resource.actions = [{ ...panel.action, disabled: settings.source.status !== 'active' }];
        return bind(context, resource, () => revision(), async request => {
          const input = request.input ?? {}; keys(input, ['enabled']);
          if (typeof input.enabled !== 'boolean') fail();
          // Same profile version check as the connection toggles: a stale page never overwrites.
          await deps.update({ id: botId, capabilities: { systemSkillsOff: withBotSystemSkill(settings.systemSkillsOff, skillId, input.enabled as boolean) } }, settings.source.currentVersion);
          return receipt(id);
        });
      }
      const skill = await deps.skill(botId, section); deps.assertOwner(owner);
      if (!skill) throwIpcError('NOT_FOUND', 'Skill unavailable');
      resource.display.title = skill.name;
      const readRevision = async () => revision(await deps.skill(botId, section));
      resource.revision = await revision(skill);
      const enabled = skill.enabled !== false;
      const enabledField = { id: 'enabled', label: editorCopy.useSkill, kind: 'toggle' as const };
      const setEnabled = async (input: Record<string, unknown>) => {
        if (!('enabled' in input)) return;
        if (typeof input.enabled !== 'boolean') fail();
        if (input.enabled !== enabled) await deps.setSkillEnabled(botId, section, input.enabled as boolean);
      };
      // Large imported skills remain intact; mobile's transport must never clip and save them.
      // Only the on/off switch is offered; turning it off moves the folder and never rewrites the body.
      if (Buffer.byteLength(JSON.stringify(skill)) > 55_000) {
        const panel = form('capability', editorCopy.useSkill, [enabledField], { enabled });
        panel.block.fallbackMarkdown = `${resolveRemoteText(editorCopy.largeSkill, locale)}\n\n${skill.body.slice(0, 12_000)}…`;
        resource.blocks = [panel.block];
        resource.actions = [{ ...panel.action, disabled: settings.source.status !== 'active' }];
        return bind(context, resource, readRevision, async request => {
          const input = request.input ?? {}; keys(input, ['enabled']);
          if (!('enabled' in input)) fail();
          await setEnabled(input);
          return receipt(id);
        });
      }
      const panel = form('skill', editorCopy.save, [
        enabledField,
        { id: 'name', label: editorCopy.name, kind: 'text', required: true },
        { id: 'description', label: editorCopy.description, kind: 'multiline' },
        { id: 'body', label: editorCopy.body, kind: 'multiline', required: true },
      ], { enabled, name: skill.name, description: skill.description, body: skill.body });
      resource.blocks = [panel.block, { id: 'remove', primitive: 'action', fallbackMarkdown: editorCopy.remove.fallback, data: { actionId: 'remove' } }];
      resource.actions = [{ ...panel.action, disabled: settings.source.status !== 'active' }, { id: 'remove', label: editorCopy.remove, tone: 'destructive', confirmation: { title: editorCopy.remove, body: editorCopy.removeBody, confirmLabel: editorCopy.remove } }];
      return bind(context, resource, readRevision, async request => {
        const input = request.input ?? {};
        if (request.actionId === 'remove') { keys(input, []); await deps.removeSkill(botId, section); }
        else {
          keys(input, ['enabled', 'name', 'description', 'body']);
          if ('enabled' in input && typeof input.enabled !== 'boolean') fail();
          const edited = (['name', 'description', 'body'] as const).filter(key => key in input);
          if (edited.length) {
            const next = { ...skill };
            for (const key of edited) next[key] = string(input[key], key === 'name' ? 64 : key === 'description' ? 280 : 55_000);
            await deps.saveSkill(botId, next);
          }
          // Content first, in the store the skill is in now; then move it if the switch changed.
          await setEnabled(input);
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
