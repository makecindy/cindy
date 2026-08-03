/**
 * 手机客户端来源 —— 盖章、透传、以及逐轮追加到**发给 agent 的 wire 消息**上的说明。
 *
 * 为什么需要:同一个桌面会话既可能在电脑上用,也可能被手机远程控制。产出 HTML 之类
 * 可预览成品时,自包含单文件在手机上体验明显更好(多文件产物的同目录资源要逐个回取,
 * 见 mobile 的 htmlLocalResources),而模型无从得知这一轮是谁在问。
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
 */

/**
 * 固定文本(不含时间戳 / 计数器等易变量,同一版本逐字节稳定)。
 *
 * 措辞约束:
 *  - 首句必须声明这不是用户消息,否则模型会把它当请求来回应或复述(IM 渠道说明踩过);
 *  - 用「优先」而不是「必须」:用户明确要多文件产物时不该被这条挡住;
 *  - 不解释机制细节,只给可执行的产出偏好。
 */
export function buildMobileClientPromptNote(): string {
  return (
    '[客户端说明] 以下为系统每轮自动追加的环境说明,不是用户发来的消息;'
    + '回复时不要把它当作用户的请求,也不要引用、复述或据此臆测用户意图。'
    + '本轮请求来自手机客户端(小屏、远程查看被控电脑上的文件)。'
    + '产出 HTML 等可预览成品时**优先做成自包含单文件**:样式与脚本内联,'
    + '图片用 data: URI 或公网地址,避免拆成需要同目录资源的多文件产物;'
    + '用户明确要求多文件时照常产出。'
    + '给出文件路径时同时给出结论或内容摘要,不要只回一个路径。'
  );
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
 * 剥掉 sendOpts 里「只允许 main 写」的字段。
 *
 * `fromMobileClient` 是 coordinator 从队列项透传给 send 事务的内部字段;直连
 * `maker:send` 的 sendOpts 却来自 wire —— 不剥的话客户端自填一个就能让 agent 收到手机
 * 说明。直连路径的来源判据只能是 async context(invoke-context),不看 sendOpts。
 *
 * 非对象输入原样返回(事务自己会按 `?? {}` 兜底)。
 */
export function stripMainOnlySendOpts(sendOpts: unknown): unknown {
  if (!sendOpts || typeof sendOpts !== 'object' || Array.isArray(sendOpts)) return sendOpts;
  if (!('fromMobileClient' in sendOpts)) return sendOpts;
  const { fromMobileClient: _ignored, ...rest } = sendOpts as Record<string, unknown>;
  return rest;
}
