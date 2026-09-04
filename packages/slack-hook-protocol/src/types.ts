/**
 * slack-hook-protocol/types.ts
 * ---------------------------------------------------------------------------
 * hook server <-> desktop 双工任务协议 v1 的全部类型定义。
 *
 * 协议模型(四幕):
 *   1. 连接自报家门: hello(desktop -> server, 声明工作区别名) / welcome / ping / pong
 *   2. 派活:        task.dispatch(server -> desktop) -> task.ack(立即三态应答)
 *   3. 干活:        无消息 —— 铁律「同 externalKey 同 session」由 desktop 侧保证
 *   4. 交差:        turn.end(desktop -> server, 结果回传)
 *
 * 关键约定:
 *   - externalKey 对协议是不透明字符串, 由 hook server 的 provider 生成
 *     (格式约定 `<providerId>:...`), desktop 只拿它查 session 映射并原样回传。
 *   - workspace 是别名(alias), 本地绝对路径只存在于 desktop, 永不过网线。
 *   - sessionId 仅「接管已有桌面会话」时由 server 显式指定; 普通流程不填,
 *     ack / turn.end 中回传仅作记录与调试, 不参与路由。
 *   - 可靠性: requestId 幂等(重投不重跑, 只回放上次 ack); 断线重连后
 *     server 重投未 ack 任务, desktop 补发未送达的 turn.end。
 *
 * v2 增量(版本号不变 —— type 为开放集合, 老端收到未知类型丢帧不断连):
 *   5. 绑定:   bind.start(desktop 发起) / bind.update(server 推状态) / bind.revoke
 *      —— 中心部署下「Slack 用户 ↔ 设备」的建立与解除。阶段 4 起改走
 *      Sign in with Slack(OIDC): desktop 发空 bind.start, server 签发授权
 *      链接经 bind.update(state=pending, authorizeUrl)回推, 用户在系统浏览器
 *      完成 Slack 授权后 server 回调建链, 再推 confirmed。协议只承载 desktop
 *      侧的发起与状态同步, 身份确认在 server 与 Slack 之间完成。
 *   6. 问答:   query.request(server -> desktop) / query.response —— /bind /model
 *      /effort 等指令触发时实时拉取工作区 / 模型清单, 不用连接期快照。
 *   7. 取消:   task.cancel(server -> desktop) —— /stop 中断在跑任务,
 *      desktop 以 turn.end(status=cancelled) 收口。
 *   8. 归档:   session.archive(server -> desktop) —— 私聊 /new 换代后通知
 *      desktop 归档旧代会话(按 externalKey 查绑定), 列表不再显示; 无绑定 /
 *      会话不存在时静默忽略(幂等)。
 *
 *   9. 进度:   turn.progress(desktop -> server) —— turn 执行中的渲染快照。
 *      历史: 初版只发裸累积文本, 体验不佳一度下线; 现已复活, desktop 侧
 *      合成「过程区时间线 + 部分正文」的完整快照(节流), server 侧以
 *      占位消息 + chat.update 原地刷新呈现。旧版 desktop 仍发裸文本快照,
 *      新 server 同样渲染(向后兼容); 旧 server 收到新帧静默丢弃(无害)。
 *
 *   10. 交互:  interaction.request(desktop -> server) / interaction.decision
 *      (server -> desktop) / interaction.cancel(desktop -> server) ——
 *      turn 执行中 agent 发起的用户交互(模型主动提问 AskUserQuestion /
 *      计划审阅 plan_review)以按钮卡片形式转发到 Slack thread。设计原则:
 *      **决策语义全部留在 desktop**(它持有 maker-core 的原始
 *      InteractionRequest 与按钮->决策映射), server 是"哑渲染器"——
 *      收到 request 渲染卡片, 按钮按压只回传 buttonId; desktop 侧对每个
 *      交互设超时, 超时/收口时按安全默认自决并发 cancel 让 server 改写
 *      卡片。旧 server 收到 request 丢帧不断连 -> desktop 超时默认继续,
 *      任务不会卡死(向后兼容)。权限审批(permission)已纳入本通道: server
 *      可经 dispatch options.permissionMode 为新建会话指定权限档(见
 *      TaskDispatchOptions), 非 bypass 档下 agent 的权限请求同样以按钮卡
 *      转发(允许一次 / 本会话总是允许 / 拒绝), 超时安全默认为拒绝。
 *
 *   11. 偏好:  prefs.get / prefs.set(desktop -> server) / prefs.state
 *      (server -> desktop) —— server 侧 user_prefs(按 (Slack 用户, 工作目录)
 *      的 agent/model/effort/permission 偏好, /model 卡的数据正本)的远程
 *      读写通道: desktop 设置页是同一份数据的编辑器。prefs.state 是全量
 *      快照, 既作为 get/set 的应答(replyTo 回显请求 id), 也在 /model 卡
 *      写入后主动推送(replyTo null; 设备离线静默丢, desktop 重连自拉)。
 *      旧 server 收到 prefs.get 丢帧不断连 -> desktop 侧超时降级为
 *      "服务器版本过旧"提示; 旧 desktop 收到主动 prefs.state 同样丢帧无害。
 *
 *   12. 工具:  tool.request(desktop -> server) / tool.response(server ->
 *      desktop) —— desktop 会话内 agent 调用 server 侧 Slack 网关工具
 *      (server 以绑定用户托管的 user token 调 Slack 官方 MCP / Web API)。
 *      方向与 query.* 相反: desktop 是请求方(pending map + 超时在 desktop
 *      侧), server 收到即执行并以 tool.response(replyTo 回显 requestId)
 *      应答。tool 名是开放集合(server 不认识回 UNKNOWN_TOOL), 错误一律
 *      结构化 {code, message} —— desktop 按 code 分支, 不解析文案(规则 9)。
 *      能力协商: 支持本帧族的 server 在 welcome.features 里带
 *      HOOK_FEATURE_SLACK_TOOLS; 旧 server 收到 tool.request 丢帧不断连,
 *      desktop 侧靠 feature 缺席短路 + 超时兜底(SERVER_TOO_OLD)。
 *
 *   13. 多 workspace 绑定(multi-team): 一台设备可同时持有多个
 *      (teamId, slackUserId) 绑定 —— 每个 Slack workspace(team)一条, 同
 *      team 内仍一设备一身份。能力协商双向: desktop 在 hello.features 带
 *      HOOK_FEATURE_MULTI_TEAM 声明自己会消费多绑定帧, server 在
 *      welcome.features 带同名标识声明支持; 任一侧缺席则整体回落单绑定
 *      行为(server 对旧 desktop 保持"跨 team 顶替"旧语义, 新 desktop 对
 *      旧 server 收起添加入口)。增量帧面:
 *        - bind.state(server -> desktop): 绑定全量快照(权威列表), 连接
 *          建立与任何绑定变化(新增/解除/被顶)后推送; 旧 desktop 不认识
 *          本类型, parse 拒收丢帧不断连。
 *        - bind.update 加可选 teamId: 事件帧按 team 定位(confirmed /
 *          revoked); 授权流早期(pending)团队未知, teamId 为 null。
 *        - bind.start 加可选 teamId: 给指定 team 重新授权时 pin 授权页;
 *          缺省 = 用户在 Slack 授权页自选(可绑任意新 team)。
 *        - bind.revoke 从空对象放宽为 { teamId?: string|null }: 带 team
 *          = 只解绑该 team; 空/缺省 = 解绑本设备全部(兼容老 desktop)。
 *          旧 server 对带 teamId 的帧 parse 拒收, 故 desktop 仅在 server
 *          声明 multi-team 后才发带 team 的形态。
 *        - prefs.set / prefs.state 条目 / tool.request 加可选 teamId:
 *          多绑定下偏好与网关工具的 team 归属消歧; 缺省语义 = 设备唯一
 *          绑定(多绑定时 server 拒绝猜测, 结构化报错)。
 *        - TaskSource 加 teamId / teamName: desktop 侧会话记住来源
 *          workspace(标题展示 + 工具调用默认 team)。
 *
 *   15. 生命周期通知偏好: hello.lifecycleAnnouncement 在每次建连时同步
 *      当前有效值,lifecycle.preference 在设置页切换时即时更新。server
 *      只有声明 HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT 后 desktop 才发送
 *      即时更新帧;旧 server 忽略 hello 新字段,保持既有通知行为。
 *
 *   19. Telegram 行为配置: provider.behavior.get / provider.behavior.set
 *      (desktop -> server) / provider.behavior.state(server -> desktop) ——
 *      当前仅 provider='telegram'。选择器**只认 bindingId**(不是
 *      provider.prefs.* 的 bindingId/scopeId 二选一): 行为配置(emoji 回应 /
 *      回复引用 / 群免 @ 白名单)在绑定成立前没有意义, 收窄为单选择器把
 *      "谁能读写它"的边界钉死在已确认的绑定上。set 的三个全局字段与
 *      groupActivation 共用同一套 patch 三态: 缺省(undefined)=不动、
 *      显式枚举值 = 写入 override(哪怕这个值刚好等于当前版本默认值也照写
 *      不落空 —— 用户的显式选择不能因为协议以后调整默认值而被悄悄改写)、
 *      显式 null = 清除 override、回落到当时版本的默认值。二者可同帧组合,
 *      但至少要有一项实际改动(null 也算一次真实改动)—— 空 patch 直接拒收
 *      (不同于 prefs.set, 这里没有"无副作用地静默 no-op"的容错空间)。
 *      state 携带的**始终是已解析的非空有效值**(不是原始 patch, 不会是
 *      null), 且 groupActivation 只列出偏离默认值('mention')的 chatId;
 *      bound=false 时 parse 强制整帧收敛为默认行为 + 空白名单(未绑定没有
 *      主体持有 per-chat 覆盖)。三个全局字段的默认值(DEFAULT_TELEGRAM_
 *      BEHAVIOR)与个人版桌面客户端出厂行为对齐: emojiReactions='minimal'、
 *      replyQuoteDm='off'、replyQuoteGroup='first'。见 Provider-neutral
 *      behavior 小节。
 *
 *   编号说明: 本文件头的条目号与 docs/slack-hook-protocol.md §1 的消息目录
 *      对齐(那份是正本)。中间的跳号是因为部分帧只在下方各自的类型旁说明 ——
 *      14 多 provider(provider.bind.* / provider.prefs.*, 见 Provider-neutral
 *      小节)、15 最近会话(QUERY_KINDS)、16 群消息中继(GroupMessagePayload)、
 *      17 上下线通知偏好(LifecyclePreferencePayload, 即上面那条)、19 见上。
 *
 *   18. 续跑: turn.reopen(desktop -> server) —— 一个已经以 turn.end 收口的
 *      任务, 在桌面端被用户续跑了, 把后续进展重新接回渠道里那条消息。
 *
 *      要解决的问题: turn.end(status=error)之后, 用户常在桌面端点错误横幅上
 *      的「重试」。那会在**同一个会话**里起一个新 turn(桌面端发的是一条隐藏
 *      续跑指令), 任务确实继续跑了, 但渠道那条消息永远停在失败上 —— 因为
 *      turn.progress / turn.end 都以 requestId 为键, 那一轮已经收口, 协议里
 *      也没有任何"会话级"通道能让 desktop 主动往那条消息写东西。用户看到的
 *      就是"点了重试也没反应"。
 *
 *      形态刻意用**新 requestId + reopenOf**, 而不是复用原 requestId:
 *        - server 侧幂等语义不用改(原 requestId 的 turn.end 仍是一次性的),
 *          只需把 reopenOf 指向的那条消息的位置(channel + ts)登记给新
 *          requestId, 之后的 turn.progress / turn.end 走既有代码路径;
 *        - task.cancel 能精确命中续跑轮(它带的是新 requestId);
 *        - 一次续跑再失败、再被续跑时天然形成链条, 每环都有自己的 id。
 *
 *      路由面**只含** turn.progress / turn.end / task.cancel, 刻意不含
 *      interaction.*: 续跑是用户在桌面端点出来的, 人就在桌面前, 那一轮里 agent
 *      的提问 / 计划审阅 / 权限审批由桌面本地交互面直接处理, 不绕回渠道。
 *
 *      server 侧约定:
 *        - 认不出 reopenOf(映射已过期 / 消息已删)时**静默忽略**整条帧, 并对
 *          随后到达的同 requestId 的 turn.progress / turn.end 一并忽略 ——
 *          回流失败只是回到"消息停在失败上"的现状, 不是错误, 不要报错刷屏;
 *          更一般地: 对**从未登记过**的 requestId 的 turn.progress / turn.end
 *          一律静默忽略, 不报错也不新建消息;
 *        - 认得出时把那条消息改回进行中态, 后续 progress 原地刷新、turn.end
 *          定稿。渠道里不新增消息(用户抱怨的正是那条消息不动);
 *        - 本帧必须幂等: 同一 (requestId, reopenOf) 重复登记同一个位置, 无副作用
 *          (断线重投时 desktop 可能重复发送);
 *        - 不需要为续跑 requestId 关联 interaction.* —— 那些帧不会带着它到来;
 *        - 收到一个已经绑定到别的任务的 requestId 时拒绝登记, 并把该 requestId
 *          整体隔离(后续 turn.progress / turn.end 一并忽略, 不得落到原有路由上);
 *        - **连接断开时必须收口该连接上所有"已 reopen 但没收到 turn.end"的消息**
 *          (恢复原终态或改写成「续跑中断」), 否则它们会永久停在假的"进行中"上,
 *          比本能力上线前更糟; 收口是权威的, desktop 不会在重连后补回该轮结果。
 *          但收口落笔时必须校验该消息仍归"被断开的那个连接 + 那次 reopen"所有,
 *          迟到的收口不得盖掉更新的一次 reopen 或已到达的新终态。
 *      desktop 侧约定:
 *        - 只在 server 于 welcome.features 宣告 HOOK_FEATURE_TURN_REOPEN 时
 *          才发本帧(旧 server 会 parse 拒收丢帧, 虽不断连但没有意义);
 *        - 只有"用户在桌面端显式续跑"才触发 —— 桌面端在同一会话里问的其它
 *          问题不回流, 否则渠道消息会被无关内容改写;
 *        - 记账只在进程内(app 重启后原 requestId 已随进程消失), 有 TTL;
 *        - 本帧必须排在该 turn 的任何 turn.progress / turn.end 之前, 包括"首个
 *          观察到的事件本身就是终态"的情形(否则先发的 turn.end 被当未知 id 丢弃,
 *          随后的 reopen 又把消息改成进行中, 就再没有终态帧能收口);
 *        - 续跑轮的 turn.progress / turn.end 一律直发, 不缓存也不在重连后补发 ——
 *          刻意偏离"断线重连 desktop 补发未送达 turn.end"的通用约定, 因为那条
 *          消息在断连瞬间已被 server 收口, 迟到的 turn.end 只会撞上被解绑的
 *          requestId 而丢弃, 反把"其实成功"显示成"续跑中断"。相应地, turn.end
 *          没发出去时不得再把这条消息线登记成可续跑。
 *
 *      requestId 命名空间: 续跑 requestId 由 desktop 生成、普通任务由 server
 *      生成, 却是同一张路由表的键(parse 只能校验非空且不等于 reopenOf), 所以
 *      desktop 必须用全局抗碰撞标识(UUID v4 或同等强度), server 以上面那条
 *      "拒绝并隔离已绑定 requestId"兜底。
 *
 *      已声明接受的降级: 连接在续跑轮跑完前断开时结果不回流 —— 断在装映射前是
 *      消息保持原失败态(与本能力上线前一致), 断在装映射后是 server 收口成原终态
 *      或「续跑中断」。两种都可在渠道重发。刻意不为此加 ack 往返: 回流是增强而非
 *      关键路径。注意"失败方向安全"依赖上面那条断连收口 —— 没有它, 可见状态会从
 *      "停在失败"退化成"永远进行中", 反而比不做回流更糟。
 */

/** 当前协议版本。信封 `v` 不等于本值的消息直接拒收。 */
export const HOOK_PROTOCOL_VERSION = 1;

/**
 * 单帧(JSON 序列化后)最大字符数。parse 对超长原始帧直接拒收 —— 纯粹是
 * 防 OOM 的粗防御, 不是业务限额。task.dispatch 可携带 base64 图片附件, 故取
 * 一个能容纳"几张聊天截图"的宽上限(48 MiB); 附件的精细限额(单图大小 /
 * 张数)由生产源头(provider)负责, 不依赖本值。非附件帧远小于此。
 */
export const HOOK_MAX_FRAME_CHARS = 48 * 1024 * 1024;

/** 消息类型全集(v1 七种 + v2 增量帧)。 */
export const HOOK_MESSAGE_TYPES = [
  'hello',
  'welcome',
  'ping',
  'pong',
  'task.dispatch',
  'task.ack',
  'turn.end',
  'turn.delivery',
  'turn.progress',
  'turn.reopen',
  'msg.op',
  'msg.op.result',
  'bind.start',
  'bind.update',
  'bind.revoke',
  'provider.bind.start',
  'provider.bind.cancel',
  'provider.bind.revoke',
  'provider.bind.update',
  'provider.bind.state',
  'query.request',
  'query.response',
  'task.cancel',
  'session.archive',
  'interaction.request',
  'interaction.decision',
  'interaction.cancel',
  'prefs.get',
  'prefs.set',
  'prefs.state',
  'provider.prefs.get',
  'provider.prefs.set',
  'provider.prefs.state',
  'tool.request',
  'tool.response',
  'bind.state',
  'group.message',
  'lifecycle.preference',
  'provider.behavior.get',
  'provider.behavior.set',
  'provider.behavior.state',
] as const;

export type HookMessageType = (typeof HOOK_MESSAGE_TYPES)[number];

/**
 * 消息信封 —— 线上跑的每一帧都是这个形状。
 * `id` 是发送方生成的帧唯一标识(日志/去重用); 业务关联一律走 payload 里的
 * requestId, 不用 `id`。`ts` 是发送方时钟(unix ms), 仅供诊断, 不参与逻辑。
 */
export interface HookEnvelope<TType extends HookMessageType, TPayload> {
  v: number;
  type: TType;
  id: string;
  ts: number;
  payload: TPayload;
}

// ── 阶段 1: 连接与身份 ───────────────────────────────────────────────────────

/**
 * hello(desktop -> server): 建连后第一帧, 自报身份与能力。
 * 工作区别名映射变更后, desktop 重发 hello 即时生效(server 以最新一帧为准)。
 */
export interface HelloPayload {
  protocolVersion: number;
  /** desktop 设备稳定标识(多设备路由预留, v1 server 侧可只记录)。 */
  deviceId: string;
  deviceName: string;
  /** 本连接注册的工作区别名列表 —— server 只能派发列表内的别名。 */
  workspaces: string[];
  /**
   * 本连接的默认工作区别名(可选; 缺省 / null = 无默认, server 按各自既有
   * 规则决定, 通常落 HOOK_CHAT_WORKSPACE_ALIAS)。**必须是 workspaces 的成员**
   * (协议层校验) —— 默认值不能绕过「server 只能派发列表内的别名」这条约束。
   *
   * 动机: X 这类**一次交互只有一条公开消息**的渠道没有交互式选择面板(Slack
   * 有 Block Kit、Telegram 有 inline keyboard), 无处让用户挑目录, 于是所有
   * 任务都只能落在对话伪目录上、碰不到本地仓库。由 desktop 在握手时声明一个
   * 默认目录, 是不引入额外往返、也不占用正文字符的做法。
   *
   * 旧 server 校验器只查已知字段, 本字段安全透传(同 features 的兼容策略)。
   */
  defaultWorkspace?: string | null;
  /** 可用 agent 类型(如 'cc' / 'codex'), 供 server 侧校验 dispatch options。 */
  agents: string[];
  /**
   * desktop 侧能力标识(可选, 缺省 = 旧客户端无能力)。当前已定义:
   * HOOK_FEATURE_MULTI_TEAM —— 会消费 bind.state 快照与按 team 定位的
   * bind.update / prefs.state。老 server 校验器只查已知字段, 本字段安全透传。
   */
  features?: string[];
  /**
   * 是否由 Slack Bot 私信设备上下线通知。缺省表示旧客户端,server 按既有
   * 默认开启处理;新客户端始终显式发送当前有效值。
   */
  lifecycleAnnouncement?: boolean;
}

/** welcome(server -> desktop): hello 的应答, 握手完成。 */
export interface WelcomePayload {
  serverName: string;
  /** server 侧启用的可选能力标识, v1 恒空数组, 预留。 */
  features: string[];
}

/** ping / pong: 心跳, 双向皆可发起, 收到 ping 必须回 pong。payload 恒空对象。 */
export type PingPayload = Record<string, never>;
export type PongPayload = Record<string, never>;

// ── 阶段 2: 派活 ─────────────────────────────────────────────────────────────

/**
 * dispatch 的可选 override。全部可空 —— 空值落到 desktop 连接配置的默认值。
 * permissionMode 语义: 仅对「新建 session」的任务生效 —— desktop 校验其属于
 * 目标 agent 的能力档位清单, 合法即用, 非法/缺省落 bypassPermissions;
 * 复用/接管已有会话时忽略(session meta 权威, 进行中的会话不受影响)。
 */
export interface TaskDispatchOptions {
  model?: string | null;
  permissionMode?: string | null;
  agentKind?: string | null;
  /** 思考强度档位(如 low/medium/high); 空 = desktop 按草稿默认落值。 */
  effort?: string | null;
}

/**
 * 入站附件(图片等), 随 dispatch 一起下发。base64 内联传输 —— 复用已建好、
 * 已鉴权的 WS 通道, 免去 desktop 再开 HTTP 拉取端点。desktop 侧解码落盘后
 * 以本地路径喂给 agent(maker 的 image content block 要 path 而非 base64)。
 * 精细限额(单图大小 / 张数)由 provider 在生产端把关, 见其实现。
 */
export interface TaskAttachment {
  /** 原文件名(落盘 / 提示用); 无则 desktop 按序号命名。 */
  name: string | null;
  /** MIME 类型(如 image/png)。 */
  mimeType: string;
  /** base64 编码的字节(不含 data: 前缀)。 */
  dataBase64: string;
}

/**
 * agent 多模态可消费的图片 MIME 白名单 —— 协议层的权威单一来源。
 * 与 desktop renderer 的 SUPPORTED_IMAGE_EXTS 一致, 也是 Claude / Codex vision
 * 实际接受的集合(png / jpeg / gif / webp)。provider 下载端与 desktop 落盘端
 * 都据此过滤: 一端宽一端窄会导致图片被下载/传输后在对端静默丢弃, 白费带宽还
 * 不告知用户。bmp / svg / heic / avif / tiff 等不在此列(上游 vendor API 不接受)。
 */
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * 判定 MIME 是否为 agent 可消费的图片类型(大小写 / 前后空白无关;
 * 常见别名 image/jpg 归一到 image/jpeg)。
 */
export function isSupportedImageMime(mime: string): boolean {
  const m = mime.trim().toLowerCase();
  if (m === 'image/jpg') return true;
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m);
}

/**
 * 结构化 thread 上下文条目(来源 IM 的 thread 历史中的一条消息)。
 * desktop 据此渲染可折叠的 thread 上下文卡片, 不再依赖从 prompt
 * 文本里正则解析 <thread_context> 块。
 */
export interface ThreadContextEntry {
  author: string;
  text: string;
  /** 该条目是否为 bot 自身的回复(渲染时可视觉区分)。 */
  isBot?: boolean;
}

/**
 * 任务来源元数据 —— 告知 desktop 这条任务来自哪个 IM 平台及其上下文。
 * 字段全部可选(im 除外); 旧 server 不发时 desktop 降级为纯文本渲染。
 */
export interface TaskSource {
  /** IM 平台标识(开放集合): 'slack' | 'feishu' | 'discord' | ... */
  im: string;
  /** 来源显示名(频道名 "#general"、群名等); null = 未知。 */
  channelName?: string | null;
  /**
   * (multi-team)来源 Slack workspace id / 显示名: desktop 存进 session
   * meta, 作会话标题前缀与网关工具调用的默认 team。老 server 不下发。
   */
  teamId?: string | null;
  teamName?: string | null;
  /** 结构化 thread 上下文; 省略或空数组 = 无 thread 历史。 */
  threadContext?: ThreadContextEntry[];
  /**
   * 触发本任务的 IM 消息 id(与 group.message.messageId 同一 id 空间)。
   * desktop 用它在本地群窗口中精确剔除"当前消息", 避免上下文与 prompt 重复。
   * 旧 server 不发 = null/缺省, desktop 降级为不剔重。
   */
  triggerMessageId?: string | null;
  /**
   * 用户 @ bot 的干净原文(UI 显示用) —— 不含 thread 上下文与 prompt 指引。
   * desktop 据此渲染任务卡片正文, 与发给 agent 的完整 prompt 彻底分离。
   */
  userText?: string;
}

/**
 * task.dispatch(server -> desktop): 派发一个任务。
 * 两种会话定位方式:
 *   - sessionId 为 null(默认): 按 externalKey 查映射, 有则复用、无则在
 *     workspace 别名对应目录下新建 —— 此时 workspace 必填。
 *   - sessionId 非 null(接管): 直接投进该已有 desktop session 并把
 *     externalKey 重绑到它; workspace 忽略(session 自带工作目录, 但其
 *     workingDir 必须落在本连接注册的别名路径内, 否则 rejected)。
 */
export interface TaskDispatchPayload {
  requestId: string;
  externalKey: string;
  /** 工作区别名; sessionId 为 null 时必填(非 null 字符串)。 */
  workspace: string | null;
  /** 接管目标 session; 普通流程恒 null。 */
  sessionId: string | null;
  prompt: string;
  options?: TaskDispatchOptions;
  /** 入站附件(可选); 省略或空数组 = 无附件, 纯文本任务。 */
  attachments?: TaskAttachment[];
  /** 任务来源元数据; 省略 = 来源未知, desktop 按纯文本处理。 */
  source?: TaskSource;
}

/** ack 三态。 */
export const TASK_ACK_RESULTS = ['accepted', 'queued', 'rejected'] as const;
export type TaskAckResult = (typeof TASK_ACK_RESULTS)[number];

/** rejected 的机器可读原因。 */
export const TASK_REJECT_REASONS = [
  /** workspace 别名未在本连接注册。 */
  'unknown_workspace',
  /** 接管目标 session 的工作目录不在本连接注册的别名路径内。 */
  'workspace_not_allowed',
  /** 接管目标 session 不存在。 */
  'session_not_found',
  /** desktop 侧 hook 功能已关闭(总开关或本连接开关)。 */
  'disabled',
  /** 参数非法(desktop 业务层校验不过, 区别于协议层直接拒收的坏帧)。 */
  'invalid',
] as const;
export type TaskRejectReason = (typeof TASK_REJECT_REASONS)[number];

/**
 * task.ack(desktop -> server): dispatch 的立即应答。
 * 字段联动约束(parse 强制):
 *   - reason 仅 rejected 时非 null;
 *   - queuePosition 仅 queued 时非 null(0 起, 非负整数);
 *   - sessionId 在 accepted / queued 时为目标 session id, rejected 时为 null。
 */
export interface TaskAckPayload {
  requestId: string;
  result: TaskAckResult;
  reason: TaskRejectReason | null;
  sessionId: string | null;
  queuePosition: number | null;
}

// ── 阶段 4: 交差 ─────────────────────────────────────────────────────────────

/** cancelled: task.cancel 中断收口(errorMessage 恒 null, finalText 可为已产出的部分文本)。 */
export const TURN_END_STATUSES = ['ok', 'error', 'cancelled'] as const;
export type TurnEndStatus = (typeof TURN_END_STATUSES)[number];

/** turn 的用量摘要。v1 只有耗时, 字段可空(拿不到就 null, 不编造)。 */
export interface TurnEndUsage {
  durationMs: number | null;
}

/**
 * turn.end(desktop -> server): 任务收口。
 * 收口时机以 maker-core 事件流的 done / terminal error 为准。
 * 字段联动约束(parse 强制): status 为 'ok' 时 errorMessage 必须为 null;
 * 为 'error' 时 errorMessage 必须为非空字符串。
 */
export interface TurnEndPayload {
  requestId: string;
  externalKey: string;
  sessionId: string | null;
  status: TurnEndStatus;
  /** 该 turn 的最终文本(error 时可为空串)。 */
  finalText: string;
  errorMessage: string | null;
  usage: TurnEndUsage;
  /**
   * 出站附件(agent 产出的图片 / 文件, base64 内联) —— 与入站 attachments
   * 对称复用 TaskAttachment。desktop 侧从最终文本的 xdt-image / xdt-file
   * 引用与 tool_result 旁路收集并施加大小/数量限额(finalText 中对应引用
   * 已剥离/替换为提示); server 侧上传到渠道。省略或空数组 = 无附件。
   * 旧 server 收到未知字段静默忽略(校验器只查已知字段), 向后兼容。
   */
  attachments?: TaskAttachment[];
}

/**
 * turn.delivery(server -> desktop): server 对普通 turn.end 的两阶段交付回执。
 *
 * accepted 表示 server 已经接管最终结果及其重试责任；delivered 表示渠道侧
 * 终态动作已完成；failed 表示 server 已停止重试。desktop 只有在双方协商
 * HOOK_FEATURE_TURN_DELIVERY 后才等待本帧，老 server 继续沿用 fire-and-forget。
 */
export const TURN_DELIVERY_STATES = ['accepted', 'retrying', 'delivered', 'failed'] as const;
export type TurnDeliveryState = (typeof TURN_DELIVERY_STATES)[number];

/** retrying / failed 回执的安全、结构化错误；不得携带上游响应体、凭证或用户内容。 */
export interface TurnDeliveryError {
  code: string;
  message: string;
  /** 原样重放同一个 turn.end 是否仍可能恢复；false 时 desktop 只提示，不重跑 Agent。 */
  retryable: boolean;
}

export interface TurnDeliveryPayload {
  requestId: string;
  state: TurnDeliveryState;
  /** 已发生的渠道发布尝试次数；accepted 为 0，其余状态至少为 1。 */
  attempt: number;
  /** 仅 retrying 为正的安全整数，表示 server 计划的下次尝试时刻(unix ms)。 */
  retryAt: number | null;
  /** retrying / failed 非 null；accepted / delivered 恒为 null，failed 的 retryable 必须为 false。 */
  error: TurnDeliveryError | null;
}

// ── 阶段 9(v2): 执行进度 ────────────────────────────────────────────────────

/**
 * turn.progress(desktop -> server): turn 执行中的渲染快照(见文件头第 9 条)。
 * text 是 desktop 合成好的完整 markdown 快照(过程区时间线 + 已产出的部分
 * 正文), server 侧不拼接、不累积 —— 每帧整体替换占位消息内容(latest-wins,
 * 丢帧无害)。desktop 侧负责节流(约 1.5s/帧)与长度控制。
 */
export interface TurnProgressPayload {
  requestId: string;
  /** 当前渲染快照(完整替换语义, 非增量)。 */
  text: string;
}

// ── 阶段 18(v2): 收口后的续跑 ───────────────────────────────────────────────

/**
 * turn.reopen(desktop -> server): 把一个已收口任务的续跑接回原消息
 * (见文件头第 18 条)。
 *
 * server 收到后把 reopenOf 那条消息的位置登记给 requestId, 之后 desktop 会用
 * **requestId**(不是 reopenOf)继续发 turn.progress 与 turn.end, 走既有路径。
 * 认不出 reopenOf 时静默忽略本帧与后续同 requestId 的帧。
 *
 * 路由面**只含** turn.progress / turn.end / task.cancel。刻意不含 interaction.*:
 * 续跑是用户在**桌面端**点出来的, 人就在桌面前, 那一轮里 agent 的提问 / 计划审阅 /
 * 权限审批由桌面本地交互面直接处理, 不绕回渠道 —— 所以 server 不会收到带续跑
 * requestId 的 interaction.request, 也不需要为它建立 thread 关联。(反过来若把交互
 * 推回渠道, 用户得离开正在操作的桌面端去渠道点按钮, 更绕。)
 *
 * 可靠性: 本帧可被重复发送, server 必须幂等 —— 同一 (requestId, reopenOf) 重复
 * 登记同一个位置, 无副作用。与之对称, server 对**从未登记过**的 requestId 的
 * turn.progress / turn.end 一律静默忽略: 不报错、不新建消息。
 *
 * 帧序: 本帧必须排在这一轮的**任何** turn.progress / turn.end 之前 —— 包括"首个
 * 观察到的事件本身就是终态"(例如立刻的凭证错误)。先发 turn.end 的话 server 会按
 * 未知 requestId 丢弃它, 随后的 reopen 又把消息改成进行中, 就再没有终态帧能收口。
 *
 * 孤儿收口(server 侧责任): 映射装上、消息已改成进行中之后, desktop 崩溃 / 重启
 * 不会补发任何帧(记账只在进程内)。所以**连接断开时 server 必须收口该连接上所有
 * "已 reopen 但未收到 turn.end"的消息** —— 恢复原终态或改写成一句"续跑中断"。
 * 少了这条, 可见状态会从"停在失败"退化成"永远进行中", 比不做回流更糟。收口落笔时
 * 必须校验该消息仍归"被断开的那个连接 + 那次 reopen"所有: desktop 可能毫秒级重连、
 * 用户也可能立刻再点一次重试, 迟到的收口不得盖掉更新的一次 reopen 或已到达的新终态。
 *
 * 断连即终局(desktop 侧对称责任): 续跑轮的 turn.progress / turn.end 一律直发,
 * **不缓存也不在重连后补发** —— 这刻意偏离"断线重连 desktop 补发未送达 turn.end"
 * 的通用约定, 因为那条消息在断连瞬间已被上面的收口改写, 迟到的 turn.end 只会撞上
 * 被解绑的 requestId 而丢弃, 反把"其实成功"显示成"续跑中断"。相应地, turn.end 没
 * 发出去时 desktop 不得再把这条消息线登记成可续跑(它的 reopenOf 已被解绑)。
 *
 * id 碰撞: 续跑 requestId 由 desktop 生成(须 UUID v4 或同等强度), 与 server 生成的
 * 普通 requestId 共用一张路由表。server 收到已绑定到别的任务的 requestId 时拒绝登记,
 * **并把该 requestId 整体隔离** —— 后续 turn.progress / turn.end 一并忽略。只拒本帧
 * 却继续按老路由收后续帧, 等于让续跑的进度与终态改写那个无关任务的消息。
 *
 * 已声明接受的降级: 连接在续跑轮跑完前断开时结果不回流 —— 断在装映射前是消息保持
 * 原失败态(与本能力上线前完全一致), 断在装映射后是 server 收口成原终态或"续跑中断"
 * (那一轮其实成功时, 渠道会偏保守地显示没成功, 而桌面端有正确结果)。两种情形用户都
 * 可在渠道重发。协议刻意不为此加 ack 往返: 回流是增强而非关键路径。注意这个"失败
 * 方向安全"的结论**依赖上面那条孤儿收口**。
 */
export interface TurnReopenPayload {
  /**
   * 续跑轮的新任务 id(后续 progress / end / cancel 都用它)。
   *
   * 必须**全局抗碰撞**(UUID v4 或同等强度), 不得用递增计数器或会话内序号: 普通
   * 任务的 requestId 由 server 生成、本字段由 desktop 生成, 两者是同一张生命周期
   * 路由表的键, 而 parse 只能校验"非空且不等于 reopenOf"。id 空间重叠时, 一次续跑
   * 可能覆盖掉某个无关在跑任务的路由。server 侧以"拒绝已绑定的 requestId"兜底。
   */
  requestId: string;
  /** 被续跑的那一轮的 requestId —— server 据此定位渠道里那条消息。 */
  reopenOf: string;
  /**
   * 渠道内标识(原样回传), 供日志与诊断关联。
   *
   * **不参与路由**: 定位那条消息的唯一依据是 reopenOf。刻意不允许用它兜底 ——
   * 两端独立实现(server 闭源、独立仓), 一端"映射过期就按 externalKey 找 thread"、
   * 另一端"映射过期就忽略", 同一次过期续跑会在一端改写消息、在另一端丢弃。
   */
  externalKey: string;
  /** 续跑发生在哪个会话(记录与调试用, 不参与路由)。 */
  sessionId: string | null;
  /**
   * 为什么被续跑。当前只有 'user-continued'(用户在桌面端显式点了续跑 / 重试)。
   * 开放集合: server 不认识的值按 'user-continued' 处理即可, 不要拒帧。
   */
  reason: string;
}

// ── 阶段 5(v2): 身份绑定 ────────────────────────────────────────────────────

/**
 * bind.start(desktop -> server): 发起「Slack 用户 ↔ 本设备」绑定。
 * 阶段 4 起绑定走 Sign in with Slack(OIDC): 新桌面端发**空对象** `{}`,
 * server 据连接身份签发授权链接经 bind.update(pending, authorizeUrl)回推。
 * 设备身份取连接 hello 的 deviceId, 不在本帧携带。
 *
 * email 字段仅为识别老客户端保留(@deprecated): 老桌面端仍按邮箱发起,
 * server 收到带 email 的 bind.start 即判定为旧版, 回 bind.update(failed)
 * 提示升级, 不再执行邮箱定位。
 */
export interface BindStartPayload {
  /** @deprecated 旧版邮箱绑定流字段; 新端不再发送, 仅用于 server 识别老客户端。 */
  email?: string;
  /**
   * (multi-team)重新授权指定 workspace 时 pin 授权页到该 team(server 在
   * 授权链接上带 team 参数); 缺省/null = 用户在授权页自选(添加新 team)。
   * 老 server 校验器不查本字段, 安全透传(它照常签发不 pin 的链接)。
   */
  teamId?: string | null;
}

/**
 * bind.update 状态机:
 *   none      未绑定(连接建立后 server 主动推一帧告知现状)
 *   pending   OIDC 授权链接已签发(authorizeUrl 非空), 等待用户在浏览器授权
 *   confirmed 绑定成立(slackUserId / slackUserName 非空)
 *   denied    用户在 Slack 授权页点了拒绝
 *   expired   授权超时(state 令牌过期)
 *   failed    流程失败(如老客户端、该 workspace 未安装本 app), message 携带原因
 *   revoked   绑定被解除(本设备主动 revoke, 或被同用户新设备顶掉)
 */
export const BIND_UPDATE_STATES = [
  'none',
  'pending',
  'confirmed',
  'denied',
  'expired',
  'failed',
  'revoked',
] as const;
export type BindUpdateState = (typeof BIND_UPDATE_STATES)[number];

/**
 * bind.update(server -> desktop): 绑定状态推送(bind.start 的应答 + 后续
 * 任何状态变化, 含连接建立时的现状同步与被新设备顶掉的通知)。
 * 字段联动(parse 强制): confirmed 时 slackUserId 非空; pending 时
 * authorizeUrl 非空(OIDC 授权链接); failed 时 message 非空。
 */
export interface BindUpdatePayload {
  state: BindUpdateState;
  slackUserId: string | null;
  /** Slack 显示名(设置页展示「已绑定 @xxx」用), 拿不到可为 null。 */
  slackUserName: string | null;
  /** 人类可读补充说明(failed 原因 / revoked 缘由等)。 */
  message: string | null;
  /**
   * OIDC 授权链接(仅 state=pending 时非空): 桌面端用系统浏览器打开它,
   * 用户在 Slack 授权页确认后 server 回调完成绑定。其它状态省略或 null。
   */
  authorizeUrl?: string | null;
  /**
   * 结构化失败原因(仅 state=failed 时可选)。桌面端按它分支 UI, 不解析
   * message 文案(规则 9)。当前已定义:
   *   'not-installed' —— 用户授权的 Slack workspace 未安装本 App(SIWS 授权
   *   不要求安装, 但 bot 无 token 收发消息), 桌面端显示「安装 App」引导。
   * parse 侧只校验 string|null(未知值放行), 老客户端遇到新 reason 忽略即可。
   */
  reason?: string | null;
  /**
   * 按 workspace 定制的安装链接(仅 reason='not-installed' 时可选): 携带
   * team 参数, Slack 安装授权页会预选到用户刚授权的那个 workspace, 免手选。
   * 桌面端缺省(老 server)回退通用 /slack/install 链接。
   */
  installUrl?: string | null;
  /**
   * 绑定所在 Slack workspace 显示名(仅 state=confirmed 时可选下发, 取安装
   * 档案的 teamName): 设置页状态行展示「已绑定 @xxx(workspace)」。老 server
   * 不下发或档案缺名时为 null/缺省, 桌面端回退只显示用户名。
   */
  teamName?: string | null;
  /**
   * (multi-team)事件所属 Slack workspace id: confirmed / revoked 按 team
   * 定位到绑定列表的对应行; 授权流早期(pending / denied / expired)团队
   * 尚未确定, 为 null/缺省。老 server 不下发, 单绑定桌面端不依赖本字段。
   */
  teamId?: string | null;
}

/** bind.update.reason 已知值: 绑定的 Slack workspace 未安装本 App。 */
export const BIND_FAIL_REASON_NOT_INSTALLED = 'not-installed';

/** bind.update.reason 已知值(multi-team): 该绑定被同用户在另一台设备顶替。 */
export const BIND_FAIL_REASON_SUPERSEDED = 'superseded';

/**
 * bind.revoke(desktop -> server): 解除本设备绑定。
 * teamId 非空 = 只解绑该 workspace(multi-team); 空/缺省 = 解绑本设备全部
 * (兼容单绑定老 desktop 的"关开关即全解")。pendingOnly=true = 只作废
 * 进行中的授权尝试(pending 授权 / 等安装登记), 不触碰任何已确认绑定 ——
 * multi-team 下「取消添加 workspace」的通道(此时 teamId 忽略)。
 * ⚠ 旧 server 对带字段的帧 parse 拒收(它要求空对象), desktop 仅在
 * welcome.features 声明 multi-team 后才发非空形态。
 */
export interface BindRevokePayload {
  teamId?: string | null;
  pendingOnly?: boolean;
}

/**
 * bind.state(server -> desktop, multi-team): 本设备绑定全量快照。
 * 权威列表语义 —— 连接建立与任何绑定变化(新增 / 解除 / 被顶 / 撤权清理)
 * 后整体推送, desktop 以此对齐本地列表(bind.update 只承载过程事件)。
 * 仅对 hello.features 声明 multi-team 的连接下发; 旧 desktop 不认识本
 * 类型, parse 拒收丢帧不断连。
 */
export interface BindStateEntry {
  teamId: string;
  /** workspace 显示名(安装档案 teamName); 档案缺名时 null。 */
  teamName: string | null;
  slackUserId: string;
  slackUserName: string | null;
}

export interface BindStatePayload {
  bindings: BindStateEntry[];
}

// ── Provider-neutral binding (append-only v1) ───────────────────────────────

/**
 * IM providers supported by the shared Cindy relay.
 * Append-only: adding a value here is backward compatible because every
 * provider-specific frame family is gated behind a `provider:<id>` welcome
 * capability — an old peer that does not know the new id never negotiates it,
 * and its parse rejects stray frames without dropping the connection.
 */
export const HOOK_PROVIDERS = ['slack', 'telegram', 'x'] as const;
export type HookProvider = (typeof HOOK_PROVIDERS)[number];

/**
 * Provider binding states. A binding attempt moves monotonically from pending
 * through optional confirmation to confirmed, or one of the terminal states.
 */
export const PROVIDER_BIND_STATES = [
  'none',
  'pending',
  'awaiting_confirmation',
  'confirmed',
  'denied',
  'expired',
  'failed',
  'revoked',
  'superseded',
] as const;
export type ProviderBindState = (typeof PROVIDER_BIND_STATES)[number];

/** Known UI action hints. The wire remains open; consumers ignore unknown values. */
export const PROVIDER_BIND_ACTIONS = [
  'open_connect_url',
  'copy_connect_url',
  'cancel',
  'retry',
  'revoke',
  'open_provider',
  'add_to_group',
] as const;
export type KnownProviderBindAction = (typeof PROVIDER_BIND_ACTIONS)[number];
export type ProviderBindAction = string;

/** Start a provider-specific, one-time binding attempt for this device. */
export interface ProviderBindStartPayload {
  requestId: string;
  provider: HookProvider;
  /** Optional provider scope (for example a Slack team or Telegram bot id). */
  scopeId?: string | null;
}

/** Cancel exactly one in-flight binding attempt without touching a binding. */
export interface ProviderBindCancelPayload {
  requestId: string;
  provider: HookProvider;
  attemptId: string;
}

/** Revoke exactly one confirmed binding. */
export interface ProviderBindRevokePayload {
  requestId: string;
  provider: HookProvider;
  bindingId: string;
}

/**
 * Shared payload for provider.bind.update and provider.bind.state. update is an
 * event/reply; state is an authoritative point-in-time snapshot for one scope.
 * All nullable fields are explicit so an old value cannot survive a snapshot.
 */
export interface ProviderBindStatusPayload {
  provider: HookProvider;
  /** Request id being answered, or null for an unsolicited state push. */
  replyTo: string | null;
  state: ProviderBindState;
  attemptId: string | null;
  bindingId: string | null;
  principalId: string | null;
  principalName: string | null;
  scopeId: string | null;
  scopeName: string | null;
  /** One-time provider deep link; present only while state=pending. */
  connectUrl: string | null;
  /** Unix milliseconds; required for pending/awaiting_confirmation attempts. */
  expiresAt: number | null;
  /** Stable machine-readable reason; required for unsuccessful terminal states. */
  reason: string | null;
  /** Optional safe recovery/provider URL interpreted by the host application. */
  remediationUrl: string | null;
  actions: ProviderBindAction[];
}

export type ProviderBindUpdatePayload = ProviderBindStatusPayload;
export type ProviderBindStatePayload = ProviderBindStatusPayload;

// ── 阶段 6(v2): 实时问答 ────────────────────────────────────────────────────

/** 可查询的清单种类。 */
export const QUERY_KINDS = ['workspaces', 'models', 'sessions', 'session-new'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/**
 * query.request(server -> desktop): 实时拉取清单(/bind /model /effort 触发)。
 * queryId 由 server 生成, response 原样回传配对; server 侧自行做超时。
 */
export interface QueryRequestPayload {
  queryId: string;
  kind: QueryKind;
  /** kind=session-new: create and bind a blank task immediately for `/new`. */
  sessionNew?: {
    previousExternalKey: string;
    externalKey: string;
    workspace: string;
    options?: TaskDispatchOptions;
    source?: TaskSource;
  };
}

/**
 * 模型条目: efforts 为该模型支持的思考强度档位(可空数组 = 不支持调档)。
 * group 是目录分组 id(如 'gpt' / 'gpt-budget'): 骨折版与官方版 displayName
 * 故意同名、仅靠分组区分, server 渲染下拉时据此加区分后缀, 否则出现两个
 * 一模一样的 "GPT-5.5"(线上实撞)。可选 —— 旧桌面端不发, server 视为无分组。
 */
export interface QueryModelEntry {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  group?: string | null;
}

/**
 * 权限档条目(label = desktop capabilities 的 displayName, 原样透传,
 * 与模型 label 同风格 —— server 不做本地化映射, 避免档位集合演进时文案漂移)。
 */
export interface QueryPermissionModeEntry {
  id: string;
  label: string;
}

/**
 * 按 agent 分组的模型清单(kind=models 的响应体)。
 * permissionModes 缺席 = 旧版 desktop(不支持权限档下发), server 侧应隐藏
 * 权限选择 UI; 空数组 = 该 agent 无可选档位, 同样隐藏。
 */
export interface QueryAgentModels {
  agentKind: string;
  models: QueryModelEntry[];
  permissionModes?: QueryPermissionModeEntry[];
}

/** Privacy-minimised recent-session entry for the provider session picker. */
export interface QuerySessionEntry {
  id: string;
  title: string;
  /** Workspace alias only; local absolute paths are forbidden on this wire. */
  workspace: string;
  /** Unix milliseconds of the latest local activity. */
  lastActiveAt: number;
}

/**
 * query.response(desktop -> server): 问答应答。
 * ok=false 时 error 非空(desktop 侧取清单失败); ok=true 时按 kind 携带
 * workspaces 或 agents 之一(parse 强制)。
 */
export interface QueryResponsePayload {
  queryId: string;
  kind: QueryKind;
  ok: boolean;
  error: string | null;
  /** kind=workspaces 且 ok 时必填: 当前注册的工作区别名。 */
  workspaces?: string[];
  /** kind=models 且 ok 时必填: 按 agent 分组的可用模型与 effort 档位。 */
  agents?: QueryAgentModels[];
  /** kind=sessions 且 ok 时必填: at most 20 privacy-minimised entries. */
  sessions?: QuerySessionEntry[];
  /** kind=session-new 且 ok 时必填。 */
  sessionId?: string;
}

// ── 阶段 7(v2): 任务取消 ────────────────────────────────────────────────────

/**
 * task.cancel(server -> desktop): 中断在跑任务(/stop 触发)。
 * desktop 收到后中断对应 session 的当前 turn, 以 turn.end(cancelled) 收口;
 * requestId 未知 / 任务已收口时静默忽略(与 turn.end 的竞态由 server 侧
 * 幂等消化)。
 */
export interface TaskCancelPayload {
  requestId: string;
}

// ── 阶段 8(v2): 会话归档 ────────────────────────────────────────────────────

/**
 * session.archive(server -> desktop): 归档 externalKey 绑定的会话(私聊
 * /new 换代触发, 旧代会话不再显示在桌面端列表)。desktop 侧幂等: 无绑定、
 * 会话不存在或已归档时静默忽略。老版本 desktop 不认识本类型, parse 拒收
 * 丢帧不断连(见文件头「type 为开放集合」约定), 仅表现为旧会话留在列表。
 */
export interface SessionArchivePayload {
  externalKey: string;
}

// ── 阶段 10(v2): 执行中交互 ─────────────────────────────────────────────────

/** 单个交互卡按钮上限(Slack actions block 每块 5 个 x 分块, 取宽松上限)。 */
export const MAX_INTERACTION_BUTTONS = 24;

/**
 * 交互卡按钮。id 是 desktop 侧的决策映射键(server 原样回传, 不理解语义),
 * 同一张卡内唯一; 字符集限制: 不含 '|'(server 侧 value 复合编码分隔符)。
 */
export interface InteractionButton {
  id: string;
  label: string;
  /** 视觉样式(Slack 按钮 style; default = 无样式)。 */
  style: 'primary' | 'danger' | 'default';
}

/**
 * interaction.request(desktop -> server): turn 执行中 agent 发起的用户交互,
 * 以「标题 + markdown 正文 + 按钮组」的渠道无关卡片形式转发。server 渲染进
 * 该任务的回帖 thread, 按钮按压回 interaction.decision。
 * kind 是开放集合(当前 'ask_user_question' / 'plan_review'), server 只透传
 * 日志不理解语义 —— 新 kind 不需要 server 升级。
 */
export interface InteractionRequestPayload {
  /** 所属任务(server 据此定位回帖 thread 并校验归属)。 */
  requestId: string;
  /** 交互唯一标识(maker-core InteractionRequest.requestId), 决策配对键。 */
  interactionId: string;
  kind: string;
  title: string;
  /** markdown 正文(server 转渠道格式渲染); 可为空串。 */
  body: string;
  buttons: InteractionButton[];
}

/**
 * interaction.decision(server -> desktop): 用户按下交互卡按钮。
 * desktop 按 interactionId 配对挂起的交互, 用 buttonId 查自己登记的
 * 按钮->决策映射(语义不过网线)。迟到/未知的 decision 静默忽略。
 */
export interface InteractionDecisionPayload {
  requestId: string;
  interactionId: string;
  buttonId: string;
}

/**
 * interaction.cancel(desktop -> server): 交互已在 desktop 侧收口(超时按
 * 安全默认自决 / turn 结束), 通知 server 改写卡片(摘按钮 + reason 文案),
 * 防止用户对着死卡片按。幂等: server 找不到对应卡片时静默忽略。
 */
export interface InteractionCancelPayload {
  requestId: string;
  interactionId: string;
  /** 卡片改写文案(人类可读)。 */
  reason: string;
}

// ── 阶段 11(v2): 目录偏好远程读写 ──────────────────────────────────────────

/** prefs.get(desktop -> server): 拉取本设备绑定用户的全部目录偏好快照。 */
export interface PrefsGetPayload {
  /** desktop 生成的关联 id, prefs.state.replyTo 回显配对。 */
  requestId: string;
}

/** 单目录偏好条目(与 server user_prefs 行同形; slackUserId 不过网线)。 */
export interface WorkspacePrefsEntry {
  workspace: string;
  model: string | null;
  effort: string | null;
  agentKind: string | null;
  permissionMode: string | null;
  /**
   * (multi-team)偏好归属的 Slack workspace。多绑定设备的快照覆盖全部已绑
   * team, 桌面端按 teamId 分组编辑。老 server 不下发(单绑定语境无歧义)。
   */
  teamId?: string | null;
}

/**
 * prefs.set(desktop -> server): 部分更新某目录偏好(undefined 字段不动,
 * null 显式清空 —— 与 server setPrefs / dispatch options 同语义)。
 * server 只做 shape 校验, 不校验值合法性(值来自 desktop 自己的能力清单;
 * 过期值由 desktop 派发侧 defaults 兜底)。
 */
export interface PrefsSetPayload {
  requestId: string;
  workspace: string;
  model?: string | null;
  effort?: string | null;
  agentKind?: string | null;
  permissionMode?: string | null;
  /**
   * (multi-team)写入目标 team。缺省/null = 设备唯一绑定(多绑定时 server
   * 不猜测, 忽略写入并在应答快照中原样回放现状)。老 server 不查本字段。
   */
  teamId?: string | null;
}

/**
 * prefs.state(server -> desktop): 绑定用户的全量目录偏好快照。
 * replyTo 回显 get/set 的 requestId; 主动推送(/model 卡写入后)为 null。
 * 字段联动(parse 强制): bound=false 时 prefs 恒空数组(未绑定无偏好可言)。
 */
export interface PrefsStatePayload {
  replyTo: string | null;
  bound: boolean;
  prefs: WorkspacePrefsEntry[];
}

// ── Provider-neutral preferences (append-only v1) ──────────────────────────

/** Provider preference selector; exactly one of bindingId/scopeId is non-null. */
export interface ProviderPrefsSelector {
  provider: HookProvider;
  bindingId: string | null;
  scopeId: string | null;
}

export interface ProviderPrefsGetPayload extends ProviderPrefsSelector {
  requestId: string;
}

export interface ProviderPrefsSetPayload extends ProviderPrefsSelector {
  requestId: string;
  workspace: string;
  model?: string | null;
  effort?: string | null;
  agentKind?: string | null;
  permissionMode?: string | null;
}

/** Provider-neutral preference row (intentionally has no Slack teamId field). */
export interface ProviderWorkspacePrefsEntry {
  workspace: string;
  model: string | null;
  effort: string | null;
  agentKind: string | null;
  permissionMode: string | null;
}

export interface ProviderPrefsStatePayload extends ProviderPrefsSelector {
  replyTo: string | null;
  bound: boolean;
  prefs: ProviderWorkspacePrefsEntry[];
}

// ── Provider-neutral behavior (Telegram, append-only v1) ───────────────────
// 见文件头第 19 条。

/**
 * Providers this frame family currently understands. Deliberately its own
 * append-only list rather than reusing HookProvider: the field shapes below
 * (emoji reactions, reply-quote depth, a chat-id-keyed mention allowlist) are
 * Telegram-specific, not provider-neutral placeholders — adding Slack or X
 * here later requires a deliberate look at whether these exact fields still
 * make sense for that provider, not just a permissive type-level allowance.
 */
export const PROVIDER_BEHAVIOR_PROVIDERS = Object.freeze(['telegram'] as const);
export type ProviderBehaviorProvider = (typeof PROVIDER_BEHAVIOR_PROVIDERS)[number];

/** Emoji reaction verbosity on Telegram messages the bot sees/sends. */
export const TELEGRAM_EMOJI_REACTIONS = Object.freeze(['off', 'minimal', 'expressive'] as const);
export type TelegramEmojiReactions = (typeof TELEGRAM_EMOJI_REACTIONS)[number];

/** Whether a DM reply quotes the message it answers. */
export const TELEGRAM_REPLY_QUOTE_DM = Object.freeze(['off', 'first'] as const);
export type TelegramReplyQuoteDm = (typeof TELEGRAM_REPLY_QUOTE_DM)[number];

/** Whether a group reply quotes the message(s) it answers. */
export const TELEGRAM_REPLY_QUOTE_GROUP = Object.freeze(['off', 'first', 'all'] as const);
export type TelegramReplyQuoteGroup = (typeof TELEGRAM_REPLY_QUOTE_GROUP)[number];

/**
 * The only per-chat activation override this protocol carries: the bot
 * responds in that chat without requiring an @mention. The default behavior
 * ('mention' required) is expressed by the chat's *absence* from the map —
 * there is no 'mention' literal to write, only this one to set or clear.
 */
export const TELEGRAM_GROUP_ACTIVATION_ALWAYS = 'always';
export type TelegramGroupActivationOverride = typeof TELEGRAM_GROUP_ACTIVATION_ALWAYS;

/** The three global Telegram behavior switches, always present together. */
export interface TelegramBehaviorFields {
  emojiReactions: TelegramEmojiReactions;
  replyQuoteDm: TelegramReplyQuoteDm;
  replyQuoteGroup: TelegramReplyQuoteGroup;
}

/**
 * Baseline behavior for a binding that has never been configured, and the
 * value provider.behavior.state must report while bound=false (parse
 * enforced — see ProviderBehaviorStatePayload). Matches the personal-build
 * defaults (the shipped Telegram bot behavior before any override): emoji
 * reactions default to 'minimal', DM reply-quoting defaults off, and group
 * reply-quoting defaults to quoting the first message of a burst.
 */
export const DEFAULT_TELEGRAM_BEHAVIOR: Readonly<TelegramBehaviorFields> = Object.freeze({
  emojiReactions: 'minimal',
  replyQuoteDm: 'off',
  replyQuoteGroup: 'first',
});

/**
 * Selector for provider.behavior.* frames. Deliberately narrower than
 * ProviderPrefsSelector (which allows a scope-only selector before a binding
 * exists): every field here — the global switches and the per-chat allowlist
 * — is meaningless without a concrete bound principal (the allowlist's keys
 * are chats *that principal's bot* has seen), so there is nothing to
 * configure pre-binding. Requiring bindingId (not bindingId | scopeId) keeps
 * the owner boundary explicit: whoever holds the bindingId is the only party
 * allowed to read or write it.
 */
export interface ProviderBehaviorSelector {
  provider: ProviderBehaviorProvider;
  bindingId: string;
}

export interface ProviderBehaviorGetPayload extends ProviderBehaviorSelector {
  requestId: string;
}

/**
 * A single chat's activation-allowlist patch. `value: 'always'` adds the
 * override; `value: null` clears a previously-set override, falling back to
 * the default (mention required). Only one chat per set frame — batching is
 * just repeated set calls, which keeps each mutation independently
 * observable via the resulting provider.behavior.state.
 */
export interface ProviderBehaviorGroupActivationPatch {
  chatId: string;
  value: TelegramGroupActivationOverride | null;
}

/**
 * provider.behavior.set(desktop -> server): patch one bound Telegram
 * principal's behavior. Two independent, freely combinable patch axes:
 *   - the three global fields, each optional and each `enum | null`:
 *       - undefined = untouched (field omitted from the frame entirely);
 *       - an enum literal = set an **explicit override** to that value —
 *         written and persisted even when it happens to equal the current
 *         version default. This matters: a user who explicitly chose
 *         'minimal' must keep seeing 'minimal' even if a later protocol
 *         revision changes DEFAULT_TELEGRAM_BEHAVIOR.emojiReactions to
 *         something else. Explicit intent must survive a default-value
 *         change; only the user (or a future explicit clear) may remove it;
 *       - `null` = **clear** the override, falling back to whatever
 *         DEFAULT_TELEGRAM_BEHAVIOR carries for that field at resolve time.
 *     This is the same three-way shape as ProviderBehaviorGroupActivationPatch
 *     below (undefined/value/null), just applied to enum fields instead of
 *     a chat-id map entry.
 *   - groupActivation: one chat's allowlist patch or clear (see above).
 * parse rejects a frame with neither axis present — unlike prefs.set, a
 * silent no-op here would give the user no observable feedback that nothing
 * changed, so intent must be explicit. Note `null` on a global field still
 * counts as "an actual patch" for that at-least-one-patch requirement: it
 * is a real, observable clear action, not an omission.
 */
export interface ProviderBehaviorSetPayload extends ProviderBehaviorSelector {
  requestId: string;
  emojiReactions?: TelegramEmojiReactions | null;
  replyQuoteDm?: TelegramReplyQuoteDm | null;
  replyQuoteGroup?: TelegramReplyQuoteGroup | null;
  groupActivation?: ProviderBehaviorGroupActivationPatch;
}

/**
 * provider.behavior.state(server -> desktop): full effective snapshot for one
 * bound Telegram principal — reply to get/set (replyTo echoes requestId) or
 * an unsolicited push after some other client mutates it (replyTo null).
 * The three behavior fields are the *resolved* values (never a raw patch).
 * groupActivation lists only chats that deviate from the default — chats the
 * user never touched are implicitly 'mention' and are not enumerated. The
 * enclosing frame remains bounded by HOOK_MAX_FRAME_CHARS; the map itself has
 * no lower entry cap because every valid set mutation must remain representable
 * in a later authoritative state snapshot.
 * Field linkage (parse enforced): bound=false collapses the whole snapshot to
 * DEFAULT_TELEGRAM_BEHAVIOR and an empty groupActivation — there is no
 * principal to hold per-chat overrides for an unbound selector, so a stale
 * configured value cannot survive past the binding that set it.
 */
export interface ProviderBehaviorStatePayload
  extends ProviderBehaviorSelector, TelegramBehaviorFields {
  replyTo: string | null;
  bound: boolean;
  groupActivation: Record<string, TelegramGroupActivationOverride>;
}

// ── 阶段 12(v2): Slack 网关工具 ────────────────────────────────────────────

/**
 * welcome.features 能力标识: server 支持 tool.request / tool.response 帧族
 * (Slack 网关工具)。desktop 侧发 tool.request 前先查本标识, 缺席直接短路
 * 为 SERVER_TOO_OLD, 不打空炮。
 */
export const HOOK_FEATURE_SLACK_TOOLS = 'slack-tools';

/**
 * 双向能力标识: 多 workspace 绑定(见文件头第 13 条)。desktop 在
 * hello.features 声明会消费 bind.state / 按 team 定位的帧; server 在
 * welcome.features 声明支持。任一侧缺席回落单绑定行为。
 */
export const HOOK_FEATURE_MULTI_TEAM = 'multi-team';

/** Both peers must advertise this before using provider.bind.* frames. */
export const HOOK_FEATURE_PROVIDER_BIND = 'provider-bind-v1';

/** Both peers must advertise this before using provider.prefs.* frames. */
export const HOOK_FEATURE_PROVIDER_PREFS = 'provider-prefs-v1';

/** Both peers must advertise this before using provider.behavior.* frames. */
export const HOOK_FEATURE_PROVIDER_BEHAVIOR = 'provider-behavior-v1';

/** Both peers must advertise this before query.kind=sessions is used. */
export const HOOK_FEATURE_SESSION_PICKER = 'session-picker-v1';

/** Both peers support immediate blank-task creation for provider `/new`. */
export const HOOK_FEATURE_SESSION_NEW = 'session-new-v1';

/** Server capability announcing that its provider registry enables Telegram. */
export const HOOK_FEATURE_PROVIDER_TELEGRAM = 'provider:telegram';

/** Server capability announcing that its provider registry enables X (Twitter). */
export const HOOK_FEATURE_PROVIDER_X = 'provider:x';

/**
 * server 支持 hello.lifecycleAnnouncement 与 lifecycle.preference,可由
 * desktop 设置页即时控制该设备的 Slack Bot 上下线私信。
 */
export const HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT = 'lifecycle-announcement-v1';

/** lifecycle.preference(desktop -> server): 即时更新本设备的通知偏好。 */
export interface LifecyclePreferencePayload {
  enabled: boolean;
}

/**
 * welcome.features 能力标识: server 支持 turn.reopen(见文件头第 18 条)——
 * 能把一条已收口消息重新挂到续跑轮的新 requestId 上。desktop 仅在本标识出现
 * 时才登记续跑记账并发帧; 缺席则维持旧行为(渠道消息停在失败上)。
 */
export const HOOK_FEATURE_TURN_REOPEN = 'turn-reopen-v1';

/**
 * 双向能力标识：server 会在收到普通 turn.end 后回 turn.delivery，并以
 * accepted 明确接管重试责任。续跑轮仍遵循 turn-reopen 的“断连即终局”，
 * 不进入本回执与重放链路。
 */
export const HOOK_FEATURE_TURN_DELIVERY = 'turn-delivery-v1';

// ── 阶段 20: 消息操作动词(msg.op) —— 内容面上收客户端 ─────────────────────────

/**
 * 双向能力标识: 双方都宣告后, desktop 用 msg.op 直接驱动渠道消息形态,
 * server 退为**哑执行器**(只做 lane 授权、全局限速与 API 调用, 不解释内容)。
 *
 * 为什么要这条轴: 现有 turn.progress / turn.end 是按「turn 阶段」切的 ——
 * 客户端产文本快照、服务端决定它长什么样(分块、发还是编辑、卡片形态、
 * 表情、媒体组)。于是任何呈现改进都要协议 + 服务端 + 客户端三仓联发。
 * 正确的轴是**内容面(客户端) vs 投递面(服务端)**: 消息形态由客户端全权决定,
 * 服务端只保留多租户授权、跨租户共享 token 的限速预算、终稿必达与离线自治。
 *
 * 兼容: 缺席本标识时 desktop 继续走 turn.progress / turn.end 旧路径, 服务端
 * 保留旧渲染栈, 老客户端逐字节无感知。**仅 telegram provider 先行**——
 * Slack / X 的渲染路径不接入本动词集(它们的形态契约由 Dash 重构后的实现持有,
 * 不在本轴的搬迁范围)。
 */
export const HOOK_FEATURE_MESSAGE_OPS = 'msg-op-v1';

/** msg.op 的作用域: 服务端据此校验该设备是否有权操作这条 lane。 */
export interface MessageOpScope {
  /**
   * 目标渠道会话(与 task.dispatch 的 externalKey 同一命名空间)。
   *
   * **这是本动词集唯一的授权锚点, 也是唯一的寻址依据。** 服务端必须由它反查
   * 自己那份 lane 记录, 从记录里取实际的 chat / topic —— 不接受客户端直接指定
   * 目标聊天。否则一台被攻陷或有 bug 的桌面就能往任意 chat_id 发消息, 越过它
   * 自己 lane 的边界。lane 不存在或不属于该设备的绑定 principal 时一律拒绝执行。
   */
  externalKey: string;
}

/**
 * 一次消息操作的具体动作。
 *
 * 设计约束(与「哑执行器」互为定义):
 *   - 形态参数已经是**最终形态**: 文本是渲染好的正文, 分块由客户端切好,
 *     服务端不再分块、不再套模板、不再补文案;
 *   - 每个动作自带 `opId`(客户端生成, 全局唯一)。服务端按 opId 幂等:
 *     重复收到同一 opId 一律返回首次结果, 不重复调用 Bot API —— 这是断连
 *     重发下不产生重复消息的**唯一**依据(Telegram 没有发送端幂等键)。
 *
 * 服务端不变量(两条, 缺一即安全漏洞):
 *   1. **寻址**: 目标 chat / topic 只能由 `scope.externalKey` 反查服务端自己
 *      的 lane 记录得到, 不读客户端任何输入(见 MessageOpScope)。
 *   2. **归属**: `edit` / `delete` / `react` 引用的 messageId 必须经服务端核验
 *      确属该 lane —— 它只能是本 lane 先前 `send` 的产物, 或该 lane 收到的
 *      入站消息。少了这一条, 这套动词就是一个能编辑、删除、标记**任意**消息的
 *      后门: messageId 在 Telegram 里只是个自增序号, 猜得到。
 */
export type MessageOpAction =
  | {
      kind: 'send';
      /** 已渲染的最终正文(客户端已分块; 服务端不再切)。 */
      text: string;
      /** 回复锚点: 目标渠道的原生 message id。 */
      replyToMessageId?: string | null;
      /** 客户端决定的呈现档位; 服务端按能力降级但不改内容。 */
      tier?: 'rich' | 'html' | 'plain';
      silent?: boolean;
      /** 该消息挂的按钮(语义与形态都由客户端定, 服务端原样下发)。 */
      buttons?: MessageOpButton[][];
    }
  | {
      kind: 'edit';
      messageId: string;
      text: string;
      tier?: 'rich' | 'html' | 'plain';
      buttons?: MessageOpButton[][];
    }
  | { kind: 'delete'; messageId: string }
  | {
      kind: 'react';
      targetMessageId: string;
      /** 空串 = 撤销该消息上本 bot 的表情。 */
      emoji: string;
      big?: boolean;
    }
  | { kind: 'typing' }
  | {
      kind: 'media';
      items: MessageOpMediaItem[];
      /** 2 张以上连续图片是否合成原生相册(客户端决定)。 */
      album?: boolean;
      replyToMessageId?: string | null;
    };

export interface MessageOpButton {
  /** 客户端生成的回调 token; 服务端只做透传与一次性消费, 不解释语义。 */
  token: string;
  label: string;
}

export interface MessageOpMediaItem {
  name: string;
  mimeType: string;
  dataBase64: string;
  caption?: string;
}

/**
 * msg.op(desktop -> server): 驱动一次渠道消息操作。
 *
 * 服务端职责边界(哑执行器):
 *   1. 校验 scope.externalKey 落在该设备的绑定内(多租户授权, 不可下放客户端);
 *   2. 排进该 bot token 的全局限速队列, 尊重完整 retry_after(跨租户共享预算,
 *      必须中心化);
 *   3. 调用 Bot API, 按 opId 幂等;
 *   4. 回 msg.op.result 带上渠道 message id。
 * 除此之外**不解释内容**: 不分块、不套文案、不判断该发还是该编辑。
 */
export interface MessageOpPayload {
  /** 客户端生成的幂等键, 全局唯一; 重发同一 opId 不产生第二条消息。 */
  opId: string;
  /** 归属的 turn(用于日志关联与 lane 授权); 非 turn 语境可省略。 */
  requestId?: string;
  scope: MessageOpScope;
  action: MessageOpAction;
}

/**
 * msg.op.result(server -> desktop): 一次消息操作的回执。
 *
 * `messageId` 是客户端做后续 edit / delete / react 的**唯一**依据 —— 没有它,
 * 整个动词集只能发不能改。失败时 `error` 说明原因; `retryAfterMs` 非空表示
 * 服务端限速队列建议的等待(客户端据此排后续 op, 不自行加固定上限)。
 */
export interface MessageOpResultPayload {
  opId: string;
  ok: boolean;
  /** send / media 成功时渠道返回的 message id(media 相册返回首条)。 */
  messageId?: string | null;
  /** 相册等一次产出多条时的完整 id 列表。 */
  messageIds?: string[];
  error?: string | null;
  retryAfterMs?: number | null;
}

/**
 * 内置「对话」伪工作目录的保留别名。desktop 恒把它放进 hello / query 的
 * workspaces 清单首位(绑定到它的任务以无项目目录的对话模式运行), 真实
 * 目录别名不许撞名(desktop 侧校验)。server 据此识别伪目录: 清单里只剩
 * 本别名(用户没配任何真实目录)时不走「单目录自动绑」捷径, 仍发选择卡
 * 让用户显式确认, 并提示去桌面端配置真实目录。
 */
export const HOOK_CHAT_WORKSPACE_ALIAS = 'chat';

/**
 * tool.request(desktop -> server): 调用 server 侧 Slack 网关工具。
 * tool 为开放集合(当前约定 'status' / 'listTools' / 'callTool'), server
 * 不认识的值回 UNKNOWN_TOOL 错误而非丢帧 —— 网关工具演进不需要协议升级。
 */
export interface ToolRequestPayload {
  /** desktop 生成的关联 id; tool.response.replyTo 回显配对。 */
  requestId: string;
  /** 网关工具名(开放集合)。 */
  tool: string;
  /** 工具参数(如 callTool 的 { name, arguments }); 省略 = 无参。 */
  args?: Record<string, unknown>;
  /**
   * (multi-team)以哪个 workspace 的绑定身份执行。缺省/null = 设备唯一
   * 绑定; 多绑定设备缺省时 server 拒绝猜测, 回结构化错误 AMBIGUOUS_TEAM
   * —— 以错误身份向错误 workspace 发消息是本帧族最重的串台风险(规则 9)。
   */
  teamId?: string | null;
}

/**
 * 网关工具的结构化错误。code 是机器可读错误码(如 NOT_BOUND / NO_USER_TOKEN /
 * UNKNOWN_TOOL / TOKEN_EXPIRED / RATE_LIMITED), desktop 按 code 分支提示,
 * message 仅人类可读补充 —— 两端都不得解析 message 做逻辑(规则 9)。
 */
export interface ToolErrorShape {
  code: string;
  message: string;
}

/**
 * tool.response(server -> desktop): tool.request 的应答。
 * 字段联动(parse 强制): ok=false 时 error 必须为非空 {code, message};
 * ok=true 时 error 必须缺席或 null(result 形状由具体工具约定, 协议不限)。
 */
export interface ToolResponsePayload {
  /** 回显 tool.request.requestId。 */
  replyTo: string;
  ok: boolean;
  /** ok=true 时的结果(任意 JSON; listTools/callTool 透传 MCP 结果语义)。 */
  result?: unknown;
  /** ok=false 时的结构化错误。 */
  error?: ToolErrorShape | null;
}

// ── 阶段 14: 群消息中继(group-relay-v1) ─────────────────────────────────────

/**
 * 双向能力标识: 群消息实时中继。desktop 在 hello.features 声明会消费
 * group.message 帧(本地维护群上下文窗口); server 在 welcome.features 声明
 * 支持。任一侧缺席则 server 不转发, desktop 无群上下文(引用注入不受影响)。
 *
 * 设计边界(2026-07-28 决策): 群聊内容**不得驻留在 server**(内存亦不允许),
 * server 收到群消息后对已声明本能力的成员桌面转发即弃; 滚动窗口、增量游标与
 * 上下文拼装全部在 desktop 本地完成 —— 与 Slack 通道「平台即存储」同构,
 * Telegram 无历史 API, 存储方为用户自己的设备。
 */
export const HOOK_FEATURE_GROUP_RELAY = 'group-relay-v1';

/**
 * group.message 接收方代际标识。双方同时声明后,server 必须按实际扇出目标
 * 填充 recipient,desktop 必须与当前 confirmed binding 精确匹配后才可入窗。
 * 这是独立能力而不是静默改写 group-relay-v1:旧帧没有可信接收方身份,
 * 新 desktop 对缺席本能力的 server 只能安全降级为不落群历史。
 */
export const HOOK_FEATURE_GROUP_RELAY_RECIPIENT = 'group-relay-recipient-v1';

/**
 * group.message 的发送者标识(display name 为主)。
 * id / username 均可选(旧生产端不发时省略, 向后兼容): 新生产端(阶段 19
 * 起, provider.behavior 需要按发送者匹配群白名单以外的场景)可附带平台
 * user id 与 @handle。二者按 Telegram 当前实际契约收紧校验(group.message
 * 本身仍是开放 provider 集合, 但这两个新字段目前只有 Telegram 生产端会填,
 * 形状即按 Telegram 定义; 未来若有其它 provider 要填这两个字段且形状不同,
 * 需要重新评估这里的校验, 而不是放宽成万能字符串):
 *   - id: Telegram 数字 user id 的规范十进制正整数字符串(无前导零,在 Bot API
 *     52-bit 范围内), 见 GROUP_MESSAGE_AUTHOR_ID_PATTERN;
 *   - username: Telegram @handle, 仅 [A-Za-z0-9_]，1~32 位, 见
 *     GROUP_MESSAGE_AUTHOR_USERNAME_PATTERN。
 */
export interface GroupMessageAuthor {
  name: string;
  /** 是否为 bot(含 Cindy 自身出站回复的回流条目)。 */
  isBot?: boolean;
  /** Telegram 数字 user id 的规范十进制正整数字符串(52-bit 范围内); 拿不到时省略。 */
  id?: string;
  /** Telegram @handle(不含 @ 前缀, [A-Za-z0-9_]{1,32}); 拿不到时省略。 */
  username?: string;
}

/** server 针对单个 desktop 扇出 group.message 时的权威接收方绑定。 */
export interface GroupMessageRecipient {
  bindingId: string;
  principalId: string;
}

/**
 * group.message(server -> desktop): 把一条群消息实时转发给该群已知绑定
 * 成员的桌面, fire-and-forget(无 ack, 桌面离线即丢 —— 零驻留的固有代价)。
 * chatId/threadId/messageId 是反查 id: task.dispatch 的引用块与桌面窗口
 * 条目按同一组 id 关联, prompt 缺失上下文时 agent 可按 id 查本地窗口兜底。
 * 一次性凭证(如 Telegram 绑定深链 /start <token>)由 server 过滤, 不转发。
 */
export interface GroupMessagePayload {
  /** IM 平台标识(开放集合, 当前 'telegram')。 */
  provider: string;
  /**
   * 本帧实际路由到的绑定代际；仅在双方协商
   * HOOK_FEATURE_GROUP_RELAY_RECIPIENT 后必填。旧生产端缺省以保持 wire 兼容。
   */
  recipient?: GroupMessageRecipient;
  chatId: string;
  /** forum topic / thread id; null = 主群流。 */
  threadId: string | null;
  messageId: string;
  /** 群显示名; null = 未知。 */
  chatName: string | null;
  author: GroupMessageAuthor;
  /** 正文(生产端截断后 ≤4k 字符; 可为空字符串, 如纯附件消息)。 */
  text: string;
  /** 附件文件名列表(仅名字, 不携带字节; 桌面窗口行内标注用)。 */
  fileNames?: string[];
  /** 消息在 IM 平台的发送时刻(unix ms)。 */
  sentAt: number;
}

// ── 消息联合 ─────────────────────────────────────────────────────────────────

export type HookHelloMessage = HookEnvelope<'hello', HelloPayload>;
export type HookWelcomeMessage = HookEnvelope<'welcome', WelcomePayload>;
export type HookPingMessage = HookEnvelope<'ping', PingPayload>;
export type HookPongMessage = HookEnvelope<'pong', PongPayload>;
export type HookTaskDispatchMessage = HookEnvelope<'task.dispatch', TaskDispatchPayload>;
export type HookTaskAckMessage = HookEnvelope<'task.ack', TaskAckPayload>;
export type HookTurnEndMessage = HookEnvelope<'turn.end', TurnEndPayload>;
export type HookTurnDeliveryMessage = HookEnvelope<'turn.delivery', TurnDeliveryPayload>;
export type HookTurnProgressMessage = HookEnvelope<'turn.progress', TurnProgressPayload>;
export type HookMessageOpMessage = HookEnvelope<'msg.op', MessageOpPayload>;
export type HookMessageOpResultMessage = HookEnvelope<'msg.op.result', MessageOpResultPayload>;
export type HookTurnReopenMessage = HookEnvelope<'turn.reopen', TurnReopenPayload>;
export type HookBindStartMessage = HookEnvelope<'bind.start', BindStartPayload>;
export type HookBindUpdateMessage = HookEnvelope<'bind.update', BindUpdatePayload>;
export type HookBindRevokeMessage = HookEnvelope<'bind.revoke', BindRevokePayload>;
export type HookQueryRequestMessage = HookEnvelope<'query.request', QueryRequestPayload>;
export type HookQueryResponseMessage = HookEnvelope<'query.response', QueryResponsePayload>;
export type HookTaskCancelMessage = HookEnvelope<'task.cancel', TaskCancelPayload>;
export type HookSessionArchiveMessage = HookEnvelope<'session.archive', SessionArchivePayload>;
export type HookInteractionRequestMessage = HookEnvelope<
  'interaction.request',
  InteractionRequestPayload
>;
export type HookInteractionDecisionMessage = HookEnvelope<
  'interaction.decision',
  InteractionDecisionPayload
>;
export type HookInteractionCancelMessage = HookEnvelope<
  'interaction.cancel',
  InteractionCancelPayload
>;
export type HookPrefsGetMessage = HookEnvelope<'prefs.get', PrefsGetPayload>;
export type HookPrefsSetMessage = HookEnvelope<'prefs.set', PrefsSetPayload>;
export type HookPrefsStateMessage = HookEnvelope<'prefs.state', PrefsStatePayload>;
export type HookToolRequestMessage = HookEnvelope<'tool.request', ToolRequestPayload>;
export type HookToolResponseMessage = HookEnvelope<'tool.response', ToolResponsePayload>;
export type HookBindStateMessage = HookEnvelope<'bind.state', BindStatePayload>;
export type HookProviderBindStartMessage = HookEnvelope<
  'provider.bind.start',
  ProviderBindStartPayload
>;
export type HookProviderBindCancelMessage = HookEnvelope<
  'provider.bind.cancel',
  ProviderBindCancelPayload
>;
export type HookProviderBindRevokeMessage = HookEnvelope<
  'provider.bind.revoke',
  ProviderBindRevokePayload
>;
export type HookProviderBindUpdateMessage = HookEnvelope<
  'provider.bind.update',
  ProviderBindUpdatePayload
>;
export type HookProviderBindStateMessage = HookEnvelope<
  'provider.bind.state',
  ProviderBindStatePayload
>;
export type HookProviderPrefsGetMessage = HookEnvelope<
  'provider.prefs.get',
  ProviderPrefsGetPayload
>;
export type HookProviderPrefsSetMessage = HookEnvelope<
  'provider.prefs.set',
  ProviderPrefsSetPayload
>;
export type HookProviderPrefsStateMessage = HookEnvelope<
  'provider.prefs.state',
  ProviderPrefsStatePayload
>;
export type HookGroupMessageMessage = HookEnvelope<'group.message', GroupMessagePayload>;
export type HookLifecyclePreferenceMessage = HookEnvelope<
  'lifecycle.preference',
  LifecyclePreferencePayload
>;
export type HookProviderBehaviorGetMessage = HookEnvelope<
  'provider.behavior.get',
  ProviderBehaviorGetPayload
>;
export type HookProviderBehaviorSetMessage = HookEnvelope<
  'provider.behavior.set',
  ProviderBehaviorSetPayload
>;
export type HookProviderBehaviorStateMessage = HookEnvelope<
  'provider.behavior.state',
  ProviderBehaviorStatePayload
>;

/** 全部合法消息的判别联合(按 `type` 判别)。 */
export type HookMessage =
  | HookHelloMessage
  | HookWelcomeMessage
  | HookPingMessage
  | HookPongMessage
  | HookTaskDispatchMessage
  | HookTaskAckMessage
  | HookTurnEndMessage
  | HookTurnDeliveryMessage
  | HookTurnProgressMessage
  | HookTurnReopenMessage
  | HookBindStartMessage
  | HookBindUpdateMessage
  | HookBindRevokeMessage
  | HookQueryRequestMessage
  | HookQueryResponseMessage
  | HookTaskCancelMessage
  | HookSessionArchiveMessage
  | HookInteractionRequestMessage
  | HookInteractionDecisionMessage
  | HookInteractionCancelMessage
  | HookPrefsGetMessage
  | HookPrefsSetMessage
  | HookPrefsStateMessage
  | HookToolRequestMessage
  | HookToolResponseMessage
  | HookBindStateMessage
  | HookProviderBindStartMessage
  | HookProviderBindCancelMessage
  | HookProviderBindRevokeMessage
  | HookProviderBindUpdateMessage
  | HookProviderBindStateMessage
  | HookProviderPrefsGetMessage
  | HookProviderPrefsSetMessage
  | HookProviderPrefsStateMessage
  | HookGroupMessageMessage
  | HookLifecyclePreferenceMessage
  | HookProviderBehaviorGetMessage
  | HookProviderBehaviorSetMessage
  | HookProviderBehaviorStateMessage
  | HookMessageOpMessage
  | HookMessageOpResultMessage;

/** parseHookMessage 的结果 —— 不抛异常, 坏帧以 error 字符串描述具体原因。 */
export type HookParseResult = { ok: true; message: HookMessage } | { ok: false; error: string };
