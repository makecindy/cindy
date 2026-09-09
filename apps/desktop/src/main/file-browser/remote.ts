/**
 * remote — SSH 远程会话的 file-browser 后端(RemoteFileBrowserManager)。
 *
 * 职责:per remoteHostId 维护一个到远端 file-service daemon 的 RPC client,
 * 处理「连接 → probe → (装/升级 bundle) → execStream 启动 → handshake」的
 * 完整就绪链,并把 IPC handler 的文件操作转发成 RPC 调用。
 *
 * 生命周期:
 *  - client 懒建 + in-flight 去重(并发 listDir 只触发一次建链)。
 *  - daemon 生命周期 = SSH exec channel;通道断开 → client 标 dead →
 *    下一次请求自动重建(一次)。
 *  - schema 不匹配(probe 版本 ≠ 本地 FILE_SERVICE_SCHEMA_VERSION,或
 *    handshake 抛 SCHEMA_MISMATCH)→ 重推 bundle → 重启 daemon。bundle
 *    ~50KB,重推是秒级。
 *
 * 依赖注入(RemoteFsDeps):SSH pool / 安装器 / bundle 路径解析都可替换,
 * 单测用内存 fake 直接驱动状态机(规则 14)。
 */

import {
  FileServiceClient,
  FileServiceRpcError,
  type FileServiceStream,
} from '@cindy/remote-file-service/client';
import {
  FILE_SERVICE_BUNDLE_VERSION,
  FILE_SERVICE_SCHEMA_VERSION,
} from '@cindy/remote-file-service/protocol';
import type { FsRpcEvent, FsRpcMethods } from '@cindy/remote-file-service/protocol';

import { createLogger, type Logger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const log = createLogger('file-browser/remote');

/** probe/install 所需的最小 host 面(对齐 @cindy/maker-remote-ssh RemoteHost)。 */
export interface RemoteFsHost {
  execStream(cmd: string, opts?: { env?: Record<string, string> }): Promise<FileServiceStream>;
}

export interface RemoteFsProbe {
  nodeReady: boolean;
  installed: boolean;
  schemaVersion: number | null;
  /** daemon 报告的 bundle 版本(未安装 / 老 daemon 未报告时 null)。 */
  bundleVersion: string | null;
  binaryPath: string;
  nodeBinaryPath: string;
  /** 远端 rg 绝对路径;null = 未探测到,daemon 不带 --rg 启动,搜索降级。 */
  rgPath: string | null;
}

export interface RemoteFsDeps {
  /** 确保 host 已连接(未连则连;auth 失败等直接抛)。 */
  ensureHostReady(hostId: string): Promise<void>;
  /** 拿 host 句柄(必须已 ready)。 */
  getHost(hostId: string): RemoteFsHost;
  /** probe 远端安装状态。 */
  probe(hostId: string): Promise<RemoteFsProbe>;
  /** 推送 bundle(覆盖安装)。 */
  install(hostId: string): Promise<{ ready: boolean; error?: string }>;
  logger?: Logger;
}

/** POSIX 单引号 quote(远端路径可能含空格)。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}


/** 断链自动重放白名单:只有无副作用的读方法可以安全重试(见 request 注释)。 */
const IDEMPOTENT_RETRY_METHODS = new Set<string>([
  'listDir',
  'readFile',
  'readFileChunk',
  'stat',
  'listAllFiles',
  'watchStart',
  'watchStop',
  'searchCancel',
  'handshake',
]);

export class RemoteFileBrowserManager {
  private readonly deps: RemoteFsDeps;
  private readonly log: Logger;
  /** in-flight 或已就绪的 client(promise 形态做并发去重)。 */
  private readonly clients = new Map<string, Promise<FileServiceClient>>();
  /** Per-alias fence preventing stale endpoint builds from publishing. */
  private readonly endpointGenerations = new Map<string, number>();
  /**
   * per-host 事件订阅者(搜索流 / P4 watch)。生命周期独立于 client——client
   * 断链重建后 buildClient 会重新挂一个转发器,订阅者无感。
   */
  private readonly hostListeners = new Map<string, Set<(evt: FsRpcEvent) => void>>();
  /** per-host 重连钩子:每次 buildClient handshake 成功后触发(含首连)。 */
  private readonly connectListeners = new Map<string, Set<() => void>>();

  constructor(deps: RemoteFsDeps) {
    this.deps = deps;
    this.log = deps.logger ?? log;
  }

  private currentEndpointGeneration(hostId: string): number {
    return this.endpointGenerations.get(hostId) ?? 0;
  }

  private advanceEndpointGeneration(hostId: string): void {
    this.endpointGenerations.set(hostId, this.currentEndpointGeneration(hostId) + 1);
  }

  private assertCurrentEndpointGeneration(hostId: string, generation: number): void {
    if (this.currentEndpointGeneration(hostId) !== generation) {
      throw new FileServiceRpcError(
        'ENDPOINT_STALE',
        `remote file-service endpoint changed while work was in flight: ${hostId}`,
      );
    }
  }

  /**
   * 类型安全的远程调用入口。断链自动重建一次(仅幂等读方法);其余错误原样抛
   * FileServiceRpcError(caller 决定 throwIpcError 还是 {ok:false})。
   */
  async request<M extends keyof FsRpcMethods>(
    hostId: string,
    method: M,
    params: FsRpcMethods[M]['params'],
  ): Promise<FsRpcMethods[M]['result']> {
    const generation = this.currentEndpointGeneration(hostId);
    const client = await this.getClient(hostId, generation);
    this.assertCurrentEndpointGeneration(hostId, generation);
    try {
      const result = await client.request(method, params);
      this.assertCurrentEndpointGeneration(hostId, generation);
      return result;
    } catch (err) {
      this.assertCurrentEndpointGeneration(hostId, generation);
      const code = (err as FileServiceRpcError)?.code;
      if (
        (code === 'CHANNEL_CLOSED' || code === 'CHANNEL_ERROR') &&
        IDEMPOTENT_RETRY_METHODS.has(method as string)
      ) {
        // 断链:丢弃旧 client,重建一次再试。二次失败原样抛。
        // 仅限幂等读——变更类(writeFile/rename/delete/create)可能已在 daemon
        // 侧执行、只是响应没送回来,盲目重放会把"实际已成功"变成 ENOENT/EEXIST
        // 伪失败;变更类断链一律把错误交回调用方由用户决定重试。
        this.log.warn('file-service channel lost, rebuilding', { hostId, method });
        this.clients.delete(hostId);
        const rebuilt = await this.getClient(hostId, generation);
        const result = await rebuilt.request(method, params);
        this.assertCurrentEndpointGeneration(hostId, generation);
        return result;
      }
      if (code === 'CHANNEL_CLOSED' || code === 'CHANNEL_ERROR') {
        // 变更类断链仍要重建 client,让下一次调用可用;本次错误如实上抛。
        this.clients.delete(hostId);
      }
      throw err;
    }
  }

  /**
   * 订阅某 host 的"连接就绪"钩子(首连与断链重建都会触发)。remote watch 用
   * 它重放 watchStart(daemon 换进程后 watch 状态清零)。返回退订函数。
   */
  onHostConnected(hostId: string, cb: () => void): () => void {
    let set = this.connectListeners.get(hostId);
    if (!set) {
      set = new Set();
      this.connectListeners.set(hostId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.connectListeners.delete(hostId);
    };
  }

  /**
   * 订阅某 host 的 daemon 事件帧(搜索流等)。返回退订函数。订阅先于连接建立
   * 也有效(事件在 client 就绪后自然开始流入)。
   */
  onHostEvent(hostId: string, cb: (evt: FsRpcEvent) => void): () => void {
    let set = this.hostListeners.get(hostId);
    if (!set) {
      set = new Set();
      this.hostListeners.set(hostId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.hostListeners.delete(hostId);
    };
  }

  /** 主动断开某 host 的 client(host 断开 / 应用退出清理)。幂等。 */
  async disposeHost(hostId: string): Promise<void> {
    this.advanceEndpointGeneration(hostId);
    const pending = this.clients.get(hostId);
    if (!pending) return;
    this.clients.delete(hostId);
    // Do not await an in-flight build: it may be blocked on readiness. The
    // generation fence makes it fail before publishing, then this continuation
    // disposes any client it managed to construct.
    void pending.then((client) => client.dispose()).catch(() => undefined);
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.clients.keys()];
    await Promise.allSettled(ids.map((id) => this.disposeHost(id)));
  }

  private getClient(hostId: string, generation: number): Promise<FileServiceClient> {
    const existing = this.clients.get(hostId);
    if (existing) {
      // 已有 in-flight 或活 client;死 client 在 await 后甄别并重建。
      return existing.then((c) => {
        this.assertCurrentEndpointGeneration(hostId, generation);
        if (!c.isDead) return c;
        if (this.clients.get(hostId) === existing) this.clients.delete(hostId);
        return this.getClient(hostId, generation);
      });
    }
    const building = this.buildClient(hostId, generation);
    this.clients.set(hostId, building);
    building.catch(() => {
      // 建链失败不留缓存,下次请求重走全链。
      if (this.clients.get(hostId) === building) this.clients.delete(hostId);
    });
    return building;
  }

  /** 完整就绪链:连接 → probe → 需要则装 → 启 daemon → handshake。 */
  private async buildClient(hostId: string, generation: number): Promise<FileServiceClient> {
    await this.deps.ensureHostReady(hostId);
    this.assertCurrentEndpointGeneration(hostId, generation);

    let probe = await this.deps.probe(hostId);
    this.assertCurrentEndpointGeneration(hostId, generation);
    // bundleVersion 也参与比较:schema 兼容的 daemon 行为修复(如新增错误码)
    // 只 bump bundle 版本,不比它就永远不会重推,修复会静默发不出去。
    const needsInstall =
      !probe.installed ||
      probe.schemaVersion !== FILE_SERVICE_SCHEMA_VERSION ||
      probe.bundleVersion !== FILE_SERVICE_BUNDLE_VERSION;
    if (needsInstall) {
      if (!probe.nodeReady) {
        // node 是 agent bootstrap 装的;能创建 remote session 的机器必然有。
        // 走到这说明用户还没在这台机器上跑过 agent —— 提示走会话发送链路。
        throw new FileServiceRpcError(
          'NODE_MISSING',
          'remote bundled node not installed; send a message in this session first to bootstrap the remote agent',
        );
      }
      this.log.info('file-service install/upgrade', {
        hostId,
        installed: probe.installed,
        remoteSchema: probe.schemaVersion,
        localSchema: FILE_SERVICE_SCHEMA_VERSION,
        remoteBundle: probe.bundleVersion,
        localBundle: FILE_SERVICE_BUNDLE_VERSION,
      });
      const r = await this.deps.install(hostId);
      this.assertCurrentEndpointGeneration(hostId, generation);
      if (!r.ready) {
        throw new FileServiceRpcError('INSTALL_FAILED', r.error ?? 'file-service install failed');
      }
      probe = await this.deps.probe(hostId);
      this.assertCurrentEndpointGeneration(hostId, generation);
    }

    this.assertCurrentEndpointGeneration(hostId, generation);
    const host = this.deps.getHost(hostId);
    const rgArg = probe.rgPath ? ` --rg ${shq(probe.rgPath)}` : '';
    const stream = await host.execStream(
      `${shq(probe.nodeBinaryPath)} ${shq(probe.binaryPath)}${rgArg}`,
    );
    try {
      this.assertCurrentEndpointGeneration(hostId, generation);
    } catch (err) {
      try { stream.kill(); } catch { /* best effort */ }
      throw err;
    }
    const client = new FileServiceClient({ stream, logger: this.log });
    try {
      const info = await client.connect();
      this.assertCurrentEndpointGeneration(hostId, generation);
      this.log.info('file-service connected', { hostId, ...info });
      // 事件转发:daemon event 帧 → 该 host 的所有订阅者。挂在 client 上,
      // client 死亡自动清;重建时这里重新挂,订阅者(hostListeners)无感。
      client.onEvent((evt) => {
        const set = this.hostListeners.get(hostId);
        if (!set) return;
        for (const cb of set) cb(evt);
      });
      // 连接就绪钩子(watch 重放等)。注意在 return 前触发:订阅者的重放请求
      // 会经 getClient 拿到本 promise(已 set 进 clients),不会二次建链。
      const connectSet = this.connectListeners.get(hostId);
      if (connectSet) {
        for (const cb of connectSet) {
          try {
            cb();
          } catch (err) {
            this.log.warn('onHostConnected callback threw', { hostId, error: String(err) });
          }
        }
      }
      return client;
    } catch (err) {
      client.dispose();
      // handshake 阶段的 SCHEMA_MISMATCH:probe 报的版本与实际 daemon 不一致
      // (bundle 半新半旧的罕见态)——重推后由 caller 的下一次请求重走建链。
      if ((err as FileServiceRpcError)?.code === 'SCHEMA_MISMATCH') {
        this.log.warn('handshake schema mismatch, forcing reinstall', { hostId });
        this.assertCurrentEndpointGeneration(hostId, generation);
        await this.deps.install(hostId);
        this.assertCurrentEndpointGeneration(hostId, generation);
      }
      throw err;
    }
  }
}

/** 把远端 RPC 错误统一映射成 IPC 错误抛出(throw 风格 handler 用)。 */
export function throwRemoteFsIpcError(err: unknown): never {
  const e = err as FileServiceRpcError;
  const message = e?.message ? String(e.message) : String(err);
  throwIpcError('REMOTE_FS_UNAVAILABLE', message);
}
