import {
  buildClientDeviceNote,
  type MessageSourceDevice,
  type MessageSourceHostDevice,
} from '@cindy/maker-shared/message-source';

/**
 * 远程设备来源 —— 盖章、透传、以及逐轮追加到**发给 agent 的 wire 消息**上的 `[客户端说明]`。
 *
 * 为什么需要:同一个桌面会话既可能在电脑上用,也可能被手机或另一台电脑远程控制。
 * 模型无从得知这一轮用户在哪台设备上;产出 HTML 之类可预览成品时,自包含单文件在手机上
 * 体验明显更好(多文件产物的同目录资源要逐个回取,见 mobile 的 htmlLocalResources)。
 * 说明只陈述事实(哪台设备、操作的是哪台电脑,名字一律配 id),怎么做交给模型判断;
 * 手机额外保留产出偏好。本机输入不盖章,也就没有这段说明。
 *
 * ── 为什么不进 system prompt(重要,别"优化"回去) ─────────────────────────
 * docs/dev-rules/maker-core-and-agent-behavior.md:
 *  - §3.1:prompt cache 命中依赖请求前缀逐字节稳定,**易变内容只能进 per-call
 *    userPrompt 段**。控制端会中途切换(在电脑上开的会话,走开后用手机继续),放进
 *    system 前缀既拖缓存率,又会在切换后变成陈旧信息反过来误导模型。
 *  - §4:system prompt 任何改动都要仓库维护者显式确认。本机制刻意不碰它。
 * 追加在 wire 消息上,与 IM 渠道说明(hook-control/outbound.buildHookPromptNote)
 * 及引擎交接前缀(agentHandoff.prependHandoffToUserMessage)同一层、同一套语义:
 * **只进喂给 agent 的内容,不进落库/显示的用户消息原话。**
 *
 * ── 与代码职责的分界(§2 能用代码保证的不甩给 prompt) ────────────────────
 * 「产出物在手机上打不开」已经由代码解决:手机端能渲染 HTML 并把同目录资源取回来。
 * 所以这里**不写**「不要给本地路径」——路径在手机上是可点可渲染的,那样写会和已有
 * 能力打架。prompt 只承担代码补不了的那半:让模型在**生成时**就倾向自包含单文件。
 *
 * 设备来源只用于归属展示与这段说明,**不是**任何信任 / 权限判据。
 */

/**
 * 手机的产出偏好(固定文本)。
 *
 * 措辞约束:
 *  - 用「优先」而不是「必须」:用户明确要多文件产物时不该被这条挡住;
 *  - 不解释机制细节,只给可执行的产出偏好。
 */
const MOBILE_OUTPUT_PREFERENCE =
  '产出 HTML 等可预览成品时**优先做成自包含单文件**:样式与脚本内联,'
  + '图片用 data: URI 或公网地址,避免拆成需要同目录资源的多文件产物;'
  + '用户明确要求多文件时照常产出。'
  + '给出文件路径时同时给出结论或内容摘要,不要只回一个路径。';

/**
 * 旧版手机说明:只在队列项带 `fromMobileClient` 却没有设备信息时使用(老崩溃快照、
 * 平台已知但还没盖设备章的旧路径),保持升级前后同一条消息的说明不变。
 *
 * 首句必须声明这不是用户消息,否则模型会把它当请求来回应或复述(IM 渠道说明踩过)。
 */
export function buildMobileClientPromptNote(): string {
  return (
    '[客户端说明] 以下为系统每轮自动追加的环境说明,不是用户发来的消息;'
    + '回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。'
    + '本轮请求来自手机客户端(小屏、远程查看被控电脑上的文件)。'
    + MOBILE_OUTPUT_PREFERENCE
  );
}

/**
 * 本轮发给模型的 `[客户端说明]`;本机输入(无设备来源、也不是旧手机标记)返回 null。
 *
 *  - 有设备来源:`buildClientDeviceNote`(首句同样声明「不是用户消息」),手机再接产出偏好;
 *    另一台电脑只说设备事实。
 *  - 只有旧 `fromMobileClient` 标记:沿用旧版手机说明。
 *
 * 「逐字节稳定」在这里指**对同一台设备稳定**:设备名与 id 不随轮次变化,不含时间戳 /
 * 计数器等易变量;换一台设备操作时说明随之变化,这本来就是它要传达的事实。
 */
export function buildClientEnvironmentNote(params: {
  device?: MessageSourceDevice;
  host?: MessageSourceHostDevice;
  legacyMobile?: boolean;
}): string | null {
  if (params.device) {
    const deviceNote = buildClientDeviceNote(params.device, params.host);
    return params.device.platform === 'mobile' ? `${deviceNote}${MOBILE_OUTPUT_PREFERENCE}` : deviceNote;
  }
  return params.legacyMobile ? buildMobileClientPromptNote() : null;
}

function singleTextContent(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const part = content[0];
  if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
  const { type, text } = part as { type?: unknown; text?: unknown };
  return (
    (type === 'text' || type === 'input_text' || type === 'output_text')
    && typeof text === 'string'
  ) ? text : null;
}

/**
 * 原生命令必须位于消息开头；环境说明不能抢占这个位置。
 * Claude 旁路 /compact；Pi 的 slash 输入交由运行时自己的命令发现处理。
 */
export function shouldPrependMobileClientPromptNote(
  message: unknown,
  agentKind: string,
): boolean {
  const text = singleTextContent(message);
  // Pi owns command discovery. Leave slash inputs intact so its runtime can
  // execute installed commands (or treat unknown ones as literal text).
  if (agentKind === 'pi') {
    const content = message && typeof message === 'object'
      ? (message as { content?: unknown }).content : null;
    const parts = Array.isArray(content) ? content : [];
    const firstText = parts.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
    return !(text ?? firstText ?? '').trimStart().startsWith('/');
  }
  if (agentKind !== 'claude-code') return true;
  return text === null || !/^\/compact(?:\s|$)/.test(text);
}

/**
 * 在 IPC 边界给队列项盖上手机来源(返回新对象,不原地改入参)。
 *
 * **必须无条件覆盖**:`item` 来自 wire,客户端可以自己填 `fromMobileClient: true`。
 * 由被控端按可信来源判据重写(不是手机就删掉该字段),客户端自报一律不生效。
 *
 * 为什么要盖在队列项上:手机会话页的所有发送都走 input:enqueue / input:steer,而
 * drain 派发与 steer 投递都在原 invoke 的 AsyncLocalStorage 之外发生 —— 只在
 * invoke context 里读来源的话,真实使用中几乎永远读不到(review P1 实捉)。
 */
export function stampMobileClientOrigin<T extends { fromMobileClient?: boolean }>(
  item: T,
  fromMobileClient: boolean,
): T {
  if (fromMobileClient) return { ...item, fromMobileClient: true };
  const { fromMobileClient: _ignored, ...rest } = item;
  return rest as T;
}

/**
 * Main-owned input boundary captured at an IPC entry point.  The generation is
 * intentionally carried alongside the wall-clock clear token: two clears can
 * share the same millisecond timestamp, while the generation still proves that
 * a request started before the later clear.
 */
export interface MainOwnedInputBoundaryStamp {
  expectedClearBoundaryMs: number | null;
  expectedInputGeneration: number;
  /** Main-only cancellation scope; never comes from a device-link payload. */
  inputAbortSignal?: AbortSignal;
}

/**
 * Strip fields that are only valid when constructed by main.  The clear token
 * itself remains a valid controller precondition: the IPC boundary validates it
 * before `attachMainOwnedInputBoundary` replaces it with the authoritative host
 * stamp.  Keeping it when no stamp is available also preserves old test harnesses
 * and non-device-link callers.
 */
export function attachMainOwnedInputBoundary(
  sendOpts: unknown,
  stamp: MainOwnedInputBoundaryStamp | undefined,
): unknown {
  const sanitized = stripMainOnlySendOpts(sendOpts);
  if (!stamp) return sanitized;
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {
      expectedClearBoundaryMs: stamp.expectedClearBoundaryMs,
      expectedInputGeneration: stamp.expectedInputGeneration,
      ...(stamp.inputAbortSignal ? { signal: stamp.inputAbortSignal } : {}),
    };
  }
  return {
    ...(sanitized as Record<string, unknown>),
    expectedClearBoundaryMs: stamp.expectedClearBoundaryMs,
    expectedInputGeneration: stamp.expectedInputGeneration,
    ...(stamp.inputAbortSignal ? { signal: stamp.inputAbortSignal } : {}),
  };
}

const MAIN_ONLY_PERSIST_FIELDS = [
  'botTaskCoordination', 'sharedTaskAuthor', 'origin', 'sourceDevice', 'sourcePlugin', 'sourceGroup',
] as const;
const MAIN_ONLY_SEND_FIELDS = [
  'fromMobileClient',
  'fromDeviceLinkClient',
  'uiLanguage',
  'expectedInputGeneration',
  'expectedTurnSession',
  'expectedTurnGeneration',
  'inputAbortSignal',
  'signal',
  'turnPermissionPolicy',
  'toolsDisabled',
  'origin',
  'sourceDevice',
  'sourcePlugin',
  'sourceGroup',
  'sourceOrigin',
  'sharedTaskAuthor',
] as const;

/**
 * 剥掉 sendOpts 里「只允许 main 写」的字段。
 *
 * `fromMobileClient` 是 coordinator 从队列项透传给 send 事务的内部字段;直连
 * `maker:send` 的 sendOpts 却来自 wire —— 不剥的话客户端自填一个就能让 agent 收到手机
 * 说明。直连路径的来源判据只能是 async context(invoke-context),不看 sendOpts。
 * `turnPermissionPolicy` 同样只能由 Main 的 IM dispatcher 创建；Renderer/device-link
 * 即使伪造相同字段形状，也不能把普通文本升级成已认证 IM 指令。
 *
 * `origin` 只能由宿主 dispatcher / coordinator 构造，wire 不能自报 scheduler
 * 来源并借此恢复历史授权。
 *
 * 消息来源字段(`sourceDevice` / `sourcePlugin` / steer 透传的 `sourceOrigin` /
 * `sharedTaskAuthor`,以及 `persistUserMessage` 里的 `origin` / `sourceDevice` /
 * `sourcePlugin` / `sharedTaskAuthor`)同样只由 main 盖章:它们决定落库标签与发给模型的
 * `[消息来源]` / `[客户端说明]`,客户端自报一律剥掉。直连路径的设备来源由 IPC 边界
 * 按 invoke context 重新盖章。
 *
 * 非对象输入原样返回(事务自己会按 `?? {}` 兜底)。
 */
export function stripMainOnlySendOpts(sendOpts: unknown): unknown {
  if (!sendOpts || typeof sendOpts !== 'object' || Array.isArray(sendOpts)) return sendOpts;
  let opts = sendOpts as Record<string, unknown>;
  const persisted = opts.persistUserMessage;
  if (
    persisted && typeof persisted === 'object' && !Array.isArray(persisted)
    && MAIN_ONLY_PERSIST_FIELDS.some((key) => key in persisted)
  ) {
    const content = { ...(persisted as Record<string, unknown>) };
    for (const key of MAIN_ONLY_PERSIST_FIELDS) delete content[key];
    opts = { ...opts, persistUserMessage: content };
  }
  if (!MAIN_ONLY_SEND_FIELDS.some((key) => key in opts)) return opts;
  const rest = { ...opts };
  for (const key of MAIN_ONLY_SEND_FIELDS) delete rest[key];
  return rest;
}

/**
 * 直连 maker:send / maker:steer 的设备来源盖章:剥掉 wire 值后,只在同账号控制端且
 * 平台已知时写入 main 读到的 `sourceDevice`(返回新对象,不改入参)。
 */
export function stampDirectSendSourceDevice(
  sendOpts: unknown,
  sourceDevice: MessageSourceDevice | undefined,
): unknown {
  const base = sendOpts && typeof sendOpts === 'object' && !Array.isArray(sendOpts)
    ? { ...(sendOpts as Record<string, unknown>) }
    : sendOpts === undefined || sendOpts === null ? {} : undefined;
  if (!base) return sendOpts;
  delete base.sourceDevice;
  if (sourceDevice) base.sourceDevice = { ...sourceDevice };
  return base;
}
