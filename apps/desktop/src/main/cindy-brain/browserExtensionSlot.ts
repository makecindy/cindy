/**
 * browserExtensionSlot.ts — 浏览器扩展槽(browserExtension,2026-10-27)。
 * ---------------------------------------------------------------------------
 * 插件随包携带一个浏览器扩展时,由宿主承接扩展的连接:为每个**已装、启用、声明
 * browserExtension** 的插件各开一份本机桥接(BrowserExtensionBridge),复制并注册
 * 它的 Native Messaging host,把扩展发起的请求(翻译、字幕…)经管子转交给插件,
 * 并把插件的作业与配对身份推送转给桥接。声明 pageControl 的扩展同时成为
 * Browser Use 的「我的浏览器」执行端(user-browser 后端经 getPageControl 取桥接)。
 *
 * 安全模型:
 * - 资格审:已装、启用、声明 browserExtension;停用/卸载/换版即关桥接,在途作业
 *   按 BRIDGE_STOPPED 作废,不留排队作业;
 * - 身份:允许连接的扩展 id 来自身份卡(装入时展示并钉死),宿主代码里不出现任何
 *   具体插件名;native host 的授权令牌只写本机私有连接文件;
 * - 不设站点名单(2026-10-30 决定):安全交给任务的权限档位与自动审核;旧插件推送的
 *   setPolicy 照常应答但不生效;
 * - 配对归插件:插件推送已配对的浏览器,宿主持久化到 owner 私有目录,重启后先恢复再
 *   接受连接;没有缓存时向插件索要一次;
 * - native host 在插件沙箱外运行且全账号共用一份注册,只为官方 Cindy Chrome 安装
 *   (见 OFFICIAL_NATIVE_HOSTS,宿主唯一点名具体插件的地方);
 * - 转交请求只投递给声明该扩展的插件(沙箱内处理),宿主不解释其业务内容。
 *
 * 纯逻辑 + 依赖注入(规则 14):ghost 查询、管子投递、目录与桥接工厂在
 * cindy-brain/index.ts 组装时注入。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BrowserExtensionBridge,
  type BrowserExtensionBridgeOptions,
  type BrowserExtensionRelayNotice,
} from '../browser-extension/bridge.js';
import {
  createNativeBinding,
  type NativeBinding,
  type NativeBindingOptions,
} from '../browser-extension/native-binding.js';
import { defaultBrowserExtensionPolicy } from '../browser-extension/policy.js';
import {
  ghostInstallApprovalToken,
  type GhostPipeBrowserExtensionResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import type { UserBrowserPageControl } from '../mcp-integrations/browser-backend/user-browser-backend.js';

/**
 * Native Messaging hosts run outside the plugin sandbox and every Cindy on the account shares
 * their registration, so only the official Cindy Chrome plugin may install one, under its own
 * name. It must also declare its bundled Node program, which the install confirmation already
 * presents as running unsandboxed. Any other declaration is ignored: the bridge still runs and
 * the extension falls back to pairing.
 */
const OFFICIAL_NATIVE_HOSTS: ReadonlyMap<string, string> = new Map([
  ['my-browser', 'com.makecindy.browser'],
]);

/** A package that claims an official id without verified source gets no trust of any kind. */
function claimsUnverifiedOfficialId(ghost: InstalledGhost, verified: boolean): boolean {
  return !verified && OFFICIAL_NATIVE_HOSTS.has(ghost.manifest.id);
}

export function mayInstallNativeHost(ghost: InstalledGhost, verified = true): boolean {
  const name = ghost.manifest.browserExtension?.nativeHost?.name;
  return (
    verified &&
    name !== undefined &&
    ghost.namespace == null &&
    OFFICIAL_NATIVE_HOSTS.get(ghost.manifest.id) === name &&
    ghost.manifest.node !== undefined
  );
}

/** 「我的浏览器」只由官方 Cindy Chrome 提供;其它插件声明 pageControl 一律忽略(2026-10-30 决定)。 */
/** The root instance of an official plugin id whose source was verified. */
function isOfficialInstance(ghost: InstalledGhost, verified: boolean): boolean {
  return verified && ghost.namespace == null && OFFICIAL_NATIVE_HOSTS.has(ghost.manifest.id);
}

export function mayProvidePageControl(ghost: InstalledGhost, verified = true): boolean {
  return (
    ghost.manifest.browserExtension?.pageControl === true && isOfficialInstance(ghost, verified)
  );
}

export interface BrowserExtensionSlotDeps {
  /**
   * Whether this installed package really is the official one (installed from the public market with
   * the approved bytes; unpacked dev builds count). The manifest id alone proves nothing: only a
   * verified package may install the native host, provide My browser or inherit saved pairings.
   */
  isVerifiedOfficial(ghost: InstalledGhost): boolean;
  getGhost(id: string): InstalledGhost | null;
  /** 把转交事件投到插件逻辑页;false = 逻辑页不在线。 */
  sendToGhost(ghostId: string, payload: unknown): boolean;
  /** 逻辑页不在线时拉起它(订阅网关同款);缺省不拉起。 */
  wake?(ghostId: string): Promise<boolean>;
  /** 配对缓存目录(owner 私有);切换账号后目录变化,桥接按新目录重启。 */
  policyDir(): string;
  /** 当前数据所有者标识;变化时所有桥接重建(配对不跨账号)。 */
  ownerScopeKey(): string;
  createBridge?(options: BrowserExtensionBridgeOptions): BrowserExtensionBridge;
  createNativeBinding?(options: NativeBindingOptions): NativeBinding;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface Entry {
  instanceId: string;
  signature: string;
  ghost: InstalledGhost;
  bridge: BrowserExtensionBridge;
  native: NativeBinding | null;
  ready: Promise<void>;
  closing: boolean;
  /** Paired clients as last persisted. */
  saved: SavedBrowserExtensionState;
  /** Earliest time the native binding may be retried after a failed or pending install. */
  nativeRetryAt?: number;
  /** A native install retry still running; stopping waits for it before withdrawing the registration. */
  nativeRetry?: Promise<unknown>;
  /** The startup sequence failed (for example every compatible port was busy); the next request rebuilds it. */
  startFailed?: true;
  /** Where the installed package came from; pairings never carry over to a package from elsewhere. */
  source: string;
  /** Serialises cache writes so an older write cannot land after a newer one. */
  writes: Promise<void>;
  /**
   * Cache directory of the account this entry was created for. Fixed at creation: an account
   * switch changes policyDir() while a write may still be waiting, and its pairings must never be
   * written into the new account's cache.
   */
  cacheDir: string;
}

interface SavedBrowserExtensionState {
  trustedClients: unknown[];
  /** Read from a file written before pairings recorded their package source. */
  unstamped?: true;
}

function fail(
  errorCode: Extract<GhostPipeBrowserExtensionResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeBrowserExtensionResult {
  return { ok: false, errorCode, message };
}

/** Install provenance of a package: a replacement from another source starts without saved pairings. */
function packageSource(ghost: InstalledGhost): string {
  return JSON.stringify([ghost.publishingSource ?? null, ghost.namespace ?? null]);
}

function entrySignature(ghost: InstalledGhost, ownerScopeKey: string): string {
  return JSON.stringify([
    ownerScopeKey,
    ghost.dir,
    ghost.manifest.version,
    ghostInstallApprovalToken(ghost.approval),
    ghost.manifest.browserExtension,
  ]);
}

/** 浏览器扩展槽:按插件启停桥接 → 转交扩展请求 → 承接插件的作业/策略推送 → 提供页面控制桥接。 */
export class GhostBrowserExtensionSlot {
  private readonly entries = new Map<string, Entry>();
  /** Stops in flight; a replacement entry waits for them so the old one cannot undo its setup. */
  private readonly stopping = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly deps: BrowserExtensionSlotDeps) {}

  /** 装/卸/启停/换版广播后调用;幂等,只对发生变化的插件启停桥接。 */
  reconcile(ghosts: InstalledGhost[]): void {
    if (this.disposed) return;
    const ownerScopeKey = this.deps.ownerScopeKey();
    const wanted = new Map<string, InstalledGhost>();
    for (const ghost of ghosts) {
      if (!ghost.enabled || !ghost.manifest.browserExtension) continue;
      wanted.set(installedGhostStoragePart(ghost), ghost);
    }
    for (const [instanceId, entry] of this.entries) {
      const ghost = wanted.get(instanceId);
      if (!ghost || entrySignature(ghost, ownerScopeKey) !== entry.signature)
        void this.stop(instanceId);
    }
    for (const [instanceId, ghost] of wanted) {
      if (!this.entries.has(instanceId)) this.start(instanceId, ghost, ownerScopeKey);
    }
  }

  private start(instanceId: string, ghost: InstalledGhost, ownerScopeKey: string): void {
    const needs = ghost.manifest.browserExtension!;
    const cacheDir = this.deps.policyDir();
    const verified = this.deps.isVerifiedOfficial(ghost);
    if (needs.nativeHost && !mayInstallNativeHost(ghost, verified))
      this.deps.log?.warn(
        'browser extension native host ignored: only the verified official plugin may install one',
        {
          instanceId,
          hostName: needs.nativeHost.name,
        },
      );
    const native =
      needs.nativeHost && mayInstallNativeHost(ghost, verified)
        ? (this.deps.createNativeBinding ?? createNativeBinding)({
            hostName: needs.nativeHost.name,
            binaryDir: path.join(ghost.dir, needs.nativeHost.binary),
          })
        : null;
    const bridge = (this.deps.createBridge ?? ((options) => new BrowserExtensionBridge(options)))({
      ghostId: ghost.manifest.id,
      installedVersion: ghost.manifest.version,
      extensionIds: needs.extensionIds,
      ...(native ? { nativeToken: native.token } : {}),
      onRelay: (notice) => void this.relay(instanceId, notice),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.log ? { log: this.deps.log } : {}),
    });
    const entry: Entry = {
      instanceId,
      signature: entrySignature(ghost, ownerScopeKey),
      ghost,
      bridge,
      native,
      ready: Promise.resolve(),
      closing: false,
      saved: { trustedClients: [] },
      source: packageSource(ghost),
      writes: Promise.resolve(),
      cacheDir,
    };
    const previous = this.stopping.get(instanceId);
    entry.ready = (async () => {
      // The old bridge must release its port and native registration before this one claims them.
      await previous?.catch(() => undefined);
      // Pairings are restored only for the verified official package, and a file saved before pairings
      // carried a source is stamped now so a later replacement cannot inherit it.
      const saved = verified ? await this.readSaved(cacheDir, instanceId, entry.source) : null;
      if (saved?.unstamped) void this.persist(entry, { trustedClients: saved.trustedClients });
      if (saved) {
        entry.saved = saved;
        try {
          // Paired clients first, so an extension paired before the restart is not sent back to
          // pairing while the plugin is still starting.
          bridge.setTrustedClients(saved.trustedClients);
        } catch (err) {
          this.deps.log?.warn('browser extension saved pairings rejected', {
            instanceId,
            error: errorText(err),
          });
        }
      }
      await bridge.start();
      // No saved pairings (first run in the host, or an unreadable cache): ask the plugin to push them
      // now, so a browser it already paired is not sent back to pairing.
      if (!saved) void this.requestPairings(instanceId);
      if (native) {
        const installed = await native.install(bridge.listeningPort, needs.extensionIds);
        if (!installed.ok)
          this.deps.log?.warn('browser extension native binding unavailable', {
            instanceId,
            reason: installed.reason,
          });
      }
      this.deps.log?.info('browser extension bridge ready', {
        instanceId,
        port: bridge.listeningPort,
        pageControl: needs.pageControl === true,
      });
    })().catch((err) => {
      entry.startFailed = true;
      this.deps.log?.warn('browser extension bridge failed to start', {
        instanceId,
        error: errorText(err),
      });
    });
    this.entries.set(instanceId, entry);
  }

  private rebuild(failed: Entry): void {
    const { instanceId, ghost } = failed;
    if (this.disposed || this.entries.get(instanceId) !== failed) return;
    const ownerScopeKey = this.deps.ownerScopeKey();
    void this.stop(instanceId).then(() => {
      if (!this.disposed && !this.entries.has(instanceId))
        this.start(instanceId, ghost, ownerScopeKey);
    });
  }

  private stop(instanceId: string): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry || entry.closing) return this.stopping.get(instanceId) ?? Promise.resolve();
    entry.closing = true;
    this.entries.delete(instanceId);
    const stopped = (async () => {
      // Close first: queued jobs end and new ones are refused at once, even while startup (native
      // registration can take seconds) is still finishing. Closing again after it is harmless.
      await entry.bridge.close();
      await entry.ready;
      await entry.nativeRetry?.catch(() => undefined);
      await entry.bridge.close();
      await entry.native?.close();
      this.deps.log?.info('browser extension bridge stopped', { instanceId });
    })().finally(() => {
      if (this.stopping.get(instanceId) === stopped) this.stopping.delete(instanceId);
    });
    this.stopping.set(instanceId, stopped);
    return stopped;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  // ── 转交:扩展 → 插件 ────────────────────────────────────────────────────

  private async relay(instanceId: string, notice: BrowserExtensionRelayNotice): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    const payload = {
      type: 'event',
      name: 'browser-extension-relay',
      id: notice.id,
      clientId: notice.clientId,
      request: notice.request,
      ts: (this.deps.now ?? Date.now)(),
    };
    let delivered = this.deps.sendToGhost(instanceId, payload);
    if (!delivered && this.deps.wake) {
      try {
        delivered =
          (await this.deps.wake(instanceId)) && this.deps.sendToGhost(instanceId, payload);
      } catch (err) {
        this.deps.log?.warn('browser extension relay wake failed', {
          instanceId,
          error: errorText(err),
        });
      }
    }
    if (delivered)
      this.deps.log?.info('browser extension relay delivered to plugin', {
        instanceId,
        id: notice.id,
      });
    if (!delivered) {
      this.deps.log?.warn('browser extension relay undeliverable; plugin logic page offline', {
        instanceId,
        id: notice.id,
      });
      entry.bridge.relayResult(notice.id, { ok: false, error: 'PLUGIN_UNAVAILABLE' });
    }
  }

  // ── 管子上行:插件 → 桥接 ────────────────────────────────────────────────

  private entryFor(
    ghostId: string,
  ): { ok: true; entry: Entry } | { ok: false; result: GhostPipeBrowserExtensionResult } {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.browserExtension) {
      return {
        ok: false,
        result: fail(
          'PERMISSION_DENIED',
          '插件未申请浏览器扩展能力(browserExtension),或当前未启用',
        ),
      };
    }
    const entry = this.entries.get(installedGhostStoragePart(ghost)) ?? this.entries.get(ghostId);
    if (!entry)
      return { ok: false, result: fail('HOST_NOT_READY', '浏览器扩展桥接尚未就绪;稍后重试') };
    return { ok: true, entry };
  }

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeBrowserExtensionResult> {
    const gate = this.entryFor(ghostId);
    if (!gate.ok) return gate.result;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return fail('INVALID_REQUEST', 'browser-extension-request 载荷必须是对象');
    const req = payload as Record<string, unknown>;
    const { entry } = gate;
    await entry.ready;
    // The plugin may have been disabled, removed or replaced while the bridge was starting: a request
    // that began before that must not act (re-pair, reinstall the native binding) on the old instance.
    if (entry.closing || this.entries.get(entry.instanceId) !== entry)
      return fail('HOST_NOT_READY', '浏览器扩展桥接已重建;稍后重试');
    if (entry.startFailed) {
      // A failed startup would otherwise stay failed for good (no pairing request, no native binding)
      // even after the cause, such as busy ports, is gone. Rebuild it from the same request path the
      // plugin already retries on HOST_NOT_READY; there is no timer.
      this.rebuild(entry);
      return fail('HOST_NOT_READY', 'Cindy 正在重新启动浏览器扩展桥接,请稍后重试');
    }
    try {
      switch (req.kind) {
        case 'status': {
          // A native install that failed for a passing reason (a busy file, a registry timeout) would
          // otherwise stay failed until the plugin is toggled; try again on a status request, at most
          // every 30 seconds.
          if (entry.native && entry.native.status() === 'unavailable') {
            const now = (this.deps.now ?? Date.now)();
            if (now >= (entry.nativeRetryAt ?? 0)) {
              entry.nativeRetryAt = now + 30_000;
              const retry = entry.native.install(
                entry.bridge.listeningPort,
                entry.ghost.manifest.browserExtension!.extensionIds,
              );
              entry.nativeRetry = retry;
              try {
                await retry;
              } finally {
                if (entry.nativeRetry === retry) entry.nativeRetry = undefined;
              }
            }
          }
          const status = await entry.bridge.status();
          if (!status.ok) return { ...status, errorCode: 'HOST_NOT_READY' };
          return {
            ...status,
            host: true,
            nativeBinding: entry.native ? entry.native.status() : 'unavailable',
          };
        }
        case 'act':
          // Uploads by path are Cindy's own: the task's folder boundary and approval were checked by
          // the host before it asked Chrome to read the file. A plugin cannot name host paths.
          if (
            req.action === 'upload' &&
            req.payload &&
            typeof req.payload === 'object' &&
            'paths' in req.payload
          )
            return fail('INVALID_REQUEST', 'upload by path is not available to plugins');
          // Raw DevTools commands can make Chrome open any host path (DOM.setFileInputFiles) or read
          // any page state, so only the verified official plugin may send them through the pipe.
          if (
            req.action === 'cdp' &&
            !isOfficialInstance(entry.ghost, this.deps.isVerifiedOfficial(entry.ghost))
          )
            return fail(
              'INVALID_REQUEST',
              'raw DevTools commands are not available to this plugin',
            );
          return (await entry.bridge.act(
            req.action,
            req.payload ?? {},
          )) as GhostPipeBrowserExtensionResult;
        // Site lists were removed (2026-10-30); plugins that still push them are acknowledged.
        case 'setPolicy':
          return entry.bridge.setPolicy() as GhostPipeBrowserExtensionResult;
        case 'setTrustedClients': {
          // A package that only claims the official id could read an unpaired client's key through
          // status and pin it back; it gets no pairings at all (native binding is its only way in, and
          // it has none).
          if (claimsUnverifiedOfficialId(entry.ghost, this.deps.isVerifiedOfficial(entry.ghost)))
            return fail('PERMISSION_DENIED', '未核验来源的插件不能保存浏览器配对');
          let applied: { ok: true };
          try {
            applied = entry.bridge.setTrustedClients(req.clients);
          } catch (err) {
            return fail('INVALID_REQUEST', errorText(err));
          }
          await this.persist(entry, {
            trustedClients: Array.isArray(req.clients) ? req.clients : [],
          });
          return applied;
        }
        case 'relayActive':
          if (typeof req.id !== 'string') return fail('INVALID_REQUEST', 'relayActive 需要 id');
          return entry.bridge.relayActive(req.id);
        case 'relayProgress':
          if (typeof req.id !== 'string') return fail('INVALID_REQUEST', 'relayProgress 需要 id');
          return entry.bridge.relayProgress(
            req.id,
            req.progress,
          ) as GhostPipeBrowserExtensionResult;
        case 'relayResult':
          if (typeof req.id !== 'string') return fail('INVALID_REQUEST', 'relayResult 需要 id');
          return entry.bridge.relayResult(req.id, req.result) as GhostPipeBrowserExtensionResult;
        default:
          return fail(
            'INVALID_REQUEST',
            `未知的 browser-extension-request kind ${JSON.stringify(req.kind)}`,
          );
      }
    } catch (err) {
      this.deps.log?.warn('browser extension request failed', {
        ghostId,
        kind: req.kind,
        error: errorText(err),
      });
      return fail('INTERNAL', errorText(err));
    }
  }

  // ── 页面控制:Browser Use 的「我的浏览器」执行端 ─────────────────────────

  getPageControl(): UserBrowserPageControl | null {
    for (const [instanceId, entry] of this.entries) {
      if (mayProvidePageControl(entry.ghost, this.deps.isVerifiedOfficial(entry.ghost))) {
        return {
          bridge: entry.bridge,
          ghostId: entry.ghost.manifest.id,
          instanceId,
          pluginName: entry.ghost.manifest.name,
        };
      }
    }
    return null;
  }

  // ── 配对持久化 ──────────────────────────────────────────────────────────

  private policyFile(cacheDir: string, instanceId: string): string {
    return path.join(cacheDir, encodeURIComponent(instanceId) + '.json');
  }

  /**
   * Saved pairings; null when missing, unreadable or saved for a package from another source. A file
   * without a source predates this check and is taken once. A site list saved by older versions is ignored.
   */
  private async readSaved(
    cacheDir: string,
    instanceId: string,
    source: string,
  ): Promise<SavedBrowserExtensionState | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.policyFile(cacheDir, instanceId), 'utf8')) as {
        version?: unknown;
        source?: unknown;
        trustedClients?: unknown;
      };
      if (raw?.version !== 1) return null;
      if (raw.source !== undefined && raw.source !== source) {
        this.deps.log?.warn(
          'browser extension pairings ignored: the package came from another source',
          {
            instanceId,
          },
        );
        return null;
      }
      return {
        trustedClients: Array.isArray(raw.trustedClients) ? raw.trustedClients : [],
        ...(raw.source === undefined ? { unstamped: true as const } : {}),
      };
    } catch {
      return null;
    }
  }

  private persist(entry: Entry, change: Partial<SavedBrowserExtensionState>): Promise<void> {
    entry.saved = { ...entry.saved, ...change };
    const snapshot = entry.saved;
    entry.writes = entry.writes.then(() =>
      this.writeSaved(entry.cacheDir, entry.instanceId, entry.source, snapshot),
    );
    return entry.writes;
  }

  private async writeSaved(
    cacheDir: string,
    instanceId: string,
    source: string,
    saved: SavedBrowserExtensionState,
  ): Promise<void> {
    const file = this.policyFile(cacheDir, instanceId);
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        tmp,
        JSON.stringify({ version: 1, source, trustedClients: saved.trustedClients }),
        { mode: 0o600 },
      );
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      this.deps.log?.warn('browser extension pairings not persisted', {
        instanceId,
        error: errorText(err),
      });
    }
  }

  /**
   * Ask the plugin to push its paired browsers: wake it when offline, else send the request. The event
   * keeps its published name; plugins answer it with their pairings (and a site list that is ignored).
   */
  private async requestPairings(instanceId: string): Promise<void> {
    const payload = { type: 'event', name: 'browser-extension-policy-request' };
    try {
      if (this.deps.sendToGhost(instanceId, payload)) return;
      if (this.deps.wake && (await this.deps.wake(instanceId)))
        this.deps.sendToGhost(instanceId, payload);
    } catch (err) {
      this.deps.log?.warn('browser extension pairing request failed', {
        instanceId,
        error: errorText(err),
      });
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { defaultBrowserExtensionPolicy };
