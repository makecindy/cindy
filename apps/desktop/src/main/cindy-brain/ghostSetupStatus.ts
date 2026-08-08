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
 * - login-email / gh-cli / oidc-token 源凭证:Host 派生或优先复用宿主能力,
 *   没有可靠的同步用户配置判定；校验层禁止 setup 引用，启发式也不把
 *   它们伪装成待填写 Secret;
 * - 连接:该声明键下至少一条连接;
 * - kv 参数:意识 /kv 文件顶层键非空(undefined / null / 空白字符串算
 *   未配置;false / 0 等有值形态算已配置——存在性检查,不做语义校验)。
 *
 * 边界:本判定只管「存在性」。key 是否有效、账号权限是否够,由运行期
 * networkSlot 出网时 fail-fast 兜底,不在点击时预检(那需要真发网络请求)。
 */

import { createHash } from 'node:crypto';

import type {
  GhostManifest,
  GhostSetupActionKind,
  GhostSetupAssessment,
  GhostSetupAssessmentGroup,
  GhostSetupAssessmentItem,
  GhostSetupRequirement,
  GhostSetupStatus,
  GhostSetupStatusItem,
} from '../../shared/ghost.js';
import { GHOST_SECRET_VALUE_MAX_CHARS, isValidGhostId } from '../../shared/ghost.js';
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
type ItemVerdict = 'satisfied' | 'missing' | 'expired';

export interface EvaluateGhostSetupOptions {
  /** Host 变更总线的当前 revision；纯判定层不自行维护时钟。 */
  revision: number;
  /** Host 内配置（例如图片 Provider）形成的虚拟需求组。 */
  additionalGroups?: GhostSetupAssessmentGroup[];
  /**
   * 运行时 gate 必须严格拒绝 manifest 漂移；旧插件页投影为兼容历史
   * fail-open 行为可传 false。
   */
  strict?: boolean;
}

export class GhostSetupAssessmentError extends Error {
  readonly code = 'INVALID_SETUP_REQUIREMENT';

  constructor(message: string) {
    super(message);
    this.name = 'GhostSetupAssessmentError';
  }
}

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
    if (s.source === 'login-email' || s.source === 'gh-cli' || s.source === 'oidc-token') continue;
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
export function requirementRef(req: GhostSetupRequirement): string {
  return `${req.kind}:${req.key}`;
}

/**
 * oauth_connect 动作 id 的唯一编解码对:actionFor 与 reauthSuggest 生产、
 * executeGhostSetupAction 反解共用。改动作 id 格式只能改这两个函数,
 * 任何一侧散落的字面量都会造成"点重连拿 ACTION_STALE"的静默失配。
 */
export function oauthConnectActionId(ref: string): string {
  return `oauth_connect:${ref}`;
}

export function parseOauthConnectSecretKey(actionId: string): string | null {
  const prefix = oauthConnectActionId('secret:');
  const key = actionId.startsWith(prefix) ? actionId.slice(prefix.length) : '';
  return key.length > 0 ? key : null;
}

function actionFor(
  kind: GhostSetupAssessmentItem['kind'],
  ref: string,
  options?: { oauthClientConfigured?: boolean },
): GhostSetupAssessmentItem['actions'] {
  const actionKind: Exclude<GhostSetupActionKind, 'inline_form'> =
    kind === 'oauth'
      ? options?.oauthClientConfigured
        ? 'oauth_connect'
        : 'open_plugin_settings'
      : kind === 'connection'
        ? 'manage_connection'
        : kind === 'client_config'
          ? 'open_client_settings'
          : 'open_plugin_settings';
  return [
    {
      id: actionKind === 'oauth_connect' ? oauthConnectActionId(ref) : `${actionKind}:${ref}`,
      kind: actionKind,
    },
  ];
}

function inlineSecretAction(
  manifest: GhostManifest,
  ref: string,
  label: string,
  hint?: string,
  url?: string,
): GhostSetupAssessmentItem['actions'] {
  const opaqueId = createHash('sha256')
    .update(manifest.id)
    .update('\0')
    .update(ref)
    .digest('hex')
    .slice(0, 24);
  return [
    {
      id: `inline_form:${opaqueId}`,
      kind: 'inline_form',
      form: {
        fields: [
          {
            id: 'value',
            type: 'secret',
            label,
            ...(hint ? { description: hint } : {}),
            ...(url ? { externalLink: { url } } : {}),
            required: true,
            maxLength: GHOST_SECRET_VALUE_MAX_CHARS,
          },
        ],
      },
    },
  ];
}

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

function verdictOf(
  manifest: GhostManifest,
  req: GhostSetupRequirement,
  probes: GhostSetupProbes,
  strict: boolean,
): ItemVerdict {
  if (req.kind === 'kv') {
    if (strict && !manifest.settingsHtml) {
      throw new GhostSetupAssessmentError(
        `setup requirement ${requirementRef(req)} has no settingsHtml`,
      );
    }
    return kvValueConfigured(probes.kvValue(req.key)) ? 'satisfied' : 'missing';
  }
  if (req.kind === 'connection') {
    const declared = manifest.network?.connections?.some(
      (connection) => connection.key === req.key,
    );
    if (strict && !declared) {
      throw new GhostSetupAssessmentError(
        `setup requirement ${requirementRef(req)} is not declared`,
      );
    }
    return probes.connectionCount(req.key) > 0 ? 'satisfied' : 'missing';
  }
  const decl = manifest.network?.secrets?.find((s) => s.key === req.key);
  const nodeDecl = manifest.node?.secretBindings?.find((s) => s.key === req.key);
  // 旧插件页保留 fail-open；真正 ghost_call gate 用 strict=true，避免
  // manifest 更新竞态把失效引用误判为已就绪。
  if (!decl && !nodeDecl) {
    if (strict) {
      throw new GhostSetupAssessmentError(
        `setup requirement ${requirementRef(req)} is not declared`,
      );
    }
    return 'satisfied';
  }
  if (nodeDecl) return probes.secretSaved(req.key) ? 'satisfied' : 'missing';
  if (!decl) return 'satisfied';
  if (decl.source === 'login-email' || decl.source === 'gh-cli' || decl.source === 'oidc-token') {
    if (strict) {
      throw new GhostSetupAssessmentError(
        `setup requirement ${requirementRef(req)} cannot use a Host-derived secret`,
      );
    }
    return 'satisfied';
  }
  if (decl.source === 'oauth') {
    const st = probes.oauthStatus(req.key);
    if (st.clientConfigured && st.connected > 0) return 'satisfied';
    // 账号存在但全部过期:配置动作是「重新连接」,与「从未配置」分开报。
    if (st.clientConfigured && st.expired > 0) return 'expired';
    return 'missing';
  }
  return probes.secretSaved(req.key) ? 'satisfied' : 'missing';
}

function toAssessmentItem(
  manifest: GhostManifest,
  req: GhostSetupRequirement,
  probes: GhostSetupProbes,
  strict: boolean,
): GhostSetupAssessmentItem {
  const ref = requirementRef(req);
  const legacy = toStatusItem(manifest, req);
  const kind: GhostSetupAssessmentItem['kind'] =
    legacy.kind === 'key' ? 'secret' : legacy.kind === 'kv' ? 'plugin_config' : legacy.kind;
  const oauthClientConfigured =
    kind === 'oauth' ? probes.oauthStatus(req.key).clientConfigured : undefined;
  const secretDecl =
    req.kind === 'secret'
      ? manifest.network?.secrets?.find((secret) => secret.key === req.key)
      : undefined;
  const nodeSecretDecl =
    req.kind === 'secret'
      ? manifest.node?.secretBindings?.find((secret) => secret.key === req.key)
      : undefined;
  const userSecretDecl = secretDecl ?? nodeSecretDecl;
  return {
    ref,
    kind,
    label: legacy.label,
    ...(userSecretDecl?.hint ? { description: userSecretDecl.hint } : {}),
    state: verdictOf(manifest, req, probes, strict),
    actions:
      kind === 'secret' && userSecretDecl
        ? inlineSecretAction(manifest, ref, legacy.label, userSecretDecl.hint, userSecretDecl.url)
        : actionFor(kind, ref, { oauthClientConfigured }),
  };
}

/**
 * Setup Runtime 使用的完整判定：保留每个 any-of 组及其中所有条目的状态，
 * 供 Agent 编排流程和 Host 校验 plan。返回值只含状态，不含任何配置值。
 */
export function evaluateGhostSetupAssessment(
  manifest: GhostManifest,
  probes: GhostSetupProbes,
  options: EvaluateGhostSetupOptions,
): GhostSetupAssessment {
  if (!Number.isInteger(options.revision) || options.revision < 0) {
    throw new GhostSetupAssessmentError('setup assessment revision must be a non-negative integer');
  }
  const strict = options.strict ?? true;
  const manifestGroups = deriveRequirementGroups(manifest).map((group, index) => ({
    id: `manifest:${index + 1}`,
    mode: 'any_of' as const,
    items: group.map((req) => toAssessmentItem(manifest, req, probes, strict)),
  }));
  const groups = [...manifestGroups, ...(options.additionalGroups ?? [])];
  const ready = groups.every((group) => group.items.some((item) => item.state === 'satisfied'));
  return {
    state: ready ? 'ready' : 'required',
    revision: options.revision,
    groups,
  };
}

/**
 * 判定一段意识的配置就绪状态。纯函数:清单 + 探针进,状态出;探针全同步
 * (底层是文件存在性 / 内存清单读取),点击时现查、不缓存。
 */
export function evaluateGhostSetup(
  manifest: GhostManifest,
  probes: GhostSetupProbes,
): GhostSetupStatus {
  const assessment = evaluateGhostSetupAssessment(manifest, probes, {
    revision: 0,
    strict: false,
  });
  const missingGroups: GhostSetupStatusItem[][] = [];
  const reauth: GhostSetupStatusItem[] = [];
  const seenReauthRefs = new Set<string>();

  for (const group of assessment.groups) {
    if (group.items.some((item) => item.state === 'satisfied')) continue;
    // 组未满足:reauth 条目单列(修复动作不同),其余进缺失清单;
    // 纯 reauth 组不产生 missing 组(弹窗只提「重新连接」)。
    const missingItems: GhostSetupStatusItem[] = [];
    group.items.forEach((item) => {
      const legacyItem: GhostSetupStatusItem = {
        ref: item.ref,
        label: item.label,
        kind:
          item.kind === 'oauth'
            ? 'oauth'
            : item.kind === 'connection'
              ? 'connection'
              : item.kind === 'plugin_config'
                ? 'kv'
                : 'key',
      };
      if (item.state === 'expired') {
        if (!seenReauthRefs.has(legacyItem.ref)) {
          seenReauthRefs.add(legacyItem.ref);
          reauth.push(legacyItem);
        }
      } else {
        missingItems.push(legacyItem);
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
