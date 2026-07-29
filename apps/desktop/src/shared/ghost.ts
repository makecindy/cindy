import { findSplitChildByPanelKind, insertRootSplitPane, type Layout } from './layoutTree';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale } from './locale';

/**
 * 意识(Ghost,.cindy 文件)的清单数据模型与校验 —— main / renderer 共用。
 *
 * 跨模块安全与布局不变量见 docs/dev-rules/architecture-invariants.md / docs/dev-rules/plugin-security-and-authoring.md:
 * - `.cindy` 是一个 zip 压缩包,根部放一份 `ghost.json` 清单(身份卡);
 * - 意识只有一种形态(2026-07-12 Lizi 定案):`kind: 'chip'`、schemaVersion 2,
 *   带代码,跑在独立沙箱进程,slots 白名单声明能力,注入必弹权限清单。
 *   早期无代码的声明型(declaration, v1)已
 *   整体移除——Lizi 确认无存量包,不留兼容层(对齐 07-08"无曾用名兼容"
 *   先例);原规划的"经验"档(提示词层)同日取消,场景由 Skill 体系覆盖;
 * - 意识面板在布局树中的 panelKind 统一为 `ghost:<id>`,与布局引擎的
 *   与规则 27 的「未安装意识面板隐藏、重装原位复活」语义对接。
 *
 * 校验风格对齐 shared/layoutTree.ts:纯函数、返回 ok/reason,不抛异常;
 * main 端 GhostManager 与未来的 renderer 消费方共用,规则不漂移。
 */

/** 清单文件名(zip 根部)。 */
export const GHOST_MANIFEST_FILE = 'ghost.json';

/** 意识文件扩展名。 */
export const CINDY_FILE_EXT = '.cindy';

/** 意识面板在布局树中的 panelKind 前缀。 */
export const GHOST_PANEL_KIND_PREFIX = 'ghost:';

/** 意识沙箱文件供片协议;特权注册见 bootstrap。 */
export const GHOST_SCHEME = 'cindy-ghost';

/**
 * 意识沙箱的 session 分区前缀。无 `persist:` 前缀 = 纯内存分区,熄灯即蒸发。
 * 面板 webview 与离屏沙箱窗口共用同一分区规则(同一意识 = 同一间房)。
 */
export const GHOST_PARTITION_PREFIX = 'cindy-ghost-';

/** 某段意识的 session 分区名。 */
export function ghostPartition(id: string): string {
  return `${GHOST_PARTITION_PREFIX}${id}`;
}

/** 从分区名解析意识 id;不是意识分区(或 id 非法)返回 null。 */
export function parseGhostPartition(partition: unknown): string | null {
  if (typeof partition !== 'string' || !partition.startsWith(GHOST_PARTITION_PREFIX)) return null;
  const id = partition.slice(GHOST_PARTITION_PREFIX.length);
  return isValidGhostId(id) ? id : null;
}

/**
 * 意识 id 规则:小写字母/数字开头,后续允许小写字母/数字/连字符,总长 1–32。
 * 收紧到这个集合是因为 id 直接用作安装目录名(userData/brain/<id>),
 * 必须在 macOS / Windows 双平台都是安全的文件夹名,且天然杜绝路径穿越。
 */
const GHOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 十四个卡槽(意识能力的全部出口,docs/dev-rules/plugin-security-and-authoring.md)。
 * 'cindy' = 请 Cindy 本体代办(借主机自带 AI 能力干活;2026-07-11 Lizi 定案
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
 * 'session-context' = 会话上下文(2026-07-23):agent 派活(tool-call)时,主机把
 * 当次会话的可信 {session_id, workdir, workdir_is_local, workdir_is_read_only}
 * 注入 args.session_context。
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
 * 一致,打包与装入双侧强制),装入确认框逐条列出并置于清单最上部。
 * 'workspace' = 工作区会话(2026-07-25):插件请主机在指定本机项目目录下确保
 * 存在一个会话入口并显示在侧边栏——目录下已有 active 会话即复用,没有才创建
 * 空 draft 会话(不拉起 agent 进程)。目录授权两条路:系统选文件夹窗口亲选
 * 即授权(pick 模式,路径不回沙箱),或 tool-call 语境下带在途 callId + 绝对
 * 路径(目录在该会话 workdir 内自动放行,workdir 外弹确认卡)。远程工作区
 * v1 一律拒(fail closed)。
 */
export const GHOST_SLOTS = [
  'subscribe',
  'tool',
  'card',
  'panel',
  'cindy',
  'agent',
  'node',
  'network',
  'notify',
  'fs',
  'session-context',
  'pick',
  'preview',
  'skill',
  'workspace',
] as const;
export type GhostSlot = (typeof GHOST_SLOTS)[number];

/**
 * Card 槽能力详单。card 槽默认仅允许渲染静态/交互卡片(含按钮动作);
 * externalLinks: true 额外允许卡片声明 data-ghost-link 外链,点击经宿主
 * 确认框后 openExternal——这是独立加档权限,装入确认时单列。
 */
export interface GhostCardNeeds {
  externalLinks?: boolean;
}

/**
 * Agent 新回合能力详单。
 *
 * 申请 `agent` 槽默认只允许消费宿主在真实用户点击插件卡片时签发的
 * 一次性通行票。`background: true` 额外允许插件在没有当次点击票据时，
 * 对已经由用户建立过关联的会话发起回合；这是更高一档权限，安装时单列。
 */
export interface GhostAgentNeeds {
  background?: boolean;
}

/** 插件随包本地 Node 工作进程使用的 stdio 协议。 */
export const GHOST_NODE_PROTOCOLS = ['json-rpc-stdio', 'mcp-stdio'] as const;
export type GhostNodeProtocol = (typeof GHOST_NODE_PROTOCOLS)[number];

/** Node 工作进程生命周期；常驻档会在安装确认中单列高风险权限。 */
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
  /** 给用户看的名称(安装确认与设置状态使用)。 */
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
 * 只允许指定包内入口和固定协议，不接受 command / args / shell / env，避免把
 * ghost.json 变成任意命令启动器。Node 进程拥有当前系统用户级本机权限，主机
 * 只保证它不能绕过 main.js 调 Cindy API，并不能把它变成系统级沙箱。
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
   * 那条路生出来的不是 Node。默认关;开了会在装入确认框单列一行。
   * 权限本质不变:仍只能跑包内申报过的 JS,node 槽本就是用户级执行权。
   */
  childSpawn?: boolean;
  /**
   * 由主机 safeStorage 持久化、按声明的方法临时注入 Worker 的凭证。
   * 这是 Node 高风险能力的一部分，安装权限清单会逐条披露。
   */
  secretBindings?: GhostNodeSecretBinding[];
}

/** node 额外入口条数上限(1 主 + 4 额外 = 每插件至多 5 个工作进程)。 */
export const GHOST_NODE_MAX_EXTRA_ENTRIES = 4;

/** 宿主代启子进程:每插件同时在世的子进程数上限(不含 worker 本体)。 */
export const GHOST_NODE_MAX_CHILDREN_PER_GHOST = 4;
/** 宿主代启子进程:启动参数条数上限。 */
export const GHOST_NODE_CHILD_MAX_ARGS = 16;
/** 宿主代启子进程:单条启动参数长度上限(字符)。 */
export const GHOST_NODE_CHILD_ARG_MAX_CHARS = 2048;
/** 宿主代启子进程:stdio 中继单帧 base64 字符数上限(≈ 768KB 原始字节)。 */
export const GHOST_NODE_CHILD_CHUNK_MAX_B64_CHARS = 1024 * 1024;
/** spawn-child / childId 的 id 形状(worker 侧自铸计数器 + 主机铸 UUID 都在内)。 */
export const GHOST_NODE_CHILD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * 子进程原样模式的 argv 旗标(utilityProcess fork args[1];其后为透传参数)。
 * 放 shared 是因为 broker(主进程)与引导层(worker 进程)都要认它,而引导层
 * 模块有 import 即执行的副作用,不能被 broker 直接 import。
 */
export const GHOST_NODE_CHILD_MODE_FLAG = '__cindy-node-child__';

/**
 * ── 宿主代启子进程的引导层控制协议(worker bootstrap ↔ 主机 broker)──
 *
 * 这条通道是引导层(nodeRuntimeWorkerProcess)私藏的 parentPort,插件代码
 * 摸不到,只能经 spawnEntry 窄接口发起;它**不是** JSON-RPC stdio 通道,
 * "worker 反向 JSON-RPC 请求宿主能力恒拒 -32601"的铁律不受影响。
 * stdio 字节一律 base64 中继(chunk 可能把多字节字符切两半,文本转发会
 * 出现乱码;base64 逐字节保真)。
 */

/** worker → 主机:代启/喂 stdin/收 stdin/杀进程。 */
export type GhostNodeChildToHostMessage =
  | { type: 'spawn-child'; reqId: string; entry: string; args?: string[] }
  | { type: 'child-stdin'; childId: string; b64: string }
  | { type: 'child-stdin-end'; childId: string }
  | { type: 'child-kill'; childId: string };

/** 主机 → worker:代启结果/子进程输出/退出。 */
export type GhostNodeChildToWorkerMessage =
  | { type: 'spawn-child-result'; reqId: string; ok: true; childId: string; pid?: number }
  | { type: 'spawn-child-result'; reqId: string; ok: false; message: string }
  | { type: 'child-stdout'; childId: string; b64: string }
  | { type: 'child-stderr'; childId: string; b64: string }
  | { type: 'child-exit'; childId: string; code: number | null };

function isChildId(v: unknown): v is string {
  return typeof v === 'string' && GHOST_NODE_CHILD_ID_RE.test(v);
}

/** worker → 主机控制帧的形状校验(主机侧守门用;不合形一律静默丢)。 */
export function parseGhostNodeChildToHostMessage(
  raw: unknown,
): GhostNodeChildToHostMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type === 'spawn-child') {
    if (!isChildId(m.reqId) || typeof m.entry !== 'string') return null;
    if (m.args !== undefined) {
      if (!Array.isArray(m.args) || m.args.length > GHOST_NODE_CHILD_MAX_ARGS) return null;
      for (const arg of m.args) {
        if (typeof arg !== 'string' || arg.length > GHOST_NODE_CHILD_ARG_MAX_CHARS) return null;
      }
    }
    return {
      type: 'spawn-child',
      reqId: m.reqId,
      entry: m.entry,
      ...(m.args !== undefined ? { args: m.args as string[] } : {}),
    };
  }
  if (m.type === 'child-stdin') {
    if (!isChildId(m.childId)) return null;
    if (typeof m.b64 !== 'string' || m.b64.length > GHOST_NODE_CHILD_CHUNK_MAX_B64_CHARS) {
      return null;
    }
    return { type: 'child-stdin', childId: m.childId, b64: m.b64 };
  }
  if (m.type === 'child-stdin-end' || m.type === 'child-kill') {
    if (!isChildId(m.childId)) return null;
    return { type: m.type, childId: m.childId };
  }
  return null;
}

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
 * 面板显示形态(相对主聊天窗)。left = 顶层布局树停靠 pane(缺省);
 * 'tab' = 不进布局树,作为右侧栏(right-tabs)里的每会话单例页签
 * (2026-07-24 定案,注册链路见 renderer/cindy-brain/ghostTabPlugins.tsx)。
 * right 已退役(2026-07-25 Lizi 定案:右侧是右侧边栏的地盘,插件面板默认
 * 挤过去体验差;用户想放右边用拖拽换位即可)——旧包声明的 right 在校验期
 * 归一化为 left(已装插件每次启动都重过校验,硬拒会把存量插件打没;兼容
 * 语义与 model→cindy 改名同款)。top / bottom 需要嵌套上下分割(树操作/
 * 拖缝/卸载查找全链路),排期中——校验层先收词并明确拒绝,不静默降级(规则 9)。
 */
export const GHOST_PANEL_POSITIONS = ['left', 'tab'] as const;
export type GhostPanelPosition = (typeof GHOST_PANEL_POSITIONS)[number];

/** 面板声明(五个卡槽中的「面板」槽,一段意识至多一块)。 */
export interface GhostPanelDecl {
  /** 面板标准头(PanelChrome)标题;缺省用意识 name。 */
  title?: string;
  /** 显示形态:left 停靠主聊天窗左侧(缺省),或 'tab' 右侧栏页签;
   *  right 已退役并入 left(2026-07-25 Lizi 定案,见 GHOST_PANEL_POSITIONS 注释)。 */
  position?: GhostPanelPosition;
  /** 面板界面入口(安装目录内相对路径,意识自绘)。 */
  html: string;
  /** 面板最小宽度(px),布局引擎拖缝时的下限。仅停靠形态有效,'tab' 时禁用。 */
  minWidth?: number;
  /** 装入布局时的初始宽度占比(与 layoutTree 的 fraction 同语义)。仅停靠形态有效,'tab' 时禁用。 */
  defaultFraction?: number;
  /**
   * 标准头系统按钮开关(2026-07-25):缺省全开,声明 false 逐个关闭。
   * 当前一批:maximize =「撑满内容区」、detach =「在独立窗口中打开」、
   * minimize =「最小化为浮动气泡」。标准头本体(标题条)恒由主机绘制、
   * 不可关——可配置的只是系统按钮;'tab' 形态没有标准头,声明本字段拒装。
   * 未知键按规则 9 收词明确拒绝,新按钮上线时在这里扩键。
   */
  systemButtons?: { maximize?: boolean; detach?: boolean; minimize?: boolean };
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

/** cindy 槽·图像类可申请的动作(主机代办菜单的"图像"类目)。 */
export const GHOST_MODEL_IMAGE_ACTIONS = ['generate', 'edit'] as const;
export type GhostModelImageAction = (typeof GHOST_MODEL_IMAGE_ACTIONS)[number];

/** cindy 槽·视频类可申请的动作(generate=文生视频,edit=参考图生视频)。 */
export const GHOST_MODEL_VIDEO_ACTIONS = ['generate', 'edit'] as const;
export type GhostModelVideoAction = (typeof GHOST_MODEL_VIDEO_ACTIONS)[number];

/**
 * cindy 槽·媒体类可申请的动作(2026-07-29 开闸,makecindy/cindy#784)。
 *
 * `deposit` = 寄存:把意识**手里已有**的媒体字节(用户在面板里粘贴/拖入的图、
 * 面板存量素材)存入媒体总仓、记到本意识名下,换回指纹——从此这些媒体与
 * 「意识自己生成的图」同权,可以直接当 edit_image / edit_video 的源图。
 *
 * 为什么单独成一档能力(而非跟着 image.edit 白送):它是本槽唯一**不经模型、
 * 不花钱**的入仓通道。声明了 network 槽的意识本就能从白名单域拉字节入仓
 * (as:'media'),寄存把同样的"写你的媒体库"能力给了没有 network 槽的意识,
 * 因此必须在装入确认框里单独露出、由用户单独点头。
 *
 * 同一能力键同时授权 `release_media`(撤回自己寄存的那条引用):配额有上限,
 * 没有撤回口的配额等于"用满即永久坏掉",不成立。撤回只删本意识的寄存引用,
 * 不删字节(字节归回收器按引用归零处理),因此不是额外的信任面。
 */
export const GHOST_CINDY_MEDIA_ACTIONS = ['deposit'] as const;
export type GhostCindyMediaAction = (typeof GHOST_CINDY_MEDIA_ACTIONS)[number];

/**
 * cindy 槽能力详单(卡槽⑤配套,原名模型槽,2026-07-11 设计定案):声明"这个意识被允许
 * 向主机点哪几类代办"——只有类目与动作,**不含任何具体模型/供应商信息**
 * (选型权在主机的解析表:调用时显式点名 > 意识专属覆盖 > 用户能力偏好 >
 * 出厂默认;意识只表达意图,永不腐烂)。装入确认框与代办资格审共同消费。
 */
export interface GhostCindyNeeds {
  /** 图像类:generate=出图,edit=改图(改图仅限本意识名下媒体)。 */
  image?: GhostModelImageAction[];
  /** 视频类:generate=文生视频,edit=参考图生视频(源图仅限本意识名下媒体,1–2 张首/尾帧)。 */
  video?: GhostModelVideoAction[];
  /** 媒体类:deposit=寄存自己手里的媒体字节入总仓(换指纹,兼授权 release_media)。 */
  media?: GhostCindyMediaAction[];
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

/* ── network 槽详单(docs/dev-rules/plugin-security-and-authoring.md)──────────────────────────────────
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
 * (`*.example.com`)只命中子域(`a.example.com`),不命中裸域本身——
 * 作者两者都要就两条都声明,规则不做隐式扩张。
 */
export function ghostNetworkHostMatches(pattern: string, hostname: string): boolean {
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1;
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
 * 去换一个临时令牌(如 mivo 的 key→session 二段式)。声明后主机照单代办:
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
export const GHOST_OAUTH_SCOPES_MAX = 32;
/** OAuth broker 模式可声明的备用 clientId 上限(默认 clientId 不计入)。 */
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
 * OAuth 凭证声明(source: 'oauth',2026-07-13 与 Lizi 定案"通用声明式"):
 * 平台不预设 provider 名单——意识声明"去哪授权、要什么 scope",clientId /
 * clientSecret 由用户在意识设置页自填(经 /oauth 只写通道入库),装入确认框
 * 全量展示授权域名与 scopes,用户知情自担。声明化的是**参数**不是**代码**:
 * 授权流程(拉浏览器、loopback 回调、state/PKCE 校验、code 换 token、刷新)
 * 永远由主机可信代码执行(cindy-brain/ghostOauthFlow.ts),意识无从插手,
 * access / refresh token 与 client 凭证全程不进沙箱,注入按 inject 声明由
 * networkSlot 出网时现取现注(401 作废重刷重试一次,与 exchange 同套路)。
 */
export interface GhostSecretOauthDecl {
  /** 授权页地址(https;域名必须命中 network.hosts 白名单——确认框上的域名集合 = 全部出网面)。 */
  authorizeUrl: string;
  /** code / refresh token 交换端点(https;域名必须命中 hosts——clientSecret 只流向用户同意过的域名)。 */
  tokenUrl: string;
  /**
   * 可选:作者内置的 OAuth 客户端 ID(2026-07-13 Lizi 定案,filo-google
   * 开箱即用前置)。声明后用户零配置即可点"连接账号";用户在设置页自填的
   * client 凭证**覆盖**内置值(清除自填 = 回落内置)。桌面应用的 client
   * 凭证按 Google 官方口径本非机密(installed-app),写进包里不引入新泄露面;
   * 授权仍需用户在浏览器里亲自同意,凭证本身访问不了任何数据。
   */
  clientId?: string;
  /**
   * 可选:broker 模式下允许意识在单次连接时选择的备用客户端 ID。
   * 典型场景是同一官方意识按宿主 region 连接不同 OAuth App。值都是公开
   * 标识,secret 仍由对应区域的 broker 持有;主机只接受本数组或 clientId
   * 明确声明过的值,意识不能借 connect 请求切到任意第三方应用。
   * 仅 tokenBroker 模式可用,默认 clientId 不要在这里重复声明。
   */
  clientIdAlternatives?: string[];
  /** 可选:内置 client 的 secret(与 clientId 成对;纯 PKCE 服务商可省略)。 */
  clientSecret?: string;
  /** 申请的 scope 列表(0–32 条,确认框逐条展示;缺省 = 不带 scope 参数)。 */
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
   * displayTemplate(可选,2026-07-15 cindy-slack 前置):人类可读的展示名
   * 模板,`{点分路径}` 占位符从同一份身份响应取值(如 Slack auth.test 的
   * `"{team} · {user}"`)。与 labelPath 分工:labelPath 指向**稳定且唯一**的
   * 身份键(user_id / 邮箱),是重复授权时同身份合并的判定键;displayTemplate
   * 只管展示(设置页 / 账号工具看到的名字),任一占位符取不到值时整体降级
   * 为空(回落显示 labelPath 标签)。不声明 = 展示名就用 labelPath 的值
   * (邮箱这类本身可读的服务商不需要它)。
   *
   * avatarPath(可选,2026-07-17 xd-feishu 设置页前置):头像 URL 在身份
   * 响应里的点分路径(如飞书 user_info 的 "data.avatar_thumb")。主机连接
   * 时按该路径取 https 地址、**不带任何凭证**地下载小图(mime / 体积硬顶),
   * 转 data URL 存主机保险库,经 /oauth 只读回给意识自绘设置页展示——图片
   * 字节不出主机、沙箱 CSP(img-src data:)恰好放行。取不到 / 下载失败一律
   * 降级无头像,不阻断授权。
   */
  identity?: { url: string; labelPath: string; displayTemplate?: string; avatarPath?: string };
  /**
   * 可选:loopback 回调固定端口(1024–65535)。Atlassian 这类服务商要求回调
   * URI 与应用注册值精确匹配(含端口),声明后主机授权引擎钉死
   * `http://127.0.0.1:<port>/callback`(端口被占用时结构化报错引导重试);
   * 缺省 = 随机端口(Google 等允许任意 loopback 端口的服务商)。
   */
  redirectPort?: number;
  /**
   * 可选:XDT server token broker 的 provider slug(2026-07-14,xd-atlassian
   * 意识化前置)。声明后 code 换 token 与 refresh 不直连 tokenUrl,改经主机
   * 调 XDT server 的授权 broker(带登录 JWT;client secret 在服务端,不随包
   * 分发)。与 clientSecret 互斥。**仅第一方官方前缀意识可用**——校验层保持
   * 纯函数不感知装入语境,门控在运行时装入闸与连接闸(cindy-brain)。
   */
  tokenBroker?: string;
  /**
   * 可选:broker 弹跳回调(双地址模型,2026-07-15 cindy-slack 意识化前置)。
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
 * 凭证值来源(2026-07-13,xd_service 意识化前置):
 * - 'user'(缺省):值由用户在该意识设置页填入主机保险库;
 * - 'login-email':值 = 主机当前登录账号的邮箱——主机注入时现取登录态,
 *   设置页只读展示该邮箱(不可编辑、不进保险库);未登录 / 登录态缺 email
 *   时 fail-closed 报错并引导重新登录。适用于"服务端按登录邮箱派生鉴权"
 *   的第一方服务(如 pages 服务的 pages_<email> token,经 inject.format
 *   的静态前缀完成派生)。
 * - 'oauth'(2026-07-13,google/conf/jira 意识化前置):值 = 主机托管 OAuth
 *   授权换来的 access token——用户在意识设置页填 client 凭证并点"连接账号",
 *   主机跑授权流程并保管全部令牌,出网时现取新鲜 token 注入(见
 *   GhostSecretOauthDecl;必须同时声明 oauth 详单)。
 *
 * ('login-feishu-token' 已于 2026-07-17 随飞书登录整体下线退役——xd-feishu
 * 改走 source:'oauth' + tokenBroker:'feishu';存量已装清单由内置意识播种器
 * 按指纹覆盖自愈,未覆盖前该意识加载被拒属预期。)
 */
export const GHOST_SECRET_SOURCES = ['user', 'login-email', 'oauth'] as const;
export type GhostSecretSource = (typeof GHOST_SECRET_SOURCES)[number];

/**
 * user 凭证有两条 Host 受控收单路径:
 * - 调用前缺失时，Setup Runtime 根据本声明生成统一 inline_form；
 * - 详情页由 settingsHtml 经 `/secrets` 只写通道长期管理、替换和清除。
 *
 * 两条路径都只把明文一次性交给 Main 保险库，插件运行时只能获得 Host 注入后的
 * 请求，读不回原值。历史 `input` 字段仍退役：`input: "ghost"` 仅兼容接受并忽略，
 * `input: "host"` 拒绝；当前仍要求 user 凭证同时声明 settingsHtml 作为管理入口。
 */

/** 凭证声明：Host 用名字与说明生成 Setup 字段，值只写入主机保险库。 */
export interface GhostSecretDecl {
  /** 凭证键(意识内唯一):小写字母开头,允许小写/数字/下划线,1–32。 */
  key: string;
  /** 给用户看的名称(装入确认框展示)。 */
  label: string;
  /** 凭证值来源;缺省 'user'(校验归一化:'user' 不落清单,只保留 'login-email')。 */
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

/** preview 槽:可打开预览的域名模式条数上限(范围越小越好,同 network 精神)。 */
export const GHOST_PREVIEW_MAX_HOSTS = 4;
/** preview 槽:单次请求打开的 URL 长度上限(字符)。 */
export const GHOST_PREVIEW_URL_MAX_CHARS = 2048;
/** preview 槽:同一插件两次打开预览的最小间隔 ms(防标签页刷屏)。 */
export const GHOST_PREVIEW_OPEN_MIN_INTERVAL_MS = 5000;

/**
 * preview 槽详单(与 slots 含 'preview' 严格成对——有槽必有详单:范围是
 * 本能力的全部知情面,不允许"先装后说")。hosts 语法与 network 域名白名单
 * 一致(支持 `*.` 单层前缀通配),另特批 loopback 单段名(本地 dev server
 * 是预览的正当主场,network 语法"至少两段"表达不了它)。装入确认框逐条展示。
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
 * 连字符)。比 learn-host 的 SKILL_NAME_RE 更严:意识 id 允许含 `--`
 * (GHOST_ID_RE),共享技能根的链接名是 `<id>--<name>`,只有 name 侧禁 `--`,
 * 按"最后一个 `--`"拆分才唯一,不同插件才不可能撞出同一个链接名。
 */
export const GHOST_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** skill 槽单条技能声明(全声明式:确认框展示的就是这里的字段)。 */
export interface GhostSkillItem {
  /** 包内技能目录(安全相对路径,目录内必须有 SKILL.md)。 */
  dir: string;
  /**
   * 技能名。必须与 SKILL.md frontmatter 的 name 逐字一致(打包与装入双侧
   * 强制)——确认框里用户看到的,必须就是 Agent 实际读到的。
   */
  name: string;
  /** 技能说明。必须与 SKILL.md frontmatter 的 description 逐字一致(同上)。 */
  description: string;
}

/**
 * skill 槽详单(与 slots 含 'skill' 严格成对——有槽必有详单:捆绑了什么技能
 * 是本能力的全部知情面,不允许"先装后说")。装入确认框逐条展示。
 */
export interface GhostSkillNeeds {
  items: GhostSkillItem[];
}

/**
 * preview 槽运行期 URL 守门(纯函数,主机侧调用):
 * - 只收 https;http 仅放行 loopback(localhost / 127.0.0.1 / [::1])——本地
 *   开发服务器是预览的正当主场;
 * - 不收 URL 内嵌凭证(user:pass@,钓鱼与凭证外带面);
 * - hostname 必须命中 preview.hosts 声明(逐模式 ghostNetworkHostMatches)。
 */
export function ghostPreviewUrlAllowed(manifest: GhostManifest, rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > GHOST_PREVIEW_URL_MAX_CHARS) {
    return false;
  }
  const hosts = manifest.preview?.hosts ?? [];
  if (hosts.length === 0) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return false;
  return hosts.some((pattern) => ghostNetworkHostMatches(pattern, hostname));
}

/**
 * 身份卡里声明过的全部外链地址(来源 = network.secrets[].url 与
 * node.secretBindings[].url,装包时
 * 已校验仅 https):意识 webview 外链闸(GhostExternalLinkGate)的白名单,
 * settingsHtml/面板里的 <a href> 逐字命中才转系统浏览器打开。
 */
export function ghostExternalLinkUrls(manifest: GhostManifest): string[] {
  return [...(manifest.network?.secrets ?? []), ...(manifest.node?.secretBindings ?? [])]
    .map((s) => s.url)
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

/**
 * 注入头名黑名单:协议关键头由主机独占,作者声明命中即拒装
 * (小写比较;Cookie 也拒——会话粘连语义不给意识)。
 */
export const GHOST_NETWORK_FORBIDDEN_INJECT_HEADERS: readonly string[] = [
  'host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'origin', 'referer',
  // content-type 由请求语义决定(上传通道的 multipart boundary 依赖它),
  // 不许被凭证注入声明占用——401 重换/跨域跳转的重注入会砸掉 boundary。
  'content-type',
];

/* ── setup 就绪声明(使用前置检查,2026-07-21)──────────────────────────
 *
 * 作者用一份声明回答「这段意识用之前必须配好什么」,宿主在用户点「使用」
 * 时据此做确定性检查(规则 9:检查逻辑在宿主代码,作者只交知识),未就绪
 * 弹窗引导去配置页。语义:
 * - requires 组间 = 全部满足(allOf);组内 anyOf = 满足其一即可
 *   (Web Search 的 Brave / Tavily 任一 key 即典型组内关系);
 * - 条目三种引用:'secret:<key>'(network.secrets 声明的凭证:user 源查
 *   已保存、oauth 源查已连接账号)、'connection:<key>'(network.connections
 *   至少一条)、{ kv: '<key>', label: '...' }(意识 /kv 参数非空——kv 键名
 *   宿主无先验,label 必填供弹窗展示);
 * - 'login-email' 源凭证恒就绪,引用它属作者误解 → 拒装;
 * - 缺省(不声明 setup)= 宿主启发式:声明过凭证/连接的意识,任一项就绪
 *   即算 ready;什么都没声明的恒 ready。现有内置意识全部被启发式正确覆盖,
 *   只有启发式判不准才需要写本字段——两种典型:「必须同时配 A 和 B」用
 *   多组声明;「凭证全是可选项、不配也能用」用 requires: [](显式 opt-out,
 *   恒就绪,启发式不再兜底)。
 */

/** setup.requires 需求组条数上限。 */
export const GHOST_SETUP_MAX_GROUPS = 8;
/** Host-owned requirement groups (e.g. model-provider capability). */
export const GHOST_SETUP_MAX_HOST_GROUPS = 2;
/** 每个需求组内 anyOf 条目上限。 */
export const GHOST_SETUP_MAX_ITEMS_PER_GROUP = 8;
/** 一张 setup 卡最多需要覆盖 manifest 合法声明的全部可操作条目。 */
export const GHOST_SETUP_MAX_STEPS =
  (GHOST_SETUP_MAX_GROUPS + GHOST_SETUP_MAX_HOST_GROUPS) * GHOST_SETUP_MAX_ITEMS_PER_GROUP;
/**
 * Host-owned setup providers may append requirements that do not exist in the
 * plugin manifest (for example, a shared client capability). Reserve a bounded
 * number of steps for those Core-owned requirements so a maximally valid
 * manifest still crosses the Main → Renderer interaction boundary intact.
 */
export const GHOST_SETUP_MAX_HOST_STEPS = 8;
/** setup interaction/plan transport capacity, including Host-owned steps. */
export const GHOST_SETUP_MAX_INTERACTION_STEPS =
  GHOST_SETUP_MAX_STEPS + GHOST_SETUP_MAX_HOST_STEPS;
/** setup kv 引用的键名形状(意识 /kv 顶层键;点号仅作普通字符,不做路径下钻)。 */
export const GHOST_SETUP_KV_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 归一化后的单条 setup 需求(原始清单里 secret/connection 是字符串引用,kv 是对象)。 */
export type GhostSetupRequirement =
  | { kind: 'secret'; key: string }
  | { kind: 'connection'; key: string }
  | { kind: 'kv'; key: string; label: string };

/** setup 需求组:组内 anyOf 任一满足即组满足。 */
export interface GhostSetupGroup {
  anyOf: GhostSetupRequirement[];
}

/** setup 就绪声明(见上方块注释;不变量由 validateGhostManifest 保证)。 */
export interface GhostSetupDecl {
  requires: GhostSetupGroup[];
}

/**
 * 单条需求的就绪展示项(ghosts:setup-status IPC 载荷;main 判定、renderer
 * 弹窗展示)。kind 决定文案口径:key = 填 API key,oauth = 连接账号,
 * connection = 添加连接,kv = 填自定义参数。
 */
export interface GhostSetupStatusItem {
  /** 需求引用原文(secret:<key> / connection:<key> / kv:<key>),排障与去重用。 */
  ref: string;
  /** 展示名(secret/connection 取 network 声明的 label;kv 取 setup 声明的 label)。 */
  label: string;
  kind: 'key' | 'oauth' | 'connection' | 'kv';
}

/** 意识配置就绪状态(main 侧 evaluateGhostSetup 产出)。 */
export interface GhostSetupStatus {
  ready: boolean;
  /**
   * 未满足的需求组(每组列出仍缺的条目;组内任一配好即满足,弹窗按
   * 「A / B」口径展示)。ready 时恒为空。
   */
  missingGroups: GhostSetupStatusItem[][];
  /** OAuth 账号存在但全部过期的条目(文案区分「重新连接」)。ready 时恒为空。 */
  reauth: GhostSetupStatusItem[];
}

/** Setup Runtime 暴露给 Agent / Renderer 的需求类型；不包含任何配置值。 */
export type GhostSetupRequirementKind =
  | 'oauth'
  | 'secret'
  | 'connection'
  | 'plugin_config'
  | 'client_config';

/** Host 对单条 requirement 的权威判定。 */
export type GhostSetupRequirementState = 'missing' | 'expired' | 'satisfied';

/** Setup Runtime 允许 Agent 选择、但只能由 Host 执行的动作。 */
export type GhostSetupActionKind =
  | 'oauth_connect'
  | 'open_plugin_settings'
  | 'manage_connection'
  | 'open_client_settings'
  | 'inline_form';

/** Secret 输入沿用 /secrets 的字符上限；值本身永远不进入 Shared DTO。 */
export const GHOST_SECRET_VALUE_MAX_CHARS = 4096;

export interface GhostSetupInlineSecretField {
  /** v1 只支持单字段，固定 id 防止 Renderer/Agent 构造任意存储键。 */
  id: 'value';
  type: 'secret';
  label: string;
  description?: string;
  placeholder?: string;
  /**
   * Host 从 manifest 的 network.secrets[].url 生成的辅助入口。
   * 仅供可信 Desktop UI 展示；MCP 边界会剥离，Agent 不能提供或改写 URL。
   */
  externalLink?: {
    url: string;
  };
  required: true;
  maxLength: number;
}

export type GhostSetupAllowedAction =
  | {
      /** Host 生成的动作引用；执行时必须按最新 assessment 再校验，不能直接当执行参数。 */
      id: string;
      kind: Exclude<GhostSetupActionKind, 'inline_form'>;
    }
  | {
      /** Host 生成的散列动作引用；不编码或暴露 Secret storage key。 */
      id: string;
      kind: 'inline_form';
      form: {
        /** v1 仅支持一个 Secret 字段。 */
        fields: [GhostSetupInlineSecretField];
      };
    };

export interface GhostSetupAssessmentItem {
  /** requirement 的稳定关联引用；不携带配置值，也不是可执行能力。 */
  ref: string;
  kind: GhostSetupRequirementKind;
  label: string;
  description?: string;
  state: GhostSetupRequirementState;
  actions: GhostSetupAllowedAction[];
}

export interface GhostSetupAssessmentGroup {
  id: string;
  mode: 'any_of';
  items: GhostSetupAssessmentItem[];
}

/**
 * Setup Runtime 的完整判定结果。groups 之间 all-of，组内 any-of；
 * revision 由 Host 变更总线维护，用于丢弃过期卡片更新。
 */
export interface GhostSetupAssessment {
  state: 'ready' | 'required';
  revision: number;
  groups: GhostSetupAssessmentGroup[];
}

/** Agent 可选提供的展示编排；身份、Action 和完成状态仍由 Host 决定。 */
export interface GhostSetupPlan {
  assessmentRevision: number;
  intro?: string;
  steps: Array<{
    id: string;
    requirementRefs: string[];
    title: string;
    description: string;
    actionId: string;
  }>;
}

export type GhostSetupStepPhase =
  | 'pending'
  | 'action_running'
  | 'waiting_external'
  | 'verifying'
  | 'satisfied'
  | 'failed'
  | 'cancelled';

/**
 * Setup 卡片跨进程／跨设备传输的稳定错误码。
 *
 * Main 可以保留内部错误详情用于诊断，但 interaction snapshot 只携带这些
 * 与 locale 无关的 code；每个 Renderer 按自己的语言映射可操作文案。
 */
export const GHOST_SETUP_ERROR_CODES = [
  'ACTION_FAILED',
  'ACTION_STALE',
  'AUTH_CANCELLED',
  'AUTH_FAILED',
  'AUTH_NETWORK',
  'AUTH_SERVICE_UNAVAILABLE',
  'INLINE_INVALID',
  'INLINE_UNAVAILABLE',
  'SAVE_FAILED',
  'WINDOW_CLOSED',
  'TARGET_UNAVAILABLE',
  'ASSESSMENT_FAILED',
  'TIMEOUT',
] as const;

export type GhostSetupErrorCode = (typeof GHOST_SETUP_ERROR_CODES)[number];

/** 不可信 interaction payload 的稳定 Setup 错误码守卫。 */
export function isGhostSetupErrorCode(value: unknown): value is GhostSetupErrorCode {
  return (
    typeof value === 'string' &&
    (GHOST_SETUP_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** ghost.json 清单(不变量由 validateGhostManifest 保证)。 */
export interface GhostManifest {
  /** 清单格式版本,恒 2(v1 声明型已于 2026-07-12 移除,无存量不留兼容)。 */
  schemaVersion: 2;
  /** 唯一标识,同时是安装目录名与 panelKind 后缀。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 版本字符串(不强制 semver,仅展示用)。 */
  version: string;
  /** 作者展示名(仅展示用)。 */
  author?: string;
  /**
   * 本地化资源路径。声明后必须至少提供英文；宿主按当前应用语言读取，
   * 当前语言未提供时固定回退英文。路径均位于插件安装目录内。
   */
  locales?: Partial<Record<SupportedLocale, string>> & { en: string };
  /**
   * 宿主解析清单后附加的当前语言，只用于运行时视图与 webview 刷新。
   * 不属于 ghost.json 作者字段；validateGhostManifest 会忽略包内同名输入。
   */
  resolvedLocale?: SupportedLocale;
  /**
   * 意识自我介绍(1–300 字,仅展示用):这段意识是干嘛
   * 的、给谁用。装入确认框与详情页展示;与 tools[].description(给 AI 看的
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
  /** Agent 新回合能力详单；须与 slots 中的 `agent` 成对。 */
  agent?: GhostAgentNeeds;
  /** 随包本地 Node 工作进程详单；须与 slots 中的 `node` 成对。 */
  node?: GhostNodeNeeds;
  /**
   * 设置页「自定义设置区」界面入口(可选;安装目录内相对路径,意识自绘)。
   * 与面板同款沙箱 webview 渲染(零桥、分区断网、CSP 'self'),主题 token
   * 由主机灌入。调用前缺失的 user Secret 可由 Host Setup 卡收单；详情页仍可
   * 通过同源只写 `/secrets` 管理、替换和清除。自定义参数持久化走 `/kv`，
   * Secret 不得写入 `/kv`。
   */
  settingsHtml?: string;
  /**
   * 自定义设置区固定高度(px,可选;160–800)。缺省 = 宿主量 guest 内容
   * 高度自适应(同区间收口);声明本字段 = 固定高度(内容动态增减的设置
   * 页用它避免抖动)。须与 settingsHtml 成对声明。
   */
  settingsHeight?: number;
  /** 能力白名单(没声明的槽,运行时接口不存在)。 */
  slots: GhostSlot[];
  /**
   * card 槽能力详单(与 slots 含 'card' 成对;缺省 = 仅渲染,无外链)。
   * externalLinks: true 时卡片内可声明 data-ghost-link,点击经宿主确认框后打开浏览器。
   */
  card?: GhostCardNeeds;
  /** 注册给 agent 的工具声明(与 slots 含 'tool' 成对)。 */
  tools?: GhostToolDecl[];
  /**
   * cindy 槽能力详单(与 slots 含 'cindy' 成对;缺省 = 零能力,任何代办
   * 都会被拒并提示作者补声明)。清单里的旧字段名 model 在校验层作别名
   * 收入本字段。
   */
  cindy?: GhostCindyNeeds;
  /**
   * 订阅槽详单(与 slots 含 'subscribe' 成对;缺省 = 零事件)。
   * hooks 非空时 launch 必须为 'resident'(校验强制)。
   */
  subscribe?: GhostSubscribeNeeds;
  /**
   * network 槽详单(与 slots 含 'network' 成对;缺省 = 零能力)。
   * 域名白名单 + 凭证声明,装入确认框逐项展示,运行期主机代发并守门。
   */
  network?: GhostNetworkNeeds;
  /**
   * preview 槽详单(与 slots 含 'preview' 严格成对):可在右侧栏内置浏览器
   * 打开预览标签页的域名白名单。
   */
  preview?: GhostPreviewNeeds;
  /**
   * skill 槽详单(与 slots 含 'skill' 严格成对):随包捆绑的 Agent Skills 清单。
   * 启用时主机链接进共享技能根,Claude Code 与 Codex 双端可见;字段不参与
   * 本地化(必须与 SKILL.md 逐字一致,见 GhostSkillItem)。
   */
  skill?: GhostSkillNeeds;
  /**
   * 就绪声明(使用前置检查,见 GhostSetupDecl 块注释):作者声明「用之前
   * 必须配好什么」,宿主点「使用」时确定性检查并引导配置。缺省 = 启发式
   * (声明过凭证/连接的意识任一项就绪即 ready)。
   */
  setup?: GhostSetupDecl;
  /**
   * 显式触发指令(聊天输入框 `/<command>`,与 Skill 共用命令入口;
   * 2026-07-09 Lizi 定案:由意识作者自定,装入时主机与已装意识查重,
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
}

/**
 * 单个插件 locale 文件的 manifest 文案。协议键、工具名和参数名不翻译；
 * tools 以稳定 tool name 对齐，避免数组顺序变化导致翻译错位。
 * 所有条目都是可选项：缺失的条目在解析时回退原 manifest 文案。
 */
export interface GhostManifestLocaleResource {
  name?: string;
  description?: string;
  whenToUse?: string;
  tools?: Record<string, {
    description: string;
    /** JSON Pointer → 该参数 schema 节点已有的 title / description 翻译。 */
    parameters?: Record<string, { title?: string; description?: string }>;
  }>;
  panel?: { title: string };
  network?: {
    secrets?: Record<string, { label: string; hint?: string }>;
    connections?: Record<string, { label: string; hint?: string }>;
  };
  node?: {
    secretBindings?: Record<string, { label: string; hint?: string }>;
  };
  setup?: {
    kv?: Record<string, { label: string }>;
  };
}

/** 单个插件 locale JSON 的字节上限。Forge 与装入侧共用，避免两端契约漂移。 */
export const GHOST_LOCALE_MAX_BYTES = 64 * 1024;

/** 已装入主机的意识(清单 + 安装位置 + 启用态)。 */
export interface InstalledGhost {
  manifest: GhostManifest;
  /** 安装目录绝对路径(userData/brain/<id>)。 */
  dir: string;
  /**
   * 是否启用。停用 = 面板与能力休眠(不注册、不渲染),但意识仍装着、
   * 布局位置保留;重新启用即恢复。真身是安装目录里的 `.disabled` 标记文件。
   */
  enabled: boolean;
  /** 安装时由主机验出的来源/签名等级；作者清单不能自报。 */
  trust?: GhostTrustInfo;
  /**
   * 图标的 data URL(main 按 manifest.icon 读安装目录生成;未声明图标、
   * 文件缺失或超限时缺省)。renderer 直接作 <img src> 用,无需 loading 态。
   */
  iconDataUrl?: string;
}

/** 插件包的来源与审核等级；决定 UI 徽标，不改变运行时 slot 权限。 */
export type GhostTrustLevel =
  | 'cindy-official'
  | 'reviewed'
  | 'verified-publisher'
  | 'unverified';

export interface GhostTrustInfo {
  level: GhostTrustLevel;
  publisherSigned: boolean;
  publisherVerified: boolean;
  reviewed: boolean;
  publisherName?: string;
  publisherKeyId?: string;
  reviewerName?: string;
  /** 包含 review 声明但当前客户端不认识该审核 key，不因此抬高等级。 */
  unknownReviewer?: boolean;
}

/** 意识面板的 panelKind(布局树寻址用)。 */
// 返回类型收窄到模板字面量:右侧栏 TabKindId 含 `ghost:${string}` 分支,
// 调用方无需再 as 断言;对既有 string 消费方完全兼容。
export function ghostPanelKind(id: string): `ghost:${string}` {
  return `${GHOST_PANEL_KIND_PREFIX}${id}`;
}

/**
 * 意识的内容清单(2026-07-09 Lizi 定案:界面不显示档位/形态词,只如实
 * 描述"这段意识包含什么")。返回 i18n key 的后缀,消费方拼
 * `settings.ghosts.contents.<key>`;顺序即展示顺序(先看得见的,后能力)。
 */
export function ghostContentKeys(manifest: GhostManifest): string[] {
  const keys: string[] = [];
  if (manifest.panel) keys.push('panel');
  if (manifest.settingsHtml) keys.push('settingsUi');
  keys.push('code');
  for (const slot of manifest.slots) {
    if (slot === 'cindy') keys.push('slotCindy');
    else if (slot === 'agent') keys.push('slotAgent');
    else if (slot === 'node') keys.push('slotNode');
    else if (slot === 'tool') keys.push('slotTool');
    else if (slot === 'subscribe') keys.push('slotSubscribe');
    else if (slot === 'card') keys.push('slotCard');
    else if (slot === 'network') keys.push('slotNetwork');
    else if (slot === 'notify') keys.push('slotNotify');
    else if (slot === 'fs') keys.push('slotFs');
    // skill 是信任面最高的内容(给主 Agent 灌指令),详情页必须如实露出。
    else if (slot === 'skill') keys.push('slotSkill');
    else if (slot === 'workspace') keys.push('slotWorkspace');
    // 'panel' 槽已由 manifest.panel 覆盖,不重复
  }
  return keys;
}

export function isValidGhostId(id: unknown): id is string {
  return typeof id === 'string' && GHOST_ID_RE.test(id);
}

/**
 * 官方意识 id 前缀(docs/dev-rules/plugin-security-and-authoring.md):`cindy-` 保留给随包预装的
 * 第一方意识。用户装入通道(拖入/选文件/forge 转交)对该前缀**在 packaged
 * 版本上拒装**——否则卸载内置意识后,同 id 的第三方包可抢注官方身份,连带
 * 蹭走凭证别名(providerSecrets 的 GHOST_SECRET_STORAGE_ALIASES 按 id 生效,
 * 抢注者能拿到用户历史填过的机器级 key)。dev 构建豁免:官方意识的开发迭代
 * 本来就靠打包重装。
 */
export const GHOST_OFFICIAL_ID_PREFIX = 'cindy-';

/**
 * 官方保留前缀全集(2026-07-13 起增补 `filo-`:filo-google 更名时脱离
 * cindy- 命名空间,防抢注保护必须跟着走;同日增补 `xd-`:xd-mivo 更名同因
 * ——官方密钥别名按 id 登记,前缀不保留会被第三方抢注蹭钥匙)。
 * 新增官方前缀在此登记。
 */
export const GHOST_OFFICIAL_ID_PREFIXES: readonly string[] = [GHOST_OFFICIAL_ID_PREFIX, 'filo-', 'xd-'];

/** id 是否属于官方保留命名空间。 */
export function isOfficialGhostId(id: string): boolean {
  return GHOST_OFFICIAL_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * Bundled Ghosts whose execution depends on Cindy account-plane services.
 *
 * Local app sessions may still use external Ghosts and direct/BYOK built-ins
 * (GitHub, GitLab, Google, web search, Mermaid). These entries are hidden and
 * rejected by the main process unless a verified cloud session is active.
 */
export const CINDY_ACCOUNT_GHOST_IDS: ReadonlySet<string> = new Set([
  'cindy-art',
  'xd-pages',
  'xd-feishu',
  'xd-atlassian',
  'xd-mivo',
]);

export function isCindyAccountGhostId(id: string): boolean {
  return CINDY_ACCOUNT_GHOST_IDS.has(id);
}

/**
 * 装入确认框的单项权限。
 * 纯数据描述:renderer 拼 `settings.ghosts.perm.<labelKey>` 翻译,`detail` 是
 * 作者自由文本(如工具描述)如实展示不翻译,`detailKey` 是主机固定说明的
 * i18n 后缀(如可执行代码的沙箱说明)——两者互斥。
 */
export interface GhostPermissionItem {
  /** 稳定键:更新 diff 按它对齐(内容变化视为移除+新增,如面板换边)。 */
  key: string;
  /** 图标分组(renderer 按 kind 选图标)。 */
  kind: 'cindy' | 'agent' | 'node' | 'tool' | 'command' | 'panel' | 'code' | 'subscribe' | 'card' | 'network' | 'notify' | 'fs' | 'session-context' | 'pick' | 'preview' | 'skill' | 'workspace';
  /** i18n key 后缀,消费方拼 `settings.ghosts.perm.<labelKey>`。 */
  labelKey: string;
  /** i18n 插值参数(工具名、指令名、面板标题等)。 */
  labelArgs?: Record<string, string>;
  /** 作者自由文本补充(如实展示,不翻译)。 */
  detail?: string;
  /** 主机固定说明的 i18n key 后缀(拼法同 labelKey)。 */
  detailKey?: string;
  /**
   * detailKey 的 i18n 插值参数(与 labelArgs 分开:说明行里的插值是**主机
   * 政策数字**,如寄存字节上限,由常量单源注入,不让四份 locale 各写死一个
   * 数字。没有 detailArgs 的条目行为与从前逐字节相同)。
   */
  detailArgs?: Record<string, string>;
}

/** cindy 详单能力键 → 权限项 labelKey(新增类目/动作在此登记)。 */
const GHOST_CINDY_PERM_LABEL: Record<string, string> = {
  'image.generate': 'cindyImageGenerate',
  'image.edit': 'cindyImageEdit',
  'video.generate': 'cindyVideoGenerate',
  'video.edit': 'cindyVideoEdit',
  'media.deposit': 'cindyMediaDeposit',
};

/**
 * cindy 详单能力键 → 主机固定补充说明的 labelKey(可选;没有条目就不带 detail)。
 * 寄存是唯一"写你的媒体库"的能力,上限必须在确认框里如实写出来(媒体规则:
 * 装入确认要展示持久媒体占用上限)。
 */
const GHOST_CINDY_PERM_DETAIL: Record<string, string> = {
  'media.deposit': 'cindyMediaDepositDetail',
};

/**
 * 字节 → 确认框里给用户看的容量(含单位)。整数向下取整,不给"511.99"这种数;
 * 整 GB 用 GB 表述(1GB 显示成"1024 MB"读起来像凑数)。单位跟着数字一起从
 * 常量算出来,locale 里只留 {{quota}} 占位 —— 否则上限改成 GB 量级时,四份
 * locale 里写死的 "MB" 就成了错的。
 */
function formatGhostQuotaSize(bytes: number): string {
  const mb = Math.floor(bytes / (1024 * 1024));
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`;
  return `${mb} MB`;
}

/**
 * 从身份卡静态推导逐项权限清单(装入前无需运行任何意识代码)。
 * 顺序即展示顺序:Cindy 代办 → 注册工具 → 聊天指令 → 面板 → 订阅/卡片 →
 * 可执行代码(先能力后载体,与权限展示契约一致)。
 */
export function ghostPermissionItems(manifest: GhostManifest): GhostPermissionItem[] {
  const items: GhostPermissionItem[] = [];
  for (const [category, actions] of Object.entries(manifest.cindy ?? {})) {
    for (const action of actions ?? []) {
      const cap = `${category}.${action}`;
      const labelKey = GHOST_CINDY_PERM_LABEL[cap];
      const detailKey = GHOST_CINDY_PERM_DETAIL[cap];
      // 未登记的能力键不该出现(validateGhostManifest 已拦),防御性跳过。
      if (labelKey) {
        items.push({
          key: `cindy:${cap}`,
          kind: 'cindy',
          labelKey,
          ...(detailKey ? { detailKey } : {}),
          // 寄存上限由常量单源插值进确认框说明(媒体规则要求装入确认展示
          // 持久媒体占用上限);改常量四份 locale 自动跟随。
          ...(cap === 'media.deposit'
            ? { detailArgs: { quota: formatGhostQuotaSize(GHOST_CINDY_DEPOSIT_QUOTA_BYTES) } }
            : {}),
        });
      }
    }
  }
  // network 槽:域名逐条列(用户要逐个看到"将访问谁"),凭证逐条列
  // (只有名字,值是用户自己后来填的)。排在 Cindy 代办之后、工具之前——
  // 出网是仅次于拦截钩子的敏感能力,不能沉底。
  for (const host of manifest.network?.hosts ?? []) {
    // 域名行不带逐行 detail(多域名时会重复刷屏);"经主机代发、仅限白名单"
    // 的总说明由 code 条目的 codeDetailNetwork 一次讲清。
    items.push({
      key: `network:host:${host}`,
      kind: 'network',
      labelKey: 'networkHost',
      labelArgs: { host },
    });
  }
  // agent 槽:真人点击触发是基础档；后台自动触发另列一项高风险权限。
  if (manifest.slots.includes('agent')) {
    items.push({
      key: 'agent:user-action',
      kind: 'agent',
      labelKey: 'agentUserAction',
      detailKey: 'agentUserActionDetail',
    });
    if (manifest.agent?.background === true) {
      items.unshift({
        key: 'agent:background',
        kind: 'agent',
        labelKey: 'agentBackground',
        detailKey: 'agentBackgroundDetail',
      });
    }
  }
  // Node 是本机用户级执行权，不与浏览器沙箱的 `code` 混称。基础执行与
  // 常驻分别列出，用户能看懂“能运行”与“会一直运行”是两件事。
  if (manifest.slots.includes('node') && manifest.node) {
    items.unshift({
      key: 'node:execute',
      kind: 'node',
      labelKey: manifest.node.protocol === 'mcp-stdio' ? 'nodeMcp' : 'nodeRuntime',
      detailKey: 'nodeRuntimeDetail',
    });
    for (const binding of manifest.node.secretBindings ?? []) {
      const targetEntry = binding.entry ?? manifest.node.entry;
      const stableMethods = [...binding.methods].sort();
      items.unshift({
        key: `node:secret:${binding.key}:${targetEntry}:${stableMethods.join(',')}`,
        kind: 'node',
        labelKey: 'nodeSecret',
        labelArgs: { name: binding.label },
        detailKey: 'nodeSecretDetail',
        detail: binding.methods.join('\n'),
      });
    }
    if (manifest.node.lifecycle === 'resident') {
      items.unshift({
        key: 'node:resident',
        kind: 'node',
        labelKey: 'nodeResident',
        detailKey: 'nodeResidentDetail',
      });
    }
    // 代启子进程单列一行:执行权本质没变(仍限包内申报入口),但"会开几个
    // 进程"是用户该知道的事实。
    if (manifest.node.childSpawn === true) {
      items.unshift({
        key: 'node:child-spawn',
        kind: 'node',
        labelKey: 'nodeChildSpawn',
        detailKey: 'nodeChildSpawnDetail',
      });
    }
  }
  // skill 槽:技能指令由主 Agent 以用户全部权限执行、全项目生效、不受沙箱
  // 约束——信任面仅次于拦截钩子,逐条 unshift 到清单上部(倒序遍历保持声明
  // 顺序)。key 用 name 稳定对齐更新 diff;detail = 作者声明的 description
  // 原样展示(装入/打包校验已保证与 SKILL.md 逐字一致)。
  for (const skillItem of [...(manifest.skill?.items ?? [])].reverse()) {
    items.unshift({
      key: `skill:${skillItem.name}`,
      kind: 'skill',
      labelKey: 'skill',
      labelArgs: { name: skillItem.name },
      detailKey: 'skillDetail',
      detail: skillItem.description,
    });
  }
  // 多连接声明:逐条列"可连接你添加的 <连接类型>"——地址是用户后来自己加的
  // (且每次新增都过主机受信确认弹窗),装入时只能告知形态,不能列出具体域名。
  for (const conn of manifest.network?.connections ?? []) {
    items.push({
      key: `connections:${conn.key}`,
      kind: 'network',
      labelKey: 'networkConnections',
      labelArgs: { label: conn.label },
      detailKey: 'networkConnectionsDetail',
    });
  }
  for (const secret of manifest.network?.secrets ?? []) {
    // 来源分档文案:登录邮箱派生 vs 用户自填(意识 settingsHtml 收单——宿主
    // 凭证渲染已退役,user 凭证只剩这一档)。收单档文案不许说"意识代码无法
    // 读取"这种过头话:录入瞬间明文经过意识页面,知情同意面要如实。
    // key 不掺 source——同一凭证换档时更新 diff 显示为内容不变但文案已按
    // 新版渲染,可接受。
    if (secret.source === 'oauth' && secret.oauth) {
      // OAuth 凭证:展示授权域名 + scopes 全量如实列出(通用声明式的知情
      // 同意面——平台不预设 provider,用户看到的就是全部授权事实)。detail
      // 用作者声明的 scope 原文,不翻译不加工。
      let authorizeHost = secret.oauth.authorizeUrl;
      try {
        authorizeHost = new URL(secret.oauth.authorizeUrl).hostname;
      } catch {
        /* 校验已保证合法,防御性兜底原文 */
      }
      items.push({
        key: `network:secret:${secret.key}`,
        kind: 'network',
        labelKey: 'networkSecretOauth',
        labelArgs: { name: secret.label, host: authorizeHost },
        detailKey: 'networkSecretOauthDetail',
        ...(secret.oauth.scopes && secret.oauth.scopes.length > 0
          ? { detail: secret.oauth.scopes.join('\n') }
          : {}),
      });
      continue;
    }
    const identity = secret.source === 'login-email';
    items.push({
      key: `network:secret:${secret.key}`,
      kind: 'network',
      labelKey: identity ? 'networkSecretIdentity' : 'networkSecret',
      labelArgs: { name: secret.label },
      detailKey: identity ? 'networkSecretIdentityDetail' : 'networkSecretGhostInputDetail',
    });
  }
  // fs 槽:写文件是仅次于出网的敏感能力,紧随 network 之后展示。三档目的地
  // 与确认规则由 detailKey 的固定说明一次讲清(私有目录免确认/工作目录跟随
  // 会话权限/其它目录逐次确认),让用户装入前就知道边界在哪。
  if (manifest.slots.includes('fs')) {
    items.push({ key: 'fs', kind: 'fs', labelKey: 'fsWrite', detailKey: 'fsWriteDetail' });
  }
  // pick 槽:能弹系统选文件夹窗口。授权动作是用户亲手选中,装入时只告知
  // "它会来要"。
  if (manifest.slots.includes('pick')) {
    items.push({ key: 'pick', kind: 'pick', labelKey: 'pick', detailKey: 'pickDetail' });
  }
  // workspace 槽:能为指定项目目录创建/复用侧边栏会话入口。授权动作是用户
  // 亲选目录或点确认卡,装入时只告知"它会来要"。
  if (manifest.slots.includes('workspace')) {
    items.push({
      key: 'workspace',
      kind: 'workspace',
      labelKey: 'workspace',
      detailKey: 'workspaceDetail',
    });
  }
  // session-context 槽:派活时可获知当前会话的项目目录位置(路径信息,
  // 非文件访问权;node 槽的执行权另行单列)。
  if (manifest.slots.includes('session-context')) {
    items.push({
      key: 'session-context',
      kind: 'session-context',
      labelKey: 'sessionContext',
      detailKey: 'sessionContextDetail',
    });
  }
  // preview 槽:白名单域名如实逐行列出(detail 原样展示作者声明,同 oauth
  // scopes 风格),用户装入前就看到"它能打开谁的页面"。
  if (manifest.slots.includes('preview') && manifest.preview) {
    items.push({
      key: 'preview',
      kind: 'preview',
      labelKey: 'preview',
      detailKey: 'previewDetail',
      detail: manifest.preview.hosts.join('\n'),
    });
  }
  for (const tool of manifest.tools ?? []) {
    items.push({
      key: `tool:${tool.name}`,
      kind: 'tool',
      labelKey: 'tool',
      labelArgs: { name: tool.name },
      detail: tool.description,
    });
  }
  if (manifest.command) {
    items.push({
      key: `command:${manifest.command}`,
      kind: 'command',
      labelKey: 'command',
      labelArgs: { command: manifest.command },
    });
  }
  if (manifest.panel) {
    const position = manifest.panel.position ?? 'left';
    items.push({
      key: `panel:${position}`,
      kind: 'panel',
      labelKey: position === 'tab' ? 'panelTab' : 'panelLeft',
      labelArgs: { title: manifest.panel.title ?? manifest.name },
    });
  }
  for (const slot of manifest.slots) {
    if (slot === 'subscribe') {
      // 订阅两档分列:旁听(元数据)常规位;拦截是全部槽里权限最重的一档,
      // unshift 排到清单最顶(敏感项排最上)。
      if (manifest.subscribe?.topics?.length) {
        items.push({ key: 'subscribe:topics', kind: 'subscribe', labelKey: 'subscribeTopics' });
      }
      if (manifest.subscribe?.hooks?.length) {
        // 拦截钩按点分列(入口=改用户消息、出口=读并重渲 AI 回复,后者更敏感);
        // 整体 unshift 到清单最顶(拦截是全部槽里权限最重的一档),内部保持
        // 入口→出口顺序。will-user-message 沿用旧 key 'subscribe:hooks',老意识
        // 更新时 diff 不churn。
        const hookItems: GhostPermissionItem[] = [];
        if (manifest.subscribe.hooks.includes('will-user-message')) {
          hookItems.push({
            key: 'subscribe:hooks',
            kind: 'subscribe',
            labelKey: 'subscribeHooks',
            detailKey: 'subscribeHooksDetail',
          });
        }
        if (manifest.subscribe.hooks.includes('will-assistant-message')) {
          hookItems.push({
            key: 'subscribe:hooks:assistant',
            kind: 'subscribe',
            labelKey: 'subscribeAssistantReply',
            detailKey: 'subscribeAssistantReplyDetail',
          });
        }
        items.unshift(...hookItems);
      }
      // 有槽无详单 = 零事件,没有可告知的权限,不列。
    } else if (slot === 'card') {
      items.push({ key: 'card', kind: 'card', labelKey: 'card' });
      if (manifest.card?.externalLinks) {
        items.push({
          key: 'card:external-link',
          kind: 'card',
          labelKey: 'cardExternalLink',
          detailKey: 'cardExternalLinkDetail',
        });
      }
    }
    else if (slot === 'notify') {
      items.push({ key: 'notify', kind: 'notify', labelKey: 'notify', detailKey: 'notifyDetail' });
    }
  }
  // 常驻模式如实告知(用户要背一个后台进程);on-demand 是默认行为,不列。
  if (manifest.launch === 'resident') {
    items.push({ key: 'resident', kind: 'code', labelKey: 'resident', detailKey: 'residentDetail' });
  }
  // 可执行代码的沙箱说明分档:
  // - 有 node 槽时浏览器沙箱部分仍隔离,但不能再笼统说"无文件无网络"
  //   (Node 侧已摊过牌);
  // - 声明了 network 槽时不能宣称"无网络访问";
  // - 默认:纯沙箱、无文件无网络。
  let codeDetailKey: string;
  if (manifest.slots.includes('node')) codeDetailKey = 'codeDetailWithNode';
  else if (manifest.slots.includes('network')) codeDetailKey = 'codeDetailNetwork';
  else codeDetailKey = 'codeDetail';
  items.push({
    key: 'code',
    kind: 'code',
    labelKey: 'code',
    detailKey: codeDetailKey,
  });
  return items;
}

/** 更新确认框的权限 diff(按稳定 key 对齐;unchanged 保持新版条目)。 */
export interface GhostPermissionDiff {
  added: GhostPermissionItem[];
  removed: GhostPermissionItem[];
  unchanged: GhostPermissionItem[];
}

export function diffGhostPermissionItems(
  prev: GhostManifest,
  next: GhostManifest,
): GhostPermissionDiff {
  const prevItems = ghostPermissionItems(prev);
  const nextItems = ghostPermissionItems(next);
  const prevKeys = new Set(prevItems.map((i) => i.key));
  const nextKeys = new Set(nextItems.map((i) => i.key));
  const prevDetailByKey = new Map(prevItems.map((i) => [i.key, i.detail ?? '']));
  const added: GhostPermissionItem[] = [];
  const removed: GhostPermissionItem[] = [];
  const unchanged: GhostPermissionItem[] = [];
  for (const item of nextItems) {
    if (!prevKeys.has(item.key)) {
      added.push(item);
    } else if ((item.detail ?? '') !== prevDetailByKey.get(item.key)) {
      added.push(item);
    } else {
      unchanged.push(item);
    }
  }
  for (const item of prevItems) {
    if (!nextKeys.has(item.key)) {
      removed.push(item);
    } else if ((item.detail ?? '') !== (nextItems.find((n) => n.key === item.key)?.detail ?? '')) {
      removed.push(item);
    }
  }
  return { added, removed, unchanged };
}

/**
 * icon 允许的图片扩展名 → mime(校验与 main 读盘供图共用同一口径)。
 * 不收 svg:svg 可携带脚本,虽经 <img> 渲染不执行,仍不给这个面。
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
 * 无 `.`/`..` 段、字符集收敛,天然杜绝路径穿越与跨平台歧义。
 */
const GHOST_PATH_SEGMENT_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/;
export function isSafeGhostRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (p.includes('\\')) return false;
  const segments = p.split('/');
  return segments.every(
    (seg) => GHOST_PATH_SEGMENT_RE.test(seg) && seg !== '.' && seg !== '..',
  );
}

/**
 * 意识 webview 允许附加的入口 pathname 白名单(attach 闸的可测真身):
 * 面板 panel.html 与设置区 settingsHtml,声明哪个放行哪个;两者指向同一
 * 文件时去重。空数组 = 该意识没有任何可附加的自绘界面,闸口一律拒。
 */
export function ghostWebviewEntryPaths(manifest: GhostManifest): string[] {
  const paths: string[] = [];
  if (manifest.panel?.html) paths.push(`/${manifest.panel.html}`);
  if (manifest.settingsHtml) {
    const p = `/${manifest.settingsHtml}`;
    if (!paths.includes(p)) paths.push(p);
  }
  return paths;
}

/**
 * 装入带面板的意识后,把面板停进布局树(main 侧随 install 调用)。
 * - 树上已有同 kind 的 pane(重装)→ 返回 null:不动树,位置记忆保留、原位复活;
 * - 意识没声明面板 → null;
 * - position:'tab' → null:页签形态不进布局树,由右侧栏页签(ghostTabPlugins)承载;
 * - 否则停在聊天区左侧,宽度占比/最小宽取清单声明。
 * 卸下时**不做**逆操作 —— 树数据保留正是"重装复活"的记忆来源(§6 规则 5)。
 */
export function layoutWithGhostPanel(layout: Layout, manifest: GhostManifest): Layout | null {
  if (!manifest.panel) return null;
  if (manifest.panel.position === 'tab') return null;
  const kind = ghostPanelKind(manifest.id);
  if (findSplitChildByPanelKind(layout, kind)) return null;
  // 停靠位置(相对主聊天窗):按 chat-main 的实际下标定插入点,不写死
  // 序号(未来树形态变化不至于错位)。停靠恒在聊天区左侧(2026-07-25 Lizi
  // 定案:right 退役,右侧留给右侧边栏;用户要右侧自己拖拽换位——已在树里
  // 的 pane 是用户布局记忆,本函数只管首次装入,不搬动存量)。
  const chatIndex =
    layout.content.type === 'split'
      ? layout.content.children.findIndex((c) => c.node.type === 'pane' && c.node.panelKind === 'chat-main')
      : -1;
  const index = chatIndex < 0 ? 0 : chatIndex;
  const result = insertRootSplitPane(
    layout,
    {
      id: `ghost-${manifest.id}`,
      panelKind: kind,
      ...(manifest.panel.minWidth !== undefined ? { minWidth: manifest.panel.minWidth } : {}),
    },
    { index, fraction: manifest.panel.defaultFraction ?? 0.2 },
  );
  return result.applied ? result.layout : null;
}

export type ManifestValidation = { ok: true; manifest: GhostManifest } | { ok: false; reason: string };

const GHOST_MANIFEST_RESERVED_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isGhostManifestReservedRecordKey(value: string): boolean {
  return GHOST_MANIFEST_RESERVED_RECORD_KEYS.has(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 当前宿主语言在插件未提供时固定回退英文。 */
export function ghostLocalePathFor(
  manifest: GhostManifest,
  locale: string | undefined | null,
): string | null {
  if (!manifest.locales) return null;
  const supported = (SUPPORTED_LOCALES as readonly string[]).includes(locale ?? '')
    ? locale as SupportedLocale
    : DEFAULT_LOCALE;
  return manifest.locales[supported] ?? manifest.locales[DEFAULT_LOCALE] ?? null;
}

/** 把当前宿主语言附到运行时清单视图；不支持的输入固定归一到英文。 */
export function withGhostResolvedLocale(
  manifest: GhostManifest,
  locale: string | undefined | null,
): GhostManifest {
  const resolvedLocale = (SUPPORTED_LOCALES as readonly string[]).includes(locale ?? '')
    ? locale as SupportedLocale
    : DEFAULT_LOCALE;
  return { ...manifest, resolvedLocale };
}

type GhostSchemaLocaleText = { title?: string; description?: string };
type GhostSchemaLocaleShape = { title: boolean; description: boolean };

const GHOST_SCHEMA_MAP_KEYWORDS = [
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
] as const;
const GHOST_SCHEMA_SINGLE_KEYWORDS = [
  'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items',
  'contains', 'not', 'if', 'then', 'else',
] as const;
const GHOST_SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

function ghostJsonPointerChild(pointer: string, segment: string | number): string {
  const escaped = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${pointer}/${escaped}`;
}

/** 收集 JSON Schema 节点中已有的 title / description，以 JSON Pointer 稳定寻址。 */
function collectGhostSchemaLocaleShape(
  schema: unknown,
  pointer = '',
  result: Record<string, GhostSchemaLocaleShape> = Object.create(null) as Record<string, GhostSchemaLocaleShape>,
): Record<string, GhostSchemaLocaleShape> {
  if (!isPlainObject(schema)) return result;
  const title = typeof schema.title === 'string';
  const description = typeof schema.description === 'string';
  if (title || description) result[pointer] = { title, description };
  for (const keyword of GHOST_SCHEMA_MAP_KEYWORDS) {
    const children = schema[keyword];
    if (!isPlainObject(children)) continue;
    for (const [key, child] of Object.entries(children)) {
      collectGhostSchemaLocaleShape(child, ghostJsonPointerChild(ghostJsonPointerChild(pointer, keyword), key), result);
    }
  }
  for (const keyword of GHOST_SCHEMA_SINGLE_KEYWORDS) {
    collectGhostSchemaLocaleShape(schema[keyword], ghostJsonPointerChild(pointer, keyword), result);
  }
  for (const keyword of GHOST_SCHEMA_ARRAY_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      collectGhostSchemaLocaleShape(child, ghostJsonPointerChild(ghostJsonPointerChild(pointer, keyword), index), result);
    });
  }
  return result;
}

function resolveGhostSchemaLocale(
  schema: Record<string, unknown>,
  localized: Record<string, GhostSchemaLocaleText>,
  pointer = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...schema };
  const text = localized[pointer];
  if (text?.title !== undefined) result.title = text.title;
  if (text?.description !== undefined) result.description = text.description;
  for (const keyword of GHOST_SCHEMA_MAP_KEYWORDS) {
    const children = schema[keyword];
    if (!isPlainObject(children)) continue;
    result[keyword] = Object.fromEntries(
      Object.entries(children).map(([key, child]) => [
        key,
        isPlainObject(child)
          ? resolveGhostSchemaLocale(
              child,
              localized,
              ghostJsonPointerChild(ghostJsonPointerChild(pointer, keyword), key),
            )
          : child,
      ]),
    );
  }
  for (const keyword of GHOST_SCHEMA_SINGLE_KEYWORDS) {
    const child = schema[keyword];
    if (!isPlainObject(child)) continue;
    result[keyword] = resolveGhostSchemaLocale(child, localized, ghostJsonPointerChild(pointer, keyword));
  }
  for (const keyword of GHOST_SCHEMA_ARRAY_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    result[keyword] = children.map((child, index) => (
      isPlainObject(child)
        ? resolveGhostSchemaLocale(
            child,
            localized,
            ghostJsonPointerChild(ghostJsonPointerChild(pointer, keyword), index),
          )
        : child
    ));
  }
  return result;
}

/**
 * 校验 locale 文件。翻译是可选项(2026-07-25 起):文件里**提供**的条目严格
 * 校验——未知工具、未知 key、未知字段、原 manifest 没有的条目、类型或长度
 * 不合格照旧拒绝(防止翻译错位与哑弹);**未提供**的条目不再拒绝,解析时
 * 回退原 manifest 文案。完整翻译仍是质量推荐项,但不是装入/打包门槛。
 */
export function validateGhostManifestLocaleResource(
  raw: unknown,
  manifest: GhostManifest,
): { ok: true; resource: GhostManifestLocaleResource } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: 'locale 文件必须是对象' };
  const allowedTopLevelFields = new Set([
    'name', 'description', 'whenToUse', 'tools', 'panel', 'network', 'node', 'setup',
  ]);
  const unknownTopLevelField = Object.keys(raw).find((field) => !allowedTopLevelFields.has(field));
  if (unknownTopLevelField) {
    return { ok: false, reason: `locale 含未知字段 ${JSON.stringify(unknownTopLevelField)}` };
  }
  if (
    raw.name !== undefined &&
    (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 64)
  ) {
    return { ok: false, reason: 'locale.name 必须是 1–64 字符的非空字符串' };
  }
  const optionalText = (
    field: 'description' | 'whenToUse',
    max: number,
  ): string | undefined | { error: string } => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (manifest[field] === undefined) {
      return { error: `locale.${field} 不应存在：原 manifest 未声明该字段` };
    }
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
      return { error: `locale.${field} 必须是 1–${max} 字符的非空字符串` };
    }
    return value;
  };
  const description = optionalText('description', 300);
  if (isPlainObject(description) && typeof description.error === 'string') {
    return { ok: false, reason: description.error };
  }
  const whenToUse = optionalText('whenToUse', 300);
  if (isPlainObject(whenToUse) && typeof whenToUse.error === 'string') {
    return { ok: false, reason: whenToUse.error };
  }

  let tools: GhostManifestLocaleResource['tools'];
  if (raw.tools !== undefined) {
    if (manifest.tools === undefined) {
      return { ok: false, reason: 'locale.tools 不应存在：原 manifest 未声明工具' };
    }
    if (!isPlainObject(raw.tools)) {
      return { ok: false, reason: 'locale.tools 必须按 tool name 提供对象' };
    }
    const expectedNames = new Set(manifest.tools.map((tool) => tool.name));
    const actualNames = Object.keys(raw.tools);
    const unknown = actualNames.find((name) => !expectedNames.has(name));
    if (unknown) return { ok: false, reason: `locale.tools 含未知工具 ${JSON.stringify(unknown)}` };
    tools = Object.create(null) as NonNullable<GhostManifestLocaleResource['tools']>;
    for (const tool of manifest.tools) {
      const localized = raw.tools[tool.name];
      if (localized === undefined) continue; // 缺译:该工具整体回退原文
      if (!isPlainObject(localized)) {
        return { ok: false, reason: `locale.tools[${JSON.stringify(tool.name)}] 必须是对象` };
      }
      const unknownToolField = Object.keys(localized).find(
        (field) => field !== 'description' && field !== 'parameters',
      );
      if (unknownToolField) {
        return {
          ok: false,
          reason: `locale.tools[${JSON.stringify(tool.name)}] 含未知字段 ${JSON.stringify(unknownToolField)}`,
        };
      }
      if (
        typeof localized.description !== 'string' ||
        localized.description.trim().length === 0 ||
        localized.description.length > 1024
      ) {
        return {
          ok: false,
          reason: `locale.tools[${JSON.stringify(tool.name)}].description 必须是 1–1024 字符的非空字符串`,
        };
      }
      const parameterShape = collectGhostSchemaLocaleShape(tool.parameters);
      const parameterPointers = Object.keys(parameterShape);
      let parameters: Record<string, GhostSchemaLocaleText> | undefined;
      if (localized.parameters !== undefined) {
        if (parameterPointers.length === 0) {
          return {
            ok: false,
            reason: `locale.tools[${JSON.stringify(tool.name)}].parameters 不应存在：原参数 schema 没有 title / description`,
          };
        }
        if (!isPlainObject(localized.parameters)) {
          return {
            ok: false,
            reason: `locale.tools[${JSON.stringify(tool.name)}].parameters 必须按 JSON Pointer 提供参数文案`,
          };
        }
        const expectedPointers = new Set(parameterPointers);
        const unknownPointer = Object.keys(localized.parameters).find((pointer) => !expectedPointers.has(pointer));
        if (unknownPointer) {
          return {
            ok: false,
            reason: `locale.tools[${JSON.stringify(tool.name)}].parameters 含未知路径 ${JSON.stringify(unknownPointer)}`,
          };
        }
        parameters = Object.create(null) as Record<string, GhostSchemaLocaleText>;
        for (const pointer of parameterPointers) {
          const shape = parameterShape[pointer];
          const localizedText = localized.parameters[pointer];
          if (localizedText === undefined) continue; // 缺译 pointer:回退原文
          if (!isPlainObject(localizedText)) {
            return {
              ok: false,
              reason: `locale.tools[${JSON.stringify(tool.name)}].parameters[${JSON.stringify(pointer)}] 必须是对象`,
            };
          }
          const allowedFields = new Set([
            ...(shape.title ? ['title'] : []),
            ...(shape.description ? ['description'] : []),
          ]);
          const unknownField = Object.keys(localizedText).find((field) => !allowedFields.has(field));
          if (unknownField) {
            return {
              ok: false,
              reason: `locale.tools[${JSON.stringify(tool.name)}].parameters[${JSON.stringify(pointer)}] 含未知字段 ${JSON.stringify(unknownField)}`,
            };
          }
          if (
            localizedText.title !== undefined &&
            (typeof localizedText.title !== 'string' || localizedText.title.trim().length === 0 || localizedText.title.length > 256)
          ) {
            return {
              ok: false,
              reason: `locale.tools[${JSON.stringify(tool.name)}].parameters[${JSON.stringify(pointer)}].title 必须是 1–256 字符的非空字符串`,
            };
          }
          if (
            localizedText.description !== undefined &&
            (
              typeof localizedText.description !== 'string' ||
              localizedText.description.trim().length === 0 ||
              localizedText.description.length > 1024
            )
          ) {
            return {
              ok: false,
              reason: `locale.tools[${JSON.stringify(tool.name)}].parameters[${JSON.stringify(pointer)}].description 必须是 1–1024 字符的非空字符串`,
            };
          }
          parameters[pointer] = {
            ...(typeof localizedText.title === 'string' ? { title: localizedText.title } : {}),
            ...(typeof localizedText.description === 'string' ? { description: localizedText.description } : {}),
          };
        }
      }
      tools[tool.name] = {
        description: localized.description,
        ...(parameters !== undefined ? { parameters } : {}),
      };
    }
  }

  let panel: GhostManifestLocaleResource['panel'];
  if (raw.panel !== undefined) {
    if (manifest.panel?.title === undefined) {
      return { ok: false, reason: 'locale.panel 不应存在：原 manifest 未声明 panel.title' };
    }
    if (!isPlainObject(raw.panel)) {
      return { ok: false, reason: 'locale.panel 必须是含 title 的对象' };
    }
    const unknownPanelField = Object.keys(raw.panel).find((field) => field !== 'title');
    if (unknownPanelField) {
      return { ok: false, reason: `locale.panel 含未知字段 ${JSON.stringify(unknownPanelField)}` };
    }
    if (typeof raw.panel.title !== 'string' || raw.panel.title.trim().length === 0 || raw.panel.title.length > 64) {
      return { ok: false, reason: 'locale.panel.title 必须是 1–64 字符的非空字符串' };
    }
    panel = { title: raw.panel.title };
  }

  const validateLocalizedLabels = (
    rawValue: unknown,
    fieldPath: string,
    declarations: ReadonlyArray<{ key: string; hint?: string }>,
  ): { ok: true; labels?: Record<string, { label: string; hint?: string }> } | { ok: false; reason: string } => {
    if (rawValue === undefined) return { ok: true };
    if (declarations.length === 0) {
      return { ok: false, reason: `${fieldPath} 不应存在：原 manifest 未声明对应项目` };
    }
    if (!isPlainObject(rawValue)) {
      return { ok: false, reason: `${fieldPath} 必须按稳定 key 提供对象` };
    }
    const expectedKeys = new Set(declarations.map((declaration) => declaration.key));
    const unknownKey = Object.keys(rawValue).find((key) => !expectedKeys.has(key));
    if (unknownKey) {
      return { ok: false, reason: `${fieldPath} 含未知 key ${JSON.stringify(unknownKey)}` };
    }
    const labels = Object.create(null) as Record<string, { label: string; hint?: string }>;
    for (const declaration of declarations) {
      const localized = rawValue[declaration.key];
      if (localized === undefined) continue; // 缺译:该项回退原文
      if (!isPlainObject(localized)) {
        return { ok: false, reason: `${fieldPath}[${JSON.stringify(declaration.key)}] 必须是对象` };
      }
      const allowedFields = declaration.hint !== undefined ? new Set(['label', 'hint']) : new Set(['label']);
      const unknownField = Object.keys(localized).find((field) => !allowedFields.has(field));
      if (unknownField) {
        return {
          ok: false,
          reason: `${fieldPath}[${JSON.stringify(declaration.key)}] 含未知字段 ${JSON.stringify(unknownField)}`,
        };
      }
      if (typeof localized.label !== 'string' || localized.label.trim().length === 0 || localized.label.length > 64) {
        return {
          ok: false,
          reason: `${fieldPath}[${JSON.stringify(declaration.key)}].label 必须是 1–64 字符的非空字符串`,
        };
      }
      if (
        localized.hint !== undefined &&
        (typeof localized.hint !== 'string' || localized.hint.trim().length === 0 || localized.hint.length > 200)
      ) {
        return {
          ok: false,
          reason: `${fieldPath}[${JSON.stringify(declaration.key)}].hint 必须是 1–200 字符的非空字符串`,
        };
      }
      labels[declaration.key] = {
        label: localized.label,
        ...(typeof localized.hint === 'string' ? { hint: localized.hint } : {}),
      };
    }
    return { ok: true, labels };
  };

  const secretDecls = manifest.network?.secrets ?? [];
  const connectionDecls = manifest.network?.connections ?? [];
  let network: GhostManifestLocaleResource['network'];
  if (raw.network !== undefined) {
    if (secretDecls.length === 0 && connectionDecls.length === 0) {
      return { ok: false, reason: 'locale.network 不应存在：原 manifest 未声明凭证或连接' };
    }
    if (!isPlainObject(raw.network)) {
      return { ok: false, reason: 'locale.network 必须是含 secrets / connections 的对象' };
    }
    const unknownNetworkField = Object.keys(raw.network).find(
      (field) => field !== 'secrets' && field !== 'connections',
    );
    if (unknownNetworkField) {
      return { ok: false, reason: `locale.network 含未知字段 ${JSON.stringify(unknownNetworkField)}` };
    }
    const secrets = validateLocalizedLabels(raw.network.secrets, 'locale.network.secrets', secretDecls);
    if (!secrets.ok) return secrets;
    const connections = validateLocalizedLabels(raw.network.connections, 'locale.network.connections', connectionDecls);
    if (!connections.ok) return connections;
    network = {
      ...(secrets.labels !== undefined ? { secrets: secrets.labels } : {}),
      ...(connections.labels !== undefined ? { connections: connections.labels } : {}),
    };
  }

  const nodeSecretDecls = manifest.node?.secretBindings ?? [];
  let node: GhostManifestLocaleResource['node'];
  if (raw.node !== undefined) {
    if (nodeSecretDecls.length === 0) {
      return { ok: false, reason: 'locale.node 不应存在：原 manifest 未声明 node.secretBindings' };
    }
    if (!isPlainObject(raw.node)) {
      return { ok: false, reason: 'locale.node 必须是含 secretBindings 的对象' };
    }
    const unknownNodeField = Object.keys(raw.node).find((field) => field !== 'secretBindings');
    if (unknownNodeField) {
      return { ok: false, reason: `locale.node 含未知字段 ${JSON.stringify(unknownNodeField)}` };
    }
    const secretBindings = validateLocalizedLabels(
      raw.node.secretBindings,
      'locale.node.secretBindings',
      nodeSecretDecls,
    );
    if (!secretBindings.ok) return secretBindings;
    node = secretBindings.labels !== undefined ? { secretBindings: secretBindings.labels } : {};
  }

  const setupKvDecls = new Map<string, { key: string }>();
  for (const group of manifest.setup?.requires ?? []) {
    for (const requirement of group.anyOf) {
      if (requirement.kind === 'kv') setupKvDecls.set(requirement.key, { key: requirement.key });
    }
  }
  let setup: GhostManifestLocaleResource['setup'];
  if (raw.setup !== undefined) {
    if (setupKvDecls.size === 0) {
      return { ok: false, reason: 'locale.setup 不应存在：原 manifest 未声明 setup kv 项' };
    }
    if (!isPlainObject(raw.setup)) {
      return { ok: false, reason: 'locale.setup 必须是含 kv 的对象' };
    }
    const unknownSetupField = Object.keys(raw.setup).find((field) => field !== 'kv');
    if (unknownSetupField) {
      return { ok: false, reason: `locale.setup 含未知字段 ${JSON.stringify(unknownSetupField)}` };
    }
    const kv = validateLocalizedLabels(raw.setup.kv, 'locale.setup.kv', [...setupKvDecls.values()]);
    if (!kv.ok) return kv;
    if (kv.labels !== undefined) {
      const localizedKv = Object.create(null) as Record<string, { label: string }>;
      for (const [key, localized] of Object.entries(kv.labels)) {
        localizedKv[key] = { label: localized.label };
      }
      setup = { kv: localizedKv };
    } else {
      setup = {};
    }
  }

  return {
    ok: true,
    resource: {
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof whenToUse === 'string' ? { whenToUse } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(panel !== undefined ? { panel } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(node !== undefined ? { node } : {}),
      ...(setup !== undefined ? { setup } : {}),
    },
  };
}

/**
 * 用已校验的 locale 资源生成宿主与 Agent 消费的本地化 manifest 视图。
 * 资源里缺失的条目一律回退原 manifest 文案(部分翻译是合法状态)。
 */
export function resolveGhostManifestLocale(
  manifest: GhostManifest,
  resource: GhostManifestLocaleResource,
): GhostManifest {
  return {
    ...manifest,
    ...(resource.name !== undefined ? { name: resource.name } : {}),
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    ...(resource.whenToUse !== undefined ? { whenToUse: resource.whenToUse } : {}),
    ...(manifest.tools !== undefined && resource.tools !== undefined
      ? {
          tools: manifest.tools.map((tool) => {
            const localized = resource.tools![tool.name];
            if (localized === undefined) return tool;
            return {
              ...tool,
              description: localized.description,
              ...(tool.parameters !== undefined && localized.parameters !== undefined
                ? { parameters: resolveGhostSchemaLocale(tool.parameters, localized.parameters) }
                : {}),
            };
          }),
        }
      : {}),
    ...(manifest.panel !== undefined && resource.panel !== undefined
      ? { panel: { ...manifest.panel, title: resource.panel.title } }
      : {}),
    ...(manifest.network !== undefined && resource.network !== undefined
      ? {
          network: {
            ...manifest.network,
            ...(manifest.network.secrets !== undefined && resource.network.secrets !== undefined
              ? {
                  secrets: manifest.network.secrets.map((secret) => ({
                    ...secret,
                    ...(resource.network!.secrets![secret.key] ?? {}),
                  })),
                }
              : {}),
            ...(manifest.network.connections !== undefined && resource.network.connections !== undefined
              ? {
                  connections: manifest.network.connections.map((connection) => ({
                    ...connection,
                    ...(resource.network!.connections![connection.key] ?? {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    ...(manifest.node !== undefined && resource.node?.secretBindings !== undefined
      ? {
          node: {
            ...manifest.node,
            secretBindings: manifest.node.secretBindings?.map((binding) => ({
              ...binding,
              ...(resource.node!.secretBindings![binding.key] ?? {}),
            })),
          },
        }
      : {}),
    ...(manifest.setup !== undefined && resource.setup?.kv !== undefined
      ? {
          setup: {
            requires: manifest.setup.requires.map((group) => ({
              anyOf: group.anyOf.map((requirement) => (
                requirement.kind === 'kv' && resource.setup!.kv![requirement.key] !== undefined
                  ? { ...requirement, label: resource.setup!.kv![requirement.key].label }
                  : requirement
              )),
            })),
          },
        }
      : {}),
  };
}

/**
 * 校验一份解析后的 ghost.json。宽进严出:忽略未知字段(向前兼容),
 * 已知字段全部严格检查;任何不合格都给出人类可读 reason。
 */
export function validateGhostManifest(raw: unknown): ManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: '清单不是对象' };

  if (raw.schemaVersion !== 2) {
    return { ok: false, reason: `schemaVersion 必须是 2,得到 ${JSON.stringify(raw.schemaVersion)}(v1 声明型已于 2026-07-12 移除)` };
  }
  if (!isValidGhostId(raw.id)) {
    return { ok: false, reason: 'id 必须是 1–32 位小写字母/数字/连字符(不能以连字符开头)' };
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 64) {
    return { ok: false, reason: 'name 必须是 1–64 字符的非空字符串' };
  }
  if (typeof raw.version !== 'string' || raw.version.trim().length === 0 || raw.version.length > 32) {
    return { ok: false, reason: 'version 必须是 1–32 字符的非空字符串' };
  }
  // kind 可省略(2026-07-12 晚定案:单形态后字段纯冗余,缺省即 chip);
  // 写了就必须是 chip——写错值仍拒,不静默纠正(规则 9)。
  if (raw.kind !== undefined && raw.kind !== 'chip') {
    return { ok: false, reason: `kind 必须是 "chip" 或省略(缺省即 chip),得到 ${JSON.stringify(raw.kind)}(意识只有芯片一种形态,declaration 已移除)` };
  }
  if (
    raw.author !== undefined &&
    (typeof raw.author !== 'string' || raw.author.trim().length === 0 || raw.author.length > 64)
  ) {
    return { ok: false, reason: 'author 必须是 1–64 字符的非空字符串' };
  }
  let locales: GhostManifest['locales'];
  if (raw.locales !== undefined) {
    if (!isPlainObject(raw.locales)) {
      return { ok: false, reason: 'locales 必须是语言到 locale JSON 路径的对象' };
    }
    const unknownLocale = Object.keys(raw.locales).find(
      (locale) => !(SUPPORTED_LOCALES as readonly string[]).includes(locale),
    );
    if (unknownLocale) {
      return {
        ok: false,
        reason: `locales 含宿主不支持的语言 ${JSON.stringify(unknownLocale)}(可用:${SUPPORTED_LOCALES.join(' / ')})`,
      };
    }
    if (raw.locales.en === undefined) {
      return { ok: false, reason: 'locales 必须提供 en，作为所有不支持语言的固定回退' };
    }
    const normalized: Partial<Record<SupportedLocale, string>> = {};
    const seenPaths = new Set<string>();
    const nonLocalePaths = [
      GHOST_MANIFEST_FILE,
      raw.entry,
      raw.icon,
      raw.settingsHtml,
      isPlainObject(raw.panel) ? raw.panel.html : undefined,
      isPlainObject(raw.node) ? raw.node.entry : undefined,
      ...(isPlainObject(raw.node) && Array.isArray(raw.node.entries) ? raw.node.entries : []),
    ].filter((value): value is string => typeof value === 'string');
    const nonLocalePathFolds = new Set(nonLocalePaths.map((value) => value.toLowerCase()));
    for (const locale of SUPPORTED_LOCALES) {
      const localePath = raw.locales[locale];
      if (localePath === undefined) continue;
      if (
        typeof localePath !== 'string' ||
        !isSafeGhostRelativePath(localePath) ||
        !localePath.toLowerCase().endsWith('.json')
      ) {
        return { ok: false, reason: `locales.${locale} 必须是安装目录内以 .json 结尾的安全相对路径` };
      }
      const normalizedLocalePath = localePath.toLowerCase();
      if (nonLocalePathFolds.has(normalizedLocalePath)) {
        return {
          ok: false,
          reason: `locales.${locale} 路径 ${JSON.stringify(localePath)} 与插件其他声明文件大小写折叠后冲突`,
        };
      }
      if (seenPaths.has(normalizedLocalePath)) {
        return { ok: false, reason: `locales 含重复路径 ${JSON.stringify(localePath)}` };
      }
      seenPaths.add(normalizedLocalePath);
      normalized[locale] = localePath;
    }
    locales = normalized as GhostManifest['locales'];
  }
  if (
    raw.description !== undefined &&
    (typeof raw.description !== 'string' || raw.description.trim().length === 0 || raw.description.length > 300)
  ) {
    return { ok: false, reason: 'description 必须是 1–300 字符的非空字符串' };
  }
  if (
    raw.whenToUse !== undefined &&
    (typeof raw.whenToUse !== 'string' || raw.whenToUse.trim().length === 0 || raw.whenToUse.length > 300)
  ) {
    return { ok: false, reason: 'whenToUse 必须是 1–300 字符的非空字符串' };
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
    if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length === 0 || p.title.length > 64)) {
      return { ok: false, reason: 'panel.title 必须是 1–64 字符的字符串' };
    }
    // 面板一律由意识自绘(html 必填):declaration 时代的静态 body 面板已随
    // 单形态定案(2026-07-12)移除。
    if (!isSafeGhostRelativePath(p.html)) {
      return { ok: false, reason: 'panel.html 必填,且必须是安装目录内的安全相对路径' };
    }
    if (
      p.minWidth !== undefined &&
      (typeof p.minWidth !== 'number' || !Number.isFinite(p.minWidth) || p.minWidth < 120 || p.minWidth > 1200)
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
      return { ok: false, reason: 'panel.defaultFraction 必须是 0.05–0.8 之间的数字' };
    }
    let systemButtons: GhostPanelDecl['systemButtons'];
    if (p.systemButtons !== undefined) {
      const sb = p.systemButtons;
      if (!isPlainObject(sb)) {
        return { ok: false, reason: 'panel.systemButtons 必须是对象(如 { "maximize": false })' };
      }
      // 收词明确拒绝未知键(规则 9):新系统按钮上线时在白名单里扩键。
      const knownButtons = ['maximize', 'detach', 'minimize'];
      for (const key of Object.keys(sb)) {
        if (!knownButtons.includes(key)) {
          return { ok: false, reason: `panel.systemButtons 只认 ${knownButtons.join(' / ')},未知键:${key}` };
        }
        if (typeof (sb as Record<string, unknown>)[key] !== 'boolean') {
          return { ok: false, reason: `panel.systemButtons.${key} 必须是布尔值` };
        }
      }
      const maximize = (sb as Record<string, unknown>).maximize;
      const detach = (sb as Record<string, unknown>).detach;
      const minimize = (sb as Record<string, unknown>).minimize;
      systemButtons = {
        ...(typeof maximize === 'boolean' ? { maximize } : {}),
        ...(typeof detach === 'boolean' ? { detach } : {}),
        ...(typeof minimize === 'boolean' ? { minimize } : {}),
      };
    }
    let position: GhostPanelPosition | undefined;
    if (p.position !== undefined) {
      if (p.position === 'top' || p.position === 'bottom') {
        // 收词但明确拒绝(规则 9 不静默降级):上下停靠等布局引擎嵌套分割就绪后开放。
        return { ok: false, reason: 'panel.position 的 top / bottom 暂未支持(排期中),当前可用:left / tab' };
      }
      if (p.position === 'right') {
        // right 退役兼容(见 GHOST_PANEL_POSITIONS 注释):旧包归一化为 left,
        // 不硬拒 —— 已装插件每次启动重过本校验,硬拒等于把存量插件打没。
        position = 'left';
      } else if (!(GHOST_PANEL_POSITIONS as readonly string[]).includes(p.position as string)) {
        return {
          ok: false,
          reason: `panel.position 必须是 ${GHOST_PANEL_POSITIONS.join(' / ')}(right 已退役,旧包自动并入 left)`,
        };
      } else {
        position = p.position as GhostPanelPosition;
      }
      // 页签形态没有拖缝宽度/标准头语义:收词明确拒绝而非静默忽略(规则 9)。
      if (
        position === 'tab' &&
        (p.minWidth !== undefined || p.defaultFraction !== undefined || p.systemButtons !== undefined)
      ) {
        return {
          ok: false,
          reason:
            "panel.minWidth / panel.defaultFraction / panel.systemButtons 仅停靠形态(left)有效,position:'tab' 时请移除",
        };
      }
    }
    panel = {
      ...(p.title !== undefined ? { title: p.title as string } : {}),
      ...(position !== undefined ? { position } : {}),
      html: p.html as string,
      ...(p.minWidth !== undefined ? { minWidth: p.minWidth as number } : {}),
      ...(p.defaultFraction !== undefined ? { defaultFraction: p.defaultFraction as number } : {}),
      ...(systemButtons !== undefined ? { systemButtons } : {}),
    };
  }

  if (!isSafeGhostRelativePath(raw.entry)) {
    return { ok: false, reason: '必须提供 entry(安装目录内的安全相对路径,电子脑逻辑入口)' };
  }
  if (
    raw.launch !== undefined &&
    !(GHOST_LAUNCH_MODES as readonly string[]).includes(raw.launch as string)
  ) {
    return { ok: false, reason: `launch 必须是 ${GHOST_LAUNCH_MODES.join(' / ')}` };
  }
  if (raw.settingsHtml !== undefined && !isSafeGhostRelativePath(raw.settingsHtml)) {
    return { ok: false, reason: 'settingsHtml 必须是安装目录内的安全相对路径' };
  }
  if (raw.settingsHeight !== undefined) {
    if (raw.settingsHtml === undefined) {
      return { ok: false, reason: '声明了 settingsHeight 但没有 settingsHtml——没有界面就没有高度可言' };
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
  if (!Array.isArray(raw.slots) || raw.slots.length === 0) {
    return { ok: false, reason: '必须声明 slots(非空数组,能力白名单)' };
  }
  const slots: GhostSlot[] = [];
  for (const s of raw.slots) {
    // 旧名兼容:'model' 静默归一化为 'cindy'(2026-07-11 更名,已装老包不消失)。
    const name = s === 'model' ? 'cindy' : s;
    if (typeof name !== 'string' || !(GHOST_SLOTS as readonly string[]).includes(name)) {
      return { ok: false, reason: `slots 含未知卡槽 ${JSON.stringify(s)}(可用:${GHOST_SLOTS.join(' / ')})` };
    }
    if (slots.includes(name as GhostSlot)) {
      return { ok: false, reason: `slots 含重复卡槽 ${JSON.stringify(s)}` };
    }
    slots.push(name as GhostSlot);
  }
  // 声明了面板却没申请 panel 槽(或反之有槽无面板)都是清单自相矛盾。
  if (panel !== undefined && !slots.includes('panel')) {
    return { ok: false, reason: '声明了 panel 但 slots 未包含 "panel"' };
  }
  if (slots.includes('panel') && panel === undefined) {
    return { ok: false, reason: 'slots 声明了 "panel" 但缺少 panel(面板由意识自绘,html 必填)' };
  }

  // card 槽详单:有详单必有槽;有槽无详单 = 纯渲染卡片(默认行为,向后兼容)。
  let card: GhostCardNeeds | undefined;
  if (raw.card !== undefined) {
    if (!isPlainObject(raw.card)) {
      return { ok: false, reason: 'card 能力详单必须是对象(如 { "externalLinks": true })' };
    }
    if (!slots.includes('card')) {
      return { ok: false, reason: '声明了 card 能力详单但 slots 未包含 "card"' };
    }
    const cardRaw = raw.card as Record<string, unknown>;
    const unknownCardField = Object.keys(cardRaw).find((key) => key !== 'externalLinks');
    if (unknownCardField) {
      return { ok: false, reason: `card 含不允许的字段 ${JSON.stringify(unknownCardField)}` };
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
      if (typeof t.name === 'string' && isGhostManifestReservedRecordKey(t.name)) {
        return { ok: false, reason: `tools[].name 不允许使用对象保留键名 ${JSON.stringify(t.name)}` };
      }
      if (typeof t.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(t.name)) {
        return { ok: false, reason: 'tools[].name 必须是小写字母开头的 1–64 位小写/数字/下划线/连字符' };
      }
      if (seenNames.has(t.name)) return { ok: false, reason: `tools 含重名工具 ${JSON.stringify(t.name)}` };
      seenNames.add(t.name);
      if (typeof t.description !== 'string' || t.description.trim().length === 0 || t.description.length > 1024) {
        return { ok: false, reason: 'tools[].description 必须是 1–1024 字符的非空字符串' };
      }
      if (t.parameters !== undefined) {
        if (!isPlainObject(t.parameters)) return { ok: false, reason: 'tools[].parameters 必须是对象(JSON Schema)' };
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
        ...(t.parameters !== undefined ? { parameters: t.parameters as Record<string, unknown> } : {}),
      });
    }
  }
  if (tools !== undefined && !slots.includes('tool')) {
    return { ok: false, reason: '声明了 tools 但 slots 未包含 "tool"' };
  }
  if (slots.includes('tool') && tools === undefined) {
    return { ok: false, reason: 'slots 声明了 "tool" 但缺少 tools(注册什么工具要写清楚)' };
  }

  // cindy 槽能力详单:与 slots 含 'cindy' 成对(有详单必有槽;有槽无详单
  // 允许装入但运行时零能力——老包不消失,只是代办被拒并提示作者更新)。
  // 字段旧名 model 作别名收入(两个都写以 cindy 为准)。
  const cindyRaw = raw.cindy !== undefined ? raw.cindy : raw.model;
  let cindy: GhostCindyNeeds | undefined;
  if (cindyRaw !== undefined) {
    if (!isPlainObject(cindyRaw)) {
      return { ok: false, reason: 'cindy 能力详单必须是对象(如 { "image": ["generate"] })' };
    }
    if (!slots.includes('cindy')) {
      return { ok: false, reason: '声明了 cindy 能力详单但 slots 未包含 "cindy"' };
    }
    cindy = {};
    // 类目 → 合法动作表(image / video / media;image 与 video 的动作集恰好
    // 同名,但按类目查表,未来某类目动作分叉时这里天然承接)。新增类目必须
    // 同时在下面的落位分支登记 —— 漏登记会让动作静默落进别的类目。
    const actionTable: Record<string, readonly string[]> = {
      image: GHOST_MODEL_IMAGE_ACTIONS,
      video: GHOST_MODEL_VIDEO_ACTIONS,
      media: GHOST_CINDY_MEDIA_ACTIONS,
    };
    for (const [category, actionsRaw] of Object.entries(cindyRaw)) {
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
          return { ok: false, reason: `cindy.${category} 含重复动作 ${JSON.stringify(a)}` };
        }
        actions.push(a);
      }
      // 逐类目显式落位:不要写成 `else cindy.video = …` 的兜底分支——新增
      // 类目时漏改这里会把新动作静默塞进 video(actionTable 已放行,校验不报错)。
      if (category === 'image') cindy.image = actions as GhostModelImageAction[];
      else if (category === 'video') cindy.video = actions as GhostModelVideoAction[];
      else if (category === 'media') cindy.media = actions as GhostCindyMediaAction[];
      else return { ok: false, reason: `cindy 能力类目 ${JSON.stringify(category)} 尚未接线(主机缺陷)` };
    }
    if (cindy.image === undefined && cindy.video === undefined && cindy.media === undefined) {
      return { ok: false, reason: 'cindy 能力详单不能是空对象' };
    }
  }

  // agent 槽详单:有槽无详单 = 仅允许真实用户点击触发；background 是
  // 独立高风险加档。写了详单却没申请槽属于清单自相矛盾。
  let agent: GhostAgentNeeds | undefined;
  if (raw.agent !== undefined) {
    if (!isPlainObject(raw.agent)) {
      return { ok: false, reason: 'agent 能力详单必须是对象(如 { "background": true })' };
    }
    if (!slots.includes('agent')) {
      return { ok: false, reason: '声明了 agent 能力详单但 slots 未包含 "agent"' };
    }
    const agentRaw = raw.agent as Record<string, unknown>;
    const unknownAgentField = Object.keys(agentRaw).find((key) => key !== 'background');
    if (unknownAgentField) {
      return {
        ok: false,
        reason: `agent 含不允许的字段 ${JSON.stringify(unknownAgentField)}`,
      };
    }
    if (agentRaw.background !== undefined && typeof agentRaw.background !== 'boolean') {
      return { ok: false, reason: 'agent.background 必须是布尔值' };
    }
    if (agentRaw.background !== true) {
      return {
        ok: false,
        reason: 'agent 能力详单目前只有 background: true 这一项；仅需用户点击触发时请省略 agent 字段',
      };
    }
    agent = { background: true };
  }

  // node 槽详单:只收包内入口 + 固定 stdio 协议 + 生命周期。这里刻意采用
  // 字段白名单，command/args/shell/env 等任意命令启动面一律在装入前拒绝。
  let node: GhostNodeNeeds | undefined;
  if (raw.node !== undefined) {
    if (!isPlainObject(raw.node)) {
      return { ok: false, reason: 'node 能力详单必须是对象' };
    }
    if (!slots.includes('node')) {
      return { ok: false, reason: '声明了 node 能力详单但 slots 未包含 "node"' };
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
        reason: `node 含不允许的字段 ${JSON.stringify(unknownNodeField)}；不能声明 command/args/shell/env`,
      };
    }
    if (!isSafeGhostRelativePath(nodeRaw.entry)) {
      return { ok: false, reason: 'node.entry 必须是安装目录内的安全相对路径' };
    }
    if (!/\.(?:c?js)$/.test(nodeRaw.entry)) {
      return { ok: false, reason: 'node.entry 必须是 CommonJS .js / .cjs 文件' };
    }
    if (nodeRaw.entry === raw.entry) {
      return { ok: false, reason: 'node.entry 不能与浏览器沙箱 entry 使用同一个文件' };
    }
    if (
      typeof nodeRaw.protocol !== 'string' ||
      !(GHOST_NODE_PROTOCOLS as readonly string[]).includes(nodeRaw.protocol)
    ) {
      return { ok: false, reason: `node.protocol 必须是 ${GHOST_NODE_PROTOCOLS.join(' / ')}` };
    }
    if (
      nodeRaw.lifecycle !== undefined &&
      (typeof nodeRaw.lifecycle !== 'string' ||
        !(GHOST_NODE_LIFECYCLES as readonly string[]).includes(nodeRaw.lifecycle))
    ) {
      return { ok: false, reason: `node.lifecycle 必须是 ${GHOST_NODE_LIFECYCLES.join(' / ')}` };
    }
    if (
      nodeRaw.idleTimeoutSeconds !== undefined &&
      (typeof nodeRaw.idleTimeoutSeconds !== 'number' ||
        !Number.isInteger(nodeRaw.idleTimeoutSeconds) ||
        nodeRaw.idleTimeoutSeconds < 30 ||
        nodeRaw.idleTimeoutSeconds > 3600)
    ) {
      return { ok: false, reason: 'node.idleTimeoutSeconds 必须是 30–3600 的整数' };
    }
    if (nodeRaw.lifecycle === 'resident' && nodeRaw.idleTimeoutSeconds !== undefined) {
      return { ok: false, reason: 'node.lifecycle 为 resident 时不能再声明 idleTimeoutSeconds' };
    }
    // 额外入口(多进程窄版):同一套入口纪律——包内安全相对路径、CJS 文件、
    // 不与浏览器沙箱 entry / 主入口 / 彼此重复;条数封顶。
    let nodeEntries: string[] | undefined;
    if (nodeRaw.entries !== undefined) {
      if (!Array.isArray(nodeRaw.entries) || nodeRaw.entries.length === 0) {
        return { ok: false, reason: 'node.entries 必须是非空数组(额外工作进程入口清单)' };
      }
      if (nodeRaw.entries.length > GHOST_NODE_MAX_EXTRA_ENTRIES) {
        return { ok: false, reason: `node.entries 最多 ${GHOST_NODE_MAX_EXTRA_ENTRIES} 条` };
      }
      const seen = new Set<string>();
      for (const extra of nodeRaw.entries) {
        if (!isSafeGhostRelativePath(extra)) {
          return { ok: false, reason: 'node.entries 每项必须是安装目录内的安全相对路径' };
        }
        if (!/\.(?:c?js)$/.test(extra)) {
          return { ok: false, reason: 'node.entries 每项必须是 CommonJS .js / .cjs 文件' };
        }
        if (extra === raw.entry) {
          return { ok: false, reason: 'node.entries 不能包含浏览器沙箱 entry' };
        }
        if (extra === nodeRaw.entry) {
          return { ok: false, reason: 'node.entries 不能重复主入口 node.entry' };
        }
        if (seen.has(extra)) {
          return { ok: false, reason: `node.entries 含重复入口 ${JSON.stringify(extra)}` };
        }
        seen.add(extra);
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
        if (typeof binding.key === 'string' && isGhostManifestReservedRecordKey(binding.key)) {
          return {
            ok: false,
            reason: `node.secretBindings[].key 不允许使用对象保留键名 ${JSON.stringify(binding.key)}`,
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
            return { ok: false, reason: 'node.secretBindings[].url 不是合法的绝对地址' };
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
    return { ok: false, reason: 'slots 声明了 "node" 但缺少 node 工作进程详单' };
  }

  // preview 槽详单:与 slots 含 'preview' **严格成对**(有槽必有详单——域名
  // 范围是本能力的全部知情面,不允许"先装后说");域名语法与 network 白名单
  // 同一套(装入确认框逐条展示)。
  let preview: GhostPreviewNeeds | undefined;
  if (raw.preview !== undefined) {
    if (!isPlainObject(raw.preview)) {
      return { ok: false, reason: 'preview 详单必须是对象(如 { "hosts": ["*.example.com"] })' };
    }
    if (!slots.includes('preview')) {
      return { ok: false, reason: '声明了 preview 详单但 slots 未包含 "preview"' };
    }
    const previewRaw = raw.preview as Record<string, unknown>;
    const unknownPreviewField = Object.keys(previewRaw).find((key) => key !== 'hosts');
    if (unknownPreviewField !== undefined) {
      return { ok: false, reason: `preview 含不允许的字段 ${JSON.stringify(unknownPreviewField)}` };
    }
    if (!Array.isArray(previewRaw.hosts) || previewRaw.hosts.length === 0) {
      return { ok: false, reason: 'preview.hosts 必须是非空数组(可打开预览的域名白名单)' };
    }
    if (previewRaw.hosts.length > GHOST_PREVIEW_MAX_HOSTS) {
      return { ok: false, reason: `preview.hosts 最多 ${GHOST_PREVIEW_MAX_HOSTS} 条` };
    }
    const seenPreviewHosts = new Set<string>();
    for (const host of previewRaw.hosts) {
      if (
        !isValidGhostNetworkHostPattern(host) &&
        !(typeof host === 'string' && GHOST_PREVIEW_LOOPBACK_HOSTS.has(host))
      ) {
        return { ok: false, reason: `preview.hosts 含不合法域名模式 ${JSON.stringify(host)}` };
      }
      if (seenPreviewHosts.has(host)) {
        return { ok: false, reason: `preview.hosts 含重复域名 ${JSON.stringify(host)}` };
      }
      seenPreviewHosts.add(host);
    }
    preview = { hosts: previewRaw.hosts as string[] };
  }
  if (slots.includes('preview') && preview === undefined) {
    return { ok: false, reason: 'slots 声明了 "preview" 但缺少 preview 详单(hosts 域名白名单必填)' };
  }

  // skill 槽详单:与 slots 含 'skill' **严格成对**(有槽必有详单——捆绑了什么
  // 技能是本能力的全部知情面)。name/description 与 SKILL.md 的逐字一致性在
  // 打包(packGhostDir)与装入(GhostManager.parse)两侧另行强制,这里只管
  // 声明本身的形状。name/dir 大小写折叠去重:win32 文件系统折叠大小写,
  // 共享技能根的链接名不允许折叠后相撞。
  let skill: GhostSkillNeeds | undefined;
  if (raw.skill !== undefined) {
    if (!isPlainObject(raw.skill)) {
      return { ok: false, reason: 'skill 详单必须是对象(如 { "items": [{ "dir": "skills/foo", "name": "foo", "description": "..." }] })' };
    }
    if (!slots.includes('skill')) {
      return { ok: false, reason: '声明了 skill 详单但 slots 未包含 "skill"' };
    }
    const skillRaw = raw.skill as Record<string, unknown>;
    const unknownSkillField = Object.keys(skillRaw).find((key) => key !== 'items');
    if (unknownSkillField !== undefined) {
      return { ok: false, reason: `skill 含不允许的字段 ${JSON.stringify(unknownSkillField)}` };
    }
    if (!Array.isArray(skillRaw.items) || skillRaw.items.length === 0) {
      return { ok: false, reason: 'skill.items 必须是非空数组(随包捆绑的技能清单)' };
    }
    if (skillRaw.items.length > GHOST_SKILL_MAX_ITEMS) {
      return { ok: false, reason: `skill.items 最多 ${GHOST_SKILL_MAX_ITEMS} 条` };
    }
    const skillItems: GhostSkillItem[] = [];
    const seenSkillNames = new Set<string>();
    const seenSkillDirs = new Set<string>();
    for (const item of skillRaw.items) {
      if (!isPlainObject(item)) {
        return { ok: false, reason: 'skill.items 每项必须是对象({ dir, name, description })' };
      }
      const itemRaw = item as Record<string, unknown>;
      const unknownItemField = Object.keys(itemRaw).find(
        (key) => key !== 'dir' && key !== 'name' && key !== 'description',
      );
      if (unknownItemField !== undefined) {
        return { ok: false, reason: `skill.items 条目含不允许的字段 ${JSON.stringify(unknownItemField)}` };
      }
      if (!isSafeGhostRelativePath(itemRaw.dir)) {
        return { ok: false, reason: `skill.items[].dir 必须是包内安全相对路径(如 "skills/foo"),得到 ${JSON.stringify(itemRaw.dir)}` };
      }
      if (
        typeof itemRaw.name !== 'string' ||
        itemRaw.name.length > GHOST_SKILL_NAME_MAX_CHARS ||
        !GHOST_SKILL_NAME_RE.test(itemRaw.name)
      ) {
        return { ok: false, reason: `skill.items[].name 必须是小写字母/数字加单连字符分段(禁首尾/连续连字符)、长度 1–${GHOST_SKILL_NAME_MAX_CHARS},得到 ${JSON.stringify(itemRaw.name)}` };
      }
      if (
        typeof itemRaw.description !== 'string' ||
        itemRaw.description.trim().length === 0 ||
        itemRaw.description.length > 1024
      ) {
        return { ok: false, reason: 'skill.items[].description 必须是 1–1024 字符的非空字符串' };
      }
      const nameFold = itemRaw.name.toLowerCase();
      if (seenSkillNames.has(nameFold)) {
        return { ok: false, reason: `skill.items 含重复 name ${JSON.stringify(itemRaw.name)}` };
      }
      seenSkillNames.add(nameFold);
      const dirFold = itemRaw.dir.toLowerCase();
      if (seenSkillDirs.has(dirFold)) {
        return { ok: false, reason: `skill.items 含重复 dir ${JSON.stringify(itemRaw.dir)}` };
      }
      seenSkillDirs.add(dirFold);
      skillItems.push({ dir: itemRaw.dir, name: itemRaw.name, description: itemRaw.description });
    }
    skill = { items: skillItems };
  }
  if (slots.includes('skill') && skill === undefined) {
    return { ok: false, reason: 'slots 声明了 "skill" 但缺少 skill 详单(items 技能清单必填)' };
  }

  // 订阅槽详单(卡槽①):与 slots 含 'subscribe' 成对(有详单必有槽;有槽
  // 无详单允许装入但零事件,同 cindy 语义)。硬规则:声明了 hooks(拦截)
  // 必须 launch:'resident'——要挡路就得常驻在场,每条消息等冷启动不可接受。
  let subscribe: GhostSubscribeNeeds | undefined;
  if (raw.subscribe !== undefined) {
    if (!isPlainObject(raw.subscribe)) {
      return { ok: false, reason: 'subscribe 订阅详单必须是对象(如 { "topics": ["turn"] })' };
    }
    if (!slots.includes('subscribe')) {
      return { ok: false, reason: '声明了 subscribe 订阅详单但 slots 未包含 "subscribe"' };
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
          return { ok: false, reason: `subscribe.${field} 含重复项 ${JSON.stringify(item)}` };
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
        reason: '声明了 subscribe.hooks(拦截钩子)必须同时声明 launch: "resident"——拦截要求常驻在场,否则每条消息都要等冷启动',
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
      return { ok: false, reason: 'network 详单必须是对象(如 { "hosts": ["api.example.com"] })' };
    }
    if (!slots.includes('network')) {
      return { ok: false, reason: '声明了 network 详单但 slots 未包含 "network"' };
    }
    const n = raw.network as Record<string, unknown>;
    // 连接声明在场性先探一眼(合法性下面细验):静态 hosts 的必填性依赖它——
    // 声明了 connections(动态连接地址)时 hosts 允许缺省/空数组,否则维持
    // 原规则必填 1–8 条(静态域名与动态连接至少有其一)。
    const hasConnectionDecls = Array.isArray(n.connections) && n.connections.length > 0;
    if (n.hosts === undefined && !hasConnectionDecls) {
      return { ok: false, reason: `network.hosts 必须是 1–${GHOST_NETWORK_MAX_HOSTS} 条的数组(仅声明了 network.connections 时才可缺省)` };
    }
    if (n.hosts !== undefined && (!Array.isArray(n.hosts) || n.hosts.length > GHOST_NETWORK_MAX_HOSTS)) {
      return { ok: false, reason: `network.hosts 必须是 1–${GHOST_NETWORK_MAX_HOSTS} 条的数组` };
    }
    if (Array.isArray(n.hosts) && n.hosts.length === 0 && !hasConnectionDecls) {
      return { ok: false, reason: `network.hosts 必须是 1–${GHOST_NETWORK_MAX_HOSTS} 条的数组(仅声明了 network.connections 时才允许为空)` };
    }
    const hosts: string[] = [];
    for (const h of (Array.isArray(n.hosts) ? n.hosts : [])) {
      if (typeof h !== 'string' || !isValidGhostNetworkHostPattern(h.trim().toLowerCase())) {
        return {
          ok: false,
          reason: `network.hosts 含非法条目 ${JSON.stringify(h)}(小写域名、至少两段、通配只允许最左 "*.";不收 IP / 端口 / 路径 / 协议)`,
        };
      }
      const host = h.trim().toLowerCase();
      if (hosts.includes(host)) {
        return { ok: false, reason: `network.hosts 含重复条目 ${JSON.stringify(h)}` };
      }
      hosts.push(host);
    }
    let secrets: GhostSecretDecl[] | undefined;
    if (n.secrets !== undefined) {
      if (!Array.isArray(n.secrets) || n.secrets.length === 0 || n.secrets.length > GHOST_NETWORK_MAX_SECRETS) {
        return { ok: false, reason: `network.secrets 必须是 1–${GHOST_NETWORK_MAX_SECRETS} 条的数组` };
      }
      secrets = [];
      const seenKeys = new Set<string>();
      for (const s of n.secrets) {
        if (!isPlainObject(s)) return { ok: false, reason: 'network.secrets 每项必须是对象' };
        if (typeof s.key === 'string' && isGhostManifestReservedRecordKey(s.key)) {
          return { ok: false, reason: `network.secrets[].key 不允许使用对象保留键名 ${JSON.stringify(s.key)}` };
        }
        if (typeof s.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(s.key)) {
          return { ok: false, reason: 'network.secrets[].key 必须是小写字母开头的 1–32 位小写/数字/下划线' };
        }
        if (seenKeys.has(s.key)) {
          return { ok: false, reason: `network.secrets 含重复 key ${JSON.stringify(s.key)}` };
        }
        if (node?.secretBindings?.some((binding) => binding.key === s.key)) {
          return {
            ok: false,
            reason: `network.secrets 的 key ${JSON.stringify(s.key)} 与 node.secretBindings 撞名`,
          };
        }
        seenKeys.add(s.key);
        if (typeof s.label !== 'string' || s.label.trim().length === 0 || s.label.length > 64) {
          return { ok: false, reason: 'network.secrets[].label 必须是 1–64 字符的非空字符串' };
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
        }
        // 旧 input 字段已退役：Setup Runtime 直接从 Secret 声明生成 Host 表单，
        // settingsHtml 继续提供详情页管理。遗留 `input: "ghost"` 接受并忽略
        // (不落清单)；其余值(含 'host')一律拒。
        if (s.input !== undefined && s.input !== 'ghost') {
          return {
            ok: false,
            reason: 'network.secrets[].input 已退役:Setup 表单直接从 Secret 声明生成,详情页由 settingsHtml 管理(删掉 input 字段即可;唯一可接受的遗留值是 "ghost")',
          };
        }
        // login-email:值取自主机登录态派生,用户不填、没有输入面,
        // 禁 url / exchange,settingsHtml 豁免。
        const loginDerived = source === 'login-email';
        if (s.input === 'ghost' && loginDerived) {
          return {
            ok: false,
            reason: `source: ${source} 的凭证不允许标注 input: ghost(派生凭证没有输入,谈不上谁收单)`,
          };
        }
        if (!loginDerived && raw.settingsHtml === undefined) {
          return {
            ok: false,
            reason: 'network.secrets 声明了用户填写的凭证时必须同时声明 settingsHtml(调用前可由 Host Setup 卡收单,settingsHtml 仍是长期管理/替换/清除入口)',
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
        if (
          s.hint !== undefined &&
          (typeof s.hint !== 'string' || s.hint.trim().length === 0 || s.hint.length > 200)
        ) {
          return { ok: false, reason: 'network.secrets[].hint 必须是 1–200 字符的非空字符串' };
        }
        if (s.url !== undefined) {
          if (typeof s.url !== 'string' || s.url.length === 0 || s.url.length > 200) {
            return { ok: false, reason: 'network.secrets[].url 必须是 1–200 字符的字符串' };
          }
          let parsed: URL;
          try {
            parsed = new URL(s.url);
          } catch {
            return { ok: false, reason: 'network.secrets[].url 不是合法的绝对地址' };
          }
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            return { ok: false, reason: 'network.secrets[].url 仅支持 https 且不允许内嵌用户名/密码' };
          }
        }
        if (!isPlainObject(s.inject)) {
          return { ok: false, reason: `network.secrets[${JSON.stringify(s.key)}].inject 必填(凭证要声明注入到哪个请求头)` };
        }
        const inj = s.inject as Record<string, unknown>;
        if (typeof inj.header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(inj.header)) {
          return { ok: false, reason: 'network.secrets[].inject.header 必须是 1–64 位字母/数字/连字符的头名' };
        }
        if (GHOST_NETWORK_FORBIDDEN_INJECT_HEADERS.includes(inj.header.toLowerCase())) {
          return { ok: false, reason: `network.secrets[].inject.header 不允许使用协议关键头 ${JSON.stringify(inj.header)}` };
        }
        if (
          typeof inj.format !== 'string' ||
          inj.format.length === 0 ||
          inj.format.length > 200 ||
          inj.format.split('{value}').length !== 2
        ) {
          return { ok: false, reason: 'network.secrets[].inject.format 必须是 ≤200 字符且恰含一个 {value} 占位的字符串(如 "Bearer {value}")' };
        }
        let injectHosts: string[] | undefined;
        if (inj.hosts !== undefined) {
          if (!Array.isArray(inj.hosts) || inj.hosts.length === 0) {
            return { ok: false, reason: 'network.secrets[].inject.hosts 必须是非空数组(或省略 = 全部白名单域名)' };
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
              return { ok: false, reason: `network.secrets[].inject.hosts 含重复条目 ${JSON.stringify(ih)}` };
            }
            injectHosts.push(ihNorm);
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
          return { ok: false, reason: 'network.secrets[].source 为 oauth 时不允许声明 exchange(access token 直接注入,无二段交换)' };
        }
        if (s.oauth !== undefined) {
          if (!isPlainObject(s.oauth)) {
            return { ok: false, reason: `network.secrets[${JSON.stringify(s.key)}].oauth 必须是对象` };
          }
          const oa = s.oauth as Record<string, unknown>;
          const parseHostBoundUrl = (
            raw2: unknown,
            field: string,
          ): { ok: true; url: string } | { ok: false; reason: string } => {
            if (typeof raw2 !== 'string' || raw2.length === 0 || raw2.length > 2048) {
              return { ok: false, reason: `network.secrets[].oauth.${field} 必须是 1–2048 字符的字符串` };
            }
            let parsed2: URL;
            try {
              parsed2 = new URL(raw2);
            } catch {
              return { ok: false, reason: `network.secrets[].oauth.${field} 不是合法的绝对地址` };
            }
            if (parsed2.protocol !== 'https:' || parsed2.port !== '' || parsed2.username || parsed2.password) {
              return { ok: false, reason: `network.secrets[].oauth.${field} 仅支持 https 默认端口且不允许内嵌用户名/密码` };
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
              return { ok: false, reason: 'network.secrets[].oauth.clientId 必须是 1–200 字符、不含空白的字符串' };
            }
          }
          let oaClientIdAlternatives: string[] | undefined;
          if (oa.clientIdAlternatives !== undefined) {
            if (oa.clientId === undefined) {
              return { ok: false, reason: 'network.secrets[].oauth.clientIdAlternatives 必须与默认 clientId 一起声明' };
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
                  reason: 'network.secrets[].oauth.clientIdAlternatives 含非法条目(须为 1–200 字符、不含空白的字符串)',
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
              return { ok: false, reason: 'network.secrets[].oauth.clientSecret 必须与 clientId 成对声明' };
            }
            if (
              typeof oa.clientSecret !== 'string' ||
              oa.clientSecret.trim().length === 0 ||
              oa.clientSecret.length > 200 ||
              /\s/.test(oa.clientSecret)
            ) {
              return { ok: false, reason: 'network.secrets[].oauth.clientSecret 必须是 1–200 字符、不含空白的字符串' };
            }
          }
          let oaScopes: string[] | undefined;
          if (oa.scopes !== undefined) {
            if (!Array.isArray(oa.scopes) || oa.scopes.length > GHOST_OAUTH_SCOPES_MAX) {
              return { ok: false, reason: `network.secrets[].oauth.scopes 必须是 ≤${GHOST_OAUTH_SCOPES_MAX} 条的数组` };
            }
            oaScopes = [];
            for (const sc of oa.scopes) {
              if (typeof sc !== 'string' || sc.trim().length === 0 || sc.length > 200 || /\s/.test(sc)) {
                return { ok: false, reason: `network.secrets[].oauth.scopes 含非法条目 ${JSON.stringify(sc)}(1–200 字符、不含空白)` };
              }
              if (oaScopes.includes(sc)) {
                return { ok: false, reason: `network.secrets[].oauth.scopes 含重复条目 ${JSON.stringify(sc)}` };
              }
              oaScopes.push(sc);
            }
          }
          if (oa.pkce !== undefined && typeof oa.pkce !== 'boolean') {
            return { ok: false, reason: 'network.secrets[].oauth.pkce 必须是布尔值(缺省 true)' };
          }
          if (oa.scopeDelimiter !== undefined && oa.scopeDelimiter !== ',') {
            return { ok: false, reason: 'network.secrets[].oauth.scopeDelimiter 目前只支持 ","(缺省 = 空格拼接)' };
          }
          let oaExtra: Record<string, string> | undefined;
          if (oa.extraAuthorizeParams !== undefined) {
            if (!isPlainObject(oa.extraAuthorizeParams)) {
              return { ok: false, reason: 'network.secrets[].oauth.extraAuthorizeParams 必须是对象' };
            }
            const entries = Object.entries(oa.extraAuthorizeParams as Record<string, unknown>);
            if (entries.length === 0 || entries.length > GHOST_OAUTH_EXTRA_PARAMS_MAX) {
              return { ok: false, reason: `network.secrets[].oauth.extraAuthorizeParams 必须是 1–${GHOST_OAUTH_EXTRA_PARAMS_MAX} 条(或省略)` };
            }
            oaExtra = {};
            for (const [pk, pv] of entries) {
              if (!/^[a-z][a-z0-9_]{0,31}$/.test(pk)) {
                return { ok: false, reason: `network.secrets[].oauth.extraAuthorizeParams 键 ${JSON.stringify(pk)} 必须是小写字母开头的 1–32 位小写/数字/下划线` };
              }
              if (GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS.includes(pk)) {
                return { ok: false, reason: `network.secrets[].oauth.extraAuthorizeParams 不允许声明协议保留参数 ${JSON.stringify(pk)}` };
              }
              if (typeof pv !== 'string' || pv.length === 0 || pv.length > 200) {
                return { ok: false, reason: `network.secrets[].oauth.extraAuthorizeParams[${JSON.stringify(pk)}] 必须是 1–200 字符的字符串` };
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
              return { ok: false, reason: 'network.secrets[].oauth.redirectPort 必须是 1024–65535 的整数' };
            }
          }
          // tokenBroker(可选):XDT server broker slug;secret 在服务端,与
          // clientSecret 互斥(同时声明说明作者没想清 secret 到底在哪)。
          if (oa.tokenBroker !== undefined) {
            if (typeof oa.tokenBroker !== 'string' || !GHOST_OAUTH_TOKEN_BROKER_RE.test(oa.tokenBroker)) {
              return { ok: false, reason: 'network.secrets[].oauth.tokenBroker 必须是小写字母开头的 1–32 位小写/数字/下划线/连字符' };
            }
            if (oa.clientSecret !== undefined) {
              return { ok: false, reason: 'network.secrets[].oauth.tokenBroker 与 clientSecret 互斥(broker 模式下 secret 由服务端持有,不随包分发)' };
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
              return { ok: false, reason: 'network.secrets[].oauth.brokerBounce 必须与 tokenBroker、redirectPort 同时声明' };
            }
            if (!isPlainObject(oa.brokerBounce)) {
              return { ok: false, reason: 'network.secrets[].oauth.brokerBounce 必须是对象' };
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
            oaBounce = { path: bb.path as string, callbackPath: bb.callbackPath as string };
          }
          let oaIdentity:
            | { url: string; labelPath: string; displayTemplate?: string; avatarPath?: string }
            | undefined;
          if (oa.identity !== undefined) {
            if (!isPlainObject(oa.identity)) {
              return { ok: false, reason: 'network.secrets[].oauth.identity 必须是对象' };
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
                reason: 'network.secrets[].oauth.identity.labelPath 必须是 ≤128 字符的点分路径(段名限字母/数字/_/-,如 "email" / "user.name")',
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
              const placeholders = [...idn.displayTemplate.matchAll(GHOST_OAUTH_IDENTITY_TEMPLATE_PLACEHOLDER_RE)];
              if (placeholders.length === 0) {
                return {
                  ok: false,
                  reason: 'network.secrets[].oauth.identity.displayTemplate 必须含至少一个 {点分路径} 占位符(如 "{team} · {user}")',
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
            // avatarPath(可选):头像 URL 的点分路径,形状同 labelPath。
            let idnAvatarPath: string | undefined;
            if (idn.avatarPath !== undefined) {
              if (
                typeof idn.avatarPath !== 'string' ||
                idn.avatarPath.length > 128 ||
                !GHOST_SECRET_EXCHANGE_TOKEN_PATH_RE.test(idn.avatarPath)
              ) {
                return {
                  ok: false,
                  reason: 'network.secrets[].oauth.identity.avatarPath 必须是 ≤128 字符的点分路径(段名限字母/数字/_/-,如 "data.avatar_thumb")',
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
            ...(oa.scopeDelimiter !== undefined ? { scopeDelimiter: oa.scopeDelimiter as ',' } : {}),
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
            return { ok: false, reason: `network.secrets[${JSON.stringify(s.key)}].exchange 必须是对象` };
          }
          const ex = s.exchange as Record<string, unknown>;
          if (typeof ex.url !== 'string' || ex.url.length === 0 || ex.url.length > 2048) {
            return { ok: false, reason: 'network.secrets[].exchange.url 必须是 1–2048 字符的字符串' };
          }
          let exUrl: URL;
          try {
            exUrl = new URL(ex.url);
          } catch {
            return { ok: false, reason: 'network.secrets[].exchange.url 不是合法的绝对地址' };
          }
          if (exUrl.protocol !== 'https:' || exUrl.port !== '' || exUrl.username || exUrl.password) {
            return { ok: false, reason: 'network.secrets[].exchange.url 仅支持 https 默认端口且不允许内嵌用户名/密码' };
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
              reason: 'network.secrets[].exchange.tokenPath 必须是 ≤128 字符的点分路径(段名限字母/数字/_/-,如 "session" / "data.token")',
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
        return { ok: false, reason: `network.connections 必须是 1–${GHOST_NETWORK_MAX_CONNECTION_DECLS} 条的数组` };
      }
      // 没人收地址和 token:连接的地址与凭证一律由意识 settingsHtml 收单
      // (经 /connections 协议通道),没有界面就没有入口。
      if (raw.settingsHtml === undefined) {
        return {
          ok: false,
          reason: '声明了 network.connections 必须同时声明 settingsHtml(连接地址与凭证由意识设置界面收单,没有界面就没人收单)',
        };
      }
      connections = [];
      const seenConnKeys = new Set<string>();
      const secretKeySet = new Set((secrets ?? []).map((s) => s.key));
      const nodeSecretKeySet = new Set((node?.secretBindings ?? []).map((s) => s.key));
      for (const c of n.connections) {
        if (!isPlainObject(c)) return { ok: false, reason: 'network.connections 每项必须是对象' };
        if (typeof c.key === 'string' && isGhostManifestReservedRecordKey(c.key)) {
          return { ok: false, reason: `network.connections[].key 不允许使用对象保留键名 ${JSON.stringify(c.key)}` };
        }
        if (typeof c.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(c.key)) {
          return { ok: false, reason: 'network.connections[].key 必须是小写字母开头的 1–32 位小写/数字/下划线' };
        }
        if (seenConnKeys.has(c.key)) {
          return { ok: false, reason: `network.connections 含重复 key ${JSON.stringify(c.key)}` };
        }
        // 与 secrets 共用键命名空间(保险库派生键同一前缀),撞名拒装。
        if (secretKeySet.has(c.key)) {
          return { ok: false, reason: `network.connections[].key ${JSON.stringify(c.key)} 与 network.secrets 的 key 撞名(两者共用命名空间)` };
        }
        if (nodeSecretKeySet.has(c.key)) {
          return { ok: false, reason: `network.connections[].key ${JSON.stringify(c.key)} 与 node.secretBindings 的 key 撞名(两者共用命名空间)` };
        }
        seenConnKeys.add(c.key);
        if (typeof c.label !== 'string' || c.label.trim().length === 0 || c.label.length > 64) {
          return { ok: false, reason: 'network.connections[].label 必须是 1–64 字符的非空字符串' };
        }
        if (
          c.hint !== undefined &&
          (typeof c.hint !== 'string' || c.hint.trim().length === 0 || c.hint.length > 200)
        ) {
          return { ok: false, reason: 'network.connections[].hint 必须是 1–200 字符的非空字符串' };
        }
        if (!isPlainObject(c.inject)) {
          return { ok: false, reason: `network.connections[${JSON.stringify(c.key)}].inject 必填(连接凭证要声明注入到哪个请求头)` };
        }
        const cinj = c.inject as Record<string, unknown>;
        if (typeof cinj.header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(cinj.header)) {
          return { ok: false, reason: 'network.connections[].inject.header 必须是 1–64 位字母/数字/连字符的头名' };
        }
        if (GHOST_NETWORK_FORBIDDEN_INJECT_HEADERS.includes(cinj.header.toLowerCase())) {
          return { ok: false, reason: `network.connections[].inject.header 不允许使用协议关键头 ${JSON.stringify(cinj.header)}` };
        }
        if (
          typeof cinj.format !== 'string' ||
          cinj.format.length === 0 ||
          cinj.format.length > 200 ||
          cinj.format.split('{value}').length !== 2
        ) {
          return { ok: false, reason: 'network.connections[].inject.format 必须是 ≤200 字符且恰含一个 {value} 占位的字符串(如 "Bearer {value}")' };
        }
        if (cinj.hosts !== undefined) {
          // 注入范围恒等于各连接自身地址(用户添加哪条注入哪条),作者无从
          // 收窄或扩张——声明即结构性误解,直接拒装。
          return { ok: false, reason: 'network.connections[].inject.hosts 不允许声明(连接凭证只注入对应连接自身的地址)' };
        }
        if (c.maxConnections !== undefined) {
          if (
            typeof c.maxConnections !== 'number' ||
            !Number.isInteger(c.maxConnections) ||
            c.maxConnections < 1 ||
            c.maxConnections > GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL
          ) {
            return { ok: false, reason: `network.connections[].maxConnections 必须是 1–${GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL} 的整数(缺省 ${GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL})` };
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

  // setup 就绪声明:引用必须指向已声明的凭证/连接(悬空引用在装包期拒,
  // 不留到运行期才发现作者写错);kv 引用要求 settingsHtml(没有设置页
  // 没人填参数);login-email 源恒就绪,引用它属结构性误解,直接拒装。
  let setup: GhostSetupDecl | undefined;
  if (raw.setup !== undefined) {
    if (!isPlainObject(raw.setup)) {
      return { ok: false, reason: 'setup 必须是对象(如 { "requires": [{ "anyOf": ["secret:api_key"] }] })' };
    }
    const su = raw.setup as Record<string, unknown>;
    // 空数组是合法的显式 opt-out:「本意识没有使用前置需求」——凭证全为
    // 可选项的意识用它关掉宿主启发式(不声明才走启发式)。
    if (!Array.isArray(su.requires) || su.requires.length > GHOST_SETUP_MAX_GROUPS) {
      return { ok: false, reason: `setup.requires 必须是 0–${GHOST_SETUP_MAX_GROUPS} 组的数组(空数组 = 显式声明无使用前置需求)` };
    }
    const secretByKey = new Map<string, { loginDerived: boolean }>([
      ...(network?.secrets ?? []).map(
        (s) => [s.key, { loginDerived: s.source === 'login-email' }] as const,
      ),
      ...(node?.secretBindings ?? []).map(
        (s) => [s.key, { loginDerived: false }] as const,
      ),
    ]);
    const connectionKeys = new Set((network?.connections ?? []).map((c) => c.key));
    const groups: GhostSetupGroup[] = [];
    for (const g of su.requires) {
      if (!isPlainObject(g) || !Array.isArray(g.anyOf) || g.anyOf.length === 0 || g.anyOf.length > GHOST_SETUP_MAX_ITEMS_PER_GROUP) {
        return { ok: false, reason: `setup.requires 每组必须是 { "anyOf": [...] } 且组内 1–${GHOST_SETUP_MAX_ITEMS_PER_GROUP} 条` };
      }
      const items: GhostSetupRequirement[] = [];
      const seenRefs = new Set<string>();
      for (const it of g.anyOf) {
        let item: GhostSetupRequirement;
        if (typeof it === 'string') {
          const m = /^(secret|connection):(.+)$/.exec(it);
          if (!m) {
            return { ok: false, reason: `setup 条目 ${JSON.stringify(it)} 形态不对(字符串条目须为 "secret:<key>" 或 "connection:<key>";kv 用对象 { "kv": "<key>", "label": "..." })` };
          }
          const [, refKind, refKey] = m;
          if (refKind === 'secret') {
            const decl = secretByKey.get(refKey);
            if (!decl) {
              return { ok: false, reason: `setup 引用了未声明的凭证 ${JSON.stringify(refKey)}(必须逐字取自 network.secrets[].key 或 node.secretBindings[].key)` };
            }
            if (decl.loginDerived) {
              return { ok: false, reason: `setup 不允许引用 login-email 源凭证 ${JSON.stringify(refKey)}(登录派生身份恒就绪,无配置动作可引导)` };
            }
            item = { kind: 'secret', key: refKey };
          } else {
            if (!connectionKeys.has(refKey)) {
              return { ok: false, reason: `setup 引用了未声明的连接 ${JSON.stringify(refKey)}(必须逐字取自 network.connections[].key)` };
            }
            item = { kind: 'connection', key: refKey };
          }
        } else if (isPlainObject(it)) {
          if (typeof it.kv === 'string' && isGhostManifestReservedRecordKey(it.kv)) {
            return { ok: false, reason: `setup kv 条目的 kv 不允许使用对象保留键名 ${JSON.stringify(it.kv)}` };
          }
          if (typeof it.kv !== 'string' || !GHOST_SETUP_KV_KEY_RE.test(it.kv)) {
            return { ok: false, reason: 'setup kv 条目的 kv 必须是 1–64 位字母/数字/下划线/点/连字符的键名' };
          }
          if (typeof it.label !== 'string' || it.label.trim().length === 0 || it.label.length > 64) {
            return { ok: false, reason: 'setup kv 条目必须带 1–64 字符的 label(kv 键名宿主无先验,弹窗要有名字可展示)' };
          }
          if (raw.settingsHtml === undefined) {
            return { ok: false, reason: 'setup 引用了 kv 参数但没有 settingsHtml——参数由意识设置界面收单,没有界面就没人填' };
          }
          item = { kind: 'kv', key: it.kv, label: it.label };
        } else {
          return { ok: false, reason: 'setup.requires[].anyOf 每条必须是字符串引用或 { "kv", "label" } 对象' };
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
      return { ok: false, reason: 'command 必须是 1–32 字符、不含空白与 "/" 的字符串' };
    }
    if (tools === undefined) {
      return { ok: false, reason: '声明了 command 但没有 tools——没有工具的指令无事可做' };
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
      return { ok: false, reason: '声明了 keywords 但没有 tools——没有工具的触发词无事可做' };
    }
    const seen = new Set<string>();
    keywords = [];
    for (const k of raw.keywords) {
      if (typeof k !== 'string') return { ok: false, reason: 'keywords 每项必须是字符串' };
      const word = k.trim();
      if (word.length < 2 || word.length > 24) {
        return { ok: false, reason: `keywords 每项须为 2–24 字符(单字词命中面失控):${JSON.stringify(k)}` };
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
      schemaVersion: 2,
      id: raw.id,
      name: raw.name,
      version: raw.version,
      kind: 'chip',
      ...(raw.author !== undefined ? { author: raw.author as string } : {}),
      ...(locales !== undefined ? { locales } : {}),
      ...(raw.description !== undefined ? { description: raw.description as string } : {}),
      ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string } : {}),
      ...(raw.icon !== undefined ? { icon: raw.icon as string } : {}),
      entry: raw.entry,
      ...(raw.launch !== undefined ? { launch: raw.launch as GhostLaunchMode } : {}),
      ...(raw.settingsHtml !== undefined ? { settingsHtml: raw.settingsHtml as string } : {}),
      ...(raw.settingsHeight !== undefined ? { settingsHeight: raw.settingsHeight as number } : {}),
      slots,
      ...(tools !== undefined ? { tools } : {}),
      ...(card !== undefined ? { card } : {}),
      ...(cindy !== undefined ? { cindy } : {}),
      ...(agent !== undefined ? { agent } : {}),
      ...(node !== undefined ? { node } : {}),
      ...(subscribe !== undefined ? { subscribe } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(preview !== undefined ? { preview } : {}),
      ...(skill !== undefined ? { skill } : {}),
      ...(setup !== undefined ? { setup } : {}),
      ...(raw.command !== undefined ? { command: raw.command as string } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(panel !== undefined ? { panel } : {}),
    },
  };
}

/**
 * ── 管子(脑机接口)消息协议(docs/dev-rules/plugin-security-and-authoring.md)──
 *
 * 下行(主机 → 电子脑,'ghost-pipe:message' 单向推):
 *   - tool-call:agent 经 ghost 总机派活。电子脑处理完必须用 send 上行
 *     tool-result 交卷(callId 配对;超时由主机掐,过期卷子作废)。
 *
 * 上行(电子脑 → 主机,cindy.send(payload) = ipcRenderer.invoke):
 *   - tool-result:交卷。
 *   - host-request:读取宿主公开上下文。目前只支持 app-context(region + locale),
 *     无需声明卡槽、无用户数据与凭证内容。
 *   - cindy-request(旧名 model-request 兼容):cindy 槽代办(意识请 Cindy 本体干活;invoke 的返回值即结果,
 *     无需另配对)。gen_image / edit_image;须声明 'cindy' 卡槽与能力详单。
 *   - fetch-request:network 槽代理 HTTP(invoke 返回值即响应,无需另配对)。
 *     须声明 'network' 卡槽与域名详单;凭证由主机注入,意识永不经手。
 *   - pick-request:pick 槽——请主机弹系统级选文件夹窗口(用户亲选即授权)。
 *   - preview-request:preview 槽——请主机在右侧栏内置浏览器开预览标签页
 *     (URL 必须命中身份卡 preview.hosts 白名单)。
 *
 * 身份永远由主机按 webContents 反查(不信自报),这里的类型只描述载荷形状。
 */

/** 下行:工具调用派发。 */
export interface GhostPipeToolCall {
  type: 'tool-call';
  /** 配对号(主机生成;交卷时原样带回)。 */
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** 上行:工具调用交卷。 */
export type GhostPipeToolResult =
  | { type: 'tool-result'; callId: string; ok: true; result: unknown }
  | { type: 'tool-result'; callId: string; ok: false; errorCode?: string; message: string };

/**
 * 上行:工具调用进度心跳(长任务续命)。在途 tool-call 每收到一次心跳,
 * 主机把该卷的超时窗口重新续满一个基础档(缺省 330s),从派发起算不超过
 * GHOST_PIPE_CALL_MAX_TOTAL_MS 天花板。经 cindy-request 请主机代办且带
 * callId 的署名单在途时主机自动续命,无需心跳;意识自己经 network 槽轮询
 * 外部长任务时才需要发。验身与交卷同纪律:callId 不是派给你的即丢弃。
 */
export interface GhostPipeToolProgress {
  type: 'tool-progress';
  callId: string;
}

/**
 * 管子 tool-call 从派发起算的绝对上限(毫秒,30 分钟):代办自动续命与
 * tool-progress 心跳共用的天花板——盖住视频代办 expected×3 的最大轮询
 * 预算(seedance-pro 为 900s)+ 余量,又不给真死掉的调用无限吊着的机会。
 * (2026-07-24 管子长任务续命定案:此前 330s 固定超时令分钟级视频代办
 * 必超时,任务在后台继续烧钱、结果却作废。)
 */
export const GHOST_PIPE_CALL_MAX_TOTAL_MS = 30 * 60_000;

/** 主机公开给意识的构建区域。与 desktop CURRENT_CINDY_REGION 同口径。 */
export type GhostAppRegion = 'cn' | 'global';

/**
 * 上行:读取宿主公开上下文。`cindy.request({kind:'app-context'})` 是 preload
 * 提供的语法糖,底层仍走同一根 ghost-pipe 与主机白名单。
 */
export interface GhostPipeHostRequest {
  type: 'host-request';
  kind: 'app-context';
}

/** 插件请求 Agent 新回合时可选的会话处理方式。 */
export const GHOST_AGENT_RUN_MODES = ['continue', 'fork', 'new'] as const;
export type GhostAgentRunMode = (typeof GHOST_AGENT_RUN_MODES)[number];

/** Agent 回合的触发来源；后台触发需要清单中的额外权限。 */
export const GHOST_AGENT_TRIGGER_KINDS = ['user-action', 'background'] as const;
export type GhostAgentTriggerKind = (typeof GHOST_AGENT_TRIGGER_KINDS)[number];

/**
 * 上行:请求 Cindy Agent 开始一个普通用户回合。
 *
 * promptTemplate 必须且只能含一个 `{{user_message}}`；宿主完成替换并把
 * `{{event_json}}` 替换成 event 的 JSON。插件文本始终进入普通 user 回合，
 * 不会进入 system prompt。
 */
export interface GhostPipeAgentRequest {
  type: 'agent-request';
  mode: GhostAgentRunMode;
  trigger?: GhostAgentTriggerKind;
  promptTemplate: string;
  userMessage: string;
  event?: unknown;
  /** user-action 触发必填；来自宿主下发的 card-action 事件。 */
  userActionToken?: string;
  /** background 触发必填；必须是该插件曾由真人点击建立过关联的会话。 */
  sessionId?: string;
  /** new 模式的新会话标题；其它模式忽略。 */
  title?: string;
}

/** 插件请求 Agent 新回合的结构化返回。 */
export type GhostPipeAgentResult =
  | {
      ok: true;
      sessionId: string;
      mode: GhostAgentRunMode;
      disposition: 'created' | 'resumed' | 'active' | 'queued' | 'forked';
    }
  | {
      ok: false;
      errorCode:
        | 'INVALID_REQUEST'
        | 'PERMISSION_DENIED'
        | 'TOKEN_EXPIRED'
        | 'RATE_LIMITED'
        | 'HOST_NOT_READY'
        | 'SESSION_NOT_FOUND'
        | 'SESSION_UNAVAILABLE'
        | 'FORK_FAILED'
        | 'INTERNAL';
      message: string;
    };

/**
 * node-request 长任务绝对上限(毫秒,15 分钟):声明 maxTotalMs 后请求最长
 * 可以吊多久的天花板——盖住旧 Bridge 约 12 分钟的构建时长,又不给真死掉的
 * 进程永远吊着的机会。
 */
export const GHOST_NODE_REQUEST_MAX_TOTAL_MS = 15 * 60_000;

/** 上行:main.js 通过主机中继调用随包 Node 工作进程。 */
export interface GhostPipeNodeRequest {
  type: 'node-request';
  /** JSON-RPC 方法名；mcp-stdio 时使用 tools/list、tools/call 等 MCP 方法。 */
  method: string;
  params?: unknown;
  /**
   * 单次等待上限,缺省 30 秒;允许 1–120 秒。声明了 maxTotalMs 时语义变为
   * **沉默窗口**:worker 只要还有动静(stdout 协议消息或 stderr 日志)就续期。
   */
  timeoutMs?: number;
  /**
   * 长任务绝对上限(2026-07-23,构建续命):声明后开启"有动静就续期",
   * 必须 ≥ 生效的 timeoutMs 且 ≤ GHOST_NODE_REQUEST_MAX_TOTAL_MS(15 分钟)。
   * 缺省 = 不续期,行为与旧版完全一致。
   */
  maxTotalMs?: number;
  /**
   * 目标工作进程入口(2026-07-23,多进程窄版):缺省 = node.entry 主进程;
   * 指定时必须逐字命中 node.entries 申报清单,否则整单拒。
   */
  entry?: string;
}

/** Node / stdio MCP 请求的结构化返回。 */
export type GhostPipeNodeResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      errorCode:
        | 'INVALID_REQUEST'
        | 'PERMISSION_DENIED'
        | 'PROCESS_START_FAILED'
        | 'PROCESS_EXITED'
        | 'PROTOCOL_ERROR'
        | 'TIMEOUT'
        | 'RATE_LIMITED'
        | 'INTERNAL';
      message: string;
      data?: unknown;
    };

/**
 * session-context 槽注入到 tool-call args.session_context 的形态(主机铸造,
 * snake_case 与 dir_deposit / save_deposit 同风格)。
 *
 * workdir_is_local 是本注入的位置安全核心:只有主机能证明「该会话不是远程工作区
 * (sessions.remoteHostId 为空)」时才为 true;证明不了(远程会话 / 查无会话 /
 * 无 sessionId 语境)一律 false——插件此时**不得**把 workdir 当本机路径交给
 * Node 侧读写(fail closed,见 docs/dev-rules/plugin-security-and-authoring.md §6)。
 * workdir_is_read_only 则由同一份会话 permission / plan 状态铸造;为 true 时
 * 插件不得修改当前 workdir。证明不了会话状态时同样 fail closed 为 true。
 */
export interface GhostSessionContextInjected {
  session_id: string | null;
  workdir: string | null;
  workdir_is_local: boolean;
  workdir_is_read_only: boolean;
}

/**
 * session-context 注入体推导(纯函数;main 侧查会话快照后调用):
 * - 无 sessionId 语境 / 查无会话:回落 ALS workdir,但恒 workdir_is_local=false
 *   且 workdir_is_read_only=true(证明不了就不许当本机路径或修改,fail closed);
 * - 有快照:workdir 取会话真身,只有 remoteHostId 为空且 workdir 非空才算本地。
 */
export function deriveGhostSessionContext(
  sessionId: string | null,
  fallbackWorkdir: string | null,
  snapshot: {
    workingDir: string | null;
    remoteHostId: string | null;
    workdirIsReadOnly: boolean;
  } | null,
): GhostSessionContextInjected {
  if (!sessionId) {
    return {
      session_id: null,
      workdir: fallbackWorkdir,
      workdir_is_local: false,
      workdir_is_read_only: true,
    };
  }
  if (!snapshot) {
    return {
      session_id: sessionId,
      workdir: fallbackWorkdir,
      workdir_is_local: false,
      workdir_is_read_only: true,
    };
  }
  return {
    session_id: sessionId,
    workdir: snapshot.workingDir,
    workdir_is_local: snapshot.remoteHostId === null && snapshot.workingDir !== null,
    workdir_is_read_only: snapshot.workdirIsReadOnly,
  };
}

/** pick 槽:标题(选择框里的用途说明)长度上限。 */
export const GHOST_PICK_TITLE_MAX_CHARS = 80;
/** pick 槽:同一插件两次弹选择框的最小间隔 ms(防对话框骚扰)。 */
export const GHOST_PICK_MIN_INTERVAL_MS = 3000;

/**
 * 上行:pick 槽——请主机弹系统级选文件夹窗口。用户亲手选中即授权;
 * 取消即拒,插件拿不到任何路径信息。
 */
export interface GhostPipePickRequest {
  type: 'pick-request';
  /** v1 只支持选目录;将来扩文件类型时在此收窄枚举。 */
  mode: 'directory';
  /** 选择框内的用途说明(净化后随插件名一起展示,让用户知道谁在要、要来干嘛)。 */
  title?: string;
  /**
   * 是否同时签发目录过户票据(dir_deposit,上传等主机代办用;收集有
   * 文件数/体积上限,大目录会失败)。未声明 node 槽的插件必须请求票据——
   * 否则选完什么都拿不到,请求本身就是无意义的。
   */
  deposit?: boolean;
}

/** pick 槽结构化返回。path 仅在插件声明了 node 槽时提供(见 GHOST_SLOTS 注释)。 */
export type GhostPipePickResult =
  | {
      ok: true;
      /** 所选目录名(展示用,不含上级路径)。 */
      name: string;
      /** 绝对路径:仅 node 槽插件可见(Node 侧本就有用户级本机权限)。 */
      path?: string;
      /** 目录过户票据(同 ghost_call dir 通道;上传等主机代办凭票取件)。 */
      dir_deposit?: DirDepositReceiptShape;
    }
  | {
      ok: false;
      errorCode:
        | 'PERMISSION_DENIED'
        | 'INVALID_REQUEST'
        | 'CANCELLED'
        | 'RATE_LIMITED'
        | 'BUSY'
        | 'INTERNAL';
      message: string;
    };

/**
 * dir_deposit 票据的意识可见形态(与 main/cindy-brain/dirDeposit.ts 的
 * DirDepositReceipt 同构;shared 不反向 import main,这里镜像声明)。
 */
export interface DirDepositReceiptShape {
  token: string;
  file_count: number;
  total_bytes: number;
  rel_paths: string[];
}

/** workspace 槽:用途说明/新会话标题长度上限。 */
export const GHOST_WORKSPACE_TITLE_MAX_CHARS = 100;
/** workspace 槽:同一插件两次请求的最小间隔 ms(防确认卡/对话框骚扰)。 */
export const GHOST_WORKSPACE_MIN_INTERVAL_MS = 3000;

/**
 * 上行:workspace 槽——请主机在指定本机项目目录下确保存在一个会话入口
 * (侧边栏可见)。目录下已有 active 会话时复用(created:false),没有才创建
 * 空 draft 会话(不拉起 agent 进程)。目录授权两条路:
 * - mode:'pick':主机弹系统级选文件夹窗口,用户亲手选中即授权,绝对路径
 *   不回沙箱(与 pick 槽同一哲学);
 * - mode:'dir':传绝对路径 + 当前在途 ghost_call 的 callId(主机签发的上下文
 *   凭证,反查发起会话)。目录在该会话 workdir 内自动放行,workdir 外弹
 *   确认卡由用户决定(对齐 attachments/dir 过户的两档钳制)。
 * 远程工作区(SSH)v1 不支持,一律拒(fail closed)。
 */
export type GhostPipeWorkspaceRequest =
  | {
      type: 'workspace-request';
      kind: 'ensure-session';
      mode: 'pick';
      /** pick 模式选择框里的用途说明(净化后随插件名展示);也用作新会话标题。 */
      title?: string;
      /** 建成/命中后是否跳转聚焦到该会话(缺省 false,只落侧边栏)。 */
      focus?: boolean;
    }
  | {
      type: 'workspace-request';
      kind: 'ensure-session';
      mode: 'dir';
      /** 目标项目目录的本机绝对路径。 */
      dir: string;
      /** 当前在途 ghost_call 的 callId。 */
      callId: string;
      /** 用作新会话标题(净化后展示)。 */
      title?: string;
      /** 建成/命中后是否跳转聚焦到该会话(缺省 false,只落侧边栏)。 */
      focus?: boolean;
    };

/** workspace 槽结构化返回。绝对路径不回沙箱,只给目录 basename。 */
export type GhostPipeWorkspaceResult =
  | {
      ok: true;
      sessionId: string;
      /** true = 本次新建;false = 命中已有会话复用。 */
      created: boolean;
      /** 目录名(展示用,不含上级路径)。 */
      name: string;
    }
  | {
      ok: false;
      errorCode:
        | 'PERMISSION_DENIED'
        | 'INVALID_REQUEST'
        | 'CANCELLED'
        | 'RATE_LIMITED'
        | 'BUSY'
        | 'DIR_NOT_FOUND'
        | 'NOT_DIRECTORY'
        | 'HOST_NOT_READY'
        | 'INTERNAL';
      message: string;
    };

/**
 * 上行:preview 槽——请主机在右侧栏内置浏览器打开一个预览标签页。
 * url 必须命中身份卡 preview.hosts 白名单(ghostPreviewUrlAllowed);
 * sessionId 缺省 = 当前活跃会话(通常配合 session-context 注入的 session_id)。
 */
export interface GhostPipePreviewRequest {
  type: 'preview-request';
  url: string;
  sessionId?: string;
}

/** preview 槽结构化返回。 */
export type GhostPipePreviewResult =
  | { ok: true }
  | {
      ok: false;
      errorCode:
        | 'PERMISSION_DENIED'
        | 'INVALID_REQUEST'
        | 'URL_NOT_ALLOWED'
        | 'RATE_LIMITED'
        | 'HOST_NOT_READY'
        | 'INTERNAL';
      message: string;
    };

/** host-request 与 settings 页面 `/app-context` 共用的只读返回形态。 */
export interface GhostAppContextResult {
  ok: true;
  context: {
    region: GhostAppRegion;
    /** 当前宿主应用语言；插件只使用本值，不读取 navigator.language。 */
    locale: SupportedLocale;
  };
}

/**
 * 上行:聊天卡片供片(卡槽③海报模式)。意识为自己的一次 tool-call
 * 提供聊天流卡片内容:收到 tool-call 后即可发第一版(过程海报),执行中
 * 整版换稿(主机按 GHOST_CARD_MIN_INTERVAL_MS 限速),交卷前发最终版。
 * html 必须是纯静态 HTML+CSS——脚本/事件属性/外链会被主机 sanitizer 剥除,
 * 图片只认本意识名下的 cindy-media://blobs/<指纹>.<ext> 地址。
 * 不发 = 聊天流按今日默认渲染(通用图卡),卡片是每次调用的可选项。
 */
export interface GhostPipeCardUpdate {
  type: 'card-update';
  /** 归因号:tool-call 下发的 callId 原样带回(主机验"这单是不是派给你的")。 */
  callId: string;
  /** 卡片正文(静态 HTML+CSS;≤ GHOST_CARD_HTML_MAX_BYTES,超限整条拒)。 */
  html: string;
  /** 期望渲染高度 px(clamp 到 [GHOST_CARD_HEIGHT_MIN, GHOST_CARD_HEIGHT_MAX])。 */
  height?: number;
  /**
   * 协议版本:1 = 海报模式(静态);2 = 交互卡(HTML 里可含 data-ghost-action
   * 按钮,点击经宿主回传 card-action 事件)。缺省 1。渲染层的点击委托对 v1/v2
   * 都生效(v 仅作意图声明 + 遥测),真正的闸是净化器放行 data-ghost-action。
   */
  v?: 1 | 2;
  /**
   * 后台活动状态声明(可选):
   * 'working' = 过程态、还在干活——主机据此:(a) 保持会话侧栏的运行呼吸;
   *   (b) 渲染层持续播放该卡的自绘动画(不再随调用 settle 停播);(c) 把该
   *   卡位的更新窗口跨调用保持打开(自首个 'working' 起封顶
   *   GHOST_CARD_WORKING_WINDOW_MS)——生成类意识可以把过程卡钉在提交调用
   *   的卡位上,由后续轮询调用持续刷进度,终态媒体(视频/音频播放器)仍由
   *   无卡的轮询调用按基座默认渲染。
   * 'done' = 终版——熄灭呼吸、关闭跨调用窗口(回到 settle 宽限语义)。
   * 不声明 = 旧语义(settle + 宽限窗;card-action 场景由主机"点击即亮、
   * 静默超时自动灭"兜底)。非法值整条拒收。
   */
  state?: 'working' | 'done';
}

/**
 * state:'working' 声明打开的跨调用更新窗口上限 ms(自该卡**首个** working
 * 版本起算,固定不滑动)。意义:让"提交调用画常驻过程卡、轮询调用跨卡位刷
 * 进度"的生成类流程走得通(视频/音乐可长达十几分钟);**固定上限**是安全
 * 缓冲——settle 后锁卡本是"不给已完结消息留远程改写面"的防线,working 窗口
 * 是对它的有界豁免,不能被意识用连续 working 无限续命。
 */
export const GHOST_CARD_WORKING_WINDOW_MS = 30 * 60_000;

/** 卡片 html 字节上限(UTF-8;与 manifest tools[].parameters 16KB 同精神,卡片放宽一倍)。 */
export const GHOST_CARD_HTML_MAX_BYTES = 32 * 1024;
/** 卡片渲染高度下限 px。 */
export const GHOST_CARD_HEIGHT_MIN = 120;
/** 卡片渲染高度上限 px(容 ~460 宽通栏竖图 9:16 + 题注;与 generic 图卡的
 *  "高图可以很高"口径对齐,再高截断)。 */
export const GHOST_CARD_HEIGHT_MAX = 900;
/** 未声明 height 时的缺省渲染高度 px。 */
export const GHOST_CARD_HEIGHT_DEFAULT = 240;
/** 同一 callId 两版卡片的最小间隔 ms(首版免罚;超发静默丢,防聊天流被刷)。 */
export const GHOST_CARD_MIN_INTERVAL_MS = 1000;

/**
 * 交互卡按钮的 action id 形状(v2,data-ghost-action 值):意识声明、宿主回传。
 * 收 `:`——mivo 的 customId 形如 `MJ::JOB::upsample::1::<uuid>` /
 * `NANOBANANA::image::imgPrompt::0::<id>`,含双冒号;长度放到 128。净化器按此
 * 校验,不合法整属性丢(元素本身仍在,只是点不动)。
 */
export const GHOST_CARD_ACTION_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * 宿主点击后的本地锁定窗口 ms:点了按钮先禁用/防连点,等意识 card-update
 * 换新卡自然解锁;窗口内意识没换卡也自动解禁(防卡死)。
 */
export const GHOST_CARD_ACTION_INFLIGHT_MS = 8000;

/**
 * 需要用户输入文字的动作(data-ghost-prompt 声明,如 mivo 的 imgPrompt 改写):
 * 宿主点击时弹输入框收集,随 card-action 的 prompt 字段回传。两个上限:
 * 输入正文与占位文案(data-ghost-prompt 属性值,超限整属性丢)。
 */
export const GHOST_CARD_ACTION_PROMPT_MAX_LEN = 2000;
export const GHOST_CARD_PROMPT_PLACEHOLDER_MAX_LEN = 128;

/**
 * 卡内外链声明(data-ghost-link,<a href> 由净化器转写为同一属性)的值上限。
 * 超限整属性丢(元素与文字保留,只是点不动)。
 */
export const GHOST_CARD_LINK_MAX_LEN = 2048;

/**
 * 卡内外链声明的白名单校验(净化器与宿主点击桥共用,双层同判):
 * 仅整串 http/https URL;空白与控制字符出现即拒——URL 构造器会静默剥掉
 * TAB/CR/LF,校验对象与落地属性值必须是同一串,不给"解析后合法、原文
 * 混淆"留缝。真实跳转仍由 main 的 shell:open-external 再验一道协议(第三道)。
 */
export function isGhostCardLinkAllowed(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > GHOST_CARD_LINK_MAX_LEN) {
    return false;
  }
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c <= 32 || c === 127) return false;
  }
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 衍生卡 callId 的分隔标记:card-action 派发时主机铸造 `<根callId>::sp<序>`
 * 作为新卡位(spawnCallId)随事件下发。意识对它 card-update = 在原卡下方长出
 * 一张新卡(原卡原封不动——MJ 抽卡式玩法,母卡按钮可反复点);仍写原 callId
 * = 原地换卡(旧行为,向后兼容)。所有衍生卡平铺挂在根卡下:点衍生卡上的
 * 按钮,新 spawn 仍以根 callId 为前缀铸造,不嵌套(callId 长度恒定)。
 * renderer 据此前缀识别衍生卡:不进活卡锚定池、堆叠渲染在母卡画布下方。
 */
export const GHOST_CARD_SPAWN_SEP = '::sp';

/** 取衍生卡的根 callId(非衍生卡原样返回)。 */
export function ghostCardRootCallId(callId: string): string {
  const i = callId.indexOf(GHOST_CARD_SPAWN_SEP);
  return i === -1 ? callId : callId.slice(0, i);
}

/**
 * card-action 触发后的卡片"重开"窗口 ms。交互卡的按钮常在卡片结算很久后
 * (甚至重启后)才被点,那时卡片调用早过 GRACE_MS 宽限、内存条目已被清扫,
 * 意识想 card-update 换新卡会撞 too-late/unknown-call。所以派发 card-action
 * 前把该 callId 重开为 in-flight(窗内自由更新,窗外由懒清扫回收);窗口取足够
 * 长以覆盖一次按钮动作的完整轮询(mivo 单窗 105s + 下载 + 余量)。
 */
export const GHOST_CARD_REOPEN_WINDOW_MS = 600_000;

/**
 * tool_result JSON 顶层的卡片配对令牌键名。仅当该次调用真供过卡时由主机
 * 注入(值 = callId),renderer 据此从卡片库取卡渲染;模型侧 mediaHint 已
 * 声明忽略。
 */
export const GHOST_CARD_ID_KEY = 'xdt_card_id';

/**
 * notify 槽的提示语气(→ 主机 Toast 的 variant;缺省 'info')。
 * 只影响图标与配色,不改变"轻提示、自动消失、无按钮"的形态。
 */
export const GHOST_NOTIFY_TONES = ['info', 'success', 'warning', 'error'] as const;
export type GhostNotifyTone = (typeof GHOST_NOTIFY_TONES)[number];

/**
 * 上行:系统提示(notify 槽,2026-07-14)。意识请主机在屏幕顶部弹一条
 * 轻提示(toast):意识只供**纯文本**(不是 HTML,主机原样作文本渲染,
 * 控制字符剥除、超限拒收),提示壳与意识身份头(图标+名字)由主机画——
 * 意识伪装不了主机通知、也冒充不了别的意识(信任边界与订阅槽红条同款)。
 * 无阻塞、无按钮、无回执;确认类交互不在本槽(面板自绘或卡槽③交互卡)。
 * 典型场景:分钟级代办完成、授权即将过期、订阅旁听发现值得提醒的事。
 */
export interface GhostPipeNotify {
  type: 'notify';
  /** 提示正文(纯文本,≤ GHOST_NOTIFY_MAX_CHARS;允许 \n 换行)。 */
  text: string;
  /** 语气(图标/配色);缺省 'info'。 */
  tone?: GhostNotifyTone;
}

/** notify 的 invoke 返回(失败带人话原因,供意识作者调试;不涉他人信息)。 */
export type GhostPipeNotifyResult = { ok: true } | { ok: false; message: string };

/** 提示正文长度上限(与订阅槽 block reason ≤200 同量级:一眼能读完的量)。 */
export const GHOST_NOTIFY_MAX_CHARS = 200;

/**
 * 主机代言提示的文案键(host-origin notice,2026-07-14):凭证入库 / 授权
 * 成功这类**主机权威事件**的 tips——事件判定者是主机(/secrets 入库、OAuth
 * 流程收尾都在主机手里),不经意识代码、不占意识 notify 限速、也不要求意识
 * 声明 notify 槽。广播走同一 ghosts:notify 通道但载荷带 textKey/textArgs
 * (而非 text):文案是主机说的话,必须跟用户语言走,由 renderer 按本白名单
 * 校验后翻译渲染(i18n `chat.ghostNotify.<key>`);白名单外的键静默丢弃,
 * 防版本错配时把生肉 key 摆上界面。
 */
export const GHOST_HOST_NOTICE_KEYS = ['secretSaved', 'oauthConnected', 'oauthConnectedNoLabel', 'connectionAdded'] as const;
export type GhostHostNoticeKey = (typeof GHOST_HOST_NOTICE_KEYS)[number];

/** 同一意识两条提示的最小间隔 ms(超发拒收,防 toast 刷屏骚扰)。 */
export const GHOST_NOTIFY_MIN_INTERVAL_MS = 5000;

/** cindy 槽代办的质量档位:意识只表达"要多好",具体模型由主机解析表决定。 */
export const GHOST_MODEL_TIERS = ['draft', 'standard', 'best'] as const;
export type GhostModelTier = (typeof GHOST_MODEL_TIERS)[number];

/**
 * cindy 槽生图代办的画幅意图:方图 / 横图 / 竖图。与 tier 同一哲学——意识
 * 只声明比例意图,主机翻译成当前后端支持的具体像素尺寸(枚举值即真实产出
 * 比例,当前三档全后端可兑现,不做"最近似"降级)。将来扩值域(如 16:9)
 * 是向后兼容的加法,老意识不受影响。
 */
export const GHOST_IMAGE_ASPECT_RATIOS = ['1:1', '3:2', '2:3'] as const;
export type GhostImageAspectRatio = (typeof GHOST_IMAGE_ASPECT_RATIOS)[number];

/**
 * cindy 槽视频代办的画幅比例。与生图的 aspectRatio 分开成两套值域:视频
 * 后端(video provider 层)的公共集是 16:9 系,与图像后端的原生尺寸枚举
 * 没有交集,合成一套只会让两边都出现"声明了却兑现不了"的值。这里登记的
 * 是**所有已注册 provider 都支持**的交集,单个型号的实际支持集由主机在
 * 解析出选型后二次校验(型号不支持即明拒,不做最近似降级)。
 */
export const GHOST_VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const;
export type GhostVideoRatio = (typeof GHOST_VIDEO_RATIOS)[number];

/** cindy 槽视频代办的分辨率档(同 GHOST_VIDEO_RATIOS 的口径:公共集 + 按型号二次校验)。 */
export const GHOST_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type GhostVideoResolution = (typeof GHOST_VIDEO_RESOLUTIONS)[number];

/**
 * 视频时长/帧率的形状上限(秒 / fps)。这两项各型号差异大(如 seedance
 * 支持 4/6/8/10 秒,happyhorse 只有 5 秒),协议层不枚举值域,只做"正整数
 * 且不离谱"的粗筛,真正的可用集由主机按解析出的型号校验并在拒绝话术里
 * 列出。粗筛的意义是挡住沙箱乱填(负数、小数、天文数字)。
 */
export const GHOST_VIDEO_MAX_DURATION_SECONDS = 60;
export const GHOST_VIDEO_MAX_FPS = 120;

/**
 * 异步代办(mode:'submit')完成结果的保留时长(毫秒,30 分钟):完成后
 * 过期即清,query_job 查无此单。TTL 之外还有每意识完成记录条数上限
 * (cindySlot 的 settled-job eviction):快速提交循环下最旧的完成记录会
 * 在 TTL 未到时被提前淘汰。任务表在内存(主进程重启即丢),意识须把
 * "查无此单"当作可重新提交的正常失败面。
 */
export const GHOST_CINDY_JOB_TTL_MS = 30 * 60_000;

/**
 * 每意识后台异步代办在途上限。同步代办天然被管子超时与 agent 节奏限流,
 * 异步提交是瞬时的,必须有内置闸防批量提交刷爆付费通道;用户配置的
 * inflightLimit(同时约束同步+异步)更严时以更严者为准。
 */
export const GHOST_CINDY_MAX_ASYNC_JOBS = 2;

/**
 * ── deposit_media 政策参数(makecindy/cindy#784)─────────────────────────
 *
 * 寄存是插件写持久媒体的第三条路,而且是唯一**两道闸都没有**的一条:模型
 * 代办要花钱(成本即天然限流),network `as:'media'` 限 manifest 白名单域名,
 * 寄存收的是本地字节 —— 不花钱、不出网、可程序化循环调用。因此这条通道
 * 自带三重硬闸:单次上限、每意识累计配额、令牌桶频控。
 */

/**
 * 单次寄存上限(解码后字节;超限整单拒)。
 *
 * 2026-07-29 由 16MB(fs 槽单次写量级)上调至 50MB:实拍照片与短视频素材
 * 常态超过 16MB,压到 16MB 以下要插件自己转码,与"画布上的图直接能改"的
 * 目标冲突。下游没有新的天花板 —— network `as:'media'` 的入仓硬顶本就是
 * GHOST_FETCH_MEDIA_MAX_BYTES(256MB),blobStore 不设上限。
 *
 * 代价说明白:寄存的字节以 base64 走一次 ghost-pipe IPC(50MB → 约 67MB
 * 字符串的瞬时分配),这是本通道与 network 通道的结构性差别 —— 后者字节
 * 全程在主机手里、不过 IPC。因此这个数不宜再往上抬;真需要更大的素材,
 * 正确解法是插件侧压缩或分片,不是继续抬上限。
 */
export const GHOST_CINDY_DEPOSIT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 每意识寄存累计配额(字节)。只统计**寄存**引用(refKind 'ghost-deposit'),
 * 不含模型产物与 network 下载 —— 否则一个出图很多的意识会连一张参考图都
 * 存不进来。内容寻址天然去重:同一张图反复寄存不重复占额。
 * 用满的释放口是 release_media(面板删素材时撤回),不做静默 LRU 淘汰
 * ——"昨天能改今天改不了"正是 #784 要消灭的体验。
 *
 * 2026-07-29 由 512MB 上调至 1GB:单次上限同步抬到 50MB 后,原配额只够存
 * 十来件大素材,重度使用的无限画布会频繁撞顶。
 */
export const GHOST_CINDY_DEPOSIT_QUOTA_BYTES = 1024 * 1024 * 1024;

/**
 * 频控令牌桶:容量 = 允许的突发张数(用户一次粘一批图要立刻可用),
 * 之后按 refill 间隔匀速回补。防的是程序化死循环刷仓,不是拦正常批量粘贴。
 */
export const GHOST_CINDY_DEPOSIT_BURST = 8;
export const GHOST_CINDY_DEPOSIT_REFILL_MS = 1000;

/**
 * 上行:cindy 槽代办请求(请 Cindy 本体出图 / 改图)。协议 type 为
 * 'cindy-request'(2026-07-11 由 'model-request' 更名,主机对旧名保持
 * 静默兼容)。选型双轨:
 * - tier(推荐):档位意图(draft 快省草稿 / standard 默认 / best 最好),
 *   主机按解析表翻译成当下的具体模型——意识代码永不腐烂;
 * - model(仅透传场景):用户在会话里显式点名某模型时原话带给主机,
 *   白名单外一律拒。意识自己**不要**替用户做选型。
 * 两者都给时 model 优先。意识永远不经手 key,也决定不了白名单之外的路由。
 */
export type GhostPipeCindyRequest =
  | {
      type: 'cindy-request';
      kind: 'gen_image';
      prompt: string;
      tier?: GhostModelTier;
      model?: string;
      /**
       * 画幅比例(可选):'1:1' 方图 / '3:2' 横图 / '2:3' 竖图;不传 =
       * 后端自定(auto)。比例是意图声明,主机映射为该后端的具体尺寸,
       * 实际像素以返回的 width/height 为准。图像类代办(生图/改图)专用,
       * 视频类请改用 ratio(值域不同),带错了会被明拒。
       */
      aspectRatio?: GhostImageAspectRatio;
      /**
       * 归因号(可选):这单代办由哪次 tool-call 触发,把收到的
       * callId 原样带上——配额记账、日志、用量面板由此对上"哪次调用花的
       * 钱"。面板交互等无 tool-call 语境的代办可不带(日志记 unattributed)。
       */
      callId?: string;
    }
  | {
      type: 'cindy-request';
      kind: 'edit_image';
      prompt: string;
      /**
       * 源图指纹(sha256,1–4 张)。只能引用本意识名下(出生自它或挂在
       * 它画廊)的媒体——主机逐张查账验归属,查无此账即拒。
       */
      hashes: string[];
      tier?: GhostModelTier;
      model?: string;
      /**
       * 画幅比例(可选,语义同 gen_image 分支)。不传 = 跟随源图画幅
       * (后端 auto),这也是历史行为;传了则按该比例重绘。
       */
      aspectRatio?: GhostImageAspectRatio;
      /** 归因号(同 gen_image 分支)。 */
      callId?: string;
    }
  | {
      type: 'cindy-request';
      kind: 'gen_video';
      prompt: string;
      tier?: GhostModelTier;
      model?: string;
      /**
       * 画面参数(全部可选):不传 = 该型号的出厂默认(与历史行为逐字节
       * 同形)。ratio/resolution 的值域见 GHOST_VIDEO_RATIOS /
       * GHOST_VIDEO_RESOLUTIONS;duration(秒)与 fps 各型号支持集不同,
       * 主机按解析出的选型校验,不支持即明拒并列出可用值。实际生效的
       * 参数随结果回传(见 GhostPipeModelResult 的 videoParams)。
       */
      ratio?: GhostVideoRatio;
      resolution?: GhostVideoResolution;
      duration?: number;
      fps?: number;
      /** 归因号(同 gen_image 分支)。 */
      callId?: string;
      /**
       * 异步模式(仅视频类代办):'submit' = 资格审与源图校验通过后立即
       * 返回 jobId,生成在后台继续,用 kind:'query_job' 轮询取件。适合
       * 可能超过管子超时窗口的超长任务;缺省同步等待(主机会为署名单
       * 自动续命,分钟级任务推荐同步)。
       */
      mode?: 'submit';
    }
  | {
      type: 'cindy-request';
      kind: 'edit_video';
      prompt: string;
      /**
       * 参考图指纹(sha256,1–2 张:1 张=首帧动画,2 张=首尾帧过渡)。
       * 归属规则同 edit_image:只能引用本意识名下的媒体。
       */
      hashes: string[];
      tier?: GhostModelTier;
      model?: string;
      /** 画面参数(同 gen_video 分支;参考图不改变这几项的语义)。 */
      ratio?: GhostVideoRatio;
      resolution?: GhostVideoResolution;
      duration?: number;
      fps?: number;
      /** 归因号(同 gen_image 分支)。 */
      callId?: string;
      /** 异步模式(同 gen_video 分支)。 */
      mode?: 'submit';
    }
  | {
      type: 'cindy-request';
      kind: 'query_job';
      /** mode:'submit' 受理时返回的任务号(仅本意识自己的任务可查)。 */
      jobId: string;
    }
  | {
      /**
       * 寄存:把意识手里已有的媒体字节存入总仓、记到本意识名下,换回指纹
       * (makecindy/cindy#784)。典型来源是面板里用户粘贴/拖入的图与面板存量
       * 素材——它们的字节只在面板侧(IndexedDB / 面板内存),不在总仓,因此
       * 在寄存之前不能当 edit_image / edit_video 的源图。
       *
       * 不经模型、不花钱、不产出新内容:这条通道只是"字节换指纹"。因此它
       * **不进 ghost_call 产物账**(不会被当成生成物自动送进聊天/IM——用户
       * 自己粘的参考图被回推到 IM 会是隐私事故),也不进画廊(粘贴的参考图
       * 不是这个意识的"作品")。
       *
       * 须声明 'cindy' 卡槽 + `cindy.media: ["deposit"]`。
       */
      type: 'cindy-request';
      kind: 'deposit_media';
      /**
       * 媒体字节的 base64(不含 data: 前缀;解码后 ≤
       * GHOST_CINDY_DEPOSIT_MAX_BYTES = 50MB)。真实类型由主机按字节魔数
       * 判定,识别不出受支持媒体一律拒收——自报的 mime / 扩展名不作为依据。
       */
      data: string;
      /** 可选备注(入账 label;仅供主机侧账目与排查,不进聊天)。 */
      label?: string;
      /** 归因号(仅日志归因;寄存不计入产物账,见上)。 */
      callId?: string;
    }
  | {
      /**
       * 撤回寄存:删掉本意识对该指纹的寄存引用(配额随之释放)。面板上那件
       * 素材被用户删掉时调用,是 deposit 配额的正常释放口。
       *
       * 只删**本意识自己的寄存引用**:别人的引用、画廊引用、聊天消息引用都
       * 不受影响;字节本身交回收器按"引用归零"统一处理,本请求删不掉字节。
       * 与 deposit 共用 `cindy.media: ["deposit"]` 授权。
       */
      type: 'cindy-request';
      kind: 'release_media';
      /** 要撤回的寄存指纹(sha256)。 */
      hash: string;
    };

/**
 * 视频代办实际生效的画面参数回执(仅视频类代办)。取值优先用上游任务
 * 上报的真实值,上游没报的那项回落主机提交值;各字段仍可能缺省(上游
 * 没报且主机也没显式指定时)。类型是宽松的 string/number 而非请求侧的
 * 枚举——回执是**上游说的**,不能假设它落在主机的值域里。
 *
 * 用途:老宿主会静默忽略请求里的新画面参数,意识拿这份回执才分得清
 * "宿主不支持,给了默认档"与"宿主兑现了我要的档"。
 */
export interface GhostVideoResultParams {
  durationSeconds?: number;
  resolution?: string;
  ratio?: string;
  fps?: number;
}

/** cindy 槽代办的返回(cindy.send 的 resolve 值)。 */
export type GhostPipeModelResult =
  | {
      ok: true;
      /** 生成媒体的取件地址(cindy-media://…,聊天与面板皆可渲染)。 */
      url: string;
      /** 内容指纹(面板经 cindy-ghost://<id>/media/<指纹> 取件用)。 */
      hash: string;
      /** 落盘扩展名(含点)。 */
      ext: string;
      /** 实际执行的模型 id(主机解析后的最终选型,主机说了算)。 */
      model: string;
      /** 模型展示名(目录 label;意识交卷 note 里给用户看)。 */
      modelLabel: string;
      /**
       * 图片像素宽/高(仅图片代办,best-effort:主机解析字节头得来,
       * 解析不出则缺省)。意识供聊天卡片时据此按宽高比精确声明卡高,
       * 首帧即最终高度,不再经历"估计值 → 实测值"的可见收敛。
       */
      width?: number;
      height?: number;
      /** 视频代办实际生效的画面参数(仅视频类代办;图像类不带此字段)。 */
      videoParams?: GhostVideoResultParams;
    }
  | {
      ok: true;
      /** 异步受理(mode:'submit')与 query_job 进行中共用本分支。 */
      jobId: string;
      status: 'running';
      /** 该型号预期耗时(秒;registry 登记值,供意识决定轮询节奏)。 */
      expectedSeconds?: number;
      /** 已耗时(秒;仅 query_job 返回)。 */
      elapsedSeconds?: number;
    }
  | {
      /**
       * query_job 完成态(独立成员,jobId/status 必填):`'status' in r`
       * 即可与同步成功分支可靠判别。取件字段与同步成功分支同形。
       */
      ok: true;
      jobId: string;
      status: 'done';
      url: string;
      hash: string;
      ext: string;
      model: string;
      modelLabel: string;
      /** 与同步成功分支同形(异步代办只有视频,这里通常必带)。 */
      videoParams?: GhostVideoResultParams;
    }
  | {
      /**
       * deposit_media 成功(独立成员:有 `bytes`、无 `model`/`status`,
       * 可与生成分支可靠判别)。指纹拿到手即可直接当 edit_image /
       * edit_video 的源图,也可经 cindy-ghost://<id>/media/<指纹><后缀>
       * 在面板里取件。
       */
      ok: true;
      url: string;
      hash: string;
      ext: string;
      /** 落仓字节数(去重命中时为既有内容的字节数)。 */
      bytes: number;
      /** 该字节此前已在总仓(全局内容去重命中)。 */
      deduplicated: boolean;
      /** 寄存配额:本意识已用 / 上限(字节)。作者据此提前提示用户。 */
      quotaUsedBytes: number;
      quotaLimitBytes: number;
    }
  | {
      /** release_media 成功。released=false 表示本就没有这条寄存引用(幂等)。 */
      ok: true;
      released: boolean;
      quotaUsedBytes: number;
      quotaLimitBytes: number;
    }
  | { ok: false; message: string };

/* ── 订阅槽①:事件协议(2026-07-12 定案:一种事件模型,两个类型)──────
 * did- 旁听:fire-and-forget,主机投完即走,意识崩/慢不影响任何会话;
 * will- 拦截:主机停等裁决(硬超时 fail-open + 连续失败熔断降级只旁听)。
 * 事件名前缀即类型;未来开新拦截点 = 加 will- 事件 + 同一裁决协议。 */

/** 熄灯期事件缓冲队列上限(每意识;溢出丢最旧并在下一条累计 dropped)。 */
export const GHOST_SUB_QUEUE_MAX = 100;
/** will- 钩子裁决硬超时(毫秒;超时 = 放行 fail-open,聊天绝不被坏意识卡死)。
 *  仅用于 will-user-message(入口):它挡在发送前,必须快,不能让用户等。 */
export const GHOST_HOOK_TIMEOUT_MS = 3000;
/** will-assistant-message(出口)裁决超时(毫秒,5 分钟)。它是"先定案 → 后台
 *  处理完再原地替换"的后置钩子,不阻塞发送/发下一条,故容许长处理(意识可能
 *  跑外部合规接口 / 自己的 LLM 润色 / 出图);超时同样 fail-open 用原文定案。 */
export const GHOST_ASSISTANT_HOOK_TIMEOUT_MS = 5 * 60_000;
/** 钩子连续失败(超时/崩溃)熔断阈值:达到即降级为只旁听并通知用户。 */
export const GHOST_HOOK_FUSE_THRESHOLD = 3;
/** 钩子改写(rewrite)正文长度上限(字符,超长截断):防意识塞巨量正文
 *  撑爆消息;提示词优化产物通常远小于此。 */
export const GHOST_HOOK_REWRITE_MAX_CHARS = 16_000;

/** did- 旁听事件名(topic 归属:turn / session)。 */
export type GhostDidEventName =
  | 'did-turn-start'
  | 'did-turn-end'
  | 'did-session-created'
  | 'did-session-archived'
  | 'did-session-switched';

/** did-turn-start 载荷(全元数据,无消息内容)。 */
export interface GhostEventTurnStartData {
  sessionId: string;
  /** agent 种类(claude / codex;以主机实际派发为准)。 */
  agent: string;
  model?: string;
}

/** did-turn-end 载荷。usage 各字段**可选**:cc/codex 上报丰富度不同
 *  (cache 指标 claude 更全),意识作者不要假设字段必在。 */
export interface GhostEventTurnEndData extends GhostEventTurnStartData {
  durationMs: number;
  endReason: 'completed' | 'interrupted' | 'error';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

/** did-session-* 载荷。 */
export interface GhostEventSessionData {
  sessionId: string;
  workdir?: string;
}

/**
 * 下行:主机 → 意识的事件推送(经管子 onHostMessage 到达)。
 * did- 分支带 topic/seq(每意识单调递增,可自查漏收;dropped = 上一段
 * 熄灯期溢出丢弃数);will- 分支带 hookId,意识须在超时窗内回
 * GhostPipeEventVerdict,不回视为放行。
 */
export type GhostPipeEventPush =
  | {
      type: 'event';
      name: GhostDidEventName;
      topic: GhostSubscribeTopic;
      seq: number;
      ts: number;
      dropped?: number;
      data: GhostEventTurnStartData | GhostEventTurnEndData | GhostEventSessionData;
    }
  | {
      type: 'event';
      name: 'will-user-message';
      hookId: string;
      ts: number;
      data: { sessionId: string; text: string };
    }
  | {
      type: 'event';
      name: 'will-assistant-message';
      hookId: string;
      ts: number;
      /** text = 本轮 AI 回复全文;意识可放行/改写/自绘(见 GhostPipeEventVerdict)。 */
      data: { sessionId: string; text: string };
    }
  | {
      /** 随包 Node 进程发来的 JSON-RPC notification / MCP 进度事件。 */
      type: 'event';
      name: 'node-notification';
      method: string;
      params?: unknown;
      ts: number;
    }
  | {
      /** Node 工作进程生命周期变化；供 main.js 更新自己的卡片/面板状态。 */
      type: 'event';
      name: 'node-status';
      state: 'starting' | 'running' | 'stopped' | 'crashed';
      message?: string;
      /** 哪个入口的进程(多进程窄版;缺省 = 主入口 node.entry)。 */
      entry?: string;
      ts: number;
    }
  | {
      /**
       * 交互卡按钮点击(v2,card 槽):真实用户点了自绘卡上的 data-ghost-action
       * 元素,宿主把点击回传给意识电子脑。fire-and-forget(无 hookId/裁决)——
       * 意识自己干活(如调工具 + card-update 换新卡)。callId = 被点那张卡的
       * 归因号(主机已验该卡归属本意识);actionId = data-ghost-action 的值
       * (过 GHOST_CARD_ACTION_ID_RE)。
       */
      type: 'event';
      name: 'card-action';
      callId: string;
      actionId: string;
      /** 被点卡片所属会话；老卡可能没有归属，缺省时不能唤起 Agent。 */
      sessionId?: string;
      /**
       * 宿主为这次真实点击签发的一次性通行票。仅声明了 agent 槽且卡片有
       * 会话归属时提供；短时有效、消费一次即作废、绑定当前插件与会话。
       */
      userActionToken?: string;
      /**
       * 用户输入的文字(仅当按钮声明了 data-ghost-prompt:宿主点击时弹输入框
       * 收集,非空才带;≤ GHOST_CARD_ACTION_PROMPT_MAX_LEN)。无声明的普通
       * 按钮永远没有此字段。
       */
      prompt?: string;
      /**
       * 主机铸造的衍生卡位(`<根callId>::sp<序>`,见 GHOST_CARD_SPAWN_SEP)。
       * 对它 card-update = 原卡下方长出新卡(原卡保留,母卡按钮可反复点);
       * 对原 callId card-update = 原地换卡。推荐新结果一律画到 spawnCallId。
       */
      spawnCallId: string;
      ts: number;
    };

/**
 * 上行:意识 → 主机的钩子裁决(cindy.send)。"停下来交给你做,做完继续"的
 * 几种收尾(哪些动作合法按钩子分:will-user-message 用 allow/block/rewrite,
 * will-assistant-message 用 allow/rewrite/render——主机侧各自校验,不合法的
 * 动作按 allow 兜底):
 * - 'allow':原样放行(意识可在窗口内做纯副作用:记账/日志,不改消息);
 * - 'rewrite':放行**改写后的正文**——`text`(≤GHOST_HOOK_REWRITE_MAX_CHARS,
 *   超长截断)替换即将落库/显示的消息正文;**静默替换**(气泡直接显示改写版,
 *   无标记无弹窗),提示词优化/合规改写走这条——装入确认框已如实披露「可改写」;
 * - 'block'(仅 will-user-message):打回不继续,`reason`(≤200 字符)显示在被拦
 *   气泡的主机脚标上;
 * - 'render'(仅 will-assistant-message):自绘结果卡片替换 AI 气泡——`html`
 *   (主机净化 + 高度 clamp,规则同 card 槽海报)、`height` 初始高度估计。原文
 *   仍落库并保留"查看原文"入口(信任边界:意识盖不住 AI 实际输出)。
 * 无论哪种,窗口里意识想 await 外部接口(经 network 槽)、改写、记日志都行,
 * 主机只等它把裁决返回。整块承载 UI(脚标/身份头/查看原文)主机绘制,意识
 * 只供 text/reason/html。
 */
export interface GhostPipeEventVerdict {
  type: 'event-verdict';
  hookId: string;
  action: 'allow' | 'block' | 'rewrite' | 'render';
  /** block 时展示的理由。 */
  reason?: string;
  /** rewrite 时的新正文(替换消息正文;其它 action 忽略)。 */
  text?: string;
  /** render 时的自绘卡片 HTML(主机净化;其它 action 忽略)。 */
  html?: string;
  /** render 时的卡片初始高度估计(主机 clamp;缺省用 card 槽默认)。 */
  height?: number;
}

/* ── network 槽:代理 fetch 协议(2026-07-12)──────────────────────────
 * 意识 cindy.send({type:'fetch-request',…}) → 主机白名单校验 + 凭证注入 +
 * 真实 HTTP → invoke resolve 值即 GhostPipeFetchResult。硬边界都在主机侧
 * 代码强制(规则 9),常量在此与手册/校验共用一份。 */

/** 代理 fetch 允许的方法(REST 查询/提交/删除;body 仍仅 POST 允许)。 */
// PUT / PATCH 于 2026-07-13 随 oauth 凭证形态一并放行(Google Calendar 更新、
// Sheets 写入、Jira / Confluence 更新全是 PUT/PATCH;风险面与 POST 同档)。
export const GHOST_FETCH_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type GhostFetchMethod = (typeof GHOST_FETCH_METHODS)[number];

/** 请求体上限(UTF-8 字节)。 */
export const GHOST_FETCH_BODY_MAX_BYTES = 256 * 1024;
/** 响应体上限(超限截断并标 truncated;2026-07-21 由 1MB 放宽到 50MB,Jira 等大 JSON 不再被截)。 */
export const GHOST_FETCH_RESPONSE_MAX_BYTES = 50 * 1024 * 1024;
/** 超时缺省/下限/上限(毫秒;越界 clamp 不拒单)。 */
export const GHOST_FETCH_TIMEOUT_DEFAULT_MS = 30_000;
export const GHOST_FETCH_TIMEOUT_MIN_MS = 1_000;
export const GHOST_FETCH_TIMEOUT_MAX_MS = 60_000;
/** 每意识在途代发请求硬顶(常量,不做配置项——防死循环刷单,非配额)。 */
export const GHOST_FETCH_INFLIGHT_LIMIT = 4;

/* ── 媒体模式(as:'media',mivo 迁移地基):字节不进沙箱 ──────────────
 * 意识声明"这个响应是媒体":主机把 2xx 的受支持媒体字节直接落 cindy-media
 * 总仓、记到该意识名下(ghost-gallery 引用,与 cindy 槽产物同等待遇),
 * resolve 只回取件地址——沙箱全程摸不到媒体字节,比"递进去再交回来"更省
 * 也更安全。非 2xx / 文本类响应自动回落文本形态(错误 JSON 意识看得到)。 */

/** 媒体响应字节硬顶(超限整单拒,不截断——截断的媒体是坏文件)。 */
export const GHOST_FETCH_MEDIA_MAX_BYTES = 256 * 1024 * 1024;
/** 媒体模式的超时缺省/上限(毫秒;下限与文本模式共用 GHOST_FETCH_TIMEOUT_MIN_MS)。 */
export const GHOST_FETCH_MEDIA_TIMEOUT_DEFAULT_MS = 120_000;
export const GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS = 300_000;
/** 媒体入账备注(画廊 caption)长度上限。 */
export const GHOST_FETCH_LABEL_MAX_CHARS = 200;

/* ── 上传通道(upload,媒体模式的镜像):字节不进沙箱 ──────────────────
 * 意识把"自己名下"的总仓媒体上传给白名单服务(mivo 改图/图生视频的源图):
 * 请求里只报指纹,主机查账验归属(出生自它 / 挂它画廊 / 用户显式过户)、
 * 读 blob、代组 multipart/form-data 出网——沙箱全程摸不到媒体字节。 */

/** 上传:单次最多文件数。 */
export const GHOST_FETCH_UPLOAD_MAX_FILES = 4;
/** 上传:单文件字节上限(3D 模型可到几十 MB,给足;超限整单拒)。 */
export const GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE = 64 * 1024 * 1024;
/** 上传:单次总字节上限(multipart 体整体驻内存组装,必须封顶)。 */
export const GHOST_FETCH_UPLOAD_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** 上传:multipart 字段名形状(缺省 'file')。 */
export const GHOST_FETCH_UPLOAD_FIELD_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 总仓指纹形状(64 位十六进制,与 blobStore 同口径)。 */
export const GHOST_MEDIA_HASH_RE = /^[a-f0-9]{64}$/;

/* ── 目录上传(uploadDir,xd-service 意识化二期):字节与路径都不进沙箱 ──
 * 意识把"用户 / 主 agent 显式过户"的本地目录整体上传给白名单服务(静态
 * 站点部署等):主 agent 在 ghost_call 顶层传 dir(绝对路径,主机钳制在
 * 会话 workdir 内)→ 主机收集文件、发一次性票据(token)注入 args.dir_deposit
 * → 意识 fetch-request 只报 token,主机凭票读盘、代组 multipart 出网。
 * 意识永远拿不到绝对路径与文件字节,也无法自造票据指向任意目录。 */

/** 目录上传:单目录最多文件数(静态站点构建产物量级)。 */
export const GHOST_FETCH_DIR_UPLOAD_MAX_FILES = 500;
/** 目录上传:单文件字节上限。 */
export const GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
/** 目录上传:单次总字节上限(multipart 体整体驻内存组装,必须封顶)。 */
export const GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** 目录上传:随行普通表单字段条数上限。 */
export const GHOST_FETCH_DIR_UPLOAD_MAX_FIELDS = 8;
/** 目录上传:普通表单字段值长度上限(字符)。 */
export const GHOST_FETCH_DIR_UPLOAD_FIELD_VALUE_MAX_CHARS = 2048;
/** 目录过户票据形状(主机 randomUUID 发放)。 */
export const GHOST_DIR_DEPOSIT_TOKEN_RE = /^[a-f0-9-]{36}$/;
/** 目录过户票据有效期(毫秒;过期未消费自动作废)。 */
export const GHOST_DIR_DEPOSIT_TTL_MS = 10 * 60_000;

/**
 * 下行落盘(save 票据,2026-07-13,google/conf/jira 意识化「附件下载不降级」):
 * 主 agent 经 ghost_call 顶层 save_dir 过户一个 workdir 内的可写目录 →
 * 主机发限时票据注入 args.save_deposit → 意识 fetch({as:'file', saveTo})
 * 时主机把响应字节直接写进该目录——字节与绝对路径都不进沙箱,意识只拿到
 * 落盘后的文件名。与 dirDeposit(上行读)同一"显式交付"哲学的镜像。
 */
/** 下行票据有效期(毫秒)。 */
export const GHOST_SAVE_DEPOSIT_TTL_MS = 10 * 60_000;
/** 单张下行票据最多写入的文件数(一次 ghost_call 内多附件下载够用)。 */
export const GHOST_SAVE_DEPOSIT_MAX_USES = 16;
/** 单张下行票据的累计写入字节上限。 */
export const GHOST_SAVE_DEPOSIT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** 单文件下行体积上限(与媒体取件同档;超限整单拒不截断——截断文件是坏文件)。 */
export const GHOST_FETCH_FILE_MAX_BYTES = 256 * 1024 * 1024;
/** 意识建议文件名的长度上限(超限拒;消毒后仍以主机为准)。 */
export const GHOST_FETCH_FILE_NAME_MAX_CHARS = 128;

/* ── fs 槽(写文件,2026-07-14):字节由主机代写,沙箱仍零 fs ──────────
 * 意识 cindy.send({type:'fs-request', op, root, …}) → 资格审(声明了 'fs'
 * 卡槽?)→ 按 root 分档守门 → 主机代写/代读 → 结构化 GhostPipeFsResult。
 * 三个 root:
 * - 'data'    私有数据目录(userData/ghost-fs/<ghostId>);全 op,免确认,
 *             配额封顶,卸载随包回收。老 MCP out_file 泄洪的意识世界等价物。
 * - 'workdir' 当前会话工作目录;仅 write,须带 callId(反查 session),
 *             跟随会话 permission 模式(见 fsSlot 的映射表),远程工作区拒。
 * - 'save'    主 agent 过户的 save 票据目录;仅 write,复用 saveDeposit
 *             的 TTL/次数/字节预算与文件名消毒(与 as:'file' 下载同一本账)。
 */
export const GHOST_FS_ROOTS = ['data', 'workdir', 'save'] as const;
export type GhostFsRoot = (typeof GHOST_FS_ROOTS)[number];
export const GHOST_FS_OPS = ['write', 'read', 'list', 'delete'] as const;
export type GhostFsOp = (typeof GHOST_FS_OPS)[number];

/** fs 相对路径总长上限(字符;分段规则同 isSafeGhostRelativePath)。 */
export const GHOST_FS_PATH_MAX_CHARS = 256;
/** 单次写入内容上限(解码后字节;超限整单拒——大数据请分文件)。 */
export const GHOST_FS_WRITE_MAX_BYTES = 16 * 1024 * 1024;
/** 单次读取上限(解码前字节;超限拒,提示分文件存)。 */
export const GHOST_FS_READ_MAX_BYTES = 16 * 1024 * 1024;
/** 私有数据目录:累计字节配额(超限写拒,提示自行删旧文件)。 */
export const GHOST_FS_DATA_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** 私有数据目录:文件数配额。 */
export const GHOST_FS_DATA_MAX_FILES = 2000;
/** list 返回条数上限(超出截断并标 truncated)。 */
export const GHOST_FS_LIST_MAX_ENTRIES = 2000;

/** 上行:fs 槽写文件请求。 */
export interface GhostPipeFsRequest {
  type: 'fs-request';
  /** 操作:write=创建/覆盖,read/list/delete 仅 root:'data'。 */
  op: GhostFsOp;
  /** 目的地档位(见上方注释)。 */
  root: GhostFsRoot;
  /**
   * 相对路径(`a/b/c.ext` 形态,规则同 isSafeGhostRelativePath:正斜杠分段、
   * 无 `.`/`..`、段首不许点——写不了 .git 等隐藏目录是刻意的)。write/read/
   * delete 必填;list 可选(缺省列根)。root:'save' 时仅取 basename 语义
   * (票据目录不展开子目录),并经主机消毒去重。
   */
  path?: string;
  /** 写入内容(write 必填;encoding:'base64' 时为 base64 文本,否则 UTF-8)。 */
  content?: string;
  /** 内容编码(write 的入参编码 / read 的期望返回编码);缺省 'utf8'。 */
  encoding?: 'utf8' | 'base64';
  /** save 票据(root:'save' 必填;来自 ghost_call 顶层 save_dir 过户)。 */
  token?: string;
  /** 归因号(root:'workdir' 必填:主机凭它反查 session 与权限;其余可选)。 */
  callId?: string;
}

/** fs 槽 list 的单条目(路径相对本意识私有目录根)。 */
export interface GhostFsListEntry {
  path: string;
  bytes: number;
  /** 最后修改时间(unix ms)。 */
  mtime: number;
}

/** 代写文件的返回(cindy.send 的 resolve 值;失败带人话原因,永不 reject)。 */
export type GhostPipeFsResult =
  | { ok: true; op: 'write'; /** 落盘后的相对路径(save 档为消毒去重后的文件名)。 */ path: string; bytes: number }
  | { ok: true; op: 'read'; path: string; content: string; encoding: 'utf8' | 'base64'; bytes: number }
  | { ok: true; op: 'list'; entries: GhostFsListEntry[]; truncated?: boolean }
  | { ok: true; op: 'delete'; path: string; /** false = 本来就不存在(幂等)。 */ existed: boolean }
  | { ok: false; message: string };

/** 上行:network 槽代理 fetch 请求。 */
export interface GhostPipeFetchRequest {
  type: 'fetch-request';
  /** 目标地址:仅 https、默认端口,host 必须命中 network.hosts 白名单。 */
  url: string;
  /** 缺省 GET。 */
  method?: GhostFetchMethod;
  /**
   * 意识自带请求头(如 Content-Type / Accept)。协议关键头与凭证类头
   * 由主机剥除后再注入声明的凭证——意识写了也不生效,不算错误。
   */
  headers?: Record<string, string>;
  /** 请求体(文本;仅 POST / PUT / PATCH / DELETE;≤ GHOST_FETCH_BODY_MAX_BYTES;与 upload 互斥)。 */
  body?: string;
  /**
   * 上传通道(仅 POST;与 body 互斥):把本意识名下的总仓媒体以
   * multipart/form-data 上传给目标——只报指纹,主机验归属、读字节、代组
   * 请求体,Content-Type(boundary)由主机独占。hashes 1–4 条(64 位
   * 十六进制指纹);field 为每个文件的表单字段名,缺省 'file';fields 为
   * 随行普通表单字段(在文件段之前;值里的字面量 "{bytes}" 由主机替换成
   * 全部上传文件的总字节数——飞书 upload_all 这类要求 size 字段的服务用,
   * 2026-07-16 lizi_feishu 意识化前置)。
   */
  upload?: { hashes: string[]; field?: string; fields?: Record<string, string> };
  /**
   * 目录上传通道(仅 POST;与 body / upload 互斥):把主机过户票据指向的
   * 本地目录整体以 multipart/form-data 上传——token 来自 ghost_call 顶层
   * dir 参数过户后注入的 args.dir_deposit.token(一次性、限本意识、限时);
   * fields 为随行普通表单字段(如 name / preset;值里的字面量 "{bytes}"
   * 由主机替换成全部上传文件的总字节数);fileFieldPrefix 为文件字段名前缀
   * (缺省 'file-',第 N 个文件字段名 `file-N`,filename=相对路径);
   * fileField 为单文件精确字段名(与 fileFieldPrefix 互斥,票据必须恰含
   * 1 个文件,filename=文件名不含目录——飞书 im 文件上传这类"字段名钉死
   * file"的服务用,2026-07-16)。
   */
  uploadDir?: {
    token: string;
    fields?: Record<string, string>;
    fileFieldPrefix?: string;
    fileField?: string;
  };
  /** 超时毫秒(clamp 到 [MIN, MAX];媒体模式与上传用 MEDIA_* 档;缺省各自 DEFAULT)。 */
  timeoutMs?: number;
  /**
   * 响应处理模式:'text'(缺省)= 文本回沙箱;'media' = 受支持的媒体字节由
   * 主机落总仓记账,只回取件地址(见 GHOST_FETCH_MEDIA_* 常量);'file' =
   * 任意类型字节由主机直接写进 save 票据指向的 workdir 目录(须同时传
   * saveTo;字节不进沙箱也不进总仓,见 GHOST_SAVE_DEPOSIT_* 常量)。
   */
  as?: 'text' | 'media' | 'file';
  /**
   * 下行落盘票据(仅 as:'file',必填):token 来自 ghost_call 顶层 save_dir
   * 过户后注入的 args.save_deposit.token;filename 为建议文件名(可选,主机
   * 消毒并防覆盖去重;缺省从 Content-Disposition / URL 派生)。
   */
  saveTo?: { token: string; filename?: string };
  /** 媒体入账备注(画廊 caption;仅媒体模式消费,≤GHOST_FETCH_LABEL_MAX_CHARS)。 */
  label?: string;
  /**
   * OAuth 多账号选择(仅对 source:'oauth' 的凭证生效):指定用哪个已连接
   * 账号的令牌注入(账号 id 来自 /oauth 端点的账号清单);缺省 = 默认账号。
   * 非 oauth 凭证忽略本字段。
   */
  authAccount?: string;
  /** 归因号(同 cindy-request:tool-call 的 callId 原样带上,日志对账)。 */
  callId?: string;
}

/** 代理 fetch 的返回(cindy.send 的 resolve 值)。 */
export type GhostPipeFetchResult =
  | {
      ok: true;
      /** HTTP 状态码(4xx/5xx 也走 ok:true——那是"代发成功,对方说不行")。 */
      status: number;
      /** 响应头(主机过滤后的白名单字段,如 content-type)。 */
      headers: Record<string, string>;
      /** 响应体文本(≤ GHOST_FETCH_RESPONSE_MAX_BYTES,超限截断)。 */
      body: string;
      /** body 被截断时为 true。 */
      truncated?: boolean;
    }
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      /**
       * 媒体模式取件单(as:'media' 且响应为受支持媒体):字节已落总仓、
       * 记在本意识名下——url 聊天/面板皆可渲染,hash 可作改图源图/面板取件。
       */
      media: { url: string; hash: string; ext: string; bytes: number };
    }
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      /**
       * 下行落盘回执(as:'file' 且 2xx):字节已写进 save 票据指向的目录。
       * file_name 是消毒去重后的最终文件名(相对该目录);dir_name 是过户时
       * 注入 args.save_deposit 的目录名,拼给用户看用。
       */
      file: { file_name: string; bytes: number; mime_type: string };
    }
  | { ok: false; message: string };

/** 工具调用的结构化失败分类(与 cindy-tools 的 CindyGhostCallErrorCode 同构)。 */
export type GhostToolCallErrorCode =
  | 'GHOST_NOT_FOUND'
  | 'GHOST_ASLEEP'
  | 'GHOST_DISABLED_IN_WORKDIR'
  | 'TOOL_NOT_FOUND'
  | 'GHOST_CRASHED'
  | 'TIMEOUT'
  | 'ATTACHMENT_INVALID'
  | 'DIR_INVALID'
  | 'INTERNAL';

/** 主机错误码不能被插件结果覆盖；其余格式合法的码作为业务错误码透传。 */
const GHOST_HOST_ERROR_CODES: ReadonlySet<string> = new Set([
  'GHOST_NOT_FOUND',
  'GHOST_ASLEEP',
  'GHOST_DISABLED_IN_WORKDIR',
  'TOOL_NOT_FOUND',
  'GHOST_CRASHED',
  'TIMEOUT',
  'ATTACHMENT_INVALID',
  'DIR_INVALID',
  'INTERNAL',
]);

export function isGhostPluginErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(value) &&
    !GHOST_HOST_ERROR_CODES.has(value)
  );
}

/** 工具调用结果(主机侧;ghost 总机 MCP 原样透传给 agent)。 */
export type GhostToolCallResult =
  | { ok: true; result: unknown }
  | { ok: false; errorCode: GhostToolCallErrorCode | (string & {}); message: string };

/**
 * ghost_call 的工具全名。两套 agent 的 MCP toolName 形态不同:
 * Claude Code 是 `mcp__<server>__<tool>`,Codex translator 组装成
 * `mcp:<server>:<tool>`(见 maker-core codex/translator.ts handleMcpToolCall),
 * 两种都要认——漏了 Codex 形态时,Codex 会话的意识召唤行/意识卡全部退化成
 * 通用 MCP 行「cindy · ghost call」。2026-07-12 server 由 'cindy_ghosts'
 * 更名 'cindy'(调用名更短);旧名保留用于匹配改名前持久化的历史消息
 * (召唤行/已召唤卡对老会话不失效)。
 */
export const GHOST_CALL_TOOL_NAMES: readonly string[] = [
  'mcp__cindy__ghost_call',
  'mcp__cindy_ghosts__ghost_call',
  'mcp:cindy:ghost_call',
  'mcp:cindy_ghosts:ghost_call',
];

/** toolName 是否是 ghost_call(兼容新旧 server 名)。 */
export function isGhostCallToolName(name: string | undefined | null): boolean {
  return typeof name === 'string' && GHOST_CALL_TOOL_NAMES.includes(name);
}
