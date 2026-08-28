/** `.cindy` 包根目录中的 manifest 文件名。 */
export const GHOST_MANIFEST_FILE = 'ghost.json';

/** 意识文件扩展名。 */
export const CINDY_FILE_EXT = '.cindy';

/** 新建 ghost.json 使用的格式版本；与 Plugin HTTP API envelope 版本独立演进。 */
export const GHOST_MANIFEST_SCHEMA_VERSION = 3 as const;

/** ghost.json 的 description / whenToUse 字符上限。 */
export const GHOST_MANIFEST_SUMMARY_MAX_CHARS = 300;

/** Cindy host locales supported by Plugin manifest resources. */
export const GHOST_LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;
export type GhostLocale = (typeof GHOST_LOCALES)[number];
export type GhostManifestLocales = {
  en: string;
} & Partial<Record<Exclude<GhostLocale, 'en'>, string>>;

/** Maximum size of one locale JSON resource in a `.cindy` package. */
export const GHOST_LOCALE_MAX_BYTES = 64 * 1024;

/**
 * 意识 id 规则:小写字母/数字开头,后续允许小写字母/数字/连字符,总长 1–32。
 * 收紧到这个集合并排除 Windows 设备保留名,因为 id 直接用作安装目录名
 * (userData/brain/<id>),必须在 macOS / Windows 双平台都是安全的文件夹名,
 * 且天然杜绝路径穿越。
 */
const GHOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Windows 设备保留名；带扩展名时仍不能作为文件或目录名。 */
const WINDOWS_RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME_RE.test(name);
}

/**
 * schemaVersion 2 能力名清单，仅用于兼容旧包。
 * 'cindy' = 请 Cindy 本体代办(借主机自带 AI 能力干活;2026-07-11 定案
 * 由 'model' 更名——本质是 Cindy 在干活,与选模型无关;旧名在校验层作
 * 静默别名兼容,已装老包不消失)。
 * 'network' = 意识自带服务:域名白名单
 * 内的 HTTP 经主机代发(沙箱本身保持零直连),凭证锁主机保险库按声明注入。
 * 'notify' = 系统提示(2026-07-14):意识经管子请主机弹一条轻提示(toast),
 * 意识只供纯文本,整块 UI 主机画并带意识身份头(与订阅槽红条同一信任边界);
 * 无阻塞、无按钮、无回执——确认类交互不在此槽(走面板自绘或卡槽③交互卡)。
 * 'fs' = 写文件(2026-07-14):意识经管子请主机代写文件(创建/修改)。三档
 * 目的地:自己的私有数据目录(userData/ghost-fs/<id>,免确认)、当前会话
 * workdir(跟随会话 permission 模式:免批模式直写、逐条模式弹确认卡、
 * plan/只读拒)、save 票据目录(主 agent 过户,复用 saveDeposit 预算)。
 * 字节永远由主机落盘,沙箱本身仍无 fs——本槽是"申请主机代写"的资格,
 * 不是文件系统访问权。
 * 'main-view' = 应用级插件主视图：宿主只挂载已批准 manifest 声明的包内
 * HTML 入口。它与会话内 panel 独立授权，本身不附赠网络、文件或
 * 凭证能力。
 * 'session-context' = 会话上下文(2026-07-23):agent 派活(tool-call)时,主机把
 * 当次会话的可信 {session_id, workdir, workdir_is_local} 注入 args.session_context。
 * 只注入宿主认证过的事实,插件与 agent 自报的同名字段一律被剥除;远程工作区
 * (workdir 不在本机)时 workdir_is_local=false,插件不得把它当本机路径用。
 * 'pick' = 目录选择(2026-07-23):插件经管子申请主机弹**系统级**选文件夹窗口,
 * 用户亲手选中即授权(与浏览器文件选择同一哲学:决定权在用户的点击上)。
 * 返回票据(dir_deposit,同 ghost_call dir 通道);声明了 node 槽的插件额外
 * 拿到绝对路径(Node 侧本就有用户级本机权限,路径保密无意义,可信才是重点)。
 * 'preview' = 面板预览(2026-07-23):插件经管子申请在右侧栏内置浏览器里打开
 * 一个网址标签页。网址范围装入时在 preview.hosts 白名单里定死(同 network
 * 域名白名单语法),运行期主机逐次校验,范围外一律拒——防钓鱼是结构性的。
 * 'skill' = 捆绑 Agent Skills(2026-07-25):插件随包携带 SKILL.md 技能目录,
 * 装入且启用后由主机链接进共享技能根 ~/.agents/skills/<id>--<name>(win32 用
 * junction),Claude Code 与 Codex 都能发现。信任面与其它槽完全不同量级:技能
 * 指令由主 Agent 以**用户全部权限**执行、对所有项目与会话生效、不受插件沙箱
 * 约束,也不随"某工作目录停用本插件"而隐藏——仅全局停用/卸载才撤链。因此
 * manifest 全声明式(items 的 name/description 必须与 SKILL.md frontmatter 逐字
 * 一致,打包与装入双侧强制),插件详情逐条列出并置于能力清单最上部。
 * 'workspace' = 工作区会话(2026-07-25):插件请主机在指定本机项目目录下确保
 * 存在一个会话入口并显示在侧边栏——目录下已有 active 会话即复用,没有才创建
 * 空 draft 会话(不拉起 agent 进程)。目录授权两条路:系统选文件夹窗口亲选
 * 即授权(pick 模式,路径不回沙箱),或 tool-call 语境下带在途 callId + 绝对
 * 路径(目录在该会话 workdir 内自动放行,workdir 外弹确认卡)。远程工作区
 * v1 一律拒(fail closed)。
 * 'ios-simulator' = Host 托管的内嵌 iOS 模拟器入口:插件只能读取当前任务的
 * 脱敏状态并请求 Host 打开控制面板。视频帧、输入、设备标识、Native Helper、
 * 生命周期与恢复均不跨插件边界,仍由 Cindy Host 独占管理。
 *
 * 以下名称只用于 schemaVersion 2 的兼容校验。schemaVersion 3 使用顶层直接
 * 字段声明能力，不再提供 slots。未知 v2 slot 会被保留供兼容诊断，但不会
 * 被猜测成某个 Host 能力，也不会阻止安装。
 */
export const LEGACY_GHOST_SLOTS = [
  'subscribe',
  'tool',
  'card',
  'panel',
  'main-view',
  'cindy',
  'agent',
  'node',
  'network',
  'notify',
  'badge',
  'confirm',
  'fs',
  'library',
  'session-context',
  'pick',
  'preview',
  'skill',
  'workspace',
  'ios-simulator',
] as const;
type LegacyGhostSlot = string;

/** v2 slot 只约束可安全展示/传输的形状。 */
const GHOST_SLOT_NAME_RE = /^[a-z][a-z0-9._:-]{0,127}$/;

/**
 * 电子脑启动模式(2026-07-12):
 * - 'on-demand'(缺省):被需要才拉起(agent 派活 / 面板 /wake / 重载);
 * - 'resident':唤醒即启动——enable 时拉起,应用启动时对"已唤醒"者拉起。
 * 两种模式下沉睡 / 抽离 / 更新换代一律先熄灯,规则不变;resident 会在装入
 * 确认框多一行如实告知(常驻 = 用户要背一个后台进程,必须知情)。
 */
export const GHOST_LAUNCH_MODES = ['on-demand', 'resident'] as const;
export type GhostLaunchMode = (typeof GHOST_LAUNCH_MODES)[number];

/**
 * 面板显示形态(相对主聊天窗)。left / right = 顶层布局树停靠 pane;
 * 'tab' = 不进布局树,作为右侧栏(right-tabs)里的每会话单例页签
 * (2026-07-24 定案)。top / bottom 需要嵌套上下分割(树操作/拖缝/卸载
 * 查找全链路),排期中——校验层先收词并明确拒绝,不静默降级(规则 9)。
 */
export const GHOST_PANEL_POSITIONS = ['left', 'right', 'tab'] as const;
export type GhostPanelPosition = (typeof GHOST_PANEL_POSITIONS)[number];

/** 面板声明(卡槽之一,一段意识至多一块)。 */
export interface GhostPanelDecl {
  /** 面板标准头(PanelChrome)标题;缺省用意识 name。 */
  title?: string;
  /** 显示形态:left / right 停靠,或 'tab' 右侧栏页签;缺省 = right(2026-07-12 定案)。 */
  position?: GhostPanelPosition;
  /** 面板界面入口(安装目录内相对路径,意识自绘,由主机面板容器渲染)。 */
  html: string;
  /** 面板最小宽度(px),布局引擎拖缝时的下限。仅停靠形态有效,'tab' 时禁用。 */
  minWidth?: number;
  /** 装入布局时的初始宽度占比(与 layoutTree 的 fraction 同语义)。仅停靠形态有效,'tab' 时禁用。 */
  defaultFraction?: number;
}

/** 应用级插件主视图可用的 Cindy 系统线性图标。枚举值与图标名保持一致。 */
export const GHOST_MAIN_VIEW_ICONS = [
  'puzzle',
  'globe',
  'code',
  'folder',
  'database',
  'chart-column',
  'image',
  'message-circle',
  'calendar-days',
] as const;
export type GhostMainViewIcon = (typeof GHOST_MAIN_VIEW_ICONS)[number];

/**
 * 插件一级主视图声明。它是应用级导航能力，与会话内 panel 独立授权；
 * Host 只会挂载这里声明且经过批准的包内 HTML 入口。
 */
export interface GhostMainViewDecl {
  /** 侧边栏与主视图标题；缺省回退插件 name。 */
  title?: string;
  /** 侧边栏使用的 Cindy 系统线性图标；缺省为 puzzle。 */
  icon?: GhostMainViewIcon;
  /** 主视图界面入口（安装目录内安全相对路径）。 */
  html: string;
}

/**
 * 芯片型意识注册给 agent 的工具声明(卡槽②)。
 * 声明式而非运行时动态注册(规则 9:确定性;且会话中途增删工具会破坏
 * prompt 缓存前缀,规则 10)——主机在会话建立时按"已装且唤醒"的意识
 * 快照注入工具集。
 */
export interface GhostToolDecl {
  /** 工具名:小写字母开头,允许小写/数字/下划线/连字符,≤64。 */
  name: string;
  /** 给模型看的工具说明。 */
  description: string;
  /** JSON Schema(object)形态的参数声明;可省略(无参工具)。 */
  parameters?: Record<string, unknown>;
}

/**
 * Card 槽能力详单。card 槽默认仅允许渲染静态/交互卡片(含按钮动作);
 * externalLinks: true 额外允许卡片声明 data-ghost-link 外链,点击经宿主
 * 确认框后 openExternal——这是独立加档权限,插件详情中单列。
 */
export interface GhostCardNeeds {
  externalLinks?: boolean;
}

/**
 * Agent 新回合能力详单。
 *
 * 声明 `agent` 默认只允许消费宿主在真实用户点击插件卡片时签发的
 * 一次性通行票；可选加档由 Desktop 如实展示，并由 Host 在运行时守门。
 */
export interface GhostAgentNeeds {
  background?: boolean;
  errand?: boolean;
  schedule?: boolean;
}

/** 插件随包本地 Node 工作进程使用的 stdio 协议。 */
export const GHOST_NODE_PROTOCOLS = ['json-rpc-stdio', 'mcp-stdio'] as const;
export type GhostNodeProtocol = (typeof GHOST_NODE_PROTOCOLS)[number];

/** Node 工作进程生命周期;常驻档会在插件详情中单列高风险权限。 */
export const GHOST_NODE_LIFECYCLES = ['on-demand', 'resident'] as const;
export type GhostNodeLifecycle = (typeof GHOST_NODE_LIFECYCLES)[number];

/** 单插件最多可声明的 Node 凭证绑定数。 */
export const GHOST_NODE_MAX_SECRET_BINDINGS = 4;
/** 单条 Node 凭证最多可绑定的 JSON-RPC 方法数。 */
export const GHOST_NODE_MAX_SECRET_METHODS = 16;
const GHOST_NODE_MCP_RESERVED_METHODS = new Set(['initialize', 'notifications/initialized']);

/** MCP 握手由宿主发起，插件业务请求与凭证绑定均不得占用这些方法。 */
export function isGhostNodeMcpReservedMethod(method: string): boolean {
  return GHOST_NODE_MCP_RESERVED_METHODS.has(method);
}

/**
 * 主机保险库 → 随包 Node Worker 的按请求凭证绑定。
 *
 * 值由 settingsHtml 经 `/secrets` 一次性写入 safeStorage；浏览器沙箱
 * main.js 不能直接从保险库读取明文。宿主仅在 method 与 entry 同时命中
 * 本声明时，把值放进发往 Worker 的保留字段 `cindy.secrets[key]`；
 * Worker 获得明文后仍可能主动回传或泄露。未声明 entry 时只允许主入口。
 */
export interface GhostNodeSecretBinding {
  /** 凭证键(插件内唯一):小写字母开头,允许小写/数字/下划线,1–32。 */
  key: string;
  /** 给用户看的名称(插件详情与设置状态使用)。 */
  label: string;
  /** 允许注入的 JSON-RPC 方法白名单(1–16 条)。 */
  methods: string[];
  /** 可选目标入口；缺省只绑定 node.entry 主入口。 */
  entry?: string;
  /** 可选输入提示。 */
  hint?: string;
  /** 可选凭证申请页(仅 https；设置页外链须逐字命中)。 */
  url?: string;
}

/**
 * 随插件安装的本地 Node 工作进程声明。
 *
 * 只允许指定包内入口和固定协议,不接受 command / args / shell / env,避免把
 * ghost.json 变成任意命令启动器。Node 进程拥有当前系统用户级本机权限,主机
 * 只保证它不能绕过 main.js 调 Cindy API,并不能把它变成系统级沙箱。
 */
export interface GhostNodeNeeds {
  entry: string;
  protocol: GhostNodeProtocol;
  lifecycle?: GhostNodeLifecycle;
  idleTimeoutSeconds?: number;
  /**
   * 额外工作进程入口(2026-07-23,能力 5 窄版):仍只能是包内申报过的 JS 文件,
   * node-request 带 entry 字段指名调用;每个入口一个独立进程,协议/生命周期/
   * 空闲策略与主入口共用同一份声明。不是任意命令执行——包外文件、未申报
   * 入口一律拒。
   */
  entries?: string[];
  /**
   * 宿主代启子进程开关(2026-07-23,缺口 1):worker 可经引导层窄接口
   * (spawnEntry)请求宿主再启动一个**已申报入口**(entry / entries 之内)的
   * 原样 stdio 子进程,并把子进程 stdio 字节中继回 worker。给 Maker Runtime
   * 这类"自己 spawn process.execPath"的库改道用——正式包关 RunAsNode,
   * 那条路生出来的不是 Node。默认关;开了会在插件详情中单列一行。
   * 权限本质不变:仍只能跑包内申报过的 JS,node 槽本就是用户级执行权。
   */
  childSpawn?: boolean;
  /**
   * 由主机 safeStorage 持久化、按声明的方法临时注入 Worker 的凭证。
   * 这是 Node 高风险能力的一部分，插件详情会逐条披露。
   */
  secretBindings?: GhostNodeSecretBinding[];
}

/** node 额外入口条数上限(1 主 + 4 额外 = 每插件至多 5 个工作进程)。 */
export const GHOST_NODE_MAX_EXTRA_ENTRIES = 4;

/** cindy 槽·图像类可申请的动作(主机代办菜单的"图像"类目)。 */
export const GHOST_MODEL_IMAGE_ACTIONS = ['generate', 'edit'] as const;
export type GhostModelImageAction = (typeof GHOST_MODEL_IMAGE_ACTIONS)[number];

/** cindy 槽·视频类可申请的动作(generate=文生视频,edit=参考图生视频)。 */
export const GHOST_MODEL_VIDEO_ACTIONS = ['generate', 'edit'] as const;
export type GhostModelVideoAction = (typeof GHOST_MODEL_VIDEO_ACTIONS)[number];

/** cindy 槽·媒体类可申请的动作(deposit=寄存自己手里的媒体字节入总仓)。 */
export const GHOST_CINDY_MEDIA_ACTIONS = ['deposit'] as const;
export type GhostCindyMediaAction = (typeof GHOST_CINDY_MEDIA_ACTIONS)[number];

/**
 * cindy 槽·文本类可申请的动作(2026-07-31 开闸)。
 *
 * `oneshot` = 快问快答:意识递一段文字,主机经**轻量任务模型链**(与会话
 * 起标题、任务一句话总结同一条通道)直答一次并把文字原样递回。不拉起
 * agent、无工具、无用户权限、不进任何会话——只花模型额度,拿不到任何
 * 宿主能力。
 */
export const GHOST_CINDY_TEXT_ACTIONS = ['oneshot'] as const;
export type GhostCindyTextAction = (typeof GHOST_CINDY_TEXT_ACTIONS)[number];

/**
 * cindy 槽·向量类可申请的动作(2026-08-04 开闸)。
 *
 * `text` = 文本转向量:意识递一批文字,主机经统一 embedding 通道返回等长的
 * 向量数组。只生成、不存储;向量原样递回意识自己保管。与 text.oneshot
 * 分成两档:两者花不同的钱(轻量任务模型链 vs embedding 模型),合成一档
 * 就没法只授权其中一样。
 */
export const GHOST_CINDY_EMBED_ACTIONS = ['text'] as const;
export type GhostCindyEmbedAction = (typeof GHOST_CINDY_EMBED_ACTIONS)[number];

/** cindy 槽·搜索类可申请的动作(web=Cindy 托管的公网搜索)。 */
export const GHOST_CINDY_SEARCH_ACTIONS = ['web'] as const;
export type GhostCindySearchAction = (typeof GHOST_CINDY_SEARCH_ACTIONS)[number];

/**
 * cindy 槽能力详单(卡槽⑤配套,原名模型槽,2026-07-11 设计定案):声明"这个意识被允许
 * 向主机点哪几类代办"——只有类目与动作,**不含任何具体模型/供应商信息**
 * (选型权在主机的解析表:调用时显式点名 > 意识专属覆盖 > 用户能力偏好 >
 * 出厂默认;意识只表达意图,永不腐烂)。插件详情与代办资格审共同消费。
 */
export interface GhostCindyNeeds {
  /** 图像类:generate=出图,edit=改图(改图仅限本意识名下媒体)。 */
  image?: GhostModelImageAction[];
  /** 视频类:generate=文生视频,edit=参考图生视频(源图仅限本意识名下媒体,1–2 张首/尾帧)。 */
  video?: GhostModelVideoAction[];
  /** 媒体类:deposit=寄存自己手里的媒体字节入总仓(换指纹,兼授权 release_media)。 */
  media?: GhostCindyMediaAction[];
  /** 文本类:oneshot=快问快答(轻量任务模型链直答一次,无 agent 无工具)。 */
  text?: GhostCindyTextAction[];
  /** 向量类:text=文本转向量(只生成不存储,向量原样递回意识自己保管)。 */
  embed?: GhostCindyEmbedAction[];
  /** 搜索类:web=Cindy 托管的公网搜索(主机固定路由,插件不经手网关凭证)。 */
  search?: GhostCindySearchAction[];
  /**
   * 快问快答偏好模型(目录模型 id,如 "codex/gpt-5.5";须与 text 含 "oneshot"
   * 成对)。主机能从当前供应商目录解析到(且用户未停用)就用它,解析不到按
   * 未声明处理;用户在详情页的钉档永远优先于本声明。注意:旧宿主会把含本
   * 字段的身份卡**整份拒装**(cindy 详单未知类目硬拒)——声明前确认目标
   * 用户群的主机版本。
   */
  oneshotModel?: string;
}

/**
 * 订阅槽 did- 旁听主题(卡槽①,2026-07-12 开闸)。v1 全部是**元数据级**:
 * turn = 轮次开始/结束(agent/模型/耗时/用量,不含消息内容);
 * session = 会话创建/归档/切换(切换 = 用户把哪个会话切到台前,2026-07-13 增)。
 * 正文级主题(消息内容旁听)刻意不开——隐私最重,等真实场景再议,权限文案
 * 也要另分一档。
 */
export const GHOST_SUBSCRIBE_TOPICS = ['turn', 'session'] as const;
export type GhostSubscribeTopic = (typeof GHOST_SUBSCRIBE_TOPICS)[number];

/**
 * 订阅槽 will- 拦截钩子(真 hook:主机停等裁决)。两个点,一进一出:
 * - `will-user-message`(入口):用户消息即将交给 agent 之前(拦下 = turn 压根
 *   不启动);动作 allow/block/rewrite。
 * - `will-assistant-message`(出口):AI 这轮回复完成、最终气泡定案之前,把全文
 *   交给意识做润色/合规改写或自绘结果卡片;动作 allow/rewrite/render(无 block
 *   ——AI 已生成,拦无意义)。**不拦流式输出**(照常打字机),只在 turn 结束
 *   边界的独立异步续跑里裁决,不搅 maker-core 热路径;超时/崩溃 fail-open 用原文。
 * 两个钩子都不拦 tool-call。声明了任一钩子必须 launch:'resident'(要挡路就得常驻
 * 在场,冷启动延迟不可接受),校验强制。
 */
export const GHOST_SUBSCRIBE_HOOKS = ['will-user-message', 'will-assistant-message'] as const;
export type GhostSubscribeHook = (typeof GHOST_SUBSCRIBE_HOOKS)[number];

/**
 * 订阅槽详单(与 slots 含 'subscribe' 成对;有槽无详单允许装入但零事件——
 * 与 cindy 详单同语义)。topics = did- 旁听(fire-and-forget),hooks = will-
 * 拦截(停等裁决);没声明的主题/钩子,网关不挂处理段(接口不存在)。
 */
export interface GhostSubscribeNeeds {
  topics?: GhostSubscribeTopic[];
  hooks?: GhostSubscribeHook[];
}

/* ── network 槽详单──────────────────────────────────
 * 意识自带服务:作者声明域名白名单 + 凭证需求,装入时钉死、确认框逐项展示。
 * 运行期沙箱仍零直连,所有出网经管子 fetch-request 由主机代发;凭证明文
 * 永不进沙箱——主机只在"该凭证声明的注入位置"拼进请求头。 */

/** network 槽:域名白名单条数上限(声明面越小越好,超了说明设计有问题)。 */
export const GHOST_NETWORK_MAX_HOSTS = 8;
/** network 槽:凭证声明条数上限。 */
export const GHOST_NETWORK_MAX_SECRETS = 4;
/** network 槽:多连接(connections)声明条数上限(一段意识通常只对接一种自建服务)。 */
export const GHOST_NETWORK_MAX_CONNECTION_DECLS = 2;
/** network 槽:每条连接声明下用户可添加的连接数上限(同时是 maxConnections 缺省值)。 */
export const GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL = 8;

/**
 * 域名白名单条目格式:小写域名,至少两段(拒绝裸 TLD / 单段内网名),
 * 通配只允许最左一段(`*.example.com`);不收 IP、端口、路径、协议。
 */
const GHOST_NETWORK_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export function isValidGhostNetworkHostPattern(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 253) return false;
  const bare = p.startsWith('*.') ? p.slice(2) : p;
  const labels = bare.split('.');
  // 至少两段:`*.com` / `localhost` / 裸 TLD 全部拒绝,命中面必须是具体域。
  if (labels.length < 2) return false;
  // 纯数字四段视作 IP,拒收(白名单只认域名)。
  if (labels.every((l) => /^\d+$/.test(l))) return false;
  return labels.every((l) => GHOST_NETWORK_LABEL_RE.test(l));
}

/**
 * hostname 是否命中白名单条目。精确条目要求逐字相等;通配条目
 * (`*.example.com`)命中任意深度的子域(`a.example.com`、`a.b.example.com`),
 * 但不命中裸域本身——作者两者都要就两条都声明,规则不做隐式扩张。
 * 注意:此行为必须与桌面端 base 的同名校验器逐字一致(两端同一契约),
 * 任何语义调整都属于协议变更,需两侧同步。
 */
function ghostNetworkHostMatches(pattern: string, hostname: string): boolean {
  if (pattern.startsWith('*.'))
    return hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1;
  return hostname === pattern;
}

/**
 * 凭证注入声明:该凭证以什么形态、进哪些域名的请求头。绑定在 secret 上
 * (而非独立 auth 模板)是刻意的——结构上保证"key 只流向它声明的域名",
 * 意识更新扩白名单也扩不走存量凭证的流向。
 */
export interface GhostSecretInjectDecl {
  /**
   * 注入范围(manifest.network.hosts 的子集,逐字匹配声明条目);
   * 缺省 = 详单里的全部域名。
   */
  hosts?: string[];
  /** 注入的请求头名(如 Authorization / X-Subscription-Token)。 */
  header: string;
  /** 头值模板:恰含一个 `{value}` 占位,其余为静态文本(如 `Bearer {value}`)。 */
  format: string;
}

/** 凭证交换(key 换令牌)请求体类型白名单。 */
export const GHOST_SECRET_EXCHANGE_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
] as const;
export type GhostSecretExchangeContentType = (typeof GHOST_SECRET_EXCHANGE_CONTENT_TYPES)[number];

/** 凭证交换:请求体模板长度上限。 */
export const GHOST_SECRET_EXCHANGE_BODY_MAX_CHARS = 2048;
/** 凭证交换:令牌缓存时长(秒)缺省 / 下限 / 上限(上限 30 天)。 */
export const GHOST_SECRET_EXCHANGE_TTL_DEFAULT_S = 3600;
export const GHOST_SECRET_EXCHANGE_TTL_MIN_S = 60;
export const GHOST_SECRET_EXCHANGE_TTL_MAX_S = 30 * 24 * 3600;
/** 凭证交换:tokenPath 点分路径形状(不支持数组下标,段名字母/数字/_/-)。 */
export const GHOST_SECRET_EXCHANGE_TOKEN_PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** oauth.identity.displayTemplate:占位符提取(`{点分路径}`;路径形状同 tokenPath)。 */
export const GHOST_OAUTH_IDENTITY_TEMPLATE_PLACEHOLDER_RE = /\{([^{}]*)\}/g;
/** oauth.identity.displayTemplate 长度上限(渲染产物也按同上限截断降级)。 */
export const GHOST_OAUTH_IDENTITY_TEMPLATE_MAX_CHARS = 200;

/**
 * 凭证交换声明(可选):有些服务的 API key 不直接当请求凭证,要先拿 key
 * 去换一个临时令牌(key→session 二段式)。声明后主机照单代办:
 * POST 交换端点(请求体模板注入原始 key,按 contentType 确定性转义)→
 * 从响应 JSON 按 tokenPath 取令牌 → 按 ttl 内存缓存 → inject.format 的
 * {value} 注入的是**换来的令牌**而非原始 key;上游 401 时主机作废缓存
 * 重换重试一次。原始 key 与令牌全程不进沙箱。做成清单声明而非主机硬编码,
 * 是为了新意识接入二段式服务不需要更新 app(交换方式由意识作者声明)。
 */
export interface GhostSecretExchangeDecl {
  /** 交换端点(仅 https、默认端口;域名必须命中 network.hosts 白名单)。 */
  url: string;
  /**
   * POST 请求体模板:恰含一个 `{value}` 占位(原始凭证落点)。注入时按
   * contentType 转义:json → JSON 字符串转义;form → percent 编码。
   */
  bodyFormat: string;
  /** 请求体类型;缺省 'application/json'。 */
  contentType?: GhostSecretExchangeContentType;
  /** 令牌在响应 JSON 里的点分路径(如 "session" / "data.token";值须是非空字符串)。 */
  tokenPath: string;
  /** 令牌缓存时长(秒,60–2592000);缺省 3600。 */
  ttlSeconds?: number;
}

/** OAuth 凭证:scopes 条数上限(超出拒装;确认框逐条展示要可读)。 */
export const GHOST_OAUTH_SCOPES_MAX = 256;
/** OAuth broker 模式允许声明的备用 client ID 数量上限。 */
export const GHOST_OAUTH_CLIENT_ID_ALTERNATIVES_MAX = 8;
/** OAuth 凭证:extraAuthorizeParams 条数上限。 */
export const GHOST_OAUTH_EXTRA_PARAMS_MAX = 8;
/**
 * OAuth 授权 URL 的协议保留参数:由主机授权引擎独占,意识的
 * extraAuthorizeParams 不许声明(装入拒;引擎侧同名单防御性忽略)。
 */
export const GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS: readonly string[] = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'scope',
  'code_challenge',
  'code_challenge_method',
];

/**
 * OAuth 凭证声明(source: 'oauth',2026-07-13 定案"通用声明式"):
 * 平台不预设 provider 名单——意识声明"去哪授权、要什么 scope",clientId /
 * clientSecret 由用户在意识设置页自填(经 /oauth 只写通道入库),插件详情
 * 全量展示授权域名与 scopes,用户知情自担。声明化的是**参数**不是**代码**:
 * 授权流程(拉浏览器、loopback 回调、state/PKCE 校验、code 换 token、刷新)
 * 永远由主机可信代码执行,意识无从插手,
 * access / refresh token 与 client 凭证全程不进沙箱,注入按 inject 声明由
 * networkSlot 出网时现取现注(401 作废重刷重试一次,与 exchange 同套路)。
 */
export interface GhostSecretOauthDecl {
  /** 授权页地址(https;域名必须命中 network.hosts 白名单——确认框上的域名集合 = 全部出网面)。 */
  authorizeUrl: string;
  /** code / refresh token 交换端点(https;域名必须命中 hosts——clientSecret 只流向用户同意过的域名)。 */
  tokenUrl: string;
  /**
   * 可选:作者内置的 OAuth 客户端 ID(2026-07-13 定案,开箱即用前置)。
   * 声明后用户零配置即可点"连接账号";用户在设置页自填的
   * client 凭证**覆盖**内置值(清除自填 = 回落内置)。桌面应用的 client
   * 凭证按 Google 官方口径本非机密(installed-app),写进包里不引入新泄露面;
   * 授权仍需用户在浏览器里亲自同意,凭证本身访问不了任何数据。
   */
  clientId?: string;
  /** 可选:broker 模式下允许意识在单次连接时选择的备用客户端 ID。 */
  clientIdAlternatives?: string[];
  /** 可选:内置 client 的 secret(与 clientId 成对;纯 PKCE 服务商可省略)。 */
  clientSecret?: string;
  /** 申请的 scope 列表(0–256 条,确认框逐条展示;缺省 = 不带 scope 参数)。 */
  scopes?: string[];
  /**
   * 可选:authorize URL 里 scope 参数的拼接分隔符。OAuth 标准是空格(缺省),
   * Slack 这类逗号分隔的服务商声明 ","(目前只认这一个值)。
   */
  scopeDelimiter?: ',';
  /** PKCE(S256)开关,缺省 true;个别不支持的老服务商可显式声明 false。 */
  pkce?: boolean;
  /**
   * 服务商特有的授权页附加参数(如 Google 的 access_type=offline +
   * prompt=consent、Atlassian 的 audience=api.atlassian.com);协议保留参数
   * (GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS)不许声明。
   */
  extraAuthorizeParams?: Record<string, string>;
  /**
   * 可选:授权成功后拉一次身份端点给账号打展示标签(设置页"已连接为 xxx");
   * url 仅 https 且域名须命中 hosts;labelPath 为响应 JSON 的点分路径
   * (与 exchange.tokenPath 同规则)。拉取失败不阻断授权(标签降级为空)。
   *
   * displayTemplate(可选,2026-07-15 增补):人类可读的展示名
   * 模板,`{点分路径}` 占位符从同一份身份响应取值(如 Slack auth.test 的
   * `"{team} · {user}"`)。与 labelPath 分工:labelPath 指向**稳定且唯一**的
   * 身份键(user_id / 邮箱),是重复授权时同身份合并的判定键;displayTemplate
   * 只管展示(设置页 / 账号工具看到的名字),任一占位符取不到值时整体降级
   * 为空(回落显示 labelPath 标签)。不声明 = 展示名就用 labelPath 的值
   * (邮箱这类本身可读的服务商不需要它)。
   */
  identity?: {
    url: string;
    labelPath: string;
    displayTemplate?: string;
    avatarPath?: string;
  };
  /**
   * 可选:loopback 回调固定端口(1024–65535)。Atlassian 这类服务商要求回调
   * URI 与应用注册值精确匹配(含端口),声明后主机授权引擎钉死
   * `http://127.0.0.1:<port>/callback`(端口被占用时结构化报错引导重试);
   * 缺省 = 随机端口(Google 等允许任意 loopback 端口的服务商)。
   */
  redirectPort?: number;
  /**
   * 可选:服务端 token broker 的 provider slug(2026-07-14 增补)。
   * 声明后 code 换 token 与 refresh 不直连 tokenUrl,改经主机
   * 调服务端的授权 broker(带登录 JWT;client secret 在服务端,不随包
   * 分发)。与 clientSecret 互斥。静态官方前缀照旧放行；其余资格由可信组织市场
   * 来源、批准包字节与当前组织事实共同判定。校验层保持纯函数不感知装入语境，
   * 门控在装入闸与连接闸。
   */
  tokenBroker?: string;
  /**
   * 可选:broker 弹跳回调(双地址模型,2026-07-15 增补)。
   * Slack 这类服务商后台只收 https redirect,不收 http loopback——声明后
   * 报给服务商的 redirect_uri 变成「授权 broker 服务的 https 弹跳路由」
   * (主机运行时用 broker 基地址 + `path` 拼出,清单不落域名字面量),浏览器
   * 授权后落弹跳路由,由其 302 回本机 `http://127.0.0.1:<redirectPort><callbackPath>`。
   * 约束:必须与 tokenBroker、redirectPort 同时声明(弹跳路由的 302 目标
   * 端口与路径在 broker 服务端写死,三者是一套约定);两个路径都必须是
   * `/` 开头的站内绝对路径。
   */
  brokerBounce?: { path: string; callbackPath: string };
}

/** tokenBroker slug 形状(小写字母开头,小写/数字/下划线/连字符,1–32)。 */
export const GHOST_OAUTH_TOKEN_BROKER_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** brokerBounce 路径形状(/ 开头的站内绝对路径,段字符限字母/数字/_/-,≤128)。 */
export const GHOST_OAUTH_BOUNCE_PATH_RE = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/**
 * 凭证值来源(2026-07-13 定型):
 * - 'user'(缺省):值由用户在该意识设置页填入主机保险库;
 * - 'login-email':值 = 主机当前登录账号的邮箱——主机注入时现取登录态,
 *   设置页只读展示该邮箱(不可编辑、不进保险库);未登录 / 登录态缺 email
 *   时 fail-closed 报错并引导重新登录。适用于"服务端按登录邮箱派生鉴权"
 *   的第一方服务(经 inject.format 的静态前缀完成派生)。
 * - 'oauth'(2026-07-13 增补):值 = 主机托管 OAuth
 *   授权换来的 access token——用户在意识设置页填 client 凭证并点"连接账号",
 *   主机跑授权流程并保管全部令牌,出网时现取新鲜 token 注入(见
 *   GhostSecretOauthDecl;必须同时声明 oauth 详单)。
 * - 'login-feishu-token'(2026-07-16 增补):值 = 主机
 *   飞书登录态的 user access token——主机注入时现取(登录态管理器
 *   自刷新,token 明文不进沙箱、不进错误消息);未连接飞书 / 刷新链路判
 *   AUTH_EXPIRED 时 fail-closed 报错并引导重新登录飞书。适用于"能力面
 *   直接复用产品飞书登录身份"的第一方服务;与 login-email 同族:用户
 *   不填值,禁 url / exchange / oauth,settingsHtml 豁免。
 * - 'oidc-token'(2026-08-03 增补):值 = 主机为当前企业 Membership
 *   按受信组织插件 provenance 按需签发的短时 Cindy Connection JWT;
 *   插件和 Node Worker 都不能读取或保存令牌。必须固定注入
 *   `Authorization: Bearer {value}` 并显式声明非空的精确 inject.hosts;
 *   不允许 url / exchange / oauth / input,也不要求 settingsHtml。只有
 *   organization scope 的插件可以通过 Plugin Market 发布该来源。
 * - 'gh-cli'(2026-08-05 增补):值优先取主机本地 GitHub CLI
 *   登录态(`gh auth token`),不可用时回落到用户在该插件设置页
 *   保存的备用 Token。两种值都只允许固定注入
 *   `https://api.github.com` 的 `Authorization: Bearer {value}`;插件和
 *   Node Worker 不能读取令牌。必须声明 settingsHtml 作为
 *   备用 Token 的管理入口,不允许 exchange / oauth / input。
 */
export const GHOST_SECRET_SOURCES = [
  'user',
  'login-email',
  'oauth',
  'login-feishu-token',
  'oidc-token',
  'gh-cli',
] as const;
export type GhostSecretSource = (typeof GHOST_SECRET_SOURCES)[number];

/**
 * 凭证收单(2026-07-13 两次定案,当天收敛):user 凭证的收单**一律**由意识
 * settingsHtml 自绘——经协议 `/secrets` 只写通道一次性入库,存入后意识拿不回
 * 明文,保管(safeStorage)与注入(主机代发时)由主机独占。安全模型弱化点
 * 仅一处:录入瞬间明文经过意识页面(用户主动敲进它的输入框),插件详情
 * 如实告知。**宿主渲染凭证输入行已整体退役**(基座不再为意识特设凭证 UI,
 * 定案):清单里遗留的 `input: "ghost"` 接受并忽略(与现状同义),
 * `input: "host"` 直接拒绝;声明 user 凭证必须同时声明 settingsHtml。
 */

/** 凭证声明:只有名字与说明——值由用户在该意识设置区填入主机保险库。 */
export interface GhostSecretDecl {
  /** 凭证键(意识内唯一):小写字母开头,允许小写/数字/下划线,1–32。 */
  key: string;
  /** 给用户看的名称(插件详情展示)。 */
  label: string;
  /** 凭证值来源;缺省 'user'(校验归一化:'user' 不落清单)。 */
  source?: GhostSecretSource;
  /** 可选提示(如"在 example.com/settings 生成")。 */
  hint?: string;
  /**
   * 可选:该凭证的控制台/申请页地址(仅 https)。settingsHtml 里可用
   * `<a href>` 逐字引用本地址——主机外链闸(GhostExternalLinkGate)只放行
   * 身份卡声明过的地址,点击转系统浏览器打开;也供确认框等宿主 UI 引用。
   */
  url?: string;
  /** 注入位置声明(必填:没有注入位置的凭证无处可用)。 */
  inject: GhostSecretInjectDecl;
  /** 可选:key 换令牌二段式声明(见 GhostSecretExchangeDecl;与 oauth 互斥)。 */
  exchange?: GhostSecretExchangeDecl;
  /** source: 'oauth' 时必填的授权详单(见 GhostSecretOauthDecl);其它来源禁止声明。 */
  oauth?: GhostSecretOauthDecl;
  /**
   * @deprecated 已退役(2026-07-13 宿主凭证渲染退役):user 凭证一律意识
   * settingsHtml 收单。原始清单遗留的 'ghost' 装入时接受并忽略(归一化后
   * 不落清单,见 validateGhostManifest),其余值拒。字段仅为原始清单解析
   * 与存量消费点的类型兼容保留,新代码不要读写。
   */
  input?: 'ghost';
}

/**
 * 多连接声明(connections,2026-07-14,Cindy GitLab 自建实例前置):
 * "地址 + 凭证成对多条"的凭证形态——作者只声明连接类型(名字、注入形态、
 * 条数上限),具体地址与 token 由用户在意识设置页逐条添加(经 /connections
 * 协议通道入库)。与静态 hosts 白名单的关系:用户添加的每条地址并入该意识
 * 的放行域(精确匹配,不吃通配),**每次新增地址都要过主机受信确认弹窗**
 * ——动态白名单不能只凭意识设置页(意识自绘、不可信)单方面扩张。凭证注入
 * 范围恒等于各连接自身地址(结构上钉死"token 只流向它自己的实例"),因此
 * inject 不允许声明 hosts 子集(写了拒装)。
 */
export interface GhostConnectionDecl {
  /** 连接声明键(意识内唯一,与 secrets[].key 共用命名空间不得撞名):小写字母开头,1–32。 */
  key: string;
  /** 给人看的连接类型名(如「GitLab 实例」;确认框与设置页展示)。 */
  label: string;
  /** 可选提示(≤200 字,设置页展示,如"填实例域名与 Personal Access Token")。 */
  hint?: string;
  /**
   * 凭证注入形态(header + format,校验同 GhostSecretInjectDecl;**禁止**
   * 声明 hosts——注入范围恒等于各连接自身地址,不接受作者收窄/扩张)。
   */
  inject: { header: string; format: string };
  /** 每种连接可添加的地址数上限(1–8 整数;缺省 8)。 */
  maxConnections?: number;
}

/**
 * network 槽详单(与 slots 含 'network' 成对;有槽无详单允许装入但零能力,
 * 与 cindy / subscribe 同语义)。
 */
export interface GhostNetworkNeeds {
  /**
   * 静态域名白名单(装入时钉死;运行期主机逐请求校验)。常规必填 1–8 条;
   * 声明了 connections(动态连接地址)时可缺省/空数组——静态域名与动态
   * 连接至少有其一(校验保证),归一化后恒为数组(可能为空)。
   */
  hosts: string[];
  /** 凭证声明(0–4 条;用户填值,主机加密保管并按 inject 声明注入)。 */
  secrets?: GhostSecretDecl[];
  /** 多连接声明(0–2 条;地址+凭证成对多条,用户在设置页添加,见 GhostConnectionDecl)。 */
  connections?: GhostConnectionDecl[];
}

/**
 * 注入头名黑名单:协议关键头由主机独占,作者声明命中即拒装
 * (小写比较;Cookie 也拒——会话粘连语义不给意识)。
 */
export const GHOST_NETWORK_FORBIDDEN_INJECT_HEADERS: readonly string[] = [
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'cookie',
  'origin',
  'referer',
  // content-type 由请求语义决定(上传通道的 multipart boundary 依赖它),
  // 不许被凭证注入声明占用——401 重换/跨域跳转的重注入会砸掉 boundary。
  'content-type',
];

/** preview 槽:可打开预览的域名模式条数上限(范围越小越好,同 network 精神)。 */
export const GHOST_PREVIEW_MAX_HOSTS = 4;

/**
 * preview 槽详单(与 slots 含 'preview' 严格成对——有槽必有详单:范围是
 * 本能力的全部知情面,不允许"先装后说")。hosts 语法与 network 域名白名单
 * 一致(支持 `*.` 单层前缀通配),另特批 loopback 单段名(本地 dev server
 * 是预览的正当主场,network 语法"至少两段"表达不了它)。插件详情逐条展示。
 */
export interface GhostPreviewNeeds {
  hosts: string[];
}

/** preview.hosts 特批的 loopback 主机名(network 域名语法之外唯一的例外)。 */
export const GHOST_PREVIEW_LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/** skill 槽:单插件最多捆绑的 Agent Skill 数(范围越小越好,同 preview 精神)。 */
export const GHOST_SKILL_MAX_ITEMS = 4;
/** skill 槽:SKILL.md 单文件字节上限。打包与装入两侧共用,避免契约漂移。 */
export const GHOST_SKILL_MD_MAX_BYTES = 64 * 1024;
/** skill 槽:技能 name 长度上限(链接目录名的一半,克制)。 */
export const GHOST_SKILL_NAME_MAX_CHARS = 64;
/**
 * skill 槽:技能 name 形状——小写字母/数字,连字符仅作单段分隔(禁首尾与连续
 * 连字符)。比 SkillHub 的技能名规则更严:意识 id 允许含 `--`(GHOST_ID_RE),
 * 共享技能根的链接名是 `<id>--<name>`,只有 name 侧禁 `--`,
 * 按"最后一个 `--`"拆分才唯一,不同插件才不可能撞出同一个链接名。
 */
export const GHOST_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** manual:单插件最多声明的渐进披露手册单元数。 */
export const GHOST_MANUAL_MAX_ITEMS = 8;
/** manual:每个声明单元固定的入口文件名。 */
export const GHOST_MANUAL_ENTRY_FILE = 'MANUAL.md';
/** manual:单个 Markdown 文件的字节上限。打包与装入两侧共用。 */
export const GHOST_MANUAL_MD_MAX_BYTES = 64 * 1024;
/** manual:一级索引说明的字符上限。 */
export const GHOST_MANUAL_DESCRIPTION_MAX_CHARS = GHOST_MANIFEST_SUMMARY_MAX_CHARS;

/** skill 槽单条技能声明(全声明式:插件详情展示的就是这里的字段)。 */
export interface GhostSkillItem {
  /** 包内技能目录(安全相对路径,目录内必须有 SKILL.md)。 */
  dir: string;
  /**
   * 技能名。必须与 SKILL.md frontmatter 的 name 逐字一致(打包与装入双侧
   * 强制)——详情里用户看到的,必须就是 Agent 实际读到的。
   */
  name: string;
  /** 技能说明。必须与 SKILL.md frontmatter 的 description 逐字一致(同上)。 */
  description: string;
}

/**
 * skill 槽详单(与 slots 含 'skill' 严格成对——有槽必有详单:捆绑了什么技能
 * 是本能力的全部知情面,不允许隐瞒)。插件详情逐条展示。
 */
export interface GhostSkillNeeds {
  items: GhostSkillItem[];
}

/** manual 单条手册声明。name 是模型调用时使用的逻辑路径首段，dir 是包内物理目录。 */
export interface GhostManualItem {
  /** 包内手册目录(安全相对路径，目录内必须有 MANUAL.md)。 */
  dir: string;
  /** 逻辑名称；沿用 skill name 的小写连字符规则。 */
  name: string;
  /** ghost_info / ghost_manual 根索引展示的手册说明。 */
  description: string;
}

/** 插件随包提供、由 Host 按需读取的渐进披露手册索引。 */
export interface GhostManualNeeds {
  items: GhostManualItem[];
}

/** setup 作者声明：组间 allOf，组内 anyOf。 */
export type GhostSetupRequirement =
  | { kind: 'secret'; key: string }
  | { kind: 'connection'; key: string }
  | { kind: 'kv'; key: string; label: string };

export interface GhostSetupGroup {
  anyOf: GhostSetupRequirement[];
}

export interface GhostSetupDecl {
  requires: GhostSetupGroup[];
}

export const GHOST_SETUP_MAX_GROUPS = 8;
export const GHOST_SETUP_MAX_ITEMS_PER_GROUP = 8;
export const GHOST_SETUP_KV_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 已校验的 ghost.json 协议文档；Desktop 会再投影成无 slots 的运行时模型。 */
export interface GhostManifest {
  /** v2 仅作存量兼容；新插件使用 v3。 */
  schemaVersion: 2 | typeof GHOST_MANIFEST_SCHEMA_VERSION;
  /** 唯一标识,同时是安装目录名与 panelKind 后缀。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 版本字符串(不强制 semver,仅展示用)。 */
  version: string;
  /**
   * 安装此 Release 所需的最低 Cindy 客户端版本。缺省表示不限制客户端版本；
   * 声明时必须是合法 SemVer，客户端与 Plugin Server 使用同一比较语义。
   */
  minCindyVersion?: string;
  /** 作者展示名(仅展示用)。 */
  author?: string;
  /**
   * 宿主语言到包内 locale JSON 的映射。声明时必须提供英文资源作为固定
   * 回退；路径须唯一，且不能与其它 manifest 文件声明冲突。
   */
  locales?: GhostManifestLocales;
  /**
   * 意识自我介绍(1–300 字,仅展示用):这段意识是干嘛
   * 的、给谁用。插件详情页展示;与 tools[].description(给 AI 看的
   * 工具说明)职责不同,后者不因本字段缺省而顶上。
   */
  description?: string;
  /**
   * 语义召回线索(1–300 字;给模型看,不上界面):什么场景该想起
   * 这段意识——进 agent 会话的意识花名册。与 description 分开是因为读者不同:
   * 描述给人看要简洁,召回线索给模型看要场景枚举、且会反复调优。缺省时
   * 花名册回落用 description。
   */
  whenToUse?: string;
  /**
   * 图标图片(包内相对路径,装入后位于安装目录)。仅允许白名单扩展名
   * (见 ghostIconMimeType);由 main 读盘转 data URL 随清单下发,
   * renderer 直接 <img> 渲染——cindy-ghost:// 协议只挂沙箱分区,主窗口不走它。
   */
  icon?: string;
  /**
   * 意识形态,恒 'chip'(2026-07-12 单形态定案)。清单里可省略(同日晚间
   * 定案:单形态后纯冗余),校验归一化补齐——消费方永远拿到 'chip'。
   */
  kind: 'chip';
  /** 逻辑入口 JS(安装目录内相对路径,电子脑)。 */
  entry: string;
  /** 电子脑启动模式;缺省 = 'on-demand'(被需要才拉起)。 */
  launch?: GhostLaunchMode;
  /** Agent 新回合能力；v3 空对象表示仅允许真实用户点击触发。 */
  agent?: GhostAgentNeeds;
  /** 随包本地 Node 工作进程能力。 */
  node?: GhostNodeNeeds;
  /**
   * 设置页「自定义设置区」界面入口(可选;安装目录内相对路径,意识自绘)。
   * 与面板同款沙箱 webview 渲染(零桥、分区断网、CSP 'self'),主题 token
   * 由主机灌入。用户填写的 `network.secrets` 与 `node.secretBindings` 凭证
   * 必须在此页面收单并经 `/secrets` 只写通道立即交给主机保险库，不得写入
   * `/kv`；其它自定义参数持久化走同源 `fetch('/kv')`。
   */
  settingsHtml?: string;
  /**
   * 自定义设置区固定高度(px,可选;160–800)。缺省 = 宿主量 guest 内容
   * 高度自适应(同区间收口);声明本字段 = 固定高度(内容动态增减的设置
   * 页用它避免抖动)。须与 settingsHtml 成对声明。
   */
  settingsHeight?: number;
  /** 仅 schemaVersion 2 存在的兼容声明。 */
  slots?: LegacyGhostSlot[];
  /**
   * card 能力；v3 空对象表示仅渲染、无外链。
   * externalLinks: true 时卡片内可声明 data-ghost-link,点击经宿主确认框后打开浏览器。
   */
  card?: GhostCardNeeds;
  /** 注册给 agent 的工具声明；字段本身就是能力声明。 */
  tools?: GhostToolDecl[];
  /**
   * Cindy 代办能力。v2 的旧字段名 model 在兼容校验层收入本字段。
   */
  cindy?: GhostCindyNeeds;
  /**
   * 订阅能力与事件范围。
   * hooks 非空时 launch 必须为 'resident'(校验强制)。
   */
  subscribe?: GhostSubscribeNeeds;
  /**
   * network 能力与访问范围。
   * 域名白名单 + 凭证声明由插件详情逐项展示,运行期主机代发并守门。
   */
  network?: GhostNetworkNeeds;
  /**
   * 显式触发指令(聊天输入框 `/<command>`,与 Skill 共用命令入口;
   * 2026-07-09 定案:由意识作者自定,装入时主机与已装意识查重,
   * 冲突即拒)。须声明 tools——没有工具的指令无事可做。
   */
  command?: string;
  /**
   * @deprecated 语义触发扩展词表——「语言提及软提示」已于 2026-07-14 移除
   * (普通用户无法理解凭空出现的「提及意识」胶囊),本字段不再有任何消费。
   * 校验保留(数量/长度/单字词限制)仅为旧包装入兼容,新意识不要写,
   * 手册(FORGE_GUIDE)已不再介绍。
   */
  keywords?: string[];
  /** 面板声明;没有面板的意识(如纯工具意识)可省略。 */
  panel?: GhostPanelDecl;
  /** 应用级主视图声明；v3 直接声明，v2 与 `main-view` slot 成对。 */
  mainView?: GhostMainViewDecl;
  /**
   * preview 能力详单；v2 与 'preview' slot 成对。可在右侧栏内置浏览器
   * 打开预览标签页的域名白名单。
   */
  preview?: GhostPreviewNeeds;
  /**
   * skill 能力详单；v2 与 'skill' slot 成对。随包捆绑的 Agent Skills 清单。
   * 启用时主机链接进共享技能根,Claude Code 与 Codex 双端可见;字段不参与
   * 本地化(必须与 SKILL.md 逐字一致,见 GhostSkillItem)。
   */
  skill?: GhostSkillNeeds;
  /** 无配置的 Host 能力在 v3 中只接受字面量 true；不需要时省略。 */
  notify?: true;
  badge?: true;
  confirm?: true;
  fs?: true;
  /** 持久作品库；卸载不删数据，位置和删除由 Host 设置页管理。 */
  library?: true;
  sessionContext?: true;
  pick?: true;
  workspace?: true;
  iosSimulator?: true;
  /**
   * 随包渐进披露手册。它不是能力 slot 或授权项；Host 只把索引投影给模型，
   * 正文经 ghost_manual 按需读取。旧客户端忽略这一可选顶层字段。
   */
  manual?: GhostManualNeeds;
  /** 使用前置检查；引用必须绑定本清单已声明的凭证、连接或设置项。 */
  setup?: GhostSetupDecl;
  /** v3 未知顶层字段原样保留，但 Host 不解释、不展示、不授权。 */
  [key: string]: unknown;
}

/** 判断已校验的 manifest 是否请求 Host 托管的企业身份凭证。 */
export function ghostManifestUsesOidcToken(manifest: GhostManifest): boolean {
  return manifest.network?.secrets?.some((secret) => secret.source === 'oidc-token') ?? false;
}

/** 判断值是否可作为 `ghost.json.id` 和跨平台安全的安装目录名。 */
export function isValidGhostId(id: unknown): id is string {
  return typeof id === 'string' && GHOST_ID_RE.test(id) && !isWindowsReservedName(id);
}

/**
 * 插件详情与不兼容安装提醒共用的单项能力说明。
 * 纯数据描述:renderer 拼 `settings.ghosts.perm.<labelKey>` 翻译,`detail` 是
 * 作者自由文本(如工具描述)如实展示不翻译,`detailKey` 是主机固定说明的
 * i18n 后缀(如可执行代码的沙箱说明)——两者互斥。
 */
const GHOST_ICON_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** icon 路径 → mime;扩展名不在白名单返回 null(即校验不通过)。 */
export function ghostIconMimeType(p: string): string | null {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return null;
  return GHOST_ICON_MIME_BY_EXT[p.slice(dot).toLowerCase()] ?? null;
}

/**
 * 校验"安装目录内相对路径"(entry / panel.html / settingsHtml 共用):
 * 只允许 `a/b/c.ext` 形态——正斜杠分段、无盘符、无反斜杠、无空段、
 * 无 `.`/`..` 段、无 Windows 设备保留名、字符集收敛,天然杜绝路径穿越
 * 与跨平台歧义。
 */
const GHOST_PATH_SEGMENT_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/;
export function isSafeGhostRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (p.includes('\\')) return false;
  const segments = p.split('/');
  return segments.every(
    (seg) =>
      GHOST_PATH_SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..' && !isWindowsReservedName(seg),
  );
}

/** `validateGhostManifest` 的无异常校验结果。 */
export type ManifestValidation =
  { ok: true; manifest: GhostManifest } | { ok: false; reason: string };

interface ParsedCindyVersion {
  core: readonly [string, string, string];
  prerelease: readonly { numeric: boolean; value: string }[];
}

function compareNumericIdentifiers(left: string, right: string): -1 | 0 | 1 {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseCindyVersion(value: string): ParsedCindyVersion | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const core = [match[1], match[2], match[3]] as [string, string, string];
  const prerelease: Array<{ numeric: boolean; value: string }> = [];
  for (const part of match[4]?.split('.') ?? []) {
    const numeric = /^\d+$/.test(part);
    if (numeric && !/^(0|[1-9]\d*)$/.test(part)) return null;
    prerelease.push({ numeric, value: part });
  }
  return { core, prerelease };
}

/** 判断值是否是可参与兼容性比较的 Cindy SemVer。 */
export function isValidCindyVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && parseCindyVersion(value) !== null;
}

/** 开发构建没有正式版本号，按当前源码兼容处理。 */
export function isVersionlessCindyVersion(value: string): boolean {
  return value === '0.0.0' || value.startsWith('0.0.0-');
}

/** 按 SemVer 2.0.0 比较两个 Cindy 版本；任一格式非法时返回 null。 */
export function compareCindyVersions(leftValue: string, rightValue: string): -1 | 0 | 1 | null {
  const left = parseCindyVersion(leftValue);
  const right = parseCindyVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    const coreComparison = compareNumericIdentifiers(left.core[index], right.core[index]);
    if (coreComparison !== 0) return coreComparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart.numeric !== rightPart.numeric) return leftPart.numeric ? -1 : 1;
    const partComparison = leftPart.numeric
      ? compareNumericIdentifiers(leftPart.value, rightPart.value)
      : leftPart.value === rightPart.value
        ? 0
        : leftPart.value < rightPart.value
          ? -1
          : 1;
    if (partComparison !== 0) return partComparison;
  }
  return 0;
}

/** 缺少最低版本即不限制；非法当前版本按不兼容处理。 */
export function supportsCindyVersion(
  currentVersion: string,
  minCindyVersion: string | undefined,
): boolean {
  if (minCindyVersion === undefined) return true;
  if (!isValidCindyVersion(currentVersion) || !isValidCindyVersion(minCindyVersion)) return false;
  if (isVersionlessCindyVersion(currentVersion)) return true;
  const comparison = compareCindyVersions(currentVersion, minCindyVersion);
  return comparison !== null && comparison >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const GHOST_MANIFEST_RESERVED_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isGhostManifestReservedRecordKey(value: string): boolean {
  return GHOST_MANIFEST_RESERVED_RECORD_KEYS.has(value);
}

const GHOST_MANIFEST_KNOWN_TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'id',
  'name',
  'version',
  'minCindyVersion',
  'author',
  'locales',
  'description',
  'whenToUse',
  'icon',
  'kind',
  'entry',
  'launch',
  'agent',
  'node',
  'settingsHtml',
  'settingsHeight',
  'slots',
  'card',
  'tools',
  'cindy',
  'model',
  'subscribe',
  'network',
  'command',
  'keywords',
  'panel',
  'mainView',
  'preview',
  'skill',
  'manual',
  'setup',
  'notify',
  'badge',
  'confirm',
  'fs',
  'library',
  'sessionContext',
  'pick',
  'workspace',
  'iosSimulator',
]);

const V3_BOOLEAN_CAPABILITY_FIELDS = [
  'notify',
  'badge',
  'confirm',
  'fs',
  'library',
  'sessionContext',
  'pick',
  'workspace',
  'iosSimulator',
] as const;

const V3_DECLARATION_TO_LEGACY_SLOT = [
  ['tools', 'tool'],
  ['card', 'card'],
  ['panel', 'panel'],
  ['mainView', 'main-view'],
  ['subscribe', 'subscribe'],
  ['skill', 'skill'],
  ['cindy', 'cindy'],
  ['agent', 'agent'],
  ['node', 'node'],
  ['network', 'network'],
  ['preview', 'preview'],
] as const;

const V3_BOOLEAN_TO_LEGACY_SLOT: Record<(typeof V3_BOOLEAN_CAPABILITY_FIELDS)[number], string> = {
  notify: 'notify',
  badge: 'badge',
  confirm: 'confirm',
  fs: 'fs',
  library: 'library',
  sessionContext: 'session-context',
  pick: 'pick',
  workspace: 'workspace',
  iosSimulator: 'ios-simulator',
};

type PreparedGhostManifest = {
  raw: Record<string, unknown>;
  schemaVersion: 2 | 3;
  v3BaseCard: boolean;
  v3BaseAgent: boolean;
  unknownV3Fields: Record<string, unknown>;
};

function prepareGhostManifestForValidation(
  value: unknown,
): { ok: true; prepared: PreparedGhostManifest } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: '清单不是对象' };
  if (value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    return {
      ok: false,
      reason: `schemaVersion 必须是 2 或 3,得到 ${JSON.stringify(value.schemaVersion)}(v1 声明型已于 2026-07-12 移除)`,
    };
  }
  if (value.schemaVersion === 2) {
    return {
      ok: true,
      prepared: {
        raw: Array.isArray(value.slots)
          ? { ...value, slots: dropEmptyLegacyCapabilitySlots(value, value.slots) }
          : value,
        schemaVersion: 2,
        v3BaseCard: false,
        v3BaseAgent: false,
        unknownV3Fields: {},
      },
    };
  }
  if (value.slots !== undefined) {
    return { ok: false, reason: 'schemaVersion 3 不再支持 slots；请直接声明对应能力字段' };
  }
  if (value.minCindyVersion === undefined) {
    return { ok: false, reason: 'schemaVersion 3 必须声明 minCindyVersion' };
  }
  for (const field of V3_BOOLEAN_CAPABILITY_FIELDS) {
    if (value[field] !== undefined && value[field] !== true) {
      return { ok: false, reason: `${field} 出现时必须是 true；不需要时请省略` };
    }
  }
  const syntheticSlots: string[] = [];
  for (const [field, slot] of V3_DECLARATION_TO_LEGACY_SLOT) {
    if (value[field] !== undefined) syntheticSlots.push(slot);
  }
  for (const field of V3_BOOLEAN_CAPABILITY_FIELDS) {
    if (value[field] === true) syntheticSlots.push(V3_BOOLEAN_TO_LEGACY_SLOT[field]);
  }
  const v3BaseCard = isPlainObject(value.card) && Object.keys(value.card).length === 0;
  const v3BaseAgent = isPlainObject(value.agent) && Object.keys(value.agent).length === 0;
  return {
    ok: true,
    prepared: {
      raw: {
        ...value,
        slots: syntheticSlots,
        ...(v3BaseCard ? { card: undefined } : {}),
        ...(v3BaseAgent ? { agent: undefined } : {}),
      },
      schemaVersion: 3,
      v3BaseCard,
      v3BaseAgent,
      unknownV3Fields: Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => key === 'model' || !GHOST_MANIFEST_KNOWN_TOP_LEVEL_FIELDS.has(key),
        ),
      ),
    },
  };
}

/** v2 允许历史上只有名字、没有实际能力详单的 slot；校验结果会将其丢弃。 */
function dropEmptyLegacyCapabilitySlots(
  value: Record<string, unknown>,
  slots: unknown[],
): unknown[] {
  return slots.filter((slot) => {
    const normalized = slot === 'model' ? 'cindy' : slot;
    if (normalized === 'tool') return value.tools !== undefined;
    if (normalized === 'panel') return value.panel !== undefined;
    if (normalized === 'cindy') return value.cindy !== undefined || value.model !== undefined;
    if (normalized === 'subscribe') return value.subscribe !== undefined;
    if (normalized === 'node') return value.node !== undefined;
    if (normalized === 'network') return value.network !== undefined;
    if (normalized === 'preview') return value.preview !== undefined;
    if (normalized === 'skill') return value.skill !== undefined;
    return true;
  });
}

/**
 * 校验一份 JSON.parse 后的未知 `ghost.json` 值。已知字段严格检查；v2 未知
 * 字段忽略，v3 未知顶层字段原样保留但不解释、不授权。
 */
export function validateGhostManifest(value: unknown): ManifestValidation {
  const preparation = prepareGhostManifestForValidation(value);
  if (!preparation.ok) return preparation;
  const prepared = preparation.prepared;
  const raw = prepared.raw;
  if (!isValidGhostId(raw.id)) {
    return {
      ok: false,
      reason: 'id 必须是 1–32 位小写字母/数字/连字符(不能以连字符开头或使用 Windows 设备保留名)',
    };
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 64) {
    return { ok: false, reason: 'name 必须是 1–64 字符的非空字符串' };
  }
  if (
    typeof raw.version !== 'string' ||
    raw.version.trim().length === 0 ||
    raw.version.length > 32
  ) {
    return { ok: false, reason: 'version 必须是 1–32 字符的非空字符串' };
  }
  if (
    raw.minCindyVersion !== undefined &&
    (typeof raw.minCindyVersion !== 'string' || !isValidCindyVersion(raw.minCindyVersion))
  ) {
    return { ok: false, reason: 'minCindyVersion 必须是合法的 SemVer 字符串' };
  }
  // kind 可省略(2026-07-12 晚定案:单形态后字段纯冗余,缺省即 chip);
  // 写了就必须是 chip——写错值仍拒,不静默纠正(规则 9)。
  if (raw.kind !== undefined && raw.kind !== 'chip') {
    return {
      ok: false,
      reason: `kind 必须是 "chip" 或省略(缺省即 chip),得到 ${JSON.stringify(raw.kind)}(意识只有芯片一种形态,declaration 已移除)`,
    };
  }
  if (
    raw.author !== undefined &&
    (typeof raw.author !== 'string' || raw.author.trim().length === 0 || raw.author.length > 64)
  ) {
    return { ok: false, reason: 'author 必须是 1–64 字符的非空字符串' };
  }
  const declaredFilePathFolds = [
    GHOST_MANIFEST_FILE,
    raw.entry,
    raw.icon,
    raw.settingsHtml,
    isPlainObject(raw.panel) ? raw.panel.html : undefined,
    isPlainObject(raw.mainView) ? raw.mainView.html : undefined,
    isPlainObject(raw.node) ? raw.node.entry : undefined,
    ...(isPlainObject(raw.node) && Array.isArray(raw.node.entries) ? raw.node.entries : []),
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  const isSameOrDescendant = (path: string, ancestor: string): boolean =>
    path === ancestor || path.startsWith(`${ancestor}/`);
  const pathsConflict = (left: string, right: string): boolean =>
    isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
  let locales: GhostManifest['locales'];
  if (raw.locales !== undefined) {
    if (!isPlainObject(raw.locales)) {
      return {
        ok: false,
        reason: 'locales 必须是语言到 locale JSON 路径的对象',
      };
    }
    const unknownLocale = Object.keys(raw.locales).find(
      (locale) => !(GHOST_LOCALES as readonly string[]).includes(locale),
    );
    if (unknownLocale) {
      return {
        ok: false,
        reason: `locales 含宿主不支持的语言 ${JSON.stringify(unknownLocale)}(可用:${GHOST_LOCALES.join(' / ')})`,
      };
    }
    if (raw.locales.en === undefined) {
      return {
        ok: false,
        reason: 'locales 必须提供 en，作为所有不支持语言的固定回退',
      };
    }
    const normalized: Partial<Record<GhostLocale, string>> = {};
    const seenPaths: string[] = [];
    const skillDirFolds = (
      isPlainObject(raw.skill) && Array.isArray(raw.skill.items) ? raw.skill.items : []
    )
      .map((item) => (isPlainObject(item) ? item.dir : undefined))
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase());
    const manualDirFolds = (
      isPlainObject(raw.manual) && Array.isArray(raw.manual.items) ? raw.manual.items : []
    )
      .map((item) => (isPlainObject(item) ? item.dir : undefined))
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase());
    for (const locale of GHOST_LOCALES) {
      const localePath = raw.locales[locale];
      if (localePath === undefined) continue;
      if (
        typeof localePath !== 'string' ||
        !isSafeGhostRelativePath(localePath) ||
        !localePath.toLowerCase().endsWith('.json')
      ) {
        return {
          ok: false,
          reason: `locales.${locale} 必须是安装目录内以 .json 结尾的安全相对路径`,
        };
      }
      const normalizedLocalePath = localePath.toLowerCase();
      const conflictsWithFile = declaredFilePathFolds.some((path) =>
        pathsConflict(path, normalizedLocalePath),
      );
      const conflictsWithSkillDir = skillDirFolds.some((dir) =>
        isSameOrDescendant(dir, normalizedLocalePath),
      );
      const conflictsWithManualDir = manualDirFolds.some((dir) =>
        pathsConflict(dir, normalizedLocalePath),
      );
      if (conflictsWithFile || conflictsWithSkillDir || conflictsWithManualDir) {
        return {
          ok: false,
          reason: `locales.${locale} 路径 ${JSON.stringify(localePath)} 与插件其他声明文件大小写折叠后冲突`,
        };
      }
      if (seenPaths.includes(normalizedLocalePath)) {
        return {
          ok: false,
          reason: `locales 含重复路径 ${JSON.stringify(localePath)}`,
        };
      }
      if (
        seenPaths.some(
          (path) =>
            isSameOrDescendant(path, normalizedLocalePath) ||
            isSameOrDescendant(normalizedLocalePath, path),
        )
      ) {
        return {
          ok: false,
          reason: `locales.${locale} 路径 ${JSON.stringify(localePath)} 与其他 locale 文件存在祖先路径冲突`,
        };
      }
      seenPaths.push(normalizedLocalePath);
      normalized[locale] = localePath;
    }
    locales = {
      ...normalized,
      en: normalized.en!,
    };
  }
  if (
    raw.description !== undefined &&
    (typeof raw.description !== 'string' ||
      raw.description.trim().length === 0 ||
      raw.description.length > GHOST_MANIFEST_SUMMARY_MAX_CHARS)
  ) {
    return {
      ok: false,
      reason: `description 必须是 1–${GHOST_MANIFEST_SUMMARY_MAX_CHARS} 字符的非空字符串`,
    };
  }
  if (
    raw.whenToUse !== undefined &&
    (typeof raw.whenToUse !== 'string' ||
      raw.whenToUse.trim().length === 0 ||
      raw.whenToUse.length > GHOST_MANIFEST_SUMMARY_MAX_CHARS)
  ) {
    return {
      ok: false,
      reason: `whenToUse 必须是 1–${GHOST_MANIFEST_SUMMARY_MAX_CHARS} 字符的非空字符串`,
    };
  }
  if (raw.icon !== undefined) {
    if (!isSafeGhostRelativePath(raw.icon)) {
      return { ok: false, reason: 'icon 必须是安装目录内的安全相对路径' };
    }
    if (ghostIconMimeType(raw.icon) === null) {
      return {
        ok: false,
        reason: `icon 扩展名不受支持(可用:${Object.keys(GHOST_ICON_MIME_BY_EXT).join(' / ')})`,
      };
    }
  }
  let panel: GhostPanelDecl | undefined;
  if (raw.panel !== undefined) {
    const p = raw.panel;
    if (!isPlainObject(p)) return { ok: false, reason: 'panel 必须是对象' };
    if (
      p.title !== undefined &&
      (typeof p.title !== 'string' || p.title.length === 0 || p.title.length > 64)
    ) {
      return { ok: false, reason: 'panel.title 必须是 1–64 字符的字符串' };
    }
    // 面板一律由意识自绘(html 必填):declaration 时代的静态 body 面板已随
    // 单形态定案(2026-07-12)移除。
    if (!isSafeGhostRelativePath(p.html)) {
      return {
        ok: false,
        reason: 'panel.html 必填,且必须是安装目录内的安全相对路径',
      };
    }
    if (
      p.minWidth !== undefined &&
      (typeof p.minWidth !== 'number' ||
        !Number.isFinite(p.minWidth) ||
        p.minWidth < 120 ||
        p.minWidth > 1200)
    ) {
      return { ok: false, reason: 'panel.minWidth 必须是 120–1200 之间的数字' };
    }
    if (
      p.defaultFraction !== undefined &&
      (typeof p.defaultFraction !== 'number' ||
        !Number.isFinite(p.defaultFraction) ||
        p.defaultFraction < 0.05 ||
        p.defaultFraction > 0.8)
    ) {
      return {
        ok: false,
        reason: 'panel.defaultFraction 必须是 0.05–0.8 之间的数字',
      };
    }
    if (p.position !== undefined) {
      if (p.position === 'top' || p.position === 'bottom') {
        // 收词但明确拒绝(规则 9 不静默降级):上下停靠等布局引擎嵌套分割就绪后开放。
        return {
          ok: false,
          reason: 'panel.position 的 top / bottom 暂未支持(排期中),当前可用:left / right / tab',
        };
      }
      if (!(GHOST_PANEL_POSITIONS as readonly string[]).includes(p.position as string)) {
        return {
          ok: false,
          reason: `panel.position 必须是 ${GHOST_PANEL_POSITIONS.join(' / ')}`,
        };
      }
      // 页签形态没有拖缝宽度语义:收词明确拒绝而非静默忽略(规则 9)。
      if (p.position === 'tab' && (p.minWidth !== undefined || p.defaultFraction !== undefined)) {
        return {
          ok: false,
          reason:
            "panel.minWidth / panel.defaultFraction 仅停靠形态(left / right)有效,position:'tab' 时请移除",
        };
      }
    }
    panel = {
      ...(p.title !== undefined ? { title: p.title as string } : {}),
      ...(p.position !== undefined ? { position: p.position as GhostPanelPosition } : {}),
      html: p.html as string,
      ...(p.minWidth !== undefined ? { minWidth: p.minWidth as number } : {}),
      ...(p.defaultFraction !== undefined ? { defaultFraction: p.defaultFraction as number } : {}),
    };
  }

  let mainView: GhostMainViewDecl | undefined;
  if (raw.mainView !== undefined) {
    if (!isPlainObject(raw.mainView)) {
      return { ok: false, reason: 'mainView 必须是对象' };
    }
    const unknownMainViewField = Object.keys(raw.mainView).find(
      (field) => field !== 'html' && field !== 'title' && field !== 'icon',
    );
    if (unknownMainViewField) {
      return {
        ok: false,
        reason: `mainView 含不允许的字段 ${JSON.stringify(unknownMainViewField)}`,
      };
    }
    if (
      raw.mainView.title !== undefined &&
      (typeof raw.mainView.title !== 'string' ||
        raw.mainView.title.trim().length === 0 ||
        raw.mainView.title.length > 64)
    ) {
      return {
        ok: false,
        reason: 'mainView.title 必须是 1–64 字符的非空字符串',
      };
    }
    if (
      raw.mainView.icon !== undefined &&
      !(GHOST_MAIN_VIEW_ICONS as readonly unknown[]).includes(raw.mainView.icon)
    ) {
      return {
        ok: false,
        reason: `mainView.icon 必须是以下系统图标之一:${GHOST_MAIN_VIEW_ICONS.join(' / ')}`,
      };
    }
    if (!isSafeGhostRelativePath(raw.mainView.html)) {
      return {
        ok: false,
        reason: 'mainView.html 必填，且必须是安装目录内的安全相对路径',
      };
    }
    mainView = {
      ...(raw.mainView.title !== undefined ? { title: raw.mainView.title } : {}),
      ...(raw.mainView.icon !== undefined ? { icon: raw.mainView.icon as GhostMainViewIcon } : {}),
      html: raw.mainView.html,
    };
  }

  if (!isSafeGhostRelativePath(raw.entry)) {
    return {
      ok: false,
      reason: '必须提供 entry(安装目录内的安全相对路径,电子脑逻辑入口)',
    };
  }
  if (
    raw.launch !== undefined &&
    !(GHOST_LAUNCH_MODES as readonly string[]).includes(raw.launch as string)
  ) {
    return {
      ok: false,
      reason: `launch 必须是 ${GHOST_LAUNCH_MODES.join(' / ')}`,
    };
  }
  if (raw.settingsHtml !== undefined && !isSafeGhostRelativePath(raw.settingsHtml)) {
    return { ok: false, reason: 'settingsHtml 必须是安装目录内的安全相对路径' };
  }
  if (raw.settingsHeight !== undefined) {
    if (raw.settingsHtml === undefined) {
      return {
        ok: false,
        reason: '声明了 settingsHeight 但没有 settingsHtml——没有界面就没有高度可言',
      };
    }
    if (
      typeof raw.settingsHeight !== 'number' ||
      !Number.isFinite(raw.settingsHeight) ||
      raw.settingsHeight < 160 ||
      raw.settingsHeight > 800
    ) {
      return { ok: false, reason: 'settingsHeight 必须是 160–800 之间的数字' };
    }
  }
  if (!Array.isArray(raw.slots)) {
    return { ok: false, reason: 'schemaVersion 2 的 slots 必须是数组' };
  }
  const slots: LegacyGhostSlot[] = [];
  for (const s of raw.slots) {
    // 旧名兼容:'model' 静默归一化为 'cindy'(2026-07-11 更名,已装老包不消失)。
    const name = s === 'model' ? 'cindy' : s;
    if (typeof name !== 'string' || !GHOST_SLOT_NAME_RE.test(name)) {
      return {
        ok: false,
        reason: `slots 含格式非法的卡槽名称 ${JSON.stringify(s)}`,
      };
    }
    if (slots.includes(name)) {
      return { ok: false, reason: `slots 含重复卡槽 ${JSON.stringify(s)}` };
    }
    slots.push(name);
  }
  // 声明了面板却没申请 panel 槽(或反之有槽无面板)都是清单自相矛盾。
  if (panel !== undefined && !slots.includes('panel')) {
    return { ok: false, reason: '声明了 panel 但 slots 未包含 "panel"' };
  }
  if (slots.includes('panel') && panel === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "panel" 但缺少 panel(面板由意识自绘,html 必填)',
    };
  }
  if (mainView !== undefined && !slots.includes('main-view')) {
    return { ok: false, reason: '声明了 mainView 但 slots 未包含 "main-view"' };
  }
  if (slots.includes('main-view') && mainView === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "main-view" 但缺少 mainView(html 必填)',
    };
  }
  if (slots.includes('badge') && panel === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "badge" 但缺少 panel——未读点必须有可打开的面板内容',
    };
  }

  // card 槽能力详单:缺省 = 仅渲染;externalLinks: true 是独立加档权限。
  let card: GhostCardNeeds | undefined;
  if (raw.card !== undefined) {
    if (!isPlainObject(raw.card)) {
      return {
        ok: false,
        reason: 'card 能力详单必须是对象(如 { "externalLinks": true })',
      };
    }
    if (!slots.includes('card')) {
      return {
        ok: false,
        reason: '声明了 card 能力详单但 slots 未包含 "card"',
      };
    }
    const cardRaw = raw.card as Record<string, unknown>;
    const unknownCardField = Object.keys(cardRaw).find((key) => key !== 'externalLinks');
    if (unknownCardField) {
      return {
        ok: false,
        reason: `card 含不允许的字段 ${JSON.stringify(unknownCardField)}`,
      };
    }
    if (cardRaw.externalLinks !== undefined && typeof cardRaw.externalLinks !== 'boolean') {
      return { ok: false, reason: 'card.externalLinks 必须是布尔值' };
    }
    if (cardRaw.externalLinks === true) {
      card = { externalLinks: true };
    }
  }

  // 工具声明(卡槽②):与 slots 含 'tool' 严格成对,规则同 panel。
  let tools: GhostToolDecl[] | undefined;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools) || raw.tools.length === 0 || raw.tools.length > 16) {
      return { ok: false, reason: 'tools 必须是 1–16 项的数组' };
    }
    tools = [];
    const seenNames = new Set<string>();
    for (const t of raw.tools) {
      if (!isPlainObject(t)) return { ok: false, reason: 'tools 每项必须是对象' };
      if (typeof t.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(t.name)) {
        return {
          ok: false,
          reason: 'tools[].name 必须是小写字母开头的 1–64 位小写/数字/下划线/连字符',
        };
      }
      if (seenNames.has(t.name))
        return {
          ok: false,
          reason: `tools 含重名工具 ${JSON.stringify(t.name)}`,
        };
      seenNames.add(t.name);
      if (
        typeof t.description !== 'string' ||
        t.description.trim().length === 0 ||
        t.description.length > 1024
      ) {
        return {
          ok: false,
          reason: 'tools[].description 必须是 1–1024 字符的非空字符串',
        };
      }
      if (t.parameters !== undefined) {
        if (!isPlainObject(t.parameters))
          return {
            ok: false,
            reason: 'tools[].parameters 必须是对象(JSON Schema)',
          };
        try {
          if (JSON.stringify(t.parameters).length > 16_384) {
            return { ok: false, reason: 'tools[].parameters 过大(上限 16KB)' };
          }
        } catch {
          return { ok: false, reason: 'tools[].parameters 必须可序列化' };
        }
      }
      tools.push({
        name: t.name,
        description: t.description,
        ...(t.parameters !== undefined
          ? { parameters: t.parameters as Record<string, unknown> }
          : {}),
      });
    }
  }
  if (tools !== undefined && !slots.includes('tool')) {
    return { ok: false, reason: '声明了 tools 但 slots 未包含 "tool"' };
  }
  if (slots.includes('tool') && tools === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "tool" 但缺少 tools(注册什么工具要写清楚)',
    };
  }

  // cindy 槽能力详单:与 slots 含 'cindy' 成对(有详单必有槽;有槽无详单
  // 允许装入但运行时零能力——老包不消失,只是代办被拒并提示作者更新)。
  // 字段旧名 model 作别名收入(两个都写以 cindy 为准)。
  const cindyRaw =
    raw.cindy !== undefined ? raw.cindy : prepared.schemaVersion === 2 ? raw.model : undefined;
  let cindy: GhostCindyNeeds | undefined;
  if (cindyRaw !== undefined) {
    if (!isPlainObject(cindyRaw)) {
      return {
        ok: false,
        reason: 'cindy 能力详单必须是对象(如 { "image": ["generate"] })',
      };
    }
    if (!slots.includes('cindy')) {
      return {
        ok: false,
        reason: '声明了 cindy 能力详单但 slots 未包含 "cindy"',
      };
    }
    cindy = {};
    // 类目 → 合法动作表(image / video / media / text / embed / search;动作集恰好
    // 同名,但按类目查表,未来某类目动作分叉时这里天然承接)。
    const actionTable: Record<string, readonly string[]> = {
      image: GHOST_MODEL_IMAGE_ACTIONS,
      video: GHOST_MODEL_VIDEO_ACTIONS,
      media: GHOST_CINDY_MEDIA_ACTIONS,
      text: GHOST_CINDY_TEXT_ACTIONS,
      embed: GHOST_CINDY_EMBED_ACTIONS,
      search: GHOST_CINDY_SEARCH_ACTIONS,
    };
    for (const [category, actionsRaw] of Object.entries(cindyRaw)) {
      if (category === 'oneshotModel') continue; // 标量意图键,不是类目,单独校验
      const allowed = actionTable[category];
      if (!allowed) {
        return {
          ok: false,
          reason: `cindy 含未知能力类目 ${JSON.stringify(category)}(当前支持:${Object.keys(actionTable).join(' / ')})`,
        };
      }
      if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
        return { ok: false, reason: `cindy.${category} 必须是非空数组` };
      }
      const actions: string[] = [];
      for (const a of actionsRaw) {
        if (typeof a !== 'string' || !allowed.includes(a)) {
          return {
            ok: false,
            reason: `cindy.${category} 含未知动作 ${JSON.stringify(a)}(可用:${allowed.join(' / ')})`,
          };
        }
        if (actions.includes(a)) {
          return {
            ok: false,
            reason: `cindy.${category} 含重复动作 ${JSON.stringify(a)}`,
          };
        }
        actions.push(a);
      }
      if (category === 'image') cindy.image = actions as GhostModelImageAction[];
      else if (category === 'video') cindy.video = actions as GhostModelVideoAction[];
      else if (category === 'media') cindy.media = actions as GhostCindyMediaAction[];
      else if (category === 'text') cindy.text = actions as GhostCindyTextAction[];
      else if (category === 'embed') cindy.embed = actions as GhostCindyEmbedAction[];
      else if (category === 'search') cindy.search = actions as GhostCindySearchAction[];
      else
        return {
          ok: false,
          reason: `cindy 能力类目 ${JSON.stringify(category)} 尚未接线(协议缺陷)`,
        };
    }
    if (
      cindy.image === undefined &&
      cindy.video === undefined &&
      cindy.media === undefined &&
      cindy.text === undefined &&
      cindy.embed === undefined &&
      cindy.search === undefined
    ) {
      return { ok: false, reason: 'cindy 能力详单不能是空对象' };
    }
    // oneshotModel(快问快答偏好模型)是标量意图键,不是类目:先摘出,不进类目循环。
    const oneshotModelRaw = cindyRaw.oneshotModel;
    if (oneshotModelRaw !== undefined) {
      if (
        typeof oneshotModelRaw !== 'string' ||
        oneshotModelRaw.trim().length === 0 ||
        oneshotModelRaw.length > 128
      ) {
        return {
          ok: false,
          reason: 'cindy.oneshotModel 必须是 1–128 字符的目录模型 id(如 "codex/gpt-5.5")',
        };
      }
      if (!cindy.text?.includes('oneshot')) {
        return {
          ok: false,
          reason: 'cindy.oneshotModel 必须与 text 含 "oneshot" 成对声明(它是快问快答的偏好模型)',
        };
      }
      cindy.oneshotModel = oneshotModelRaw.trim();
    }
    if (cindy.search?.includes('web') && (!slots.includes('tool') || tools === undefined)) {
      return {
        ok: false,
        reason: 'cindy.search.web 只允许由真实 tool-call 触发，必须同时声明 "tool" 槽和 tools',
      };
    }
  }

  // 订阅槽详单(卡槽①):与 slots 含 'subscribe' 成对(有详单必有槽;有槽
  // 无详单允许装入但零事件,同 cindy 语义)。硬规则:声明了 hooks(拦截)
  // 必须 launch:'resident'——要挡路就得常驻在场,每条消息等冷启动不可接受。
  let subscribe: GhostSubscribeNeeds | undefined;
  if (raw.subscribe !== undefined) {
    if (!isPlainObject(raw.subscribe)) {
      return {
        ok: false,
        reason: 'subscribe 订阅详单必须是对象(如 { "topics": ["turn"] })',
      };
    }
    if (!slots.includes('subscribe')) {
      return {
        ok: false,
        reason: '声明了 subscribe 订阅详单但 slots 未包含 "subscribe"',
      };
    }
    subscribe = {};
    const subRaw = raw.subscribe as Record<string, unknown>;
    for (const [field, allowed] of [
      ['topics', GHOST_SUBSCRIBE_TOPICS],
      ['hooks', GHOST_SUBSCRIBE_HOOKS],
    ] as const) {
      const listRaw = subRaw[field];
      if (listRaw === undefined) continue;
      if (!Array.isArray(listRaw) || listRaw.length === 0) {
        return { ok: false, reason: `subscribe.${field} 必须是非空数组` };
      }
      const list: string[] = [];
      for (const item of listRaw) {
        if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
          return {
            ok: false,
            reason: `subscribe.${field} 含未知项 ${JSON.stringify(item)}(可用:${allowed.join(' / ')})`,
          };
        }
        if (list.includes(item)) {
          return {
            ok: false,
            reason: `subscribe.${field} 含重复项 ${JSON.stringify(item)}`,
          };
        }
        list.push(item);
      }
      if (field === 'topics') subscribe.topics = list as GhostSubscribeTopic[];
      else subscribe.hooks = list as GhostSubscribeHook[];
    }
    if (subscribe.topics === undefined && subscribe.hooks === undefined) {
      return { ok: false, reason: 'subscribe 订阅详单不能是空对象' };
    }
    if (subscribe.hooks !== undefined && raw.launch !== 'resident') {
      return {
        ok: false,
        reason:
          '声明了 subscribe.hooks(拦截钩子)必须同时声明 launch: "resident"——拦截要求常驻在场,否则每条消息都要等冷启动',
      };
    }
  }

  // network 槽详单:与 slots 含 'network' 成对(有详单必有槽;有槽
  // 无详单允许装入但零能力,同 cindy / subscribe 语义)。hosts 是核心声明;
  // secrets 每条必须带 inject(没有注入位置的凭证无处可用),inject.hosts
  // 必须是 hosts 声明条目的子集——结构上钉死"key 只流向它声明的域名"。
  let network: GhostNetworkNeeds | undefined;
  if (raw.network !== undefined) {
    if (!isPlainObject(raw.network)) {
      return {
        ok: false,
        reason: 'network 详单必须是对象(如 { "hosts": ["api.example.com"] })',
      };
    }
    if (!slots.includes('network')) {
      return {
        ok: false,
        reason: '声明了 network 详单但 slots 未包含 "network"',
      };
    }
    const n = raw.network as Record<string, unknown>;
    // 连接声明在场性先探一眼(合法性下面细验):静态 hosts 的必填性依赖它——
    // 声明了 connections(动态连接地址)时 hosts 允许缺省/空数组,否则维持
    // 原规则必填 1–8 条(静态域名与动态连接至少有其一)。
    const hasConnectionDecls = Array.isArray(n.connections) && n.connections.length > 0;
    if (n.hosts === undefined && !hasConnectionDecls) {
      return {
        ok: false,
        reason: `network.hosts 必须是 1–${GHOST_NETWORK_MAX_HOSTS} 条的数组(仅声明了 network.connections 时才可缺省)`,
      };
    }
    if (
      n.hosts !== undefined &&
      (!Array.isArray(n.hosts) || n.hosts.length > GHOST_NETWORK_MAX_HOSTS)
    ) {
      return {
        ok: false,
        reason: `network.hosts 必须是 1–${GHOST_NETWORK_MAX_HOSTS} 条的数组`,
      };
    }
    if (Array.isArray(n.hosts) && n.hosts.length === 0 && !hasConnectionDecls) {
      return {
        ok: false,
        reason: `network.hosts 必须是 1–${GHOST_NETWORK_MAX_HOSTS} 条的数组(仅声明了 network.connections 时才允许为空)`,
      };
    }
    const hosts: string[] = [];
    for (const h of Array.isArray(n.hosts) ? n.hosts : []) {
      if (typeof h !== 'string' || !isValidGhostNetworkHostPattern(h.trim().toLowerCase())) {
        return {
          ok: false,
          reason: `network.hosts 含非法条目 ${JSON.stringify(h)}(小写域名、至少两段、通配只允许最左 "*.";不收 IP / 端口 / 路径 / 协议)`,
        };
      }
      const host = h.trim().toLowerCase();
      if (hosts.includes(host)) {
        return {
          ok: false,
          reason: `network.hosts 含重复条目 ${JSON.stringify(h)}`,
        };
      }
      hosts.push(host);
    }
    let secrets: GhostSecretDecl[] | undefined;
    if (n.secrets !== undefined) {
      if (
        !Array.isArray(n.secrets) ||
        n.secrets.length === 0 ||
        n.secrets.length > GHOST_NETWORK_MAX_SECRETS
      ) {
        return {
          ok: false,
          reason: `network.secrets 必须是 1–${GHOST_NETWORK_MAX_SECRETS} 条的数组`,
        };
      }
      secrets = [];
      const seenKeys = new Set<string>();
      for (const s of n.secrets) {
        if (!isPlainObject(s)) return { ok: false, reason: 'network.secrets 每项必须是对象' };
        if (typeof s.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(s.key)) {
          return {
            ok: false,
            reason: 'network.secrets[].key 必须是小写字母开头的 1–32 位小写/数字/下划线',
          };
        }
        if (seenKeys.has(s.key)) {
          return {
            ok: false,
            reason: `network.secrets 含重复 key ${JSON.stringify(s.key)}`,
          };
        }
        seenKeys.add(s.key);
        if (typeof s.label !== 'string' || s.label.trim().length === 0 || s.label.length > 64) {
          return {
            ok: false,
            reason: 'network.secrets[].label 必须是 1–64 字符的非空字符串',
          };
        }
        // 来源:缺省 'user';'login-email' = 主机登录邮箱派生(用户不填值)。
        // 归一化:'user' 不落清单(与缺省同义,权限 diff 不 churn)。
        let source: GhostSecretSource | undefined;
        if (s.source !== undefined) {
          if (
            typeof s.source !== 'string' ||
            !(GHOST_SECRET_SOURCES as readonly string[]).includes(s.source)
          ) {
            return {
              ok: false,
              reason: `network.secrets[].source 仅支持 ${GHOST_SECRET_SOURCES.join(' / ')}(缺省 user)`,
            };
          }
          if (s.source === 'login-email') source = 'login-email';
          if (s.source === 'oauth') source = 'oauth';
          if (s.source === 'login-feishu-token') source = 'login-feishu-token';
          if (s.source === 'oidc-token') source = 'oidc-token';
          if (s.source === 'gh-cli') source = 'gh-cli';
        }
        // 输入面字段已退役(2026-07-13 宿主凭证渲染整体退役):user 凭证
        // 一律意识 settingsHtml 收单。遗留 `input: "ghost"` 接受并忽略
        // (与现状同义、不落清单);其余值(含 'host')一律拒。
        if (s.input !== undefined && s.input !== 'ghost') {
          return {
            ok: false,
            reason:
              'network.secrets[].input 已退役:宿主收单不存在,用户填写的凭证一律由意识 settingsHtml 收单(删掉 input 字段即可;唯一可接受的遗留值是 "ghost")',
          };
        }
        // login-email / login-feishu-token 同族:值取自主机登录态派生,用户
        // 不填、没有输入面,禁 url / exchange,settingsHtml 豁免。oidc-token
        // 同样由 Host 托管,但值来自当前组织 Membership 的 Connection JWT。
        const loginDerived = source === 'login-email' || source === 'login-feishu-token';
        const oidcManaged = source === 'oidc-token';
        const ghCliManaged = source === 'gh-cli';
        if (s.input === 'ghost' && (loginDerived || oidcManaged || ghCliManaged)) {
          return {
            ok: false,
            reason: `source: ${source} 的凭证不允许标注 input: ghost(Host 托管凭证没有输入,谈不上谁收单)`,
          };
        }
        if (!loginDerived && !oidcManaged && raw.settingsHtml === undefined) {
          return {
            ok: false,
            reason:
              'network.secrets 声明了用户填写的凭证时必须同时声明 settingsHtml(凭证由意识设置界面收单,没有界面就没人收单;宿主渲染输入行已退役)',
          };
        }
        if (loginDerived && s.url !== undefined) {
          return {
            ok: false,
            reason: `network.secrets[].source 为 ${source} 时不允许声明 url(值取自主机登录态,没有"前往控制台"可去)`,
          };
        }
        if (loginDerived && s.exchange !== undefined) {
          // 组合会把登录态凭证作为原始值 POST 给交换端点,而确认框文案只
          // 承诺"派生注入请求头"——语义盖不住,结构上禁掉(有真实场景再议)。
          return {
            ok: false,
            reason: `network.secrets[].source 为 ${source} 时不允许声明 exchange(登录态凭证不外送交换端点)`,
          };
        }
        if (oidcManaged && s.url !== undefined) {
          return {
            ok: false,
            reason: 'network.secrets[].source 为 oidc-token 时不允许声明 url(令牌由 Host 按需签发)',
          };
        }
        if (oidcManaged && s.exchange !== undefined) {
          return {
            ok: false,
            reason:
              'network.secrets[].source 为 oidc-token 时不允许声明 exchange(不允许把 Connection JWT 转交给第三方端点)',
          };
        }
        if (ghCliManaged && s.exchange !== undefined) {
          return {
            ok: false,
            reason:
              'network.secrets[].source 为 gh-cli 时不允许声明 exchange(不允许把 GitHub 登录令牌转交给第三方端点)',
          };
        }
        if (
          s.hint !== undefined &&
          (typeof s.hint !== 'string' || s.hint.trim().length === 0 || s.hint.length > 200)
        ) {
          return {
            ok: false,
            reason: 'network.secrets[].hint 必须是 1–200 字符的非空字符串',
          };
        }
        if (s.url !== undefined) {
          if (typeof s.url !== 'string' || s.url.length === 0 || s.url.length > 200) {
            return {
              ok: false,
              reason: 'network.secrets[].url 必须是 1–200 字符的字符串',
            };
          }
          let parsed: URL;
          try {
            parsed = new URL(s.url);
          } catch {
            return {
              ok: false,
              reason: 'network.secrets[].url 不是合法的绝对地址',
            };
          }
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            return {
              ok: false,
              reason: 'network.secrets[].url 仅支持 https 且不允许内嵌用户名/密码',
            };
          }
        }
        if (!isPlainObject(s.inject)) {
          return {
            ok: false,
            reason: `network.secrets[${JSON.stringify(s.key)}].inject 必填(凭证要声明注入到哪个请求头)`,
          };
        }
        const inj = s.inject as Record<string, unknown>;
        if (typeof inj.header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(inj.header)) {
          return {
            ok: false,
            reason: 'network.secrets[].inject.header 必须是 1–64 位字母/数字/连字符的头名',
          };
        }
        if (GHOST_NETWORK_FORBIDDEN_INJECT_HEADERS.includes(inj.header.toLowerCase())) {
          return {
            ok: false,
            reason: `network.secrets[].inject.header 不允许使用协议关键头 ${JSON.stringify(inj.header)}`,
          };
        }
        if (
          typeof inj.format !== 'string' ||
          inj.format.length === 0 ||
          inj.format.length > 200 ||
          inj.format.split('{value}').length !== 2
        ) {
          return {
            ok: false,
            reason:
              'network.secrets[].inject.format 必须是 ≤200 字符且恰含一个 {value} 占位的字符串(如 "Bearer {value}")',
          };
        }
        let injectHosts: string[] | undefined;
        if (inj.hosts !== undefined) {
          if (!Array.isArray(inj.hosts) || inj.hosts.length === 0) {
            return {
              ok: false,
              reason: 'network.secrets[].inject.hosts 必须是非空数组(或省略 = 全部白名单域名)',
            };
          }
          injectHosts = [];
          for (const ih of inj.hosts) {
            if (typeof ih !== 'string' || !hosts.includes(ih.trim().toLowerCase())) {
              return {
                ok: false,
                reason: `network.secrets[].inject.hosts 含 ${JSON.stringify(ih)}——必须逐字取自 network.hosts 声明条目`,
              };
            }
            const ihNorm = ih.trim().toLowerCase();
            if (injectHosts.includes(ihNorm)) {
              return {
                ok: false,
                reason: `network.secrets[].inject.hosts 含重复条目 ${JSON.stringify(ih)}`,
              };
            }
            injectHosts.push(ihNorm);
          }
        }
        if (oidcManaged) {
          if (inj.header !== 'Authorization' || inj.format !== 'Bearer {value}') {
            return {
              ok: false,
              reason:
                'network.secrets[].source 为 oidc-token 时 inject 必须是 Authorization: Bearer {value}',
            };
          }
          if (injectHosts === undefined || injectHosts.length === 0) {
            return {
              ok: false,
              reason: 'network.secrets[].source 为 oidc-token 时必须显式声明非空 inject.hosts',
            };
          }
          if (injectHosts.some((host) => host.startsWith('*.'))) {
            return {
              ok: false,
              reason:
                'network.secrets[].source 为 oidc-token 时 inject.hosts 只允许精确域名,不允许通配',
            };
          }
        }
        if (ghCliManaged) {
          if (inj.header !== 'Authorization' || inj.format !== 'Bearer {value}') {
            return {
              ok: false,
              reason:
                'network.secrets[].source 为 gh-cli 时 inject 必须是 Authorization: Bearer {value}',
            };
          }
          if (
            injectHosts === undefined ||
            injectHosts.length !== 1 ||
            injectHosts[0] !== 'api.github.com'
          ) {
            return {
              ok: false,
              reason:
                'network.secrets[].source 为 gh-cli 时 inject.hosts 必须且只能是 api.github.com',
            };
          }
        }
        // oauth(source: 'oauth' 时必填):主机托管 OAuth 授权详单。授权页与
        // token 端点域名都必须落在 hosts 白名单内——确认框展示的域名集合就是
        // 全部出网面(clientSecret 只流向 tokenUrl,授权只发生在 authorizeUrl)。
        let oauth: GhostSecretOauthDecl | undefined;
        if (source === 'oauth' && s.oauth === undefined) {
          return {
            ok: false,
            reason: `network.secrets[${JSON.stringify(s.key)}].oauth 必填(source: oauth 的凭证要声明去哪授权)`,
          };
        }
        if (source !== 'oauth' && s.oauth !== undefined) {
          return {
            ok: false,
            reason: 'network.secrets[].oauth 仅允许在 source: oauth 的凭证上声明',
          };
        }
        if (source === 'oauth' && s.exchange !== undefined) {
          // access token 已是最终注入物,再叠一段 key 换令牌没有语义。
          return {
            ok: false,
            reason:
              'network.secrets[].source 为 oauth 时不允许声明 exchange(access token 直接注入,无二段交换)',
          };
        }
        if (s.oauth !== undefined) {
          if (!isPlainObject(s.oauth)) {
            return {
              ok: false,
              reason: `network.secrets[${JSON.stringify(s.key)}].oauth 必须是对象`,
            };
          }
          const oa = s.oauth as Record<string, unknown>;
          const parseHostBoundUrl = (
            raw2: unknown,
            field: string,
          ): { ok: true; url: string } | { ok: false; reason: string } => {
            if (typeof raw2 !== 'string' || raw2.length === 0 || raw2.length > 2048) {
              return {
                ok: false,
                reason: `network.secrets[].oauth.${field} 必须是 1–2048 字符的字符串`,
              };
            }
            let parsed2: URL;
            try {
              parsed2 = new URL(raw2);
            } catch {
              return {
                ok: false,
                reason: `network.secrets[].oauth.${field} 不是合法的绝对地址`,
              };
            }
            if (
              parsed2.protocol !== 'https:' ||
              parsed2.port !== '' ||
              parsed2.username ||
              parsed2.password
            ) {
              return {
                ok: false,
                reason: `network.secrets[].oauth.${field} 仅支持 https 默认端口且不允许内嵌用户名/密码`,
              };
            }
            if (!hosts.some((pattern) => ghostNetworkHostMatches(pattern, parsed2.hostname))) {
              return {
                ok: false,
                reason: `network.secrets[].oauth.${field} 的域名 ${JSON.stringify(parsed2.hostname)} 必须命中 network.hosts 白名单`,
              };
            }
            return { ok: true, url: raw2 };
          };
          const authorizeParsed = parseHostBoundUrl(oa.authorizeUrl, 'authorizeUrl');
          if (!authorizeParsed.ok) return authorizeParsed;
          const tokenParsed = parseHostBoundUrl(oa.tokenUrl, 'tokenUrl');
          if (!tokenParsed.ok) return tokenParsed;
          // 内置 client 凭证(可选,成对语义:secret 不许孤儿声明)。
          if (oa.clientId !== undefined) {
            if (
              typeof oa.clientId !== 'string' ||
              oa.clientId.trim().length === 0 ||
              oa.clientId.length > 200 ||
              /\s/.test(oa.clientId)
            ) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.clientId 必须是 1–200 字符、不含空白的字符串',
              };
            }
          }
          let oaClientIdAlternatives: string[] | undefined;
          if (oa.clientIdAlternatives !== undefined) {
            if (oa.clientId === undefined) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.clientIdAlternatives 必须与默认 clientId 一起声明',
              };
            }
            if (
              !Array.isArray(oa.clientIdAlternatives) ||
              oa.clientIdAlternatives.length === 0 ||
              oa.clientIdAlternatives.length > GHOST_OAUTH_CLIENT_ID_ALTERNATIVES_MAX
            ) {
              return {
                ok: false,
                reason: `network.secrets[].oauth.clientIdAlternatives 必须是 1–${GHOST_OAUTH_CLIENT_ID_ALTERNATIVES_MAX} 条的数组`,
              };
            }
            oaClientIdAlternatives = [];
            for (const clientId of oa.clientIdAlternatives) {
              if (
                typeof clientId !== 'string' ||
                clientId.trim().length === 0 ||
                clientId.length > 200 ||
                /\s/.test(clientId)
              ) {
                return {
                  ok: false,
                  reason:
                    'network.secrets[].oauth.clientIdAlternatives 含非法条目(须为 1–200 字符、不含空白的字符串)',
                };
              }
              if (clientId === oa.clientId || oaClientIdAlternatives.includes(clientId)) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.clientIdAlternatives 含重复条目 ${JSON.stringify(clientId)}`,
                };
              }
              oaClientIdAlternatives.push(clientId);
            }
          }
          if (oa.clientSecret !== undefined) {
            if (oa.clientId === undefined) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.clientSecret 必须与 clientId 成对声明',
              };
            }
            if (
              typeof oa.clientSecret !== 'string' ||
              oa.clientSecret.trim().length === 0 ||
              oa.clientSecret.length > 200 ||
              /\s/.test(oa.clientSecret)
            ) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.clientSecret 必须是 1–200 字符、不含空白的字符串',
              };
            }
          }
          let oaScopes: string[] | undefined;
          if (oa.scopes !== undefined) {
            if (!Array.isArray(oa.scopes) || oa.scopes.length > GHOST_OAUTH_SCOPES_MAX) {
              return {
                ok: false,
                reason: `network.secrets[].oauth.scopes 必须是 ≤${GHOST_OAUTH_SCOPES_MAX} 条的数组`,
              };
            }
            oaScopes = [];
            for (const sc of oa.scopes) {
              if (
                typeof sc !== 'string' ||
                sc.trim().length === 0 ||
                sc.length > 200 ||
                /\s/.test(sc)
              ) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.scopes 含非法条目 ${JSON.stringify(sc)}(1–200 字符、不含空白)`,
                };
              }
              if (oaScopes.includes(sc)) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.scopes 含重复条目 ${JSON.stringify(sc)}`,
                };
              }
              oaScopes.push(sc);
            }
          }
          if (oa.pkce !== undefined && typeof oa.pkce !== 'boolean') {
            return {
              ok: false,
              reason: 'network.secrets[].oauth.pkce 必须是布尔值(缺省 true)',
            };
          }
          if (oa.scopeDelimiter !== undefined && oa.scopeDelimiter !== ',') {
            return {
              ok: false,
              reason: 'network.secrets[].oauth.scopeDelimiter 目前只支持 ","(缺省 = 空格拼接)',
            };
          }
          let oaExtra: Record<string, string> | undefined;
          if (oa.extraAuthorizeParams !== undefined) {
            if (!isPlainObject(oa.extraAuthorizeParams)) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.extraAuthorizeParams 必须是对象',
              };
            }
            const entries = Object.entries(oa.extraAuthorizeParams as Record<string, unknown>);
            if (entries.length === 0 || entries.length > GHOST_OAUTH_EXTRA_PARAMS_MAX) {
              return {
                ok: false,
                reason: `network.secrets[].oauth.extraAuthorizeParams 必须是 1–${GHOST_OAUTH_EXTRA_PARAMS_MAX} 条(或省略)`,
              };
            }
            oaExtra = {};
            for (const [pk, pv] of entries) {
              if (!/^[a-z][a-z0-9_]{0,31}$/.test(pk)) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.extraAuthorizeParams 键 ${JSON.stringify(pk)} 必须是小写字母开头的 1–32 位小写/数字/下划线`,
                };
              }
              if (GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS.includes(pk)) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.extraAuthorizeParams 不允许声明协议保留参数 ${JSON.stringify(pk)}`,
                };
              }
              if (typeof pv !== 'string' || pv.length === 0 || pv.length > 200) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.extraAuthorizeParams[${JSON.stringify(pk)}] 必须是 1–200 字符的字符串`,
                };
              }
              oaExtra[pk] = pv;
            }
          }
          // redirectPort(可选):loopback 回调固定端口(Atlassian 等回调精确匹配)。
          if (oa.redirectPort !== undefined) {
            if (
              typeof oa.redirectPort !== 'number' ||
              !Number.isInteger(oa.redirectPort) ||
              oa.redirectPort < 1024 ||
              oa.redirectPort > 65535
            ) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.redirectPort 必须是 1024–65535 的整数',
              };
            }
          }
          // tokenBroker(可选):服务端 broker slug;secret 在服务端,与
          // clientSecret 互斥(同时声明说明作者没想清 secret 到底在哪)。
          if (oa.tokenBroker !== undefined) {
            if (
              typeof oa.tokenBroker !== 'string' ||
              !GHOST_OAUTH_TOKEN_BROKER_RE.test(oa.tokenBroker)
            ) {
              return {
                ok: false,
                reason:
                  'network.secrets[].oauth.tokenBroker 必须是小写字母开头的 1–32 位小写/数字/下划线/连字符',
              };
            }
            if (oa.clientSecret !== undefined) {
              return {
                ok: false,
                reason:
                  'network.secrets[].oauth.tokenBroker 与 clientSecret 互斥(broker 模式下 secret 由服务端持有,不随包分发)',
              };
            }
          }
          if (oaClientIdAlternatives !== undefined && oa.tokenBroker === undefined) {
            return {
              ok: false,
              reason: 'network.secrets[].oauth.clientIdAlternatives 仅允许与 tokenBroker 一起声明',
            };
          }
          // brokerBounce(可选):双地址弹跳回调,必须与 tokenBroker + redirectPort
          // 成套声明(302 目标端口/路径在 broker 服务端写死,三者是一套约定)。
          let oaBounce: { path: string; callbackPath: string } | undefined;
          if (oa.brokerBounce !== undefined) {
            if (oa.tokenBroker === undefined || oa.redirectPort === undefined) {
              return {
                ok: false,
                reason:
                  'network.secrets[].oauth.brokerBounce 必须与 tokenBroker、redirectPort 同时声明',
              };
            }
            if (!isPlainObject(oa.brokerBounce)) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.brokerBounce 必须是对象',
              };
            }
            const bb = oa.brokerBounce as Record<string, unknown>;
            for (const field of ['path', 'callbackPath'] as const) {
              const v = bb[field];
              if (typeof v !== 'string' || v.length > 128 || !GHOST_OAUTH_BOUNCE_PATH_RE.test(v)) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.brokerBounce.${field} 必须是 / 开头的站内绝对路径(段字符限字母/数字/_/-,≤128 字符)`,
                };
              }
            }
            oaBounce = {
              path: bb.path as string,
              callbackPath: bb.callbackPath as string,
            };
          }
          let oaIdentity:
            | {
                url: string;
                labelPath: string;
                displayTemplate?: string;
                avatarPath?: string;
              }
            | undefined;
          if (oa.identity !== undefined) {
            if (!isPlainObject(oa.identity)) {
              return {
                ok: false,
                reason: 'network.secrets[].oauth.identity 必须是对象',
              };
            }
            const idn = oa.identity as Record<string, unknown>;
            const idnUrl = parseHostBoundUrl(idn.url, 'identity.url');
            if (!idnUrl.ok) return idnUrl;
            if (
              typeof idn.labelPath !== 'string' ||
              idn.labelPath.length > 128 ||
              !GHOST_SECRET_EXCHANGE_TOKEN_PATH_RE.test(idn.labelPath)
            ) {
              return {
                ok: false,
                reason:
                  'network.secrets[].oauth.identity.labelPath 必须是 ≤128 字符的点分路径(段名限字母/数字/_/-,如 "email" / "user.name")',
              };
            }
            // displayTemplate(可选):展示名模板,占位符 `{点分路径}`(路径
            // 形状同 labelPath),至少一个占位符——纯静态字符串没有"身份展示"
            // 语义,多半是作者笔误。
            let idnTemplate: string | undefined;
            if (idn.displayTemplate !== undefined) {
              if (
                typeof idn.displayTemplate !== 'string' ||
                idn.displayTemplate.length === 0 ||
                idn.displayTemplate.length > GHOST_OAUTH_IDENTITY_TEMPLATE_MAX_CHARS
              ) {
                return {
                  ok: false,
                  reason: `network.secrets[].oauth.identity.displayTemplate 必须是 1–${GHOST_OAUTH_IDENTITY_TEMPLATE_MAX_CHARS} 字符的字符串`,
                };
              }
              const placeholders = [
                ...idn.displayTemplate.matchAll(GHOST_OAUTH_IDENTITY_TEMPLATE_PLACEHOLDER_RE),
              ];
              if (placeholders.length === 0) {
                return {
                  ok: false,
                  reason:
                    'network.secrets[].oauth.identity.displayTemplate 必须含至少一个 {点分路径} 占位符(如 "{team} · {user}")',
                };
              }
              for (const m of placeholders) {
                const p = m[1] ?? '';
                if (p.length > 128 || !GHOST_SECRET_EXCHANGE_TOKEN_PATH_RE.test(p)) {
                  return {
                    ok: false,
                    reason: `network.secrets[].oauth.identity.displayTemplate 占位符 {${p}} 不是合法点分路径(段名限字母/数字/_/-)`,
                  };
                }
              }
              idnTemplate = idn.displayTemplate;
            }
            let idnAvatarPath: string | undefined;
            if (idn.avatarPath !== undefined) {
              if (
                typeof idn.avatarPath !== 'string' ||
                idn.avatarPath.length > 128 ||
                !GHOST_SECRET_EXCHANGE_TOKEN_PATH_RE.test(idn.avatarPath)
              ) {
                return {
                  ok: false,
                  reason:
                    'network.secrets[].oauth.identity.avatarPath 必须是 ≤128 字符的点分路径(段名限字母/数字/_/-,如 "data.avatar_thumb")',
                };
              }
              idnAvatarPath = idn.avatarPath;
            }
            oaIdentity = {
              url: idnUrl.url,
              labelPath: idn.labelPath,
              ...(idnTemplate !== undefined ? { displayTemplate: idnTemplate } : {}),
              ...(idnAvatarPath !== undefined ? { avatarPath: idnAvatarPath } : {}),
            };
          }
          oauth = {
            authorizeUrl: authorizeParsed.url,
            tokenUrl: tokenParsed.url,
            ...(oa.clientId !== undefined ? { clientId: oa.clientId as string } : {}),
            ...(oaClientIdAlternatives !== undefined
              ? { clientIdAlternatives: oaClientIdAlternatives }
              : {}),
            ...(oa.clientSecret !== undefined ? { clientSecret: oa.clientSecret as string } : {}),
            ...(oaScopes !== undefined ? { scopes: oaScopes } : {}),
            ...(oa.scopeDelimiter !== undefined
              ? { scopeDelimiter: oa.scopeDelimiter as ',' }
              : {}),
            ...(oa.pkce !== undefined ? { pkce: oa.pkce as boolean } : {}),
            ...(oaExtra !== undefined ? { extraAuthorizeParams: oaExtra } : {}),
            ...(oaIdentity !== undefined ? { identity: oaIdentity } : {}),
            ...(oa.redirectPort !== undefined ? { redirectPort: oa.redirectPort as number } : {}),
            ...(oa.tokenBroker !== undefined ? { tokenBroker: oa.tokenBroker as string } : {}),
            ...(oaBounce !== undefined ? { brokerBounce: oaBounce } : {}),
          };
        }
        // exchange(可选):key 换令牌二段式。交换端点必须落在 hosts 白名单
        // 内——结构上保证原始 key 也只流向用户同意过的域名。
        let exchange: GhostSecretExchangeDecl | undefined;
        if (s.exchange !== undefined) {
          if (!isPlainObject(s.exchange)) {
            return {
              ok: false,
              reason: `network.secrets[${JSON.stringify(s.key)}].exchange 必须是对象`,
            };
          }
          const ex = s.exchange as Record<string, unknown>;
          if (typeof ex.url !== 'string' || ex.url.length === 0 || ex.url.length > 2048) {
            return {
              ok: false,
              reason: 'network.secrets[].exchange.url 必须是 1–2048 字符的字符串',
            };
          }
          let exUrl: URL;
          try {
            exUrl = new URL(ex.url);
          } catch {
            return {
              ok: false,
              reason: 'network.secrets[].exchange.url 不是合法的绝对地址',
            };
          }
          if (
            exUrl.protocol !== 'https:' ||
            exUrl.port !== '' ||
            exUrl.username ||
            exUrl.password
          ) {
            return {
              ok: false,
              reason: 'network.secrets[].exchange.url 仅支持 https 默认端口且不允许内嵌用户名/密码',
            };
          }
          if (!hosts.some((pattern) => ghostNetworkHostMatches(pattern, exUrl.hostname))) {
            return {
              ok: false,
              reason: `network.secrets[].exchange.url 的域名 ${JSON.stringify(exUrl.hostname)} 必须命中 network.hosts 白名单`,
            };
          }
          if (
            typeof ex.bodyFormat !== 'string' ||
            ex.bodyFormat.length === 0 ||
            ex.bodyFormat.length > GHOST_SECRET_EXCHANGE_BODY_MAX_CHARS ||
            ex.bodyFormat.split('{value}').length !== 2
          ) {
            return {
              ok: false,
              reason: `network.secrets[].exchange.bodyFormat 必须是 ≤${GHOST_SECRET_EXCHANGE_BODY_MAX_CHARS} 字符且恰含一个 {value} 占位的字符串`,
            };
          }
          let exContentType: GhostSecretExchangeContentType | undefined;
          if (ex.contentType !== undefined) {
            if (
              typeof ex.contentType !== 'string' ||
              !(GHOST_SECRET_EXCHANGE_CONTENT_TYPES as readonly string[]).includes(ex.contentType)
            ) {
              return {
                ok: false,
                reason: `network.secrets[].exchange.contentType 仅支持 ${GHOST_SECRET_EXCHANGE_CONTENT_TYPES.join(' / ')}`,
              };
            }
            exContentType = ex.contentType as GhostSecretExchangeContentType;
          }
          if (
            typeof ex.tokenPath !== 'string' ||
            ex.tokenPath.length > 128 ||
            !GHOST_SECRET_EXCHANGE_TOKEN_PATH_RE.test(ex.tokenPath)
          ) {
            return {
              ok: false,
              reason:
                'network.secrets[].exchange.tokenPath 必须是 ≤128 字符的点分路径(段名限字母/数字/_/-,如 "session" / "data.token")',
            };
          }
          let exTtl: number | undefined;
          if (ex.ttlSeconds !== undefined) {
            if (
              typeof ex.ttlSeconds !== 'number' ||
              !Number.isInteger(ex.ttlSeconds) ||
              ex.ttlSeconds < GHOST_SECRET_EXCHANGE_TTL_MIN_S ||
              ex.ttlSeconds > GHOST_SECRET_EXCHANGE_TTL_MAX_S
            ) {
              return {
                ok: false,
                reason: `network.secrets[].exchange.ttlSeconds 必须是 ${GHOST_SECRET_EXCHANGE_TTL_MIN_S}–${GHOST_SECRET_EXCHANGE_TTL_MAX_S} 的整数(秒)`,
              };
            }
            exTtl = ex.ttlSeconds;
          }
          exchange = {
            url: ex.url,
            bodyFormat: ex.bodyFormat,
            ...(exContentType !== undefined ? { contentType: exContentType } : {}),
            tokenPath: ex.tokenPath,
            ...(exTtl !== undefined ? { ttlSeconds: exTtl } : {}),
          };
        }
        secrets.push({
          key: s.key,
          label: s.label,
          ...(source !== undefined ? { source } : {}),
          ...(s.hint !== undefined ? { hint: s.hint as string } : {}),
          ...(s.url !== undefined ? { url: s.url as string } : {}),
          inject: {
            header: inj.header,
            format: inj.format,
            ...(injectHosts !== undefined ? { hosts: injectHosts } : {}),
          },
          ...(exchange !== undefined ? { exchange } : {}),
          ...(oauth !== undefined ? { oauth } : {}),
        });
      }
    }
    // connections(可选):多连接声明——"地址 + 凭证成对多条"的凭证形态
    // (自建实例场景)。作者只声明连接类型与注入形态,地址与 token 由用户在
    // 设置页添加(每次新增地址都过主机受信确认);连接凭证的注入范围恒等于
    // 各连接自身地址,inject.hosts 禁止声明。
    let connections: GhostConnectionDecl[] | undefined;
    if (n.connections !== undefined) {
      if (
        !Array.isArray(n.connections) ||
        n.connections.length === 0 ||
        n.connections.length > GHOST_NETWORK_MAX_CONNECTION_DECLS
      ) {
        return {
          ok: false,
          reason: `network.connections 必须是 1–${GHOST_NETWORK_MAX_CONNECTION_DECLS} 条的数组`,
        };
      }
      // 没人收地址和 token:连接的地址与凭证一律由意识 settingsHtml 收单
      // (经 /connections 协议通道),没有界面就没有入口。
      if (raw.settingsHtml === undefined) {
        return {
          ok: false,
          reason:
            '声明了 network.connections 必须同时声明 settingsHtml(连接地址与凭证由意识设置界面收单,没有界面就没人收单)',
        };
      }
      connections = [];
      const seenConnKeys = new Set<string>();
      const secretKeySet = new Set((secrets ?? []).map((s) => s.key));
      for (const c of n.connections) {
        if (!isPlainObject(c)) return { ok: false, reason: 'network.connections 每项必须是对象' };
        if (typeof c.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(c.key)) {
          return {
            ok: false,
            reason: 'network.connections[].key 必须是小写字母开头的 1–32 位小写/数字/下划线',
          };
        }
        if (seenConnKeys.has(c.key)) {
          return {
            ok: false,
            reason: `network.connections 含重复 key ${JSON.stringify(c.key)}`,
          };
        }
        // 与 secrets 共用键命名空间(保险库派生键同一前缀),撞名拒装。
        if (secretKeySet.has(c.key)) {
          return {
            ok: false,
            reason: `network.connections[].key ${JSON.stringify(c.key)} 与 network.secrets 的 key 撞名(两者共用命名空间)`,
          };
        }
        seenConnKeys.add(c.key);
        if (typeof c.label !== 'string' || c.label.trim().length === 0 || c.label.length > 64) {
          return {
            ok: false,
            reason: 'network.connections[].label 必须是 1–64 字符的非空字符串',
          };
        }
        if (
          c.hint !== undefined &&
          (typeof c.hint !== 'string' || c.hint.trim().length === 0 || c.hint.length > 200)
        ) {
          return {
            ok: false,
            reason: 'network.connections[].hint 必须是 1–200 字符的非空字符串',
          };
        }
        if (!isPlainObject(c.inject)) {
          return {
            ok: false,
            reason: `network.connections[${JSON.stringify(c.key)}].inject 必填(连接凭证要声明注入到哪个请求头)`,
          };
        }
        const cinj = c.inject as Record<string, unknown>;
        if (typeof cinj.header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(cinj.header)) {
          return {
            ok: false,
            reason: 'network.connections[].inject.header 必须是 1–64 位字母/数字/连字符的头名',
          };
        }
        if (GHOST_NETWORK_FORBIDDEN_INJECT_HEADERS.includes(cinj.header.toLowerCase())) {
          return {
            ok: false,
            reason: `network.connections[].inject.header 不允许使用协议关键头 ${JSON.stringify(cinj.header)}`,
          };
        }
        if (
          typeof cinj.format !== 'string' ||
          cinj.format.length === 0 ||
          cinj.format.length > 200 ||
          cinj.format.split('{value}').length !== 2
        ) {
          return {
            ok: false,
            reason:
              'network.connections[].inject.format 必须是 ≤200 字符且恰含一个 {value} 占位的字符串(如 "Bearer {value}")',
          };
        }
        if (cinj.hosts !== undefined) {
          // 注入范围恒等于各连接自身地址(用户添加哪条注入哪条),作者无从
          // 收窄或扩张——声明即结构性误解,直接拒装。
          return {
            ok: false,
            reason:
              'network.connections[].inject.hosts 不允许声明(连接凭证只注入对应连接自身的地址)',
          };
        }
        if (c.maxConnections !== undefined) {
          if (
            typeof c.maxConnections !== 'number' ||
            !Number.isInteger(c.maxConnections) ||
            c.maxConnections < 1 ||
            c.maxConnections > GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL
          ) {
            return {
              ok: false,
              reason: `network.connections[].maxConnections 必须是 1–${GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL} 的整数(缺省 ${GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL})`,
            };
          }
        }
        connections.push({
          key: c.key,
          label: c.label,
          ...(c.hint !== undefined ? { hint: c.hint as string } : {}),
          inject: { header: cinj.header, format: cinj.format },
          ...(c.maxConnections !== undefined ? { maxConnections: c.maxConnections as number } : {}),
        });
      }
    }
    network = {
      hosts,
      ...(secrets !== undefined ? { secrets } : {}),
      ...(connections !== undefined ? { connections } : {}),
    };
  }

  // agent 能力详单:缺省 = 仅点击票据;可选加档由 Desktop 展示并由 Host 守门。
  let agent: GhostAgentNeeds | undefined;
  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      return {
        ok: false,
        reason: 'agent 能力详单必须是对象(如 { "background": true })',
      };
    }
    if (!slots.includes('agent')) {
      return {
        ok: false,
        reason: '声明了 agent 能力详单但 slots 未包含 "agent"',
      };
    }
    const agentRaw = raw.agent as Record<string, unknown>;
    const unknownAgentField = Object.keys(agentRaw).find(
      (key) => key !== 'background' && key !== 'errand' && key !== 'schedule',
    );
    if (unknownAgentField) {
      return {
        ok: false,
        reason: `agent 含不允许的字段 ${JSON.stringify(unknownAgentField)}`,
      };
    }
    if (agentRaw.background !== undefined && typeof agentRaw.background !== 'boolean') {
      return { ok: false, reason: 'agent.background 必须是布尔值' };
    }
    if (agentRaw.errand !== undefined && typeof agentRaw.errand !== 'boolean') {
      return { ok: false, reason: 'agent.errand 必须是布尔值' };
    }
    if (agentRaw.schedule !== undefined && typeof agentRaw.schedule !== 'boolean') {
      return { ok: false, reason: 'agent.schedule 必须是布尔值' };
    }
    if (agentRaw.background !== true && agentRaw.errand !== true && agentRaw.schedule !== true) {
      return {
        ok: false,
        reason:
          'agent 能力详单只有 background: true / errand: true / schedule: true 三项加档;仅需用户点击触发时请省略 agent 字段',
      };
    }
    agent = {
      ...(agentRaw.background === true ? { background: true } : {}),
      ...(agentRaw.errand === true ? { errand: true } : {}),
      ...(agentRaw.schedule === true ? { schedule: true } : {}),
    };
  }

  // node 槽详单:只收包内入口 + 固定 stdio 协议 + 生命周期。这里刻意采用
  // 字段白名单,command/args/shell/env 等任意命令启动面一律在装入前拒绝。
  let node: GhostNodeNeeds | undefined;
  if (raw.node !== undefined) {
    if (!isPlainObject(raw.node)) {
      return { ok: false, reason: 'node 能力详单必须是对象' };
    }
    if (!slots.includes('node')) {
      return {
        ok: false,
        reason: '声明了 node 能力详单但 slots 未包含 "node"',
      };
    }
    const nodeRaw = raw.node as Record<string, unknown>;
    const allowedNodeFields = new Set([
      'entry',
      'protocol',
      'lifecycle',
      'idleTimeoutSeconds',
      'entries',
      'childSpawn',
      'secretBindings',
    ]);
    const unknownNodeField = Object.keys(nodeRaw).find((key) => !allowedNodeFields.has(key));
    if (unknownNodeField) {
      return {
        ok: false,
        reason: `node 含不允许的字段 ${JSON.stringify(unknownNodeField)};不能声明 command/args/shell/env`,
      };
    }
    if (!isSafeGhostRelativePath(nodeRaw.entry)) {
      return { ok: false, reason: 'node.entry 必须是安装目录内的安全相对路径' };
    }
    if (!/\.(?:c?js)$/.test(nodeRaw.entry)) {
      return {
        ok: false,
        reason: 'node.entry 必须是 CommonJS .js / .cjs 文件',
      };
    }
    // 入口重合判定折叠大小写:Windows / macOS 默认文件系统大小写不敏感,
    // main.js 与 Main.js 是同一个文件,原样比较会漏判。
    if (nodeRaw.entry.toLowerCase() === (raw.entry as string).toLowerCase()) {
      return {
        ok: false,
        reason: 'node.entry 不能与浏览器沙箱 entry 使用同一个文件',
      };
    }
    if (
      typeof nodeRaw.protocol !== 'string' ||
      !(GHOST_NODE_PROTOCOLS as readonly string[]).includes(nodeRaw.protocol)
    ) {
      return {
        ok: false,
        reason: `node.protocol 必须是 ${GHOST_NODE_PROTOCOLS.join(' / ')}`,
      };
    }
    if (
      nodeRaw.lifecycle !== undefined &&
      (typeof nodeRaw.lifecycle !== 'string' ||
        !(GHOST_NODE_LIFECYCLES as readonly string[]).includes(nodeRaw.lifecycle))
    ) {
      return {
        ok: false,
        reason: `node.lifecycle 必须是 ${GHOST_NODE_LIFECYCLES.join(' / ')}`,
      };
    }
    if (
      nodeRaw.idleTimeoutSeconds !== undefined &&
      (typeof nodeRaw.idleTimeoutSeconds !== 'number' ||
        !Number.isInteger(nodeRaw.idleTimeoutSeconds) ||
        nodeRaw.idleTimeoutSeconds < 30 ||
        nodeRaw.idleTimeoutSeconds > 3600)
    ) {
      return {
        ok: false,
        reason: 'node.idleTimeoutSeconds 必须是 30–3600 的整数',
      };
    }
    if (nodeRaw.lifecycle === 'resident' && nodeRaw.idleTimeoutSeconds !== undefined) {
      return {
        ok: false,
        reason: 'node.lifecycle 为 resident 时不能再声明 idleTimeoutSeconds',
      };
    }
    // 额外入口(多进程窄版):同一套入口纪律——包内安全相对路径、CJS 文件、
    // 不与浏览器沙箱 entry / 主入口 / 彼此重复;条数封顶。
    let nodeEntries: string[] | undefined;
    if (nodeRaw.entries !== undefined) {
      if (!Array.isArray(nodeRaw.entries) || nodeRaw.entries.length === 0) {
        return {
          ok: false,
          reason: 'node.entries 必须是非空数组(额外工作进程入口清单)',
        };
      }
      if (nodeRaw.entries.length > GHOST_NODE_MAX_EXTRA_ENTRIES) {
        return {
          ok: false,
          reason: `node.entries 最多 ${GHOST_NODE_MAX_EXTRA_ENTRIES} 条`,
        };
      }
      // 同上折叠大小写:大小写变体在大小写不敏感文件系统上是同一个文件,
      // 不能被当作不同入口通过查重。
      const seen = new Set<string>();
      for (const extra of nodeRaw.entries) {
        if (!isSafeGhostRelativePath(extra)) {
          return {
            ok: false,
            reason: 'node.entries 每项必须是安装目录内的安全相对路径',
          };
        }
        if (!/\.(?:c?js)$/.test(extra)) {
          return {
            ok: false,
            reason: 'node.entries 每项必须是 CommonJS .js / .cjs 文件',
          };
        }
        const extraFold = extra.toLowerCase();
        if (extraFold === (raw.entry as string).toLowerCase()) {
          return { ok: false, reason: 'node.entries 不能包含浏览器沙箱 entry' };
        }
        if (extraFold === nodeRaw.entry.toLowerCase()) {
          return {
            ok: false,
            reason: 'node.entries 不能重复主入口 node.entry',
          };
        }
        if (seen.has(extraFold)) {
          return {
            ok: false,
            reason: `node.entries 含重复入口 ${JSON.stringify(extra)}`,
          };
        }
        seen.add(extraFold);
      }
      nodeEntries = nodeRaw.entries as string[];
    }
    if (nodeRaw.childSpawn !== undefined && typeof nodeRaw.childSpawn !== 'boolean') {
      return { ok: false, reason: 'node.childSpawn 必须是布尔值' };
    }
    let nodeSecretBindings: GhostNodeSecretBinding[] | undefined;
    if (nodeRaw.secretBindings !== undefined) {
      if (
        !Array.isArray(nodeRaw.secretBindings) ||
        nodeRaw.secretBindings.length === 0 ||
        nodeRaw.secretBindings.length > GHOST_NODE_MAX_SECRET_BINDINGS
      ) {
        return {
          ok: false,
          reason: `node.secretBindings 必须是 1–${GHOST_NODE_MAX_SECRET_BINDINGS} 条的数组`,
        };
      }
      if (raw.settingsHtml === undefined) {
        return {
          ok: false,
          reason: 'node.secretBindings 需要 settingsHtml 收集凭证',
        };
      }
      nodeSecretBindings = [];
      const seenSecretKeys = new Set<string>();
      for (const bindingRaw of nodeRaw.secretBindings) {
        if (!isPlainObject(bindingRaw)) {
          return { ok: false, reason: 'node.secretBindings 每项必须是对象' };
        }
        const binding = bindingRaw as Record<string, unknown>;
        const unknownBindingField = Object.keys(binding).find(
          (key) => !['key', 'label', 'methods', 'entry', 'hint', 'url'].includes(key),
        );
        if (unknownBindingField) {
          return {
            ok: false,
            reason: `node.secretBindings[] 含不允许的字段 ${JSON.stringify(unknownBindingField)}`,
          };
        }
        if (typeof binding.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(binding.key)) {
          return {
            ok: false,
            reason: 'node.secretBindings[].key 必须是小写字母开头的 1–32 位小写/数字/下划线',
          };
        }
        if (seenSecretKeys.has(binding.key)) {
          return {
            ok: false,
            reason: `node.secretBindings 含重复 key ${JSON.stringify(binding.key)}`,
          };
        }
        seenSecretKeys.add(binding.key);
        if (
          typeof binding.label !== 'string' ||
          binding.label.trim().length === 0 ||
          binding.label.length > 64
        ) {
          return {
            ok: false,
            reason: 'node.secretBindings[].label 必须是 1–64 字符的非空字符串',
          };
        }
        if (
          !Array.isArray(binding.methods) ||
          binding.methods.length === 0 ||
          binding.methods.length > GHOST_NODE_MAX_SECRET_METHODS
        ) {
          return {
            ok: false,
            reason: `node.secretBindings[].methods 必须是 1–${GHOST_NODE_MAX_SECRET_METHODS} 条的数组`,
          };
        }
        const methods: string[] = [];
        for (const method of binding.methods) {
          if (typeof method !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(method)) {
            return {
              ok: false,
              reason: 'node.secretBindings[].methods 每项必须是 1–128 位安全方法名',
            };
          }
          if (nodeRaw.protocol === 'mcp-stdio' && isGhostNodeMcpReservedMethod(method)) {
            return {
              ok: false,
              reason: `node.secretBindings[].methods 不能绑定宿主保留的 MCP 方法 ${JSON.stringify(method)}`,
            };
          }
          if (methods.includes(method)) {
            return {
              ok: false,
              reason: `node.secretBindings[].methods 含重复方法 ${JSON.stringify(method)}`,
            };
          }
          methods.push(method);
        }
        let bindingEntry: string | undefined;
        if (binding.entry !== undefined) {
          if (
            typeof binding.entry !== 'string' ||
            (binding.entry !== nodeRaw.entry && !(nodeEntries ?? []).includes(binding.entry))
          ) {
            return {
              ok: false,
              reason: 'node.secretBindings[].entry 必须逐字命中 node.entry 或 node.entries',
            };
          }
          bindingEntry = binding.entry;
        }
        if (
          binding.hint !== undefined &&
          (typeof binding.hint !== 'string' ||
            binding.hint.trim().length === 0 ||
            binding.hint.length > 200)
        ) {
          return {
            ok: false,
            reason: 'node.secretBindings[].hint 必须是 1–200 字符的非空字符串',
          };
        }
        if (binding.url !== undefined) {
          if (
            typeof binding.url !== 'string' ||
            binding.url.length === 0 ||
            binding.url.length > 200
          ) {
            return {
              ok: false,
              reason: 'node.secretBindings[].url 必须是 1–200 字符的字符串',
            };
          }
          let parsed: URL;
          try {
            parsed = new URL(binding.url);
          } catch {
            return {
              ok: false,
              reason: 'node.secretBindings[].url 不是合法的绝对地址',
            };
          }
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            return {
              ok: false,
              reason: 'node.secretBindings[].url 仅支持 https 且不允许内嵌用户名/密码',
            };
          }
        }
        nodeSecretBindings.push({
          key: binding.key,
          label: binding.label,
          methods,
          ...(bindingEntry !== undefined ? { entry: bindingEntry } : {}),
          ...(binding.hint !== undefined ? { hint: binding.hint as string } : {}),
          ...(binding.url !== undefined ? { url: binding.url as string } : {}),
        });
      }
    }
    node = {
      entry: nodeRaw.entry,
      protocol: nodeRaw.protocol as GhostNodeProtocol,
      ...(nodeRaw.lifecycle !== undefined
        ? { lifecycle: nodeRaw.lifecycle as GhostNodeLifecycle }
        : {}),
      ...(nodeRaw.idleTimeoutSeconds !== undefined
        ? { idleTimeoutSeconds: nodeRaw.idleTimeoutSeconds }
        : {}),
      ...(nodeEntries !== undefined ? { entries: nodeEntries } : {}),
      ...(nodeRaw.childSpawn !== undefined ? { childSpawn: nodeRaw.childSpawn } : {}),
      ...(nodeSecretBindings !== undefined ? { secretBindings: nodeSecretBindings } : {}),
    };
  }
  if (slots.includes('node') && node === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "node" 但缺少 node 工作进程详单',
    };
  }
  if (node?.secretBindings) {
    for (const binding of node.secretBindings) {
      if (network?.secrets?.some((secret) => secret.key === binding.key)) {
        return {
          ok: false,
          reason: `network.secrets 的 key ${JSON.stringify(binding.key)} 与 node.secretBindings 撞名`,
        };
      }
      if (network?.connections?.some((connection) => connection.key === binding.key)) {
        return {
          ok: false,
          reason: `network.connections[].key ${JSON.stringify(binding.key)} 与 node.secretBindings 的 key 撞名(两者共用命名空间)`,
        };
      }
    }
  }

  // preview 槽详单:与 slots 含 'preview' **严格成对**(有槽必有详单——域名
  // 范围是本能力的全部知情面,不允许"先装后说");域名语法与 network 白名单
  // 同一套(插件详情逐条展示)。
  let preview: GhostPreviewNeeds | undefined;
  if (raw.preview !== undefined) {
    if (!isPlainObject(raw.preview)) {
      return {
        ok: false,
        reason: 'preview 详单必须是对象(如 { "hosts": ["*.example.com"] })',
      };
    }
    if (!slots.includes('preview')) {
      return {
        ok: false,
        reason: '声明了 preview 详单但 slots 未包含 "preview"',
      };
    }
    const previewRaw = raw.preview as Record<string, unknown>;
    const unknownPreviewField = Object.keys(previewRaw).find((key) => key !== 'hosts');
    if (unknownPreviewField !== undefined) {
      return {
        ok: false,
        reason: `preview 含不允许的字段 ${JSON.stringify(unknownPreviewField)}`,
      };
    }
    if (!Array.isArray(previewRaw.hosts) || previewRaw.hosts.length === 0) {
      return {
        ok: false,
        reason: 'preview.hosts 必须是非空数组(可打开预览的域名白名单)',
      };
    }
    if (previewRaw.hosts.length > GHOST_PREVIEW_MAX_HOSTS) {
      return {
        ok: false,
        reason: `preview.hosts 最多 ${GHOST_PREVIEW_MAX_HOSTS} 条`,
      };
    }
    const seenPreviewHosts = new Set<string>();
    for (const host of previewRaw.hosts) {
      if (
        !isValidGhostNetworkHostPattern(host) &&
        !(typeof host === 'string' && GHOST_PREVIEW_LOOPBACK_HOSTS.has(host))
      ) {
        return {
          ok: false,
          reason: `preview.hosts 含不合法域名模式 ${JSON.stringify(host)}`,
        };
      }
      if (seenPreviewHosts.has(host)) {
        return {
          ok: false,
          reason: `preview.hosts 含重复域名 ${JSON.stringify(host)}`,
        };
      }
      seenPreviewHosts.add(host);
    }
    preview = { hosts: previewRaw.hosts as string[] };
  }
  if (slots.includes('preview') && preview === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "preview" 但缺少 preview 详单(hosts 域名白名单必填)',
    };
  }

  // skill 槽详单:与 slots 含 'skill' **严格成对**(有槽必有详单——捆绑了什么
  // 技能是本能力的全部知情面)。name/description 与 SKILL.md 的逐字一致性在
  // 打包与装入两侧另行强制,这里只管声明本身的形状。name/dir 大小写折叠去重:
  // win32 文件系统折叠大小写,共享技能根的链接名不允许折叠后相撞。
  let skill: GhostSkillNeeds | undefined;
  if (raw.skill !== undefined) {
    if (!isPlainObject(raw.skill)) {
      return {
        ok: false,
        reason:
          'skill 详单必须是对象(如 { "items": [{ "dir": "skills/foo", "name": "foo", "description": "..." }] })',
      };
    }
    if (!slots.includes('skill')) {
      return { ok: false, reason: '声明了 skill 详单但 slots 未包含 "skill"' };
    }
    const skillRaw = raw.skill as Record<string, unknown>;
    const unknownSkillField = Object.keys(skillRaw).find((key) => key !== 'items');
    if (unknownSkillField !== undefined) {
      return {
        ok: false,
        reason: `skill 含不允许的字段 ${JSON.stringify(unknownSkillField)}`,
      };
    }
    if (!Array.isArray(skillRaw.items) || skillRaw.items.length === 0) {
      return {
        ok: false,
        reason: 'skill.items 必须是非空数组(随包捆绑的技能清单)',
      };
    }
    if (skillRaw.items.length > GHOST_SKILL_MAX_ITEMS) {
      return {
        ok: false,
        reason: `skill.items 最多 ${GHOST_SKILL_MAX_ITEMS} 条`,
      };
    }
    const skillItems: GhostSkillItem[] = [];
    const seenSkillNames = new Set<string>();
    const seenSkillDirs = new Set<string>();
    for (const item of skillRaw.items) {
      if (!isPlainObject(item)) {
        return {
          ok: false,
          reason: 'skill.items 每项必须是对象({ dir, name, description })',
        };
      }
      const itemRaw = item as Record<string, unknown>;
      const unknownItemField = Object.keys(itemRaw).find(
        (key) => key !== 'dir' && key !== 'name' && key !== 'description',
      );
      if (unknownItemField !== undefined) {
        return {
          ok: false,
          reason: `skill.items 条目含不允许的字段 ${JSON.stringify(unknownItemField)}`,
        };
      }
      if (!isSafeGhostRelativePath(itemRaw.dir)) {
        return {
          ok: false,
          reason: `skill.items[].dir 必须是包内安全相对路径(如 "skills/foo"),得到 ${JSON.stringify(itemRaw.dir)}`,
        };
      }
      if (
        typeof itemRaw.name !== 'string' ||
        itemRaw.name.length > GHOST_SKILL_NAME_MAX_CHARS ||
        !GHOST_SKILL_NAME_RE.test(itemRaw.name)
      ) {
        return {
          ok: false,
          reason: `skill.items[].name 必须是小写字母/数字加单连字符分段(禁首尾/连续连字符)、长度 1–${GHOST_SKILL_NAME_MAX_CHARS},得到 ${JSON.stringify(itemRaw.name)}`,
        };
      }
      if (
        typeof itemRaw.description !== 'string' ||
        itemRaw.description.trim().length === 0 ||
        itemRaw.description.length > 1024
      ) {
        return {
          ok: false,
          reason: 'skill.items[].description 必须是 1–1024 字符的非空字符串',
        };
      }
      const nameFold = itemRaw.name.toLowerCase();
      if (seenSkillNames.has(nameFold)) {
        return {
          ok: false,
          reason: `skill.items 含重复 name ${JSON.stringify(itemRaw.name)}`,
        };
      }
      seenSkillNames.add(nameFold);
      const dirFold = itemRaw.dir.toLowerCase();
      if (seenSkillDirs.has(dirFold)) {
        return {
          ok: false,
          reason: `skill.items 含重复 dir ${JSON.stringify(itemRaw.dir)}`,
        };
      }
      seenSkillDirs.add(dirFold);
      skillItems.push({
        dir: itemRaw.dir,
        name: itemRaw.name,
        description: itemRaw.description,
      });
    }
    skill = { items: skillItems };
  }
  if (slots.includes('skill') && skill === undefined) {
    return {
      ok: false,
      reason: 'slots 声明了 "skill" 但缺少 skill 详单(items 技能清单必填)',
    };
  }

  // manual 是独立顶层字段，不是能力 slot 或授权项。这里只校验一级逻辑索引；
  // MANUAL.md 存在性、Markdown 文本与逐文件 64KB 上限由打包/装入两侧校验。
  let manual: GhostManualNeeds | undefined;
  if (raw.manual !== undefined) {
    if (!isPlainObject(raw.manual)) {
      return {
        ok: false,
        reason:
          'manual 必须是对象(如 { "items": [{ "dir": "manual/getting-started", "name": "getting-started", "description": "..." }] })',
      };
    }
    const manualRaw = raw.manual as Record<string, unknown>;
    const unknownManualField = Object.keys(manualRaw).find((key) => key !== 'items');
    if (unknownManualField !== undefined) {
      return {
        ok: false,
        reason: `manual 含不允许的字段 ${JSON.stringify(unknownManualField)}`,
      };
    }
    if (!Array.isArray(manualRaw.items) || manualRaw.items.length === 0) {
      return { ok: false, reason: 'manual.items 必须是非空数组(随包手册索引)' };
    }
    if (manualRaw.items.length > GHOST_MANUAL_MAX_ITEMS) {
      return {
        ok: false,
        reason: `manual.items 最多 ${GHOST_MANUAL_MAX_ITEMS} 条`,
      };
    }
    const manualItems: GhostManualItem[] = [];
    const seenManualNames = new Set<string>();
    const seenManualDirs = new Set<string>();
    for (const item of manualRaw.items) {
      if (!isPlainObject(item)) {
        return {
          ok: false,
          reason: 'manual.items 每项必须是对象({ dir, name, description })',
        };
      }
      const itemRaw = item as Record<string, unknown>;
      const unknownItemField = Object.keys(itemRaw).find(
        (key) => key !== 'dir' && key !== 'name' && key !== 'description',
      );
      if (unknownItemField !== undefined) {
        return {
          ok: false,
          reason: `manual.items 条目含不允许的字段 ${JSON.stringify(unknownItemField)}`,
        };
      }
      if (!isSafeGhostRelativePath(itemRaw.dir)) {
        return {
          ok: false,
          reason: `manual.items[].dir 必须是包内安全相对路径(如 "manual/getting-started"),得到 ${JSON.stringify(itemRaw.dir)}`,
        };
      }
      const dirFold = itemRaw.dir.toLowerCase();
      if (declaredFilePathFolds.some((path) => pathsConflict(dirFold, path))) {
        return {
          ok: false,
          reason: `manual.items[].dir ${JSON.stringify(itemRaw.dir)} 与插件声明文件路径大小写折叠后冲突`,
        };
      }
      if (
        typeof itemRaw.name !== 'string' ||
        itemRaw.name.length > GHOST_SKILL_NAME_MAX_CHARS ||
        !GHOST_SKILL_NAME_RE.test(itemRaw.name)
      ) {
        return {
          ok: false,
          reason: `manual.items[].name 必须是小写字母/数字加单连字符分段(禁首尾/连续连字符)、长度 1–${GHOST_SKILL_NAME_MAX_CHARS},得到 ${JSON.stringify(itemRaw.name)}`,
        };
      }
      if (
        typeof itemRaw.description !== 'string' ||
        itemRaw.description.trim().length === 0 ||
        itemRaw.description.length > GHOST_MANUAL_DESCRIPTION_MAX_CHARS
      ) {
        return {
          ok: false,
          reason: `manual.items[].description 必须是 1–${GHOST_MANUAL_DESCRIPTION_MAX_CHARS} 字符的非空字符串`,
        };
      }
      const nameFold = itemRaw.name.toLowerCase();
      if (seenManualNames.has(nameFold)) {
        return {
          ok: false,
          reason: `manual.items 含重复 name ${JSON.stringify(itemRaw.name)}`,
        };
      }
      seenManualNames.add(nameFold);
      if (seenManualDirs.has(dirFold)) {
        return {
          ok: false,
          reason: `manual.items 含重复 dir ${JSON.stringify(itemRaw.dir)}`,
        };
      }
      seenManualDirs.add(dirFold);
      manualItems.push({
        dir: itemRaw.dir,
        name: itemRaw.name,
        description: itemRaw.description,
      });
    }
    manual = { items: manualItems };
  }

  // setup 引用必须在交付边界就与同一份 manifest 的凭证、连接和设置入口对齐；
  // 不能让服务端接受、Desktop 装入时才拒绝。
  let setup: GhostSetupDecl | undefined;
  if (raw.setup !== undefined) {
    if (!isPlainObject(raw.setup)) {
      return {
        ok: false,
        reason: 'setup 必须是对象(如 { "requires": [{ "anyOf": ["secret:api_key"] }] })',
      };
    }
    const setupRaw = raw.setup as Record<string, unknown>;
    if (
      !Array.isArray(setupRaw.requires) ||
      setupRaw.requires.length > GHOST_SETUP_MAX_GROUPS
    ) {
      return {
        ok: false,
        reason: `setup.requires 必须是 0–${GHOST_SETUP_MAX_GROUPS} 组的数组(空数组 = 显式声明无使用前置需求)`,
      };
    }
    const secretByKey = new Map<
      string,
      { hostDerivedSource: 'login-email' | 'gh-cli' | 'oidc-token' | null }
    >([
      ...(network?.secrets ?? []).map(
        (secret) =>
          [
            secret.key,
            {
              hostDerivedSource:
                secret.source === 'login-email' ||
                secret.source === 'gh-cli' ||
                secret.source === 'oidc-token'
                  ? secret.source
                  : null,
            },
          ] as const,
      ),
      ...(node?.secretBindings ?? []).map(
        (secret) => [secret.key, { hostDerivedSource: null }] as const,
      ),
    ]);
    const connectionKeys = new Set((network?.connections ?? []).map((connection) => connection.key));
    const groups: GhostSetupGroup[] = [];
    for (const group of setupRaw.requires) {
      if (
        !isPlainObject(group) ||
        !Array.isArray(group.anyOf) ||
        group.anyOf.length === 0 ||
        group.anyOf.length > GHOST_SETUP_MAX_ITEMS_PER_GROUP
      ) {
        return {
          ok: false,
          reason: `setup.requires 每组必须是 { "anyOf": [...] } 且组内 1–${GHOST_SETUP_MAX_ITEMS_PER_GROUP} 条`,
        };
      }
      const items: GhostSetupRequirement[] = [];
      const seenRefs = new Set<string>();
      for (const requirement of group.anyOf) {
        let item: GhostSetupRequirement;
        if (typeof requirement === 'string') {
          const match = /^(secret|connection):(.+)$/.exec(requirement);
          if (!match) {
            return {
              ok: false,
              reason: `setup 条目 ${JSON.stringify(requirement)} 形态不对(字符串条目须为 "secret:<key>" 或 "connection:<key>";kv 用对象 { "kv": "<key>", "label": "..." })`,
            };
          }
          const [, kind, key] = match;
          if (kind === 'secret') {
            const declaration = secretByKey.get(key);
            if (!declaration) {
              return {
                ok: false,
                reason: `setup 引用了未声明的凭证 ${JSON.stringify(key)}(必须逐字取自 network.secrets[].key 或 node.secretBindings[].key)`,
              };
            }
            if (declaration.hostDerivedSource) {
              return {
                ok: false,
                reason: `setup 不允许引用 ${declaration.hostDerivedSource} 源凭证 ${JSON.stringify(key)}(Host 派生身份没有用户配置动作可引导)`,
              };
            }
            item = { kind: 'secret', key };
          } else {
            if (!connectionKeys.has(key)) {
              return {
                ok: false,
                reason: `setup 引用了未声明的连接 ${JSON.stringify(key)}(必须逐字取自 network.connections[].key)`,
              };
            }
            item = { kind: 'connection', key };
          }
        } else if (isPlainObject(requirement)) {
          if (
            typeof requirement.kv === 'string' &&
            isGhostManifestReservedRecordKey(requirement.kv)
          ) {
            return {
              ok: false,
              reason: `setup kv 条目的 kv 不允许使用对象保留键名 ${JSON.stringify(requirement.kv)}`,
            };
          }
          if (
            typeof requirement.kv !== 'string' ||
            !GHOST_SETUP_KV_KEY_RE.test(requirement.kv)
          ) {
            return {
              ok: false,
              reason: 'setup kv 条目的 kv 必须是 1–64 位字母/数字/下划线/点/连字符的键名',
            };
          }
          if (
            typeof requirement.label !== 'string' ||
            requirement.label.trim().length === 0 ||
            requirement.label.length > 64
          ) {
            return {
              ok: false,
              reason: 'setup kv 条目必须带 1–64 字符的 label(kv 键名宿主无先验,弹窗要有名字可展示)',
            };
          }
          if (raw.settingsHtml === undefined) {
            return {
              ok: false,
              reason:
                'setup 引用了 kv 参数但没有 settingsHtml——参数由意识设置界面收单,没有界面就没人填',
            };
          }
          item = { kind: 'kv', key: requirement.kv, label: requirement.label };
        } else {
          return {
            ok: false,
            reason: 'setup.requires[].anyOf 每条必须是字符串引用或 { "kv", "label" } 对象',
          };
        }
        const ref = `${item.kind}:${item.key}`;
        if (seenRefs.has(ref)) {
          return { ok: false, reason: `setup 同组内含重复条目 ${JSON.stringify(ref)}` };
        }
        seenRefs.add(ref);
        items.push(item);
      }
      groups.push({ anyOf: items });
    }
    setup = { requires: groups };
  }

  // 显式触发指令:1–32 字符、无空白、无 '/'(允许中文,如 /画图);
  // 必须有工具可干活。跨意识查重在装入时由 GhostManager 执行(需要本地清单)。
  if (raw.command !== undefined) {
    if (
      typeof raw.command !== 'string' ||
      raw.command.length === 0 ||
      raw.command.length > 32 ||
      /[\s/]/.test(raw.command)
    ) {
      return {
        ok: false,
        reason: 'command 必须是 1–32 字符、不含空白与 "/" 的字符串',
      };
    }
    if (tools === undefined) {
      return {
        ok: false,
        reason: '声明了 command 但没有 tools——没有工具的指令无事可做',
      };
    }
  }

  // 语义触发扩展词表:≤8 个、每个 2–24 字符(单字词命中面失控,拒收)、
  // 去首尾空白后不许为空;大小写折叠去重。必须有工具可干活(同 command)。
  let keywords: string[] | undefined;
  if (raw.keywords !== undefined) {
    if (!Array.isArray(raw.keywords) || raw.keywords.length === 0 || raw.keywords.length > 8) {
      return { ok: false, reason: 'keywords 必须是 1–8 项的数组' };
    }
    if (tools === undefined) {
      return {
        ok: false,
        reason: '声明了 keywords 但没有 tools——没有工具的触发词无事可做',
      };
    }
    const seen = new Set<string>();
    keywords = [];
    for (const k of raw.keywords) {
      if (typeof k !== 'string') return { ok: false, reason: 'keywords 每项必须是字符串' };
      const word = k.trim();
      if (word.length < 2 || word.length > 24) {
        return {
          ok: false,
          reason: `keywords 每项须为 2–24 字符(单字词命中面失控):${JSON.stringify(k)}`,
        };
      }
      const fold = word.toLowerCase();
      if (seen.has(fold)) continue; // 重复词静默去重,不拒装
      seen.add(fold);
      keywords.push(word);
    }
  }

  return {
    ok: true,
    manifest: {
      ...prepared.unknownV3Fields,
      schemaVersion: prepared.schemaVersion,
      id: raw.id,
      name: raw.name,
      version: raw.version,
      ...(raw.minCindyVersion !== undefined
        ? { minCindyVersion: raw.minCindyVersion as string }
        : {}),
      kind: 'chip',
      ...(raw.author !== undefined ? { author: raw.author as string } : {}),
      ...(locales !== undefined ? { locales } : {}),
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
      ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string } : {}),
      ...(raw.icon !== undefined ? { icon: raw.icon as string } : {}),
      entry: raw.entry,
      ...(raw.launch !== undefined ? { launch: raw.launch as GhostLaunchMode } : {}),
      ...(agent !== undefined || prepared.v3BaseAgent
        ? { agent: agent ?? {} }
        : {}),
      ...(node !== undefined ? { node } : {}),
      ...(raw.settingsHtml !== undefined ? { settingsHtml: raw.settingsHtml as string } : {}),
      ...(raw.settingsHeight !== undefined ? { settingsHeight: raw.settingsHeight as number } : {}),
      ...(prepared.schemaVersion === 2 ? { slots } : {}),
      ...(card !== undefined
        || prepared.v3BaseCard
        || (prepared.schemaVersion === 3 && slots.includes('card'))
        ? { card: card ?? {} }
        : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(cindy !== undefined ? { cindy } : {}),
      ...(subscribe !== undefined ? { subscribe } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(raw.command !== undefined ? { command: raw.command as string } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(panel !== undefined ? { panel } : {}),
      ...(mainView !== undefined ? { mainView } : {}),
      ...(preview !== undefined ? { preview } : {}),
      ...(skill !== undefined ? { skill } : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('notify') ? { notify: true as const } : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('badge') ? { badge: true as const } : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('confirm') ? { confirm: true as const } : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('fs') ? { fs: true as const } : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('library')
        ? { library: true as const }
        : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('session-context')
        ? { sessionContext: true as const }
        : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('pick') ? { pick: true as const } : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('workspace')
        ? { workspace: true as const }
        : {}),
      ...(prepared.schemaVersion === 3 && slots.includes('ios-simulator')
        ? { iosSimulator: true as const }
        : {}),
      ...(manual !== undefined ? { manual } : {}),
      ...(setup !== undefined ? { setup } : {}),
    },
  };
}
