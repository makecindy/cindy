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
 * detail 排版都不碰 Electron,由 clientEndpointsService 负责真正弹框。
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

export interface EndpointManifestDialogCopy {
  title: string;
  networkBody: string;
  configBody: string;
  /** 以下四条均带 {{}} 占位,由 buildEndpointManifestDialogContent 填充。 */
  sourceLine: string;
  reasonLine: string;
  diagnosisLine: string;
  logLine: string;
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
    title: '无法获取服务器配置',
    networkBody:
      'Cindy 启动前需要先获取服务器配置，这次请求没有成功。请检查网络连接后重新获取。',
    configBody:
      '服务器没有返回可用的配置，重新获取不会改变结果。请稍后再试或联系我们。',
    sourceLine: '配置来源：{{source}}',
    reasonLine: '失败原因：{{reason}}',
    diagnosisLine: '网络诊断：{{diagnosis}}',
    logLine: '诊断日志位置：{{path}}',
    offlineHint:
      '也可以用上次成功获取的配置离线启动（获取于 {{savedAt}}），需要联网的功能会不可用。',
    retryButton: '重新获取配置',
    offlineButton: '用上次配置启动',
    quitButton: '退出 Cindy',
  },
  en: {
    title: 'Cannot load server configuration',
    networkBody:
      'Cindy needs the server configuration before it can start, and this request did not go through. Check your network connection and fetch it again.',
    configBody:
      'The server did not return a usable configuration, so fetching it again will not change the result. Try later or contact us.',
    sourceLine: 'Configuration source: {{source}}',
    reasonLine: 'Failure reason: {{reason}}',
    diagnosisLine: 'Network diagnosis: {{diagnosis}}',
    logLine: 'Diagnostic log location: {{path}}',
    offlineHint:
      'You can also start offline with the configuration Cindy last fetched ({{savedAt}}). Features that need a network connection will be unavailable.',
    retryButton: 'Fetch Configuration',
    offlineButton: 'Use Last Configuration',
    quitButton: 'Quit Cindy',
  },
  ja: {
    title: 'サーバー設定を取得できません',
    networkBody:
      'Cindy の起動にはサーバー設定の取得が必要ですが、今回のリクエストは失敗しました。ネットワーク接続を確認してから再取得してください。',
    configBody:
      'サーバーから使用可能な設定を取得できませんでした。再取得しても結果は変わりません。時間をおいて試すか、お問い合わせください。',
    sourceLine: '設定の取得先: {{source}}',
    reasonLine: '失敗の原因: {{reason}}',
    diagnosisLine: 'ネットワーク診断: {{diagnosis}}',
    logLine: '診断ログの場所: {{path}}',
    offlineHint:
      '前回取得できた設定でオフライン起動することもできます（取得日時: {{savedAt}}）。ネットワークが必要な機能は利用できません。',
    retryButton: '設定を再取得',
    offlineButton: '前回の設定で起動',
    quitButton: 'Cindy を終了',
  },
  ko: {
    title: '서버 설정을 가져올 수 없습니다',
    networkBody:
      'Cindy를 시작하려면 먼저 서버 설정을 가져와야 하지만 이번 요청이 실패했습니다. 네트워크 연결을 확인한 후 다시 가져오세요.',
    configBody:
      '서버에서 사용할 수 있는 설정을 가져오지 못했습니다. 다시 가져와도 결과는 바뀌지 않습니다. 잠시 후 다시 시도하거나 문의해 주세요.',
    sourceLine: '설정 출처: {{source}}',
    reasonLine: '실패 원인: {{reason}}',
    diagnosisLine: '네트워크 진단: {{diagnosis}}',
    logLine: '진단 로그 위치: {{path}}',
    offlineHint:
      '마지막으로 가져온 설정으로 오프라인 시작할 수도 있습니다({{savedAt}} 기준). 네트워크가 필요한 기능은 사용할 수 없습니다.',
    retryButton: '설정 다시 가져오기',
    offlineButton: '지난 설정으로 시작',
    quitButton: 'Cindy 종료',
  },
};

export interface EndpointManifestDialogInput {
  locale: EndpointManifestDialogLocale;
  kind: EndpointManifestFailureKind;
  /** 错误码级别的短标识(fetch-failed:ERR_FAILED / invalid-json 等)。 */
  reason: string;
  /**
   * 清单来源:CDN 路径是 URL,dev 的 file 模式是本地文件路径。四语文案因此用中性的
   * 「来源 / source / 取得先 / 출처」,不写「URL / 地址」——否则 file 模式下名不副实。
   */
  source: string;
  /** 网络分阶段诊断摘要;没跑或跑失败时省略。 */
  diagnosis?: string | null;
  /**
   * 诊断产物位置:netlog 抓成功时是那个文件,失败时回落成日志目录——所以文案用
   * 「诊断日志位置」而不是「诊断日志」,不承诺一定是单个文件。
   */
  logPath?: string | null;
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
  choices: EndpointManifestDialogChoice[];
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
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

  const lines = [
    input.kind === 'network' ? copy.networkBody : copy.configBody,
    '',
    fill(copy.reasonLine, { reason: input.reason }),
    fill(copy.sourceLine, { source: input.source }),
  ];
  if (input.diagnosis) {
    lines.push(fill(copy.diagnosisLine, { diagnosis: input.diagnosis }));
  }
  if (input.logPath) {
    lines.push(fill(copy.logLine, { path: input.logPath }));
  }
  if (offlineAvailable) {
    lines.push('', fill(copy.offlineHint, { savedAt: input.offlineSavedAt ?? '' }));
  }

  const buttons = [copy.retryButton];
  const choices: EndpointManifestDialogChoice[] = ['retry'];
  if (offlineAvailable) {
    buttons.push(copy.offlineButton);
    choices.push('offline');
  }
  buttons.push(copy.quitButton);
  choices.push('exit');

  return {
    message: copy.title,
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    choices,
  };
}
