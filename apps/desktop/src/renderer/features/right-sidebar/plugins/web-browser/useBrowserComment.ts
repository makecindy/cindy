/**
 * useBrowserComment —— web-browser tab 的「页面评论」状态机(host 侧)。
 *
 * 职责(对齐方案分层:guest 只管选择层与 marker,评论编辑与业务流程全在 host):
 *  - 模式开关:toggle 后向 guest 发 enter-mode / exit-mode(经 `webview.send`,
 *    guest 是 webview-security 强制注入的 browserCommentPreload)。
 *  - 订阅 webview `ipc-message`:element-selected(弹输入气泡;`immediate` 标记
 *    时跳过气泡直接空评论提交)、command-result(关键命令回执)与
 *    mode-exited(guest 内 Esc)。
 *  - 提交流程:prepare-screenshot → main capturePage 拿 PNG 字节 →
 *    cacheImageFromBuffer 进会话图片缓存 → 组 BrowserCommentDraftItem 追加进
 *    ComposerDraft.browserComments(browser-comment-chip:ChatInput 渲染为
 *    「N 条注释」胶囊,发送时才序列化文本块 + 截图并入 filesToSend)。
 *  - Phase 2 多评论:提交成功后**不退出模式**,发 commit-pending 让 pending
 *    marker 转常驻、编号推进,可连续标注;提交点之前失败则保留气泡供重试。
 *  - 导航 / 页面刷新时 guest 上下文销毁,host 侧同步退出评论模式。
 *
 * 状态机:off → starting(等待 guest 确认)→ selecting(点选中)→ pending(气泡打开)→
 *          submitting(截图 + 入草稿)→ selecting(连续标注)。
 *          pending → cancelling(等待 guest 撤销)→ selecting。
 *          若 enter 时页面已有文本选区:starting 暂存选择,ACK 后直接进 pending。
 *          immediate 路径:selecting → submitting → selecting(不经 pending)。
 *          任何态可被 exit 打断回 off。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebviewTag } from 'electron';

import type { BrowserCommentDraftItem } from '@/lib/browserComments';
import { appendBrowserCommentToDraft, getDraft } from '@/lib/composerDraftStore';
import type { AttachedFile } from '@/lib/fileTypes';
import { toast } from '@/lib/toast';

import {
  BROWSER_COMMENT_CANCEL_PENDING_CHANNEL,
  BROWSER_COMMENT_COMMAND_RESULT_CHANNEL,
  BROWSER_COMMENT_COMMIT_PENDING_CHANNEL,
  BROWSER_COMMENT_DESIGN_PREVIEW_CHANNEL,
  BROWSER_COMMENT_DESIGN_RESET_CHANNEL,
  BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
  BROWSER_COMMENT_ENTER_MODE_CHANNEL,
  BROWSER_COMMENT_EXIT_MODE_CHANNEL,
  BROWSER_COMMENT_MODE_EXITED_CHANNEL,
  BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL,
  type BrowserCommentCommandChannel,
  type BrowserCommentCommandEnvelope,
  type BrowserCommentCommandResult,
  type BrowserCommentDesignPreviewPayload,
  type BrowserCommentStyleChange,
  type BrowserCommentTargetInfo,
} from '../../../../../shared/browserComment';
import { composerDraftKeyForRightSidebarSession } from '@/features/cc-agent/newMakerDraftRightSidebar';
import {
  createEmptyBrowserCommentEditorDraft,
  hasBrowserCommentDesignDraft,
  hasBrowserCommentEditorDraft,
  type BrowserCommentEditorDraft,
} from './browserCommentEditorDraft';

/** 关键 guest 命令的完成回执等待上限；超时保持用户输入并允许重试。 */
const COMMAND_TIMEOUT_MS = 2_000;

/**
 * 下一个 marker 编号 = 草稿里已有 marker 编号的最大值 + 1。
 * 不能用 `browserComments.length + 1`:用户删掉某条 chip 后,数组长度会与最大
 * 编号脱节(如删了 ②,剩 ①③ 时 length=2 → 会复用 ③),导致重复的 marker 与
 * `## Comment N` 块。取 max 保证编号单调、永不重号。
 */
function computeNextMarkerNumber(items: readonly { markerNumber: number }[] | undefined): number {
  if (!items || items.length === 0) return 1;
  return items.reduce((max, item) => Math.max(max, item.markerNumber), 0) + 1;
}

/**
 * Electron 当前类型把 WebviewTag.send 标成 Promise<void>，但不同 Electron
 * 版本 / 测试替身可能仍返回 void。状态机只能观察真实 thenable 的异步失败，
 * 不能因对 undefined 调用 .catch 而把已经投递的命令误判成发送失败。
 */
function observeSendRejection(result: unknown, onRejected: (reason: unknown) => void): void {
  if (
    result === null ||
    (typeof result !== 'object' && typeof result !== 'function') ||
    typeof (result as PromiseLike<unknown>).then !== 'function'
  ) {
    return;
  }
  void Promise.resolve(result).catch(onRejected);
}

export type BrowserCommentMode =
  'off' | 'starting' | 'selecting' | 'pending' | 'cancelling' | 'submitting';

interface PendingBrowserCommentCommand {
  webview: WebviewTag;
  command: BrowserCommentCommandChannel;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (reason: Error) => void;
}

interface BufferedStartupSelection {
  webview: WebviewTag;
  epoch: number;
  target: BrowserCommentTargetInfo;
}

export interface UseBrowserCommentResult {
  /** 当前状态;BrowserChrome 按钮 active 态 = mode !== 'off'。 */
  mode: BrowserCommentMode;
  /** 已点选的目标信息(pending / submitting 态非空),气泡定位与提交都用它。 */
  pendingTarget: BrowserCommentTargetInfo | null;
  /** Host 侧未提交编辑草稿；WebView 自动换代时保留，显式取消 / 成功后清空。 */
  editorDraft: BrowserCommentEditorDraft;
  updateEditorDraft: (draft: BrowserCommentEditorDraft) => void;
  /** 工具栏按钮:off → 进入点选;其它态 → 整体退出。 */
  toggle: () => void;
  /** 气泡取消:回到点选态(marker 清除、样式预览还原,评论模式保持)。 */
  cancelPending: () => void;
  /** 气泡提交:走截图 + 入草稿流程。styleChanges 为样式编辑器的改动(可空)。 */
  submit: (commentText: string, styleChanges?: BrowserCommentStyleChange[]) => void;
  /** 样式编辑器实时预览:全量当前编辑状态透传给 guest 应用到 pending 元素。 */
  previewDesign: (payload: BrowserCommentDesignPreviewPayload) => void;
  /** 样式编辑器「重置」:guest 还原 pending 元素上的全部预览。 */
  resetDesign: () => void;
}

export function useBrowserComment(
  tabId: string,
  sessionId: string | undefined,
  /** useBrowserWebview 暴露的当前 WebView 代际句柄。 */
  webview: WebviewTag | null,
  /** 提交时刻的页面 URL 取值器(immediate 路径由 hook 自己触发提交,拿不到
   *  调用方参数,统一走 getter;需引用稳定或由调用方 useCallback 包裹)。 */
  getPageUrl: () => string,
): UseBrowserCommentResult {
  const { t } = useTranslation();
  // 草稿写入目标键:项目草稿页的 RSB bucket 是合成 sessionId,可见 composer
  // 实际用 NEW_MAKER_DRAFT_KEY 存草稿 —— 评论(含截图缓存目录)必须落到
  // composer 真正读取的键上,否则 toast 成功但胶囊永远不出现(Codex review P2)。
  const composerDraftKey =
    sessionId === undefined ? undefined : composerDraftKeyForRightSidebarSession(sessionId);
  const [mode, setMode] = useState<BrowserCommentMode>('off');
  const [pendingTarget, setPendingTarget] = useState<BrowserCommentTargetInfo | null>(null);
  const [editorDraft, setEditorDraft] = useState(createEmptyBrowserCommentEditorDraft);
  const editorDraftRef = useRef(editorDraft);
  editorDraftRef.current = editorDraft;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const pendingTargetRef = useRef(pendingTarget);
  pendingTargetRef.current = pendingTarget;
  const tRef = useRef(t);
  tRef.current = t;
  const getPageUrlRef = useRef(getPageUrl);
  getPageUrlRef.current = getPageUrl;
  const webviewRef = useRef<WebviewTag | null>(webview);
  const requestSequenceRef = useRef(0);
  const pendingCommandsRef = useRef(new Map<string, PendingBrowserCommentCommand>());
  /**
   * Guest 在 enter-mode 内会同步识别页面已有文本选区，而统一 command ACK
   * 要等 handler 返回后才发送。starting 期间收到的 selection 先按 WebView
   * 代际与提交纪元暂存，ACK 后再原子地推进到 pending / submitting，避免
   * guest 已被 blocker 锁成 pending、host 却把事件丢掉。
   */
  const bufferedStartupSelectionRef = useRef<BufferedStartupSelection | null>(null);
  /**
   * 提交纪元:每次退出模式 / 导航 / guest 内 Esc 都自增,使正在挂起的异步提交
   * (prepare → capture → cache)在恢复后察觉自己已被作废并静默中止,避免把一个
   * 已取消 / 已失效的选择追加进草稿(或把已退出的模式又拨回 selecting)。
   */
  const submitEpochRef = useRef(0);
  /**
   * appendBrowserCommentToDraft 是用户数据的提交点。其后的 guest ACK 只负责
   * 收尾 overlay；若此时 WebView 导航 / 崩溃 / 换代，仍必须按成功上报，不能
   * 用 lifecycle failure 诱导用户重试并重复写入同一条评论。
   */
  const committedSubmissionEpochRef = useRef<number | null>(null);
  const clearEditorDraft = useCallback(() => {
    setEditorDraft(createEmptyBrowserCommentEditorDraft());
  }, []);
  const updateEditorDraft = useCallback((draft: BrowserCommentEditorDraft) => {
    setEditorDraft(draft);
  }, []);

  const rejectCommandsForWebview = useCallback((target: WebviewTag) => {
    for (const [requestId, pending] of pendingCommandsRef.current) {
      if (pending.webview !== target) continue;
      clearTimeout(pending.timer);
      pendingCommandsRef.current.delete(requestId);
      pending.reject(new Error('browser comment WebView changed'));
    }
  }, []);

  const settleCommittedSubmission = useCallback(
    (epoch: number, nextMode: Extract<BrowserCommentMode, 'off' | 'selecting'>): boolean => {
      if (committedSubmissionEpochRef.current !== epoch) return false;
      committedSubmissionEpochRef.current = null;
      setPendingTarget(null);
      clearEditorDraft();
      setMode(nextMode);
      toast.success(tRef.current('rightSidebar.browser.commentAdded'));
      return true;
    },
    [clearEditorDraft],
  );

  /**
   * 向当前 WebView 发送一条必须确认完成的命令。requestId resolver 与具体
   * WebView 对象绑定，旧代际回执不可能推进新代际的状态机。
   */
  const sendCommand = useCallback(
    <T>(command: BrowserCommentCommandChannel, payload?: T): Promise<void> => {
      const target = webviewRef.current;
      if (!target) return Promise.reject(new Error('browser comment WebView unavailable'));
      const requestId = `${tabId}:${++requestSequenceRef.current}`;
      const envelope: BrowserCommentCommandEnvelope<T> = { requestId, payload };

      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = pendingCommandsRef.current.get(requestId);
          if (!pending) return;
          pendingCommandsRef.current.delete(requestId);
          reject(new Error(`browser comment command timed out: ${command}`));
        }, COMMAND_TIMEOUT_MS);
        pendingCommandsRef.current.set(requestId, {
          webview: target,
          command,
          timer,
          resolve,
          reject,
        });

        const rejectDelivery = (reason: unknown) => {
          const pending = pendingCommandsRef.current.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          pendingCommandsRef.current.delete(requestId);
          reject(reason instanceof Error ? reason : new Error('browser comment send failed'));
        };

        try {
          observeSendRejection(target.send(command, envelope), rejectDelivery);
        } catch (reason) {
          rejectDelivery(reason);
        }
      });
    },
    [tabId],
  );

  /** 无需等待状态推进的通知；仍使用信封，guest 可统一执行同一套命令 handler。 */
  const sendBestEffortCommand = useCallback(
    <T>(command: BrowserCommentCommandChannel, payload?: T) => {
      const target = webviewRef.current;
      if (!target) return;
      const envelope: BrowserCommentCommandEnvelope<T> = {
        requestId: `${tabId}:${++requestSequenceRef.current}`,
        payload,
      };
      try {
        observeSendRejection(target.send(command, envelope), () => undefined);
      } catch {
        // WebView 正在 detach / destroy；host 仍可安全完成本地退出。
      }
    },
    [tabId],
  );

  const sendNotification = useCallback((channel: string, payload?: unknown) => {
    const target = webviewRef.current;
    if (!target) return;
    try {
      observeSendRejection(target.send(channel, payload), () => undefined);
    } catch {
      // 实时预览是非关键通知；关键状态转换全部走 sendCommand。
    }
  }, []);

  /**
   * 统一退出 Guest 评论状态。用户主动关闭 / 取消时 discardEditorDraft=true；
   * WebView 导航、enter 失败等非用户故障只拆 overlay、保留可恢复的 Host 草稿。
   */
  const leaveMode = useCallback(
    (discardEditorDraft: boolean) => {
      const committedEpoch = committedSubmissionEpochRef.current;
      submitEpochRef.current += 1; // 作废任何挂起中的提交
      bufferedStartupSelectionRef.current = null;
      if (discardEditorDraft) clearEditorDraft();
      sendBestEffortCommand(BROWSER_COMMENT_EXIT_MODE_CHANNEL);
      if (committedEpoch !== null && settleCommittedSubmission(committedEpoch, 'off')) return;
      setMode('off');
      setPendingTarget(null);
    },
    [clearEditorDraft, sendBestEffortCommand, settleCommittedSubmission],
  );
  const exitMode = useCallback(() => {
    leaveMode(true);
  }, [leaveMode]);
  const abortModePreservingDraft = useCallback(() => {
    leaveMode(false);
  }, [leaveMode]);
  const exitModeRef = useRef(exitMode);
  exitModeRef.current = exitMode;
  const abortModePreservingDraftRef = useRef(abortModePreservingDraft);
  abortModePreservingDraftRef.current = abortModePreservingDraft;

  /**
   * 撤销 Guest 已建立的 pending target。显式取消会丢弃 Host 草稿；自动拒绝
   * 一个无法承载恢复中 design edits 的 target 时只撤 marker，保留草稿继续
   * 点选。两条路径共用 ACK 状态机，避免 Host 提前回 selecting 而 Guest 仍
   * 卡在 pending。
   */
  const cancelGuestPending = useCallback(
    (discardEditorDraft: boolean) => {
      const epoch = submitEpochRef.current;
      setMode('cancelling');
      void sendCommand(BROWSER_COMMENT_CANCEL_PENDING_CHANNEL).then(
        () => {
          if (submitEpochRef.current !== epoch) return;
          setPendingTarget(null);
          if (discardEditorDraft) clearEditorDraft();
          setMode('selecting');
        },
        () => {
          if (submitEpochRef.current !== epoch) return;
          // 无法确认 guest 已撤掉 pending 时整体退出；下次 enter 会先幂等拆旧 overlay。
          if (discardEditorDraft) {
            exitMode();
          } else {
            abortModePreservingDraft();
          }
          toast.error(tRef.current('rightSidebar.browser.commentFailed'));
        },
      );
    },
    [abortModePreservingDraft, clearEditorDraft, exitMode, sendCommand],
  );

  const cancelPending = useCallback(() => {
    if (modeRef.current !== 'pending') return;
    // 立即离开 pending，序列化 cancel 与 submit：ACK 前 submit() 不再能够
    // 启动 prepare-screenshot，避免 guest 已撤销 target 后 host 又进提交态。
    cancelGuestPending(true);
  }, [cancelGuestPending]);

  /**
   * 提交主流程(气泡提交与 immediate 共用)。commentText 允许为空(immediate:
   * 只留标注 + 截图,用户回 composer 再补话)。调用前提:target 已在 guest 侧
   * pending(marker 已画好)。
   */
  const doSubmit = useCallback(
    (
      target: BrowserCommentTargetInfo,
      commentText: string,
      styleChanges?: BrowserCommentStyleChange[],
    ) => {
      if (!composerDraftKey) return;
      if (modeRef.current === 'submitting' || modeRef.current === 'off') return;
      // 注意不在这里 setPendingTarget:气泡路径早已设置(submitting 期间气泡
      // 保持可见的禁用态);immediate 路径刻意保持 null,不闪现气泡。
      setMode('submitting');
      // 认领本次提交纪元:后续每个 await 之后都比对,一旦被退出 / 导航自增,
      // 说明这次选择已作废,静默中止(既不入草稿也不把模式拨回 selecting)。
      const epoch = submitEpochRef.current;
      const isStale = () => submitEpochRef.current !== epoch;

      void (async () => {
        let draftCommitted = false;
        try {
          // 1) guest 隐藏交互层只留标注，并明确确认两帧渲染已经完成。
          // 随命令下发草稿现存 marker 编号白名单:chip 单删 / 清空 / 发送
          // 清草稿都是 silent 写入无法事件通知,截图前对账是唯一可靠时机 ——
          // guest 据此剪除已无对应 `## Comment N` 块的常驻 marker。
          await sendCommand(BROWSER_COMMENT_PREPARE_SCREENSHOT_CHANNEL, {
            validMarkerNumbers: (getDraft(composerDraftKey)?.browserComments ?? []).map(
              (c) => c.markerNumber,
            ),
          });
          if (isStale()) return; // 已退出 / 导航,放弃本次提交

          // 2) main capturePage → PNG 字节(标注是页内 DOM,天然在图里)。
          const { data } = await window.electronAPI.rsbBrowserBridge.captureScreenshotData({
            tabId,
          });
          if (isStale()) return;

          // 3) PNG → 会话图片缓存 → AttachedFile。
          const n = target.markerNumber;
          const suggestedName = `browser-comment-${n}.png`;
          const cached = await window.electronAPI.cacheImageFromBuffer({
            sessionId: composerDraftKey,
            buffer: data,
            mimeType: 'image/png',
            suggestedName,
          });
          if (isStale()) return;
          const attached: AttachedFile = {
            id: crypto.randomUUID(),
            name: suggestedName,
            // 与剪贴板粘贴的 `clipboard://paste-*` 同型:图片附件以 url 为准,
            // path 只是占位标识来源。
            path: `clipboard://browser-comment-${Date.now()}`,
            ext: '.png',
            size: data.byteLength,
            category: 'image',
            mimeType: 'image/png',
            url: cached.url,
            originalName: suggestedName,
          };

          // 4) 结构化评论条目入草稿(browser-comment-chip):不进草稿文本、
          //    不进附件托盘 —— ChatInput 渲染为「N 条注释」胶囊,发送时才
          //    序列化 + 截图并入 filesToSend。非 silent 写入,挂载中的
          //    ChatInput 经 subscribeDraft 立即刷新胶囊。
          const item: BrowserCommentDraftItem = {
            id: crypto.randomUUID(),
            markerNumber: n,
            pageUrl: getPageUrlRef.current(),
            target,
            comment: commentText.trim(),
            screenshot: attached,
            ...(styleChanges && styleChanges.length > 0 ? { styleChanges } : {}),
          };
          appendBrowserCommentToDraft(composerDraftKey, item);
          draftCommitted = true;
          committedSubmissionEpochRef.current = epoch;

          // 5) Phase 2 连续标注:pending marker 转常驻,编号按草稿最大编号推进,
          //    回点选态继续标注(不退出模式,与 Codex 一致)。
          await sendCommand(BROWSER_COMMENT_COMMIT_PENDING_CHANNEL, {
            nextMarkerNumber: computeNextMarkerNumber(getDraft(composerDraftKey)?.browserComments),
          });
          if (isStale()) {
            settleCommittedSubmission(epoch, 'off');
            return;
          }
          settleCommittedSubmission(epoch, 'selecting');
        } catch {
          if (draftCommitted) {
            // Composer 已经是用户数据的提交点。guest 收尾失败时不能把同一条评论
            // 留在气泡里让用户重试并重复 append。即使 lifecycle 已作废本纪元，
            // 也先结算成功；若 lifecycle 已抢先结算，epoch guard 会避免重复 toast。
            if (!isStale()) sendBestEffortCommand(BROWSER_COMMENT_EXIT_MODE_CHANNEL);
            settleCommittedSubmission(epoch, 'off');
            return;
          }
          // 已退出 / 导航:模式与 marker 已由打断方复位,静默(不报错、不拨回)。
          if (isStale()) return;
          if (target.immediate) {
            // immediate 没有 Popover / 用户输入可保留。失败时撤掉本次 pending
            // marker 并回点选态，用户可以直接重新 Cmd/Ctrl+点击；不能把 host
            // 留在一个没有 pendingTarget、也没有取消入口的 pending 状态。
            try {
              await sendCommand(BROWSER_COMMENT_CANCEL_PENDING_CHANNEL);
              if (isStale()) return;
              setPendingTarget(null);
              setMode('selecting');
            } catch {
              if (isStale()) return;
              // 无法确认 pending marker 已撤除时，整体退出比继续展示失配状态安全。
              abortModePreservingDraft();
            }
            toast.error(t('rightSidebar.browser.commentFailed'));
            return;
          }
          // 普通气泡提交失败：pendingTarget 与 Popover 实例都保留，用户输入不会
          // 卸载丢失，可直接修订后重试或主动取消。guest 在截图准备期间始终保有
          // 透明 blocker，因此底层网页也不会抢走点击。
          setMode('pending');
          toast.error(t('rightSidebar.browser.commentFailed'));
        }
      })();
    },
    [
      composerDraftKey,
      abortModePreservingDraft,
      exitMode,
      sendBestEffortCommand,
      sendCommand,
      settleCommittedSubmission,
      t,
      tabId,
    ],
  );
  const doSubmitRef = useRef(doSubmit);
  doSubmitRef.current = doSubmit;

  const acceptSelectedTarget = useCallback(
    (info: BrowserCommentTargetInfo) => {
      const editorDraft = editorDraftRef.current;
      if (!info.designBaseline && hasBrowserCommentDesignDraft(editorDraft)) {
        // 恢复中的 CSS / text edit 不能绑定到 region、文本选区或 baseline
        // 采集失败的元素。Guest 此时已经建立 pending marker，先经 ACK 撤销，
        // Host 草稿保持不变，让用户继续选择一个兼容元素。
        cancelGuestPending(false);
        return;
      }
      if (info.immediate && !hasBrowserCommentEditorDraft(editorDraft)) {
        // Cmd/Ctrl+点击「立即添加」:跳过气泡,空评论文本直接提交。
        doSubmitRef.current(info, '');
        return;
      }
      // 生命周期恢复后若仍有 Host 草稿，即使用户 Cmd/Ctrl+点击也必须重新打开
      // Popover，让恢复的正文 / 样式明确绑定当前 target；不能提交空评论后清空。
      // 同时归一化为普通 pending，后续截图失败应保留 Popover，而不是走 immediate
      // 的无编辑器取消路径。
      setPendingTarget(info.immediate ? { ...info, immediate: false } : info);
      setMode('pending');
    },
    [cancelGuestPending],
  );

  const toggle = useCallback(() => {
    if (modeRef.current !== 'off') {
      exitMode();
      return;
    }
    if (!composerDraftKey) return;
    // 编号 = 草稿里已有 marker 编号的最大值 + 1(删 chip 后长度与最大编号会脱节)。
    const epoch = submitEpochRef.current;
    bufferedStartupSelectionRef.current = null;
    setMode('starting');
    void sendCommand(BROWSER_COMMENT_ENTER_MODE_CHANNEL, {
      markerNumber: computeNextMarkerNumber(getDraft(composerDraftKey)?.browserComments),
    }).then(
      () => {
        if (submitEpochRef.current !== epoch) return;
        const buffered = bufferedStartupSelectionRef.current;
        bufferedStartupSelectionRef.current = null;
        if (buffered && buffered.epoch === epoch && buffered.webview === webviewRef.current) {
          acceptSelectedTarget(buffered.target);
          return;
        }
        setMode('selecting');
      },
      () => {
        if (submitEpochRef.current !== epoch) return;
        bufferedStartupSelectionRef.current = null;
        // send 已到 guest 但 ACK 丢失时，guest 可能已经挂上 overlay。失败路径
        // 必须与用户主动退出走同一套清理，不能只关闭 host 按钮状态。
        abortModePreservingDraft();
        toast.error(tRef.current('rightSidebar.browser.commentFailed'));
      },
    );
  }, [abortModePreservingDraft, acceptSelectedTarget, composerDraftKey, exitMode, sendCommand]);

  const submit = useCallback(
    (commentText: string, styleChanges?: BrowserCommentStyleChange[]) => {
      const target = pendingTarget;
      if (!target || modeRef.current !== 'pending') return;
      // 有样式改动时允许空评论(标注本身就是诉求);两者皆空不提交。
      if (!commentText.trim() && !(styleChanges && styleChanges.length > 0)) return;
      doSubmit(target, commentText, styleChanges);
    },
    [doSubmit, pendingTarget],
  );

  const previewDesign = useCallback(
    (payload: BrowserCommentDesignPreviewPayload) => {
      if (modeRef.current !== 'pending') return;
      sendNotification(BROWSER_COMMENT_DESIGN_PREVIEW_CHANNEL, payload);
    },
    [sendNotification],
  );
  const resetDesign = useCallback(() => {
    sendNotification(BROWSER_COMMENT_DESIGN_RESET_CHANNEL);
  }, [sendNotification]);

  /**
   * 当前 WebView 代际的唯一事件绑定点。useBrowserWebview 在延迟创建、LRU
   * 淘汰和崩溃重建时都会发布新对象，因此 layout effect 会在浏览器可交互
   * 之前精确拆旧挂新并更新 send target，消除普通 effect 前 ref 仍指向旧
   * generation 的点击窗口。
   */
  useLayoutEffect(() => {
    const previousWebview = webviewRef.current;
    webviewRef.current = webview;
    if (previousWebview && previousWebview !== webview) {
      const committedEpoch = committedSubmissionEpochRef.current;
      submitEpochRef.current += 1;
      bufferedStartupSelectionRef.current = null;
      if (committedEpoch !== null) {
        settleCommittedSubmission(committedEpoch, 'off');
      } else if (
        modeRef.current === 'pending' ||
        modeRef.current === 'submitting' ||
        pendingTargetRef.current
      ) {
        toast.error(tRef.current('rightSidebar.browser.commentFailed'));
      }
      setMode('off');
      setPendingTarget(null);
    }
    if (!webview) return;

    const onIpcMessage = (e: Electron.IpcMessageEvent) => {
      switch (e.channel) {
        case BROWSER_COMMENT_COMMAND_RESULT_CHANNEL: {
          const result = e.args[0] as BrowserCommentCommandResult | undefined;
          if (
            !result ||
            typeof result.requestId !== 'string' ||
            typeof result.command !== 'string' ||
            typeof result.ok !== 'boolean'
          ) {
            return;
          }
          const pending = pendingCommandsRef.current.get(result.requestId);
          if (!pending || pending.webview !== webview || pending.command !== result.command) {
            return;
          }
          clearTimeout(pending.timer);
          pendingCommandsRef.current.delete(result.requestId);
          if (result.ok) {
            pending.resolve();
          } else {
            pending.reject(new Error(`browser comment guest rejected: ${result.command}`));
          }
          return;
        }
        case BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL: {
          const currentMode = modeRef.current;
          if (currentMode !== 'starting' && currentMode !== 'selecting') return;
          const info = e.args[0] as BrowserCommentTargetInfo | undefined;
          if (!info || typeof info !== 'object') return;
          if (currentMode === 'starting') {
            // enterMode 会在统一 ACK 前同步上报页面已有文本选区。只保留当前
            // generation / epoch 的第一条选择；guest 一旦 pending 不会再发第二条。
            bufferedStartupSelectionRef.current ??= {
              webview,
              epoch: submitEpochRef.current,
              target: info,
            };
            return;
          }
          acceptSelectedTarget(info);
          return;
        }
        case BROWSER_COMMENT_MODE_EXITED_CHANNEL: {
          // guest 内按了 Esc,overlay 已自拆 —— host 只同步状态。
          const committedEpoch = committedSubmissionEpochRef.current;
          submitEpochRef.current += 1; // 作废任何挂起中的提交
          bufferedStartupSelectionRef.current = null;
          clearEditorDraft();
          if (committedEpoch !== null && settleCommittedSubmission(committedEpoch, 'off')) return;
          setMode('off');
          setPendingTarget(null);
          return;
        }
        default:
      }
    };
    const onNavigate = () => {
      if (modeRef.current === 'off') return;
      abortModePreservingDraftRef.current();
    };
    webview.addEventListener('ipc-message', onIpcMessage);
    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    return () => {
      webview.removeEventListener('ipc-message', onIpcMessage);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      rejectCommandsForWebview(webview);
    };
  }, [
    acceptSelectedTarget,
    clearEditorDraft,
    rejectCommandsForWebview,
    settleCommittedSubmission,
    webview,
  ]);

  // tab 卸载 / 切走时若模式仍开着,通知 guest 拆 overlay(webview 被 pool 保活,
  // 不通知的话 overlay 会一直趴在页面上)。
  useEffect(() => {
    return () => {
      if (modeRef.current !== 'off') exitModeRef.current();
    };
  }, [tabId]);

  return {
    mode,
    pendingTarget,
    editorDraft,
    updateEditorDraft,
    toggle,
    cancelPending,
    submit,
    previewDesign,
    resetDesign,
  };
}
