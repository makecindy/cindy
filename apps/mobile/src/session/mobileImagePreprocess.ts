/**
 * mobileImagePreprocess.ts — 本机图片上传前降采样 / 压缩。
 * ---------------------------------------------------------------------------
 * 拍照 / 相册原图(quality 1 的 12MP+ JPEG 动辄 5-10MB)直传 OSS 是「拍照后照片
 * 半天不出现」的主因之一。附件的下游消费者是 agent(Anthropic API 对图片长边
 * 上限 ~1568px,超出会被服务端再压),长边 2048 + JPEG 0.8 对模型输入零损失,
 * 上传体积却能降一个数量级。
 *
 *   - 决策(plan)是纯函数,node 可单测;
 *   - 执行(expo-image-manipulator)动态 import + deps 注入,测试不碰原生层;
 *   - gif 跳过(重编码会毁动画);png / webp 只在需要缩尺寸时处理并输出 png(不毁透明);
 *   - 处理失败或产物反而更大时回退原图——压缩只能锦上添花,不能挡住发图。
 */

export interface MobileImagePreprocessInput {
  uri: string;
  name: string;
  mimeType?: string;
  /** 原文件字节数,0 = 未知。 */
  size: number;
  width?: number | null;
  height?: number | null;
}

export interface MobileImagePreprocessOutput {
  uri: string;
  name: string;
  mimeType?: string;
  /** 处理后文件字节数,0 = 未知(由调用方 stat 兜底)。 */
  size: number;
}

export interface MobileImagePreprocessPlan {
  /** 传给 manipulator 的等比缩放目标(只给长边一维);null = 只重编码不缩尺寸。 */
  resize: { width: number } | { height: number } | null;
  format: 'jpeg' | 'png';
  compress: number;
}

/** 长边超过此值才缩尺寸;2048 > Anthropic 服务端上限(~1568),模型侧零损失。 */
export const MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE = 2048;
export const MOBILE_IMAGE_UPLOAD_JPEG_QUALITY = 0.8;
/** 文件小于此值时不值得重编码,直接原样上传。 */
export const MOBILE_IMAGE_UPLOAD_SKIP_BYTES = 400 * 1024;
/**
 * 文件超过此值不在手机上解码处理,原样上传:整图解码的内存随像素增长,超大图可能让进程被系统终止。
 * 与放开附件体积前的解码范围一致(当时超过 30 MB 的图片不会进入这里)。
 */
export const MOBILE_IMAGE_PREPROCESS_MAX_BYTES = 30 * 1024 * 1024;

/**
 * 决定一张图要不要 / 怎么在上传前处理。返回 null = 原样上传。
 */
export function planMobileImageUploadPreprocess(
  input: Pick<MobileImagePreprocessInput, 'mimeType' | 'size' | 'width' | 'height'>,
): MobileImagePreprocessPlan | null {
  const mime = (input.mimeType ?? '').trim().toLowerCase();
  if (mime === 'image/gif') return null;
  if (input.size > MOBILE_IMAGE_PREPROCESS_MAX_BYTES) return null;

  const width = normalizeDim(input.width);
  const height = normalizeDim(input.height);
  const longEdge = Math.max(width, height);
  const needsResize = longEdge > MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE;
  const isBig = input.size > MOBILE_IMAGE_UPLOAD_SKIP_BYTES;

  if (mime === 'image/png' || mime === 'image/webp') {
    // png / webp 可能带透明,绝不能进 JPEG 重编码分支(透明区会被拍平成黑/白底,
    // 内容被静默改坏);只有缩尺寸有收益时才处理。输出统一 PNG:保 alpha 且两端
    // 都支持编码(iOS 的 ImageManipulator 不支持 WEBP 编码,规则 15 跨平台口径);
    // 产物若反而更大,preprocess 入口的体积守卫会回退原图。
    if (!needsResize) return null;
    return {
      resize: resizeForLongEdge(width, height),
      format: 'png',
      compress: 1,
    };
  }

  if (!needsResize && !isBig) return null;
  return {
    // 尺寸未知时不缩(manipulator 的 resize 会放大小图),只做 JPEG 重编码。
    resize: needsResize ? resizeForLongEdge(width, height) : null,
    format: 'jpeg',
    compress: MOBILE_IMAGE_UPLOAD_JPEG_QUALITY,
  };
}

/** 按 plan.format 同步文件扩展名(mobile-image-1.png → mobile-image-1.jpg)。 */
export function renameForMobileImagePreprocess(name: string, format: 'jpeg' | 'png'): string {
  const targetExt = format === 'png' ? 'png' : 'jpg';
  const dotIdx = name.lastIndexOf('.');
  const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  return `${base}.${targetExt}`;
}

/** 可注入的 manipulator 执行实现(测试用)。 */
export type MobileImageManipulateRunner = (
  uri: string,
  plan: MobileImagePreprocessPlan,
) => Promise<{ uri: string }>;

export interface MobileImagePreprocessDeps {
  run?: MobileImageManipulateRunner;
  /** 读处理产物字节数;默认 expo-file-system。 */
  statSize?: (uri: string) => Promise<number>;
}

/**
 * 上传前处理入口:plan 为 null 或执行失败时原样返回;产物没有变小也回退原图。
 */
export async function preprocessMobileImageForUpload(
  input: MobileImagePreprocessInput,
  deps: MobileImagePreprocessDeps = {},
): Promise<MobileImagePreprocessOutput> {
  const original: MobileImagePreprocessOutput = {
    uri: input.uri,
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
  };
  const plan = planMobileImageUploadPreprocess(input);
  if (!plan) return original;
  try {
    const run = deps.run ?? runManipulateNative;
    const result = await run(input.uri, plan);
    const statSize = deps.statSize ?? statSizeNative;
    const size = await statSize(result.uri);
    if (!Number.isFinite(size) || size <= 0) return original;
    // 原 size 已知且产物没变小(小图重编码可能反增)→ 白做,回退原图。
    if (input.size > 0 && size >= input.size) return original;
    return {
      uri: result.uri,
      name: renameForMobileImagePreprocess(input.name, plan.format),
      mimeType: plan.format === 'png' ? 'image/png' : 'image/jpeg',
      size,
    };
  } catch {
    // 压缩失败不能挡发图,静默回退原图(上传路径自身仍有大小校验兜底)。
    return original;
  }
}

function normalizeDim(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function resizeForLongEdge(
  width: number,
  height: number,
): { width: number } | { height: number } {
  // 只给长边一维,manipulator 会按比例算另一维。
  return width >= height
    ? { width: MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE }
    : { height: MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE };
}

/**
 * expo-image-manipulator 新 context API。动态 import 保证本模块在 vitest(node)
 * 下可导入——测试路径全部经 deps.run 注入(与 mobileAttachmentUpload 同模式)。
 */
async function runManipulateNative(
  uri: string,
  plan: MobileImagePreprocessPlan,
): Promise<{ uri: string }> {
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const context = ImageManipulator.manipulate(uri);
  if (plan.resize) context.resize(plan.resize);
  const rendered = await context.renderAsync();
  try {
    const saved = await rendered.saveAsync({
      compress: plan.compress,
      format: plan.format === 'png' ? SaveFormat.PNG : SaveFormat.JPEG,
    });
    return { uri: saved.uri };
  } finally {
    rendered.release();
    context.release();
  }
}

async function statSizeNative(uri: string): Promise<number> {
  const { statMobileAttachmentFileSize } = await import('@/session/mobileAttachmentUpload');
  return statMobileAttachmentFileSize(uri);
}
