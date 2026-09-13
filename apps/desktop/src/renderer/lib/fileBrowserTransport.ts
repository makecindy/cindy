/**
 * fileBrowserTransport —— 文件浏览的 device-link 透明传输层(makerTransport 同款模式)。
 *
 * 让 useFileTree / useFileContent 等 hooks 的文件操作**按会话来源**自动切换:
 *   - 本地 / SSH remote 会话 → 原样走 window.electronAPI.fileBrowser(SSH 由
 *     main 按 remoteHostId 路由,renderer 无感)
 *   - device-link 远程会话(被控设备)→ 走 deviceLink.invoke(deviceId,
 *     'file-browser:remote-op', [{op, ...}]) 隧道,被控端 device-op 执行
 *     (含被控端自己的 SSH 二跳)
 *
 * watch 的 device 分支不走 invoke:控制端订阅 `fs-watch:<workdir>` topic
 * (被控端订阅即启 watch、退订即停;断链重连由 subscriptionRefcount replay
 * 自动恢复),事件经 onRemotePush 以与本地完全同形的 payload 到达。
 *
 * 版本偏差:老被控端没有 remote-op channel,invoke reject
 * DEVICE_LINK_CHANNEL_NOT_ALLOWED —— isDeviceTooOldError 给上层渲染
 * "对方设备版本过旧"占位用。
 */

import { createLogger } from '@/lib/logger';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';

import { gzipTextToBase64, gunzipBase64ToText } from './gzipBase64';

const log = createLogger('fileBrowserTransport');

type LocalFileBrowser = typeof window.electronAPI.fileBrowser;

const REMOTE_OP_CHANNEL = 'file-browser:remote-op';
const FILE_BROWSER_EVENT_CHANNEL = 'maker:file-browser:event';

/**
 * writeFile 压缩阈值(UTF-16 码元数,粗粒度启发式:ASCII ≈ 64KB、CJK ≈
 * 192KB UTF-8 字节)。小内容压缩收益抵不过 caps 探测 + 编码开销,走明文。
 */
const WRITE_GZIP_MIN_CHARS = 64 * 1024;

/**
 * contentGz 上帧预算(base64 纯 ASCII,字符数 = UTF-8 字节数),量纲对齐被控
 * 端读取路径的 DEVICE_READ_MAX_JSON_BYTES(1.8MB,给 2MiB 帧限留 envelope
 * 余量)。不可压缩文本 gzip+base64 会比明文膨胀 ~1.33×,不预检就发会在
 * invoke 层撞 PAYLOAD_TOO_LARGE——超预算(或压了反而不省)直接回退明文,
 * 与读取路径 encodeReadFileResult 的"编码后仍超预算 → 不用编码结果"对齐。
 */
const WRITE_GZIP_MAX_B64_CHARS = 1_800_000;

/**
 * 被控端 gzip 能力缓存(per deviceId,进程生命周期)。
 * 探测走 remote-op 的 `caps` op:新被控端 resolve `{ok:true,gzip:true}`;
 * 老被控端没有该 op,确定性 resolve `{ok:false,message:'unknown op: caps'}`
 * → 负缓存。网络类 reject 是瞬态,不缓存(本次按不支持处理,下次重探)。
 * 绝不向未确认支持的设备发 contentGz——老端会把缺失的 content 当空串写盘。
 */
const deviceGzipCaps = new Map<string, Promise<boolean>>();

function deviceSupportsGzip(deviceId: string, workdir: string): Promise<boolean> {
  const cached = deviceGzipCaps.get(deviceId);
  if (cached) return cached;
  const probe = invokeOp<{ ok: boolean; gzip?: boolean }>(deviceId, 'caps', { workdir })
    .then((r) => r?.ok === true && r.gzip === true)
    .catch(() => {
      deviceGzipCaps.delete(deviceId);
      return false;
    });
  deviceGzipCaps.set(deviceId, probe);
  return probe;
}

/**
 * 被控端 listDir 是否支持 `showIgnoredDirs`(「显示被忽略的目录」)。
 *
 * **三态**:`true` / `false` = 已探定的结论;`null` = 未知(瞬态失败) —— 调用方据此
 * 保持「还没结论」，不要把一次网络抖动落定成「对方版本过旧」并用它把开关禁用掉。
 *
 * 区分确定性「不支持」与瞬态失败：老被控端根本没有 `file-browser:remote-op`
 * channel，invoke 会被快速拒回 `CHANNEL_NOT_ALLOWED`（确定性）；隧道不可达 /
 * 重连中的 reject 与之不同，属于瞬态。
 *
 * 缓存：**只缓存肯定结论 `true`**,且带**进程级重连代次**(见下)。`false`（老端）
 * 不留在缓存里 —— 被控端在一次掉线期间升级是真实场景，缓存会把它钉在「不支持」
 * 直到重启；重探一次只是一个被快速拒绝的 invoke，代价可忽略。瞬态 `null` 同样
 * 不缓存，由调用方在连接恢复后重探。
 *
 * 与 gzip 那份缓存分开：后者带着「用出空写就永久降级」的自愈语义，两件事互不牵连。
 */

/**
 * 进程级重连代次。
 *
 * 不能拿 hook 局的 `useDeviceLinkReconnectEpoch` 当缓存依据:它是 `useState(0)`
 * 起步的 hook 局部计数器,只观察**挂载期间**的事件 —— 面板卸载 →(此时设备重连 /
 * 被回滚,没有任何 hook 看得到)→ 面板重挂载时新实例又从 0 开始,进程内的缓存却
 * 还留着上一代的肯定结论,于是跳过 caps RPC、开关一直可按。
 *
 * 所以缓存自己订阅全局 reconnect 流:模块级订阅不随面板生命周期起落(惰性建立
 * 于首次调用;测试环境没有 deviceLink 时静默跳过,代次恒 0)。任何设备恢复 online
 * 或 relay 恢复 online 都让整表代次作废 —— 重探一次 caps 很便宜,不值得按 deviceId
 * 精细区分。订阅故意常驻:它本身就是「面板不在时也要记账」的那只耳朵。
 */
let reconnectGeneration = 0;
let reconnectSubscribed = false;

function ensureReconnectSubscription(): void {
  if (reconnectSubscribed) return;
  const api = window.electronAPI?.deviceLink;
  if (!api?.onPresenceChanged || !api.onStatusChanged) return;
  reconnectSubscribed = true;
  const bump = (): void => {
    reconnectGeneration += 1;
  };
  api.onPresenceChanged((snapshot) => {
    if (snapshot.online) bump();
  });
  api.onStatusChanged(({ status }) => {
    if (status === 'online') bump();
  });
}

const deviceRevealCaps = new Map<
  string,
  { generation: number; probe: Promise<boolean | null> }
>();

/** 只回收「本次探测装上的那条」:同 deviceId 可能已因更新的代次换上新的 probe。 */
function evictRevealCapsIfCurrent(deviceId: string, generation: number): void {
  if (deviceRevealCaps.get(deviceId)?.generation === generation) {
    deviceRevealCaps.delete(deviceId);
  }
}

export function deviceSupportsRevealIgnoredDirs(
  deviceId: string,
  workdir: string,
): Promise<boolean | null> {
  ensureReconnectSubscription();
  const cached = deviceRevealCaps.get(deviceId);
  if (cached && cached.generation === reconnectGeneration) return cached.probe;
  const probeGeneration = reconnectGeneration;
  const probe = Promise.resolve()
    .then(() => invokeOp<{ ok: boolean; showIgnoredDirs?: boolean }>(deviceId, 'caps', { workdir }))
    .then((r) => {
      const supported = r?.ok === true && r.showIgnoredDirs === true;
      // 只留肯定结论；「不支持」下次重新问（被控端可能已升级）。
      if (!supported) evictRevealCapsIfCurrent(deviceId, probeGeneration);
      return supported;
    })
    .catch((err: unknown) => {
      evictRevealCapsIfCurrent(deviceId, probeGeneration);
      if (isDeviceTooOldError(err)) return false; // 老端：确定性不支持
      return null; // 瞬态：不落定，等连接恢复重探
    });
  deviceRevealCaps.set(deviceId, { generation: probeGeneration, probe });
  return probe;
}

export interface FileTreeEventPayload {
  workdir: string;
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  relPath: string;
}

/** searchCollect(device 分支的非流式搜索)返回形状。 */
export interface SearchCollectResult {
  matches: Array<{
    searchId: string;
    relPath: string;
    lineNumber: number;
    lineText: string;
    submatches: Array<{ start: number; end: number }>;
  }>;
  truncated: boolean;
  totalMatches: number;
  totalFiles: number;
}

function invokeOp<T>(deviceId: string, op: string, params: Record<string, unknown>): Promise<T> {
  return window.electronAPI.deviceLink.invoke(deviceId, REMOTE_OP_CHANNEL, [
    { op, ...params },
  ]) as Promise<T>;
}

/** 老被控端(无 remote-op channel)→ 版本过旧,上层渲染升级提示占位。 */
export function isDeviceTooOldError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('DEVICE_LINK_CHANNEL_NOT_ALLOWED') || msg.includes('CHANNEL_NOT_ALLOWED');
}

/**
 * 与 window.electronAPI.fileBrowser 同形的读写子集,按 deviceId 路由。
 * device 分支的返回形状由被控端 device-op 保证与本地 handler 逐字段一致。
 */
export function fileBrowserApiFor(deviceId: string | null | undefined): Pick<
  LocalFileBrowser,
  | 'listDir'
  | 'listAllFiles'
  | 'readFile'
  | 'writeFile'
  | 'createFile'
  | 'createFolder'
  | 'deleteEntry'
  | 'renameEntry'
  | 'stat'
> {
  if (!deviceId) return window.electronAPI.fileBrowser;
  return {
    listDir: (p) => invokeOp(deviceId, 'listDir', p),
    listAllFiles: (p) => invokeOp(deviceId, 'listAllFiles', p),
    // readFile 恒带 acceptGzip(老被控端忽略未知字段,无害);返回若为 gzip
    // 编码则在这里解回明文,上层 hooks(useFileContent 等)零感知。
    readFile: async (p) => {
      const res = await invokeOp<Awaited<ReturnType<LocalFileBrowser['readFile']>>>(
        deviceId,
        'readFile',
        { ...p, acceptGzip: true },
      );
      if (res && res.ok) {
        const data = res.data as typeof res.data & { contentEncoding?: 'gzip' };
        if (data.contentEncoding === 'gzip') {
          const rest = { ...data };
          delete rest.contentEncoding;
          return { ok: true, data: { ...rest, content: await gunzipBase64ToText(data.content) } };
        }
      }
      return res;
    },
    // 大内容且被控端确认支持 gzip → 以 contentGz 发送(明文 content 不再上帧);
    // 其余情况(小内容 / 老端 / 探测瞬断 / 压缩异常)全部回退现状明文。
    writeFile: async (p) => {
      if (p.content.length > WRITE_GZIP_MIN_CHARS && (await deviceSupportsGzip(deviceId, p.workdir))) {
        try {
          const contentGz = await gzipTextToBase64(p.content);
          // 预算预检:压缩结果超帧预算(不可压缩内容 gzip+base64 反而膨胀)
          // 就不发 contentGz,直接走明文——避免 invoke 层 PAYLOAD_TOO_LARGE
          // 后再兜底重发的浪费。
          if (contentGz.length > WRITE_GZIP_MAX_B64_CHARS) {
            return await invokeOp(deviceId, 'writeFile', p);
          }
          const rest: Record<string, unknown> = { ...p, contentGz };
          delete rest.content;
          const res = await invokeOp<Awaited<ReturnType<LocalFileBrowser['writeFile']>>>(
            deviceId,
            'writeFile',
            rest,
          );
          // 写后校验(防静默清空):caps 正缓存可能过期——被控端从新版本降级回
          // 老版本后重连,老端会把缺失的 content 当空串写盘。>64K 明文经新端
          // 正确写入后返回的 size 必然 >0,所以 ok && size===0 只可能是老端空写:
          // 立刻负缓存该设备,并用明文重发同一内容自愈,把数据丢失闸死在一次
          // 保存内(下一轮 dirty 基线也以明文重发结果为准)。
          if (res && res.ok === true && res.size === 0) {
            log.warn('gzip write landed as empty file (stale caps, target downgraded?), resending plaintext', {
              deviceId,
              relPath: p.relPath,
            });
            deviceGzipCaps.set(deviceId, Promise.resolve(false));
            return invokeOp(deviceId, 'writeFile', p);
          }
          return res;
        } catch (err) {
          // 压缩本身失败是本端环境问题,回退明文保证保存不被阻断。
          log.warn('gzip compress failed, falling back to plaintext write', {
            deviceId,
            relPath: p.relPath,
            error: String(err),
          });
        }
      }
      return invokeOp(deviceId, 'writeFile', p);
    },
    createFile: (p) => invokeOp(deviceId, 'createFile', p),
    createFolder: (p) => invokeOp(deviceId, 'createFolder', p),
    deleteEntry: (p) => invokeOp(deviceId, 'deleteEntry', p),
    renameEntry: (p) => invokeOp(deviceId, 'renameEntry', p),
    stat: (p) => invokeOp(deviceId, 'stat', p),
  };
}

/** device 分支的非流式内容搜索(useProjectSearch 消费,伪流式回放给 UI)。 */
export function deviceSearchCollect(
  deviceId: string,
  q: { workdir: string; query: string; caseSensitive: boolean; maxMatches: number },
): Promise<SearchCollectResult> {
  return invokeOp(deviceId, 'searchCollect', q);
}

/**
 * watch 启停:本地/SSH 走 fileBrowser IPC;device 走 fs-watch topic 订阅
 * (经 main 的 subscriptionRefcount,多窗口引用计数 + 断链 replay)。
 */
export async function startWatchFor(
  deviceId: string | null | undefined,
  params: {
    workdir: string;
    remoteHostId?: string | null;
    hideMetaFiles?: boolean;
    /**
     * 「显示被忽略的目录」:本地 / SSH 分支下发到 matcher 与 watcher;
     * **device 分支不传**——被控端的 watch 由 `fs-watch:<workdir>` topic
     * 订阅驱动,订阅载荷里没有过滤开关(与 hideMetaFiles 同款限制),
     * 所以被控端 watcher 仍用默认过滤:目录能列出、内部改动不推事件。
     */
    showIgnoredDirs?: boolean;
  },
): Promise<void> {
  if (!deviceId) {
    await window.electronAPI.fileBrowser.startWatch(params);
    return;
  }
  await window.electronAPI.deviceLink.subscribe(deviceId, [`fs-watch:${params.workdir}`]);
}

export async function stopWatchFor(
  deviceId: string | null | undefined,
  params: { workdir: string; remoteHostId?: string | null },
): Promise<void> {
  if (!deviceId) {
    await window.electronAPI.fileBrowser.stopWatch(params);
    return;
  }
  await window.electronAPI.deviceLink.unsubscribe(deviceId, [`fs-watch:${params.workdir}`]);
}

/**
 * 文件树变更事件订阅:本地/SSH 走 fileBrowser.onEvent;device 过滤
 * onRemotePush(deviceId + channel 匹配)。两条路的回调 payload 完全同形。
 */
export function onFileTreeEventFor(
  deviceId: string | null | undefined,
  cb: (event: FileTreeEventPayload) => void,
): () => void {
  if (!deviceId) return window.electronAPI.fileBrowser.onEvent(cb);
  return window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
    if (push.deviceId !== deviceId) return;
    if (push.channel !== FILE_BROWSER_EVENT_CHANNEL) return;
    if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
    cb(push.payload as FileTreeEventPayload);
  });
}
