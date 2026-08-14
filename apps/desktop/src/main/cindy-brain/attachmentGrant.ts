/**
 * attachmentGrant.ts — 用户图片过户(docs/dev-rules/plugin-security-and-authoring.md)。
 * ---------------------------------------------------------------------------
 * 归属铁律不动:意识永远只能读自己名下的账。用户想让意识处理**自己的图**,
 * 走"显式引渡":AI 调 ghost_call 时把当前会话里用户图片的 xdt-image:// 地址
 * 放进顶层 attachments → 本模块逐张解析、读字节、落媒体总仓(blob)、给目标
 * 意识记一条可读引用(人工交接 = ghost-grant；Host 工具代办 =
 * ghost-tool-grant)→ 返回指纹数组。调用方把指纹注入 args.attachments 交给意识——
 * 意识拿到的仍只是字符串,摸不到路径与字节(平台结构保证不破)。
 *
 * 语义:用户把图和请求一起发出 = 对这批图的授权意图明确,不再弹框。
 * **不做**:意识主动申请读任意会话附件的 API(等价于开相册权限)。
 *
 * 依赖注入(规则 14):解析/读盘/落仓/记账全经 deps,单测内存直测。
 */

import { randomUUID } from 'node:crypto';

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
    /** 预留的精确引用 id；策略在 await 后失效时只能回滚本次创建的行。 */
    id: string;
    hash: string;
    refKind: 'ghost-grant' | 'ghost-tool-grant';
    refId: string;
    originKind: 'user' | 'tool';
    label?: string;
  }): Promise<void>;
  /** 精确回滚本次预留的授权行；不触碰旧交接或其它并发调用的引用。 */
  removeRefById(id: string): Promise<unknown>;
  /**
   * 在任何 addRef 前先持久化整批精确 id；perform 失败时即时补偿，
   * 补偿失败也必须留下可由同 owner DB 重启重放的日志。
   */
  withRefCompensation<T>(params: {
    refIds: readonly string[];
    perform: () => Promise<T>;
    compensate: (refId: string) => Promise<unknown>;
  }): Promise<T>;
  /**
   * 调用方提供的同步实时授权断言。它会在每个异步持久化边界前后执行，
   * 确保工具在落仓期间切为 blocked 时不留下可读 grant ref。
   */
  assertStillAllowed?(): void;
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
  | {
      ok: true;
      hashes: string[];
      /**
       * 撤销本次刚授出的全部 ref。复用出生阶段同一条 withRefCompensation
       * 持久补偿协议(先落 pending 标记再逐条删),不是裸循环 removeRefById——
       * 半路失败或进程崩溃时,标记留在盘上,下一次同 owner DB 就绪的 reconcile
       * 会按标记里的精确 id 重放删除,不会把已批准过、现在必须撤销的授权行
       * 永久遗留在账上。对调用方而言仍是不重抛的 best-effort:失败只记 warn
       * 继续——调用方已经在处理另一个更早的失败原因，撤销本身再失败不能
       * 盖过那个原因。授权成功返回之后，本函数所在的 ghost_call 仍可能因为
       * 无关原因（目录确认、setup 状态、blocked 复判…）继续失败；那些路径
       * 必须调用它，否则会把「写完才拒绝」的已生效授权副作用留在账上（见
       * docs/dev-rules/plugin-security-and-authoring.md §3.1 第 4 条）。
       * 空批返回的 revoke 是无操作 no-op。
       */
      revoke: () => Promise<void>;
    }
  | { ok: false; message: string; errorCode?: 'PERMISSION_DENIED' };

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
  if (urls.length === 0) return { ok: true, hashes: [], revoke: async () => {} };
  if (urls.length > maxCount) {
    return { ok: false, message: `附件过多(单次上限 ${maxCount} 张)` };
  }
  // 三阶段:先整批解析(零副作用),再落 blob/元数据(仍未授权),
  // 最后才在持久补偿日志保护下整批挂 ref。任何一张失败都不能留下
  // 半批可读授权;孤立的内容寻址 blob 不构成插件读权。
  const resolved: ResolvedGrantSource[] = [];
  for (const url of urls) {
    try {
      deps.assertStillAllowed?.();
      resolved.push(await deps.resolveImageUrl(url));
      deps.assertStillAllowed?.();
    } catch (err) {
      deps.log?.warn('ghost attachment grant: resolve failed', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
      // 策略拒绝(格式对但不可过户)原样透出,别的落格式教学文案——
      // 让模型看到错误后能一次自纠,不用瞎猜。
      if (err instanceof GrantPolicyError) {
        return { ok: false, errorCode: 'PERMISSION_DENIED', message: err.message };
      }
      return {
        ok: false,
        message: `附件地址无法解析:${url}(接受 xdt-image://<会话ID>/<文件名>、cindy-media://blobs/<指纹>.<后缀>,或该图片在本机图片缓存 / 媒体总仓内的绝对路径)`,
      };
    }
  }
  const prepared: Array<{
    id: string;
    hash: string;
    refKind: 'ghost-grant' | 'ghost-tool-grant';
    refId: string;
    originKind: 'user' | 'tool';
  }> = [];
  try {
    for (const r of resolved) {
      deps.assertStillAllowed?.();
      const buffer = r.buffer ?? (await deps.readFile(r.absPath));
      deps.assertStillAllowed?.();
      const written = await deps.writeBlob({ buffer, mimeType: r.mimeType });
      // 内容寻址 blob 本身不授予插件读取能力；真正的授权边界是下面的
      // ghost-grant ref。仍在每个 await 后重判，阻止后续 metadata/ref 写入。
      deps.assertStillAllowed?.();
      await deps.recordBlob({
        hash: written.hash,
        ext: written.ext,
        mimeType: written.mimeType,
        bytes: written.bytes,
        isCache: false,
      });
      deps.assertStillAllowed?.();
      const originKind = r.originKind ?? 'user';
      prepared.push({
        // 在首个 INSERT 前预留整批 id：即使 DB 已提交但 worker
        // 回执丢失，持久补偿也只会删除这次尝试的精确行。
        id: randomUUID(),
        hash: written.hash,
        // refKind 本身就是回退兼容边界:旧客户端只把 ghost-grant 当成人工
        // 永久授权，因而工具自动交接必须落到它不认识的独立类型。
        refKind: originKind === 'user' ? 'ghost-grant' : 'ghost-tool-grant',
        refId: ghostId,
        originKind,
      });
    }

    // 整批授权行共用一个持久补偿事务。日志必须在第一个
    // addRef 前落盘；中途 blocked、DB 丢 ACK、即时删除失败或进程
    // 崩溃都能由同 owner 的下次 DB ready 精确补偿。
    //
    // 空批次必须**跳过**补偿事务:真身 withMediaRefCompensation 对
    // refIds.length === 0 是硬抛(空事务没有可回滚的行,落一份空日志纯属
    // 污染)。零附件在本函数的契约里是合法的直通成功,不能因为记账层的
    // 批次校验被翻译成「附件过户失败」。
    if (prepared.length > 0) {
      await deps.withRefCompensation({
        refIds: prepared.map((grant) => grant.id),
        compensate: deps.removeRefById,
        perform: async () => {
          for (const grant of prepared) {
            deps.assertStillAllowed?.();
            await deps.addRef(grant);
            deps.assertStillAllowed?.();
          }
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.warn('ghost attachment grant: import failed', { ghostId, error: message });
    if (err instanceof GrantPolicyError) {
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: err.message };
    }
    return { ok: false, message: `附件过户失败:${message}` };
  }
  const hashes = prepared.map((grant) => grant.hash);
  deps.log?.info('ghost attachment grant: done', { ghostId, count: hashes.length });
  const revoke = async (): Promise<void> => {
    const refIds = prepared.map((grant) => grant.id);
    try {
      await deps.withRefCompensation({
        refIds,
        // 目标就是删除,perform 与 compensate 因此是同一个幂等操作:无论
        // 走到哪一半失败,两条路径收敛到同一个结果——批内每条 ref 都尝试
        // 删过。真身 removeRefById 是 DELETE WHERE id=?,重复删不存在的
        // id 不报错,可以安全重放。
        perform: async () => {
          for (const grant of prepared) {
            await deps.removeRefById(grant.id);
          }
        },
        compensate: (refId) => deps.removeRefById(refId),
      });
    } catch (err) {
      deps.log?.warn('ghost attachment grant: revoke-on-later-failure did not remove every ref', {
        ghostId,
        refIds,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  return { ok: true, hashes, revoke };
}
