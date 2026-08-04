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
  collectHtmlLocalResourceRefs,
  planHtmlResourceFetches,
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
  /** 取一个资源 → `data:` URI(取不到返回空串或抛错,两者都计入 failed)。 */
  fetchOne: (target: HtmlResourceFetchTarget) => Promise<string>,
  options: {
    concurrency?: number;
    isCancelled?: () => boolean;
    /** 整页内联总量预算(data: URI 字符数);缺省 HTML_RESOURCE_TOTAL_MAX_CHARS。 */
    totalBudgetChars?: number;
  } = {},
): Promise<HtmlResourceFetchOutcome> {
  const concurrency = Math.max(1, options.concurrency ?? FETCH_CONCURRENCY);
  const isCancelled = options.isCancelled ?? (() => false);
  const totalBudget = options.totalBudgetChars ?? HTML_RESOURCE_TOTAL_MAX_CHARS;
  const urlByAbsPath = new Map<string, string>();
  let failed = 0;
  let overBudget = 0;
  let usedChars = 0;
  let cursor = 0;
  // 一旦有资源装不进剩余预算,就视为预算耗尽、后续一律不再取件。
  //
  // **不能只比 `usedChars >= totalBudget`**:资源大小要取回来才知道,而被拒的那个不计入
  // usedChars —— 于是 usedChars 可能永远到不了预算线,早退分支从不触发,剩下的资源仍会
  // 被逐个下载完(网络与临时文件全白花),正是这条 review 要防的 DoS。
  // 代价是偏保守:大资源用尽预算后,后面本可塞进去的小资源也不再取。预览场景下可预测、
  // 有界比多塞一两个资源重要。
  let budgetExhausted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled()) return;
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      const target = targets[index];
      if (budgetExhausted) {
        overBudget += 1;
        continue;
      }
      try {
        const dataUri = await fetchOne(target);
        if (!dataUri) {
          failed += 1;
          continue;
        }
        // 取回来才知道多大;装不进剩余预算就丢掉这一个(保留原引用),不占内存。
        //
        // **按 `长度 × refCount` 计费,不是按长度**(review P1 实捉):取件按路径去重,但
        // applyHtmlResourceUrls 会在**每一处**引用都完整插入这份 data: URI —— 100 个
        // `<img src="a.png">` 指向同一张 2 MiB 图,只计一次时能通过 8 MiB 预算,回填后却
        // 生成约 267 MiB 的 HTML,WebView 序列化时 OOM。预算要覆盖的是**最终回填后的增量**。
        // 计数必须显式兜底成 1:`Math.max(1, undefined)` 是 **NaN**,而
        // `usedChars + NaN > totalBudget` 恒为 false —— 少一个字段就让整条预算判断变成
        // fail-open,所有资源无条件放行(本仓既有用例实捉)。
        const refCount = Number.isFinite(target.refCount) && target.refCount > 0
          ? target.refCount
          : 1;
        const inlinedChars = dataUri.length * refCount;
        if (usedChars + inlinedChars > totalBudget) {
          budgetExhausted = true;
          overBudget += 1;
          continue;
        }
        usedChars += inlinedChars;
        urlByAbsPath.set(target.absPath, dataUri);
      } catch {
        failed += 1;
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
  fetchResourceDataUri: (target: HtmlResourceFetchTarget) => Promise<string>,
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
  }, [fetchResourceDataUri, html, plan, refs]);

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
