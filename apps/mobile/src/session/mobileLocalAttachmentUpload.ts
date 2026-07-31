/**
 * mobileLocalAttachmentUpload.ts — 本机附件(图片 / 文件)乐观上传控制器
 * (会话页 / 新建会话页共用)。
 * ---------------------------------------------------------------------------
 * 旧链路是「压缩 + presign + PUT 全部完成后附件才进托盘」,拍照 / 选大文件后要
 * 盯着空托盘等数秒到十几秒。本控制器把链路改成乐观模式:
 *
 *   - picker 一返回,附件立刻以 pending 卡(图片=本地缩略图,文件=文件名 chip)
 *     进托盘;
 *   - 预处理(图片降采样;文件跳过)+ 上传转后台,并发上限 2(手机上行带宽是
 *     瓶颈,和 remoteMediaResolveQueue 同精神),成功后由宿主把正式 attachment 入列;
 *   - pending 期间可被 X 掉:未开跑的直接移除;已 in-flight 的任其完成,完成后
 *     经 deps.discard 回收 OSS 中转对象(上传已经发生,不回收就是孤儿);
 *   - 发送前 waitForIdle():等全部任务落定并返回期间失败数,宿主据此决定
 *     「失败了就不发、让用户看到错误」;
 *   - dispose():退屏兜底,把仍在天上的任务全部标记丢弃(完成后回收)。
 *
 * 纯逻辑模块,依赖注入(preprocess / upload / discard / 校验),node 可单测。
 */
import { i18n } from '@/i18n';
import type { RemoteSerializedAttachment } from '@/session/types';
import type { MobileImagePreprocessInput, MobileImagePreprocessOutput } from '@/session/mobileImagePreprocess';
import type { AnnotationStroke } from '@/session/imageAnnotationModel';

export type MobileLocalAttachmentKind = 'image' | 'file';

/** picker 产出的待上传本机附件(图片的 uri 同时用作托盘即时预览)。 */
export interface MobileLocalAttachmentUploadCandidate {
  kind: MobileLocalAttachmentKind;
  uri: string;
  name: string;
  mimeType?: string;
  /** 原文件字节数,0 = 未知(上传前由 statSize 兜底)。 */
  size: number;
  width?: number | null;
  height?: number | null;
  /**
   * 任务真正开跑时的异步就位钩子(相册 ph:// → file:// 换址、HEIC 转码缩边等重活)。
   * 返回的字段覆盖到 candidate 上再进后续管线;托盘预览始终用原始 uri,所以入队
   * 当帧就有缩略图,重活全在后台。
   */
  resolve?: () => Promise<Partial<Pick<
    MobileLocalAttachmentUploadCandidate,
    'uri' | 'name' | 'mimeType' | 'size' | 'width' | 'height' | 'skipPreprocess'
  >>>;
  /** resolve 阶段已完成优化编码(如 HEIC 转码+缩边),跳过 preprocess 防二次有损。 */
  skipPreprocess?: boolean;
  /**
   * 仅由明确拥有输入文件的调用方提供(当前是 WebView 粘贴落盘):
   * controller 会把 resolve / preprocess 生成的同任务临时 uri 一并交回清理。
   * 系统相册、相机与文件选择器的 uri 不设置此钩子,避免误删宿主管理的文件。
   */
  cleanupLocalUris?: (uris: readonly string[]) => Promise<void>;
  /** 宿主侧溯源 id(相册 asset.id → attachment 映射用),管线不消费。 */
  sourceId?: string;
  /**
   * 圈点标注元数据(uri 已是烧录产物时携带;管线不消费,onUploaded 原样回传,
   * 宿主据此给附件打 annotated 标并记录「矢量笔迹 + 原图」的再编辑真相)。
   */
  annotation?: {
    strokes: AnnotationStroke[];
    sourceUri: string;
    sourceMimeType: string;
  };
  /**
   * 再编辑保存的替换语义:本 candidate 上传**成功后**宿主才移除该旧附件
   * (管线不消费)。不能在入队时就删——上传可能因 token / 网络 / 超限失败,
   * 提前删会让用户新旧两头空(review P1)。
   */
  replacesAttachmentId?: string;
}

/** 托盘 pending 卡的渲染数据(image → 缩略卡;file → 文件名 chip)。 */
export interface PendingLocalAttachmentUpload {
  localId: string;
  kind: MobileLocalAttachmentKind;
  previewUri: string;
  name: string;
  /** 已知字节数(chip 显示「名称 · 大小」用;0 = 未知)。 */
  size: number;
  /** 宿主侧溯源 id(相册来源才有):面板重开时据此把上传中的资产格标 busy 禁点。 */
  sourceId?: string;
  /**
   * 上传失败(弱网 / 超时 / token 失效):卡片保留为「失败 · 可重试」态,而不是
   * 从托盘消失只留一条 toast——弱网下让用户原地重试,不用重新找图重选。
   */
  failed?: boolean;
}

export interface MobileLocalAttachmentUploadDeps {
  /** 图片上传前降采样(preprocessMobileImageForUpload);file 类任务不会调到。 */
  preprocess(input: MobileImagePreprocessInput): Promise<MobileImagePreprocessOutput>;
  /** size 未知时读本地文件字节数。 */
  statSize(uri: string): Promise<number>;
  /** 校验最终上传体积,超限时 throw;candidate 供按 kind 区分文案。 */
  assertSize(size: number, candidate: MobileLocalAttachmentUploadCandidate): void;
  /** 真正的 presign + PUT(uploadMobileAttachmentFromFile);signal 中止时应尽快断掉传输。 */
  upload(
    candidate: { name: string; size: number; mimeType?: string },
    fileUri: string,
    opts: { token: string; signal?: AbortSignal },
  ): Promise<RemoteSerializedAttachment>;
  /** 已上传但不再被引用的对象回收(discardMobileUploadedAttachment,best-effort)。 */
  discard(attachment: RemoteSerializedAttachment): void;
  /** pending 列表变化(宿主 setState 驱动托盘;已 claim 的任务不在其中)。 */
  onPendingChange(pending: readonly PendingLocalAttachmentUpload[]): void;
  /**
   * 单个上传成功(宿主把 attachment 入列、图片记录 previewUri 映射)。
   * uploadedUri = 实际 PUT 的本地文件(降采样产物;plan 为 null / 回退时等于
   * candidate.uri)——发送后气泡的本地缩略图兜底用它(比原图小一个量级)。
   * localId = 任务 id,宿主用它把已 claim 任务的产物路由给对应的乐观消息。
   */
  onUploaded(
    attachment: RemoteSerializedAttachment,
    candidate: MobileLocalAttachmentUploadCandidate,
    uploadedUri: string,
    localId: string,
    localUris: readonly string[],
    isActive: () => boolean,
  ): void | Promise<void>;
  /** 单个失败(宿主展示错误文案);已被移除 / 丢弃的任务不会回调。localId 语义同 onUploaded。 */
  onFailed(error: unknown, localId: string): void;
}

export interface MobileLocalAttachmentUploadController {
  /**
   * 把 picker 产出批量入队并立即出现在 pending 列表;后台按并发上限上传。
   * token 允许传 Promise:调用方**不要**先 await getAccessToken() 再 enqueue——那个等待窗
   * 里任务尚未入队,composer 抢发时 waitForIdle 立即返回、刚选的附件被静默丢弃(粘贴路径
   * 没有 picker modal 遮挡,窗口真实可踩)。同步段就 enqueue,token 由任务开跑时自行等待。
   */
  enqueue(
    candidates: readonly MobileLocalAttachmentUploadCandidate[],
    opts: { token: string | Promise<string | null> },
  ): void;
  /** 托盘 X:移除一个 pending;已 in-flight 的完成后自动回收 OSS 对象。 */
  remove(localId: string): void;
  /**
   * 重试一个失败态任务:重新入队跑完整管线(就位钩子 / 降采样 / presign / PUT)。
   * token 必传新鲜值——失败可能停留了很久,旧凭证大概率已过期。非失败态任务 no-op。
   */
  retry(localId: string, opts: { token: string | Promise<string | null> }): void;
  /**
   * 丢弃当前全部任务(语义同逐个 remove),controller 继续可用。
   * 场景:新建会话页切换目标电脑——上一台电脑期间发起的在途上传不能在完成后
   * 经 onUploaded 混进新电脑的草稿附件。
   */
  removeAll(): void;
  /** 等全部任务落定;返回等待期间(含此刻已 in-flight)的失败个数。 */
  waitForIdle(): Promise<{ failedCount: number }>;
  /** 当前是否还有未落定任务。 */
  hasPending(): boolean;
  /**
   * 当前未落定(非 discarded、非 claimed)任务数——**同步真源**。附件槽位校验必须读这里
   * 而不是 onPendingChange 驱动的 React state:state commit 走 macrotask,信箱
   * 串行 drain 的 await 只隔 microtask,读 state 会拿到「入队前」的旧值,多条
   * 投递仍可绕过 MOBILE_MAX_ATTACHMENTS(review P1)。
   */
  pendingCount(): number;
  /**
   * 把任务划归一条已发送的乐观消息(outbox):claimed 任务离开 composer 域——
   * 不再出现在 onPendingChange 托盘、不计入 pendingCount 限额、waitForIdle 不等它;
   * 任务本身照跑,产物经 onUploaded/onFailed 的 localId 由宿主路由给对应消息。
   * remove / retry 对 claimed 任务照常可用(outbox 条目的删除与重试复用它们)。
   */
  claim(localIds: readonly string[]): void;
  /**
   * claim 的逆操作:任务交还 composer 域(重回托盘、重新计入限额)。
   *
   * 乐观消息被收回成草稿时用(创建失败把待发消息交还输入框):任务本身继续跑,
   * 落定后宿主的 outbox 路由找不到归属条目,产物自然回落到托盘。取消再重传是错的
   * ——用户已经等过一次上传,且粘贴来源的本地文件可能已被回收(review P1)。
   */
  unclaim(localIds: readonly string[]): void;
  /**
   * 未 claim 且未丢弃任务的同步快照(顺序 = 入队序):发送时刻用它决定「这条消息
   * 要带走哪些在途上传」。failed = 已失败结算的卡(claim 后随消息进失败态);
   * kind / previewUri 供乐观消息气泡直接渲染本地缩略图(图片 = candidate.uri)。
   */
  claimableTasks(): Array<{ localId: string; failed: boolean; kind: MobileLocalAttachmentKind; previewUri: string }>;
  /** 退屏兜底:全部标记丢弃(不再回调 onUploaded/onFailed,完成后回收 OSS)。 */
  dispose(): void;
}

const MAX_CONCURRENT_UPLOADS = 2;

/**
 * iOS 模拟器没有相机:expo-image-picker 原生层不做 isSourceTypeAvailable 防护,
 * 直接 `setSourceType(.camera)` 会抛 NSInvalidArgumentException 崩掉整个进程
 * (实测崩栈:UIImagePickerController.setSourceType ← launchLegacyImagePicker)。
 * 检测走沙盒路径:模拟器 app 的 documentDirectory 必含 `/CoreSimulator/`
 * (`~/Library/Developer/CoreSimulator/Devices/...`),真机是 `/var/mobile/...`。
 * 不用 expo-constants 的 platform.ios.platform——SDK 56 原生层已只返回 buildNumber,
 * 该字段恒 undefined(类型声明滞后,实测踩过)。Android 模拟器有虚拟相机,不拦。
 */
export function isCameraUnavailableOnSimulator(
  platformOs: string,
  documentDirectory: string | null | undefined,
): boolean {
  if (platformOs !== 'ios') return false;
  return (documentDirectory ?? '').includes('/CoreSimulator/');
}

type TaskOutcome = 'uploaded' | 'failed' | 'discarded';

interface UploadTask {
  localId: string;
  candidate: MobileLocalAttachmentUploadCandidate;
  /** 上传凭证;Promise 形态 = enqueue 时 token 仍在获取中,runTask 开跑时等它就位。 */
  token: string | Promise<string | null>;
  /** failed = 上传失败但卡片保留在托盘(可 retry / remove),任务已结算不占并发位。 */
  state: 'queued' | 'running' | 'failed';
  discarded: boolean;
  /** 已划归乐观消息(outbox 域):离开托盘 / 限额 / waitForIdle,任务本身照跑。 */
  claimed: boolean;
  /** in-flight 取消通道:remove / removeAll / dispose 时 abort,真正断掉 PUT 传输。 */
  abort: AbortController;
  /** 本任务已接触的自有临时 uri；无 cleanupLocalUris 时只记账、不做删除。 */
  localUris: Set<string>;
  outcome: Promise<TaskOutcome>;
  resolveOutcome: (outcome: TaskOutcome) => void;
}

function createOutcome(): { outcome: Promise<TaskOutcome>; resolveOutcome: (outcome: TaskOutcome) => void } {
  let resolveOutcome!: (outcome: TaskOutcome) => void;
  const outcome = new Promise<TaskOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  return { outcome, resolveOutcome };
}

export function createMobileLocalAttachmentUploadController(
  deps: MobileLocalAttachmentUploadDeps,
): MobileLocalAttachmentUploadController {
  const tasks = new Map<string, UploadTask>();
  let seq = 0;
  let runningCount = 0;
  let disposed = false;

  function notifyPending(): void {
    const pending: PendingLocalAttachmentUpload[] = [];
    for (const task of tasks.values()) {
      if (task.discarded || task.claimed) continue;
      pending.push({
        localId: task.localId,
        kind: task.candidate.kind,
        previewUri: task.candidate.uri,
        name: task.candidate.name,
        size: task.candidate.size,
        sourceId: task.candidate.sourceId,
        failed: task.state === 'failed' || undefined,
      });
    }
    deps.onPendingChange(pending);
  }

  function pump(): void {
    if (runningCount >= MAX_CONCURRENT_UPLOADS) return;
    for (const task of tasks.values()) {
      if (task.state !== 'queued') continue;
      task.state = 'running';
      runningCount += 1;
      void runTask(task);
      if (runningCount >= MAX_CONCURRENT_UPLOADS) return;
    }
  }

  function cleanupTaskLocalUris(task: UploadTask, keepOriginal: boolean): void {
    const cleanup = task.candidate.cleanupLocalUris;
    if (!cleanup) return;
    const originalUri = task.candidate.uri;
    const uris = [...task.localUris].filter((uri) => !keepOriginal || uri !== originalUri);
    task.localUris = keepOriginal ? new Set([originalUri]) : new Set();
    if (uris.length > 0) void cleanup(uris).catch(() => undefined);
  }

  async function runTask(task: UploadTask): Promise<void> {
    // 先让出一拍:保证任务至少异步落定——pending 帧可见、waitForIdle 统计口径一致,
    // 同步 throw(如已知 size 的超限校验)不会在 enqueue 调用栈里就把任务清掉。
    await Promise.resolve();
    let outcome: TaskOutcome = 'failed';
    try {
      // token 先就位(可能仍在网络 refresh):拿不到就快速失败,不浪费后面的转码/降采样。
      const token = await task.token;
      if (!token) {
        throw new Error(task.candidate.kind === 'image'
          ? i18n.t('composer.upload.sessionExpiredImage')
          : i18n.t('composer.upload.sessionExpiredFile'));
      }
      // 取消检查点 1:token 等待期间被 X 掉的任务在这里短路,跳过后面的换址/转码/降采样。
      if (task.discarded) {
        outcome = 'discarded';
        return;
      }
      // 先跑 candidate 自带的就位钩子(相册换址 / HEIC 转码),结果覆盖进管线输入。
      let source = task.candidate;
      if (source.resolve) {
        source = { ...source, ...(await source.resolve()) };
      }
      task.localUris.add(source.uri);
      // 只有图片需要降采样;文件(pdf / office / 文本)与已优化产物原样直传。
      const prepared = source.kind === 'image' && !source.skipPreprocess
        ? await deps.preprocess({
          uri: source.uri,
          name: source.name,
          mimeType: source.mimeType,
          size: source.size,
          width: source.width,
          height: source.height,
        })
        : {
          uri: source.uri,
          name: source.name,
          mimeType: source.mimeType,
          size: source.size,
        };
      task.localUris.add(prepared.uri);
      const size = prepared.size > 0 ? prepared.size : await deps.statSize(prepared.uri);
      deps.assertSize(size, task.candidate);
      // 取消检查点 2:资产就位 / 降采样(大图慢路径)期间被 X 掉的任务在发起 PUT 前短路
      // ——PUT 一旦开始便不可中止,只能事后 best-effort 删除,这里拦住就不产生 OSS 孤儿风险。
      if (task.discarded) {
        outcome = 'discarded';
        return;
      }
      const attachment = await deps.upload(
        { name: prepared.name, size, mimeType: prepared.mimeType || undefined },
        prepared.uri,
        { token, signal: task.abort.signal },
      );
      if (task.discarded) {
        // 上传成功但用户已 X 掉 / 页面已退出:回收中转对象,不回调宿主。
        deps.discard(attachment);
        outcome = 'discarded';
      } else {
        // 回传就位后的 candidate(kind / sourceId 随 spread 保留):resolve 型任务
        // (相册 ph:// 换址、HEIC / 粘贴转码)实际上传的是 source.uri,宿主的预览
        // 映射要指向这个仍然在世的 file://,而不是可能被系统回收的原始临时文件。
        await deps.onUploaded(
          attachment,
          source,
          prepared.uri,
          task.localId,
          [...task.localUris],
          () => !disposed && !task.discarded,
        );
        if (disposed || task.discarded) {
          // onUploaded 可能为粘贴图片等待持久缩略图；等待期间退屏 / removeAll
          // 时不能再把附件写回旧页面，且已经上传的 OSS 对象仍须回收。
          deps.discard(attachment);
          outcome = 'discarded';
        } else {
          outcome = 'uploaded';
        }
      }
    } catch (err) {
      if (task.discarded) {
        outcome = 'discarded';
      } else {
        deps.onFailed(err, task.localId);
        outcome = 'failed';
      }
    } finally {
      if (outcome === 'failed' && !disposed) {
        // 失败卡保留在托盘(state=failed,可 retry / remove),不再从 map 删除——
        // 弱网下「图直接消失 + 一条 toast」逼用户重新找图重选,原地重试才是对的。
        // 只保留原始粘贴文件供 retry；本轮 resolve / preprocess 中间产物立即回收。
        cleanupTaskLocalUris(task, true);
        task.state = 'failed';
      } else {
        // uploaded 的成功路径由 onUploaded 在把预览换成持久缩略图后清理；
        // discarded 在这里回收全部自有临时文件。
        if (outcome === 'discarded') cleanupTaskLocalUris(task, false);
        tasks.delete(task.localId);
      }
      runningCount -= 1;
      task.resolveOutcome(outcome);
      if (!disposed && !task.discarded) notifyPending();
      pump();
    }
  }

  return {
    enqueue(candidates, opts) {
      if (disposed || candidates.length === 0) return;
      for (const candidate of candidates) {
        seq += 1;
        const localId = `local-attachment-upload-${seq}`;
        tasks.set(localId, {
          localId,
          candidate,
          token: opts.token,
          state: 'queued',
          discarded: false,
          claimed: false,
          abort: new AbortController(),
          localUris: new Set([candidate.uri]),
          ...createOutcome(),
        });
      }
      notifyPending();
      pump();
    },

    remove(localId) {
      const task = tasks.get(localId);
      if (!task || task.discarded) return;
      if (task.state === 'queued' || task.state === 'failed') {
        // 还没开跑 / 已失败结算:直接出队；自有粘贴临时文件同步进入回收队列。
        tasks.delete(task.localId);
        cleanupTaskLocalUris(task, false);
        task.resolveOutcome('discarded');
      } else {
        // 已 in-flight:标记丢弃 + abort 真正断掉传输(PUT 层监听 signal 走
        // UploadTask.cancelAsync),不再让被取消的上传白跑流量;abort 到达前
        // 已完成的场景由 runTask 末段回收 OSS 对象兜底。
        // outcome 提前落定为 discarded:waitForIdle 已快照进 Promise.all 的等待立即解除
        // ——弱网发送转圈时点 X,send() 不该继续陪被取消的上传等到 OS 超时(codex
        // review R16)。Promise 重复 resolve 幂等,runTask finally 的二次落定是 no-op。
        task.discarded = true;
        task.abort.abort();
        task.resolveOutcome('discarded');
      }
      notifyPending();
    },

    retry(localId, opts) {
      const task = tasks.get(localId);
      if (!task || task.discarded || task.state !== 'failed') return;
      // 重新入队跑完整管线;outcome 换新的一份(旧的已落定为 failed,不可复用),
      // abort 通道同理换新(上一轮超时已把旧 signal 打成 aborted),
      // token 用调用方给的新鲜值(失败卡可能停留很久,旧凭证大概率已过期)。
      const renewed = createOutcome();
      task.state = 'queued';
      task.token = opts.token;
      task.abort = new AbortController();
      task.outcome = renewed.outcome;
      task.resolveOutcome = renewed.resolveOutcome;
      notifyPending();
      pump();
    },

    removeAll() {
      // 与 dispose 同一套丢弃语义,但不置 disposed:之后仍可正常 enqueue 新批次。
      // 只清 composer 域(未 claim)的任务:removeAll 的调用方语义都是「丢弃托盘
      // 在途上传」(切换目标电脑 / 排队编辑退出),已 claim 给 outbox 消息的任务
      // 不归它管——误丢会让 discarded 任务不再回调,对应消息永远卡在「上传中」。
      for (const task of tasks.values()) {
        if (task.claimed) continue;
        if (task.state === 'queued' || task.state === 'failed') {
          tasks.delete(task.localId);
          cleanupTaskLocalUris(task, false);
        } else {
          task.discarded = true;
          task.abort.abort();
        }
        // in-flight 同样提前落定(见 remove 的说明),解除 waitForIdle 的既有等待。
        task.resolveOutcome('discarded');
      }
      notifyPending();
    },

    async waitForIdle() {
      // 等待期间可能有新任务入队(用户连拍),循环直到没有活跃(queued / running)
      // 任务。已丢弃任务不进快照:被 X 掉的在途上传不会再影响 attachments,发送没
      // 必要等它跑完(它的 OSS 回收由 runTask 末段自理)。已 claim 任务同理不进——
      // 它们属于先前发出的乐观消息,本次发送没理由等别人的附件。失败态任务已结算、
      // 不再变化,不能进等待快照(它们的 outcome 恒已落定,会造成忙等死循环);以「结算
      // 时刻托盘里仍挂着的失败卡数」作为失败口径——有失败卡就不该放行发送。
      for (;;) {
        const snapshot = [...tasks.values()]
          .filter((task) => !task.discarded && !task.claimed && task.state !== 'failed')
          .map((task) => task.outcome);
        if (snapshot.length === 0) {
          let failedCount = 0;
          for (const task of tasks.values()) {
            if (!task.discarded && !task.claimed && task.state === 'failed') failedCount += 1;
          }
          return { failedCount };
        }
        await Promise.all(snapshot);
      }
    },

    hasPending() {
      for (const task of tasks.values()) {
        if (!task.discarded && !task.claimed) return true;
      }
      return false;
    },

    pendingCount() {
      let count = 0;
      for (const task of tasks.values()) {
        if (!task.discarded && !task.claimed) count += 1;
      }
      return count;
    },

    claim(localIds) {
      let changed = false;
      for (const localId of localIds) {
        const task = tasks.get(localId);
        if (!task || task.discarded || task.claimed) continue;
        task.claimed = true;
        changed = true;
      }
      // claimed 任务离开托盘,同步刷一次 pending 列表。
      if (changed) notifyPending();
    },

    unclaim(localIds) {
      let changed = false;
      for (const localId of localIds) {
        const task = tasks.get(localId);
        if (!task || task.discarded || !task.claimed) continue;
        task.claimed = false;
        changed = true;
      }
      // 任务回到托盘域,同步刷一次 pending 列表(失败卡也会重新出现,可 retry / X)。
      if (changed) notifyPending();
    },

    claimableTasks() {
      const out: Array<{
        localId: string;
        failed: boolean;
        kind: MobileLocalAttachmentKind;
        previewUri: string;
      }> = [];
      for (const task of tasks.values()) {
        if (task.discarded || task.claimed) continue;
        out.push({
          localId: task.localId,
          failed: task.state === 'failed',
          kind: task.candidate.kind,
          previewUri: task.candidate.uri,
        });
      }
      return out;
    },

    dispose() {
      disposed = true;
      for (const task of tasks.values()) {
        if (task.state === 'queued' || task.state === 'failed') {
          tasks.delete(task.localId);
          cleanupTaskLocalUris(task, false);
        } else {
          task.discarded = true;
          task.abort.abort();
        }
        // 同 remove / removeAll:提前落定,退屏时不让任何 waitForIdle 等待者挂死。
        task.resolveOutcome('discarded');
      }
    },
  };
}
