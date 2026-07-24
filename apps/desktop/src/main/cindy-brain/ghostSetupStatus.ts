/**
 * ghostSetupStatus —— 意识配置就绪判定(使用前置检查的纯函数层)。
 *
 * 用户在插件页点「使用」时,宿主据清单推导「用之前必须配好什么」并逐项
 * 核对现有存储(ghosts:setup-status IPC 的判定真身)。全部是确定性代码
 * 判定(规则 9),不唤醒沙箱、不让意识自检:
 * - 有 setup 声明 → 按声明逐组判定(组间 allOf,组内 anyOf);
 * - 无 setup 声明 → 启发式:声明过凭证(user / oauth 源)或连接的意识,
 *   任一项就绪即 ready;什么都没声明的恒 ready。现有内置意识全部被启发式
 *   正确覆盖(Web Search 任一 key、GitLab 一条连接、Google 一个账号……),
 *   setup 字段只在启发式判不准时才需要作者写。
 *
 * 分项就绪口径(探针由 index.ts 注入,测试喂假体;全部同步、毫秒级):
 * - user 源凭证:保险库已保存(等价 /secrets GET 的 saved);
 * - oauth 源凭证:client 可用(自填或内置)且 ≥1 个 connected 账号;
 *   账号存在但全部 expired 时归入 reauth(弹窗文案区分「重新连接」);
 * - login-email 源凭证:恒就绪(登录派生,无配置动作;校验层已禁止
 *   setup 引用,启发式也不将其计入需求);
 * - 连接:该声明键下至少一条连接;
 * - kv 参数:意识 /kv 文件顶层键非空(undefined / null / 空白字符串算
 *   未配置;false / 0 等有值形态算已配置——存在性检查,不做语义校验)。
 *
 * 边界:本判定只管「存在性」。key 是否有效、账号权限是否够,由运行期
 * networkSlot 出网时 fail-fast 兜底,不在点击时预检(那需要真发网络请求)。
 */

import type {
  GhostManifest,
  GhostSetupRequirement,
  GhostSetupStatus,
  GhostSetupStatusItem,
} from '../../shared/ghost.js';
import { isValidGhostId } from '../../shared/ghost.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** OAuth 凭证的分项状态(index.ts 由 GhostOauthAccountManager 现查)。 */
export interface GhostSetupOauthProbe {
  /** client 可用 = 用户自填或清单内置任一在场(与 /oauth 端点同口径)。 */
  clientConfigured: boolean;
  /** status === 'connected' 的账号数。 */
  connected: number;
  /** status === 'expired' 的账号数。 */
  expired: number;
}

/** 判定探针最小面(生产由 index.ts 接各存储真身;测试喂内存假体)。 */
export interface GhostSetupProbes {
  /** user 源凭证是否已入库(保险库存在性,不解密)。 */
  secretSaved(key: string): boolean;
  /** oauth 源凭证的 client / 账号状态。 */
  oauthStatus(key: string): GhostSetupOauthProbe;
  /** 该连接声明键下已添加的连接条数。 */
  connectionCount(key: string): number;
  /** 意识 /kv 顶层键的当前值(无文件 / 无键 → undefined)。 */
  kvValue(key: string): unknown;
}

/** 单条需求的判定结果(内部中间态)。 */
type ItemVerdict = 'satisfied' | 'missing' | 'reauth';

/** kv 值的「已配置」口径:undefined / null / 空白字符串算未配置。 */
function kvValueConfigured(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * 从清单推导需求组:有 setup 按声明;无 setup 走启发式(全部凭证/连接
 * 合成一个 anyOf 大组;空需求 → 空数组 = 恒就绪)。
 */
function deriveRequirementGroups(manifest: GhostManifest): GhostSetupRequirement[][] {
  if (manifest.setup) {
    return manifest.setup.requires.map((group) => group.anyOf);
  }
  const implicit: GhostSetupRequirement[] = [];
  for (const s of manifest.network?.secrets ?? []) {
    if (s.source === 'login-email') continue; // 登录派生恒就绪,不构成配置需求
    implicit.push({ kind: 'secret', key: s.key });
  }
  for (const s of manifest.node?.secretBindings ?? []) {
    implicit.push({ kind: 'secret', key: s.key });
  }
  for (const c of manifest.network?.connections ?? []) {
    implicit.push({ kind: 'connection', key: c.key });
  }
  return implicit.length > 0 ? [implicit] : [];
}

/** 需求条目 → 展示项(label 取声明原文;kind 决定弹窗文案口径)。 */
function toStatusItem(manifest: GhostManifest, req: GhostSetupRequirement): GhostSetupStatusItem {
  if (req.kind === 'kv') {
    return { ref: `kv:${req.key}`, label: req.label, kind: 'kv' };
  }
  if (req.kind === 'connection') {
    const decl = manifest.network?.connections?.find((c) => c.key === req.key);
    return { ref: `connection:${req.key}`, label: decl?.label ?? req.key, kind: 'connection' };
  }
  const decl = manifest.network?.secrets?.find((s) => s.key === req.key);
  const nodeDecl = manifest.node?.secretBindings?.find((s) => s.key === req.key);
  return {
    ref: `secret:${req.key}`,
    label: decl?.label ?? nodeDecl?.label ?? req.key,
    kind: decl?.source === 'oauth' ? 'oauth' : 'key',
  };
}

function verdictOf(manifest: GhostManifest, req: GhostSetupRequirement, probes: GhostSetupProbes): ItemVerdict {
  if (req.kind === 'kv') {
    return kvValueConfigured(probes.kvValue(req.key)) ? 'satisfied' : 'missing';
  }
  if (req.kind === 'connection') {
    return probes.connectionCount(req.key) > 0 ? 'satisfied' : 'missing';
  }
  const decl = manifest.network?.secrets?.find((s) => s.key === req.key);
  const nodeDecl = manifest.node?.secretBindings?.find((s) => s.key === req.key);
  // 清单漂移防御(setup 引用在校验期保证存在,这里只可能是运行期清单被
  // 换过):查无声明按已就绪放行,交给运行期 networkSlot 兜底,不误拦。
  if (!decl && !nodeDecl) return 'satisfied';
  if (nodeDecl) return probes.secretSaved(req.key) ? 'satisfied' : 'missing';
  if (!decl) return 'satisfied';
  if (decl.source === 'login-email') return 'satisfied';
  if (decl.source === 'oauth') {
    const st = probes.oauthStatus(req.key);
    if (st.clientConfigured && st.connected > 0) return 'satisfied';
    // 账号存在但全部过期:配置动作是「重新连接」,与「从未配置」分开报。
    if (st.clientConfigured && st.expired > 0) return 'reauth';
    return 'missing';
  }
  return probes.secretSaved(req.key) ? 'satisfied' : 'missing';
}

/**
 * 判定一段意识的配置就绪状态。纯函数:清单 + 探针进,状态出;探针全同步
 * (底层是文件存在性 / 内存清单读取),点击时现查、不缓存。
 */
export function evaluateGhostSetup(manifest: GhostManifest, probes: GhostSetupProbes): GhostSetupStatus {
  const groups = deriveRequirementGroups(manifest);
  const missingGroups: GhostSetupStatusItem[][] = [];
  const reauth: GhostSetupStatusItem[] = [];
  const seenReauthRefs = new Set<string>();

  for (const group of groups) {
    const verdicts = group.map((req) => verdictOf(manifest, req, probes));
    if (verdicts.includes('satisfied')) continue;
    // 组未满足:reauth 条目单列(修复动作不同),其余进缺失清单;
    // 纯 reauth 组不产生 missing 组(弹窗只提「重新连接」)。
    const missingItems: GhostSetupStatusItem[] = [];
    group.forEach((req, i) => {
      const item = toStatusItem(manifest, req);
      if (verdicts[i] === 'reauth') {
        if (!seenReauthRefs.has(item.ref)) {
          seenReauthRefs.add(item.ref);
          reauth.push(item);
        }
      } else {
        missingItems.push(item);
      }
    });
    if (missingItems.length > 0) missingGroups.push(missingItems);
  }

  const ready = missingGroups.length === 0 && reauth.length === 0;
  return { ready, missingGroups: ready ? [] : missingGroups, reauth: ready ? [] : reauth };
}

/**
 * ghosts:setup-status 的 handler 主体(规则 14:抽成可注入依赖的函数,
 * `ipcMain.handle` 只做 adapter,测试用内存 harness 直接 invoke)。
 * 错误路径:id 形态非法 INVALID_PARAMS、未安装 NOT_FOUND;探针意外抛错
 * **有意不在此捕获**——让 invoke 直接 reject,renderer 侧 catch 后放行
 * (fail-open),绝不把「查询失败」折叠成「未配置」去误拦用户。
 */
export function handleGhostSetupStatusRequest(args: {
  id: unknown;
  /** 现查在装清单并返回运行时清单(oauth 内置 client 已注入);未装 null。 */
  getRuntimeManifest: (id: string) => GhostManifest | null;
  /** 按清单构造探针(index.ts 接各存储真身;测试喂假体)。 */
  probesFor: (manifest: GhostManifest) => GhostSetupProbes;
}): GhostSetupStatus {
  const { id } = args;
  if (typeof id !== 'string' || !isValidGhostId(id)) {
    throwIpcError('INVALID_PARAMS', 'id must be a valid Ghost id');
  }
  const manifest = args.getRuntimeManifest(id);
  if (!manifest) throwIpcError('NOT_FOUND', `意识 ${id} 未安装`);
  return evaluateGhostSetup(manifest, args.probesFor(manifest));
}
