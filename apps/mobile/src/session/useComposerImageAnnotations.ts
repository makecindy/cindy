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
 * (聊天图的磁盘缓存受 LRU 管辖,直接引用会在再编辑窗口内被清理)。生成文件的
 * 回收跟随上传生命周期:上传成功后挂到附件名下,随附件移除 / 发送清空 / 被替换
 * 删除;上传失败时失败卡仍在托盘、可重试,文件原样保留;只有任务被确定放弃
 * (失败卡 / 在途卡被移除、整体丢弃、退屏、交接给发件箱)才删除。
 */
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { summarizeAnnotationRegions } from '@cindy/maker-shared/image-annotation';
import { useAnnotationBurnIn } from '@/session/AnnotationBurnInWebView';
import {
  annotationBurnedFileName,
  imageMimeForUriFallback,
  isAnnotationBurnSourceResultUsable,
  isDirectSendableImageMime,
  planAnnotationBurnSource,
  sniffImageMimeFromBase64,
  type AnnotationBurnSourcePlan,
  type AnnotationStroke,
} from '@/session/imageAnnotationModel';
import { MOBILE_MAX_ATTACHMENTS } from '@/session/attachments';
import type { ImageLightboxAnnotationConfig } from '@/session/ImageLightbox';
import type {
  MobileLocalAttachmentUploadCandidate,
} from '@/session/mobileLocalAttachmentUpload';
import type { RemoteSerializedAttachment } from '@/session/types';

/**
 * 标注烧录要把整张图 base64 读进 JS 内存,这是防 OOM 的上限,与附件本身的发送上限无关
 *(附件与桌面一致只受传输通道限制)。
 */
const ANNOTATION_SOURCE_MAX_BYTES = 30 * 1024 * 1024;

/** 标注附件的再编辑真相(attachmentId → 矢量笔迹 + 原图)。 */
interface AnnotationEditMeta {
  strokes: AnnotationStroke[];
  /** 未烧录原图(annotation-src 私有副本,不受磁盘缓存 LRU 影响)。 */
  sourceUri: string;
  sourceMimeType: string;
  /** sourceUri 本身已是带笔迹的烧录图(见 candidate.annotation.baseAnnotated)。 */
  baseAnnotated?: boolean;
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
  /**
   * 按 id 读取托盘里的已上传附件(同步真源)。再编辑时据此判断替换目标是否仍在
   * 托盘、以及底图本身是否已是标注烧录图(再编辑真相丢失时保住 annotated 标)。
   */
  getAttachment?: (attachmentId: string) => RemoteSerializedAttachment | undefined;
}

/** lightbox 已解码的源图尺寸(可选提示,仅用于烧录前预缩决策)。 */
export interface AnnotationSourceSizeHint {
  naturalWidth?: number;
  naturalHeight?: number;
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
    sizeHint?: AnnotationSourceSizeHint,
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

/** 入队后尚未落定的上传登记(candidate.uri → 本次生成的文件)。 */
interface PendingUploadRegistration {
  files: string[];
  /** 再编辑替换的目标附件:登记存在期间该附件不可再次编辑(防双重替换)。 */
  replacesAttachmentId?: string;
}

/**
 * 烧录前的源图预处理(expo-image-manipulator,已是本 App 既有原生依赖):
 * 按 plan 转码 / 预缩并落盘。动态 import 保证 node 单测可导入本模块。
 */
async function runAnnotationBurnSourcePlan(
  uri: string,
  plan: AnnotationBurnSourcePlan,
): Promise<{ uri: string; width: number; height: number }> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(uri);
  if (plan.resize) context.resize(plan.resize);
  const rendered = await context.renderAsync();
  try {
    const saved = await rendered.saveAsync({
      compress: plan.compress,
      format: plan.format === 'jpeg' ? SaveFormat.JPEG : SaveFormat.PNG,
    });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } finally {
    // render 结果持有原生纹理,显式释放(与 mobileImagePreprocess 同模式)。
    rendered.release();
    context.release();
  }
}

function positiveHintDimension(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/**
 * 给模型的标注区域(与桌面同一归纳算法)。底图本身已是烧录图(再编辑真相丢失)时,
 * 旧红线的位置不可知,只描述新笔迹会让说明与图上红线不符——此时不带区域,
 * 退回固定说明。
 */
export function annotationRegionsForUpload(
  annotation: { strokes: readonly AnnotationStroke[]; baseAnnotated?: boolean } | undefined,
): Pick<RemoteSerializedAttachment, 'annotationRegions'> {
  if (!annotation || annotation.baseAnnotated) return {};
  const regions = summarizeAnnotationRegions(annotation.strokes);
  return regions.length > 0 ? { annotationRegions: regions } : {};
}

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
  const { burnIn, acquireWarm, host } = useAnnotationBurnIn();
  const metaRef = useRef<Map<string, AnnotationEditMeta>>(new Map());
  /**
   * attachmentId → 本 hook 为该附件生成的缓存文件(烧录图 / 源图副本)。
   * 附件离场(移除 / 发送 / 替换)时据此删除:截图私有副本不遗留在 app cache
   * (review P2);再编辑替换的新旧附件会共享源副本,删除前做引用检查。
   */
  const generatedFilesRef = useRef<Map<string, string[]>>(new Map());
  /**
   * candidate.uri → 已入队、尚未上传成功的生成文件登记。上传成功时迁到
   * attachment.id 名下;失败时原样保留(失败卡可重试,重试读的就是这些文件);
   * 只有上传控制器确认任务被放弃(onAbandoned)才删除。
   */
  const pendingUploadsRef = useRef<Map<string, PendingUploadRegistration>>(new Map());
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

  /**
   * 删除不再被任何登记(附件名下 / 在途上传 / extraKeep)引用的生成文件
   * (best-effort)。在途上传(含失败待重试)仍引用的文件绝不删除。
   */
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
      if (!referenced) {
        for (const registration of pendingUploadsRef.current.values()) {
          if (registration.files.includes(file)) {
            referenced = true;
            break;
          }
        }
      }
      if (!referenced) void FileSystem.deleteAsync(file, { idempotent: true }).catch(() => undefined);
    }
  }, []);

  /** 该附件是否有尚未落定的再编辑替换(上传中或失败待重试)。 */
  const hasPendingReplacement = useCallback((attachmentId: string) => {
    for (const registration of pendingUploadsRef.current.values()) {
      if (registration.replacesAttachmentId === attachmentId) return true;
    }
    return false;
  }, []);

  /**
   * 烧录源准备:Android WebView 解不了的格式先转码、已知超大图先按上传口径预缩
   * (见 planAnnotationBurnSource)。manipulator 失败、产物与提示尺寸对不上或
   * 体积超过源图上限(烧录要全量 base64 进 JS 内存)时回退原图(即既有路径)。
   * tempUri = 仅供本次烧录的中间产物,烧完即删。
   */
  const prepareBurnSource = useCallback(async (
    source: { fileUri: string; mimeType: string },
    sizeHint: AnnotationSourceSizeHint | undefined,
  ): Promise<{
    fileUri: string;
    mimeType: string;
    strokeSpace?: { width: number; height: number };
    tempUri?: string;
  }> => {
    const original = { fileUri: source.fileUri, mimeType: source.mimeType };
    const hint = {
      width: positiveHintDimension(sizeHint?.naturalWidth),
      height: positiveHintDimension(sizeHint?.naturalHeight),
    };
    const plan = planAnnotationBurnSource({
      mimeType: source.mimeType,
      platformOS: Platform.OS,
      naturalWidth: hint.width,
      naturalHeight: hint.height,
    });
    if (!plan) return original;
    try {
      const result = await runAnnotationBurnSourcePlan(source.fileUri, plan);
      const info = await FileSystem.getInfoAsync(result.uri).catch(() => null);
      const resultSize = info?.exists && typeof info.size === 'number' && Number.isFinite(info.size)
        ? info.size
        : 0;
      if (
        !isAnnotationBurnSourceResultUsable(plan, result, hint)
        || !(resultSize > 0)
        || resultSize > ANNOTATION_SOURCE_MAX_BYTES
      ) {
        void FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined);
        return original;
      }
      return {
        fileUri: result.uri,
        mimeType: plan.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        ...(plan.strokeSpace ? { strokeSpace: plan.strokeSpace } : {}),
        tempUri: result.uri,
      };
    } catch {
      return original;
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
    if (size > ANNOTATION_SOURCE_MAX_BYTES) {
      throw new Error(t('composer.upload.imageTooLargeSend', { size: Math.round(ANNOTATION_SOURCE_MAX_BYTES / 1024 / 1024) }));
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
    sizeHint?: AnnotationSourceSizeHint,
  ): Promise<void> => {
    const opts = optionsRef.current;
    /** 本次提交新生成、尚未交给上传管线的文件:提交失败时回收。 */
    const createdFiles: string[] = [];
    let handedToUpload = false;
    try {
      let replaceId = replaceAttachmentId;
      if (replaceId && hasPendingReplacement(replaceId)) {
        // 同一附件已有未落定的替换(上传中 / 失败待重试):再替换一次会让两份
        // 新图都留在托盘(第二次替换找不到旧附件可删)并越过附件上限。
        throw new Error(t('composer.attachments.replacementPending'));
      }
      const replacedAttachment = replaceId && opts.getAttachment ? opts.getAttachment(replaceId) : undefined;
      if (replaceId && opts.getAttachment && !replacedAttachment) {
        // 替换目标已不在托盘:按新增处理(占新槽位,受上限约束)。
        replaceId = null;
      }
      if (!replaceId && opts.getRemainingAttachmentSlots() <= 0) {
        throw new Error(t('composer.upload.maxAttachments', { count: MOBILE_MAX_ATTACHMENTS }));
      }
      const replacedMeta = replaceId ? metaRef.current.get(replaceId) : undefined;
      // 再编辑真相丢失(恢复草稿 / 排队编辑载入等)时底图本身就是带红线的烧录图:
      // 即使本次没有新笔迹,产物仍是标注图,annotated 标不能丢(之后再次编辑同样)。
      const baseIsAnnotatedBurn = !!replaceId && (replacedMeta
        ? replacedMeta.baseAnnotated === true
        : replacedAttachment?.annotated === true);
      const sourceInputUri = replacedMeta?.sourceUri ?? displayUri;
      const source = await materializeSource(
        sourceInputUri,
        replacedMeta?.sourceMimeType ?? mimeTypeHint,
      );
      if (source.fileUri !== sourceInputUri) createdFiles.push(source.fileUri);
      const annotation = strokes.length > 0 || baseIsAnnotatedBurn
        ? {
          strokes: strokes.map((s) => ({ points: [...s.points] })),
          sourceUri: source.fileUri,
          sourceMimeType: source.mimeType,
          ...(baseIsAnnotatedBurn ? { baseAnnotated: true } : {}),
        }
        : undefined;
      let candidate: MobileLocalAttachmentUploadCandidate;
      // 非直传白名单(bmp / heic 等能显示但管线不收的格式):即使无笔迹也走
      // 烧录通道——空笔迹烧录 = 光栅化为 PNG,对齐桌面「字节可达 + 发送时
      // 光栅化」模型(PR #792),否则这类图转发会被上传层类型白名单拒收。
      const mustRasterize = !isDirectSendableImageMime(source.mimeType);
      if (strokes.length > 0 || mustRasterize) {
        const burnSource = await prepareBurnSource(source, sizeHint);
        let burned;
        try {
          const base64 = await FileSystem.readAsStringAsync(burnSource.fileUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          burned = await burnIn({
            base64,
            mimeType: burnSource.mimeType,
            strokes,
            ...(burnSource.strokeSpace ? { strokeSpace: burnSource.strokeSpace } : {}),
          });
        } finally {
          if (burnSource.tempUri) {
            void FileSystem.deleteAsync(burnSource.tempUri, { idempotent: true }).catch(() => undefined);
          }
        }
        await ensureDir(burnedDir);
        const name = strokes.length > 0
          ? annotationBurnedFileName(burned.mimeType, nextFileTag())
          : `image-${nextFileTag()}.${burned.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
        const burnedUri = `${burnedDir}${name}`;
        await FileSystem.writeAsStringAsync(burnedUri, burned.base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        createdFiles.push(burnedUri);
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
          ...(annotation ? { annotation } : {}),
        };
      } else {
        const ext = extForMime(source.mimeType);
        candidate = {
          kind: 'image',
          uri: source.fileUri,
          name: `image-${nextFileTag()}.${ext}`,
          // 直传源无解码尺寸,至少带上真实字节数让 preprocess 的重编码判断生效。
          // (lightbox 尺寸提示只用于烧录预缩,不改变直传转发的分辨率。)
          size: source.size,
          mimeType: source.mimeType,
          ...(annotation ? { annotation } : {}),
        };
      }
      if (replaceId) candidate.replacesAttachmentId = replaceId;
      // 入队前先按 candidate.uri(强唯一)登记本次生成的文件:上传成功后
      // decorateUploadedAttachment 把登记迁到 attachment.id 下;上传失败时失败卡
      // 仍可重试,登记与文件原样保留;任务被确定放弃时由上传控制器回调
      // onAbandoned 删除(替换场景与旧附件共享的源副本经引用检查保留)。
      const ownedFiles = [...new Set([candidate.uri, candidate.annotation?.sourceUri]
        .filter((uri): uri is string => !!uri && isHookGeneratedFile(uri)))];
      const registration: PendingUploadRegistration = {
        files: ownedFiles,
        ...(replaceId ? { replacesAttachmentId: replaceId } : {}),
      };
      const registrationKey = candidate.uri;
      pendingUploadsRef.current.set(registrationKey, registration);
      candidate.onAbandoned = () => {
        if (pendingUploadsRef.current.get(registrationKey) !== registration) return;
        pendingUploadsRef.current.delete(registrationKey);
        deleteUnreferencedFiles(registration.files);
      };
      handedToUpload = true;
      opts.enqueueUploads([candidate], { token: opts.getAccessToken() });
      // 旧附件此刻不动:替换在上传成功回调(decorateUploadedAttachment)里执行,
      // 失败时旧附件与其再编辑真相原样保留,用户可重试。
    } catch (err) {
      // 系统 Alert 能盖过全屏 lightbox Modal(composer 错误条此刻被遮挡不可见);
      // lightbox 停留在标注模式,用户可重试或放弃。
      Alert.alert(t('composer.attachments.annotationSaveFailed'), err instanceof Error && err.message ? err.message : t('composer.attachments.tryAgain'));
      throw err;
    } finally {
      // 未交给上传管线就失败:本次新建的副本 / 烧录图无人引用,立即回收
      // (与既有附件共享的源副本经引用检查保留)。
      if (!handedToUpload && createdFiles.length > 0) deleteUnreferencedFiles(createdFiles);
    }
  }, [
    materializeSource,
    prepareBurnSource,
    burnIn,
    burnedDir,
    nextFileTag,
    isHookGeneratedFile,
    deleteUnreferencedFiles,
    hasPendingReplacement,
    t,
  ]);

  const decorateUploadedAttachment = useCallback((
    attachment: RemoteSerializedAttachment,
    candidate: MobileLocalAttachmentUploadCandidate,
  ): RemoteSerializedAttachment => {
    // 接手 submitAnnotation 入队前按 candidate.uri 登记的生成文件:上传成功了,
    // 把在途登记迁到 attachment.id 下。查不到登记(非本 hook 的上传)才重新计算。
    const pending = pendingUploadsRef.current.get(candidate.uri);
    pendingUploadsRef.current.delete(candidate.uri);
    const ownedFiles = pending?.files ?? [candidate.uri, candidate.annotation?.sourceUri]
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
      ...(candidate.annotation.baseAnnotated ? { baseAnnotated: true } : {}),
    });
    return { ...attachment, annotated: true, ...annotationRegionsForUpload(candidate.annotation) };
  }, [isHookGeneratedFile, deleteUnreferencedFiles]);

  const chatAnnotation = useMemo<ImageLightboxAnnotationConfig>(() => ({
    submitLabel: t('composer.attachments.sendToChat'),
    // 一级直发按钮(对齐桌面):不画笔迹也能把历史图转发进 composer 托盘。
    allowDirectSubmit: true,
    prewarm: acquireWarm,
    onSubmit: (_image, displayUri, strokes, context) =>
      submitAnnotation(displayUri, strokes, context.mimeType, null, context),
  }), [submitAnnotation, acquireWarm, t]);

  const trayAnnotation = useMemo<ImageLightboxAnnotationConfig>(() => ({
    submitLabel: t('composer.attachments.save'),
    initialStrokesFor: (image) => metaRef.current.get(image.key)?.strokes,
    // 替换上传未落定(上传中 / 失败待重试)的附件不可再编辑,防双重替换;
    // 画笔置灰,点按说明原因。
    annotationBlockedReason: (image) => (
      hasPendingReplacement(image.key) ? t('composer.attachments.replacementPending') : undefined
    ),
    prewarm: acquireWarm,
    onSubmit: (image, displayUri, strokes, context) =>
      submitAnnotation(displayUri, strokes, context.mimeType, image.key, context),
  }), [submitAnnotation, hasPendingReplacement, acquireWarm, t]);

  /**
   * 信箱消费入口:其它路由(文件浏览器 lightbox 画笔)投递的标注提交,由
   * 会话页在 focus 时逐条交给本方法——与聊天 lightbox 的直发共用同一条
   * 烧录 / 上传 / annotated 链路。
   */
  const submitExternalAnnotation = useCallback(
    (displayUri: string, strokes: AnnotationStroke[], mimeType?: string, sizeHint?: AnnotationSourceSizeHint) =>
      submitAnnotation(displayUri, strokes, mimeType, null, sizeHint),
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
    // 只清附件名下的文件;在途上传(含失败待重试)的文件由上传生命周期回收
    // (放弃时 onAbandoned),这里删会让仍在跑 / 可重试的任务读不到源文件。
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
