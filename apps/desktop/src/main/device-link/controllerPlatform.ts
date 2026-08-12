/**
 * 控制端平台登记表(deviceId → platform)。
 *
 * platform 来自 relay 广播的 presence 快照(`PresenceSnapshot.platform`):桌面报
 * `process.platform`(`darwin` / `win32` / `linux`),手机报 `Platform.OS`
 * (`ios` / `android`)。两端取值天然不重叠,所以它是现成可用的「控制端是电脑还是
 * 手机」判据 —— 不需要往 relay 协议里新加 clientType 字段。
 *
 * ⚠️ **可信度:仅体验分流,不是安全边界。** 这个值由对端设备在 hello 帧里自报
 * (`HelloPayload.platform`,client→server),本仓没有服务端校验或覆盖 —— 一台改过的
 * 同账号已配对设备可以声称自己是 `ios`。消费方只能拿它做"要不要换个呈现 / 多说一句"
 * 这类无权限后果的分流;任何鉴权、权限或安全判定都不得建立在它上面。
 *
 * 单独成模块而不是留在 device-link/index.ts 里,是为了让 dispatch.ts 也能读:
 * index.ts 已经 import dispatch.ts(`index.ts` 顶部),反向 import 会成环。这里是
 * 无依赖叶子模块,两边都能安全引用,且平台事实只有一份。
 */

/**
 * 手机平台取值(手机侧 `Platform.OS` 的全集)。
 * 对应的桌面侧判据是 voice-input/dictionarySyncDriver 的 `DESKTOP_PLATFORMS`
 * (`darwin` / `win32` / `linux`);两张表互不重叠,新增平台时同步。
 */
const MOBILE_PLATFORMS = new Set(['ios', 'android']);

/**
 * 是否手机平台。
 *
 * **刻意写成正向判定,而不是 `!isDesktopPlatform(p)`**:presence 可能还没到、旧版本
 * 客户端可能报别的字符串,那些情况下 platform 是未知而非「手机」。取反会把未知一律
 * 当手机,是 fail-open;正向白名单在未知时返回 false,行为退化成「不加任何手机相关
 * 处理」,这才是安全方向。
 */
export function isMobilePlatform(platform: string | undefined | null): boolean {
  return typeof platform === 'string' && MOBILE_PLATFORMS.has(platform);
}

const platformByDevice = new Map<string, string>();

/** presence 变更时登记(唯一写入点在 device-link/index.ts 的 onPresenceChanged)。 */
export function setControllerPlatform(deviceId: string, platform: string): void {
  platformByDevice.set(deviceId, platform);
}

/** 未登记(presence 未到 / 已清空)返回 undefined —— 调用方按未知处理,不要猜。 */
export function getControllerPlatform(deviceId: string): string | undefined {
  return platformByDevice.get(deviceId);
}

/** 账号切换 / 连接重置时清空(与其它 presence 缓存同点清理)。 */
export function clearControllerPlatforms(): void {
  platformByDevice.clear();
}
