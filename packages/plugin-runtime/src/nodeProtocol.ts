import { parsePluginAuthorizationRequest, type PluginAuthorizationRequest, type PluginAuthorizationResult } from '@cindy/device-link';

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
  | { type: 'plugin-authorize'; reqId: string; rpcId: string; request: PluginAuthorizationRequest }
  | { type: 'device-authorize'; reqId: string; rpcId: string; url: string }
  | { type: 'spawn-child'; reqId: string; entry: string; args?: string[]; rpcId?: string }
  | { type: 'child-stdin'; childId: string; b64: string }
  | { type: 'child-stdin-end'; childId: string }
  | { type: 'child-kill'; childId: string };

/** 主机 → worker:代启结果/子进程输出/退出。 */
export type GhostNodeChildToWorkerMessage =
  | { type: 'plugin-authorize-result'; reqId: string; ok: boolean; result?: PluginAuthorizationResult }
  | { type: 'device-authorize-result'; reqId: string; ok: boolean }
  | { type: 'spawn-child-result'; reqId: string; ok: true; childId: string; pid?: number }
  | { type: 'spawn-child-result'; reqId: string; ok: false; message: string }
  | { type: 'child-stdout'; childId: string; b64: string }
  | { type: 'child-stderr'; childId: string; b64: string }
  | { type: 'child-exit'; childId: string; code: number | null };

function isChildId(v: unknown): v is string {
  return typeof v === 'string' && GHOST_NODE_CHILD_ID_RE.test(v);
}

/** worker → 主机控制帧的形状校验(主机侧守门用;不合形一律静默丢)。 */
export function parseGhostNodeChildToHostMessage(raw: unknown): GhostNodeChildToHostMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type === 'plugin-authorize') {
    if (Object.keys(m).sort().join(',') !== 'reqId,request,rpcId,type'
      || !isChildId(m.reqId) || typeof m.rpcId !== 'string' || !/^\d{1,16}$/.test(m.rpcId)) return null;
    try { return { type: m.type, reqId: m.reqId, rpcId: m.rpcId, request: parsePluginAuthorizationRequest(m.request) }; }
    catch { return null; }
  }
  if (m.type === 'device-authorize') {
    if (
      Object.keys(m).sort().join(',') !== 'reqId,rpcId,type,url' ||
      !isChildId(m.reqId) ||
      typeof m.rpcId !== 'string' ||
      !/^\d{1,16}$/.test(m.rpcId) ||
      typeof m.url !== 'string' ||
      m.url.length > 8192
    )
      return null;
    return { type: 'device-authorize', reqId: m.reqId, rpcId: m.rpcId, url: m.url };
  }
  if (m.type === 'spawn-child') {
    if (!isChildId(m.reqId) || typeof m.entry !== 'string') return null;
    if (m.rpcId !== undefined && (typeof m.rpcId !== 'string' || !/^\d{1,16}$/.test(m.rpcId))) return null;
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
      ...(typeof m.rpcId === 'string' ? { rpcId: m.rpcId } : {}),
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


/** 插件随包本地 Node 工作进程使用的 stdio 协议。 */
export const GHOST_NODE_PROTOCOLS = ['json-rpc-stdio', 'mcp-stdio'] as const;
export type GhostNodeProtocol = (typeof GHOST_NODE_PROTOCOLS)[number];

/** Node 工作进程生命周期；常驻档会在插件详情中单列高风险能力。 */
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
  /** 引用本插件 network.secrets 中的 OAuth key；仅注入短期 access token。 */
  oauthSecret?: string;
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
 * Host 只按已支持的包内入口和固定协议启动进程；未知的 command / args / shell /
 * env 等扩展仅保留为数据，不传入进程启动参数。Node 进程拥有当前系统用户级本机权限，主机
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
   * 那条路生出来的不是 Node。默认关;开了会在插件详情单列一行。
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


export type GhostPipeNodeResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      errorCode:
        | 'CANCELLED'
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


export const GHOST_NODE_REQUEST_MAX_TOTAL_MS = 15 * 60_000;
