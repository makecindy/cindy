/**
 * attachmentGrant.ts — 用户图片过户(docs/dev-rules/plugin-security-and-authoring.md)。
 * ---------------------------------------------------------------------------
 * 归属铁律不动:意识永远只能读自己名下的账。用户想让意识处理**自己的图**,
 * 走"显式引渡":AI 调 ghost_call 时把当前会话里用户图片的 xdt-image:// 地址
 * 放进顶层 attachments → 本模块逐张解析、读字节、落媒体总仓(blob)、给目标
 * 意识记一条 ghost-grant 引用(授权按张、永久,与画廊同生命周期,回收随
 * 引用计数)→ 返回指纹数组。调用方把指纹注入 args.attachments 交给意识——
 * 意识拿到的仍只是字符串,摸不到路径与字节(平台结构保证不破)。
 *
 * 语义:用户把图和请求一起发出 = 对这批图的授权意图明确,不再弹框。
 * **不做**:意识主动申请读任意会话附件的 API(等价于开相册权限)。
 *
 * 依赖注入(规则 14):解析/读盘/落仓/记账全经 deps,单测内存直测。
 */

/** 解析结果:originKind 缺省按 'user'(会话内生成图过户时由接线层查账后传 'tool')。 */
export interface ResolvedGrantSource {
  absPath: string;
  mimeType: string;
  originKind?: 'user' | 'tool';
  /**
   * 解析层已读到的文件字节(可选)。给出时落仓直接用它、不再二次读盘——
   * workdir 外确认流靠这个保证「用户在确认卡上看到的字节 = 实际过户的字节」
   * (两次读盘之间文件被替换会让未经确认的新内容拿到永久授权行)。
   */
  buffer?: Uint8Array;
}

export interface AttachmentGrantDeps {
  /**
   * 附件地址 → 磁盘路径与 mime(越界/非法/账本闸不过一律 throw)。真身是
   * ghostAttachmentResolve + 总仓 blob 形态的账本出生闸(异步查账),故允许
   * 返回 Promise;同步实现照常兼容。
   */
  resolveImageUrl(url: string): ResolvedGrantSource | Promise<ResolvedGrantSource>;
  /** 读文件字节(真身 fs.promises.readFile)。 */
  readFile(absPath: string): Promise<Uint8Array>;
  /** 落字节仓(主机算指纹;真身 blobStore.writeBlob)。 */
  writeBlob(params: { buffer: Uint8Array; mimeType: string }): Promise<{
    hash: string;
    ext: string;
    mimeType: string;
    bytes: number;
  }>;
  /** blob 元数据入账(幂等;真身 ledger.recordBlob)。 */
  recordBlob(params: { hash: string; ext: string; mimeType: string; bytes: number; isCache: boolean }): Promise<void>;
  /** 加引用行(真身 ledger.addRef;出生按解析层给出的真实来源记账)。 */
  addRef(params: {
    hash: string;
    refKind: 'ghost-grant';
    refId: string;
    originKind: 'user' | 'tool';
    label?: string;
  }): Promise<string>;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** 单次过户张数上限(与改图源图上限同量级)。 */
export const MAX_GRANT_ATTACHMENTS = 4;

/** grant_only 批量预授权的张数上限(一张确认卡批一整批,后续免弹)。 */
export const MAX_GRANT_ONLY_ATTACHMENTS = 32;

/**
 * 策略拒绝标记错误:地址**格式正确**但按授权策略不可过户(典型:账本闸拒
 * "未进过聊天流的总仓 blob")。resolve 阶段 catch 到它时把 message 原样透给
 * 模型——落进格式教学文案会反向误导(格式明明对,报错却教格式),自纠必
 * 死循环。其它错误(格式不识别/内部错)仍统一教学文案,不泄内部细节。
 */
export class GrantPolicyError extends Error {}

export type AttachmentGrantResult =
  | { ok: true; hashes: string[] }
  | { ok: false; message: string };

/**
 * 把一批用户图片过户给目标意识。任何一张失败整批拒(不做半成品授权——
 * AI 拿到部分指纹会以为全部就绪,后续改图缺图更难排查)。
 */
export async function grantAttachmentsToGhost(
  deps: AttachmentGrantDeps,
  params: { ghostId: string; urls: string[]; maxCount?: number },
): Promise<AttachmentGrantResult> {
  const { ghostId, urls } = params;
  const maxCount = params.maxCount ?? MAX_GRANT_ATTACHMENTS;
  if (urls.length === 0) return { ok: true, hashes: [] };
  if (urls.length > maxCount) {
    return { ok: false, message: `附件过多(单次上限 ${maxCount} 张)` };
  }
  // 两阶段:先整批解析(纯校验零副作用,最常见的"地址不对"在这里整批拒,
  // 不留半批授权),再逐张落库(读盘/落仓/记账,中途失败仍整批报错;已写入
  // 的授权行无害——那张图确实是用户随消息给出的,留着不构成越权)。
  const resolved: ResolvedGrantSource[] = [];
  for (const url of urls) {
    try {
      resolved.push(await deps.resolveImageUrl(url));
    } catch (err) {
      deps.log?.warn('ghost attachment grant: resolve failed', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
      // 策略拒绝(格式对但不可过户)原样透出,别的落格式教学文案——
      // 让模型看到错误后能一次自纠,不用瞎猜。
      if (err instanceof GrantPolicyError) {
        return { ok: false, message: err.message };
      }
      return {
        ok: false,
        message: `附件地址无法解析:${url}(接受 xdt-image://<会话ID>/<文件名>、cindy-media://blobs/<指纹>.<后缀>,或该图片在本机图片缓存 / 媒体总仓内的绝对路径)`,
      };
    }
  }
  const hashes: string[] = [];
  for (const r of resolved) {
    try {
      const buffer = r.buffer ?? (await deps.readFile(r.absPath));
      const written = await deps.writeBlob({ buffer, mimeType: r.mimeType });
      await deps.recordBlob({
        hash: written.hash,
        ext: written.ext,
        mimeType: written.mimeType,
        bytes: written.bytes,
        isCache: false,
      });
      await deps.addRef({
        hash: written.hash,
        refKind: 'ghost-grant',
        refId: ghostId,
        originKind: r.originKind ?? 'user',
      });
      hashes.push(written.hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log?.warn('ghost attachment grant: import failed', { ghostId, error: message });
      return { ok: false, message: `附件过户失败:${message}` };
    }
  }
  deps.log?.info('ghost attachment grant: done', { ghostId, count: hashes.length });
  return { ok: true, hashes };
}
