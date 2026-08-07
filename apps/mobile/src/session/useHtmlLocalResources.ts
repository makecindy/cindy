/**
 * useHtmlLocalResources —— 渲染本地 HTML 前把它引用的同目录资源取回来。
 *
 * 词法与路径换算在 htmlLocalResources(纯函数、单测覆盖),这里只做编排:
 * 去重 → 限并发取件 → 回填 → 交给 HtmlFileReader 渲染。取件走的是单文件预览
 * 已经在用的那条被控端绝对路径通道(media:fetch),**不新增 device-link channel**;
 * 取回的是 `data:` URI 而非预签名地址(原因见 htmlLocalResources 头注)。
 *
 * 状态语义:
 *  - 文档里没有可改写引用(自包含页面,最常见)→ 零延迟、零请求,直接回原文;
 *  - 有引用 → `loading` 期间上层显示既有的取件占位,取完**一次性**渲染,
 *    不做「先渲染破图再热替换」(那会让 WebView 重载、页面闪一下)。
 *  - 单个资源取件失败不阻塞整页:该处保留原引用(渲染成破图),失败数如实回报。
 */
import { useEffect, useMemo, useState } from 'react';

import {
  applyHtmlResourceUrls,
  bytesForDataUriChars,
  collectHtmlLocalResourceRefs,
  dataUriCharsForBytes,
  planHtmlResourceFetches,
  HTML_RESOURCE_MAX_BYTES,
  HTML_RESOURCE_TOTAL_MAX_CHARS,
  type HtmlResourceFetchTarget,
} from '@/session/htmlLocalResources';

/** 并发上限:每个资源都是一次 device-link invoke + 被控端上传 OSS,不打风暴。 */
const FETCH_CONCURRENCY = 4;

export interface HtmlResourceFetchOutcome {
  urlByAbsPath: Map<string, string>;
  /** 取件失败(抛错或回空地址)的数量;这些位置回填时保留原引用。 */
  failed: number;
  /** 因整页总量预算用尽而未取的数量(与 failed 分开计,提示语不同)。 */
  overBudget: number;
}

/**
 * 限并发批量取件。**抽成纯异步函数是为了可单测** —— 本仓 mobile 没有 hook 测试设施,
 * 而为一个测试给 apps/mobile/package.json 加 devDependency 会动 runtime fingerprint、
 * 触发冷更(docs/dev-rules/mobile-development.md 的冷更边界),代价不成比例。
 *
 * 单个资源失败不抛:整页渲染不因一张图取不到而失败,失败数如实回报给上层提示。
 * `isCancelled` 让调用方在卸载 / 换文档后立刻停止后续取件,不白发请求。
 */
export async function fetchHtmlResourceUrls(
  targets: readonly HtmlResourceFetchTarget[],
  /**
   * 取一个资源 → `data:` URI(取不到返回空串或抛错,两者都计入 failed)。
   *
   * `limits.maxBytes` 是**这一次**取件的字节上限,由剩余预算收窄而来(见下面的预留制),
   * 必须原样交给被控端强制 —— 只在手机侧下载后判断挡不住流量。
   */
  fetchOne: (
    target: HtmlResourceFetchTarget,
    limits: { baseDir: string; maxBytes: number },
  ) => Promise<string>,
  options: {
    concurrency?: number;
    isCancelled?: () => boolean;
    /** 整页内联总量预算(data: URI 字符数);缺省 HTML_RESOURCE_TOTAL_MAX_CHARS。 */
    totalBudgetChars?: number;
    /** 单资源字节上限;缺省 HTML_RESOURCE_MAX_BYTES。 */
    perResourceMaxBytes?: number;
    /** HTML 所在目录绝对路径,原样透给 fetchOne 供被控端做 realpath 包含判定。 */
    baseDirAbsPath?: string;
  } = {},
): Promise<HtmlResourceFetchOutcome> {
  const concurrency = Math.max(1, options.concurrency ?? FETCH_CONCURRENCY);
  const isCancelled = options.isCancelled ?? (() => false);
  const totalBudget = options.totalBudgetChars ?? HTML_RESOURCE_TOTAL_MAX_CHARS;
  const perResourceMaxBytes = options.perResourceMaxBytes ?? HTML_RESOURCE_MAX_BYTES;
  const baseDir = options.baseDirAbsPath ?? '';
  const urlByAbsPath = new Map<string, string>();
  let failed = 0;
  let overBudget = 0;
  let cursor = 0;

  // ── 预算预留制(review P1:并发取件突破总量预算) ─────────────────────────────
  // 旧写法只在**取回之后**结算:并发 4 路时四个接近单资源上限的请求会全部先进入 fetchOne,
  // 手机同时持有约 4 × 2.8 M 字符的字节,整页 8 MiB 预算形同虚设。
  //
  // 现在改成开工前先**预留**:
  //  1. `reservedChars` = 已结算 + 在途预留,恒 ≤ totalBudget;
  //  2. 每次取件按「剩余预算 ÷ refCount」把这一次的字节上限收窄,并把该上限对应的字符数
  //     预留下来 —— 于是**在途**的下载量也被总预算约束,而不是只约束落地量;
  //  3. 取回后按实际长度结算,把没用掉的预留立刻归还给后面的资源。
  // 收窄后的上限交给被控端强制(fetchOne 的 limits.maxBytes),超限文件根本不会产生流量。
  //
  // 预算不足时**不立刻判超预算**:在途预留随时会释放,先等一次结算再判 —— 否则并发满载
  // 那一刻排到的资源会被误判成超预算(功能回退)。只有「没有在途、预算又确实不够」才是
  // 真耗尽,此时沿用既有的保守语义:置 budgetExhausted,后续不再**启动**新的取件。
  let reservedChars = 0;
  /** 真正在 fetchOne 里跑着的数量(等预算的 worker 不算)——用于判断「等下去有没有意义」。 */
  let inFlight = 0;
  let settleGen = 0;
  let waiters: Array<() => void> = [];
  const notifySettled = (): void => {
    settleGen += 1;
    const woken = waiters;
    waiters = [];
    for (const wake of woken) wake();
  };
  /** 自 `gen` 之后已有结算就立即返回,否则挂起等下一次结算(闭掉丢唤醒)。 */
  const waitForSettleSince = (gen: number): Promise<void> =>
    gen !== settleGen ? Promise.resolve() : new Promise<void>((r) => { waiters.push(r); });
  let budgetExhausted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled()) return;
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const target = targets[index];
      // 计数必须显式兜底成 1:`Math.max(1, undefined)` 是 **NaN**,而任何
      // `x > NaN` 恒为 false —— 少一个字段就让整条预算判断变成 fail-open,
      // 所有资源无条件放行(本仓既有用例实捉)。
      //
      // **按 `长度 × refCount` 计费,不是按长度**(review P1 实捉):取件按路径去重,但
      // applyHtmlResourceUrls 会在**每一处**引用都完整插入这份 data: URI —— 100 个
      // `<img src="a.png">` 指向同一张 2 MiB 图,只计一次时能通过 8 MiB 预算,回填后却
      // 生成约 267 MiB 的 HTML,WebView 序列化时 OOM。预算要覆盖的是**最终回填后的增量**。
      const refCount = Number.isFinite(target.refCount) && target.refCount > 0
        ? target.refCount
        : 1;

      let reserveChars = 0;
      let capBytes = 0;
      for (;;) {
        if (isCancelled()) return;
        if (budgetExhausted) break;
        const availableChars = totalBudget - reservedChars;
        capBytes = Math.min(
          perResourceMaxBytes,
          bytesForDataUriChars(Math.floor(availableChars / refCount)),
        );
        if (capBytes > 0) {
          // bytesForDataUriChars 的保守性保证 reserveChars <= availableChars,
          // 即 reservedChars 永不越过 totalBudget。
          reserveChars = dataUriCharsForBytes(capBytes) * refCount;
          reservedChars += reserveChars;
          break;
        }
        const gen = settleGen;
        if (inFlight > 0) {
          await waitForSettleSince(gen);
          continue;
        }
        budgetExhausted = true;
        break;
      }
      if (reserveChars === 0) {
        overBudget += 1;
        continue;
      }

      inFlight += 1;
      try {
        const dataUri = await fetchOne(target, { baseDir, maxBytes: capBytes });
        if (!dataUri) {
          failed += 1;
          continue;
        }
        const inlinedChars = dataUri.length * refCount;
        if (inlinedChars > reserveChars) {
          // 越过预留:老被控端不认 maxBytes、或回包比估算上界还长。语义与旧实现一致 ——
          // 这一个不要(保留原引用),并停掉后续取件。
          budgetExhausted = true;
          overBudget += 1;
          continue;
        }
        urlByAbsPath.set(target.absPath, dataUri);
        // 只归还没用掉的部分:剩下的 inlinedChars 从预留转为已结算占用。
        reservedChars -= reserveChars - inlinedChars;
        reserveChars = 0;
      } catch {
        failed += 1;
      } finally {
        inFlight -= 1;
        // 失败 / 超预留 / 取消:整份预留归还(成功路径已把 reserveChars 归零)。
        if (reserveChars > 0) reservedChars -= reserveChars;
        notifySettled();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );
  return { urlByAbsPath, failed, overBudget };
}

export interface HtmlLocalResourceState {
  /** 回填后的 HTML;取件未完成或无需取件时为原文。 */
  html: string;
  /** 正在取回资源(无可改写引用时恒 false)。 */
  loading: boolean;
  /** 待取资源总数(去重后)。 */
  total: number;
  /** 取件失败数(这些位置保留原引用)。 */
  failed: number;
  /**
   * 因超出**条数上限**(HTML_RESOURCE_LIMIT)而未取的数量。
   *
   * 与 overBudget **分开报**(review P2):两者的用户可见事实不同 —— 这一条意味着
   * 「前 32 项已取回」,而总量预算用尽可能在第 3 项就停了。合并成一个数字会让提示语
   * 在后一种情况下谎报「已取回前 32 项」。
   */
  overLimit: number;
  /** 因**整页总量预算**用尽而未取的数量(可能远少于条数上限就触发)。 */
  overBudget: number;
}

export function useHtmlLocalResources(
  html: string,
  /** HTML 文件所在目录的被控端绝对路径;空串表示无法定位(退化为不取件)。 */
  baseDirAbsPath: string,
  fetchResourceDataUri: (
    target: HtmlResourceFetchTarget,
    limits: { baseDir: string; maxBytes: number },
  ) => Promise<string>,
): HtmlLocalResourceState {
  const refs = useMemo(
    () => collectHtmlLocalResourceRefs(html, baseDirAbsPath),
    [baseDirAbsPath, html],
  );
  const plan = useMemo(() => planHtmlResourceFetches(refs), [refs]);
  const [outcome, setOutcome] = useState<
    { html: string; failed: number; overBudget: number } | null
  >(null);

  useEffect(() => {
    if (plan.targets.length === 0) {
      setOutcome(null);
      return undefined;
    }
    let cancelled = false;
    // 输入变了先清掉上一份文档的回填结果:绝不让旧 HTML 在新文档上闪一帧
    // (同款迟到回调隐患在本仓 review 里被反复抓过)。
    setOutcome(null);

    void fetchHtmlResourceUrls(plan.targets, fetchResourceDataUri, {
      isCancelled: () => cancelled,
      baseDirAbsPath: baseDirAbsPath,
    }).then(({ urlByAbsPath, failed, overBudget }) => {
      if (cancelled) return;
      setOutcome({
        html: applyHtmlResourceUrls(html, refs, urlByAbsPath),
        failed,
        overBudget,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [baseDirAbsPath, fetchResourceDataUri, html, plan, refs]);

  const needsFetch = plan.targets.length > 0;
  return {
    html: outcome?.html ?? html,
    loading: needsFetch && outcome === null,
    total: plan.targets.length,
    failed: outcome?.failed ?? 0,
    overLimit: plan.skipped,
    overBudget: outcome?.overBudget ?? 0,
  };
}
