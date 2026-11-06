/**
 * 启动期「端点清单获取失败」系统弹框的四语文案与内容组装。
 *
 * 这个框弹在 createWindow 之前,renderer 与 i18next 都还不存在,所以文案只能手写在
 * main 侧。原实现把中英两段直接拼在同一个 detail 里(「无法获取服务器配置 … Failed to
 * load the server endpoint manifest …」),用户看到的是一屏中英混排;这里改成按系统
 * 语言选一种语言输出。
 *
 * 单独成模块的理由与 applicationMenuLabels / oauthResultPage 相同:
 * `scripts/check-i18n-glossary.mjs` 只读 renderer 的 locale JSON,扫不到手写 catalog,
 * 抽出来才能被 __tests__/endpointManifestDialogCopyGlossary.test.ts 直接 import 扫描;
 * 也避免测试为了拿文案去 import 整个 Electron 主进程模块。
 *
 * 组装逻辑(buildEndpointManifestDialogContent)是纯函数:失败分类、按钮集合与
 * detail 排版都不碰 Electron,由 clientEndpointsService 负责真正弹框。弹框直接展示
 * 简短错误信息；清单来源、网络探针与本机路径默认只进日志，用户主动点击「复制诊断
 * 信息」时才组装进剪贴板文本。
 */
import type { SupportedLocale } from '../shared/locale.js';

export type EndpointManifestDialogLocale = SupportedLocale;

/**
 * 失败分类。**判定规则的唯一事实源是 clientEndpointsService 的
 * classifyManifestFailure**;下面只是举例说明两类的意图,不要按举例反推边界。
 *
 * network = 拿不到清单但重试 / 离线出口有意义:传输层失败(超时 / DNS / 代理 / ERR_*)、
 * 5xx,以及 407 / 408 / 425 / 429 这类**非配置 4xx**(407 只可能来自代理,描述的是本机
 * 网络环境;其余是瞬时)。可重试、可能给离线出口。
 * config = 拿不到**可用**清单且重试无意义:正文内容不合法、region 不匹配、烘焙基址为空,
 * 以及**永久性** HTTP 3xx/4xx(路径 / 权限 / 部署错)。这一类不给离线出口。
 */
export type EndpointManifestFailureKind = 'network' | 'config';

/** 用户在弹框上做出的选择。 */
export type EndpointManifestDialogChoice = 'retry' | 'offline' | 'exit';
/** 弹框内部动作;复制诊断后仍停留在当前弹框,不会进入阻断循环。 */
export type EndpointManifestDialogAction = EndpointManifestDialogChoice | 'copy-diagnostics';
/** 复制诊断的结果,用于在同一个弹框里明确反馈成功或失败。 */
export type EndpointManifestDialogCopyStatus = 'idle' | 'success' | 'failed';

export interface EndpointManifestDialogCopy {
  networkTitle: string;
  configTitle: string;
  networkBody: string;
  configBody: string;
  errorLine: string;
  diagnosticsHint: string;
  copyDiagnosticsButton: string;
  copiedHint: string;
  copyFailedHint: string;
  noSavedConfigurationHint: string;
  offlineHint: string;
  retryButton: string;
  offlineButton: string;
  quitButton: string;
}

export const ENDPOINT_MANIFEST_DIALOG_COPY: Record<
  EndpointManifestDialogLocale,
  EndpointManifestDialogCopy
> = {
  'zh-CN': {
    networkTitle: 'Cindy 暂时无法连接',
    configTitle: 'Cindy 暂时无法启动',
    networkBody:
      '启动时未能连接到 Cindy 服务。请确认设备已联网，然后重新尝试启动。如果正在使用 Proxy 或公司网络，可以切换网络后再试。',
    configBody: 'Cindy 暂时无法完成启动。请稍后重新尝试；如果问题持续出现，请联系技术支持。',
    errorLine: '错误信息：{{error}}',
    diagnosticsHint: '需要反馈时，可以复制诊断信息后粘贴给我们。',
    copyDiagnosticsButton: '复制诊断信息',
    copiedHint: '诊断信息已复制。请粘贴到反馈消息中。',
    copyFailedHint: '诊断信息未能复制，请重试。',
    noSavedConfigurationHint: '这台设备没有可用的历史配置，需要恢复连接后才能继续启动。',
    offlineHint:
      '也可以用上次成功获取的配置离线启动（获取于 {{savedAt}}），需要联网的功能会不可用。',
    retryButton: '重试启动 Cindy',
    offlineButton: '用上次配置启动',
    quitButton: '退出 Cindy',
  },
  'zh-TW': {
    networkTitle: 'Cindy 暫時無法連線',
    configTitle: 'Cindy 暫時無法啟動',
    networkBody:
      '啟動時無法連線到 Cindy 服務。請確認裝置已連線網路，然後再次嘗試啟動。如果正在使用 Proxy 或公司網路，可以切換網路後再試。',
    configBody: 'Cindy 暫時無法完成啟動。請稍後再試；如果問題持續發生，請聯絡技術支援。',
    errorLine: '錯誤資訊：{{error}}',
    diagnosticsHint: '需要協助時，可以複製診斷資訊並貼到支援訊息中。',
    copyDiagnosticsButton: '複製診斷資訊',
    copiedHint: '診斷資訊已複製。請貼到支援訊息中。',
    copyFailedHint: '無法複製診斷資訊，請再試一次。',
    noSavedConfigurationHint: '此裝置沒有可用的歷史設定，必須恢復連線後才能繼續啟動。',
    offlineHint: '也可以使用上次成功取得的設定離線啟動（取得時間：{{savedAt}}），需要網路的功能將無法使用。',
    retryButton: '再次嘗試啟動 Cindy',
    offlineButton: '使用上次的設定',
    quitButton: '結束 Cindy',
  },
  en: {
    networkTitle: "Cindy Couldn't Connect",
    configTitle: "Cindy Couldn't Start",
    networkBody:
      "Cindy couldn't connect to its services during startup. Check that this device is online, then try starting again. If you're using a proxy or company network, try switching networks.",
    configBody:
      "Cindy couldn't finish starting right now. Try again later. If the problem continues, contact support.",
    errorLine: 'Error: {{error}}',
    diagnosticsHint: 'If you need help, copy the diagnostics into your support message.',
    copyDiagnosticsButton: 'Copy Diagnostics',
    copiedHint: 'Diagnostics copied. Paste them into your support message.',
    copyFailedHint: "Diagnostics couldn't be copied. Try again.",
    noSavedConfigurationHint:
      'This device has no saved configuration yet, so Cindy needs to reconnect before it can start.',
    offlineHint:
      'You can also start offline with the configuration Cindy last fetched ({{savedAt}}). Features that need a network connection will be unavailable.',
    retryButton: 'Try Starting Cindy Again',
    offlineButton: 'Use Last Configuration',
    quitButton: 'Quit Cindy',
  },
  ja: {
    networkTitle: 'Cindy に一時的に接続できません',
    configTitle: 'Cindy を一時的に起動できません',
    networkBody:
      '起動時に Cindy のサービスへ接続できませんでした。デバイスがネットワークに接続されていることを確認して、もう一度起動してください。プロキシや社内ネットワークを使用している場合は、ネットワークを切り替えてお試しください。',
    configBody:
      'Cindy の起動を完了できませんでした。時間をおいてもう一度お試しください。問題が続く場合は、サポートにお問い合わせください。',
    errorLine: 'エラー情報: {{error}}',
    diagnosticsHint: 'サポートが必要な場合は、診断情報をコピーしてメッセージに貼り付けてください。',
    copyDiagnosticsButton: '診断情報をコピー',
    copiedHint: '診断情報をコピーしました。サポートへのメッセージに貼り付けてください。',
    copyFailedHint: '診断情報をコピーできませんでした。もう一度お試しください。',
    noSavedConfigurationHint:
      'このデバイスには利用できる保存済み設定がないため、接続が回復してから起動を続ける必要があります。',
    offlineHint:
      '前回取得できた設定でオフライン起動することもできます（取得日時: {{savedAt}}）。ネットワークが必要な機能は利用できません。',
    retryButton: 'Cindy の起動を再試行',
    offlineButton: '前回の設定で起動',
    quitButton: 'Cindy を終了',
  },
  ko: {
    networkTitle: 'Cindy에 일시적으로 연결할 수 없습니다',
    configTitle: 'Cindy를 일시적으로 시작할 수 없습니다',
    networkBody:
      '시작하는 동안 Cindy 서비스에 연결하지 못했습니다. 기기가 네트워크에 연결되어 있는지 확인한 후 다시 시작해 보세요. 프록시나 회사 네트워크를 사용 중이라면 다른 네트워크로 전환해 보세요.',
    configBody:
      '지금은 Cindy 시작을 완료할 수 없습니다. 잠시 후 다시 시도해 주세요. 문제가 계속되면 지원팀에 문의해 주세요.',
    errorLine: '오류 정보: {{error}}',
    diagnosticsHint: '도움이 필요하면 진단 정보를 복사해 지원 메시지에 붙여 넣어 주세요.',
    copyDiagnosticsButton: '진단 정보 복사',
    copiedHint: '진단 정보를 복사했습니다. 지원 메시지에 붙여 넣어 주세요.',
    copyFailedHint: '진단 정보를 복사하지 못했습니다. 다시 시도해 주세요.',
    noSavedConfigurationHint:
      '이 기기에는 사용할 수 있는 저장된 설정이 없어 연결이 복구된 후에 시작할 수 있습니다.',
    offlineHint:
      '마지막으로 가져온 설정으로 오프라인 시작할 수도 있습니다({{savedAt}} 기준). 네트워크가 필요한 기능은 사용할 수 없습니다.',
    retryButton: 'Cindy 시작 다시 시도',
    offlineButton: '지난 설정으로 시작',
    quitButton: 'Cindy 종료',
  },

  "es": {
    "networkTitle": "Cindy no se pudo conectar",
    "configTitle": "Cindy no pudo iniciar",
    "networkBody": "Cindy no pudo conectarse a sus servicios durante el inicio. Revisa la conexión de este dispositivo y vuelve a iniciarlo. Si usas un proxy o una red empresarial, prueba con otra red.",
    "configBody": "Cindy no pudo completar el inicio. Inténtalo más tarde. Si el problema continúa, contacta con soporte.",
    "errorLine": "Error: {{error}}",
    "diagnosticsHint": "Si necesitas ayuda, copia los diagnósticos en tu mensaje de soporte.",
    "copyDiagnosticsButton": "Copiar diagnóstico",
    "copiedHint": "Se copiaron los diagnósticos. Pégalos en tu mensaje de soporte.",
    "copyFailedHint": "No se pudieron copiar los datos de diagnóstico. Vuelve a intentarlo.",
    "noSavedConfigurationHint": "Este dispositivo aún no tiene una configuración guardada. Cindy necesita volver a conectarse para iniciar.",
    "offlineHint": "También puedes iniciar sin conexión con la última configuración que Cindy obtuvo ({{savedAt}}). Las funciones que requieren conexión no estarán disponibles.",
    "retryButton": "Reintentar inicio de Cindy",
    "offlineButton": "Usar la última configuración",
    "quitButton": "Salir de Cindy"
  },
  "fr": {
    "networkTitle": "Cindy n’a pas pu se connecter",
    "configTitle": "Cindy n’a pas pu démarrer",
    "networkBody": "Cindy n’a pas pu se connecter à ses services au démarrage. Vérifiez que cet appareil est en ligne, puis relancez. Si vous utilisez un proxy ou un réseau d’entreprise, essayez de changer de réseau.",
    "configBody": "Cindy n’a pas pu terminer son démarrage pour le moment. Réessayez plus tard. Si le problème persiste, contactez l’assistance.",
    "errorLine": "Erreur : {{error}}",
    "diagnosticsHint": "Si vous avez besoin d’aide, copiez les diagnostics dans votre message à l’assistance.",
    "copyDiagnosticsButton": "Copier les diagnostics",
    "copiedHint": "Diagnostics copiés. Collez-les dans votre message à l’assistance.",
    "copyFailedHint": "Impossible de copier les diagnostics. Réessayez.",
    "noSavedConfigurationHint": "Cet appareil n’a encore aucune configuration enregistrée : Cindy doit se reconnecter avant de pouvoir démarrer.",
    "offlineHint": "Vous pouvez aussi démarrer hors ligne avec la dernière configuration récupérée par Cindy ({{savedAt}}). Les fonctionnalités qui nécessitent une connexion réseau seront indisponibles.",
    "retryButton": "Relancer Cindy",
    "offlineButton": "Utiliser la dernière configuration",
    "quitButton": "Quitter Cindy"
  },
  "de": {
    "networkTitle": "Cindy konnte keine Verbindung herstellen",
    "configTitle": "Cindy konnte nicht gestartet werden",
    "networkBody": "Cindy konnte beim Start keine Verbindung zu seinen Diensten herstellen. Prüfe, ob dieses Gerät online ist, und starte Cindy erneut. Wenn du einen Proxy oder ein Unternehmensnetzwerk verwendest, versuche es mit einem anderen Netzwerk.",
    "configBody": "Cindy konnte gerade nicht vollständig starten. Versuche es später erneut. Wende dich an den Support, falls das Problem weiterhin besteht.",
    "errorLine": "Fehler: {{error}}",
    "diagnosticsHint": "Wenn du Hilfe benötigst, kopiere die Diagnosedaten in deine Nachricht an den Support.",
    "copyDiagnosticsButton": "Diagnosedaten kopieren",
    "copiedHint": "Diagnosedaten kopiert. Füge sie in deine Nachricht an den Support ein.",
    "copyFailedHint": "Die Diagnosedaten konnten nicht kopiert werden. Versuche es erneut.",
    "noSavedConfigurationHint": "Dieses Gerät hat noch keine gespeicherte Konfiguration, daher muss Cindy erneut eine Verbindung herstellen, bevor es gestartet werden kann.",
    "offlineHint": "Du kannst auch mit Cindys zuletzt abgerufener Konfiguration ({{savedAt}}) offline starten. Funktionen mit Netzwerkzugriff sind dann nicht verfügbar.",
    "retryButton": "Cindy erneut starten",
    "offlineButton": "Letzte Konfiguration verwenden",
    "quitButton": "Cindy beenden"
  },
  "pt-PT": {
    "networkTitle": "Não foi possível ligar a Cindy",
    "configTitle": "Não foi possível iniciar a Cindy",
    "networkBody": "A Cindy não conseguiu ligar-se aos seus serviços ao iniciar. Verifique se este dispositivo está ligado à Internet e tente iniciar novamente. Se utilizar um proxy ou uma rede da empresa, experimente outra rede.",
    "configBody": "Não foi possível concluir o arranque da Cindy. Tente novamente mais tarde. Se o problema persistir, contacte o suporte.",
    "errorLine": "Erro: {{error}}",
    "diagnosticsHint": "Se precisar de ajuda, copie os dados de diagnóstico para a mensagem enviada ao suporte.",
    "copyDiagnosticsButton": "Copiar dados de diagnóstico",
    "copiedHint": "Dados de diagnóstico copiados. Cole-os na mensagem para o suporte.",
    "copyFailedHint": "Não foi possível copiar os dados de diagnóstico. Tente novamente.",
    "noSavedConfigurationHint": "Este dispositivo ainda não tem uma configuração guardada. A Cindy tem de voltar a ligar-se para poder iniciar.",
    "offlineHint": "Também pode iniciar sem ligação à Internet com a última configuração obtida pela Cindy ({{savedAt}}). As funcionalidades que precisam de rede ficarão indisponíveis.",
    "retryButton": "Tentar iniciar a Cindy novamente",
    "offlineButton": "Utilizar a última configuração",
    "quitButton": "Sair de Cindy"
  },
  "pt-BR": {
    "networkTitle": "Não foi possível conectar a Cindy",
    "configTitle": "Não foi possível iniciar a Cindy",
    "networkBody": "A Cindy não conseguiu se conectar aos serviços ao iniciar. Verifique se este dispositivo está conectado à Internet e tente iniciar novamente. Se usar um proxy ou uma rede da empresa, tente outra rede.",
    "configBody": "Não foi possível concluir a inicialização da Cindy. Tente novamente mais tarde. Se o problema persistir, entre em contato com o suporte.",
    "errorLine": "Erro: {{error}}",
    "diagnosticsHint": "Se precisar de ajuda, copie os dados de diagnóstico para a mensagem enviada ao suporte.",
    "copyDiagnosticsButton": "Copiar dados de diagnóstico",
    "copiedHint": "Dados de diagnóstico copiados. Cole-os na mensagem para o suporte.",
    "copyFailedHint": "Não foi possível copiar os dados de diagnóstico. Tente novamente.",
    "noSavedConfigurationHint": "Este dispositivo ainda não tem uma configuração salva. A Cindy precisa se reconectar para poder iniciar.",
    "offlineHint": "Você também pode iniciar sem conexão com a Internet usando a última configuração obtida pela Cindy ({{savedAt}}). Os recursos que precisam de rede ficarão indisponíveis.",
    "retryButton": "Tentar iniciar a Cindy novamente",
    "offlineButton": "Usar a última configuração",
    "quitButton": "Sair de Cindy"
  },
  'zh-Hant-x-lzh': {
    networkTitle: 'Cindy 暫不能連線',
    configTitle: 'Cindy 暫不能啟',
    networkBody:
      '啟動之際，未能連上 Cindy 服務。請察裝置已連網否，而後再啟之。若方用 Proxy 或公司網路，可換網再試。',
    configBody: 'Cindy 暫不能啟動竟。請稍後再試；若此患不止，請聯絡技術支援。',
    errorLine: '謬誤：{{error}}',
    diagnosticsHint: '若需援手，可錄診斷資訊，貼於求援之訊中。',
    copyDiagnosticsButton: '錄診斷資訊',
    copiedHint: '診斷資訊已錄。請貼於求援之訊中。',
    copyFailedHint: '診斷資訊未能錄之，請再試。',
    noSavedConfigurationHint: '此裝置無可用之舊設，須復連線，方能續啟。',
    offlineHint: '亦可用上回所得之設離線而啟（所得之時：{{savedAt}}），需網路之功能將不可用。',
    retryButton: '再啟 Cindy',
    offlineButton: '用上回之設',
    quitButton: '退 Cindy',
  },
  'zh-Hans-x-lzh': {
    networkTitle: 'Cindy 暂不能连接',
    configTitle: 'Cindy 暂不能启',
    networkBody:
      '启动之际，未能连上 Cindy 服务。请察设备已连网否，而后再启之。若方用 Proxy 或公司网络，可换网再试。',
    configBody: 'Cindy 暂不能启动竟。请稍后再试；若此患不止，请联系技术支持。',
    errorLine: '谬误：{{error}}',
    diagnosticsHint: '若需援手，可录诊断信息，贴于求援之讯中。',
    copyDiagnosticsButton: '录诊断信息',
    copiedHint: '诊断信息已录。请贴于求援之讯中。',
    copyFailedHint: '诊断信息未能录之，请再试。',
    noSavedConfigurationHint: '此设备无可用之旧设，须复连接，方能续启。',
    offlineHint: '亦可用上回所得之设离线而启（所得之时：{{savedAt}}），需网络之功能将不可用。',
    retryButton: '再启 Cindy',
    offlineButton: '用上回之设',
    quitButton: '退 Cindy',
  },
};

export interface EndpointManifestDialogInput {
  locale: EndpointManifestDialogLocale;
  kind: EndpointManifestFailureKind;
  /** 失败原因会以简短形态展示,并完整进入 diagnosticsText。 */
  reason: string;
  source?: string;
  diagnosis?: string | null;
  logPath?: string | null;
  /** 复制后在同一个弹框中显示成功或失败反馈。 */
  copyStatus?: EndpointManifestDialogCopyStatus;
  /** 上次成功配置的获取时间(已格式化);有值即提供离线启动按钮。 */
  offlineSavedAt?: string | null;
}

export interface EndpointManifestDialogContent {
  /** showMessageBoxSync 的 message(macOS 上是加粗标题行)。 */
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  /** 按钮下标 → 语义,避免调用方按 index 猜。 */
  choices: EndpointManifestDialogAction[];
  /** 复制按钮使用的技术文本;永远不放进 message/detail。 */
  diagnosticsText: string;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}

/** 去掉内部传输包装,直接向用户展示真正有用的错误码或校验原因。 */
export function formatEndpointManifestVisibleError(reason: string): string {
  return reason.startsWith('fetch-failed:') ? reason.slice('fetch-failed:'.length) : reason;
}

/** 供复制按钮使用的完整技术上下文;不参与普通用户可见文案。 */
export function buildEndpointManifestDiagnosticsText(
  input: Pick<EndpointManifestDialogInput, 'kind' | 'reason' | 'source' | 'diagnosis' | 'logPath'>,
): string {
  return [
    'Cindy startup diagnostics',
    `kind=${input.kind}`,
    `reason=${input.reason}`,
    `source=${input.source ?? 'n/a'}`,
    `diagnosis=${input.diagnosis ?? 'n/a'}`,
    `logPath=${input.logPath ?? 'n/a'}`,
  ].join('\n');
}

/**
 * 组装弹框内容。离线按钮只在 kind === 'network' 且确实有可用缓存时出现——配置内容
 * 非法时给离线出口等于让用户绕过一次真实的配置事故。
 */
export function buildEndpointManifestDialogContent(
  input: EndpointManifestDialogInput,
): EndpointManifestDialogContent {
  const copy = ENDPOINT_MANIFEST_DIALOG_COPY[input.locale];
  const offlineAvailable = input.kind === 'network' && Boolean(input.offlineSavedAt);

  const lines = [input.kind === 'network' ? copy.networkBody : copy.configBody];
  if (input.kind === 'network' && !offlineAvailable) {
    lines.push('', copy.noSavedConfigurationHint);
  }
  lines.push(
    '',
    fill(copy.errorLine, { error: formatEndpointManifestVisibleError(input.reason) }),
    copy.diagnosticsHint,
  );
  if (input.copyStatus === 'success') {
    lines.push('', copy.copiedHint);
  } else if (input.copyStatus === 'failed') {
    lines.push('', copy.copyFailedHint);
  }
  if (offlineAvailable) {
    lines.push('', fill(copy.offlineHint, { savedAt: input.offlineSavedAt ?? '' }));
  }

  const buttons = [copy.retryButton, copy.copyDiagnosticsButton];
  const choices: EndpointManifestDialogAction[] = ['retry', 'copy-diagnostics'];
  if (offlineAvailable) {
    buttons.push(copy.offlineButton);
    choices.push('offline');
  }
  buttons.push(copy.quitButton);
  choices.push('exit');

  return {
    message: input.kind === 'network' ? copy.networkTitle : copy.configTitle,
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    choices,
    diagnosticsText: buildEndpointManifestDiagnosticsText(input),
  };
}
