/**
 * UserBrowserBackend — 把用户正在使用的浏览器(经随包浏览器扩展)接成 Browser Use
 * 的第三个控制目标。
 *
 * 与另外两个后端的差别:
 * - 页面活在用户自己的 Chrome / Edge 里,带着用户本人的登录态;Cindy 不启停它;
 * - 用哪个浏览器是用户的选择,所以能力与专用浏览器对齐(扩展 0.4.42 起):截图、
 *   上传、页面脚本、控制台、网络、弹窗、坐标与拖拽都可用。底线是不打扰用户自己的
 *   使用:新页面开在 Cindy 自己的后台窗口,不抢焦点,不切换用户正在看的标签页;
 * - 只有 debugger 才能做的(导出 PDF、整页/元素/后台标签截图、配方适配器的原始协议命令)做不了:
 *   Chrome 不允许把它声明成可选权限,发布版扩展没有它。能力表如实报告,截图退回可视区域,
 *   其余明确告诉模型改用专用浏览器需由用户决定,绝不悄悄换目标。旧版扩展只有基础读取与交互,
 *   同样明确拒绝并提示更新;
 * - 每个作业都经桥接校验地址,结果脱敏后才回到这里;不设站点名单(2026-10-30 决定)。
 *
 * 寻址:这里维护 targetId ↔ {连接, tabId, url} 的映射。新版扩展按 tabId 寻址;
 * 旧版扩展按精确 URL 寻址,页面在两次调用之间跳转时报 PAGE_CHANGED,不猜新页。
 */

import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RecipeBrowserSessions } from '@cindy/browser-control-runtime';
import { buildDomReadSource } from '@cindy/browser-control-runtime/dom-read';
import type {
  BrowserExtensionBridge,
  BrowserExtensionClientInfo,
  BrowserExtensionJobResult,
} from '../../browser-extension/bridge.js';
import { openRecipeInputFileSync, readRecipeInputFileSync, resolveUploadFiles } from './rsb-webview-upload-policy.js';
import type { BackendRequest, BackendResult, BrowserBackend } from './types.js';

export interface UserBrowserPageControl {
  bridge: BrowserExtensionBridge;
  ghostId: string;
  /** 已装实例标识(同一插件 ID 可有根实例与组织实例);用来精确匹配被取代工具所属的实例。 */
  instanceId: string;
  pluginName: string;
}

export interface UserBrowserBackendOptions {
  /** 声明 browserExtension.pageControl 的插件桥接;null = 没有这样的插件(或未启用)。 */
  getPageControl(): UserBrowserPageControl | null;
  /** 上传可读取的本地目录(按会话);没有则上传不可用。 */
  resolveUploadRoots?(sessionId: string): Promise<string[]>;
  logger: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
  };
  now?(): number;
  /** status 时扩展未连接,先等它重连这么久(扩展刷新或更新后会断开几秒);默认 8 秒。 */
  reconnectWaitMs?: number;
}

interface TargetRecord {
  targetId: string;
  alias: string;
  label?: string;
  clientId: string;
  tabId: number;
  url: string;
  title?: string;
}

export const USER_BROWSER_UNSUPPORTED_HINT =
  '用户浏览器执行端不支持此操作;需要时请明确告知用户并改用 Cindy 专用浏览器(external),不要自行切换。';

/** 旧版扩展的能力表(供 MCP 层在调用前拒绝,与 status 一并告知模型)。 */
export const USER_BROWSER_CAPABILITIES = Object.freeze({
  evaluate: false,
  screenshot: false,
  network: false,
  upload: false,
  dialog: false,
  console: false,
  pdf: false,
  focus: false,
  close: false,
  trustedInput: false,
  pointer: false,
  rawProtocol: false,
});

/**
 * 扩展从这个版本起与专用浏览器对齐。pdf 与原始协议除外:它们要 Chrome 的 debugger,而 Chrome 不允许
 * 把它声明成可选权限,发布版扩展没有这项能力(2026-11-01 实测 permissions.request 直接拒绝)。
 */
export const USER_BROWSER_PARITY_VERSION = '0.4.43';
export const USER_BROWSER_PARITY_CAPABILITIES = Object.freeze({
  evaluate: true,
  screenshot: true,
  network: true,
  upload: true,
  dialog: true,
  console: true,
  pdf: false,
  focus: true,
  close: true,
  trustedInput: false,
  pointer: true,
  rawProtocol: false,
});

export function extensionSupportsParity(version: string | null | undefined): boolean {
  return extensionAtLeast(version, USER_BROWSER_PARITY_VERSION);
}

/** Extensions from this version take files too large for one job in pieces, without the ~30 MB transfer bound. */
export const USER_BROWSER_CHUNKED_UPLOAD_VERSION = '0.4.61';
/** Extensions from this version list every iframe in a snapshot and route refs to the frame that holds them. */
const USER_BROWSER_FRAMES_VERSION = '0.4.61';
/** Extensions from this version read and fill password, payment and one-time-code fields like any field. */
export const USER_BROWSER_SENSITIVE_FIELDS_VERSION = '0.4.57';

function extensionAtLeast(version: string | null | undefined, wanted: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) return false;
  const want = wanted.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = Number(match[i + 1]) - want[i];
    if (diff) return diff > 0;
  }
  return true;
}

/**
 * 任一已连接的扩展是新版就给完整能力;具体作业落到旧版连接时再逐个拒绝。
 * 没有连接(断开、重连中、扩展刚刷新)时也按完整能力报:能力未知不等于不支持,
 * 否则截图、evaluate 等会在工具层被直接拒绝,还错误地建议换专用浏览器;
 * 真正的断开由后端按作业报告(并享有重连等待)。只有全部连接都是旧版时才收窄。
 */
export function userBrowserCapabilities(
  control: UserBrowserPageControl | null,
): Readonly<Record<keyof typeof USER_BROWSER_CAPABILITIES, boolean>> {
  const clients = control?.bridge.connectedClients() ?? [];
  return clients.length === 0 || clients.some((c) => extensionSupportsParity(c.version))
    ? USER_BROWSER_PARITY_CAPABILITIES
    : USER_BROWSER_CAPABILITIES;
}

/** Connections a profile names: the exact id if there is one, else every id it is a prefix of. */
function matchProfile<T extends { id: string }>(clients: T[], profile: string): T[] {
  const exact = clients.filter((c) => c.id === profile);
  return exact.length ? exact : clients.filter((c) => c.id.startsWith(profile));
}

function actionFailed(
  action: BackendRequest['action'],
  message: string,
  errorCode: BackendResult['errorCode'] = 'BROWSER_RUNTIME_ACTION_FAILED',
): BackendResult {
  return { ok: false, action, errorCode, message };
}

function actionOk(action: BackendRequest['action'], data: unknown): BackendResult {
  return { ok: true, action, status: 200, data };
}

function unsupported(action: BackendRequest['action'], what: string): BackendResult {
  return actionFailed(
    action,
    `${what}:${USER_BROWSER_UNSUPPORTED_HINT}`,
    'BROWSER_RUNTIME_INVALID_REQUEST',
  );
}

function outdated(action: BackendRequest['action'], what: string): BackendResult {
  return actionFailed(
    action,
    `${what}需要 Cindy 浏览器扩展 ${USER_BROWSER_PARITY_VERSION} 或更新版本:请告知用户在扩展管理页更新或重新加载 Cindy 扩展;也可以改用 Cindy 专用浏览器(external),不要自行切换。`,
    'BROWSER_RUNTIME_INVALID_REQUEST',
  );
}

/** Bytes per upload that fit one job (the extension's job validation caps base64 at 40 million characters). */
const UPLOAD_BATCH_BYTES_MAX = 30_000_000;
/** One piece of a larger upload. All pieces wait in the page's memory, which bounds the whole batch. */
const UPLOAD_CHUNK_BYTES = 4_000_000;
const UPLOAD_CHUNKED_BYTES_MAX = 1024 * 1024 * 1024;
function uploadTooLarge(action: BackendRequest['action'], chunked: boolean): BackendResult {
  return actionFailed(
    action,
    chunked
      ? '上传文件总大小超过 1 GB,文件要先放进页面内存,扩展处理不了这么大。请告知用户在页面上手动选择文件,或分批上传'
      : `上传文件总大小超过约 30 MB:这个版本的 Cindy 浏览器扩展只能直接传这么多。请告知用户把扩展更新到 ${USER_BROWSER_CHUNKED_UPLOAD_VERSION} 或更新版本(之后分块传输,最大 1 GB),或分批上传`,
    'BROWSER_RUNTIME_INVALID_REQUEST',
  );
}

const UPLOAD_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const TAB_ACTION_LABEL: Partial<Record<BackendRequest['action'], string>> = {
  focus: '切换活动标签页',
  close: '关闭标签页',
  screenshot: '截图',
  console: '读取控制台',
  requests: '读取网络请求',
  responseBody: '读取网络响应',
  dialog: '处理原生弹窗',
  upload: '上传文件',
  pdf: '导出 PDF',
};

const NOT_CONFIGURED_MESSAGE =
  '没有已启用的浏览器扩展插件提供页面控制(安装并启用 Cindy Chrome 插件后再选择「我的浏览器」)。';
const DISCONNECTED_MESSAGE =
  '浏览器扩展未连接:请在用户的 Chrome / Edge 中安装并启用 Cindy 扩展,保持 Cindy 运行;连接后重新查询 status。';

const UNPAIRED_MESSAGE =
  '浏览器扩展已连到 Cindy,但还没完成配对或授权:请让用户在 Cindy Chrome 插件页确认这个浏览器,或重新启用插件后再查询 status。';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class UserBrowserBackend implements BrowserBackend {
  readonly kind = 'user-browser' as const;
  private readonly targets = new Map<string, TargetRecord>();
  private readonly recipeSessions = new RecipeBrowserSessions();
  /** 任务(会话)→ 它操作过的标签页;任务停下时清掉这些页面上的「Cindy 正在操作」标记。 */
  private readonly sessionTabs = new Map<string, Map<string, { clientId: string; tabId: number }>>();
  private readonly clientBoots = new Map<string, string>();
  /** Clients that have been fully connected before: only these are worth a reconnect wait. */
  private readonly everReady = new Set<string>();
  /** 配方会话 id → 取回扩展缓存的网络事件(事件随每条命令回传,读取抓包前再取一次)。 */
  private readonly recipePumps = new Map<string, () => Promise<void>>();
  private nextAlias = 1;
  private disposed = false;

  constructor(private readonly opts: UserBrowserBackendOptions) {}

  async call(request: BackendRequest): Promise<BackendResult> {
    if (this.disposed)
      return actionFailed(
        request.action,
        'user browser backend disposed',
        'BROWSER_RUNTIME_UNAVAILABLE',
      );
    try {
      const result = await this.dispatch(request);
      this.noteSessionTab(request, result);
      return result;
    } catch (err) {
      this.opts.logger.warn('user-browser backend call threw', {
        action: request.action,
        err: err instanceof Error ? err.message : String(err),
      });
      return actionFailed(request.action, err instanceof Error ? err.message : String(err));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.recipeSessions.dispose();
    this.targets.clear();
  }

  private noteSessionTab(request: BackendRequest, result: BackendResult): void {
    const sessionId = (request as { __mcpSessionId?: unknown }).__mcpSessionId;
    const targetId = (result.data as { targetId?: unknown } | undefined)?.targetId;
    if (!result.ok || typeof sessionId !== 'string' || !sessionId || typeof targetId !== 'string') return;
    const record = this.targets.get(targetId);
    if (!record) return;
    let tabs = this.sessionTabs.get(sessionId);
    if (!tabs) this.sessionTabs.set(sessionId, (tabs = new Map()));
    tabs.set(record.targetId, { clientId: record.clientId, tabId: record.tabId });
  }

  /** 任务停下:清掉它在用户浏览器里留下的操作标记(不等标记自然淡出)。尽力而为,失败不影响任何事。 */
  async clearSessionMarks(sessionId: string): Promise<void> {
    const tabs = this.sessionTabs.get(sessionId);
    this.sessionTabs.delete(sessionId);
    const control = this.opts.getPageControl();
    if (!tabs || !control) return;
    for (const { clientId, tabId } of tabs.values()) {
      if (!this.parity(control, clientId)) continue;
      await control.bridge.act('unmark', { browser: clientId, tabId }).catch(() => undefined);
    }
  }

  // ── 分发 ────────────────────────────────────────────────────────────────

  private async dispatch(req: BackendRequest): Promise<BackendResult> {
    switch (req.action) {
      case 'status':
        return this.handleStatus(req);
      case 'doctor':
        return this.handleStatus(req, true);
      case 'start':
        return this.handleStart(req);
      case 'stop':
        return actionOk(req.action, {
          ready: true,
          backend: this.kind,
          note: '用户浏览器由用户自己启停,Cindy 不关闭它。',
        });
      case 'profiles':
        return this.handleProfiles(req);
      case 'tabs':
        return this.handleTabs(req);
      case 'open':
      case 'navigate':
        return this.handleOpen(req);
      case 'snapshot':
        return this.handleSnapshot(req);
      case 'act':
        return this.handleAct(req);
      case 'focus':
      case 'close':
      case 'screenshot':
      case 'console':
      case 'requests':
      case 'responseBody':
      case 'dialog':
      case 'pdf':
        return this.handleTabAction(req);
      case 'upload':
        return this.handleUpload(req);
      case 'recipeCommand':
        return this.handleRecipeCommand(req);
      default:
        return actionFailed(
          req.action,
          `action '${String(req.action)}' is not supported by the user browser backend`,
          'BROWSER_RUNTIME_INVALID_REQUEST',
        );
    }
  }

  // ── 连接解析 ────────────────────────────────────────────────────────────

  private control(
    action: BackendRequest['action'],
  ): { ok: true; control: UserBrowserPageControl } | { ok: false; result: BackendResult } {
    const control = this.opts.getPageControl();
    if (!control)
      return {
        ok: false,
        result: actionFailed(action, NOT_CONFIGURED_MESSAGE, 'BROWSER_RUNTIME_NOT_CONFIGURED'),
      };
    return { ok: true, control };
  }

  private connectedClients(control: UserBrowserPageControl): BrowserExtensionClientInfo[] {
    const clients = control.bridge.connectedClients();
    this.forgetRestartedBrowsers(clients);
    for (const client of clients) if (client.connected) this.everReady.add(client.id);
    return clients;
  }

  /**
   * Tab ids start over when the browser restarts while the client id stays the same, so a
   * remembered handle could reach a tab the user restored. Forget a browser's handles once its
   * launch id changes. Older extensions send no launch id and keep the previous behaviour.
   */
  private forgetRestartedBrowsers(clients: readonly BrowserExtensionClientInfo[]): void {
    for (const client of clients) {
      if (!client.boot) continue;
      const known = this.clientBoots.get(client.id);
      this.clientBoots.set(client.id, client.boot);
      if (known === undefined || known === client.boot) continue;
      for (const [targetId, record] of this.targets)
        if (record.clientId === client.id) this.targets.delete(targetId);
      for (const tabs of this.sessionTabs.values())
        for (const [targetId, tab] of tabs) if (tab.clientId === client.id) tabs.delete(targetId);
    }
  }

  /** 这条连接的扩展是否已与专用浏览器对齐(按 tabId 寻址、提供完整动作)。 */
  private parity(control: UserBrowserPageControl, clientId: string): boolean {
    return extensionSupportsParity(
      this.connectedClients(control).find((c) => c.id === clientId)?.version,
    );
  }

  /** 对一个已登记的标签页发作业:新版扩展按 tabId 寻址;结果里的地址回写映射。 */
  private async pageJob(
    control: UserBrowserPageControl,
    record: TargetRecord,
    kind: string,
    extra: Record<string, unknown> = {},
  ): Promise<BrowserExtensionJobResult> {
    const job = await control.bridge.act(kind, {
      url: record.url,
      browser: record.clientId,
      ...(this.parity(control, record.clientId) ? { tabId: record.tabId } : {}),
      ...extra,
    });
    if (job.ok) {
      if (typeof job.url === 'string') record.url = job.url;
      if (typeof job.title === 'string') record.title = job.title;
    } else if (job.error === 'TAB_CLOSED') {
      this.targets.delete(record.targetId);
    }
    return job;
  }

  /** 选连接:显式 profile(连接 id)优先;只有一条连接时直接用;多条且未指定时拒绝,不猜账号。 */
  private pickClient(
    action: BackendRequest['action'],
    control: UserBrowserPageControl,
    profile: string | undefined,
  ): { ok: true; clientId: string } | { ok: false; result: BackendResult } {
    const clients = this.connectedClients(control);
    if (clients.length === 0)
      return {
        ok: false,
        result: actionFailed(action, DISCONNECTED_MESSAGE, 'BROWSER_RUNTIME_UNAVAILABLE'),
      };
    if (profile) {
      // An exact id wins; an abbreviation must match exactly one connection, or the action could land in
      // another signed-in browser.
      const matches = matchProfile(clients, profile);
      if (matches.length > 1)
        return {
          ok: false,
          result: actionFailed(
            action,
            `浏览器连接 ${profile} 匹配多个连接,请写得更完整;用 profiles 查看当前连接`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      const found = matches[0];
      if (!found)
        return {
          ok: false,
          result: actionFailed(
            action,
            `未找到浏览器连接 ${profile};用 profiles 查看当前连接`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      return { ok: true, clientId: found.id };
    }
    if (clients.length === 1) return { ok: true, clientId: clients[0].id };
    return {
      ok: false,
      result: actionFailed(
        action,
        `有 ${clients.length} 个浏览器连接;请用 profile 指定连接 id(见 profiles),不要猜测账号`,
        'BROWSER_RUNTIME_INVALID_REQUEST',
      ),
    };
  }

  private failureResult(
    action: BackendRequest['action'],
    job: BrowserExtensionJobResult,
  ): BackendResult {
    const error = typeof job.error === 'string' ? job.error : 'BROWSER_EXTENSION_FAILED';
    const message = typeof job.message === 'string' ? job.message : '浏览器扩展操作失败';
    const execution = job.execution;
    return {
      ok: false,
      action,
      errorCode:
        error === 'EXTENSION_DISCONNECTED' || error === 'BRIDGE_PORTS_BUSY'
          ? 'BROWSER_RUNTIME_UNAVAILABLE'
          : 'BROWSER_RUNTIME_ACTION_FAILED',
      message:
        error === 'DEBUGGER_NOT_ALLOWED' || error === 'DEBUGGER_UNAVAILABLE'
          ? `${error}:这一步需要 Chrome 的调试接口,Cindy 扩展没有这项能力(Chrome 不允许扩展按需申请)。不要重试,也不要让用户去找开启入口;请告知用户这一步可以改用 Cindy 专用浏览器(external),由用户决定,不要自行切换。`
          : `${error}:${message}`,
      data: {
        error,
        ...(typeof execution === 'string' ? { execution } : {}),
        ...(job.clients ? { clients: job.clients } : {}),
        ...(job.reason ? { reason: job.reason } : {}),
      },
    };
  }

  // ── 目标表 ──────────────────────────────────────────────────────────────

  private targetKey(clientId: string, tabId: number): string {
    // The browser launch is part of the handle: after a restart the same tab number is a different
    // tab, and an old handle the agent still holds must not resolve to it.
    const boot = this.clientBoots.get(clientId);
    const suffix = `${boot ? '.' + boot.slice(0, 8) : ''}:${tabId}`;
    // Shown abbreviated, but never shared between connections: if another connection already holds the
    // key, the connection part grows until it is unique.
    for (let n = 8; n < clientId.length; n++) {
      const key = clientId.slice(0, n) + suffix;
      const holder = this.targets.get(key);
      if (!holder || holder.clientId === clientId) return key;
    }
    return clientId + suffix;
  }

  private register(
    clientId: string,
    tab: { id: number; url: string; title?: string },
    label?: string,
  ): TargetRecord {
    const targetId = this.targetKey(clientId, tab.id);
    let record = this.targets.get(targetId);
    if (!record) {
      record = {
        targetId,
        alias: `t${this.nextAlias++}`,
        clientId,
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
      };
      this.targets.set(targetId, record);
    } else {
      record.url = tab.url;
      record.title = tab.title ?? record.title;
    }
    if (label) {
      for (const other of this.targets.values())
        if (other !== record && other.label === label) delete other.label;
      record.label = label;
    }
    return record;
  }

  private resolveTarget(id: string | undefined): TargetRecord | null {
    if (!id) return null;
    const control = this.opts.getPageControl();
    if (control) this.forgetRestartedBrowsers(control.bridge.connectedClients());
    const direct = this.targets.get(id);
    if (direct) return direct;
    for (const record of this.targets.values()) {
      if (record.alias === id || record.label === id) return record;
    }
    const prefixed = [...this.targets.values()].filter((record) => record.targetId.startsWith(id));
    return prefixed.length === 1 ? prefixed[0] : null;
  }

  private describe(record: TargetRecord): Record<string, unknown> {
    return {
      targetId: record.targetId,
      suggestedTargetId: record.label ?? record.alias,
      tabId: record.alias,
      ...(record.label ? { label: record.label } : {}),
      url: record.url,
      ...(record.title !== undefined ? { title: record.title } : {}),
      browser: record.clientId,
    };
  }

  /** 扩展按精确 URL 寻址:作业前先核对标签页仍在原 URL,不在就刷新映射并如实报告。 */
  private async locate(
    action: BackendRequest['action'],
    control: UserBrowserPageControl,
    id: string | undefined,
    profile?: string,
  ): Promise<{ ok: true; record: TargetRecord } | { ok: false; result: BackendResult }> {
    const record = this.resolveTarget(id);
    if (!record) {
      return {
        ok: false,
        result: actionFailed(
          action,
          id
            ? `未知 targetId ${id};先用 tabs 或 open 取得标签页`
            : 'targetId required(用 tabs 列出或 open 打开后再操作)',
          'BROWSER_RUNTIME_INVALID_REQUEST',
        ),
      };
    }
    // The tab belongs to one connection. A profile that names a different one is a conflict, never a
    // reason to act in another signed-in browser (or to ignore what the caller asked for).
    if (profile) {
      const named = matchProfile(this.connectedClients(control), profile);
      if (named.length !== 1 || named[0].id !== record.clientId)
        return {
          ok: false,
          result: actionFailed(
            action,
            `标签页 ${record.targetId} 属于另一个浏览器连接,和 profile ${profile} 不一致;去掉 profile 或用 tabs 重新选择`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
    }
    // 新版扩展按 tabId 寻址并自己核对标签页,不必为每个作业列一遍所有标签页。
    if (this.parity(control, record.clientId)) return { ok: true, record };
    const listed = await control.bridge.act('tabs', { browser: record.clientId, limit: 100 });
    if (listed.ok && Array.isArray(listed.tabs)) {
      const current = (
        listed.tabs as Array<{ id?: unknown; url?: unknown; title?: unknown; redacted?: boolean }>
      ).find((t) => t.id === record.tabId);
      if (!current) {
        this.targets.delete(record.targetId);
        return {
          ok: false,
          result: actionFailed(
            action,
            `标签页 ${record.targetId} 已关闭;用 tabs 重新选择`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      }
      if (current.redacted) {
        return {
          ok: false,
          result: actionFailed(
            action,
            `标签页 ${record.targetId} 当前页面无法读取(不是网页或文档不可访问)`,
            'BROWSER_RUNTIME_INVALID_REQUEST',
          ),
        };
      }
      if (typeof current.url === 'string' && current.url !== record.url) {
        const previous = record.url;
        record.url = current.url;
        record.title = typeof current.title === 'string' ? current.title : record.title;
        return {
          ok: false,
          result: {
            ...actionFailed(
              action,
              `PAGE_CHANGED:标签页已从 ${previous} 跳转到 ${current.url};先 snapshot 再继续,不要沿用旧 ref`,
              'BROWSER_RUNTIME_ACTION_FAILED',
            ),
            data: { error: 'PAGE_CHANGED', ...this.describe(record) },
          },
        };
      }
    }
    return { ok: true, record };
  }

  // ── 各 action ───────────────────────────────────────────────────────────

  private async handleStatus(req: BackendRequest, doctor = false): Promise<BackendResult> {
    const control = this.opts.getPageControl();
    if (!control) {
      return actionOk(req.action, {
        ready: false,
        backend: this.kind,
        running: false,
        configured: false,
        message: NOT_CONFIGURED_MESSAGE,
        capabilities: userBrowserCapabilities(null),
      });
    }
    let status = await control.bridge.status();
    // Right after an extension reload or update it reconnects within seconds: wait briefly before
    // reporting "not connected", so the agent does not give up on a browser that is coming back.
    const deadline = (this.opts.now ?? Date.now)() + (this.opts.reconnectWaitMs ?? 8000);
    // Only an extension that was connected before (now dropped) is worth waiting for. One that never
    // finished connecting, such as an unpaired install, is reported at once with its own reason.
    if (status.ok) for (const c of status.clients) if (c.connected) this.everReady.add(c.id);
    while (
      status.ok &&
      status.clients.some((c) => this.everReady.has(c.id)) &&
      !status.clients.some((c) => c.connected) &&
      (this.opts.now ?? Date.now)() < deadline
    ) {
      await sleep(500);
      status = await control.bridge.status();
    }
    if (!status.ok) {
      return actionOk(req.action, {
        ready: false,
        backend: this.kind,
        running: false,
        configured: true,
        plugin: control.ghostId,
        error: status.error,
        message: status.message,
        capabilities: userBrowserCapabilities(null),
      });
    }
    const clients = status.clients
      .filter((c) => c.connected)
      .map((c) => ({
        id: c.id,
        browser: c.browser,
        version: c.version,
        protocolVersion: c.protocolVersion,
        fullFeatures: extensionSupportsParity(c.version),
      }));
    const outdatedClients = clients.filter((c) => !c.fullFeatures);
    // Installed and reaching Cindy, but not allowed in yet: say so instead of "install the extension".
    const unpaired = clients.length === 0 && status.clients.some((c) => !c.trusted);
    return actionOk(req.action, {
      ready: clients.length > 0,
      running: clients.length > 0,
      backend: this.kind,
      configured: true,
      plugin: control.ghostId,
      pluginName: control.pluginName,
      connected: clients.length > 0,
      clients,
      ...(clients.length === 0 ? { message: unpaired ? UNPAIRED_MESSAGE : DISCONNECTED_MESSAGE } : {}),
      ...(unpaired ? { reason: 'pairing-required' } : {}),
      ...(outdatedClients.length
        ? {
            updateNote: `有 ${outdatedClients.length} 个连接的 Cindy 扩展低于 ${USER_BROWSER_PARITY_VERSION},只支持基础读取与交互;更新扩展后可用截图、上传、页面脚本等完整能力。`,
          }
        : {}),
      capabilities: userBrowserCapabilities(control),
      note: '用户自己的浏览器:新页面开在 Cindy 的后台窗口里,不抢焦点;不要关闭、重排或切换用户自己的标签页,除非任务需要。',
      ...(doctor
        ? {
            port: status.port,
            extensionIds: status.extension_ids,
            pending: status.pending,
            targets: this.targets.size,
          }
        : {}),
    });
  }

  private async handleStart(req: BackendRequest): Promise<BackendResult> {
    if (req.proxyServer !== undefined || req.proxyAllowedHostnames !== undefined) {
      return actionFailed(
        req.action,
        '用户浏览器执行端不支持指定代理;需要代理时改用 Cindy 专用浏览器',
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    }
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const clients = this.connectedClients(gate.control);
    if (clients.length === 0)
      return actionFailed(req.action, DISCONNECTED_MESSAGE, 'BROWSER_RUNTIME_UNAVAILABLE');
    return actionOk(req.action, { ready: true, backend: this.kind, connected: true });
  }

  private handleProfiles(req: BackendRequest): BackendResult {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const profiles = this.connectedClients(gate.control).map((c) => ({
      id: c.id,
      name: c.id,
      browser: c.browser,
      version: c.version,
      connected: c.connected,
    }));
    return actionOk(req.action, {
      backend: this.kind,
      profiles,
      note: 'profile 是浏览器连接 id;同一浏览器的多个用户配置各是一条连接。它不携带按站点的登录信号。',
    });
  }

  private async handleTabs(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const connected = this.connectedClients(gate.control);
    // Same matching as every other action: an exact id wins, an abbreviation must be unique.
    const clients = req.profile ? matchProfile(connected, req.profile) : connected;
    if (req.profile && clients.length > 1)
      return actionFailed(
        req.action,
        `浏览器连接 ${req.profile} 匹配多个连接,请写得更完整;用 profiles 查看当前连接`,
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    if (clients.length === 0 && req.profile && connected.length > 0)
      return actionFailed(
        req.action,
        `未找到浏览器连接 ${req.profile};用 profiles 查看当前连接`,
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    if (clients.length === 0)
      return actionFailed(req.action, DISCONNECTED_MESSAGE, 'BROWSER_RUNTIME_UNAVAILABLE');
    const tabs: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    // Only a complete listing proves a remembered tab is gone; a truncated one (many tabs, size
    // budget) would otherwise turn a tab the agent just opened into an unknown targetId.
    const complete = new Set<string>();
    for (const client of clients) {
      const listed = await gate.control.bridge.act('tabs', {
        browser: client.id,
        limit: Math.min(100, Math.max(1, req.limit ?? 50)),
      });
      if (!listed.ok) return this.failureResult(req.action, listed);
      if (listed.truncated !== true) complete.add(client.id);
      for (const tab of (Array.isArray(listed.tabs) ? listed.tabs : []) as Array<
        Record<string, unknown>
      >) {
        if (typeof tab.id !== 'number') continue;
        if (tab.redacted || typeof tab.url !== 'string') {
          // Still open, only its details are withheld: keep any remembered handle.
          seen.add(this.targetKey(client.id, tab.id));
          tabs.push({
            targetId: this.targetKey(client.id, tab.id),
            redacted: true,
            browser: client.id,
            ...(tab.status ? { status: tab.status } : {}),
            ...(tab.error ? { error: tab.error } : {}),
          });
          continue;
        }
        const record = this.register(client.id, {
          id: tab.id,
          url: tab.url,
          title: typeof tab.title === 'string' ? tab.title : undefined,
        });
        seen.add(record.targetId);
        tabs.push({
          ...this.describe(record),
          active: tab.active === true,
          ...(tab.status ? { status: tab.status } : {}),
        });
      }
    }
    // 已关闭的标签页从映射里清掉,别名不复用。
    for (const [targetId, record] of this.targets) {
      if (complete.has(record.clientId) && !seen.has(targetId)) this.targets.delete(targetId);
    }
    return actionOk(req.action, {
      backend: this.kind,
      tabs,
      note: '这些是用户浏览器里当前打开的标签页;只在需要时操作,不要关闭或重排它们。',
    });
  }

  /** open / navigate:扩展按 URL 复用或新开后台标签页并等待加载;结果映射为 targetId。 */
  private async handleOpen(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const url =
      typeof req.url === 'string'
        ? req.url
        : typeof req.targetUrl === 'string'
          ? req.targetUrl
          : undefined;
    if (!url) return actionFailed(req.action, 'url required', 'BROWSER_RUNTIME_INVALID_REQUEST');
    const existing = req.action === 'navigate' ? this.resolveTarget(req.targetId) : null;
    // An explicit target that no longer resolves (closed, mistyped, or gone after a browser restart) is
    // an error: navigating nothing and opening a new tab would let the agent think the old one moved.
    if (req.action === 'navigate' && req.targetId && !existing)
      return actionFailed(
        req.action,
        `标签页 ${req.targetId} 已不存在或已失效;用 tabs 重新选择 targetId`,
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    const picked = this.pickClient(req.action, gate.control, req.profile ?? existing?.clientId);
    if (!picked.ok) return picked.result;
    // The target tab belongs to one connection; a profile naming another would open the page there
    // while the tab the agent meant never moves.
    if (existing && existing.clientId !== picked.clientId)
      return actionFailed(
        req.action,
        `标签页 ${req.targetId} 属于另一个浏览器连接,和 profile ${req.profile} 不一致;去掉 profile 或用 tabs 重新选择`,
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    const label = typeof req.label === 'string' ? req.label : undefined;
    if (this.parity(gate.control, picked.clientId)) {
      // navigate 带 targetId:在原标签页跳转;否则新页开在 Cindy 自己的后台窗口,不碰用户的窗口。
      const job =
        existing && existing.clientId === picked.clientId
          ? await this.pageJob(gate.control, existing, 'navigate', { url })
          : await gate.control.bridge.act('open', { url, browser: picked.clientId });
      if (!job.ok) return this.failureResult(req.action, job);
      if (typeof job.tabId !== 'number')
        return actionFailed(req.action, '扩展没有返回标签页;用 tabs 重新选择 targetId');
      const record = this.register(
        picked.clientId,
        {
          id: job.tabId,
          url: typeof job.url === 'string' ? job.url : url,
          title: typeof job.title === 'string' ? job.title : undefined,
        },
        label,
      );
      return actionOk(req.action, { backend: this.kind, ...this.describe(record) });
    }
    const navigated = await gate.control.bridge.act('navigate', { url, browser: picked.clientId });
    if (!navigated.ok) return this.failureResult(req.action, navigated);
    const actualUrl = typeof navigated.url === 'string' ? navigated.url : url;
    const listed = await gate.control.bridge.act('tabs', { browser: picked.clientId, limit: 100 });
    const tab =
      listed.ok && Array.isArray(listed.tabs)
        ? (
            listed.tabs as Array<{
              id?: unknown;
              url?: unknown;
              title?: unknown;
              redacted?: boolean;
            }>
          ).find(
            (t) =>
              !t.redacted && typeof t.id === 'number' && (t.url === actualUrl || t.url === url),
          )
        : undefined;
    if (!tab || typeof tab.id !== 'number' || typeof tab.url !== 'string') {
      return {
        ...actionOk(req.action, {
          backend: this.kind,
          url: actualUrl,
          note: '页面已打开,但未能在标签页列表里定位到它;用 tabs 重新选择 targetId。',
        }),
      };
    }
    const record = this.register(
      picked.clientId,
      { id: tab.id, url: tab.url, title: typeof tab.title === 'string' ? tab.title : undefined },
      label,
    );
    return actionOk(req.action, {
      backend: this.kind,
      ...this.describe(record),
      ...(existing && existing.targetId !== record.targetId
        ? {
            replacedTargetId: existing.targetId,
            note: '扩展按 URL 寻址:导航落在一个(新的或复用的)标签页上,后续请用返回的 targetId。',
          }
        : {}),
    });
  }

  private async handleSnapshot(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const located = await this.locate(req.action, gate.control, req.targetId, req.profile);
    if (!located.ok) return located.result;
    // From this version a snapshot already includes what every iframe shows, and refs work across them.
    const framesIncluded = extensionAtLeast(
      this.connectedClients(gate.control).find((c) => c.id === located.record.clientId)?.version,
      USER_BROWSER_FRAMES_VERSION,
    );
    if (req.frame && !framesIncluded) return unsupported(req.action, '按 frame 快照');
    const maxChars = Math.min(30000, Math.max(256, req.maxChars ?? 6000));
    const job = await this.pageJob(gate.control, located.record, 'snapshot', {
      maxChars,
      ...(framesIncluded && typeof req.limit === 'number' ? { limit: Math.min(req.limit, 500) } : {}),
      ...(typeof req.selector === 'string' ? { selector: req.selector } : {}),
    });
    if (!job.ok) return this.failureResult(req.action, job);
    const record = located.record;
    const elementLines: string[] = [];
    for (const line of String(job.elements ?? '').split('\n')) {
      const match = /^\[([a-f0-9]{32})\] (\S+) ?(.*)$/.exec(line);
      if (!match) continue;
      const [, ref, role, name] = match;
      elementLines.push(`- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]`);
    }
    // maxChars bounds the whole observation: action refs come first, page text gets what is left, and
    // interactive:true returns refs only. Refs live in the snapshot lines alone (no duplicate map).
    const head = record.title ? `# ${record.title}` : '';
    let elementsBlock = elementLines.length ? ['', '## interactive', ...elementLines].join('\n') : '';
    let cut = job.truncated === true;
    if (elementsBlock.length > maxChars) {
      elementsBlock = elementsBlock.slice(0, elementsBlock.lastIndexOf('\n', maxChars));
      cut = true;
    }
    let text = req.interactive === true ? '' : typeof job.text === 'string' ? job.text : '';
    // Two newlines join title, text and refs.
    const textBudget = Math.max(0, maxChars - head.length - elementsBlock.length - 2);
    if (text.length > textBudget) {
      text = text.slice(0, textBudget);
      cut = true;
    }
    const snapshot = [head, text, elementsBlock].filter(Boolean).join('\n');
    const lines = snapshot.split('\n');
    const refCount = (elementsBlock.match(/\[ref=/g) ?? []).length;
    return actionOk(req.action, {
      format: 'ai',
      backend: this.kind,
      targetId: record.targetId,
      url: record.url,
      ...(record.title ? { title: record.title } : {}),
      snapshot,
      stats: { lines: lines.length, chars: snapshot.length, refs: refCount, interactive: refCount },
      truncated: cut,
      ...(cut
        ? { note: '快照被截断,后面还有内容:加大 maxChars / limit,或用 selector 限定区域(例如 [role=main])后再读。没读到不代表页面上没有。' }
        : {}),
      ...(req.frame ? { frameNote: '这里的快照已包含所有 iframe 的内容,不需要 frame 参数;ref 可直接用于操作。' } : {}),
      untrusted_content: true,
    });
  }

  private async handleAct(req: BackendRequest): Promise<BackendResult> {
    const request = req.request;
    if (!request)
      return actionFailed(req.action, 'act requires request', 'BROWSER_RUNTIME_INVALID_REQUEST');
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const targetId = request.targetId ?? req.targetId;
    if (
      request.kind === 'wait' &&
      typeof request.timeMs === 'number' &&
      !request.selector &&
      !request.loadState &&
      !request.url &&
      !request.text &&
      !request.textGone &&
      !request.fn
    ) {
      await sleep(Math.min(30000, Math.max(0, request.timeMs)));
      return actionOk(req.action, {
        backend: this.kind,
        kind: 'wait',
        waitedMs: Math.min(30000, Math.max(0, request.timeMs)),
      });
    }
    const located = await this.locate(req.action, gate.control, targetId, req.profile);
    if (!located.ok) return located.result;
    const record = located.record;
    const control = gate.control;
    const parity = this.parity(control, record.clientId);
    const done = (job: BrowserExtensionJobResult, extra: Record<string, unknown> = {}) =>
      job.ok
        ? actionOk(req.action, {
            backend: this.kind,
            targetId: record.targetId,
            kind: request.kind,
            execution: job.execution ?? 'executed',
            url: record.url,
            ...(job.note ? { note: job.note } : {}),
            ...extra,
          })
        : this.failureResult(req.action, job);
    const pointerExtra = {
      ...(request.button ? { button: request.button } : {}),
      ...(request.doubleClick ? { doubleClick: true } : {}),
      ...(request.modifiers?.length ? { modifiers: request.modifiers } : {}),
    };
    switch (request.kind) {
      case 'click':
      case 'hover':
      case 'press':
      case 'select':
      case 'type':
      case 'fill': {
        if (request.query) return unsupported(req.action, '语义元素查询(query)');
        if (
          request.kind === 'click' &&
          (request.doubleClick ||
            (request.button && request.button !== 'left') ||
            request.modifiers?.length ||
            request.x !== undefined)
        ) {
          // 双击、右键、修饰键与坐标点击都走合成指针事件;元素点在它的中心。
          if (!parity) return outdated(req.action, '双击、右键、修饰键或坐标点击');
          const job = await this.pageJob(control, record, 'clickCoords', {
            ...(request.ref ? { ref: request.ref } : {}),
            ...(request.selector ? { selector: request.selector } : {}),
            ...(request.x !== undefined ? { x: request.x, y: request.y } : {}),
            ...pointerExtra,
          });
          return done(job);
        }
        if (
          (request.kind === 'type' || request.kind === 'fill') &&
          typeof request.text !== 'string'
        ) {
          return actionFailed(
            req.action,
            'type/fill requires text',
            'BROWSER_RUNTIME_INVALID_REQUEST',
          );
        }
        const kind = request.kind === 'fill' ? 'type' : request.kind;
        const job = await this.pageJob(control, record, kind, {
          ...(request.ref ? { ref: request.ref } : {}),
          ...(request.selector ? { selector: request.selector } : {}),
          ...(typeof request.text === 'string' ? { text: request.text } : {}),
          ...(request.submit ? { submit: true } : {}),
          ...(request.key ? { key: request.key } : {}),
          ...(request.values ? { values: request.values } : {}),
        });
        return done(job);
      }
      case 'wait':
        return parity
          ? this.handleWaitInPage(req, record, control)
          : this.handleWait(req, record, control.bridge);
      case 'evaluate': {
        const domRead = (req.request as { domRead?: unknown }).domRead;
        if (domRead || !parity) return this.handleDomRead(req, record, control);
        if (typeof request.fn !== 'string' || !request.fn.trim())
          return actionFailed(req.action, 'evaluate.fn required', 'BROWSER_RUNTIME_INVALID_REQUEST');
        const job = await this.pageJob(control, record, 'evaluate', { fn: request.fn });
        const as = (request as { as?: unknown }).as;
        return done(job, {
          ...(typeof as === 'string' ? { as } : {}),
          result: job.result,
          untrusted_content: true,
        });
      }
      case 'clickCoords': {
        if (!parity) return outdated(req.action, '坐标点击');
        const job = await this.pageJob(control, record, 'clickCoords', {
          x: request.x,
          y: request.y,
          ...pointerExtra,
        });
        return done(job);
      }
      case 'drag': {
        if (!parity) return outdated(req.action, '拖拽');
        if (!request.startRef || !request.endRef)
          return actionFailed(req.action, 'drag requires startRef and endRef', 'BROWSER_RUNTIME_INVALID_REQUEST');
        const job = await this.pageJob(control, record, 'drag', {
          startRef: request.startRef,
          endRef: request.endRef,
        });
        return done(job);
      }
      case 'resize': {
        if (!parity) return outdated(req.action, '调整窗口大小');
        const job = await this.pageJob(control, record, 'resize', {
          width: request.width,
          height: request.height,
        });
        return done(job, { width: job.width, height: job.height });
      }
      case 'close': {
        if (!parity) return outdated(req.action, '关闭标签页');
        const job = await this.pageJob(control, record, 'close');
        if (job.ok) this.targets.delete(record.targetId);
        return done(job);
      }
      case 'saveResource':
        return unsupported(req.action, `act:${request.kind}`);
      default:
        return actionFailed(
          req.action,
          `unsupported act kind ${String(request.kind)}`,
          'BROWSER_RUNTIME_INVALID_REQUEST',
        );
    }
  }

  /** 新版扩展在页面里轮询等待条件;wait.fn 由这里轮询页面脚本。 */
  private async handleWaitInPage(
    req: BackendRequest,
    record: TargetRecord,
    control: UserBrowserPageControl,
  ): Promise<BackendResult> {
    const request = req.request!;
    const timeoutMs = Math.min(120000, Math.max(100, request.timeoutMs ?? 30000));
    const now = this.opts.now ?? Date.now;
    const started = now();
    const result = (extra: Record<string, unknown> = {}) =>
      actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        kind: 'wait',
        url: record.url,
        waitedMs: now() - started,
        ...extra,
      });
    const conditions = {
      ...(request.selector ? { selector: request.selector } : {}),
      ...(typeof request.text === 'string' ? { text: request.text } : {}),
      ...(request.textGone ? { textGone: request.textGone } : {}),
      ...(request.url ? { urlIncludes: request.url } : {}),
      ...(request.loadState ? { loadState: request.loadState } : {}),
    };
    const hasConditions = Object.keys(conditions).length > 0;
    if (!hasConditions && typeof request.timeMs !== 'number' && !request.fn)
      return actionFailed(
        req.action,
        'wait requires selector、text、textGone、url、loadState、fn 或 timeMs',
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    if (hasConditions || typeof request.timeMs === 'number') {
      const job = await this.pageJob(control, record, 'wait', {
        ...conditions,
        ...(typeof request.timeMs === 'number'
          ? { timeMs: Math.min(120000, Math.max(0, request.timeMs)) }
          : {}),
        timeoutMs,
      });
      if (!job.ok) return this.failureResult(req.action, job);
    }
    if (!request.fn) return result();
    // fn gets its own full wait after the other conditions, as in Cindy's dedicated browser.
    const deadline = now() + timeoutMs;
    for (;;) {
      const job = await this.pageJob(control, record, 'evaluate', { fn: request.fn });
      if (!job.ok) return this.failureResult(req.action, job);
      if (job.result) return result({ result: job.result });
      if (now() >= deadline)
        return actionFailed(req.action, `等待 ${timeoutMs}ms 后 wait.fn 仍未返回真值`);
      await sleep(250);
    }
  }

  /** 标签页级动作:截图、切换、关闭、控制台、网络与弹窗。 */
  private async handleTabAction(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const located = await this.locate(req.action, gate.control, req.targetId, req.profile);
    if (!located.ok) return located.result;
    const record = located.record;
    if (!this.parity(gate.control, record.clientId))
      return outdated(req.action, TAB_ACTION_LABEL[req.action] ?? req.action);
    let extra: Record<string, unknown> = {};
    switch (req.action) {
      case 'screenshot':
        // 整页、元素与用户窗口里的后台标签由扩展按需借用调试完成;未授权时扩展退回可视区域并说明。
        extra = {
          type: req.type === 'jpeg' ? 'jpeg' : 'png',
          ...(req.fullPage ? { fullPage: true } : {}),
          ...(req.ref ? { ref: req.ref } : {}),
        };
        break;
      case 'requests':
        extra = {
          ...(typeof req.filter === 'string' ? { filter: req.filter } : {}),
          ...(req.clear ? { clear: true } : {}),
        };
        break;
      case 'responseBody':
        if (typeof req.url !== 'string' || !req.url.trim())
          return actionFailed(req.action, 'responseBody.url required', 'BROWSER_RUNTIME_INVALID_REQUEST');
        extra = {
          requestUrl: req.url,
          ...(req.maxChars ? { maxChars: Math.min(30000, Math.max(256, req.maxChars)) } : {}),
        };
        break;
      case 'dialog':
        extra = {
          ...(typeof req.accept === 'boolean' ? { accept: req.accept } : {}),
          ...(typeof req.promptText === 'string' ? { promptText: req.promptText } : {}),
        };
        break;
    }
    const job = await this.pageJob(gate.control, record, req.action, extra);
    if (!job.ok) return this.failureResult(req.action, job);
    const base = { backend: this.kind, targetId: record.targetId };
    switch (req.action) {
      case 'close':
        this.targets.delete(record.targetId);
        return actionOk(req.action, base);
      case 'focus':
        return actionOk(req.action, {
          ...base,
          note:
            '已在 Chrome 的 Cindy 窗口里切到这一页(不抢焦点,浏览器图标会闪动提醒):需要用户亲手操作(例如登录)时,请告诉用户切到那个窗口完成,完成后再继续。',
        });
      case 'screenshot':
      case 'pdf':
        return actionOk(req.action, {
          ...base,
          mimeType: job.mimeType,
          data: job.data,
          bytes: job.bytes,
          ...(job.note ? { note: job.note } : {}),
        });
      case 'console':
        return actionOk(req.action, {
          ...base,
          messages: Array.isArray(job.messages) ? job.messages : [],
          ...(job.note ? { note: job.note } : {}),
          untrusted_content: true,
        });
      case 'requests':
        return actionOk(req.action, {
          ...base,
          requests: Array.isArray(job.requests) ? job.requests : [],
          ...(job.truncated ? { truncated: true } : {}),
          ...(job.note ? { note: job.note } : {}),
          untrusted_content: true,
        });
      case 'responseBody':
        return actionOk(req.action, { ...base, response: job.response, untrusted_content: true });
      default:
        return actionOk(req.action, {
          ...base,
          ...(job.armed !== undefined ? { armed: job.armed } : {}),
          ...(Array.isArray(job.recent) ? { recent: job.recent } : {}),
          ...(job.note ? { note: job.note } : {}),
        });
    }
  }

  /**
   * 配方适配器的原始协议命令:扩展按需接上调试(需用户授权一次),会话结束或闲置即断开。
   * 网络事件缓存在扩展里,随每条命令的结果回传;读取抓包前再主动取一次。
   */
  private async handleRecipeCommand(req: BackendRequest): Promise<BackendResult> {
    const command = req.recipeCommand;
    if (!command || !req.targetId)
      return actionFailed(
        req.action,
        'recipeCommand requires an explicit targetId and command',
        'BROWSER_RUNTIME_INVALID_REQUEST',
      );
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const located = await this.locate(req.action, gate.control, req.targetId, req.profile);
    if (!located.ok) return located.result;
    const record = located.record;
    const control = gate.control;
    if (!this.parity(control, record.clientId)) return outdated(req.action, '配方适配器的浏览器协议命令');
    const sessionKey = (req as { __mcpSessionId?: unknown }).__mcpSessionId;
    const scope = JSON.stringify([
      typeof sessionKey === 'string' ? sessionKey : '',
      req.profile ?? '',
      record.targetId,
    ]);
    if (command.method !== 'Cindy.begin') {
      if (command.method === 'Cindy.captureRead')
        await this.recipePumps.get(command.sessionId ?? '')?.();
      return actionOk(
        req.action,
        await this.recipeSessions.call(scope, command.sessionId ?? '', command.method, command.params),
      );
    }
    const begun = await this.pageJob(control, record, 'cdp', { op: 'begin' });
    if (!begun.ok) return this.failureResult(req.action, begun);
    const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
    const closers = new Set<() => void>();
    const deliver = (job: BrowserExtensionJobResult) => {
      const events = Array.isArray(job.events) ? (job.events as Array<[string, Record<string, unknown>]>) : [];
      for (const [method, params] of events) for (const listener of listeners) listener(method, params);
      if (!job.ok && (job.error === 'DEBUGGER_DETACHED' || job.error === 'TAB_CLOSED'))
        for (const close of [...closers]) close();
    };
    let sessionId = '';
    sessionId = this.recipeSessions.begin(scope, {
      send: async (method, params) => {
        const job = await this.pageJob(control, record, 'cdp', {
          op: 'command',
          method,
          params: params ?? {},
        });
        deliver(job);
        if (!job.ok) throw new Error(`${String(job.error)}:${String(job.message ?? '')}`);
        return job.result;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose: (listener) => {
        closers.add(listener);
        return () => closers.delete(listener);
      },
      dispose: () => {
        this.recipePumps.delete(sessionId);
        void this.pageJob(control, record, 'cdp', { op: 'end' }).catch(() => {});
      },
    });
    this.recipePumps.set(sessionId, async () => deliver(await this.pageJob(control, record, 'cdp', { op: 'events' })));
    return actionOk(req.action, { sessionId });
  }

  /** 上传:按会话允许的目录解析本地文件,读成字节交给扩展放进页面的文件输入框。 */
  private async handleUpload(req: BackendRequest): Promise<BackendResult> {
    const gate = this.control(req.action);
    if (!gate.ok) return gate.result;
    const located = await this.locate(req.action, gate.control, req.targetId, req.profile);
    if (!located.ok) return located.result;
    const record = located.record;
    if (!this.parity(gate.control, record.clientId)) return outdated(req.action, '上传文件');
    const sessionId = (req as { __mcpSessionId?: unknown }).__mcpSessionId;
    const roots =
      typeof sessionId === 'string' && sessionId && this.opts.resolveUploadRoots
        ? await this.opts.resolveUploadRoots(sessionId)
        : [];
    const paths = await resolveUploadFiles(req.paths, roots, UPLOAD_CHUNKED_BYTES_MAX);
    let total = 0;
    for (const file of paths) total += (await fs.stat(file)).size;
    const chunked = extensionAtLeast(
      this.connectedClients(gate.control).find((c) => c.id === record.clientId)?.version,
      USER_BROWSER_CHUNKED_UPLOAD_VERSION,
    );
    const ref = req.inputRef ?? req.ref;
    const inputTarget = ref ? { ref } : req.selector ? { selector: req.selector } : { selector: 'input[type=file]' };
    if (total > UPLOAD_BATCH_BYTES_MAX) {
      if (!chunked || total > UPLOAD_CHUNKED_BYTES_MAX) return uploadTooLarge(req.action, chunked);
      return this.uploadInChunks(req, gate.control, record, inputTarget, paths, roots);
    }
    const files: Array<{ name: string; data: string; mimeType: string }> = [];
    let read = 0;
    for (const file of paths) {
      // Read from the descriptor that was checked, so a file swapped for a link after the check
      // cannot pull bytes from outside the allowed roots. One file at a time bounds memory.
      const bytes = readRecipeInputFileSync(file, roots);
      read += bytes.length;
      if (read > UPLOAD_BATCH_BYTES_MAX) return uploadTooLarge(req.action, chunked);
      files.push({
        name: path.basename(file),
        data: bytes.toString('base64'),
        mimeType: UPLOAD_MIME[path.extname(file).toLowerCase()] ?? '',
      });
    }
    const job = await this.pageJob(gate.control, record, 'upload', { ...inputTarget, files });
    if (!job.ok) return this.failureResult(req.action, job);
    return actionOk(req.action, {
      backend: this.kind,
      targetId: record.targetId,
      files: job.files,
    });
  }

  /** 超过一个作业放得下的文件分块交给扩展,全部到齐后才放进页面的文件输入框。 */
  private async uploadInChunks(
    req: BackendRequest,
    control: UserBrowserPageControl,
    record: TargetRecord,
    inputTarget: { ref?: string; selector?: string },
    paths: string[],
    roots: string[],
  ): Promise<BackendResult> {
    const transfer = randomUUID();
    const step = (extra: Record<string, unknown>) =>
      this.pageJob(control, record, 'upload', { ...inputTarget, transfer, ...extra });
    const begun = await step({
      op: 'begin',
      chunkFiles: paths.map((file) => ({
        name: path.basename(file),
        mimeType: UPLOAD_MIME[path.extname(file).toLowerCase()] ?? '',
      })),
    });
    if (!begun.ok) return this.failureResult(req.action, begun);
    const buffer = Buffer.alloc(UPLOAD_CHUNK_BYTES);
    let total = 0;
    try {
      for (const [index, file] of paths.entries()) {
        // Every piece comes from the descriptor that was checked, as with the whole-file route.
        const descriptor = openRecipeInputFileSync(file, roots, UPLOAD_CHUNKED_BYTES_MAX);
        try {
          for (let offset = 0; ; ) {
            const count = fsSync.readSync(descriptor, buffer, 0, buffer.length, offset);
            if (!count) break;
            offset += count;
            total += count;
            if (total > UPLOAD_CHUNKED_BYTES_MAX) {
              void step({ op: 'abort' }).catch(() => {});
              return uploadTooLarge(req.action, true);
            }
            const sent = await step({
              op: 'chunk',
              file: index,
              data: buffer.subarray(0, count).toString('base64'),
            });
            if (!sent.ok) {
              void step({ op: 'abort' }).catch(() => {});
              return this.failureResult(req.action, sent);
            }
          }
        } finally {
          fsSync.closeSync(descriptor);
        }
      }
    } catch (error) {
      void step({ op: 'abort' }).catch(() => {});
      throw error;
    }
    const job = await step({ op: 'finish' });
    if (!job.ok) return this.failureResult(req.action, job);
    return actionOk(req.action, {
      backend: this.kind,
      targetId: record.targetId,
      files: job.files,
    });
  }

  private async handleWait(
    req: BackendRequest,
    record: TargetRecord,
    bridge: BrowserExtensionBridge,
  ): Promise<BackendResult> {
    const request = req.request!;
    if (request.fn || request.textGone || request.text) return unsupported(req.action, 'wait.fn / wait.text / wait.textGone');
    // Older extensions run one wait condition per call; a combination would silently drop all but the
    // first, so it is refused instead.
    const conditions = [request.selector, typeof request.timeMs === 'number', request.url, request.loadState].filter(Boolean);
    if (conditions.length > 1) return unsupported(req.action, '同时组合多个 wait 条件(selector / timeMs / url / loadState)');
    const timeoutMs = Math.min(30000, Math.max(100, request.timeoutMs ?? 15000));
    const started = (this.opts.now ?? Date.now)();
    if (request.selector) {
      const job = await bridge.act('text', {
        url: record.url,
        browser: record.clientId,
        selector: request.selector,
        waitFor: request.selector,
        waitMs: Math.min(15000, timeoutMs),
        maxChars: 256,
      });
      if (!job.ok) return this.failureResult(req.action, job);
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        kind: 'wait',
        selector: request.selector,
        waitedMs: (this.opts.now ?? Date.now)() - started,
      });
    }
    if (request.loadState === 'networkidle')
      return unsupported(req.action, 'wait.loadState=networkidle(旧版扩展只能确认页面 load 完成)');
    if (request.loadState) {
      // Older extensions cannot wait inside the page: poll the tab's own load state. (Navigating to
      // the recorded address here would reload a page that was just submitted.)
      const deadline = started + timeoutMs;
      for (;;) {
        const listed = await bridge.act('tabs', { browser: record.clientId, limit: 100 });
        const current =
          listed.ok && Array.isArray(listed.tabs)
            ? (listed.tabs as Array<{ id?: unknown; url?: unknown; status?: unknown }>).find(
                (t) => t.id === record.tabId,
              )
            : undefined;
        if (current?.status === 'complete') {
          if (typeof current.url === 'string') record.url = current.url;
          return actionOk(req.action, {
            backend: this.kind,
            targetId: record.targetId,
            kind: 'wait',
            loadState: request.loadState,
            url: record.url,
          });
        }
        if ((this.opts.now ?? Date.now)() >= deadline)
          return actionFailed(req.action, `等待 ${timeoutMs}ms 后页面仍未加载完成`);
        await sleep(250);
      }
    }
    if (request.url) {
      const deadline = started + timeoutMs;
      for (;;) {
        const listed = await bridge.act('tabs', { browser: record.clientId, limit: 100 });
        const current =
          listed.ok && Array.isArray(listed.tabs)
            ? (listed.tabs as Array<{ id?: unknown; url?: unknown }>).find(
                (t) => t.id === record.tabId,
              )
            : undefined;
        if (typeof current?.url === 'string' && current.url.includes(request.url)) {
          record.url = current.url;
          return actionOk(req.action, {
            backend: this.kind,
            targetId: record.targetId,
            kind: 'wait',
            url: current.url,
          });
        }
        if ((this.opts.now ?? Date.now)() >= deadline)
          return actionFailed(
            req.action,
            `等待 ${timeoutMs}ms 后标签页仍未到达包含 ${request.url} 的地址`,
          );
        await sleep(250);
      }
    }
    if (typeof request.timeMs === 'number') {
      await sleep(Math.min(30000, Math.max(0, request.timeMs)));
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        kind: 'wait',
        waitedMs: request.timeMs,
      });
    }
    return actionFailed(
      req.action,
      'wait requires selector、loadState、url 或 timeMs',
      'BROWSER_RUNTIME_INVALID_REQUEST',
    );
  }

  /** 声明式读取(extract / login-wall);旧版扩展只支持这一种 evaluate。 */
  private async handleDomRead(
    req: BackendRequest,
    record: TargetRecord,
    control: UserBrowserPageControl,
  ): Promise<BackendResult> {
    const domRead = (
      req.request as { domRead?: { kind?: string; extract?: Record<string, unknown> } }
    ).domRead;
    if (!domRead) return outdated(req.action, '任意页面脚本(evaluate.fn)');
    const html =
      domRead.kind === 'extract' &&
      Object.values(
        ((domRead.extract as { fields?: Record<string, unknown> } | undefined)?.fields ?? {}) as Record<
          string,
          unknown
        >,
      ).some((f) => typeof f === 'object' && f !== null && (f as { type?: unknown }).type === 'html');
    if ((domRead.kind === 'login-wall' || html) && this.parity(control, record.clientId)) {
      // 页面脚本能读出扩展固定读取看不到的(密码框是否存在、html 字段);页面 CSP 禁止时再退回。
      const job = await this.pageJob(control, record, 'evaluate', {
        fn: buildDomReadSource(domRead),
      });
      if (job.ok)
        return actionOk(req.action, {
          backend: this.kind,
          targetId: record.targetId,
          url: record.url,
          result: job.result,
          untrusted_content: true,
        });
      if (job.error !== 'EVAL_BLOCKED_BY_PAGE') return this.failureResult(req.action, job);
    }
    if (
      domRead.kind === 'login-wall' &&
      extensionAtLeast(
        this.connectedClients(control).find((c) => c.id === record.clientId)?.version,
        USER_BROWSER_SENSITIVE_FIELDS_VERSION,
      )
    ) {
      // The page forbids scripts: probe the same two fields with the extension's declarative extract
      // (password and one-time-code fields are readable like any field from this version on).
      const probe = await this.pageJob(control, record, 'extract', {
        fields: {
          password: { selector: 'input[type=password]', attr: 'type' },
          code: { selector: 'input[autocomplete="one-time-code"]', attr: 'autocomplete' },
        },
      });
      if (!probe.ok) return this.failureResult(req.action, probe);
      const found = (probe.record ?? {}) as { password?: unknown; code?: unknown };
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        result: { password: found.password != null, code: found.code != null },
      });
    }
    if (domRead.kind === 'login-wall') {
      // Older extensions refuse to read password / one-time-code fields, so a declarative probe cannot
      // tell "absent" from "present but withheld". Report the check as unavailable, not a false negative.
      return actionOk(req.action, {
        backend: this.kind,
        targetId: record.targetId,
        result: { password: false, code: false, unavailable: true },
        note: '这个版本的扩展不读取密码/验证码字段,无法做登录墙检测;以快照内容判断是否需要登录。',
      });
    }
    if (domRead.kind !== 'extract' || !domRead.extract)
      return unsupported(req.action, '未知的声明式读取');
    const spec = domRead.extract as {
      from?: string;
      multiple?: boolean;
      limit?: number;
      fields: Record<string, string | { selector?: string; attr?: string; type?: string }>;
    };
    // The MCP contract resolves field selectors against `document` (or the `from`
    // container) and lets a field omit its selector to read the container itself.
    // The extension resolves them against document.body (or the row) and spells the
    // container as ':self'. Translate the document-level spellings so a whole-page
    // read (`body`, `:scope`) is not silently null.
    const mapSelector = (selector: string | undefined): string => {
      const trimmed = selector?.trim();
      if (!trimmed || trimmed === ':scope' || trimmed === ':self') return ':self';
      if (!spec.from && /^(html|body)$/i.test(trimmed)) return ':self';
      return trimmed;
    };
    const fields: Record<string, string | { selector: string; attr?: string }> = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      if (typeof field === 'string') {
        fields[name] = mapSelector(field);
        continue;
      }
      if (field.type === 'html') return unsupported(req.action, 'extract type:"html"');
      const selector = mapSelector(field.selector);
      if (field.type === 'href') fields[name] = { selector, attr: 'href' };
      else if (field.attr) fields[name] = { selector, attr: field.attr };
      else fields[name] = { selector };
    }
    // Single record: `from` is the extension's root (`selector`); it only reads
    // `from` as a row selector in multiple mode.
    const scope = spec.multiple
      ? { multiple: true as const, ...(spec.from ? { from: spec.from } : {}) }
      : spec.from
        ? { selector: spec.from }
        : {};
    const job = await this.pageJob(control, record, 'extract', {
      fields,
      ...scope,
      ...(spec.limit ? { limit: Math.min(100, Math.max(1, spec.limit)) } : {}),
      maxChars: Math.min(30000, Math.max(256, req.maxChars ?? 6000)),
    });
    if (!job.ok) {
      const error = String(job.error ?? '');
      if (error === 'INVALID_ARGS') {
        return actionOk(req.action, {
          backend: this.kind,
          targetId: record.targetId,
          result: {
            ok: false,
            error: String(job.message ?? 'invalid extract spec'),
            count: 0,
            records: [],
          },
        });
      }
      return this.failureResult(req.action, job);
    }
    const records = spec.multiple
      ? Array.isArray(job.records)
        ? job.records
        : []
      : [job.record ?? {}];
    return actionOk(req.action, {
      backend: this.kind,
      targetId: record.targetId,
      url: record.url,
      result: { ok: true, count: records.length, records },
      ...(job.truncated === true ? { truncated: true } : {}),
      ...(job.cursorFound !== undefined ? { cursorFound: job.cursorFound } : {}),
      untrusted_content: true,
    });
  }
}
