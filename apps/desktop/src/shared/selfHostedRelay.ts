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
   * 一台服务器只有一个中转:部署到已有记录的服务器就是重新部署那一个。部署完成不切换线路。
   * `replaceExisting`:服务器上已有不属于这台电脑的中转时,清掉它重新部署。
   */
  | { type: 'deploy'; sshHostId: string; address: string; name: string; replaceExisting: boolean }
  /** 下面这些都针对某一个服务器中转,用部署记录的 `relayId` 指定。 */
  /** 把服务器上的中转升级到这个版本 Cindy 自带的版本(保留已加入的设备)。 */
  | { type: 'upgrade-deployment'; relayId: string }
  /** 从服务器卸载中转;`removeData` 同时删除设备档案(已加入的设备需要重新加入)。 */
  | { type: 'uninstall-deployment'; relayId: string; removeData: boolean }
  /** 服务器已不可用时,只在本机删掉部署记录。 */
  | { type: 'forget-deployment'; relayId: string }
  /** 改用服务器上的这个中转。 */
  | { type: 'use-deployment'; relayId: string }
  /** 改这个中转在本机显示的名字(不改服务器上的名字)。 */
  | { type: 'rename-deployment'; relayId: string; name: string }
  /** 只读检查服务器能否部署,不改动服务器;结果在命令返回的 `check` 里。 */
  | { type: 'check-server'; sshHostId: string }
  /** 关掉一次没改动过服务器的失败部署(检查阶段就停下的)。 */
  | { type: 'dismiss-deploy-job' }
  /** 以主人身份读取服务器中转的状态(在线、设备数、证书到期);结果在 `deploymentStatus` 里。 */
  | { type: 'deployment-status'; relayId: string };

/** 部署的步骤(界面逐步展示)。`finish` 只出现在日志里。 */
export type RelayDeployStep =
  | 'connect'
  | 'check'
  | 'runtime'
  | 'upload'
  | 'configure'
  | 'certificate'
  | 'verify'
  | 'remove'
  | 'finish';

/** 部署与升级界面列出的步骤。 */
export const RELAY_DEPLOY_STEPS: readonly RelayDeployStep[] = [
  'check',
  'runtime',
  'upload',
  'configure',
  'certificate',
  'verify',
];

export const RELAY_UNINSTALL_STEPS: readonly RelayDeployStep[] = ['connect', 'remove'];

export type RelayDeployErrorCode =
  /** 连不上 SSH 主机(未配置、离线、认证失败)。 */
  | 'SSH_FAILED'
  /** SSH 能连上,但这个账号不能执行命令(例如 Git 服务的 git 账号)。 */
  | 'SHELL_UNAVAILABLE'
  /** 需要 root 或免密 sudo。 */
  | 'NEEDS_ROOT'
  /** 只支持带 systemd 的 64 位 Linux(x64 / arm64)。 */
  | 'UNSUPPORTED_SYSTEM'
  /** 80 或 443 端口被其他程序占用;detail 是程序名。 */
  | 'PORT_BUSY'
  /** 80 或 443 端口由 Docker 容器发布(容器里的配置 Cindy 改不了);detail 是容器名。 */
  | 'PORT_BUSY_CONTAINER'
  | 'NGINX_FAILED'
  /** 下载运行环境失败(官方源与国内镜像都失败,或校验不符)。 */
  | 'DOWNLOAD_FAILED'
  /** 服务器上已有不属于这台电脑的中转。 */
  | 'RELAY_MISMATCH'
  /** 证书申请失败(通常是 80 端口没对外开放,或域名没解析到这台服务器)。 */
  | 'CERTIFICATE_FAILED'
  /** 服务器在等待时间内一直连不上证书机构(出网中断、超时、连接被重置)。 */
  | 'CA_UNREACHABLE'
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

/** 部署日志只传受控事件，不把 SSH 原始输出、证书材料或凭证交给界面。 */
export type RelayDeployProgressMessage =
  | 'runtime-cached'
  | 'runtime-download'
  | 'runtime-fallback'
  | 'runtime-checksum'
  | 'runtime-extract'
  | 'nginx-prepare'
  | 'certificate-wait'
  | 'certificate-retry'
  | 'verify-retry'
  | 'nginx-rollback';

export interface RelayDeployLogEntry {
  at: number;
  step: RelayDeployStep;
  message?: RelayDeployProgressMessage;
}

export interface SelfHostedRelayDeployJobView {
  action: 'deploy' | 'upgrade' | 'uninstall';
  step: RelayDeployStep;
  status: 'running' | 'failed' | 'done';
  error?: SelfHostedRelayErrorCode;
  /** 失败时给用户看的补充信息(端口、服务器返回的原因),不含秘密。 */
  detail?: string;
  /** 可选以兼容旧的状态快照；只保存在当前账号的内存中。 */
  startedAt?: number;
  finishedAt?: number;
  logs?: RelayDeployLogEntry[];
  /** 这次任务依次要做的步骤(界面照此列出)。 */
  steps?: RelayDeployStep[];
  /** 部署的目标。检查通过前还没有部署记录,界面靠它显示服务器和地址,失败后「修改设置」也从这里回填。 */
  target?: { sshHostId: string; address: string; name: string; baseUrl: string };
  /** 这次任务对应的服务器中转(部署记录的 `relayId`;检查通过前还没有记录)。 */
  relayId?: string;
  /** 已经开始改动服务器(部署记录已保存)。为 false 时失败的部署可以直接关掉。 */
  serverChanged?: boolean;
}

/** 只读检查的结果:`existing` 说明服务器上已有的中转是不是这台电脑部署的。 */
export type SelfHostedRelayServerCheck =
  | {
      sshHostId: string;
      ok: true;
      /** 系统名与架构,例如 `Debian GNU/Linux 13 (trixie) · x86_64`。 */
      system: string;
      plan: 'direct' | 'nginx';
      existing: 'none' | 'mine' | 'other';
    }
  | { sshHostId: string; ok: false; error: SelfHostedRelayErrorCode; detail?: string };

export interface SelfHostedRelayDeploymentView {
  relayId: string;
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
  /** 部署到服务器的中转,一台服务器一个,按部署顺序。 */
  deployments: SelfHostedRelayDeploymentView[];
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
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RELAY_NAME_MAX_LENGTH = 64;

function relayIdOf(raw: Record<string, unknown>): string | null {
  return typeof raw.relayId === 'string' && RELAY_ID_PATTERN.test(raw.relayId) ? raw.relayId : null;
}

/** 中转名字:去掉首尾空白,1–64 个字符。 */
export function normalizeRelayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= RELAY_NAME_MAX_LENGTH ? name : null;
}

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
    case 'dismiss-deploy-job':
      return { type: raw.type };
    case 'upgrade-deployment':
    case 'forget-deployment':
    case 'use-deployment':
    case 'deployment-status': {
      const relayId = relayIdOf(raw);
      return relayId ? { type: raw.type, relayId } : null;
    }
    case 'rename-deployment': {
      const relayId = relayIdOf(raw);
      const name = normalizeRelayName(raw.name);
      return relayId && name ? { type: 'rename-deployment', relayId, name } : null;
    }
    case 'check-server':
      if (typeof raw.sshHostId !== 'string' || !SSH_HOST_ID_PATTERN.test(raw.sshHostId)) return null;
      return { type: 'check-server', sshHostId: raw.sshHostId };
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
      if (typeof raw.address !== 'string' || typeof raw.replaceExisting !== 'boolean') return null;
      const address = normalizeRelayAddress(raw.address);
      const name = normalizeRelayName(raw.name);
      if (!address || !name) return null;
      return { type: 'deploy', sshHostId: raw.sshHostId, address, name, replaceExisting: raw.replaceExisting };
    }
    case 'uninstall-deployment': {
      const relayId = relayIdOf(raw);
      if (!relayId || typeof raw.removeData !== 'boolean') return null;
      return { type: 'uninstall-deployment', relayId, removeData: raw.removeData };
    }
    default:
      return null;
  }
}

export interface SelfHostedRelayCommandResult {
  state: SelfHostedRelayState;
  error?: SelfHostedRelayErrorCode;
  /** 只有 `check-server` 返回。 */
  check?: SelfHostedRelayServerCheck;
  /** 只有 `deployment-status` 返回。 */
  deploymentStatus?: SelfHostedRelayDeploymentStatus;
}

/** 服务器中转的实时状态;`online: false` 表示这台电脑现在连不上它(或它不认这台电脑的主人凭证)。 */
export interface SelfHostedRelayDeploymentStatus {
  online: boolean;
  /** 已加入的设备数(含这台电脑)。 */
  devices?: number;
  /** 此刻连着中转的设备数。 */
  onlineDevices?: number;
  /** 中转自己申请的证书的到期时间;沿用已有网站证书时为 null。 */
  certificateExpiresAt?: string | null;
}

/** `window.electronAPI.selfHostedRelay`。 */
export interface SelfHostedRelayApi {
  command(command: SelfHostedRelayCommand): Promise<SelfHostedRelayCommandResult>;
  onChanged(cb: (state: SelfHostedRelayState) => void): () => void;
}
