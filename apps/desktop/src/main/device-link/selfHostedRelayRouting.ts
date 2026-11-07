/**
 * 当前 device-link 走哪个中转:官方(null)或自建中转。
 *
 * 刻意零依赖:device-link 主模块、REST 入口(deviceLinkApi)只读这里,不直接依赖读写配置的模块
 * (那边要碰 electron safeStorage、账号作用域与文件)。配置模块在启动时把自己登记为来源;
 * 没有登记(单测、未启用该功能的进程)时一律走官方中转,与引入自建中转之前的行为一致。
 */
export interface ActiveSelfHostedRelay {
  relayId: string;
  name: string;
  baseUrl: string;
  role: 'owner' | 'member';
  credential: string;
  /** 本机在这个中转上的设备 ID(与证书一致)。 */
  deviceId: string;
  /** 本机签名私钥种子(base64url),只在内存与安全存储里。 */
  signingSeed: string;
  /** 主人公钥:核对其他设备证书。 */
  ownerPublicKey: string;
}

let source: (() => ActiveSelfHostedRelay | null) | null = null;

export function setSelfHostedRelaySource(next: (() => ActiveSelfHostedRelay | null) | null): void {
  source = next;
}

/** 当前使用的自建中转与凭证;使用官方中转时返回 null。同步读取。 */
export function activeSelfHostedRelay(): ActiveSelfHostedRelay | null {
  return source ? source() : null;
}
