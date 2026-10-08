/**
 * 消息来源标签的手机端展示文案 —— 气泡上方标签、排队气泡与 IM 卡片共用。
 *
 * 数据只认主机盖章的 agentMeta / 排队项字段（读取与去换行限长走
 * `@cindy/maker-shared/message-source`），这里只负责「怎么说」：
 *  - 设备：名字优先按 deviceId 取设备清单里的实时名，取不到回退发送时的快照；
 *    与另一台设备同名时补「(短 ID)」，避免两台「iPhone」读不出是哪台(与桌面同写法)。
 *  - 插件、Orca、IM 平台名与桌面同一套措辞（docs/product-rules 消息来源统一）。
 * 分享图不显示任何来源标签，这里的文案不进分享投影。
 */
import {
  messageSourceIdEntries,
  sanitizeSourceName,
  type MessageSourceDevice,
  type MessageSourceIdKind,
  type MessageSourcePlugin,
} from "@cindy/maker-shared/message-source";
import { i18n } from "@/i18n";

/** 与桌面 HookTaskCard 同一份平台集合；未知平台 fail closed，不渲染卡片。 */
export const MOBILE_IM_PLATFORMS = [
  "slack",
  "telegram",
  "x",
  "feishu",
  "lark",
  "discord",
  "wechat",
  "wecom",
  "dingtalk",
] as const;

export type MobileImPlatform = (typeof MOBILE_IM_PLATFORMS)[number];

export function isMobileImPlatform(value: unknown): value is MobileImPlatform {
  return (
    typeof value === "string" &&
    (MOBILE_IM_PLATFORMS as readonly string[]).includes(value)
  );
}

/** 「Cindy · 来自 飞书」卡片抬头。 */
export function imSourceHeaderTitle(im: MobileImPlatform): string {
  return i18n.t("message.renderer.cindyFrom", {
    platform: i18n.t(`message.renderer.imPlatform.${im}`),
  });
}

export interface SourceDeviceDirectoryEntry {
  deviceId: string;
  name: string;
}

const SHORT_DEVICE_ID_LENGTH = 6;

/** 同名消歧用的短 ID:设备 id 前 6 位(与桌面 resolveSourceDeviceDisplay 同口径)。 */
export function shortDeviceId(deviceId: string): string {
  return deviceId.slice(0, SHORT_DEVICE_ID_LENGTH);
}

function normalizedName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * 设备显示名:实时名 → 快照名;与清单里另一台设备同名(忽略大小写)时补「(短 ID)」,
 * 与桌面同一写法。两者都没有时返回 undefined,标签退回「从手机发送 / 从电脑发送」。
 */
export function sourceDeviceDisplayName(
  device: MessageSourceDevice,
  directory: readonly SourceDeviceDirectoryEntry[],
): string | undefined {
  const live = directory.find((entry) => entry.deviceId === device.deviceId);
  const name = sanitizeSourceName(live?.name) ?? device.name;
  if (!name) return undefined;
  const key = normalizedName(name);
  const collides = directory.some(
    (entry) =>
      entry.deviceId !== device.deviceId && normalizedName(entry.name) === key,
  );
  return collides ? `${name} (${shortDeviceId(device.deviceId)})` : name;
}

export function sourceDeviceLabel(
  device: MessageSourceDevice,
  directory: readonly SourceDeviceDirectoryEntry[],
): string {
  const name = sourceDeviceDisplayName(device, directory);
  if (device.platform === "mobile") {
    return name
      ? i18n.t("message.renderer.sourceDeviceMobileNamed", { name })
      : i18n.t("message.renderer.sourceDeviceMobile");
  }
  return name
    ? i18n.t("message.renderer.sourceDeviceDesktopNamed", { name })
    : i18n.t("message.renderer.sourceDeviceDesktop");
}

/**
 * 点按设备标签时是否已能确定设备被删除：只有设备清单已加载（非空）且不含该 id
 * 才算；清单还没拉到时照常进入设备详情页，由详情页自己给出「未找到」。
 */
export function isSourceDeviceRemoved(
  deviceId: string,
  directory: readonly SourceDeviceDirectoryEntry[],
): boolean {
  return (
    directory.length > 0 &&
    !directory.some((entry) => entry.deviceId === deviceId)
  );
}

export function sourcePluginLabel(plugin: MessageSourcePlugin): string {
  return plugin.name
    ? i18n.t("message.renderer.sourcePluginNamed", { name: plugin.name })
    : i18n.t("message.renderer.sourcePlugin");
}

/** 自动化来源；共享任务访客拿到的脱敏来源没有任务名，显示通用文案。 */
export function automationOriginLabel(origin: {
  scheduleName?: string;
}): string {
  return origin.scheduleName
    ? i18n.t("message.renderer.automationOriginNamed", {
        name: origin.scheduleName,
      })
    : i18n.t("message.renderer.automationOrigin");
}

export function sessionOriginLabel(origin: {
  senderBotName?: string;
  senderSessionTitle?: string;
}): string {
  return origin.senderBotName
    ? i18n.t("message.renderer.botOriginNamed", { name: origin.senderBotName })
    : origin.senderSessionTitle
      ? i18n.t("message.renderer.sessionOriginNamed", {
          name: origin.senderSessionTitle,
        })
      : i18n.t("message.renderer.sessionOrigin");
}

/**
 * Orca 互发消息标题。worker 角色来自主机盖章的 origin.senderLabel；主机反查不到
 * role 时会退回 'Worker' / 'Lead' 这类通用值，这些不当角色名显示。
 */
export function orcaMessageTitle(
  source: "lead" | "worker",
  senderLabel?: string,
): string {
  if (source === "lead") return i18n.t("interaction.collab.fromLead");
  const role = sanitizeSourceName(senderLabel);
  return role && !/^(lead|worker)$/i.test(role)
    ? i18n.t("interaction.collab.fromWorkerNamed", { role })
    : i18n.t("interaction.collab.fromWorker");
}

const SOURCE_ID_I18N_KEYS: Record<MessageSourceIdKind, string> = {
  plugin: "message.renderer.sourcePluginId",
  teammate: "message.renderer.sourceTeammateId",
  session: "message.renderer.sourceSessionId",
  automation: "message.renderer.sourceAutomationId",
  member: "message.renderer.sourceMemberId",
};

/**
 * 可见「谁发的」标签对应的 ID 文案(长按显示):与桌面悬停、排队行共用 messageSourceIdEntries,
 * 插件优先、伙伴给伙伴 ID + 任务 ID。没有 ID(脱敏 / 本人输入)返回 undefined。
 */
export function sourceIdText(meta: unknown): string | undefined {
  const lines = messageSourceIdEntries(meta).map(({ kind, id }) => i18n.t(SOURCE_ID_I18N_KEYS[kind], { id }));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

