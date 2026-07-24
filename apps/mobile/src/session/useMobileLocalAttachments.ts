/**
 * useMobileLocalAttachments.ts — 本机附件(相册 / 拍照 / 文件)乐观上传 hook。
 * ---------------------------------------------------------------------------
 * 会话页与新建会话页共用(与 MobileComposerInputRow 同精神,改一处两页生效)。
 * 职责:权限 + ImagePicker / DocumentPicker 拉起、candidate 构造,然后交给
 * mobileLocalAttachmentUpload 控制器做「立即进托盘 + 后台(降采样)上传」;
 * attachments / previews / error 等真相 state 仍由页面持有,经回调写入。
 *
 * 页面接线要点:
 *   - 托盘渲染 pendingUploads(图片=上传中缩略卡,文件=上传中 chip),X 走
 *     removePendingUpload;
 *   - 发送前 await waitForPendingUploads(),failedCount > 0 时中止发送;
 *   - 附件限额计算要把 pendingUploads.length 算进去;
 *   - 页面卸载时 hook 自动 dispose(在途上传完成后回收 OSS 中转对象)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { formatRemoteError } from '@/device-link/remoteStatus';
import {
  MOBILE_MAX_ATTACHMENTS,
  assertMobileDocumentSize,
  categorizeMobileAttachment,
} from '@/session/attachments';
import { assertMobileImageSize, buildMobileImageAttachmentCandidate } from '@/session/mobileImageAttachment';
import { preprocessMobileImageForUpload } from '@/session/mobileImagePreprocess';
import {
  createMobileLocalAttachmentUploadController,
  isCameraUnavailableOnSimulator,
  type MobileLocalAttachmentUploadCandidate,
  type MobileLocalAttachmentUploadController,
  type PendingLocalAttachmentUpload,
} from '@/session/mobileLocalAttachmentUpload';
import {
  discardMobileUploadedAttachment,
  statMobileAttachmentFileSize,
  uploadMobileAttachmentFromFile,
} from '@/session/mobileAttachmentUpload';
import {
  buildPastedImageFileName,
  classifyPastedImageUri,
  isComposerPastedImageUri,
  mimeTypeForPastedImageExt,
  resolvePastedImageAsset,
} from '@/session/pastedImageAttachment';
import {
  getSentAttachmentThumbUri,
  registerSentAttachmentThumb,
} from '@/session/sentAttachmentThumbStore';
import type { RemoteSerializedAttachment } from '@/session/types';

export interface UseMobileLocalAttachmentsOptions {
  getAccessToken: () => Promise<string | null>;
  /** 当前已入列附件数(限额用;pending 由 hook 自己计入)。 */
  getAttachmentCount: () => number;
  /** 单个上传成功:页面把 attachment 入列;图片按 candidate.uri 记预览映射,
   *  candidate.sourceId(相册资产 id)供面板勾选态映射。localId 供已 claim
   *  (随乐观消息先发出)任务的产物路由——页面据此把附件填回对应消息而非托盘。 */
  onUploaded: (
    attachment: RemoteSerializedAttachment,
    candidate: MobileLocalAttachmentUploadCandidate,
    localId: string,
  ) => void;
  /** 错误文案(null = 清除);uploadLocalId = 触发失败的上传任务(已 claim 任务的
   *  失败由页面路由给对应乐观消息,不该落进 composer 错误条)。 */
  onError: (message: string | null, context?: { uploadLocalId?: string }) => void;
  /** picker 确认选图 / 拍下照片 / 选中文件后触发(页面用来关 Context 面板)。 */
  onPicked?: () => void;
}

/**
 * 粘贴占位卡的超时兜底:images-loading 之后原生层若一直不兑现(进程内异常、
 * 事件丢失),占位不能永远转圈。跨设备剪贴板(Mac 复制 → iPhone 粘贴)要等
 * 系统走网络拉数据,慢网下几十秒是真实场景,超时给足余量。
 */
const PASTE_PLACEHOLDER_TIMEOUT_MS = 60_000;

async function deleteLocalUris(uris: readonly string[]): Promise<void> {
  await Promise.all(uris.map((uri) => (
    FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)
  )));
}

export interface UseMobileLocalAttachmentsResult {
  /** 上传中的附件(托盘渲染 pending 卡)。 */
  pendingUploads: readonly PendingLocalAttachmentUpload[];
  /**
   * 粘贴占位卡数量:原生层已检测到图片粘贴、数据还在后台读取 / 写盘的窗口里,
   * 托盘先画 N 张无图转圈占位卡;onPasteImages 兑现或失败 / 超时后归零。
   */
  pastePlaceholderCount: number;
  /** 原生 images-loading 事件:立刻竖起 count 张粘贴占位卡。 */
  beginPastePlaceholders: (count: number) => void;
  /** 原生 images-load-failed 事件:撤掉占位卡并提示。 */
  failPastePlaceholders: () => void;
  /** 拉起相册 / 相机。 */
  addImages: (source: 'library' | 'camera') => Promise<void>;
  /** 拉起系统文件选择器。 */
  addDocument: () => Promise<void>;
  /** 输入框 Paste 粘贴剪贴板图片(ComposerRichInput 落盘的 file:// 临时文件)。 */
  addPastedImages: (uris: string[]) => Promise<void>;
  /** 直接入队已构造好的 candidates(Context 面板批量提交用,调用方自备 token,可传 Promise)。 */
  enqueueUploads: (
    candidates: readonly MobileLocalAttachmentUploadCandidate[],
    opts: { token: string | Promise<string | null> },
  ) => void;
  /** 托盘 X 一个上传中的附件。 */
  removePendingUpload: (localId: string) => void;
  /** 重试一个失败态的上传卡(自动取新鲜 token 重跑完整管线)。 */
  retryPendingUpload: (localId: string) => void;
  /** 丢弃全部在途上传(切换目标电脑等草稿整体作废场景;完成后回收 OSS 中转对象)。 */
  discardAllPendingUploads: () => void;
  /** 等全部在途上传落定;返回期间失败个数(>0 时调用方应中止发送)。 */
  waitForPendingUploads: () => Promise<{ failedCount: number }>;
  /**
   * 把当前全部未 claim 上传任务(active + 失败卡)划归一条乐观消息并返回快照
   * (顺序 = 入队序):任务离开托盘 / 限额 / waitForPendingUploads,产物经
   * onUploaded / onError 的 localId 路由。快照与 claim 同一同步段完成,无竞态窗。
   */
  claimActiveUploads: () => ReturnType<MobileLocalAttachmentUploadController['claimableTasks']>;
  /** 只等粘贴占位落定(兑现任务已入队 / 失败 / 超时),不等上传完成;详见实现处注释。 */
  waitForPastePlaceholdersSettled: () => Promise<void>;
  /** 是否有粘贴占位在途(同步真源):占位兑现前任务尚未入队、无法 claim。 */
  hasPastePlaceholders: () => boolean;
  /**
   * 限额口径的在途占坑数**同步真源**(非 React state):上传中任务(controller
   * 内部计数)+ 粘贴占位批次总数。所有附件槽位校验(标注信箱串行 drain、
   * context-sheet 选图、handleSend 剩余槽位)必须读这里,两个理由:
   * (1) `pendingUploads` state 的 commit 走 macrotask,连续提交间读 state 会拿到
   * 「入队前」旧值,绕过 MOBILE_MAX_ATTACHMENTS(review P1);
   * (2) 粘贴占位窗口(原生还在读剪贴板)任务未入 controller 队列,不含占位的
   * 计数会放行超额选图 / 标注,占位兑现时轮到粘贴图自己撞上限被丢(review P2)。
   */
  getPendingUploadCount: () => number;
}

export function useMobileLocalAttachments(
  options: UseMobileLocalAttachmentsOptions,
): UseMobileLocalAttachmentsResult {
  const { t } = useTranslation();
  const [pendingUploads, setPendingUploads] = useState<readonly PendingLocalAttachmentUpload[]>([]);
  const pickerBusyRef = useRef(false);
  /** 本 hook 拥有的 WebView 粘贴缓存；注册持久缩略图后或卸载时统一回收。 */
  const pastedImageLocalUrisRef = useRef(new Set<string>());
  const cleanupPastedImageLocalUris = async (uris: readonly string[]): Promise<void> => {
    await deleteLocalUris(uris);
    for (const uri of uris) pastedImageLocalUrisRef.current.delete(uri);
  };
  // 粘贴占位卡:按「批次」FIFO 记账(ref 数组是同步真源,state 只存总数供渲染
  // ——与 pendingCount 同理,限额校验不能读滞后一拍的 state)。原生事件不带批次
  // id,但两端的媒体处理都是串行队列(iOS mediaProcessingQueue / Android 单线程
  // executor),完成顺序 = 开始顺序,所以 images / images-load-failed 到达时按
  // FIFO 出列第一批即可——连续两次粘贴时,第一批先兑现只清自己的占位,第二批
  // 仍在原生处理中的占位继续转圈(review P2)。超时定时器兜底事件丢失,超时属
  // 异常兜底,一次清全部不做批次精度。
  const [pastePlaceholderCount, setPastePlaceholderCount] = useState(0);
  const pastePlaceholderBatchesRef = useRef<number[]>([]);
  const pastePlaceholderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 占位窗口的发送等待者:waitForPendingUploads 必须把占位当在途工作等待——
  // images-loading 到 images 兑现之间(跨设备剪贴板 / 大图可达数十秒)任务还没
  // 进 controller 队列,只等 waitForIdle 会让发送 / 创建把刚粘贴的图漏掉
  //(review P2)。占位全部落定(兑现 / 失败 / 超时归零)时统一放行。
  const pastePlaceholderWaitersRef = useRef<(() => void)[]>([]);
  // 回调经 ref 转发,controller 单例化的同时始终调到最新一次 render 的闭包。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const getPastePlaceholderTotal = () =>
    pastePlaceholderBatchesRef.current.reduce((sum, n) => sum + n, 0);

  const flushPastePlaceholderWaiters = () => {
    const waiters = pastePlaceholderWaitersRef.current;
    pastePlaceholderWaitersRef.current = [];
    for (const resolve of waiters) resolve();
  };

  /** 批次数组变更后的统一收尾:同步 state 总数 + 重置超时兜底定时器 + 放行等待者。 */
  const syncPastePlaceholders = () => {
    const total = getPastePlaceholderTotal();
    setPastePlaceholderCount(total);
    if (pastePlaceholderTimerRef.current) {
      clearTimeout(pastePlaceholderTimerRef.current);
      pastePlaceholderTimerRef.current = null;
    }
    if (total > 0) {
      pastePlaceholderTimerRef.current = setTimeout(() => {
        pastePlaceholderTimerRef.current = null;
        pastePlaceholderBatchesRef.current = [];
        setPastePlaceholderCount(0);
        flushPastePlaceholderWaiters();
        optionsRef.current.onError(t('composer.upload.pasteTimeout'));
      }, PASTE_PLACEHOLDER_TIMEOUT_MS);
    } else {
      flushPastePlaceholderWaiters();
    }
  };

  /**
   * 等全部粘贴占位落定。放行时机安全性:兑现路径 shiftPastePlaceholderBatch 与
   * controller.enqueue 在 addPastedImages 的同一同步段里,waiter 的 promise 恢复
   * 是微任务,必然晚于该同步段结束——放行后紧接的 waitForIdle 一定能看到刚入队
   * 的上传任务,不存在"占位清了、任务还没入队"的空隙。
   */
  const waitForPastePlaceholders = (): Promise<void> => {
    if (getPastePlaceholderTotal() === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      pastePlaceholderWaitersRef.current.push(resolve);
    });
  };

  const beginPastePlaceholders = (count: number) => {
    if (count <= 0) return;
    pastePlaceholderBatchesRef.current.push(count);
    syncPastePlaceholders();
  };

  /** 兑现 / 失败按 FIFO 出列一批(见上方串行队列不变量)。 */
  const shiftPastePlaceholderBatch = () => {
    if (pastePlaceholderBatchesRef.current.length === 0) return;
    pastePlaceholderBatchesRef.current.shift();
    syncPastePlaceholders();
  };

  const failPastePlaceholders = () => {
    if (pastePlaceholderBatchesRef.current.length === 0) return;
    shiftPastePlaceholderBatch();
    optionsRef.current.onError(t('composer.upload.clipboardReadFailed'));
  };

  const controller = useMemo(() => createMobileLocalAttachmentUploadController({
    preprocess: preprocessMobileImageForUpload,
    statSize: statMobileAttachmentFileSize,
    assertSize: (size, candidate) => {
      if (candidate.kind === 'image') assertMobileImageSize(size);
      else assertMobileDocumentSize(size);
    },
    upload: (candidate, fileUri, opts) => uploadMobileAttachmentFromFile(candidate, fileUri, opts),
    discard: (attachment) => discardMobileUploadedAttachment(attachment, {
      getToken: () => optionsRef.current.getAccessToken(),
    }),
    onPendingChange: setPendingUploads,
    onUploaded: async (attachment, candidate, uploadedUri, localId, localUris, isActive) => {
      // 发送后气泡的本地缩略图兜底:消息里持久化的是 cindy-oss-attach:// 中转引用,
      // 被控端物化改写前(乐观渲染 / 电脑离线窗口)渲染端没有任何预览路径——把
      // 实际上传的文件拷进自有目录记映射,气泡用本地图顶上。
      let deliveredCandidate = candidate;
      if (candidate.kind === 'image') {
        const ossRef = attachment.url ?? attachment.path;
        if (candidate.cleanupLocalUris) {
          // 粘贴源文件需要回收:先等持久缩略图完成接管，才能安全删源文件。
          await registerSentAttachmentThumb(ossRef, uploadedUri || candidate.uri);
          const durablePreviewUri = ossRef ? getSentAttachmentThumbUri(ossRef) : null;
          if (durablePreviewUri) deliveredCandidate = { ...candidate, uri: durablePreviewUri };
        } else {
          // 相册 / 相机原有路径不拥有源文件，保持 fire-and-forget，不拉长上传落定时间。
          void registerSentAttachmentThumb(ossRef, uploadedUri || candidate.uri);
        }
      }
      if (candidate.cleanupLocalUris) {
        for (const uri of localUris) pastedImageLocalUrisRef.current.add(uri);
      }
      if (!isActive()) return;
      optionsRef.current.onUploaded(attachment, deliveredCandidate, localId);
      if (candidate.cleanupLocalUris) {
        // 只有持久缩略图已经接管 composer / sent-message 预览后才删源文件；
        // 注册失败时保留到页面卸载，不能让已上传附件立刻变成坏图。
        if (deliveredCandidate.uri !== candidate.uri) {
          await candidate.cleanupLocalUris(localUris);
        }
      }
    },
    onFailed: (err, localId) => optionsRef.current.onError(formatRemoteError(err), { uploadLocalId: localId }),
  }), []);

  useEffect(() => () => {
    controller.dispose();
    const pastedUris = [...pastedImageLocalUrisRef.current];
    pastedImageLocalUrisRef.current.clear();
    if (pastedUris.length > 0) void deleteLocalUris(pastedUris);
    if (pastePlaceholderTimerRef.current) {
      clearTimeout(pastePlaceholderTimerRef.current);
      pastePlaceholderTimerRef.current = null;
    }
    // 卸载放行滞留的发送等待者,防 waitForPendingUploads 永久悬挂。
    flushPastePlaceholderWaiters();
  }, [controller]);

  /** 限额口径的在途占坑数(见接口 doc):上传中任务 + 粘贴占位。 */
  const getPendingSlotCount = () => controller.pendingCount() + getPastePlaceholderTotal();

  /** 限额检查 + 防重入的公共前奏;返回 null 表示不能继续。 */
  const beginPick = (): { remainingSlots: number } | null => {
    if (pickerBusyRef.current) return null;
    // 占坑数读同步真源 getPendingSlotCount(上传中 + 粘贴占位),不读 React state:
    // 连续入队场景不受 state commit 滞后影响(review P1);占位期间从相册再加图
    // 不能超限,addPastedImages 自己会在进本函数前出列本批占位,不会双扣。
    const remainingSlots = MOBILE_MAX_ATTACHMENTS
      - optionsRef.current.getAttachmentCount()
      - getPendingSlotCount();
    if (remainingSlots <= 0) {
      optionsRef.current.onError(t('composer.upload.maxAttachments', { count: MOBILE_MAX_ATTACHMENTS }));
      return null;
    }
    pickerBusyRef.current = true;
    optionsRef.current.onError(null);
    return { remainingSlots };
  };

  const addImages = async (source: 'library' | 'camera'): Promise<void> => {
    const begun = beginPick();
    if (!begun) return;
    try {
      // iOS 模拟器无相机:不拦截会在原生层直接崩进程(见 isCameraUnavailableOnSimulator)。
      if (source === 'camera'
        && isCameraUnavailableOnSimulator(Platform.OS, FileSystem.documentDirectory)) {
        optionsRef.current.onError(t('composer.upload.simulatorNoCamera'));
        return;
      }
      const permission = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync(false);
      if (!permission.granted) {
        optionsRef.current.onError(source === 'camera'
          ? t('composer.upload.cameraPermission')
          : t('composer.upload.photoPermission'));
        return;
      }

      const picked = source === 'camera'
        ? await ImagePicker.launchCameraAsync({
          mediaTypes: ['images'],
          quality: 1,
        })
        : await ImagePicker.launchImageLibraryAsync({
          allowsMultipleSelection: true,
          mediaTypes: ['images'],
          orderedSelection: true,
          quality: 1,
          selectionLimit: begun.remainingSlots,
        });
      if (picked.canceled) return;

      const candidates: MobileLocalAttachmentUploadCandidate[] = picked.assets
        .slice(0, begun.remainingSlots)
        .map((asset, index) => ({ kind: 'image', ...buildMobileImageAttachmentCandidate(asset, index) }));
      if (candidates.length === 0) return;
      // 立即入 pending 托盘(不先 await token):token 等待窗里任务已可被 waitForIdle 看到,
      // composer 抢发会等它落定而不是丢图;token 由任务开跑时自行等待(拿不到→该任务失败报错)。
      controller.enqueue(candidates, { token: optionsRef.current.getAccessToken() });
      optionsRef.current.onPicked?.();
    } catch (err) {
      optionsRef.current.onError(formatRemoteError(err));
    } finally {
      pickerBusyRef.current = false;
    }
  };

  const addDocument = async (): Promise<void> => {
    const begun = beginPick();
    if (!begun) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;

      const asset = picked.assets?.[0];
      const uri = asset?.uri?.trim();
      const name = asset?.name?.trim();
      if (!asset || !uri || !name) {
        optionsRef.current.onError(t('composer.upload.noFileRead'));
        return;
      }
      // 类型白名单同步校验:不支持的类型即时报错,不进托盘、不触发上传
      // (上传层还有同口径兜底,防 OSS 孤儿)。
      if (!categorizeMobileAttachment(name)) {
        optionsRef.current.onError(t('composer.upload.fileTypeUnsupported'));
        return;
      }

      const size = typeof asset.size === 'number' && Number.isFinite(asset.size) && asset.size > 0
        ? asset.size
        : 0;
      // 立即入 pending 托盘(带文件名 chip,不先 await token,同 addImages):大 PDF 不再卡住托盘。
      controller.enqueue([{
        kind: 'file',
        uri,
        name,
        size,
        mimeType: asset.mimeType || undefined,
      }], { token: optionsRef.current.getAccessToken() });
      optionsRef.current.onPicked?.();
    } catch (err) {
      optionsRef.current.onError(formatRemoteError(err));
    } finally {
      pickerBusyRef.current = false;
    }
  };

  /**
   * 输入框长按 Paste 粘贴剪贴板图片:与相册 / 拍照同一条乐观管线——粘贴落盘的
   * 临时文件立刻做托盘预览,重命名 / HEIC 转码(resolve 钩子)+ 降采样 + 上传
   * 全部在后台任务里跑(取代 #589 的阻塞式上传 + attachmentBusy 门)。
   */
  const addPastedImages = async (uris: string[]): Promise<void> => {
    if (uris.length === 0) return;
    const ownedUris = uris.filter(isComposerPastedImageUri);
    for (const uri of ownedUris) pastedImageLocalUrisRef.current.add(uri);
    // 本批 uris 就是最早一批占位卡的兑现:先按 FIFO 出列本批再做限额检查
    //(否则这批会被自己的占位双扣槽位)。出列与下方 enqueue 的 pending 上屏在
    // 同一同步段,React 批处理保证占位卡 → pending 卡之间没有空帧。
    shiftPastePlaceholderBatch();
    const begun = beginPick();
    if (!begun) {
      void cleanupPastedImageLocalUris(ownedUris);
      return;
    }
    try {
      // 同步段就入队,绝不先 await token:粘贴没有 picker modal 遮挡,token 走网络 refresh
      // 的等待窗里用户可直接点发送——任务不在队里的话 waitForIdle 立即返回,刚粘贴的图
      // 会被静默丢弃(#589 用 attachmentBusy 门堵的就是这个,乐观管线用「先入队」替代)。
      const acceptedUris = uris.slice(0, begun.remainingSlots);
      const rejectedUris = uris.slice(begun.remainingSlots).filter(isComposerPastedImageUri);
      if (rejectedUris.length > 0) void cleanupPastedImageLocalUris(rejectedUris);
      controller.enqueue(acceptedUris.map((uri, index) => {
        const classified = classifyPastedImageUri(uri);
        const ownsLocalFile = isComposerPastedImageUri(uri);
        return {
          kind: 'image' as const,
          uri,
          name: buildPastedImageFileName(index, classified.ext),
          size: 0,
          // mimeType 必须从入队起就有值:缺失时预签名不锁 Content-Type,原生直传层
          // 自动补 application/octet-stream,签名不一致 → OSS 403(2026-07 实撞)。
          mimeType: mimeTypeForPastedImageExt(classified.ext),
          resolve: async () => {
            const resolved = await resolvePastedImageAsset(uri, index);
            return { uri: resolved.uri, name: resolved.fileName, mimeType: resolved.mimeType };
          },
          cleanupLocalUris: ownsLocalFile ? cleanupPastedImageLocalUris : undefined,
        };
      }), { token: optionsRef.current.getAccessToken() });
    } catch (err) {
      optionsRef.current.onError(formatRemoteError(err));
    } finally {
      pickerBusyRef.current = false;
    }
  };

  return {
    pendingUploads,
    pastePlaceholderCount,
    beginPastePlaceholders,
    failPastePlaceholders,
    addImages,
    addDocument,
    addPastedImages,
    enqueueUploads: controller.enqueue,
    removePendingUpload: controller.remove,
    retryPendingUpload: (localId) => {
      // 重试前清掉上一次失败的错误文案;token 取新鲜值(失败卡可能停留很久)。
      optionsRef.current.onError(null);
      controller.retry(localId, { token: optionsRef.current.getAccessToken() });
    },
    discardAllPendingUploads: controller.removeAll,
    // 先等粘贴占位落定(images 兑现会把任务同步入队 / 失败与超时直接归零),
    // 再等 controller 队列——否则占位窗口内抢发会把刚粘贴的图漏在消息外
    //(review P2)。占位失败不计入 failedCount:那张图从未成为附件,语义等同
    // 用户手动移除,不应中止发送。
    waitForPendingUploads: async () => {
      await waitForPastePlaceholders();
      return controller.waitForIdle();
    },
    claimActiveUploads: () => {
      const snapshot = controller.claimableTasks();
      controller.claim(snapshot.map((task) => task.localId));
      return snapshot;
    },
    // 只等粘贴占位落定(兑现的同步段任务已入 controller 队列),不等上传本身:
    // 乐观发送(outbox)在占位窗口内需要它把「尚未入队、无法划归」的粘贴图等成
    // 可划归任务,再做同步 claim——不能用 waitForPendingUploads(那会退化回
    // 等整个上传完成)。失败 / 超时同样放行(60s 兜底,错误 toast 已由占位路径给出)。
    waitForPastePlaceholdersSettled: waitForPastePlaceholders,
    hasPastePlaceholders: () => getPastePlaceholderTotal() > 0,
    getPendingUploadCount: getPendingSlotCount,
  };
}
