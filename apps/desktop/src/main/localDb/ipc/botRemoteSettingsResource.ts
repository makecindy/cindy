import type { TeammateMediaCatalog } from '@cindy/maker-shared/teammate-media-models';
import { parseTeammateMediaModels } from '@cindy/maker-shared/teammate-media-models';
import { serializeModelRoutes } from '@cindy/maker-shared/model-route';
import { normalizeBotModelChain, readBotTaskModelOverride, type BotModelRoute } from '../../../shared/botModelChain.js';
import { createHash, randomUUID } from 'node:crypto';
import type { RemoteActionDescriptor, RemoteActionInvokeRequest, RemoteActionInvokeResponse, RemoteLocalizedText, RemoteResource } from '@cindy/device-link';
import type { getBotRemoteSettingsSource } from './bots.js';
import { botRemoteResourceFromSource } from './botRemoteResourceProjection.js';
import { RemoteResourceRegistryError, type RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { throwIpcError } from '../../utils/ipcValidate.js';

type Settings = Awaited<ReturnType<typeof getBotRemoteSettingsSource>>;
type Operation = 'media' | 'profile' | 'models' | 'memory' | 'permissions' | 'restart' | 'delete' | 'resume';
type Grant = { owner: string; controller: string; botId: string; version: number; revision: string; operation: Operation; expires: number };
type BoundGrant = { owner: string; controller: string; ref: NonNullable<RemoteActionInvokeRequest['resourceRef']>; expires: number; check: () => Promise<void>; run: (request: RemoteActionInvokeRequest) => Promise<RemoteActionInvokeResponse> };
export interface BotRemoteSettingsDeps {
  mediaModels?(): Promise<TeammateMediaCatalog>;
  owner(): string;
  assertOwner(owner: string): void;
  read(botId: string): Promise<Settings>;
  update(input: Record<string, unknown>, version: number): Promise<unknown>;
  lifecycle(botId: string, operation: 'restart' | 'delete' | 'resume', confirmName: string | undefined, guard: () => Promise<void>): Promise<{ warnings?: string[] }>;
  skills(botId: string): Promise<Array<{ slug: string; name: string; description: string; updatedAt: string | number }>>;
  directHistory?(botId: string): Promise<string>;
  now?: () => number;
}
const text = (fallback: string, cn: string, tw: string, ja: string, ko: string, additionalTranslations: Record<string, string> = {}): RemoteLocalizedText =>
  ({ fallback, translations: { 'zh-CN': cn, 'zh-TW': tw, ja, ko, ...additionalTranslations } });
const copy = {
  media: text("Media models", "媒体模型", "媒體模型", "メディアモデル", "미디어 모델"),
  mediaVision: text("Vision Bridge model", "视觉桥模型", "視覺橋模型", "Vision Bridge モデル", "Vision Bridge 모델"),
  mediaFallback: text("Vision Bridge fallback", "视觉桥备用模型", "視覺橋備用模型", "Vision Bridge の予備モデル", "Vision Bridge 예비 모델"),
  mediaImage: text("Image generation model", "图像生成模型", "圖像生成模型", "画像生成モデル", "이미지 생성 모델"),
  mediaVideo: text("Video generation model", "视频生成模型", "影片生成模型", "動画生成モデル", "동영상 생성 모델"),
  mediaInherit: text("Use app settings", "使用应用设置", "使用應用程式設定", "アプリの設定を使用", "앱 설정 사용"),
  mediaNone: text("No fallback", "不使用备用模型", "不使用備用模型", "予備モデルなし", "예비 모델 없음"),

  profile: text('Profile & Personality', '资料与性格', '資料與性格', 'プロフィールと性格', '프로필 및 성격', {"es":"Perfil y personalidad","fr":"Profil et personnalité","de":"Profil & Persönlichkeit","pt-PT":"Perfil e personalidade","pt-BR":"Perfil e personalidade","zh-Hant-x-lzh":"資料與性情","zh-Hans-x-lzh":"资料与性情"}),
  name: text('Name', '名字', '名字', '名前', '이름', {"es":"Nombre","fr":"Nom","de":"Name","pt-PT":"Nome","pt-BR":"Nome","zh-Hant-x-lzh":"名","zh-Hans-x-lzh":"名"}),
  description: text('About', '简介', '簡介', '紹介', '소개', {"es":"Acerca de","fr":"À propos","de":"Über","pt-PT":"Sobre","pt-BR":"Sobre","zh-Hant-x-lzh":"簡介","zh-Hans-x-lzh":"简介"}),
  identity: text('Personality', '性格', '性格', '性格', '성격', {"es":"Personalidad","fr":"Personnalité","de":"Persönlichkeit","pt-PT":"Personalidade","pt-BR":"Personalidade","zh-Hant-x-lzh":"性情","zh-Hans-x-lzh":"性情"}),
  models: text('Models', '模型', '模型', 'モデル', '모델', {"es":"Modelos","fr":"Modèles","de":"Modelle","pt-PT":"Modelos","pt-BR":"Modelos","zh-Hant-x-lzh":"模型","zh-Hans-x-lzh":"模型"}),
  followsDefault: text('Follow app default', '跟随应用默认', '跟隨應用預設', 'アプリのデフォルトに従う', '앱 기본값 사용', {"es":"Usar el predeterminado de la aplicación","fr":"Utiliser le réglage par défaut de l’application","de":"App-Standard verwenden","pt-PT":"Usar a predefinição da aplicação","pt-BR":"Seguir padrão do aplicativo","zh-Hant-x-lzh":"從應用預設","zh-Hans-x-lzh":"从应用默认"}),
  taskModel: text('Task Model', '任务模型', '任務模型', 'セッション用モデル', '세션 모델', {"es":"Modelo de tareas","fr":"Modèle de tâche","de":"Aufgabenmodell","pt-PT":"Modelo de tarefas","pt-BR":"Modelo de tarefas","zh-Hant-x-lzh":"差事模型","zh-Hans-x-lzh":"差事模型"}),
  taskFollowsPrimary: text('Inherit Primary Model', '继承主模型', '繼承主模型', 'メインモデルを継承', '기본 모델 상속', {"es":"Heredar modelo principal","fr":"Utiliser le modèle principal","de":"Primäres Modell übernehmen","pt-PT":"Herdar modelo principal","pt-BR":"Herdar modelo principal","zh-Hant-x-lzh":"承主模型","zh-Hans-x-lzh":"承主模型"}),
  memory: text('Memory', '记忆', '記憶', '記憶', '기억', {"es":"Memoria","fr":"Mémoire","de":"Gedächtnis","pt-PT":"Memória","pt-BR":"Memória","zh-Hant-x-lzh":"記憶","zh-Hans-x-lzh":"记忆"}),
  memoryEnabled: text('Remember Things About Me', '记住与我有关的事', '記住與我有關的事', '私に関することを覚える', '나에 관한 내용 기억하기', {"es":"Recordar cosas sobre mí","fr":"Mémoriser des informations à mon sujet","de":"Dinge über mich merken","pt-PT":"Lembrar-se de coisas sobre mim","pt-BR":"Lembrar informações sobre mim","zh-Hant-x-lzh":"記與吾相關之事","zh-Hans-x-lzh":"记与吾相关之事"}),
  userContext: text('What You Know About Me', '关于我的记忆', '關於我的記憶', '私についての記憶', '나에 관한 기억', {"es":"Lo que sabes sobre mí","fr":"Ce que vous savez de moi","de":"Was du über mich weißt","pt-PT":"O que sabe sobre mim","pt-BR":"O que você sabe sobre mim","zh-Hant-x-lzh":"關於吾之記憶","zh-Hans-x-lzh":"关于吾之记忆"}),
  permissions: text('Operation Permissions', '操作权限', '操作權限', '操作権限', '작업 권한', {"es":"Permisos de operaciones","fr":"Autorisations d’action","de":"Aktionsberechtigungen","pt-PT":"Permissões de operação","pt-BR":"Permissões de operação","zh-Hant-x-lzh":"操作權柄","zh-Hans-x-lzh":"操作权柄"}),
  ask: text('Ask Before Acting', '操作前询问', '操作前詢問', '操作前に確認', '작업 전 확인', {"es":"Preguntar antes de actuar","fr":"Demander avant d’agir","de":"Vor Aktionen fragen","pt-PT":"Perguntar antes de agir","pt-BR":"Perguntar antes de agir","zh-Hant-x-lzh":"行前先問","zh-Hans-x-lzh":"行前先问"}),
  auto: text('Auto Approval', '自动审批', '自動審批', '自動承認', '자동 승인', {"es":"Aprobación automática","fr":"Approbation automatique","de":"Automatisch genehmigen","pt-PT":"Aprovação automática","pt-BR":"Aprovação automática","zh-Hant-x-lzh":"自動審批","zh-Hans-x-lzh":"自动审批"}),
  trusted: text('Full Access', '完全访问', '完整存取', 'フルアクセス', '전체 액세스', {"es":"Acceso completo","fr":"Accès complet","de":"Vollzugriff","pt-PT":"Acesso total","pt-BR":"Acesso total","zh-Hant-x-lzh":"完全存取","zh-Hans-x-lzh":"完全访问"}),
  permissionWarning: text('Changing permissions affects future operations. Full Access allows commands and file changes without asking. Existing connection restrictions still apply.', '权限变更影响后续操作。完全访问允许执行命令和修改文件而不再询问，已有连接限制仍然有效。', '權限變更影響後續操作。完整存取允許執行命令和修改檔案而不再詢問，既有連接限制仍然有效。', '権限の変更は今後の操作に適用されます。フルアクセスでは確認なしでコマンド実行とファイル変更が可能です。既存の接続制限は維持されます。', '권한 변경은 이후 작업에 적용됩니다. 전체 액세스에서는 확인 없이 명령 실행과 파일 변경이 가능합니다. 기존 연결 제한은 유지됩니다.', {"es":"Cambiar los permisos afecta a las operaciones futuras. El acceso completo permite ejecutar comandos y modificar archivos sin preguntar. Las restricciones de conexión existentes siguen vigentes.","fr":"La modification des autorisations affecte les actions futures. L’accès complet autorise les commandes et les modifications de fichiers sans confirmation. Les restrictions de connexion existantes restent applicables.","de":"Änderungen der Berechtigungen gelten für zukünftige Aktionen. Vollzugriff erlaubt Befehle und Dateiänderungen ohne Rückfrage. Bestehende Verbindungsbeschränkungen gelten weiterhin.","pt-PT":"Alterar as permissões afeta as operações futuras. O acesso total permite executar comandos e alterar ficheiros sem pedir autorização. As restrições de ligação existentes continuam a aplicar-se.","pt-BR":"Alterar as permissões afeta operações futuras. O acesso total permite executar comandos e alterar arquivos sem perguntar. As restrições de conexão existentes continuam válidas.","zh-Hant-x-lzh":"權柄變更，及於此後之操作。完全存取許其執行命令、修改卷而不復詢問；既有連接之限制仍然有效。","zh-Hans-x-lzh":"权柄变更，及于此后之操作。完全访问许其运行命令、修改卷而不复询问；既有连接之限制仍然有效。"}),
  restart: text('Restart Teammate', '重启伙伴', '重新啟動夥伴', 'チームメイトを再起動', '팀원 다시 시작', {"es":"Reiniciar compañero","fr":"Redémarrer le coéquipier","de":"Teammitglied neu starten","pt-PT":"Reiniciar colega de equipa","pt-BR":"Reiniciar colega de equipe","zh-Hant-x-lzh":"重啟同僚","zh-Hans-x-lzh":"重启同僚"}),
  restartBody: text('Stop current work and rebuild context on your next message. History, memory and files stay. Independent tasks continue; queued input stays paused.', '停止当前工作，下一条消息重建上下文。记录、记忆和文件保留，独立任务继续，排队输入保持暂停。', '停止目前工作，下一則訊息重建上下文。記錄、記憶和檔案保留，獨立任務繼續，排隊輸入保持暫停。', '現在の作業を停止し、次のメッセージでコンテキストを再構築します。履歴、記憶、ファイルは保持されます。独立したセッションは続行し、待機中の入力は一時停止します。', '현재 작업을 중지하고 다음 메시지에서 컨텍스트를 다시 구성합니다. 기록, 기억, 파일은 유지됩니다. 독립 세션은 계속 실행되며 대기 입력은 일시 중지됩니다.', {"es":"Detiene el trabajo actual y reconstruye el contexto con tu próximo mensaje. Se conservan el historial, la memoria y los archivos. Las tareas independientes continúan; las entradas en cola siguen en pausa.","fr":"Arrêter le travail en cours et reconstruire le contexte à votre prochain message. L’historique, la mémoire et les fichiers sont conservés. Les tâches indépendantes continuent ; les messages en attente restent en pause.","de":"Aktuelle Arbeit stoppen und den Kontext bei deiner nächsten Nachricht neu aufbauen. Verlauf, Gedächtnis und Dateien bleiben erhalten. Unabhängige Aufgaben laufen weiter; Eingaben in der Warteschlange bleiben pausiert.","pt-PT":"Interrompe o trabalho atual e reconstrói o contexto na sua próxima mensagem. O histórico, a memória e os ficheiros são mantidos. As tarefas independentes continuam; as entradas em fila permanecem em pausa.","pt-BR":"Interrompe o trabalho atual e reconstrói o contexto na sua próxima mensagem. O histórico, a memória e os arquivos são mantidos. Tarefas independentes continuam; as entradas na fila permanecem pausadas.","zh-Hant-x-lzh":"止目前之工作，下一則訊至時重建上下文。記錄、記憶與卷皆存，獨立差事照行，排隊之輸入仍暫停。","zh-Hans-x-lzh":"止目前之工作，下一则讯至时重建上下文。记录、记忆与卷皆存，独立差事照行，排队之输入仍暂停。"}),
  delete: text('Delete Teammate', '删除伙伴', '刪除夥伴', 'チームメイトを削除', '팀원 삭제', {"es":"Eliminar compañero","fr":"Supprimer le coéquipier","de":"Teammitglied löschen","pt-PT":"Eliminar colega de equipa","pt-BR":"Excluir colega de equipe","zh-Hant-x-lzh":"刪同僚","zh-Hans-x-lzh":"删同僚"}),
  deleteBody: text('Permanently delete this teammate’s profile, memory, skills and workspace. Task history and independent worktrees are retained. Type the full name to delete.', '永久删除伙伴的资料、记忆、技能和工作区。任务记录和独立 worktree 保留。输入完整名字后删除。', '永久刪除夥伴的資料、記憶、技能和工作區。任務記錄和獨立 worktree 保留。輸入完整名字後刪除。', 'プロフィール、記憶、スキル、ワークスペースを完全に削除します。セッション履歴と独立した worktree は保持されます。削除するには名前全体を入力してください。', '프로필, 기억, 스킬, 작업 공간을 영구 삭제합니다. 세션 기록과 독립 worktree는 유지됩니다. 삭제하려면 전체 이름을 입력하세요.', {"es":"Elimina permanentemente el perfil, la memoria, las habilidades y el espacio de trabajo de este compañero. Se conservan el historial de tareas y los worktrees independientes. Escribe el nombre completo para eliminarlo.","fr":"Supprimer définitivement le profil, la mémoire, les compétences et l’espace de travail de ce coéquipier. L’historique des tâches et les worktrees indépendants sont conservés. Saisissez le nom complet pour confirmer la suppression.","de":"Profil, Gedächtnis, Skills und Arbeitsbereich dieses Teammitglieds dauerhaft löschen. Aufgabenverlauf und unabhängige Worktrees bleiben erhalten. Gib zum Löschen den vollständigen Namen ein.","pt-PT":"Elimine permanentemente o perfil, a memória, as competências e o espaço de trabalho deste colega de equipa. O histórico de tarefas e as worktrees independentes são mantidos. Escreva o nome completo para eliminar.","pt-BR":"Exclui permanentemente o perfil, a memória, as habilidades e o espaço de trabalho deste colega de equipe. O histórico de tarefas e as worktrees independentes são mantidos. Digite o nome completo para excluir.","zh-Hant-x-lzh":"永久刪除同僚之資料、記憶、技藝與工作區。差事記錄與獨立 worktree 保留。輸入完整之名，方可刪除。","zh-Hans-x-lzh":"永久删除同僚之资料、记忆、技艺与工作区。差事记录与独立 worktree 保留。输入完整之名，方可删除。"}),
  resume: text('Resume Teammate', '恢复伙伴', '恢復夥伴', 'チームメイトを再開', '팀원 재개', {"es":"Reanudar compañero","fr":"Réactiver le coéquipier","de":"Teammitglied fortsetzen","pt-PT":"Retomar colega de equipa","pt-BR":"Retomar colega de equipe","zh-Hant-x-lzh":"復起同僚","zh-Hans-x-lzh":"复起同僚"}),
  resumeBody: text('Your teammate starts taking messages and background work again. History, memory and files are unchanged; automations you paused yourself stay paused.', '恢复后伙伴重新接收消息和后台工作。记录、记忆和文件不变，你手动暂停的自动化仍保持暂停。', '恢復後夥伴重新接收訊息和背景工作。記錄、記憶和檔案不變，你手動暫停的自動化仍保持暫停。', '再開すると、チームメイトはメッセージとバックグラウンド作業を再び受け付けます。履歴、記憶、ファイルは変わらず、手動で一時停止した自動化は一時停止のままです。', '재개하면 팀원이 메시지와 백그라운드 작업을 다시 받습니다. 기록, 기억, 파일은 그대로이며 직접 일시 중지한 자동화는 계속 일시 중지됩니다.', {"es":"Tu compañero vuelve a recibir mensajes y trabajo en segundo plano. El historial, la memoria y los archivos no cambian; las automatizaciones que pausaste manualmente siguen en pausa.","fr":"Votre coéquipier recommence à recevoir des messages et à travailler en arrière-plan. L’historique, la mémoire et les fichiers restent inchangés ; les automatisations que vous avez vous-même mises en pause le restent.","de":"Dein Teammitglied nimmt wieder Nachrichten und Hintergrundarbeiten an. Verlauf, Gedächtnis und Dateien bleiben unverändert; Automatisierungen, die du selbst pausiert hast, bleiben pausiert.","pt-PT":"O seu colega de equipa volta a aceitar mensagens e trabalho em segundo plano. O histórico, a memória e os ficheiros permanecem inalterados; as automatizações que colocou em pausa manualmente continuam em pausa.","pt-BR":"Seu colega de equipe volta a receber mensagens e tarefas em segundo plano. O histórico, a memória e os arquivos não mudam; as automações que você pausou manualmente permanecem pausadas.","zh-Hant-x-lzh":"復起之後，同僚重新受訊、行背景工作。記錄、記憶與卷不變；君手動暫停之自運仍暫停。","zh-Hans-x-lzh":"复起之后，同僚重新受讯、行背景工作。记录、记忆与卷不变；君手动暂停之自运仍暂停。"}),
  save: text('Save Changes', '保存更改', '儲存變更', '変更を保存', '변경 사항 저장', {"es":"Guardar cambios","fr":"Enregistrer les modifications","de":"Änderungen speichern","pt-PT":"Guardar alterações","pt-BR":"Salvar alterações","zh-Hant-x-lzh":"存變更","zh-Hans-x-lzh":"存变更"}),
  saved: text('Teammate settings saved', '伙伴设置已保存', '夥伴設定已儲存', 'チームメイトの設定を保存しました', '팀원 설정을 저장했습니다', {"es":"Ajustes del compañero guardados","fr":"Paramètres du coéquipier enregistrés","de":"Einstellungen des Teammitglieds gespeichert","pt-PT":"Definições do colega de equipa guardadas","pt-BR":"Configurações do colega de equipe salvas","zh-Hant-x-lzh":"同僚規制已存","zh-Hans-x-lzh":"同僚规制已存"}),
  restarted: text('Teammate restarted; send a message to continue', '伙伴已重启，发送消息即可继续', '夥伴已重新啟動，傳送訊息即可繼續', 'チームメイトを再起動しました。メッセージを送って続行できます', '팀원을 다시 시작했습니다. 메시지를 보내 계속하세요', {"es":"Compañero reiniciado; envía un mensaje para continuar","fr":"Coéquipier redémarré ; envoyez un message pour continuer","de":"Teammitglied neu gestartet; sende eine Nachricht, um fortzufahren","pt-PT":"Colega de equipa reiniciado; envie uma mensagem para continuar","pt-BR":"Colega de equipe reiniciado; envie uma mensagem para continuar","zh-Hant-x-lzh":"同僚已重啟，遣訊即可續之","zh-Hans-x-lzh":"同僚已重启，遣讯即可续之"}),
  deleted: text('Teammate deleted', '伙伴已删除', '夥伴已刪除', 'チームメイトを削除しました', '팀원을 삭제했습니다', {"es":"Compañero eliminado","fr":"Coéquipier supprimé","de":"Teammitglied gelöscht","pt-PT":"Colega de equipa eliminado","pt-BR":"Colega de equipe excluído","zh-Hant-x-lzh":"同僚已刪","zh-Hans-x-lzh":"同僚已删"}),
  warning: text('Operation completed with cleanup warnings. Check this teammate on your computer.', '操作已完成，但清理有待检查。请在电脑上检查此伙伴。', '操作已完成，但清理有待檢查。請在電腦上檢查此夥伴。', '操作は完了しましたが、クリーンアップの確認が必要です。パソコンでこのチームメイトを確認してください。', '작업은 완료되었지만 정리 내용을 확인해야 합니다. 컴퓨터에서 이 팀원을 확인하세요.', {"es":"Operación completada con advertencias de limpieza. Revisa este compañero en tu equipo.","fr":"Opération terminée avec des avertissements de nettoyage. Vérifiez ce coéquipier sur votre ordinateur.","de":"Vorgang mit Warnungen bei der Bereinigung abgeschlossen. Überprüfe dieses Teammitglied auf deinem Computer.","pt-PT":"Operação concluída com avisos de limpeza. Verifique este colega de equipa no seu computador.","pt-BR":"Operação concluída com avisos de limpeza. Verifique este colega de equipe no seu computador.","zh-Hant-x-lzh":"操作已畢，然清理尚待察驗。請於機上察此同僚。","zh-Hans-x-lzh":"操作已毕，然清理尚待察验。请于机上察此同僚。"}),
};
// Name/avatar changes do not advance the runtime version. Include settings facts,
// while excluding chat activity so an arriving reply cannot invalidate a settings draft.
const settingsRevision = ({ source, ...settings }: Settings) => createHash('sha256').update(JSON.stringify([
  source.currentVersion, source.name, source.description, source.avatar, source.status, settings,
])).digest('hex');

/** Bounded, expiring, owner/controller/version-bound opaque actions. No raw IPC or filesystem grants. */
export function createBotRemoteSettingsResource(deps: BotRemoteSettingsDeps) {
  const grants = new Map<string, Grant>();
  const now = deps.now ?? Date.now;
  const bound = new Map<string, BoundGrant>();
  const submitting = new Set<string>();
  /** All module-specific actions, including routines, use this same opaque admission boundary.
   * The fixed inner action ids are display semantics only, never public mutation authority. */
  const bindResource = async (context: RemoteResourceHostContext, resource: RemoteResource,
    readRevision: () => Promise<string>, run: (request: RemoteActionInvokeRequest) => Promise<RemoteActionInvokeResponse>) => {
    const owner = deps.owner();
    deps.assertOwner(owner);
    const revision = resource.revision;
    if (await readRevision() !== revision) throwIpcError('PRECONDITION_FAILED', 'Resource changed while reading');
    deps.assertOwner(owner);
    const check = async () => {
      deps.assertOwner(owner);
      if (await readRevision() !== revision) throwIpcError('PRECONDITION_FAILED', 'Resource changed; refresh before retrying');
      deps.assertOwner(owner);
    };
    const ids: Record<string, string> = {};
    const actions = (resource.actions ?? []).map(action => {
      for (const [id, grant] of bound) if (grant.expires <= now()) bound.delete(id);
      while (bound.size >= 2048) bound.delete(bound.keys().next().value!);
      const id = randomUUID(); ids[action.id] = id;
      bound.set(id, { owner, controller: context.controllerDeviceId, ref: resource.ref, expires: now() + 15 * 60_000, check,
        run: request => {
          if (action.disabled) throwIpcError('PRECONDITION_FAILED', 'Action unavailable');
          return run({ ...request, actionId: action.id });
        } });
      return { ...action, id };
    });
    return { ...resource, actions, blocks: resource.blocks?.map(block => {
      const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {};
      return { ...block, data: { ...data, operationActions: ids,
        ...(typeof data.actionId === 'string' ? { actionId: ids[data.actionId] } : {}) } };
    }) };
  };
  const issue = (context: RemoteResourceHostContext, owner: string, settings: Settings, operation: Operation): string => {
    const { source } = settings;
    for (const [id, grant] of grants) if (grant.expires <= now()) grants.delete(id);
    while (grants.size >= 1024) grants.delete(grants.keys().next().value!);
    const id = randomUUID();
    grants.set(id, { owner, controller: context.controllerDeviceId, botId: source.id, version: source.currentVersion, revision: settingsRevision(settings), operation, expires: now() + 15 * 60_000 });
    return id;
  };
  const get = async (context: RemoteResourceHostContext, botId: string): Promise<RemoteResource> => {
    const owner = deps.owner();
    deps.assertOwner(owner);
    const settings = await deps.read(botId);
    deps.assertOwner(owner);
    const { source } = settings;
    const resource = botRemoteResourceFromSource(source);
    resource.revision = settingsRevision(settings);
    const actions: RemoteActionDescriptor[] = [];
    const form = (operation: Operation, fields: RemoteActionDescriptor['fields'], values: Record<string, unknown>) => {
      // A file-imported personality can exceed the portable editor's limit. Never expose a
      // truncated draft as editable: retaining the original is more important than a save button.
      if (Object.values(values).some(value => typeof value === 'string' && value.length > 12_000)) {
        return { id: operation, primitive: 'markdown', title: copy[operation], fallbackMarkdown: Object.values(values).filter(value => typeof value === 'string').join('\n\n').slice(0, 60_000) };
      }
      const id = issue(context, owner, settings, operation);
      const preparing = source.invitation && source.invitation.stage !== 'ready'
        && !(source.invitation.stage === 'avatar' && source.canonicalSessionId);
      actions.push({ id, label: copy[operation], fields,
        ...(operation === 'profile' && preparing ? { disabled: true } : {}),
        ...(operation === 'permissions' ? { confirmation: { title: copy.permissions, body: copy.permissionWarning, confirmLabel: copy.save } } : {}) });
      return { id: operation, primitive: 'form', title: copy[operation], fallbackMarkdown: operation === 'models' ? settings.modelChain.map(route => [route.model, route.providerId, route.harness, route.effort, `Fast: ${route.fastMode}`].filter(Boolean).join(' · ')).join('\n') : copy[operation].fallback, data: { actionId: id, values } };
    };
    resource.blocks = [
      form('profile', [{ id: 'name', kind: 'text', label: copy.name, required: true }, { id: 'description', kind: 'multiline', label: copy.description }, { id: 'identity', kind: 'multiline', label: copy.identity }], { name: source.name, description: source.description, identity: settings.identity }),
      form('memory', [{ id: 'memory', kind: 'toggle', label: copy.memoryEnabled }, { id: 'userContext', kind: 'multiline', label: copy.userContext }], { memory: settings.memory, userContext: settings.userContext }),
      form('permissions', [{ id: 'permissions', kind: 'select', label: copy.permissions, options: ['ask', 'auto', 'trusted'].map(value => ({ value, label: copy[value as 'ask' | 'auto' | 'trusted'] })) }], { permissions: settings.permissions }),
      form('models', [{ id: 'followsDefault', label: copy.followsDefault, kind: 'toggle' }, { id: 'modelChain', label: copy.models, kind: 'multiline' },
        { id: 'taskFollowsPrimary', label: copy.taskFollowsPrimary, kind: 'toggle' },
        { id: 'taskModel', label: copy.taskModel, kind: 'multiline' }],
        { followsDefault: settings.followsDefault, modelChain: serializeModelRoutes(settings.modelChain),
          taskFollowsPrimary: !settings.taskModelOverride,
          taskModel: serializeModelRoutes(settings.taskModelOverride ? [settings.taskModelOverride] : settings.modelChain.slice(0, 1)) }),
      { id: 'connections', primitive: 'markdown', fallbackMarkdown: [...settings.skills, ...settings.connections, ...settings.toolsets].join('\n') },
    ];
    if (deps.mediaModels) {
      const media = parseTeammateMediaModels(settings.mediaModels);
      const catalog = await deps.mediaModels();
      deps.assertOwner(owner);
      const encode = (ref: { providerId: string; modelId: string } | null | undefined) => ref ? JSON.stringify({ providerId: ref.providerId, modelId: ref.modelId }) : 'inherit';
      const selections = [
        ['vision', copy.mediaVision, media?.vision?.primary],
        ['fallback', copy.mediaFallback, media?.vision?.fallback],
        ['image', copy.mediaImage, media?.image],
        ['video', copy.mediaVideo, media?.video],
      ] as const;
      resource.blocks.push(form('media', selections.filter(([id]) => id !== 'fallback' || media?.vision).map(([id, label, selected]) => {
        const choices = catalog[id === 'fallback' ? 'vision' : id];
        const options = [{ value: 'inherit', label: id === 'fallback' ? copy.mediaNone : copy.mediaInherit },
          ...choices.map(ref => ({ value: encode(ref), label: { fallback: ref.label } }))];
        if (selected && !choices.some(ref => encode(ref) === encode(selected))) options.push({ value: encode(selected), label: { fallback: `${selected.modelId} · ${selected.providerId}` } });
        return { id, label, kind: 'select', options };
      }), Object.fromEntries(selections.map(([id, , selected]) => [id, encode(selected)]))));
    }
    // A failed shelf read must not turn into an empty shelf or prevent profile recovery.
    try {
      const skills = await deps.skills(botId);
      deps.assertOwner(owner);
      resource.blocks.push({ id: 'skills', primitive: 'markdown', fallbackMarkdown: skills.map(skill => `${skill.name}\n${skill.description}`).join('\n\n') });
    } catch { deps.assertOwner(owner); }
    if (deps.directHistory) {
      try {
        const history = await deps.directHistory(botId);
        deps.assertOwner(owner);
        resource.blocks.push({ id: 'direct', primitive: 'markdown', fallbackMarkdown: history });
      } catch { deps.assertOwner(owner); }
    }
    for (const operation of (source.status === 'paused' ? ['resume', 'delete'] : ['restart', 'delete']) as Array<'restart' | 'delete' | 'resume'>) {
      actions.push({ id: issue(context, owner, settings, operation), label: copy[operation], tone: operation === 'delete' ? 'destructive' : 'neutral',
        confirmation: { title: copy[operation], body: { restart: copy.restartBody, delete: copy.deleteBody, resume: copy.resumeBody }[operation], confirmLabel: copy[operation] },
        ...(operation === 'delete' ? { fields: [{ id: 'confirmName', label: copy.name, kind: 'text', required: true }] } : {}) });
      resource.blocks.push({ id: operation, primitive: 'action', fallbackMarkdown: copy[operation].fallback, data: { actionId: actions.at(-1)!.id } });
    }
    resource.actions = actions;
    deps.assertOwner(owner);
    return resource;
  };
  const invoke = async (context: RemoteResourceHostContext, request: RemoteActionInvokeRequest): Promise<RemoteActionInvokeResponse> => {
    const external = bound.get(request.actionId);
    if (external) {
      if (external.expires <= now() || external.controller !== context.controllerDeviceId
        || request.collectionId !== external.ref.collectionId || request.resourceRef?.collectionId !== external.ref.collectionId
        || request.resourceRef?.kind !== external.ref.kind || request.resourceRef?.id !== external.ref.id)
        throwIpcError('PRECONDITION_FAILED', 'Refresh before retrying');
      deps.assertOwner(external.owner);
      const lock = `${external.owner}:${external.ref.collectionId}:${external.ref.id}`;
      if (submitting.has(lock)) throwIpcError('PRECONDITION_FAILED', 'Resource is being updated');
      submitting.add(lock);
      try {
        await external.check();
        if (bound.get(request.actionId) !== external || external.expires <= now()) throwIpcError('PRECONDITION_FAILED', 'Action already submitted or expired');
        bound.delete(request.actionId);
        const response = await external.run(request);
        deps.assertOwner(external.owner);
        return response;
      } finally { submitting.delete(lock); }
    }
    const grant = grants.get(request.actionId);
    if (!grant || grant.expires <= now() || grant.controller !== context.controllerDeviceId || grant.botId !== request.resourceRef?.id
      || request.collectionId !== 'teammates' || request.resourceRef?.collectionId !== 'teammates' || request.resourceRef?.kind !== 'bot')
      throwIpcError('PRECONDITION_FAILED', 'Refresh teammate settings before retrying');
    deps.assertOwner(grant.owner);
    const lock = `${grant.owner}:teammates:${grant.botId}`;
    if (submitting.has(lock)) throwIpcError('PRECONDITION_FAILED', 'Teammate is being updated');
    submitting.add(lock);
    try {
    const guard = async () => {
      deps.assertOwner(grant.owner);
      const current = await deps.read(grant.botId);
      deps.assertOwner(grant.owner);
      if (settingsRevision(current) !== grant.revision) throwIpcError('PRECONDITION_FAILED', 'Teammate settings changed; refresh before retrying');
    };
    await guard();
    const input = request.input ?? {};
    const allowed: readonly string[] = { media: ['vision', 'fallback', 'image', 'video'], models: ['followsDefault', 'modelChain', 'taskFollowsPrimary', 'taskModel'], profile: ['name', 'description', 'identity'], memory: ['memory', 'userContext'], permissions: ['permissions'], restart: [], resume: [], delete: ['confirmName'] }[grant.operation];
    if (Object.keys(input).some(key => !allowed.includes(key))) throwIpcError('INVALID_PARAMS', 'Unknown teammate field');
    const string = (key: string, max = 12_000) => {
      const value = input[key];
      if (typeof value !== 'string' || value.length > max) throwIpcError('INVALID_PARAMS', 'Invalid teammate field');
      return value;
    };
    let patch: Record<string, unknown> | null = null;
    if (grant.operation === 'profile') patch = {
      ...('name' in input ? { name: string('name', 200) } : {}),
      ...('description' in input ? { description: string('description') } : {}),
      ...('identity' in input ? { identitySource: string('identity') } : {}),
    };
    if (grant.operation === 'memory') {
      if ('memory' in input && typeof input.memory !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid memory setting');
      patch = {
        ...('userContext' in input ? { userContextSource: string('userContext') } : {}),
        ...('memory' in input ? { capabilities: { memory: input.memory } } : {}),
      };
    }
    if (grant.operation === 'media') {
      const settings = await deps.read(grant.botId); deps.assertOwner(grant.owner);
      const previous = parseTeammateMediaModels(settings.mediaModels);
      const selection = (id: string, before: unknown) => {
        if (!(id in input)) return before;
        const raw = string(id);
        if (raw === 'inherit') return null;
        try { return JSON.parse(raw); } catch { return throwIpcError('INVALID_PARAMS', 'Invalid media selection'); }
      };
      const primary = selection('vision', previous?.vision?.primary);
      let mediaModels;
      try { mediaModels = parseTeammateMediaModels({
        vision: primary ? { primary, fallback: selection('fallback', previous?.vision?.fallback ?? null) } : null,
        image: selection('image', previous?.image), video: selection('video', previous?.video),
      }); } catch { return throwIpcError('INVALID_PARAMS', 'Invalid media selection'); }
      patch = { capabilities: { mediaModels } };
    }
    if (grant.operation === 'models') {
      const settings = await deps.read(grant.botId); deps.assertOwner(grant.owner);
      if ('followsDefault' in input && typeof input.followsDefault !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid model preference');
      const followsDefault = input.followsDefault ?? settings.followsDefault;
      let chain = settings.modelChain;
      if ('modelChain' in input) {
        let value: unknown;
        try { value = JSON.parse(string('modelChain')); } catch { throwIpcError('INVALID_PARAMS', 'Invalid model chain'); }
        chain = normalizeBotModelChain(value);
        if (!Array.isArray(value) || !chain.length || chain.length !== value.length || value.some(route => !['claude', 'codex', 'pi'].includes(route?.harness))) throwIpcError('INVALID_PARAMS', 'Invalid model chain');
      }
      const capabilities: Record<string, unknown> = {};
      // Old clients only send primary fields. Absence must preserve the task override.
      if ('followsDefault' in input || 'modelChain' in input) {
        capabilities.modelChainOverride = followsDefault ? null : chain;
        capabilities.modelOverride = null;
      }
      if ('taskFollowsPrimary' in input || 'taskModel' in input) {
        if ('taskFollowsPrimary' in input && typeof input.taskFollowsPrimary !== 'boolean')
          throwIpcError('INVALID_PARAMS', 'Invalid task model preference');
        const inherits = input.taskFollowsPrimary ?? !settings.taskModelOverride;
        let route: BotModelRoute | null = settings.taskModelOverride ?? chain[0] ?? null;
        if (!inherits && 'taskModel' in input) {
          try {
            const value = JSON.parse(string('taskModel'));
            if (!Array.isArray(value) || value.length !== 1) throw new Error('Invalid task model');
            route = readBotTaskModelOverride(value[0]);
          } catch { throwIpcError('INVALID_PARAMS', 'Invalid task model'); }
        }
        if (!inherits && !route) throwIpcError('INVALID_PARAMS', 'Task model required');
        capabilities.taskModelOverride = inherits ? null : route;
      }
      patch = { capabilities };
    }
    if (patch && !Object.keys(patch).length) throwIpcError('INVALID_PARAMS', 'No changed teammate fields');
    if (grant.operation === 'permissions') {
      if (!['ask', 'auto', 'trusted'].includes(String(input.permissions))) throwIpcError('INVALID_PARAMS', 'Invalid permissions');
      patch = { capabilities: { permissions: input.permissions } };
    }
    // Consume before any side effect: ambiguous responses must be reconciled by a new read, never replayed.
    if (grants.get(request.actionId) !== grant)
      throwIpcError('PRECONDITION_FAILED', 'Action already submitted; refresh teammate settings');
    grants.delete(request.actionId);
    let warnings: string[] | undefined;
    if (patch) await deps.update({ id: grant.botId, ...patch }, grant.version);
    else if (grant.operation === 'restart' || grant.operation === 'delete' || grant.operation === 'resume')
      ({ warnings } = await deps.lifecycle(grant.botId, grant.operation, grant.operation === 'delete' ? string('confirmName', 200) : undefined, guard));
    else throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Action unavailable');
    deps.assertOwner(grant.owner);
    return { effects: [
      { kind: 'refresh-collection', collectionId: request.collectionId },
      ...(grant.operation === 'delete' ? [] : [{ kind: 'refresh-resource' as const, ref: request.resourceRef! }]),
      { kind: 'toast', message: warnings?.length ? copy.warning : grant.operation === 'delete' ? copy.deleted : grant.operation === 'restart' ? copy.restarted : copy.saved },
    ] };
    } finally { submitting.delete(lock); }
  };
  return { get, invoke, bindResource };
}
