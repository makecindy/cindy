/**
 * 对外模型代理(给用户自己的 Claude Code CLI 用)的**非密钥**偏好存储。
 *
 * 只存三样东西,均非敏感:
 *   - enabled:是否对外开放代理(默认关闭 —— loopback 背后是付费凭证,必须用户显式开启)。
 *   - defaultProviderId:多来源 / stock `claude-*` 模型按模型名解析不出唯一供应商时,
 *     回落到的「对外默认供应商」id;为空表示未选。
 *   - port:开启对外服务时固定的监听端口(默认随机 → 开启即捕获当前端口并持久化)。
 *     0 / 未设置表示「未固定,启动时随机」。
 *
 * 对外访问 **token** 是敏感凭据,不在这里 —— 它走 safeStorage
 * (`providerSecretStore` 的 `read/writeLocalProxyExternalToken`)。
 *
 * userData/local-proxy-settings.json,跨 dev(http://localhost)/ installed(file://)共享,
 * 绕开 localStorage 按 origin 隔离的问题(与 sidebar-settings 同范式)。
 */

import Store from 'electron-store';

interface LocalProxySettingsShape {
  enabled: boolean;
  defaultProviderId: string;
  /** 固定监听端口;0 表示未固定(启动时随机)。 */
  port: number;
  /**
   * Codex / 通用 OpenAI 出口(codex loopback proxy)。**独立开关 + 独立 token**(第三期):
   * 与 Anthropic 出口(A 族)的 `enabled` 互不影响,可单独开启。
   *   - codexEnabled:B 族是否对外开放(默认关闭)。
   *   - codexPort:codex loopback 固定端口;0 表示未固定(启动时随机)。
   *   - codexDefaultProviderId:codex agent 按模型名解析不出唯一供应商时回落的默认供应商 id。
   */
  codexEnabled: boolean;
  codexPort: number;
  codexDefaultProviderId: string;
}

/** TCP 端口合法区间(0 = 未固定的哨兵值,单独允许)。 */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

let storeInstance: Store<LocalProxySettingsShape> | null = null;

function getStore(): Store<LocalProxySettingsShape> {
  if (!storeInstance) {
    storeInstance = new Store<LocalProxySettingsShape>({
      name: 'local-proxy-settings',
      defaults: {
        enabled: false,
        defaultProviderId: '',
        port: 0,
        codexEnabled: false,
        codexPort: 0,
        codexDefaultProviderId: '',
      },
      schema: {
        enabled: { type: 'boolean' },
        defaultProviderId: { type: 'string' },
        port: { type: 'integer', minimum: 0, maximum: MAX_PORT },
        codexEnabled: { type: 'boolean' },
        codexPort: { type: 'integer', minimum: 0, maximum: MAX_PORT },
        codexDefaultProviderId: { type: 'string' },
      },
      clearInvalidConfig: true,
    });
  }
  return storeInstance;
}

export interface LocalProxySettings {
  enabled: boolean;
  defaultProviderId: string;
  port: number;
  codexEnabled: boolean;
  codexPort: number;
  codexDefaultProviderId: string;
}

export function loadLocalProxySettings(): LocalProxySettings {
  const store = getStore();
  return {
    enabled: store.get('enabled', false),
    defaultProviderId: store.get('defaultProviderId', ''),
    port: store.get('port', 0),
    codexEnabled: store.get('codexEnabled', false),
    codexPort: store.get('codexPort', 0),
    codexDefaultProviderId: store.get('codexDefaultProviderId', ''),
  };
}

/** A 族(Anthropic)对外服务是否已开启(默认关闭)。热路径(每次外部请求鉴权)会调用,保持同步读。 */
export function isExternalAccessEnabled(): boolean {
  return getStore().get('enabled', false);
}

/** B 族(Codex / 通用 OpenAI)对外服务是否已开启(默认关闭)。与 A 族独立。热路径同步读。 */
export function isCodexExternalAccessEnabled(): boolean {
  return getStore().get('codexEnabled', false);
}

export function setLocalProxyEnabled(enabled: boolean): void {
  getStore().set('enabled', enabled);
}

export function setLocalProxyCodexEnabled(enabled: boolean): void {
  getStore().set('codexEnabled', enabled);
}

export function setLocalProxyDefaultProviderId(providerId: string): void {
  getStore().set('defaultProviderId', providerId);
}

export function setLocalProxyCodexDefaultProviderId(providerId: string): void {
  getStore().set('codexDefaultProviderId', providerId);
}

/**
 * 持久化 codex loopback 固定端口。归一化范式与 {@link setLocalProxyPort} 完全一致
 * (越界 / 非整数 → 0 未固定)。返回实际写入值。
 */
export function setLocalProxyCodexPort(port: number): number {
  const normalized =
    Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : 0;
  getStore().set('codexPort', normalized);
  return normalized;
}

/**
 * 持久化固定端口。传 0 / 越界值一律归一为 0(未固定)——非法端口不落盘,避免下次
 * 启动拿一个绑不上的端口。返回归一化后实际写入的值。
 */
export function setLocalProxyPort(port: number): number {
  const normalized =
    Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT ? port : 0;
  getStore().set('port', normalized);
  return normalized;
}

/** 端口是否在合法可绑区间(不含 0 哨兵)。UI 校验与 IPC 入参校验共用。 */
export function isValidLocalProxyPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/**
 * IPC set-port 入参校验:除了合法可绑端口,额外接受 0 = 「自动(启动时随机绑)」。
 * 用户清空端口输入框即用 0 把端口从固定改回自动,与状态模型里 0 的语义一致。
 */
export function isValidLocalProxyPortOrAuto(port: unknown): port is number {
  return port === 0 || isValidLocalProxyPort(port);
}

/** 测试隔离:丢弃单例,下次 getStore 重新构造。 */
export function resetLocalProxySettingsStoreForTest(): void {
  storeInstance = null;
}
