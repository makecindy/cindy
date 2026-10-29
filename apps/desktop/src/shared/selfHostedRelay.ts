/**
 * 自建中转服务:main / preload / renderer 共用的 IPC 契约。
 * 方案见 docs/self-hosted-relay-plan.md。只接受本机应用窗口调用,不经设备互联代理。
 */
import type { RelayJoinErrorCode } from '@cindy/device-link';

export const SELF_HOSTED_RELAY_IPC = {
  COMMAND: 'self-hosted-relay:command',
  CHANGED: 'self-hosted-relay:changed',
} as const;

export const DEFAULT_RELAY_PORT = 47820;

export type SelfHostedRelayCommand =
  | { type: 'state' }
  /** 在这台电脑上开启中转;已开启时按新设置重启。 */
  | { type: 'enable-host'; port: number; listenAll: boolean; externalUrl: string | null }
  /** 停用本机中转,并切回官方中转。 */
  | { type: 'disable-host' }
  /** 生成一次性加入链接(10 分钟有效)。 */
  | { type: 'create-join-link' }
  | { type: 'decide'; requestId: string; approve: boolean }
  /** 加入别的中转:粘贴主人电脑给出的加入链接。 */
  | { type: 'join'; link: string }
  | { type: 'cancel-join' }
  /** 切回 Cindy 官方中转(成员退出中转;主人停用本机中转;服务器上的中转继续运行)。 */
  | { type: 'use-official' }
  /**
   * 部署到自己的服务器(经已配置的 SSH 主机)。`address` 是其他设备访问用的域名或公网 IP,证书签给它。
   * `replaceExisting`:服务器上已有不属于这台电脑的中转时,清掉它重新部署。
   */
  | { type: 'deploy'; sshHostId: string; address: string; name: string; replaceExisting: boolean }
  /** 把服务器上的中转升级到这个版本 Cindy 自带的版本(保留已加入的设备)。 */
  | { type: 'upgrade-deployment' }
  /** 从服务器卸载中转;`removeData` 同时删除设备档案(已加入的设备需要重新加入)。 */
  | { type: 'uninstall-deployment'; removeData: boolean }
  /** 服务器已不可用时,只在本机删掉部署记录。 */
  | { type: 'forget-deployment' }
  /** 改回使用服务器上的中转(之前切回过官方中转)。 */
  | { type: 'use-deployment' };

/** 部署的步骤(界面逐步展示)。 */
export type RelayDeployStep =
  | 'connect'
  | 'check'
  | 'runtime'
  | 'upload'
  | 'configure'
  | 'certificate'
  | 'verify'
  | 'finish';

export const RELAY_DEPLOY_STEPS: readonly RelayDeployStep[] = [
  'connect',
  'check',
  'runtime',
  'upload',
  'configure',
  'certificate',
  'verify',
  'finish',
];

export type RelayDeployErrorCode =
  /** 连不上 SSH 主机(未配置、离线、认证失败)。 */
  | 'SSH_FAILED'
  /** 需要 root 或免密 sudo。 */
  | 'NEEDS_ROOT'
  /** 只支持带 systemd 的 64 位 Linux(x64 / arm64)。 */
  | 'UNSUPPORTED_SYSTEM'
  /** 80 或 443 端口被其他程序占用。 */
  | 'PORT_BUSY'
  | 'NGINX_FAILED'
  /** 下载运行环境失败(官方源与国内镜像都失败,或校验不符)。 */
  | 'DOWNLOAD_FAILED'
  /** 服务器上已有不属于这台电脑的中转。 */
  | 'RELAY_MISMATCH'
  /** 证书申请失败(通常是 80 端口没对外开放,或域名没解析到这台服务器)。 */
  | 'CERTIFICATE_FAILED'
  /** 服务器上中转已运行,但这台电脑访问不到(通常是 443 端口没对外开放)。 */
  | 'NOT_REACHABLE'
  /** 这个版本的 Cindy 没有带中转程序(开发环境未构建)。 */
  | 'BUNDLE_MISSING'
  | 'DEPLOY_FAILED';

export type SelfHostedRelayErrorCode =
  | RelayJoinErrorCode
  | RelayDeployErrorCode
  | 'INVALID_LINK'
  | 'NOT_SIGNED_IN'
  | 'HOSTING'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'PORT_IN_USE'
  | 'START_FAILED'
  | 'EXTERNAL_URL_REQUIRED'
  /** 申请里的配对证明对不上这台电脑生成的加入链接:不能同意。 */
  | 'PAIR_PROOF_INVALID'
  /** 只有主人电脑能做这件事。 */
  | 'NOT_OWNER'
  /** 已有部署任务在进行。 */
  | 'BUSY'
  | 'INVALID_ADDRESS'
  | 'NO_DEPLOYMENT';

export interface SelfHostedRelayPairRequestView {
  requestId: string;
  deviceName: string;
  platform: string | null;
  verifyCode: string;
  replacesExisting: boolean;
  /** 配对证明与这台电脑生成的加入链接一致;为 false 时只能拒绝。 */
  verified: boolean;
}

export type SelfHostedRelayJoinView =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'waiting'; relayName: string; verifyCode: string }
  | { status: 'joined'; relayName: string }
  | { status: 'failed'; error: SelfHostedRelayErrorCode };

export interface SelfHostedRelayDeployJobView {
  action: 'deploy' | 'upgrade' | 'uninstall';
  step: RelayDeployStep;
  status: 'running' | 'failed' | 'done';
  error?: SelfHostedRelayErrorCode;
  /** 失败时给用户看的补充信息(端口、服务器返回的原因),不含秘密。 */
  detail?: string;
}

export interface SelfHostedRelayDeploymentView {
  sshHostId: string;
  address: string;
  baseUrl: string;
  name: string;
  relayVersion: string;
  deployedAt: string;
  /** 这台电脑当前正在用它。 */
  active: boolean;
  /** 这个版本 Cindy 带的中转版本不同,可以升级。 */
  upgradeAvailable: boolean;
}

export interface SelfHostedRelayState {
  /** 已登录且系统安全存储可用。 */
  available: boolean;
  mode: 'official' | 'self-hosted';
  relay: { name: string; baseUrl: string; role: 'owner' | 'member'; origin: 'host' | 'server' | 'join' } | null;
  /** 自建模式下的连接情况:设备被移出中转 / 凭证被拒。 */
  issue: 'removed' | 'unauthorized' | null;
  host: {
    enabled: boolean;
    running: boolean;
    error: SelfHostedRelayErrorCode | null;
    port: number;
    listenAll: boolean;
    externalUrl: string | null;
    /** 本机局域网地址(含端口),用于填写对外地址。 */
    suggestedUrls: string[];
  };
  deployment: SelfHostedRelayDeploymentView | null;
  deployJob: SelfHostedRelayDeployJobView | null;
  /** 这个版本 Cindy 自带的中转版本;null = 没带(开发环境未构建)。 */
  bundledRelayVersion: string | null;
  joinLink: { link: string; expiresAt: string } | null;
  pendingRequests: SelfHostedRelayPairRequestView[];
  join: SelfHostedRelayJoinView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SSH_HOST_ID_PATTERN = /^[A-Za-z0-9._@:-]{1,128}$/;

/** 访问地址:域名或 IP(不带协议、端口、路径)。 */
export function normalizeRelayAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!trimmed || trimmed.length > 253) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.split('.').every((part) => Number(part) <= 255) ? trimmed : null;
  }
  if (trimmed.includes(':')) return /^[0-9a-f:]+$/.test(trimmed) && trimmed.split(':').length <= 8 ? trimmed : null;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(trimmed) ? trimmed : null;
}

/** 访问地址对应的 https 基础地址(IPv6 加方括号)。 */
export function relayBaseUrlForAddress(address: string): string {
  return address.includes(':') ? `https://[${address}]` : `https://${address}`;
}

/** 校验来自 renderer 的命令;不合法时返回 null。 */
export function parseSelfHostedRelayCommand(raw: unknown): SelfHostedRelayCommand | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'state':
    case 'disable-host':
    case 'create-join-link':
    case 'cancel-join':
    case 'use-official':
    case 'upgrade-deployment':
    case 'forget-deployment':
    case 'use-deployment':
      return { type: raw.type };
    case 'enable-host': {
      const port = raw.port;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
      if (typeof raw.listenAll !== 'boolean') return null;
      const externalUrl = raw.externalUrl;
      if (externalUrl !== null && (typeof externalUrl !== 'string' || externalUrl.length > 512)) return null;
      return { type: 'enable-host', port, listenAll: raw.listenAll, externalUrl: externalUrl?.trim() || null };
    }
    case 'decide':
      if (typeof raw.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(raw.requestId)) return null;
      if (typeof raw.approve !== 'boolean') return null;
      return { type: 'decide', requestId: raw.requestId, approve: raw.approve };
    case 'join':
      if (typeof raw.link !== 'string' || raw.link.length > 2048) return null;
      return { type: 'join', link: raw.link };
    case 'deploy': {
      if (typeof raw.sshHostId !== 'string' || !SSH_HOST_ID_PATTERN.test(raw.sshHostId)) return null;
      if (typeof raw.address !== 'string' || typeof raw.name !== 'string' || typeof raw.replaceExisting !== 'boolean') return null;
      const address = normalizeRelayAddress(raw.address);
      const name = raw.name.trim();
      if (!address || !name || name.length > 64) return null;
      return { type: 'deploy', sshHostId: raw.sshHostId, address, name, replaceExisting: raw.replaceExisting };
    }
    case 'uninstall-deployment':
      if (typeof raw.removeData !== 'boolean') return null;
      return { type: 'uninstall-deployment', removeData: raw.removeData };
    default:
      return null;
  }
}

export interface SelfHostedRelayCommandResult {
  state: SelfHostedRelayState;
  error?: SelfHostedRelayErrorCode;
}

/** `window.electronAPI.selfHostedRelay`。 */
export interface SelfHostedRelayApi {
  command(command: SelfHostedRelayCommand): Promise<SelfHostedRelayCommandResult>;
  onChanged(cb: (state: SelfHostedRelayState) => void): () => void;
}
