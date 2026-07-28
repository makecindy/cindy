/**
 * clientEndpoints — 客户端远程端点清单的共享 schema / 校验 / 严格解析。
 *
 * 背景:desktop / mobile 的生产端点在构建期内联进包体,发版后无法变更。CDN 上
 * 存放一份公开读的清单(仓内正本 `config/endpoint.json` = cn、
 * `config/endpoint.global.json` = global,人肉上传各自 region 的 CDN),
 * 应用启动第一步、**先于检查更新**从 CDN 拉取;CDN 清单修改后重启应用生效。
 * 完整拉取地址 = `<烘焙的 region 化 hotfix base>/endpoint.json`。
 *
 * 语义是**清单即唯一事实源**:
 *  - 拉不到 / JSON 或 schema 无法解析 / 非空 endpoint 值非法 → 启动阻断,
 *    宿主报错并提供重试;
 *  - endpoint 字段允许按 region 缺失或留空,解析结果统一补成空串,不因此阻断启动;
 *  - **没有缓存回退、没有超时后静默继续、没有逐字段烘焙回退**——任何本地兜底
 *    都会把非空 CDN 配置错误静默掩盖成"部分端点漂移",这里要的是非法值立刻暴露;
 *    desktop 与 mobile 正式包均遵守本条严格语义。
 *  - 客户端唯一烘焙的远程 URL 是拉清单用的 CDN 基址(自举必需,且防"清单配错
 *    CDN 把自己锁死");**更新/hotfix 链的 CDN base 也来自清单**(cdnBaseUrl)
 *    ——清单阻断在一切更新检查之前,更新链拿到的一定是已解析的清单值,
 *    无鸡生蛋问题;
 *  - dev(desktop 未打包 / mobile __DEV__)默认不走 CDN,改读仓内正本文件
 *    (同一套解析,allowHttp 宽松协议见下);`--endpoints-cdn` /
 *    EXPO_PUBLIC_ENDPOINTS_CDN=1 可让 dev 走完整 CDN 链路。
 *
 * 职责边界(仓规则 2):本模块是纯逻辑层,不做任何 IO——fetch / 读文件 / 报错
 * 交互由宿主(desktop main / mobile 启动闸门)实现,这里只提供确定性的解析与
 * 校验(仓规则 9)。
 *
 * 校验语义:
 *  - CLIENT_ENDPOINT_KEYS 中的字段缺失或空白时统一解析为 `''`;不同 region 可以
 *    不提供不适用的业务端点,不会因此阻断整个客户端启动;
 *  - 未知字段忽略(向前兼容:新客户端加字段后,老清单先补字段再发新客户端;
 *    新清单多出的字段老客户端不认识但不报错);
 *  - 协议白名单、禁 URL 凭据、
 *    尾斜杠归一;
 *  - `allowHttp` 宽松模式(仅 dev 本地文件路径允许开启):https-only 字段追加
 *    接受 http:、wss 字段追加 ws:,让 endpoint.local.json 能填 localhost;
 *    packaged / CDN 路径一律不开,打包校验零放松;
 *  - schemaVersion 缺失、非正整数或大于当前支持版本 → 整份拒绝(breaking change
 *    才 bump 版本)。2026-07 追加 cdnBaseUrl 时**没有** bump:新字段随全新的
 *    hotfix CDN 域名 + `/endpoint.json` 路径发布,老客户端读的是老 CDN 老路径
 *    (`/config/client-endpoints.json`)看不到新清单;即使把新正本内容双写到
 *    老路径,多出的字段也会被老 parser 按"未知字段"忽略——bump 的语义是
 *    "同一文件的不兼容重释义",纯增字段 + 换发布地址不构成。
 *  - 2026-07 稍后退役 cdnInternalBaseUrl(内网加速镜像下线,更新链只走
 *    cdnBaseUrl)同样没有 bump:删必填字段对**新客户端**是纯放松(清单里多出
 *    的该字段按未知字段忽略);退役时新路径清单尚无已发布的 packaged 消费者,
 *    线上清单已同步删除,无兼容包袱。
 *  - 2026-07-17 追加可选字符串字段 review(手机版审核模式的送审版本号,见
 *    CLIENT_ENDPOINT_REVIEW_KEY)同样没有 bump:可选字段、缺失/空串即关闭,
 *    老清单不受影响;老客户端按未知字段忽略。
 *  - 2026-07-17 退役 xdGatewayBaseUrl(同样不 bump,理由同上):XD 网关推理
 *    入口一律由 model-access server 随凭据成对下发(desktop
 *    model-access/effectiveEndpoint.ts),清单不再承载网关端点,杜绝
 *    「key 与 endpoint 不同租户」的撕裂组合;mobile 语音的网关地址经桌面端
 *    device-link 凭据同步获得,不再吃清单默认值。
 */

/** 当前客户端支持的清单 schema 版本;清单里更大的版本号会被整份拒绝。 */
export const CLIENT_ENDPOINTS_SCHEMA_VERSION = 1;

/**
 * 清单字段全集 = 客户端可能消费的端点集合。不同 region 可缺省或留空不适用的
 * 字段;解析结果仍补齐所有 key,让既有消费方保持稳定的 string 读取接口。
 */
export const CLIENT_ENDPOINT_KEYS = [
  // apiBaseUrl(老主 server xdt-api)已于 2026-07-18 退役(不 bump,删必填字段
  // 对新客户端是纯放松):四块业务消费方分批迁至独立服务(chat-data 删除 /
  // SlackIM→slack-hook / GitHub 反馈→githubApiBaseUrl / Skillhub→
  // skillhubApiBaseUrl)。退役时清单体系尚无已发布的 packaged/mobile 消费者,
  // 正本(=CDN 上传源)已同步删值,无兼容包袱(同 cdnInternalBaseUrl 先例)。
  // auth 不分 cn/global:国内/海外是两条 CDN 各发各的清单,清单本身已 region 化,
  // 客户端无脑取本字段即可。
  'authApiBaseUrl',
  // desktop 系统浏览器登录的**服务端托管回调**地址(auth-server 路由,精确值需与
  // 服务端 redirect_uri allowlist 逐字符一致)。非空 = 走托管回调链路:回调页停在
  // 自有域名、授权码由客户端轮询取回,浏览器地址栏不再出现 127.0.0.1 与 code;
  // 空 = 回落到 RFC 8252 loopback(现状行为)。这也是本能力的灰度/回滚开关——
  // 服务端出问题时清空本字段即可回退,客户端不必发版。
  // 不 bump schemaVersion:纯增可选字段,老清单缺失即 '',老客户端按未知字段忽略
  // (同 review / cdnBaseUrl 先例,理由见上方版本注释)。
  'authDesktopCallbackUrl',
  'deviceLinkApiBaseUrl',
  'oauthBrokerApiBaseUrl',
  // oss-server(公开资产直传预签名,当前场景:头像上传)。
  'ossApiBaseUrl',
  'heartbeatUrl',
  // Telegram hook is deployed independently from Slack; empty means the
  // current environment has not rolled out Telegram yet.
  'telegramHookWsUrl',
  'slackHookWsUrl',
  'websiteUrl',
  // model-access-server(登录后自动下发 LLM 网关凭据)的 API 基址。
  'modelAccessApiBaseUrl',
  // voice-server（一期开通免费语音输入的数据面）API 基址。
  'voiceApiBaseUrl',
  // github-server(用户反馈 → 官方仓 GitHub issue 的薄代理)的 API 基址。
  'githubApiBaseUrl',
  // skillhub-server(SkillHub 技能市场/发布 → XD hub 的 S2S 代理)的 API 基址。
  'skillhubApiBaseUrl',
  // plugin-server(Plugin/Skill 市场、组织管理与发布)的 API 基址。
  'pluginApiBaseUrl',
  // 更新/hotfix 链的 CDN base(manifest-*.json / hotfix 包 / agent 二进制)。
  'cdnBaseUrl',
  // 自建线手机整包发现的 mobile-update-server 基址(`${base}/latest`)。仅
  // mobile 自建变体(IS_OTA_SELFHOST)消费,desktop 与 EAS 线不读;清单值
  // 优先于烧包的 EXPO_PUBLIC_XDT_OTA_URL,让已发自建包可远程迁域名。
  // 注意热更通道的 updates.url 仍烧在原生层(expo-updates 架构),不吃本字段。
  'mobileUpdateBaseUrl',
] as const;

export type ClientEndpointKey = (typeof CLIENT_ENDPOINT_KEYS)[number];

/** 解析成功后的端点全集(全 key 存在;清单缺失/空白的字段值为 `''`)。 */
export type ClientEndpointMap = Record<ClientEndpointKey, string>;

/**
 * 可选字符串字段:`review` = 手机版审核模式的**送审版本号**(App 审核期间填
 * 送审构建的二进制版本号,如 "1.4.0")。mobile 启动时用它与自身二进制版本号
 * **严格相等匹配**,且 iOS StoreKit 未识别为 TestFlight 时才进入审核模式:
 * TestFlight 即使版本命中也继续更新;其余命中构建关闭全部 JS 显式更新检查路径(启动
 * JS 热更门 / 整包检查 / resume 静默检查)直接进主界面,设置页隐藏「检查更新 /
 * 检查整包更新」;desktop 不消费。按版本定向的意义:清单是 region 级共享文件,
 * 版本匹配把影响面从"全量用户"收窄到"同版本号的构建"——存量其它版本用户的
 * 更新检查与强更通道不受影响。注意命中粒度是**版本号而非送审构建本身**:
 * app.json 的 version 为 iOS/Android 各变体共用,若送审版本号与其它平台/变体
 * 正在线上跑的版本号相同,这些同版本用户也会进入审核模式(iOS TestFlight 除外);
 * 填写前需确认送审版本号未与其它线上线重叠,或接受重叠期影响。
 * **可选、缺失或空串即关闭**——线上已发布的清单没有该字段,若设为必填会让新
 * 客户端对老清单启动阻断;可选纯增量也是不 bump schemaVersion 的前提(见上方
 * 版本注释)。存在但非 string 视为配置错,整份拒绝(配置错要炸出来,不静默猜测)。
 * 覆盖边界与运维义务(填写前必须知晓):
 *  - **管不到 expo-updates 原生层**:CheckOnLaunch 是 build-time 原生配置
 *    (当前烘焙 ALWAYS),冷启动仍会后台静默 check+下载、下次启动生效——
 *    该缺口无法用运行时清单字段封,审核窗口内需同时冻结热更发布;
 *  - 送审版本过审对外发布后必须及时把该字段清回 ""(或删除),否则线上同
 *    版本的非 TestFlight 用户会一直处于审核模式、收不到后续 JS 更新检查与强更提示。
 */
export const CLIENT_ENDPOINT_REVIEW_KEY = 'review';

/** 各字段允许的 URL 协议白名单。 */
const FIELD_PROTOCOLS: Record<ClientEndpointKey, readonly string[]> = {
  authApiBaseUrl: ['https:'],
  authDesktopCallbackUrl: ['https:'],
  deviceLinkApiBaseUrl: ['https:'],
  oauthBrokerApiBaseUrl: ['https:'],
  ossApiBaseUrl: ['https:'],
  heartbeatUrl: ['https:'],
  telegramHookWsUrl: ['wss:'],
  slackHookWsUrl: ['wss:'],
  websiteUrl: ['https:'],
  modelAccessApiBaseUrl: ['https:'],
  voiceApiBaseUrl: ['https:'],
  githubApiBaseUrl: ['https:'],
  skillhubApiBaseUrl: ['https:'],
  pluginApiBaseUrl: ['https:'],
  cdnBaseUrl: ['https:'],
  mobileUpdateBaseUrl: ['https:'],
};

/** 解析选项;allowHttp 仅供 dev 本地文件路径(endpoint.local.json 等)开启。 */
export interface ParseClientEndpointManifestOptions {
  /** true 时 https-only 字段追加接受 http:、wss 字段追加 ws:(localhost 场景)。 */
  allowHttp?: boolean;
}

// 去尾部斜杠。不用 /\/+$/ 正则——超长 '/' 串上会 O(n²) 回溯(CodeQL js/polynomial-redos)。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

function allowedProtocols(key: ClientEndpointKey, allowHttp: boolean): readonly string[] {
  const base = FIELD_PROTOCOLS[key];
  if (!allowHttp) return base;
  const relaxed = [...base];
  if (base.includes('https:') && !base.includes('http:')) relaxed.push('http:');
  if (base.includes('wss:') && !base.includes('ws:')) relaxed.push('ws:');
  return relaxed;
}

export type ParseClientEndpointManifestResult =
  | { ok: true; endpoints: ClientEndpointMap; reviewVersion: string | null }
  | { ok: false; reason: string };

/**
 * 解析并校验一份清单原文。纯函数,输入任意文本都不会抛出。
 * 端点缺失 / 空白时写入 `''` 并继续;非空值仍校验 URL、协议与凭据;
 * `review` 可选字符串(送审版本号),缺失 / 空白 = null 即审核模式关闭
 * (语义见 CLIENT_ENDPOINT_REVIEW_KEY)。
 */
export function parseClientEndpointManifest(
  rawText: string,
  options?: ParseClientEndpointManifestOptions,
): ParseClientEndpointManifestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const record = parsed as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    return { ok: false, reason: 'invalid-schema-version' };
  }
  if (schemaVersion > CLIENT_ENDPOINTS_SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported-schema-version:${schemaVersion}` };
  }

  const endpoints = {} as ClientEndpointMap;
  for (const key of CLIENT_ENDPOINT_KEYS) {
    const raw = record[key];
    if (raw === undefined || (typeof raw === 'string' && !raw.trim())) {
      endpoints[key] = '';
      continue;
    }
    if (typeof raw !== 'string') {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    const normalized = trimTrailingSlashes(raw.trim());
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      return { ok: false, reason: `invalid-field:${key}` };
    }
    if (!allowedProtocols(key, options?.allowHttp === true).includes(url.protocol)) {
      return { ok: false, reason: `invalid-protocol:${key}` };
    }
    if (url.username || url.password) {
      return { ok: false, reason: `credentials-in-url:${key}` };
    }
    endpoints[key] = normalized;
  }

  const rawReview = record[CLIENT_ENDPOINT_REVIEW_KEY];
  if (rawReview !== undefined && typeof rawReview !== 'string') {
    return { ok: false, reason: `invalid-field:${CLIENT_ENDPOINT_REVIEW_KEY}` };
  }
  const reviewVersion =
    typeof rawReview === 'string' && rawReview.trim() ? rawReview.trim() : null;

  return { ok: true, endpoints, reviewVersion };
}

export type ResolveClientEndpointsResult =
  | { ok: true; endpoints: ClientEndpointMap; reviewVersion: string | null }
  | { ok: false; reason: string };

/**
 * 解析清单原文 → 完整端点 map(缺失/空白字段补 `''`,无任何本地合并)。
 * rawText 为 null(拉取失败/超时)→ ok:false('fetch-failed'),宿主必须阻断并重试。
 */
export function resolveClientEndpointsStrict(
  rawText: string | null,
  options?: ParseClientEndpointManifestOptions,
): ResolveClientEndpointsResult {
  if (rawText === null) {
    return { ok: false, reason: 'fetch-failed' };
  }
  return parseClientEndpointManifest(rawText, options);
}
