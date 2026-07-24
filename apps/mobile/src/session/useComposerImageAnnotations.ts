/**
 * useComposerImageAnnotations.ts — 圈点标注与 composer 附件管线的接线 hook
 * (会话页 / 新建会话页共用)。
 * ---------------------------------------------------------------------------
 * 职责(桌面 PR #792 的手机版对应物,按乐观上传管线重排了烧录时机):
 *   - 聊天 lightbox「发送到对话」:历史图(可带圈点)→ 烧录 → 进 composer 托盘
 *     上传;无笔迹时等价转发原图。
 *   - 托盘再编辑:标注附件保留「矢量笔迹 + 原图」真相(metaRef),点开托盘图
 *     显示原图 + 可撤销笔迹,保存后替换附件重新烧录上传;笔迹撤光 = 恢复原图。
 *   - annotated wire 标:烧录产物上传成功后给 RemoteSerializedAttachment 打
 *     annotated,被控端桌面(buildMakerUserMessage)据此注入「红色笔迹是用户
 *     标注」说明。
 *
 * 与桌面的差异:桌面托盘期零烧录、发送时刻才物化;手机附件是「入托盘即上传」
 * 的乐观管线,烧录提前到保存时刻(uri 即烧录图,托盘缩略图天然带笔迹)。矢量
 * 笔迹仍是唯一事实源——原图 + 笔迹在本地保留,再编辑时重放,重存时重新烧录。
 *
 * 源文件寿命:标注/转发的源图统一复制进本 hook 私有的 annotation-src 缓存目录
 * (聊天图的磁盘缓存受 LRU 管辖,直接引用会在再编辑窗口内被清理);附件移除 /
 * 发送清空时 best-effort 删除。
 */
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useAnnotationBurnIn } from '@/session/AnnotationBurnInWebView';
import {
  annotationBurnedFileName,
  imageMimeForUriFallback,
  isDirectSendableImageMime,
  sniffImageMimeFromBase64,
  type AnnotationStroke,
} from '@/session/imageAnnotationModel';
import { MOBILE_MAX_ATTACHMENTS, MOBILE_MAX_ATTACHMENT_BYTES } from '@/session/attachments';
import type { ImageLightboxAnnotationConfig } from '@/session/ImageLightbox';
import type {
  MobileLocalAttachmentUploadCandidate,
} from '@/session/mobileLocalAttachmentUpload';
import type { RemoteSerializedAttachment } from '@/session/types';

/** 标注附件的再编辑真相(attachmentId → 矢量笔迹 + 原图)。 */
interface AnnotationEditMeta {
  strokes: AnnotationStroke[];
  /** 未烧录原图(annotation-src 私有副本,不受磁盘缓存 LRU 影响)。 */
  sourceUri: string;
  sourceMimeType: string;
}

export interface UseComposerImageAnnotationsOptions {
  getAccessToken: () => Promise<string | null>;
  /** 乐观上传入队(useMobileLocalAttachments 的 enqueueUploads)。 */
  enqueueUploads: (
    candidates: readonly MobileLocalAttachmentUploadCandidate[],
    opts: { token: string | Promise<string | null> },
  ) => void;
  /** 再编辑保存时移除被替换的旧附件(页面的 remove,含 OSS 回收 + previews 清理)。 */
  removeAttachment: (attachmentId: string) => void;
  /**
   * 剩余附件槽位(MOBILE_MAX_ATTACHMENTS − 已入列 − pending):新增类提交
   * (聊天直发 / 文件浏览器投递)入队前校验,超限拒绝——picker 路径有
   * beginPick 挡,lightbox 路径不能绕过同一限额(review P2)。再编辑替换
   * 不占新槽位,不检查。
   */
  getRemainingAttachmentSlots: () => number;
}

export interface UseComposerImageAnnotationsResult {
  /** 烧录 WebView host:挂到页面任意稳定位置(无任务时为 null)。 */
  host: ReturnType<typeof useAnnotationBurnIn>['host'];
  /**
   * onUploaded 接线:标注类 candidate → 记录再编辑真相并返回打了 annotated 标
   * 的附件;其余原样返回。
   */
  decorateUploadedAttachment: (
    attachment: RemoteSerializedAttachment,
    candidate: MobileLocalAttachmentUploadCandidate,
  ) => RemoteSerializedAttachment;
  /** 聊天 lightbox 标注配置(发送到对话语义;新建会话页无聊天场景不用)。 */
  chatAnnotation: ImageLightboxAnnotationConfig;
  /** composer 托盘 lightbox 标注配置(保存 / 替换附件语义,image.key = attachmentId)。 */
  trayAnnotation: ImageLightboxAnnotationConfig;
  /** 托盘 lightbox 图源:标注附件点开显示原图(叠矢量笔迹可撤销),其余用预览。 */
  trayImageSourceUri: (attachmentId: string, previewUri: string) => string;
  /** 信箱消费入口(文件浏览器投递的标注提交):烧录 + 上传进托盘。 */
  submitExternalAnnotation: (
    displayUri: string,
    strokes: AnnotationStroke[],
    mimeType?: string,
  ) => Promise<void>;
  /** 附件被移除时清理再编辑真相与源图副本。 */
  forgetAttachment: (attachmentId: string) => void;
  /** 发送成功 / 草稿整体作废时清空全部再编辑真相。 */
  forgetAllAttachments: () => void;
}

/** hook 私有源图副本目录(cache 域,系统可回收;逐附件跟随清理)。 */
const ANNOTATION_SRC_DIR = 'annotation-src';
/** 烧录产物落盘目录。 */
const ANNOTATION_BURNED_DIR = 'annotation-burned';
/**
 * 上传入队后等多久没被 decorateUploadedAttachment "认领"就视为放弃(上传失败 /
 * 被取消,onFailed 回调链路不传 candidate,拿不到精确的失败信号,review P2)。
 * 远超正常上传耗时(乐观管线并发上限 2,单张图不会跑这么久),避免误删还在
 * 传的文件。
 */
const PENDING_UPLOAD_SWEEP_MS = 3 * 60 * 1000;

function extForMime(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower === 'image/png') return 'png';
  if (lower === 'image/gif') return 'gif';
  if (lower === 'image/webp') return 'webp';
  return 'jpg';
}


async function ensureDir(dir: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
}

export function useComposerImageAnnotations(
  options: UseComposerImageAnnotationsOptions,
): UseComposerImageAnnotationsResult {
  const { t } = useTranslation();
  const { burnIn, host } = useAnnotationBurnIn();
  const metaRef = useRef<Map<string, AnnotationEditMeta>>(new Map());
  /**
   * attachmentId → 本 hook 为该附件生成的缓存文件(烧录图 / 源图副本)。
   * 附件离场(移除 / 发送 / 替换)时据此删除:截图私有副本不遗留在 app cache
   * (review P2);再编辑替换的新旧附件会共享源副本,删除前做引用检查。
   */
  const generatedFilesRef = useRef<Map<string, string[]>>(new Map());
  // 回调经 ref 转发:config 对象保持稳定引用,lightbox 打开期间不重建。
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const srcDir = `${FileSystem.cacheDirectory}${ANNOTATION_SRC_DIR}/`;
  const burnedDir = `${FileSystem.cacheDirectory}${ANNOTATION_BURNED_DIR}/`;

  /**
   * 生成文件名用的强唯一 token:同一 hook 实例内严格递增,规避并发提交在同一
   * 毫秒内撞名互相覆盖(review P1——文件浏览器一次 focus drain 多条投递时,
   * 裸 Date.now() 存在同毫秒风险)。仍以时间戳为主体,只是叠加递增位保证唯一。
   */
  const fileSeqRef = useRef(0);
  const nextFileTag = useCallback(() => {
    fileSeqRef.current += 1;
    return Date.now() * 1000 + fileSeqRef.current;
  }, []);

  /** 是否本 hook 的私有缓存产物(只删自己生成的,绝不碰外部 file://)。 */
  const isHookGeneratedFile = useCallback(
    (uri: string) => uri.startsWith(srcDir) || uri.startsWith(burnedDir),
    [srcDir, burnedDir],
  );

  /** 删除不再被任何登记(或 extraKeep)引用的生成文件(best-effort)。 */
  const deleteUnreferencedFiles = useCallback((
    files: readonly string[],
    extraKeep: readonly string[] = [],
  ) => {
    for (const file of files) {
      let referenced = extraKeep.includes(file);
      if (!referenced) {
        for (const list of generatedFilesRef.current.values()) {
          if (list.includes(file)) {
            referenced = true;
            break;
          }
        }
      }
      if (!referenced) void FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined);
    }
  }, []);

  /**
   * 源副本收尾(全部来源统一过):
   * - mime 以字节魔数为准(png/jpeg/gif/webp),扩展名 / Content-Type / hint 都
   *   可能缺失或说谎——presign URL 常无扩展名,JPEG 字节标成 .png 会造成扩展
   *   名与内容不符(对齐桌面 sniffImageMime,PR #792 review P2);嗅探不出时
   *   保留 fallback,由后续「非直传格式走光栅化」兜底。
   * - 体积超附件上限直接拒绝:烧录要全量 base64 进 JS 内存,不做钳制会 OOM
   *   (上传层同口径校验只护住了直传路径)。
   */
  const finalizeSource = useCallback(async (
    fileUri: string,
    fallbackMime: string,
  ): Promise<{ fileUri: string; mimeType: string; size: number }> => {
    const info = await FileSystem.getInfoAsync(fileUri);
    const size = info.exists && typeof info.size === 'number' && Number.isFinite(info.size)
      ? info.size
      : 0;
    if (size > MOBILE_MAX_ATTACHMENT_BYTES) {
      throw new Error(t('composer.upload.imageTooLargeSend', { size: Math.round(MOBILE_MAX_ATTACHMENT_BYTES / 1024 / 1024) }));
    }
    const head = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
      length: 16,
      position: 0,
    }).catch(() => '');
    return { fileUri, mimeType: sniffImageMimeFromBase64(head) ?? fallbackMime, size };
  }, [t]);

  /**
   * 把标注/转发源图物化成本 hook 私有的 file:// 副本。
   * data: 解析写盘;http(s) 下载;file:// 复制(已在私有目录的原样复用)。
   */
  const materializeSource = useCallback(async (
    displayUri: string,
    mimeTypeHint: string | undefined,
  ): Promise<{ fileUri: string; mimeType: string; size: number }> => {
    const dataMatch = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(displayUri);
    if (dataMatch) {
      const mimeType = dataMatch[1].toLowerCase();
      await ensureDir(srcDir);
      const fileUri = `${srcDir}src-${nextFileTag()}.${extForMime(mimeType)}`;
      await FileSystem.writeAsStringAsync(fileUri, dataMatch[2], {
        encoding: FileSystem.EncodingType.Base64,
      });
      return finalizeSource(fileUri, mimeType);
    }
    const mimeType = (mimeTypeHint?.toLowerCase().startsWith('image/') ? mimeTypeHint.toLowerCase() : null)
      ?? imageMimeForUriFallback(displayUri);
    if (displayUri.startsWith('file://')) {
      if (displayUri.startsWith(srcDir)) return finalizeSource(displayUri, mimeType);
      await ensureDir(srcDir);
      const fileUri = `${srcDir}src-${nextFileTag()}.${extForMime(mimeType)}`;
      await FileSystem.copyAsync({ from: displayUri, to: fileUri });
      return finalizeSource(fileUri, mimeType);
    }
    if (/^https?:\/\//i.test(displayUri)) {
      await ensureDir(srcDir);
      const fileUri = `${srcDir}src-${nextFileTag()}.${extForMime(mimeType)}`;
      const result = await FileSystem.downloadAsync(displayUri, fileUri);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(t('composer.attachments.downloadOriginalFailed', { status: result.status }));
      }
      return finalizeSource(fileUri, mimeType);
    }
    throw new Error(t('composer.attachments.imageNotAnnotatable'));
  }, [srcDir, finalizeSource, nextFileTag, t]);

  /**
   * 标注提交主流程(聊天发送到对话 / 托盘再编辑保存共用):
   * 有笔迹 → 烧录成位图入托盘上传(candidate 带 annotation 元数据);
   * 无笔迹 → 原图直接入托盘(聊天=转发;再编辑=撤光恢复原图)。
   * 替换语义(replaceAttachmentId)经 candidate.replacesAttachmentId 延迟到
   * 上传**成功后**(decorateUploadedAttachment)才移除旧附件——上传可能因
   * token / 网络 / 超限失败,提前删会让用户新旧两头空(review P1)。
   */
  const submitAnnotation = useCallback(async (
    displayUri: string,
    strokes: AnnotationStroke[],
    mimeTypeHint: string | undefined,
    replaceAttachmentId: string | null,
  ): Promise<void> => {
    const opts = optionsRef.current;
    try {
      if (!replaceAttachmentId && opts.getRemainingAttachmentSlots() <= 0) {
        throw new Error(t('composer.upload.maxAttachments', { count: MOBILE_MAX_ATTACHMENTS }));
      }
      const replacedMeta = replaceAttachmentId ? metaRef.current.get(replaceAttachmentId) : undefined;
      const source = await materializeSource(
        replacedMeta?.sourceUri ?? displayUri,
        replacedMeta?.sourceMimeType ?? mimeTypeHint,
      );
      let candidate: MobileLocalAttachmentUploadCandidate;
      // 非直传白名单(bmp / heic 等能显示但管线不收的格式):即使无笔迹也走
      // 烧录通道——空笔迹烧录 = 光栅化为 PNG,对齐桌面「字节可达 + 发送时
      // 光栅化」模型(PR #792),否则这类图转发会被上传层类型白名单拒收。
      const mustRasterize = !isDirectSendableImageMime(source.mimeType);
      if (strokes.length > 0 || mustRasterize) {
        const base64 = await FileSystem.readAsStringAsync(source.fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const burned = await burnIn({ base64, mimeType: source.mimeType, strokes });
        await ensureDir(burnedDir);
        const name = strokes.length > 0
          ? annotationBurnedFileName(burned.mimeType, nextFileTag())
          : `image-${nextFileTag()}.${burned.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
        const burnedUri = `${burnedDir}${name}`;
        await FileSystem.writeAsStringAsync(burnedUri, burned.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const burnedInfo = await FileSystem.getInfoAsync(burnedUri).catch(() => null);
        candidate = {
          kind: 'image',
          uri: burnedUri,
          name,
          // 尺寸 / 字节数必须带上:preprocess 只在已知长边超限时才降采样到 2048,
          // 缺失会让 4096 烧录 PNG 原样直传(review P2)。
          size: burnedInfo?.exists && typeof burnedInfo.size === 'number' ? burnedInfo.size : 0,
          width: burned.width > 0 ? burned.width : undefined,
          height: burned.height > 0 ? burned.height : undefined,
          mimeType: burned.mimeType,
          // 纯光栅化(无笔迹)不带标注元数据:托盘不显示画笔角标、不打 annotated 标。
          ...(strokes.length > 0
            ? {
              annotation: {
                strokes: strokes.map((s) => ({ points: [...s.points] })),
                sourceUri: source.fileUri,
                sourceMimeType: source.mimeType,
              },
            }
            : {}),
        };
      } else {
        const ext = extForMime(source.mimeType);
        candidate = {
          kind: 'image',
          uri: source.fileUri,
          name: `image-${nextFileTag()}.${ext}`,
          // 直传源无解码尺寸,至少带上真实字节数让 preprocess 的重编码判断生效。
          size: source.size,
          mimeType: source.mimeType,
        };
      }
      if (replaceAttachmentId) candidate.replacesAttachmentId = replaceAttachmentId;
      // 入队前先按 candidate.uri(强唯一)登记本次生成的文件(review P2):
      // 上传成功后 decorateUploadedAttachment 会把这份登记迁到 attachment.id
      // 下;上传失败 / 被取消时没有 attachment.id 可挂,onFailed 回调链路也不
      // 传 candidate,拿不到这里的登记——用超时兜底清理,给上传留足够窗口后
      // 若始终没被 claimed 视为已放弃,删除对应文件。
      const ownedFiles = [candidate.uri, candidate.annotation?.sourceUri]
        .filter((uri): uri is string => !!uri && isHookGeneratedFile(uri));
      if (ownedFiles.length > 0) {
        generatedFilesRef.current.set(candidate.uri, ownedFiles);
        setTimeout(() => {
          const stillPending = generatedFilesRef.current.get(candidate.uri);
          if (stillPending === ownedFiles) {
            generatedFilesRef.current.delete(candidate.uri);
            deleteUnreferencedFiles(ownedFiles);
          }
        }, PENDING_UPLOAD_SWEEP_MS);
      }
      opts.enqueueUploads([candidate], { token: opts.getAccessToken() });
      // 旧附件此刻不动:替换在上传成功回调(decorateUploadedAttachment)里执行,
      // 失败时旧附件与其再编辑真相原样保留,用户可重试。
    } catch (err) {
      // 系统 Alert 能盖过全屏 lightbox Modal(composer 错误条此刻被遮挡不可见);
      // lightbox 停留在标注模式,用户可重试或放弃。
      Alert.alert(t('composer.attachments.annotationSaveFailed'), err instanceof Error && err.message ? err.message : t('composer.attachments.tryAgain'));
      throw err;
    }
  }, [materializeSource, burnIn, burnedDir, nextFileTag, isHookGeneratedFile, deleteUnreferencedFiles, t]);

  const decorateUploadedAttachment = useCallback((
    attachment: RemoteSerializedAttachment,
    candidate: MobileLocalAttachmentUploadCandidate,
  ): RemoteSerializedAttachment => {
    // 接手 submitAnnotation 入队前按 candidate.uri 登记的生成文件(review P2 的
    // 超时兜底注册);这里是正常路径——上传成功了,把临时登记迁到 attachment.id
    // 下,不再依赖超时清理。查不到临时登记(理论不会发生,兜底)才重新计算。
    const pending = generatedFilesRef.current.get(candidate.uri);
    generatedFilesRef.current.delete(candidate.uri);
    const ownedFiles = pending ?? [candidate.uri, candidate.annotation?.sourceUri]
      .filter((uri): uri is string => !!uri && isHookGeneratedFile(uri));
    if (candidate.replacesAttachmentId) {
      // 再编辑替换:新图上传成功,此刻才移除旧附件(见 candidate 字段注释)。
      // 顺序敏感——先把旧 meta / 旧文件登记摘掉再 removeAttachment:新旧附件
      // 共享同一个 sourceUri 副本(materializeSource 对 srcDir 内的源原样复用),
      // 若让 forgetAttachment 按旧登记清理会误删新附件仍引用的文件;旧文件中
      // 不被新附件引用的(如上一版烧录图)此刻删除。
      const oldId = candidate.replacesAttachmentId;
      const oldFiles = generatedFilesRef.current.get(oldId) ?? [];
      generatedFilesRef.current.delete(oldId);
      metaRef.current.delete(oldId);
      optionsRef.current.removeAttachment(oldId);
      deleteUnreferencedFiles(oldFiles, ownedFiles);
    }
    if (ownedFiles.length > 0) generatedFilesRef.current.set(attachment.id, ownedFiles);
    if (!candidate.annotation) return attachment;
    metaRef.current.set(attachment.id, {
      strokes: candidate.annotation.strokes,
      sourceUri: candidate.annotation.sourceUri,
      sourceMimeType: candidate.annotation.sourceMimeType,
    });
    return { ...attachment, annotated: true };
  }, [isHookGeneratedFile, deleteUnreferencedFiles]);

  const chatAnnotation = useMemo<ImageLightboxAnnotationConfig>(() => ({
    submitLabel: t('composer.attachments.sendToChat'),
    // 一级直发按钮(对齐桌面):不画笔迹也能把历史图转发进 composer 托盘。
    allowDirectSubmit: true,
    onSubmit: (_image, displayUri, strokes, context) =>
      submitAnnotation(displayUri, strokes, context.mimeType, null),
  }), [submitAnnotation, t]);

  const trayAnnotation = useMemo<ImageLightboxAnnotationConfig>(() => ({
    submitLabel: t('composer.attachments.save'),
    initialStrokesFor: (image) => metaRef.current.get(image.key)?.strokes,
    onSubmit: (image, displayUri, strokes, context) =>
      submitAnnotation(displayUri, strokes, context.mimeType, image.key),
  }), [submitAnnotation, t]);

  /**
   * 信箱消费入口:其它路由(文件浏览器 lightbox 画笔)投递的标注提交,由
   * 会话页在 focus 时逐条交给本方法——与聊天 lightbox 的直发共用同一条
   * 烧录 / 上传 / annotated 链路。
   */
  const submitExternalAnnotation = useCallback(
    (displayUri: string, strokes: AnnotationStroke[], mimeType?: string) =>
      submitAnnotation(displayUri, strokes, mimeType, null),
    [submitAnnotation],
  );

  const trayImageSourceUri = useCallback((attachmentId: string, previewUri: string): string => {
    return metaRef.current.get(attachmentId)?.sourceUri ?? previewUri;
  }, []);

  const forgetAttachment = useCallback((attachmentId: string) => {
    metaRef.current.delete(attachmentId);
    // 生成文件(烧录图 / 源图副本)随附件退场(best-effort;cache 域系统兜底);
    // 先摘登记再做引用检查,替换场景共享的源副本不会被误删。
    const files = generatedFilesRef.current.get(attachmentId);
    if (!files) return;
    generatedFilesRef.current.delete(attachmentId);
    deleteUnreferencedFiles(files);
  }, [deleteUnreferencedFiles]);

  const forgetAllAttachments = useCallback(() => {
    const allFiles = [...generatedFilesRef.current.values()].flat();
    generatedFilesRef.current.clear();
    metaRef.current.clear();
    deleteUnreferencedFiles(allFiles);
  }, [deleteUnreferencedFiles]);

  // 返回对象必须引用稳定(全部成员都是 useCallback / useMemo 产物):页面把它
  // 放进 composerGalleryImages 等 useMemo 的依赖里,每 render 新对象会让托盘
  // lightbox 的 images 每帧重建、进而重置用户正在画的笔迹(review P1)。
  return useMemo(() => ({
    host,
    decorateUploadedAttachment,
    chatAnnotation,
    trayAnnotation,
    trayImageSourceUri,
    submitExternalAnnotation,
    forgetAttachment,
    forgetAllAttachments,
  }), [
    host,
    decorateUploadedAttachment,
    chatAnnotation,
    trayAnnotation,
    trayImageSourceUri,
    submitExternalAnnotation,
    forgetAttachment,
    forgetAllAttachments,
  ]);
}
