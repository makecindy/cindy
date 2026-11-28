/**
 * markdownAutosave — markdown 静默自动保存的 debounce 调度器。
 *
 * 封装 FileBodyView 的"停止输入 delayMs 后写盘"规则,单独成纯工厂是为了
 * 可以用 fake timers 直接测调度语义(FileBodyView 本身依赖 CodeMirror,
 * 仓库没有挂载 EditorView 的测试 harness)。
 *
 * 核心语义:
 *  - schedule():重置计时(debounce)——连续输入期间永不触发。
 *  - 到期时若 isSaving() 为 true(上一次写盘还在途),**重排同一回调**再等
 *    delayMs,而不是丢弃。否则"最后一批修改恰好撞上在途保存"会让 dirty
 *    悬挂到用户下次按键,期间崩溃即丢字(trailing save 保证最终落盘)。
 *  - 重排每轮都重查 isSaving(),不忙等;save() 自身的"内容无变化 → no-op"
 *    兜住重排后内容其实已被保存的情况。
 *  - cancel():切文件 / 卸载时清理,幂等。
 */

export interface MarkdownAutosaveOptions {
  delayMs: number;
  /** 是否有写盘在途(FileBodyView 传 savingRef 的读取器)。 */
  isSaving: () => boolean;
  /** 真正执行保存(silent 写盘)。返回值不消费——失败路径由 save 内部提示。 */
  save: () => void;
}

export interface MarkdownAutosaveHandle {
  /** 输入触发:重置 debounce 计时。 */
  schedule(): void;
  /** 取消未触发的计时(切文件 / 卸载)。幂等。 */
  cancel(): void;
  /** Suspend pending edits until the visible file has been checked. */
  setPaused(paused: boolean): void;
}

export function createMarkdownAutosave(opts: MarkdownAutosaveOptions): MarkdownAutosaveHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  let pending = false;
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const fire = (): void => {
    timer = null;
    if (opts.isSaving()) {
      // 在途保存结束后补一次 trailing save,而不是丢弃。
      timer = setTimeout(fire, opts.delayMs);
      return;
    }
    pending = false;
    opts.save();
  };

  return {
    schedule() {
      pending = true;
      clearTimer();
      if (!paused) timer = setTimeout(fire, opts.delayMs);
    },
    cancel() {
      pending = false;
      clearTimer();
    },
    setPaused(next) {
      if (paused === next) return;
      paused = next;
      clearTimer();
      if (pending && !paused) timer = setTimeout(fire, opts.delayMs);
    },
  };
}

/**
 * 归一化 dirty 比对基准:磁盘原文可能是 CRLF,而 CodeMirror 文档行尾恒为
 * LF(doc.toString() 不含 \r\n)。基准在写入时一次性归一,onChange 每键就
 * 只需一次原生 `!==`(长度不同 O(1) 短路),替代原先每键两次 O(n) 正则
 * 分配 + 比较——1MB 文件下这是可感知的输入延迟来源。
 * 无 \r 时返回原引用,零分配。
 */
export function normalizeBaseline(raw: string): string {
  return raw.includes('\r') ? raw.replace(/\r\n/g, '\n') : raw;
}
