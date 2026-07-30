/**
 * cindySlot.ts — cindy 槽代办(卡槽⑤,原名模型槽)。
 * ---------------------------------------------------------------------------
 * 意识沙箱零网络零文件,
 * 想用 AI 只能经管子请主机代办。本模块处理上行 cindy-request(旧名 model-request 兼容):
 *
 *   电子脑 cindy.send({type:'cindy-request', kind:'gen_image'|'edit_image'|'gen_video'|'edit_video', …})
 *     → 资格审(声明了 'cindy' 卡槽 + 能力详单?按类目.动作粒度)
 *     → 频控(默认不限并发;用户可按意识配置在途上限,经 deps.getInflightLimit
 *       注入——配了才闸,防失控刷付费接口;配额治理随分发渠道重启)
 *     → 模型白名单校验(意识只能从主机菜单里挑,挑不了菜单外的任何路由;
 *       图像/视频各一份白名单与默认,同来自 providers.json 目录;该类目清单
 *       为空 = 能力暂不可用,直接拒单)
 *     → 画面参数校验(图像 aspectRatio / 视频 ratio·resolution·duration·fps):
 *       协议层值域粗筛 + 按解析出的型号二次校验;一项都不传 = 与老协议逐字节
 *       同形,后端走该型号出厂默认
 *     → 吃源图的代办(改图/图生视频):指纹逐张查账验归属(只能用自己名下的媒体)
 *     → 主机走统一媒体通道干活(字节从头到尾在主机手里;视频为分钟级长任务)
 *     → 落 blob(SHA-256 主机算)+ 账本记账(出生=该意识)
 *     → 只回指纹/地址字符串(GhostPipeModelResult)
 *
 * 记账口径:意识产物加一条
 * ghost-gallery ref(出生=该意识)——面板供图的归属校验(ghostCanRead)
 * 与"产物不被回收"同时成立;配额上限由权限策略负责。
 *
 * 另有两个**不经模型**的媒体代办(makecindy/cindy#784),走本模块只因为它们
 * 共用同一套资格审与归属账本:
 *
 *   deposit_media:意识手里已有的媒体字节(面板里用户粘贴/拖入的图)
 *     → 魔数验型(不信自报 mime)→ 单次上限 / 令牌桶频控 / 每意识累计配额
 *     → 落仓 + ghost-deposit 记账 → 回指纹。从此这些媒体与生成图同权,
 *       可直接当 edit_image / edit_video 的源图("画布上的图 = AI 能改的图")。
 *   release_media:撤回自己的寄存引用(面板删素材时释放配额)。
 *
 * 寄存刻意**不进** ghost_call 产物账(recordGhostCallMedia):它不是产物,
 * 而是用户自己的输入图——被当产物自动送进聊天/IM 会是隐私事故。
 *
 * 依赖注入(规则 14):生成/落盘/记账/归属解析全部经 deps,单测直测。
 */

import { randomUUID } from 'node:crypto';

import {
  GHOST_CINDY_DEPOSIT_BURST,
  GHOST_CINDY_DEPOSIT_MAX_BYTES,
  GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
  GHOST_CINDY_DEPOSIT_REFILL_MS,
  GHOST_CINDY_JOB_TTL_MS,
  GHOST_CINDY_MAX_ASYNC_JOBS,
  GHOST_IMAGE_ASPECT_RATIOS,
  GHOST_MODEL_TIERS,
  GHOST_VIDEO_MAX_DURATION_SECONDS,
  GHOST_VIDEO_MAX_FPS,
  GHOST_VIDEO_RATIOS,
  GHOST_VIDEO_RESOLUTIONS,
  type GhostImageAspectRatio,
  type GhostModelTier,
  type GhostPipeModelResult,
  type GhostVideoRatio,
  type GhostVideoResolution,
  type GhostVideoResultParams,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { probeImageSize } from './imageProbe.js';

/**
 * 媒体能力配置(图像/视频同构):白名单 + 默认/档位选型,真身在 providers.json 目录。
 * models 空 / defaults null = 目录没有该类目的任何模型 = 该能力暂不可用(见
 * cindyMediaCatalog.ts 的空清单语义),本模块据此早拒,不拿不在册的型号下单。
 */
export interface CindyMediaConfig {
  models: ReadonlyArray<{ id: string; label: string }>;
  defaults: { standard: string; draft: string; best: string } | null;
}

/**
 * 视频画面参数(意识可选传;不传的项由 provider 层填该型号的出厂默认)。
 * 每一项都条件展开——不传时载荷里连键都没有,与老协议逐字节同形。
 */
export interface CindyVideoParams {
  ratio?: GhostVideoRatio;
  resolution?: GhostVideoResolution;
  duration?: number;
  fps?: number;
}

/** 某个视频型号的实际支持集(provider capabilities 的投影,用于按型号二次校验)。 */
export interface CindyVideoCapabilities {
  durations: readonly number[];
  resolutions: readonly string[];
  ratios: readonly string[];
  fps: readonly number[];
}

export interface CindySlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 主机统一图片通道(art 底层客户端);返回图片字节与 mime。
   *  aspectRatio 是意识的画幅意图,注入实现负责翻译成后端具体尺寸。 */
  generateImage(params: {
    prompt: string;
    model: string;
    aspectRatio?: GhostImageAspectRatio;
  }): Promise<{ buffer: Uint8Array; mimeType: string }>;
  /** 主机统一图片通道·改图;源图以磁盘路径喂给网关(意识摸不到路径)。
   *  aspectRatio 语义同 generateImage:不传 = 跟随源图画幅(后端 auto)。 */
  editImage(params: {
    prompt: string;
    model: string;
    imagePaths: string[];
    aspectRatio?: GhostImageAspectRatio;
  }): Promise<{ buffer: Uint8Array; mimeType: string }>;
  /**
   * 主机统一视频通道·文生视频(art 视频 provider 层复用,submit→
   * 轮询→下载一条龙在注入实现里完成);返回视频字节与 mime,外加实际
   * 生效的画面参数回执(上游上报值优先,缺项回落提交值)。长任务:
   * 分钟级才 resolve,在途名额在整个等待期占用。
   */
  generateVideo(
    params: { prompt: string; model: string } & CindyVideoParams,
  ): Promise<{ buffer: Uint8Array; mimeType: string; videoParams?: GhostVideoResultParams }>;
  /** 主机统一视频通道·参考图生视频(1 张=首帧,2 张=首尾帧;源图以磁盘路径注入)。 */
  editVideo(
    params: { prompt: string; model: string; imagePaths: string[] } & CindyVideoParams,
  ): Promise<{ buffer: Uint8Array; mimeType: string; videoParams?: GhostVideoResultParams }>;
  /**
   * 该视频型号的画面参数支持集(provider capabilities;registry 缺席或查无
   * 该型号 → null)。可选依赖:不注入 = 跳过按型号校验,只做协议层粗筛
   * (值仍会被 provider 层自己的校验拦下,只是话术不如这里友好)。
   */
  videoCapabilities?(model: string): CindyVideoCapabilities | null;
  /**
   * 指纹 → 磁盘路径,且仅当该媒体在此意识名下(出生或画廊,查账本);
   * 不属于它 / 查无此账 / 文件缺失一律 null(不区分,不给探测空间)。
   */
  resolveOwnedMedia(ghostId: string, hash: string): Promise<string | null>;
  /**
   * 意识专属后端覆盖(解析表第②层,用户在意识详情页钉的);无覆盖返回
   * null。capability 为能力键(image.generate / video.edit …);返回值仍过
   * 白名单校验(型号可能已随主机演进下架)。
   */
  getOverride(ghostId: string, capability: string): string | null;
  /**
   * 当前图像能力配置——真身是 providers.json 运行时目录(与会话模型列表
   * 同一获取来源),每单现读跟随热更。models = 白名单与显示名;defaults =
   * 默认/档位选型(同样来自目录,代码零模型字面量);清单空 / defaults null
   * = 目录没给,能力暂不可用。
   */
  getImageConfig(): CindyMediaConfig;
  /** 当前视频能力配置(同 getImageConfig 语义;白名单 id = 视频 provider 层 alias)。 */
  getVideoConfig(): CindyMediaConfig;
  /**
   * 该意识的在途代办并发上限(用户配置,隐藏配置层级);null = 未配置 =
   * 不限并发。可选依赖:不注入等同全部不限。每单现读,配置热更即生效。
   */
  getInflightLimit?(ghostId: string): number | null;
  /** 落 blob + 账本记账(出生=该意识);返回取件地址与指纹。 */
  saveGhostMedia(params: {
    ghostId: string;
    buffer: Uint8Array;
    mimeType: string;
    /** 人类可读备注(记进账本 label,画廊 caption 用)。 */
    label?: string;
    /** tool-call callId(记入 ghostMediaLedger 供 ghost_call 收口带回)。 */
    callId?: string;
  }): Promise<{ url: string; hash: string; ext: string }>;
  /**
   * ── deposit_media 三件套(可选依赖:不注入 = 寄存能力在运行期不可用,
   *    资格审通过也会回结构化拒绝。未接线的宿主/测试环境天然 fail closed)──
   */
  /**
   * 字节 → 受支持媒体的真实 mime(魔数识别,与 network `as:'media'` 同一实现)。
   * 识别不出受支持媒体返回 null —— 调用方自报的 mime / 扩展名一律不作为依据。
   */
  sniffDepositMime?(buffer: Uint8Array): string | null;
  /** 寄存落仓 + ghost-deposit 记账(出生=用户,引用方=该意识)。 */
  depositMedia?(params: {
    ghostId: string;
    buffer: Uint8Array;
    mimeType: string;
    label?: string;
  }): Promise<{ url: string; hash: string; ext: string; bytes: number; deduplicated: boolean }>;
  /** 该意识寄存物的账面字节占用(配额判定;每单现读)。 */
  depositUsageBytes?(ghostId: string): Promise<number>;
  /** 撤回该意识对某指纹的寄存引用;返回是否真的删掉了行(false = 本就没有)。 */
  releaseDeposit?(params: { ghostId: string; hash: string }): Promise<boolean>;
  /**
   * 管子续命挂钩(pipeDispatcher.holdCall/releaseCall 接线):tool-call
   * 触发的同步视频代办开始时 hold(budgetMs = 这单的轮询预算),结束时
   * release——署名单在途期间管子不再按 330s 掐掉。ghostId = 主机反查的
   * 代办发起方,派发器按它配对验身(冒用别人的 callId 不生效)。可选
   * 依赖:不注入(纯测试环境)等同不续命。
   */
  holdPipeCall?(ghostId: string, callId: string, budgetMs: number): void;
  releasePipeCall?(ghostId: string, callId: string): void;
  /**
   * 视频型号预期耗时(秒;video registry 登记值)。hold 预算与异步受理
   * 返回的 expectedSeconds 共用。未注入/查无该型号 → null(用缺省)。
   */
  videoExpectedSeconds?(model: string): number | null;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** prompt 长度上限(与 ghost.json 工具声明的量级一致,防沙箱塞超长文本)。 */
const MAX_PROMPT_LEN = 4000;

/** 改图单次源图上限(沿用原 lizi_art 多图融合的常用量级)。 */
const MAX_EDIT_SOURCES = 4;

/** 图生视频参考图上限(1 张=首帧动画,2 张=首尾帧过渡;provider 层同上限)。 */
const MAX_VIDEO_SOURCES = 2;

/** 归因号长度上限(tool-call 配对号量级;超长视为沙箱乱填,拒单防日志注水)。 */
const MAX_CALL_ID_LEN = 128;

/** 视频预期耗时缺省(秒;与 video/run.ts 的缺省同口径)。 */
const DEFAULT_VIDEO_EXPECTED_SECONDS = 120;

/** 异步任务号长度上限(主机铸 UUID 量级;超长视为沙箱乱填)。 */
const MAX_JOB_ID_LEN = 64;

/** 寄存备注长度上限(与生成产物的 label 切长同量级)。 */
const MAX_DEPOSIT_LABEL_LEN = 200;

/**
 * base64 载荷的字符长度上限:先按字符数早拒,再解码——不先拦就得为一条
 * 恶意超长字符串分配整个解码缓冲。4/3 是 base64 膨胀率,+8 容纳 padding 与
 * 换行(判据与 fsSlot 的 base64 写入一致)。
 */
const MAX_DEPOSIT_B64_CHARS = (GHOST_CINDY_DEPOSIT_MAX_BYTES * 4) / 3 + 8;

/** 不含 data: 前缀的 base64 字符集(允许换行,与 fsSlot 同口径)。 */
const BASE64_RE = /^[A-Za-z0-9+/=\r\n]*$/;

/**
 * 每意识完成态(done/failed)任务记录保留上限:TTL 之外的第二道闸——
 * 快速失败/快速完成的 submit 循环不受 running 在途闸限制,没有条数上限
 * 就能在 TTL 窗口内堆记录。超出即淘汰最旧,正常插件(一次 1–2 单)碰不到。
 */
const MAX_SETTLED_JOBS_PER_GHOST = 16;

/** 异步代办任务(mode:'submit')的在途/完成记录。内存表:主进程重启即丢,
 *  query_job 对丢失单统一回"查无此任务",意识按可重新提交处理。 */
interface CindyAsyncJob {
  ghostId: string;
  /** 人话动词(失败话术,来自 KIND_INFO.verb)。 */
  verb: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  /** done:与同步成功返回同形的取件字段。 */
  result?: {
    url: string;
    hash: string;
    ext: string;
    model: string;
    modelLabel: string;
    /** 实际生效的画面参数(异步代办只有视频;上游没报即缺省)。 */
    videoParams?: GhostVideoResultParams;
  };
  /** failed:人话失败原因。 */
  error?: string;
  /** 完成时刻(done/failed;TTL 从这里起算)。 */
  doneAt?: number;
}

/** 每种代办类型的静态口径(类目/动作/是否吃源图/人话动词)。 */
interface CindyKindInfo {
  category: 'image' | 'video';
  action: 'generate' | 'edit';
  usesSources: boolean;
  maxSources: number;
  /** 人话动词(资格审与失败话术)。 */
  verb: string;
}

const KIND_INFO: Record<string, CindyKindInfo> = {
  gen_image: { category: 'image', action: 'generate', usesSources: false, maxSources: 0, verb: '出图' },
  edit_image: { category: 'image', action: 'edit', usesSources: true, maxSources: MAX_EDIT_SOURCES, verb: '改图' },
  gen_video: { category: 'video', action: 'generate', usesSources: false, maxSources: 0, verb: '生成视频' },
  edit_video: { category: 'video', action: 'edit', usesSources: true, maxSources: MAX_VIDEO_SOURCES, verb: '图生视频' },
};

const CATEGORY_LABEL: Record<CindyKindInfo['category'], string> = { image: '图像', video: '视频' };

/**
 * ── 图像能力的选型解析(2026-07-11 设计定案)──────────────────────────
 * 意识只表达意图(tier 档位)或透传用户显式点名(model);"用谁干"由主机
 * 解析,优先级:调用显式点名 > 意识专属覆盖(意识详情页钉的,经
 * getImageOverride 注入)> 档位/出厂默认。用户能力全局偏好层等多供应商
 * 接入时在覆盖与档位之间插入。
 */

// 可选清单与默认/档位选型都不再是本模块常量:经 deps.getImageConfig 注入,
// 真身来自 providers.json 运行时目录(与会话模型列表同一获取来源,OSS 热更
// 同机制),见 index.ts 的 getCatalogImageConfig 与 cindyMediaCatalog.ts 的派生
// 规则。本文件零模型字面量;目录没给清单时不猜、不顶,直接拒单。

/** 指纹形状(与 blobStore 同一规则;这里先粗筛,细校验在归属解析)。 */
const HASH_RE = /^[0-9a-f]{64}$/;

/** 沙箱传来的数值粗筛:正整数且不超过上限(挡负数、小数、天文数字、NaN)。 */
function isPositiveIntWithin(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * 按型号能力核对画面参数,返回人话的"哪项不支持 + 该型号可用值";全部
 * 支持返回 null。一次只报第一项不支持的——意识修一项再来即可,堆一长串
 * 反而不好读。
 */
function describeUnsupportedVideoParams(
  params: CindyVideoParams,
  caps: CindyVideoCapabilities,
): string | null {
  if (params.ratio !== undefined && !caps.ratios.includes(params.ratio)) {
    return `画幅 ${params.ratio}(可用:${caps.ratios.join(' / ')})`;
  }
  if (params.resolution !== undefined && !caps.resolutions.includes(params.resolution)) {
    return `分辨率 ${params.resolution}(可用:${caps.resolutions.join(' / ')})`;
  }
  if (params.duration !== undefined && !caps.durations.includes(params.duration)) {
    return `时长 ${params.duration}s(可用:${caps.durations.join(' / ')} 秒)`;
  }
  if (params.fps !== undefined && !caps.fps.includes(params.fps)) {
    return `帧率 ${params.fps}fps(可用:${caps.fps.join(' / ')})`;
  }
  return null;
}

export class GhostCindySlot {
  private readonly inflight = new Map<string, number>();
  /** 异步代办任务表(jobId → 记录;惰性 sweep,过期即清)。 */
  private readonly jobs = new Map<string, CindyAsyncJob>();
  /**
   * 寄存频控令牌桶(ghostId → 余量与结算时刻)。进程内状态:主进程重启即满,
   * 与配额(落在账本里的硬上限)是两道独立的闸,重启只放松频控不放松配额。
   */
  private readonly depositBuckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly deps: CindySlotDeps) {}

  /**
   * 处理一条 cindy-request(ghost-pipe:send 的 invoke 返回值即本结果)。
   * 永不 reject——一切失败折叠成 { ok:false, message },沙箱拿到的是
   * 结构化拒绝而不是异常穿透。
   */
  async handleModelRequest(ghostId: string, payload: unknown): Promise<GhostPipeModelResult> {
    this.sweepJobs();
    const p = payload as {
      kind?: unknown;
      prompt?: unknown;
      tier?: unknown;
      model?: unknown;
      aspectRatio?: unknown;
      ratio?: unknown;
      resolution?: unknown;
      duration?: unknown;
      fps?: unknown;
      hashes?: unknown;
      callId?: unknown;
      mode?: unknown;
      jobId?: unknown;
      data?: unknown;
      label?: unknown;
      hash?: unknown;
    };
    if (p?.kind === 'query_job') {
      return this.handleQueryJob(ghostId, p);
    }
    // 不经模型的媒体代办(#784):早于 KIND_INFO 分流——它们没有 prompt、
    // 没有选型、不占在途名额,与生成链一条都不共用。这条分支自带兜底 catch:
    // 生成链的兜底在下面那个大 try 里,这里已经 return 出去了,不共用它,
    // 而"永不 reject"是本类对沙箱的硬承诺(注入的嗅探/账本抛错也不许穿透)。
    if (p?.kind === 'deposit_media' || p?.kind === 'release_media') {
      const verb = p.kind === 'deposit_media' ? '寄存' : '撤回寄存';
      try {
        return p.kind === 'deposit_media'
          ? await this.handleDepositMedia(ghostId, p)
          : await this.handleReleaseMedia(ghostId, p);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log?.warn(`ghost cindy-request ${p.kind} unexpected failure`, {
          ghostId,
          error: message,
        });
        return { ok: false, message: `${verb}失败:${message}` };
      }
    }
    const info = typeof p?.kind === 'string' ? KIND_INFO[p.kind] : undefined;
    if (!info) {
      return {
        ok: false,
        message:
          `未知的代办类型(当前支持 ${Object.keys(KIND_INFO).join(' / ')} / ` +
          'deposit_media / release_media / query_job)',
      };
    }
    const kind = p.kind as string;
    if (p.mode !== undefined && p.mode !== 'submit') {
      return { ok: false, message: "mode 只支持 'submit'(异步提交)或不传(同步等待)" };
    }
    if (p.mode === 'submit' && info.category !== 'video') {
      return {
        ok: false,
        message: '异步提交(mode:submit)仅支持视频类代办;图像代办秒级完成,直接同步等待',
      };
    }
    if (typeof p.prompt !== 'string' || p.prompt.trim().length === 0) {
      return { ok: false, message: 'prompt 不能为空' };
    }
    if (p.prompt.length > MAX_PROMPT_LEN) {
      return { ok: false, message: `prompt 过长(上限 ${MAX_PROMPT_LEN} 字符)` };
    }
    const prompt = p.prompt;
    // 归因号:可选——tool-call 触发的代办把 callId 原样带回,日志/
    // 配额由此对上"哪次调用花的钱";面板交互等自发代办可不带,日志记
    // unattributed。带了就必须像样(非空字符串、长度设限),乱填拒单。
    if (p.callId !== undefined && (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > MAX_CALL_ID_LEN)) {
      return { ok: false, message: 'callId 不合法(1–128 字符的字符串,或不传)' };
    }
    const callId = (p.callId as string | undefined) ?? 'unattributed';

    // 画幅意图(可选,图像类代办):意识声明比例,注入实现翻译成后端具体
    // 尺寸。视频类另有 ratio(值域不同)——带错了就是用错协议,明拒好过
    // 静默忽略。不传 = 后端 auto(生图由模型自定,改图跟随源图画幅)。
    if (p.aspectRatio !== undefined) {
      if (info.category !== 'image') {
        return { ok: false, message: 'aspectRatio 仅支持图像类代办(视频画幅请用 ratio,值域不同)' };
      }
      if (
        typeof p.aspectRatio !== 'string' ||
        !(GHOST_IMAGE_ASPECT_RATIOS as readonly string[]).includes(p.aspectRatio)
      ) {
        return { ok: false, message: `未知画幅比例(可用:${GHOST_IMAGE_ASPECT_RATIOS.join(' / ')})` };
      }
    }
    const aspectRatio = p.aspectRatio as GhostImageAspectRatio | undefined;

    // 视频画面参数(可选,仅视频类代办):协议层只做值域/形状粗筛,按型号
    // 的可用集在选型解析之后二次校验(各型号支持的时长差异很大)。图像类
    // 带了这几项 = 用错协议,明拒。
    const videoParamKeys = ['ratio', 'resolution', 'duration', 'fps'] as const;
    const presentVideoKeys = videoParamKeys.filter((k) => p[k] !== undefined);
    if (presentVideoKeys.length > 0 && info.category !== 'video') {
      return {
        ok: false,
        message: `${presentVideoKeys.join(' / ')} 仅支持视频类代办(图像画幅请用 aspectRatio)`,
      };
    }
    if (p.ratio !== undefined && !(GHOST_VIDEO_RATIOS as readonly unknown[]).includes(p.ratio)) {
      return { ok: false, message: `未知视频画幅(可用:${GHOST_VIDEO_RATIOS.join(' / ')})` };
    }
    if (
      p.resolution !== undefined &&
      !(GHOST_VIDEO_RESOLUTIONS as readonly unknown[]).includes(p.resolution)
    ) {
      return { ok: false, message: `未知分辨率(可用:${GHOST_VIDEO_RESOLUTIONS.join(' / ')})` };
    }
    if (p.duration !== undefined && !isPositiveIntWithin(p.duration, GHOST_VIDEO_MAX_DURATION_SECONDS)) {
      return { ok: false, message: `duration 不合法(1–${GHOST_VIDEO_MAX_DURATION_SECONDS} 的整数秒)` };
    }
    if (p.fps !== undefined && !isPositiveIntWithin(p.fps, GHOST_VIDEO_MAX_FPS)) {
      return { ok: false, message: `fps 不合法(1–${GHOST_VIDEO_MAX_FPS} 的整数)` };
    }
    const videoParams: CindyVideoParams = {
      ...(p.ratio !== undefined ? { ratio: p.ratio as GhostVideoRatio } : {}),
      ...(p.resolution !== undefined ? { resolution: p.resolution as GhostVideoResolution } : {}),
      ...(p.duration !== undefined ? { duration: p.duration as number } : {}),
      ...(p.fps !== undefined ? { fps: p.fps as number } : {}),
    };

    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (!ghost.manifest.slots?.includes('cindy')) {
      return { ok: false, message: '本意识未声明 cindy 卡槽,无权请 Cindy 代办' };
    }
    // 能力粒度资格审:详单里没申请的动作点不了(缺详单 = 零能力,提示作者补声明)。
    const declaredActions: readonly string[] = ghost.manifest.cindy?.[info.category] ?? [];
    if (!declaredActions.includes(info.action)) {
      return {
        ok: false,
        message: `本意识未声明${CATEGORY_LABEL[info.category]}「${info.verb}」能力(身份卡 cindy.${info.category} 缺 "${info.action}"),请意识作者更新声明`,
      };
    }

    // 选型优先级(低 → 高逐层覆盖):出厂默认 → 档位(意识意图,主机翻译)
    // → 意识专属覆盖(用户在详情页钉的)→ 调用显式点名(用户当场说的)。
    // 意识报了白名单外的名字 = 拒,不静默降级。配置按类目取(图像/视频
    // 各一份白名单与默认,同来自 providers.json 目录)。
    const cfg = info.category === 'image' ? this.deps.getImageConfig() : this.deps.getVideoConfig();
    // 目录没给该类目任何模型 = 能力暂不可用:早拒并说清原因,不落回任何写死型号
    // (说明见 cindyMediaCatalog.ts;详情页对应的那几行同时显示为灰字不可选)。
    if (cfg.models.length === 0 || cfg.defaults === null) {
      const category = CATEGORY_LABEL[info.category];
      return {
        ok: false,
        message:
          `主机当前没有可用的${category}模型(模型目录暂时取不到,不是本插件缺${category}能力)。` +
          '这是主机侧临时状态,不要频繁重试;请如实告知用户,可稍后再试或重启应用重新加载模型目录。',
      };
    }
    const defaults = cfg.defaults;
    const whitelist = new Set(cfg.models.map((m) => m.id));
    let model = defaults.standard;
    if (p.tier !== undefined) {
      if (typeof p.tier !== 'string' || !(GHOST_MODEL_TIERS as readonly string[]).includes(p.tier)) {
        return { ok: false, message: `未知档位(可用:${GHOST_MODEL_TIERS.join(' / ')})` };
      }
      model = defaults[p.tier as GhostModelTier];
    }
    const capability = `${info.category}.${info.action}`;
    const override = this.deps.getOverride(ghostId, capability);
    if (override !== null) {
      if (whitelist.has(override)) {
        model = override;
      } else {
        // 钉的型号已随白名单演进下架:落回上面的档位/默认,不让老配置卡死能力。
        this.deps.log?.warn('ghost cindy override no longer whitelisted, ignored', { ghostId, override });
      }
    }
    if (p.model !== undefined) {
      if (typeof p.model !== 'string' || !whitelist.has(p.model)) {
        // 拒绝话术带上当前可用清单:插件侧不再维护模型枚举(白名单单源执法,
        // 2026-07),AI 点名失败时靠这份清单自愈,不用猜主机认哪些 id。
        return {
          ok: false,
          message: `不支持的模型(不在主机白名单内)。当前可用:${cfg.models.map((m) => m.id).join(' / ')}`,
        };
      }
      model = p.model;
    }

    // 画面参数按**解析出的型号**二次校验:协议层值域是所有 provider 的
    // 交集,单个型号支持的时长/帧率差异很大(seedance 4/6/8/10 秒,
    // happyhorse 只有 5 秒)。不支持即明拒并列出该型号的可用值,不做最近似
    // 降级——静默改成别的档位会让意识以为自己的参数生效了。
    if (info.category === 'video' && presentVideoKeys.length > 0) {
      const caps = this.deps.videoCapabilities?.(model) ?? null;
      if (caps) {
        const unsupported = describeUnsupportedVideoParams(videoParams, caps);
        if (unsupported) {
          const label = cfg.models.find((m) => m.id === model)?.label ?? model;
          return { ok: false, message: `模型「${label}」不支持${unsupported}` };
        }
      }
    }

    // 吃源图的代办(改图/图生视频):指纹形状先粗筛(不占在途名额),
    // 归属查账在下面占名额后做。
    let hashes: string[] = [];
    if (info.usesSources) {
      if (!Array.isArray(p.hashes) || p.hashes.length === 0) {
        return { ok: false, message: `${info.verb}需要至少 1 张源图指纹(hashes)` };
      }
      if (p.hashes.length > info.maxSources) {
        return { ok: false, message: `源图过多(上限 ${info.maxSources} 张)` };
      }
      for (const h of p.hashes) {
        if (typeof h !== 'string' || !HASH_RE.test(h)) {
          return { ok: false, message: '源图指纹格式不合法' };
        }
      }
      hashes = p.hashes as string[];
    }

    // 在途并发闸:默认不限;用户给该意识配了上限才拦(计数始终在记,
    // 配置热更后立即按新上限判)。
    const inflight = this.inflight.get(ghostId) ?? 0;
    const inflightLimit = this.deps.getInflightLimit?.(ghostId) ?? null;
    if (inflightLimit !== null && inflight >= inflightLimit) {
      return { ok: false, message: `同时进行的代办已达上限(${inflightLimit} 单),请稍后再试` };
    }

    this.inflight.set(ghostId, inflight + 1);
    // 异步受理成功后名额转交后台任务,由它的收尾释放;其余路径 finally 释放。
    let backgrounded = false;
    try {
      // 日志口径:发生的事件是"一单 cindy 代办"(kind = 代办类型),槽只是
      // 资格概念不进文案;归因三件套 ghostId / kind / callId 三处日志一致。
      this.deps.log?.info(`ghost cindy-request ${kind} start`, {
        ghostId,
        model,
        callId,
        ...(p.mode === 'submit' ? { mode: 'submit' } : {}),
      });

      // 吃源图的代办:逐张查账验归属——任何一张不是它名下的,整单拒
      // (统一话术不泄露细节)。异步模式也在受理期同步校验,拒绝立即可见。
      const imagePaths: string[] = [];
      for (const hash of hashes) {
        const abs = await this.deps.resolveOwnedMedia(ghostId, hash);
        if (!abs) {
          return { ok: false, message: '源图不在本意识名下(仅能改自己生成或画廊里的媒体)' };
        }
        imagePaths.push(abs);
      }

      // 单次生成 → 落库 → 组装取件字段(同步返回与异步后台共用一条链;
      // 抛错由各自调用方折叠成结构化失败)。
      const runExec = async (): Promise<{
        url: string;
        hash: string;
        ext: string;
        model: string;
        modelLabel: string;
        width?: number;
        height?: number;
        videoParams?: GhostVideoResultParams;
      }> => {
        // 可选参数一律条件展开:不传时载荷里连键都没有,与老协议逐字节同形
        // (videoParams 本身就是按此规则组装的,直接摊开即可)。
        let generated: { buffer: Uint8Array; mimeType: string; videoParams?: GhostVideoResultParams };
        if (kind === 'edit_image') {
          generated = await this.deps.editImage({
            prompt,
            model,
            imagePaths,
            ...(aspectRatio !== undefined ? { aspectRatio } : {}),
          });
        } else if (kind === 'gen_image') {
          generated = await this.deps.generateImage({
            prompt,
            model,
            ...(aspectRatio !== undefined ? { aspectRatio } : {}),
          });
        } else if (kind === 'edit_video') {
          generated = await this.deps.editVideo({ prompt, model, imagePaths, ...videoParams });
        } else {
          generated = await this.deps.generateVideo({ prompt, model, ...videoParams });
        }

        const saved = await this.deps.saveGhostMedia({
          ghostId,
          buffer: generated.buffer,
          mimeType: generated.mimeType,
          label: prompt.slice(0, 200),
          // 模型代办产物记账(ghostMediaLedger),随 ghost_call 收口带回;
          // 未署名('unattributed')不记,与 networkSlot 同契约防并发串账
          ...(callId !== 'unattributed' ? { callId } : {}),
        });
        this.deps.log?.info(`ghost cindy-request ${kind} done`, {
          ghostId,
          model,
          callId,
          hash: saved.hash,
          bytes: generated.buffer.byteLength,
        });
        // 实际选型随结果回传(主机权威信息):意识交卷 note、会话里的 AI 与
        // 用户由此看得见"这单是谁画的"。
        const modelLabel = cfg.models.find((m) => m.id === model)?.label ?? model;
        // 图片代办附带像素宽高(字节头解析,best-effort):意识供聊天卡片时
        // 据此精确声明卡高,首帧零跳动;解析不出就缺省,意识回退估计值。
        const dims =
          kind === 'gen_image' || kind === 'edit_image' ? probeImageSize(generated.buffer) : null;
        return {
          url: saved.url,
          hash: saved.hash,
          ext: saved.ext,
          model,
          modelLabel,
          ...(dims ?? {}),
          // 画面参数回执(视频代办;注入实现没给就缺省):意识据此确认
          // 自己传的参数是否被兑现——老宿主静默忽略新参数,有回执才分得清。
          ...(generated.videoParams !== undefined ? { videoParams: generated.videoParams } : {}),
        };
      };

      const expectedSeconds =
        info.category === 'video'
          ? (this.deps.videoExpectedSeconds?.(model) ?? DEFAULT_VIDEO_EXPECTED_SECONDS)
          : null;

      if (p.mode === 'submit') {
        // 异步受理。内置在途闸(用户 inflightLimit 之上的缺省闸):同步代办
        // 天然被管子超时限流,异步提交是瞬时的,不设闸就能批量刷付费通道。
        const runningJobs = [...this.jobs.values()].filter(
          (j) => j.ghostId === ghostId && j.status === 'running',
        ).length;
        if (runningJobs >= GHOST_CINDY_MAX_ASYNC_JOBS) {
          return {
            ok: false,
            message: `后台任务已达上限(${GHOST_CINDY_MAX_ASYNC_JOBS} 单):先用 query_job 取回已完成的,或等在途任务结束`,
          };
        }
        this.evictSettledJobs(ghostId);
        const jobId = randomUUID();
        const job: CindyAsyncJob = { ghostId, verb: info.verb, startedAt: Date.now(), status: 'running' };
        this.jobs.set(jobId, job);
        backgrounded = true;
        void runExec()
          .then((result) => {
            job.status = 'done';
            job.result = {
              url: result.url,
              hash: result.hash,
              ext: result.ext,
              model: result.model,
              modelLabel: result.modelLabel,
              ...(result.videoParams !== undefined ? { videoParams: result.videoParams } : {}),
            };
            job.doneAt = Date.now();
          })
          .catch((err: unknown) => {
            job.status = 'failed';
            job.error = err instanceof Error ? err.message : String(err);
            job.doneAt = Date.now();
            this.deps.log?.warn(`ghost cindy-request ${kind} job failed`, {
              ghostId,
              callId,
              jobId,
              error: job.error,
            });
          })
          .finally(() => this.releaseInflight(ghostId));
        return { ok: true, jobId, status: 'running', ...(expectedSeconds !== null ? { expectedSeconds } : {}) };
      }

      // 同步等待:署名单在途期间替管子那头的 tool-call 续命(hold 预算 =
      // 这单自己的轮询上限 expected×3,与 video/run.ts 的总超时同口径;
      // 图片秒级完成,330s 基础窗口足够,不 hold)。
      const holdBudgetMs = expectedSeconds !== null ? expectedSeconds * 3 * 1000 : 0;
      const shouldHold = holdBudgetMs > 0 && callId !== 'unattributed';
      if (shouldHold) this.deps.holdPipeCall?.(ghostId, callId, holdBudgetMs);
      try {
        return { ok: true, ...(await runExec()) };
      } finally {
        if (shouldHold) this.deps.releasePipeCall?.(ghostId, callId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn(`ghost cindy-request ${kind} failed`, { ghostId, callId, error: message });
      return { ok: false, message: `${info.verb}失败:${message}` };
    } finally {
      if (!backgrounded) this.releaseInflight(ghostId);
    }
  }

  private releaseInflight(ghostId: string): void {
    const left = (this.inflight.get(ghostId) ?? 1) - 1;
    if (left <= 0) this.inflight.delete(ghostId);
    else this.inflight.set(ghostId, left);
  }

  /** 惰性清理:完成(done/failed)超过 TTL 的任务记录出表(running 永不清)。 */
  private sweepJobs(): void {
    if (this.jobs.size === 0) return;
    const now = Date.now();
    for (const [jobId, job] of [...this.jobs]) {
      if (job.status !== 'running' && now - (job.doneAt ?? 0) > GHOST_CINDY_JOB_TTL_MS) {
        this.jobs.delete(jobId);
      }
    }
  }

  /**
   * 新 job 入表前按意识淘汰最旧的完成记录,保住每意识条数上限。
   * 在途 running(含本单即将占用的名额)都会落成完成记录,一并计入预留,
   * 上限在任何并发时序下都不被突破。
   */
  private evictSettledJobs(ghostId: string): void {
    const entries = [...this.jobs.entries()].filter(([, j]) => j.ghostId === ghostId);
    const running = entries.filter(([, j]) => j.status === 'running').length;
    const settled = entries
      .filter(([, j]) => j.status !== 'running')
      .sort((a, b) => (a[1].doneAt ?? 0) - (b[1].doneAt ?? 0));
    const excess = settled.length - (MAX_SETTLED_JOBS_PER_GHOST - running - 1);
    for (let i = 0; i < excess; i++) {
      this.jobs.delete(settled[i][0]);
    }
  }

  /**
   * 媒体类代办(deposit/release)的共用资格审:卡槽 + 详单动作粒度,话术与
   * 模型类代办同款。通过返回 null。deposit 与 release 共用同一能力键——
   * 「能存」必然「能撤回自己存的」,撤回不构成额外信任面。
   */
  private gateMediaCapability(ghostId: string): GhostPipeModelResult | null {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (!ghost.manifest.slots?.includes('cindy')) {
      return { ok: false, message: '本意识未声明 cindy 卡槽,无权请 Cindy 代办' };
    }
    const declared: readonly string[] = ghost.manifest.cindy?.media ?? [];
    if (!declared.includes('deposit')) {
      return {
        ok: false,
        message:
          '本意识未声明媒体「寄存」能力(身份卡 cindy.media 缺 "deposit"),请意识作者更新声明',
      };
    }
    return null;
  }

  /**
   * 寄存频控令牌桶:取一枚令牌,取不到返回 false。
   * 桶满时把结算时刻推到当下(不积累无限额度);未满时只推进已兑现的整数
   * 份额,余数留给下一次(避免高频调用把不足一份的等待时间反复清零)。
   */
  private takeDepositToken(ghostId: string): boolean {
    const now = Date.now();
    const bucket = this.depositBuckets.get(ghostId);
    if (!bucket) {
      this.depositBuckets.set(ghostId, { tokens: GHOST_CINDY_DEPOSIT_BURST - 1, at: now });
      return true;
    }
    const refilled = Math.floor((now - bucket.at) / GHOST_CINDY_DEPOSIT_REFILL_MS);
    if (refilled > 0) {
      const next = bucket.tokens + refilled;
      if (next >= GHOST_CINDY_DEPOSIT_BURST) {
        bucket.tokens = GHOST_CINDY_DEPOSIT_BURST;
        bucket.at = now;
      } else {
        bucket.tokens = next;
        bucket.at += refilled * GHOST_CINDY_DEPOSIT_REFILL_MS;
      }
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * deposit_media:意识手里已有的媒体字节 → 总仓,换回指纹(#784)。
   *
   * 守门顺序即成本递增顺序,任何一道不过都不做下一道:
   *   资格审 → 能力接线 → 载荷形状 → 字符数早拒 → base64 字符集 → 解码
   *   → 解码后字节上限 → 魔数验型 → 频控令牌 → 账本配额 → 落仓记账。
   *
   * 三条刻意的"不":不信自报 mime(魔数说了算)、不进 ghost_call 产物账
   * (用户自己的输入图不该被当产物推去 IM)、不进画廊(参考图不是作品)。
   */
  private async handleDepositMedia(
    ghostId: string,
    p: { data?: unknown; label?: unknown; callId?: unknown },
  ): Promise<GhostPipeModelResult> {
    const denied = this.gateMediaCapability(ghostId);
    if (denied) return denied;

    const sniff = this.deps.sniffDepositMime;
    const deposit = this.deps.depositMedia;
    const readUsage = this.deps.depositUsageBytes;
    if (!sniff || !deposit || !readUsage) {
      return { ok: false, message: '主机当前不支持媒体寄存(能力未接线)' };
    }

    if (
      p.label !== undefined &&
      (typeof p.label !== 'string' || p.label.length > MAX_DEPOSIT_LABEL_LEN)
    ) {
      return { ok: false, message: `label 不合法(≤${MAX_DEPOSIT_LABEL_LEN} 字符的字符串,或不传)` };
    }
    if (
      p.callId !== undefined &&
      (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > MAX_CALL_ID_LEN)
    ) {
      return { ok: false, message: 'callId 不合法(1–128 字符的字符串,或不传)' };
    }
    const label = p.label as string | undefined;
    const callId = (p.callId as string | undefined) ?? 'unattributed';

    if (typeof p.data !== 'string' || p.data.length === 0) {
      return { ok: false, message: 'data 必须是媒体字节的 base64 字符串(不含 data: 前缀)' };
    }
    const overLimit = `媒体过大(单次寄存上限 ${GHOST_CINDY_DEPOSIT_MAX_BYTES} 字节)`;
    // 先按字符数拦:不先拦就得为一条恶意超长字符串分配整个解码缓冲。
    if (p.data.length > MAX_DEPOSIT_B64_CHARS) return { ok: false, message: overLimit };
    if (!BASE64_RE.test(p.data)) {
      // Buffer.from 会静默丢弃非法字符,不先校字符集就等于接受任意脏串。
      return { ok: false, message: 'data 不是合法 base64(不要带 data: 前缀)' };
    }
    const buffer = new Uint8Array(Buffer.from(p.data, 'base64'));
    if (buffer.byteLength === 0) return { ok: false, message: 'data 解码后为空' };
    if (buffer.byteLength > GHOST_CINDY_DEPOSIT_MAX_BYTES) return { ok: false, message: overLimit };

    const mimeType = sniff(buffer);
    if (!mimeType) {
      return {
        ok: false,
        message:
          '不是受支持的媒体类型(按字节识别,不看自报类型):只收图片 / 视频 / 音频 / glb,识别不出一律不入媒体库',
      };
    }

    if (!this.takeDepositToken(ghostId)) {
      return {
        ok: false,
        message:
          `寄存过于频繁(允许 ${GHOST_CINDY_DEPOSIT_BURST} 张突发,之后约每 ` +
          `${Math.round(GHOST_CINDY_DEPOSIT_REFILL_MS / 1000)} 秒 1 张),请稍后重试`,
      };
    }

    // 配额:保守预判(已用 + 本次最坏情况)。内容去重命中时本次其实不占额,
    // 但入库前算不出是否命中——因此临界处可能误拒一次"其实免费"的重复寄存,
    // 代价是配额永远是硬上限、绝不超发。释放口是 release_media。
    let used: number;
    try {
      used = await readUsage(ghostId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn('ghost cindy-request deposit_media quota read failed', {
        ghostId,
        callId,
        error: message,
      });
      return { ok: false, message: `寄存失败:配额查询出错(${message})` };
    }
    if (used + buffer.byteLength > GHOST_CINDY_DEPOSIT_QUOTA_BYTES) {
      return {
        ok: false,
        message:
          `寄存配额已满(本插件上限 ${GHOST_CINDY_DEPOSIT_QUOTA_BYTES} 字节,已用 ${used})。` +
          '请对不再需要的寄存物调用 release_media 释放后重试,并如实告知用户。',
      };
    }

    let saved: { url: string; hash: string; ext: string; bytes: number; deduplicated: boolean };
    try {
      saved = await deposit({ ghostId, buffer, mimeType, ...(label ? { label } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn('ghost cindy-request deposit_media failed', {
        ghostId,
        callId,
        error: message,
      });
      return { ok: false, message: `寄存失败:${message}` };
    }

    // 落仓后重读一次真实占用:deduplicated 只说明"字节此前已在总仓",不代表
    // 本意识此前已有这条寄存引用(可能是别的意识存过),不能据它推算。
    let usedAfter = used + saved.bytes;
    try {
      usedAfter = await readUsage(ghostId);
    } catch {
      // 回读失败不影响本次成功;返回的是估算值,仅供作者提示用户。
    }
    this.deps.log?.info('ghost cindy-request deposit_media done', {
      ghostId,
      callId,
      hash: saved.hash,
      mime: mimeType,
      bytes: saved.bytes,
      ...(saved.deduplicated ? { deduplicated: true } : {}),
    });
    return {
      ok: true,
      url: saved.url,
      hash: saved.hash,
      ext: saved.ext,
      bytes: saved.bytes,
      deduplicated: saved.deduplicated,
      quotaUsedBytes: usedAfter,
      quotaLimitBytes: GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
    };
  }

  /**
   * release_media:撤回本意识对某指纹的寄存引用(配额释放口)。
   * 归属天然收敛——账本删除条件写死 refKind='ghost-deposit' + refId=本意识,
   * 别人的引用、画廊、聊天消息引用都碰不到,字节交回收器按引用归零处理。
   * 幂等:本就没有这条引用时回 released:false,不报错。
   */
  private async handleReleaseMedia(
    ghostId: string,
    p: { hash?: unknown },
  ): Promise<GhostPipeModelResult> {
    const denied = this.gateMediaCapability(ghostId);
    if (denied) return denied;

    const release = this.deps.releaseDeposit;
    const readUsage = this.deps.depositUsageBytes;
    if (!release || !readUsage) {
      return { ok: false, message: '主机当前不支持媒体寄存(能力未接线)' };
    }
    if (typeof p.hash !== 'string' || !HASH_RE.test(p.hash)) {
      return { ok: false, message: '指纹格式不合法' };
    }
    try {
      const released = await release({ ghostId, hash: p.hash });
      const usedAfter = await readUsage(ghostId);
      if (released) {
        this.deps.log?.info('ghost cindy-request release_media done', { ghostId, hash: p.hash });
      }
      return {
        ok: true,
        released,
        quotaUsedBytes: usedAfter,
        quotaLimitBytes: GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.warn('ghost cindy-request release_media failed', {
        ghostId,
        hash: p.hash,
        error: message,
      });
      return { ok: false, message: `撤回寄存失败:${message}` };
    }
  }

  /**
   * query_job:取异步任务状态/结果。归属统一话术——查无此单与不是它的单
   * 同一句,不泄露他人任务存在性;完成结果可反复查(TTL 内幂等)。
   */
  private handleQueryJob(ghostId: string, p: { jobId?: unknown }): GhostPipeModelResult {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (!ghost.manifest.slots?.includes('cindy')) {
      return { ok: false, message: '本意识未声明 cindy 卡槽,无权请 Cindy 代办' };
    }
    if (typeof p.jobId !== 'string' || p.jobId.length === 0 || p.jobId.length > MAX_JOB_ID_LEN) {
      return { ok: false, message: 'jobId 不合法(mode:submit 受理时返回的任务号)' };
    }
    const job = this.jobs.get(p.jobId);
    if (!job || job.ghostId !== ghostId) {
      return { ok: false, message: '查无此任务(可能已过期清理或应用重启丢失;请重新提交)' };
    }
    if (job.status === 'running') {
      return {
        ok: true,
        jobId: p.jobId,
        status: 'running',
        elapsedSeconds: Math.round((Date.now() - job.startedAt) / 1000),
      };
    }
    if (job.status === 'failed' || !job.result) {
      return { ok: false, message: `${job.verb}失败:${job.error ?? '未知原因'}` };
    }
    return { ok: true, jobId: p.jobId, status: 'done', ...job.result };
  }
}
