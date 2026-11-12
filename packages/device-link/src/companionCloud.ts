/**
 * 云端伙伴（docs/product-rules/cloud-companions.md）：把伙伴交给另一台电脑前，先确认那台电脑的
 * Cindy 支持接手云端伙伴。只读能力探测，返回 `{ companionCloud: <版本> }`；老版本没有该 channel →
 * CHANNEL_NOT_ALLOWED，交出方据此拒绝目标（不把伙伴交给接不住它的电脑）。
 *
 * 版本：1 = 能接手伙伴；2 = 另外接受其他电脑发来的「换主力电脑」、合并 Cindy 与合并前同步的请求（下面几个 channel）；
 * 3 = 另外能从伙伴大内容存储恢复资料，允许主力电脑交出超过偏好上限的值；
 * 4 = 另外能运行伙伴 V2（伙伴 = 一个项目）：接手时带上项目规则、项目自动化与项目记忆。V2 主力电脑只交给
 *     声明 ≥ 4 的电脑（旧电脑接住的是 V1 伙伴，不认识项目），可选目标里低于 4 的标 `outdated`。
 */
export const COMPANION_CLOUD_CAPS_CHANNEL = 'maker:companion-cloud:caps';
export const COMPANION_CLOUD_VERSION = 4;
/** 能接手伙伴的最低版本。 */
export const COMPANION_CLOUD_RECEIVE_VERSION = 1;
/** 主力电脑接受其他电脑发起换主力电脑的最低版本。 */
export const COMPANION_CLOUD_REMOTE_HAND_OVER_VERSION = 2;
/** 能接手伙伴 V2（项目伙伴）的最低版本：V2 主力电脑只交给它。 */
export const COMPANION_CLOUD_TEAMMATE_PROJECT_VERSION = 4;

/**
 * 插件「查看伙伴」(agent.companions) 跨电脑读取（只读）：在伙伴的主力电脑上返回本机伙伴的同一份插件
 * 视图，让其他电脑上的插件看到与本机一致的状态、工作阶段、当前步骤、等主人处理的请求与最新回复。
 * 入参 `[{ version: 1, kind: 'list' }]` 或 `[{ version: 1, kind: 'reply', companionId }]`；
 * 返回 `{ version: 1, companions, sessions, conversations }` 或 `{ version: 1, reply }`（见 desktop
 * pluginCompanionHost）。老版本没有该 channel → CHANNEL_NOT_ALLOWED，查看端退回伙伴列表里的状态。
 */
export const COMPANION_LIVE_CHANNEL = 'maker:companion-live:read';
export const COMPANION_LIVE_VERSION = 1;

/**
 * 在主力电脑上读取伙伴可以换到的电脑（只读，主力电脑视角：发起方自己也在其中）。
 * 入参无；返回 `CompanionCloudRemoteTarget[]`。版本 4 起，Cindy 太旧、接不住 V2 伙伴的电脑也列出，
 * 带 `outdated: true`（不能选，提示先更新那台电脑）；旧发起方忽略这个字段，选了也会被主力电脑拒绝。
 */
export const COMPANION_CLOUD_TARGETS_CHANNEL = 'maker:companion-cloud:targets';
/**
 * 请主力电脑把伙伴交给另一台电脑（写）。入参 `[botId, targetDeviceId, options?]`；在主力电脑上走与本机
 * 「主力电脑」设置完全相同的交出流程（先同步对话与资料、确认没有进行中的一轮），返回
 * `CompanionCloudRemoteActionResult`。`options.whenBusy`：伙伴还在回复时 `wait` 等这一轮结束（最多约 4 分钟）、
 * `stop` 先停止再交出；缺省按忙碌拒绝（`BUSY`）。老版本主力电脑忽略第三个参数，按忙碌拒绝。
 */
export const COMPANION_CLOUD_HAND_OVER_CHANNEL = 'maker:companion-cloud:hand-over';
/** 交出可能先等这一轮结束（约 4 分钟），再把积压对话与全部资料传完；给足执行预算与回程余量。 */
export const COMPANION_CLOUD_HAND_OVER_TIMEOUT_MS = 7 * 60_000;

/**
 * 请保留的那个 Cindy 所在的主力电脑把其他 Cindy 合并进来（写）。入参 `[keepBotId, fromBotIds[]]`；
 * 只在本机运行保留的那个 Cindy 时执行（否则 `HOME_CONFLICT`），返回 `{ ok, merged, messages, memories, skills, renamed }`
 * 或 `{ ok:false, code }`。合并要搬对话与附件，给足预算。
 */
export const COMPANION_CLOUD_MERGE_CHANNEL = 'maker:companion-cloud:merge';
export const COMPANION_CLOUD_MERGE_TIMEOUT_MS = 10 * 60_000;

/**
 * 合并前请某个 Cindy 的主力电脑把它的对话积压与全部资料传到服务器（写，不改主力电脑）。入参 `[botId]`；
 * 只在本机是它的主力电脑时执行（否则 `HOME_CONFLICT`），伙伴还在回复时 `BUSY`，返回
 * `CompanionCloudRemoteActionResult`。与交出同一套同步，给同样的预算。
 */
export const COMPANION_CLOUD_FLUSH_CHANNEL = 'maker:companion-cloud:flush';

export interface CompanionCloudCaps {
  companionCloud: number;
}

export interface CompanionCloudRemoteTarget {
  deviceId: string;
  name: string;
  online: boolean;
  /** That computer's Cindy cannot run a V2 teammate yet: listed, not selectable (version 4+ homes). */
  outdated?: boolean;
}

export type CompanionCloudRemoteActionResult =
  | { ok: true }
  | { ok: false; code: string; homeDeviceId?: string | null };

/** Declared cloud-companion version, or 0 when the answer is not a caps record. */
export function companionCloudCapsVersion(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const version = (value as { companionCloud?: unknown }).companionCloud;
  return typeof version === 'number' && Number.isFinite(version) ? version : 0;
}

/** True when the remote answer declares cloud-companion support. */
export function isCompanionCloudCaps(value: unknown): value is CompanionCloudCaps {
  return companionCloudCapsVersion(value) >= COMPANION_CLOUD_RECEIVE_VERSION;
}

/** Remote targets answer, dropping anything malformed. */
export function parseCompanionCloudRemoteTargets(value: unknown): CompanionCloudRemoteTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { deviceId, name, online, outdated } = item as Record<string, unknown>;
    if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 200) return [];
    return [{ deviceId, name: typeof name === 'string' ? name.slice(0, 200) : '', online: online === true,
      ...(outdated === true ? { outdated: true } : {}) }];
  });
}

/** Remote hand-over answer; anything malformed counts as a failure. */
export function parseCompanionCloudRemoteActionResult(value: unknown): CompanionCloudRemoteActionResult {
  if (!value || typeof value !== 'object') return { ok: false, code: 'FAILED' };
  const record = value as Record<string, unknown>;
  if (record.ok === true) return { ok: true };
  const code = typeof record.code === 'string' && /^[A-Z_]{1,40}$/.test(record.code) ? record.code : 'FAILED';
  const homeDeviceId = typeof record.homeDeviceId === 'string' ? record.homeDeviceId : record.homeDeviceId === null ? null : undefined;
  return { ok: false, code, ...(homeDeviceId !== undefined ? { homeDeviceId } : {}) };
}
